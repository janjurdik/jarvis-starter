/**
 * Conversation: turns, interruption, history, voice sentence by sentence and the `voice` state.
 * The brain (Claude or the mock) gets a `sink` it reports text, tools and cards into, and this
 * module turns that into SSE events exactly as described in docs/API.md.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { autoCard } from './autocards.mjs'
import { normalizeCard } from './cards.mjs'
import { logTurn } from './chatlog.mjs'
import { runMock } from './mock.mjs'
import { clientCount, send, sendHud } from './sse.mjs'
import { state } from './state.mjs'
import { HIDDEN_TOOLS, NODES, toolMeta } from './tools-meta.mjs'
import { SentenceSplitter, speechQueue, warmTts } from './tts.mjs'
import { BRAIN_DIR, IS_MAC, clean, errMsg, log, slug } from './util.mjs'

let brain = null
let getSnapshot = () => ({})
let getNames = () => []
let getExtraContext = () => ''
let mockAll = false
// Starts at the clock, not at zero: a window that stays open over a restart of the server (an update)
// still holds the old turns, and a new turn with an old number would be written into an old row.
let turnSeq = Math.floor(Date.now() / 1000) * 1000
let saySeq = 0
let current = null
const history = []
let voice = { state: 'idle' }
let idleTimer = null
const metrics = []

export function initChat(opts) {
  brain = opts.brain
  getSnapshot = opts.getSnapshot
  getNames = opts.getNames ?? getNames
  getExtraContext = opts.getExtraContext ?? getExtraContext
  mockAll = Boolean(opts.mockAll)
  loadHistory()
}

// ── the conversation as the user sees it, kept over a reload of the window and a restart of the server ──

const HISTORY_FILE = join(BRAIN_DIR, 'chat-history.json')
const HISTORY_MAX = 40
let historyTimer = null

function loadHistory() {
  if (history.length) return
  try {
    const saved = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'))
    for (const h of Array.isArray(saved) ? saved.slice(-HISTORY_MAX) : []) if (h && h.turn !== undefined && h.at) history.push(h)
  } catch {
    // no conversation yet
  }
}

function saveHistory() {
  clearTimeout(historyTimer)
  historyTimer = setTimeout(() => {
    try {
      mkdirSync(BRAIN_DIR, { recursive: true })
      writeFileSync(HISTORY_FILE, JSON.stringify(history.filter((h) => !h.film)), { mode: 0o600 })
    } catch (err) {
      log('chat', `históriu rozhovoru sa nepodarilo uložiť: ${errMsg(err)}`)
    }
  }, 300)
  historyTimer.unref?.()
}

function remember(entry) {
  history.push(entry)
  while (history.length > HISTORY_MAX) history.shift()
  saveHistory()
}

/**
 * A card that stands on its own in the conversation: the result of a background job, a routine's
 * word, a new version, a finished import. It goes to the open windows and into the history, so a
 * window that is reloaded (or opened later) still shows it.
 */
export function standaloneCard(turn, card, extra = {}) {
  send('chat', { turn, phase: 'card', card, ...extra })
  // A card on its own is a finished turn: without this the chat keeps showing the thinking dots under it.
  send('chat', { turn, phase: 'done', text: '', ms: 0, stopped: false })
  if (state.film) return
  remember({ turn, via: 'text', user: null, attachments: [], jarvis: '', tools: [], cards: [card], at: new Date().toISOString(), ms: 0, stopped: false, error: null, film: false })
}

// ── hlasový stav ─────────────────────────────────────────────────────────

const voiceListeners = new Set()
/** Odber zmien stavu `voice` (potlačenie wake wordu počas reči Jarvisa). */
export function onVoiceChange(fn) {
  voiceListeners.add(fn)
}

export function setVoice(next, extra = {}) {
  const stateChanged = voice.state !== next
  const changed = stateChanged || extra.heard || extra.level !== undefined
  voice = { state: next }
  if (stateChanged) for (const fn of voiceListeners) fn(next)
  if (!changed) return
  send('voice', { state: next, heard: extra.heard ?? null, level: extra.level ?? null, turn: extra.turn ?? current?.id ?? null })
}

export const voiceState = () => voice.state

function scheduleIdle(turn) {
  clearTimeout(idleTimer)
  const wait = Math.max(0, turn.playEnd - Date.now()) + 400
  idleTimer = setTimeout(() => {
    if (current && current !== turn && current.active) return
    if (voice.state === 'speaking' || voice.state === 'thinking') setVoice('idle', { turn: turn.id })
  }, wait)
}

/** UI dohralo klip. Po poslednom hneď `idle`, nečaká sa na odhad. */
export function ttsPlayed(turnId, seq) {
  const turn = current?.id === turnId ? current : history.find((h) => h.turn === turnId)?._turn
  if (!turn || turn.lastSeq === null || seq < turn.lastAudioSeq) return false
  clearTimeout(idleTimer)
  if (voice.state === 'speaking' && (!current?.active || current === turn)) setVoice('idle', { turn: turnId })
  return true
}

// ── prehrávanie na serveri, keď HUD nie je otvorený ──────────────────────

const localQueue = []
let localPlaying = null
function playLocal(file) {
  // Only macOS has a built-in player for this; elsewhere the voice needs the HUD page open.
  if (!IS_MAC || !file || file.startsWith('/tts/')) return
  localQueue.push(file)
  if (!localPlaying) nextLocal()
}
function nextLocal() {
  const file = localQueue.shift()
  if (!file) {
    localPlaying = null
    return
  }
  localPlaying = spawn('/usr/bin/afplay', [file], { stdio: 'ignore' })
  localPlaying.on('exit', nextLocal)
  localPlaying.on('error', nextLocal)
}
function stopLocal() {
  localQueue.length = 0
  localPlaying?.kill('SIGTERM')
  localPlaying = null
}

// ── turn ─────────────────────────────────────────────────────────────────

function makeTurn({ text, via, silent, mock, scenario, attachments = [] }) {
  const id = ++turnSeq
  const turn = {
    id,
    via,
    user: text,
    attachments,
    text: '',
    tools: new Map(),
    cards: [],
    at: new Date(),
    t0: Date.now(),
    firstDeltaMs: null,
    firstAudioMs: null,
    active: true,
    stopped: false,
    error: null,
    silent,
    mock,
    scenario,
    film: state.film,
    playEnd: 0,
    lastSeq: null,
    lastAudioSeq: -1,
    metric: null,
  }
  turn.queue = speechQueue((clip) => {
    if (!turn.active && !turn.finishing) return
    if (clip.url || clip.speak) {
      turn.lastAudioSeq = clip.seq
      if (turn.firstAudioMs === null) {
        turn.firstAudioMs = Date.now() - turn.t0
        if (turn.metric) turn.metric.firstAudioMs = turn.firstAudioMs
      }
      turn.playEnd = Math.max(turn.playEnd, Date.now()) + (clip.durMs ?? 0)
      if (voice.state !== 'speaking') setVoice('speaking', { turn: id })
      if (clientCount() === 0) playLocal(clip.file)
    }
    if (clip.last) {
      turn.lastSeq = clip.seq
      if (turn.playEnd) scheduleIdle(turn)
      else if (!current?.active || current === turn) setVoice('idle', { turn: id })
    }
    send('tts', { turn: id, seq: clip.seq, url: clip.url, text: clip.text, last: clip.last, ms: clip.ms ?? 0, durMs: clip.durMs ?? 0, speak: clip.speak === true })
  })
  turn.splitter = new SentenceSplitter((sentence) => {
    if (!turn.silent) turn.queue.push(sentence)
  })
  return turn
}

/** Attachments as the page sees them: no absolute paths. */
const pubAttachments = (items = []) => items.map(({ rel, name, type }) => ({ rel, name, type }))

function historyEntry(turn) {
  return {
    turn: turn.id,
    via: turn.via,
    user: turn.hidden ? null : turn.user,
    attachments: pubAttachments(turn.attachments),
    jarvis: turn.text.trim(),
    tools: [...turn.tools.values()].map(({ name, label, icon, node, status }) => ({ name, label, icon, node, status })),
    cards: turn.cards,
    at: turn.at.toISOString(),
    ms: Date.now() - turn.t0,
    stopped: turn.stopped,
    error: turn.error,
    film: turn.film,
  }
}

function finish(turn, { error = null, stopped = false, meta = {} } = {}) {
  if (!turn.active) return
  turn.active = false
  turn.finishing = !stopped
  turn.stopped = stopped
  turn.error = error
  if (stopped) {
    turn.queue.cancel()
    send('tts', { turn: turn.id, stop: true })
    stopLocal()
  } else {
    turn.splitter.flush()
    // Hlasové rozhranie nesmie pri chybe len zmĺknuť.
    if (error && !turn.silent) turn.queue.push('Prepáčte, teraz sa mi to nepodarilo.')
    turn.queue.end()
  }
  const ms = Date.now() - turn.t0
  if (error) send('chat', { turn: turn.id, phase: 'error', message: error })
  else send('chat', { turn: turn.id, phase: 'done', text: turn.text.trim(), ms, stopped })
  const entry = historyEntry(turn)
  Object.defineProperty(entry, '_turn', { value: turn, enumerable: false })
  remember(entry)
  // Real conversations are kept for the evening summary (data/chat). Filming and mock turns are not.
  if (!turn.mock && !turn.film && !error && !turn.hidden) logTurn({ user: turn.attachments.length ? `${turn.user} [prílohy: ${turn.attachments.map((a) => a.rel).join(', ')}]` : turn.user, jarvis: entry.jarvis, via: turn.via, tools: entry.tools.map((t) => t.name), at: turn.at }).catch(() => {})
  const m = {
    turn: turn.id,
    mock: turn.mock,
    via: turn.via,
    firstDeltaMs: turn.firstDeltaMs,
    firstAudioMs: turn.firstAudioMs,
    totalMs: ms,
    tools: entry.tools.map((t) => t.name),
    ...meta,
  }
  turn.metric = m
  metrics.push(m)
  if (metrics.length > 50) metrics.shift()
  log('chat', `turn ${turn.id}${turn.mock ? ' (mock)' : ''} ${error ? `chyba: ${error}` : stopped ? 'prerušený' : 'hotový'} · prvý text ${turn.firstDeltaMs ?? '–'} ms · prvý zvuk ${turn.firstAudioMs ?? '–'} ms · spolu ${ms} ms${meta.usage ? ` · in ${meta.usage.input} cache ${meta.usage.cacheRead}/${meta.usage.cacheWrite} out ${meta.usage.output}` : ''}`)
  if (stopped || turn.silent) {
    if (!turn.playEnd && (!current || current === turn)) setVoice('idle', { turn: turn.id })
  }
}

function hudLog({ text, icon, type, node } = {}) {
  const t = clean(text, 140)
  if (!t) return { ok: false, error: 'chýba text' }
  sendHud({
    type: ['info', 'action', 'alert', 'done'].includes(type) ? type : 'info',
    text: t,
    icon: slug(icon) || null,
    say: null,
    heard: null,
    node: NODES.includes(node) ? node : null,
    source: 'jarvis',
  })
  return { ok: true }
}

/** Sink, cez ktorý mozog hlási priebeh. Po skončení turnu sa všetko ticho zahodí. */
function sinkFor(turn) {
  let cardN = 0
  const live = () => turn.active
  return {
    cancelled: () => !turn.active,
    delta(text) {
      if (!live() || !text) return
      // Po vlastnej karte (hud_card) už odpoveď zaznela: ďalší text by bol tá istá odpoveď druhýkrát.
      if (turn.answered) return
      if (turn.firstDeltaMs === null) turn.firstDeltaMs = Date.now() - turn.t0
      turn.text += text
      send('chat', { turn: turn.id, phase: 'delta', text })
      turn.splitter.push(text)
    },
    /** Nový textový blok po nástroji: medzera, nech sa vety nezlepia. */
    blockBreak() {
      if (!live() || !turn.text || /\s$/.test(turn.text)) return
      this.delta(' ')
    },
    tool({ id, name, input, status }) {
      if (!live() || !id) return
      // The built-in Read opens dropped files and any other file the user points at (see brain.mjs).
      const meta = name === 'Read' ? { name, label: /[\\/]prilohy[\\/]/.test(String(input?.file_path ?? '')) ? 'Pozerám prílohu' : 'Čítam súbor', icon: 'eye', node: 'fotky' } : toolMeta(name, input, { film: state.film })
      if (HIDDEN_TOOLS.has(meta.name)) return
      const prev = turn.tools.get(id)
      if (!prev && status === 'run') turn.splitter.softFlush()
      const entry = { id, ...meta, status }
      // Spresnenie (input) nesmie vrátiť hotový nástroj späť do `run`.
      if (prev && prev.status !== 'run' && status === 'run') entry.status = prev.status
      if (prev && !input) Object.assign(entry, { label: prev.label, icon: prev.icon, node: prev.node })
      turn.tools.set(id, entry)
      send('chat', { turn: turn.id, phase: 'tool', id, name: entry.name, label: entry.label, icon: entry.icon, node: entry.node, status: entry.status })
    },
    card(input) {
      if (!live()) return { ok: false, error: 'turn už skončil' }
      const res = normalizeCard(input, `c${turn.id}-${++cardN}`)
      if (!res.ok) return res
      turn.cards.push(res.card)
      send('chat', { turn: turn.id, phase: 'card', card: res.card })
      return res
    },
    focus(node, caption) {
      if (!live()) return { ok: false, error: 'turn už skončil' }
      const target = node === null || node === 'none' ? null : NODES.includes(node) ? node : undefined
      if (target === undefined) return { ok: false, error: `neznámy uzol ${node}, povolené: ${NODES.join(', ')}` }
      send('world', { focus: target, caption: clean(caption, 60) || null })
      return { ok: true }
    },
    log: hudLog,
    done(meta = {}) {
      finish(turn, { meta })
    },
    error(message) {
      finish(turn, { error: clean(message, 300) || 'neznáma chyba' })
    },
  }
}

export const currentTurnId = () => (current?.active ? current.id : null)

/** Bežiaci turn pre úlohy na pozadí (zdedia silent a mock). */
export const currentTurnInfo = () => (current?.active ? { id: current.id, silent: current.silent, mock: current.mock } : null)

const userTurnListeners = new Set()
/** Called with (text, via) for every message the user sends (the recording marks where he talked to Jarvis). */
export function onUserTurn(fn) {
  userTurnListeners.add(fn)
  return () => userTurnListeners.delete(fn)
}

/**
 * Spustí turn. Bežiaci turn sa preruší (nová veta má prednosť). Vráti id turnu.
 * `attachments` are files already stored in memory/prilohy ([{ rel, name, type, path }], checked by
 * the caller): the brain gets their absolute paths on an extra line and opens them with Read.
 */
export function sendChat({ text, via = 'text', mock = false, silent = false, scenario = null, attachments = [], hidden = false }) {
  const message = clean(text, 2000)
  if (!message) throw Object.assign(new Error('chýba text'), { status: 400 })
  if (current?.active) stopChat('nová správa')
  clearTimeout(idleTimer)
  const useMock = mockAll || mock || !brain
  const files = Array.isArray(attachments) ? attachments.filter((a) => a?.path && a?.rel).slice(0, 12) : []
  const turn = makeTurn({ text: message, via: via === 'voice' ? 'voice' : 'text', silent, mock: useMock, scenario, attachments: files })
  // A hidden turn is Jarvis speaking up on his own (the first greeting): the nudge that started it is not shown or kept.
  turn.hidden = hidden === true
  current = turn
  if (!turn.hidden) send('chat', { turn: turn.id, phase: 'user', text: message, via: turn.via, ...(files.length ? { attachments: pubAttachments(files) } : {}) })
  if (!turn.hidden) {
    for (const fn of userTurnListeners) {
      try {
        fn(message, turn.via)
      } catch (err) {
        log('chat', errMsg(err))
      }
    }
  }
  send('chat', { turn: turn.id, phase: 'start' })
  setVoice('thinking', { turn: turn.id })
  if (!silent) warmTts()
  const sink = sinkFor(turn)
  turn.sink = sink
  const job = useMock
    ? runMock(sink, { text: message, scenario, snapshot: getSnapshot() })
    : brain.run({ id: turn.id, text: files.length ? `${message}\n[prílohy: ${files.map((a) => JSON.stringify(a.path)).join(', ')}]` : message, via: turn.via, film: state.film, extra: getExtraContext() }, sink)
  Promise.resolve(job).catch((err) => sink.error(errMsg(err)))
  return turn.id
}

export function stopChat(reason = 'stop') {
  const turn = current
  if (!turn?.active) {
    stopLocal()
    if (voice.state === 'speaking' || voice.state === 'thinking') setVoice('idle')
    // Hlas dohráva už hotový turn: UI ho stíši podľa tts stop.
    if (turn) send('tts', { turn: turn.id, stop: true })
    return { stopped: false, turn: turn?.id ?? null }
  }
  if (!turn.mock) brain?.interrupt(reason)
  finish(turn, { stopped: true })
  clearTimeout(idleTimer)
  setVoice('idle', { turn: turn.id })
  return { stopped: true, turn: turn.id }
}

export const getHistory = () => (state.film ? [] : history.filter((h) => !h.film))

export const chatMetrics = () => metrics

/** Volania z MCP nástroja jarvis-hud (hud_card, hud_focus, hud_log) k práve bežiacemu turnu. */
export function hudAction(body) {
  const action = body?.action
  if (action === 'log') return hudLog(body)
  if (!current?.active) return { ok: false, error: 'žiadny bežiaci turn, kartu ani focus nie je kam ukázať' }
  const sink = current.sink
  if (action === 'auto') {
    const built = autoCard(String(body.tool ?? ''), body.data, { film: state.film, names: getNames() })
    if (!built) return { ok: true, card: null }
    if (built.focus?.node) sink.focus(built.focus.node, built.focus.caption)
    return sink.card(built.card)
  }
  if (action === 'card' || action === 'focus') {
    // Persona: odpoveď najprv, hud nástroje na koniec. Keď už padla celá veta, zvyšok turnu je duplikát.
    if (/[.!?]\s*$/.test(current.text.trim()) && current.text.trim().length >= 60) current.answered = true
    return action === 'card' ? sink.card(body.card ?? body) : sink.focus(body.node ?? null, body.caption)
  }
  return { ok: false, error: `neznáma akcia ${action}` }
}

/** Povie ľubovoľnú vetu bez Claude (test audio cesty v UI). */
export function sayText(text) {
  const message = clean(text, 600)
  if (!message) throw Object.assign(new Error('chýba text'), { status: 400 })
  const id = `say-${++saySeq}`
  let playEnd = 0
  const q = speechQueue((clip) => {
    if (clip.url || clip.speak) {
      playEnd = Math.max(playEnd, Date.now()) + (clip.durMs ?? 0)
      if (voice.state !== 'speaking') setVoice('speaking', { turn: id })
    }
    send('tts', { turn: id, seq: clip.seq, url: clip.url, text: clip.text, last: clip.last, ms: clip.ms ?? 0, durMs: clip.durMs ?? 0, speak: clip.speak === true })
    if (clip.url && clientCount() === 0) playLocal(clip.file)
    if (clip.last) setTimeout(() => voice.state === 'speaking' && !current?.active && setVoice('idle', { turn: id }), Math.max(0, playEnd - Date.now()) + 500)
  })
  const splitter = new SentenceSplitter((s) => q.push(s))
  splitter.push(message)
  splitter.flush()
  q.end()
  return id
}

/** Pri zapnutí natáčania: história preč z UI, mozog zabudne. */
export function onFilmChange(film) {
  if (film && current?.active) stopChat('natáčanie')
  log('chat', `režim natáčania ${film ? 'ZAPNUTÝ' : 'vypnutý'}`)
}

export { errMsg }
