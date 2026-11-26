// J.A.R.V.I.S. HUD v2: režimy live, scéna a capture; zapojenie 3D sveta, Rozhovoru a hlasu.
//
//   /                       live: snapshot, Rozhovor s Jarvisom, hlas, udalosti zo SSE
//   /?mock=1                odpovede z mocku servera (bez Claude, hlas je skutočný Edge TTS)
//   /?demo=1                ukážkový rozhovor v Rozhovore (screenshoty)
//   /?film=1                režim natáčania (aj kláves N)
//   /?scene=03              scéna z ~/Desktop/Jarvis, medzerník spustí, Esc zastaví
//   /?scene=03&at=13.4      začne od 13,4 s      &mute=1  bez zvuku (obraz ide podľa MP3)
//   /?capture=1[&scene=03]  bez vlastných hodín, window.__hud.seek(t) vykreslí presne čas t
//   &q=low                  menej častíc          &token=…  token pre HUD_HOST=0.0.0.0
//   /?desktop=1             plocha Macu (appka Jarvis, WKWebView): okraje lišty a Docku, skratka ⌃⌥J,
//                           jediný prehrávač hlasu, úsporný pokojový režim
//   /?surface=app           vlastné okno: appka Jarvis na Macu (tá istá, len v okne) alebo okno prehliadača
//
// Klávesy: Enter písať a poslať, podržaný medzerník hovoriť, Esc stop, N natáčanie, F celá obrazovka.

import { createCore } from './core.js'
import { createDossier } from './dossier.js'
import { initControl } from './control.js'
import { initRecord } from './record.js'
import { createHands } from './hands.js'
import { initLinks } from './links.js'
import { createUI } from './ui.js'
import { createChat } from './chat.js'
import { createSpeech } from './speech.js'
import { createApi } from './api.js'
import { createWake } from './wake.js'
import { createJobs, demoJobs } from './jobs.js'
import { createDrop } from './drop.js'
import { createPeople } from './people.js'
import { createAppsWorld, warmAppTiles } from './apps-world.js'
import { createReveal } from './reveal.js'
import { createMediaCards } from './media-cards.js'
import { initVideo, videoEvent } from './video.js'
import { setWorldApps } from './world/apps.js'
import { activeOrbs, layoutOrbs } from './orbs.js'
import { createSettings } from './settings.js'
import { DEMO_HISTORY } from './demo.js'
import { toolIcon } from './icons.js'
import { levelAt, loadAudio, play, syntheticLevel, syntheticWave, waveAt } from './audio.js'
import { clamp, duration, easeOut, esc, nf, parseDay, plural, shortDate, wordTimes } from './format.js'
import { openEvents } from './events.js'

const params = new URLSearchParams(location.search)
const CAPTURE = params.has('capture')
const SCENE_ID = params.get('scene')
const MUTED = params.get('mute') === '1'
const START_AT = Math.max(0, Number(params.get('at')) || 0)
const MOCK = params.get('mock') === '1'
/** The Jarvis app of the Mac (on the desktop or in its own window) puts window.__jarvisDesktop in before the page loads. */
const NATIVE = Boolean(window.__jarvisDesktop?.native)
/** Plocha Macu: the app as the desktop under the windows (in its own window it says mode 'app'). */
const DESKTOP = params.get('desktop') === '1' || (NATIVE && window.__jarvisDesktop.mode !== 'app' && params.get('surface') !== 'app')
// Which of the three places this window is: the desktop, the app window (the Mac app in its window, or a browser opened with ?surface=app) or a browser tab.
const SURFACE = DESKTOP ? 'desktop' : NATIVE || params.get('surface') === 'app' ? 'app' : 'browser'
const desk = () => window.__jarvisDesktop ?? null
if (DESKTOP) document.documentElement.classList.add('jarvis-desktop')
const DEMO = params.get('demo') === '1'
const QUALITY = params.get('q') ?? (Math.min(screen.width, screen.height) < 600 || (navigator.hardwareConcurrency ?? 8) <= 4 ? 'low' : 'high')

/** Počty pre vnútorné svety (pamäť), dorážajú po štarte z /api/inner. */
let innerCounts = {}

/** Appky, ktoré si používateľ vybral (GET /api/apps, SSE `apps`). */
let appsState = { picked: [] }
let appsWorld = null
let settings = null

/** Orby, ktoré pridal alebo skryl Jarvis, a čo ukazujú (GET /api/orbs, SSE `orbs`). */
let orbState = { hidden: [], pinned: [], custom: [], content: {} }

function buildNodes(snapshot) {
  const m = snapshot.memory ?? {}
  const h = snapshot.health ?? {}
  const s = snapshot.schedule ?? { items: [] }
  const q = snapshot.quests ?? {}
  const extra = { ...(m.extra ?? {}), ...innerCounts }
  const day = parseDay(s.day)
  const items = (s.items ?? []).filter((it) => it.kind !== 'routine')
  const count = (n) => (Number.isFinite(n) && n > 0 ? nf(n) : '')
  const open = snapshot.todo?.open ?? 0
  const data = {
    ludia: { label: 'Ľudia', value: nf(m.people ?? 0), sub: 'v pamäti' },
    projekty: { label: 'Projekty', value: nf(m.projects ?? 0), sub: 'v pamäti' },
    questy: { label: 'Ciele', value: String(q.active ?? 0), sub: q.paused ? `aktívnych · ${q.paused} v pauze` : 'aktívnych' },
    kalendar: { label: 'Kalendár', value: day ? shortDate(day) : '–', sub: `${items.length} ${plural(items.length, 'položka', 'položky', 'položiek')}` },
    // The same number the inside of the orb shows: every routine that is switched on (the alarm included).
    rutiny: { label: 'Rutiny', value: String(innerCounts.rutiny ?? (snapshot.routines ?? []).length), sub: 'zapnutých' },
    udalosti: { label: 'Denník', value: nf(m.dailyLogs ?? 0), sub: plural(m.dailyLogs ?? 0, 'deň', 'dni', 'dní') },
    spravy: { label: 'Rozhovory', value: nf(m.chatMessages ?? 0), sub: 'správ s Jarvisom' },
    fotky: { label: 'Poznámky', value: nf(m.other ?? 0), sub: 'v pamäti' },
    spanok: { label: 'Spánok', value: h.sleepMin ? duration(h.sleepMin) : '–', sub: h.sleepMin ? (h.avgSleepMin ? `priemer ${duration(h.avgSleepMin)}` : 'posledná noc') : 'povedz mi, ako si spal' },
    ulohy: { label: 'Úlohy', value: nf(open), sub: snapshot.todo?.today ? `${snapshot.todo.today} na dnes` : 'otvorených' },
    posta: { label: 'Pošta', value: '+', sub: 'pripoj poštu' },
    knihy: { label: 'Knihy', value: count(extra.knihy), sub: '' },
    filmy: { label: 'Filmy', value: count(extra.filmy), sub: '' },
    skola: { label: 'Škola', value: count(extra.skola), sub: '' },
    zdroje: { label: 'Zdroje', value: count(extra.zdroje), sub: '' },
    content: { label: 'Obsah', value: count(extra.content), sub: '' },
    miesta: { label: 'Miesta', value: count(extra.miesta), sub: '' },
    hudba: { label: 'Hudba', value: count(extra.hudba), sub: '' },
    hry: { label: 'Hry', value: count(extra.hry), sub: '' },
    appky: { label: 'Tvoje appky', value: appsState.picked.length ? nf(appsState.picked.length) : '+', sub: appsState.picked.length ? 'v Jarvisovi' : 'vyber, čo používaš' },
  }
  // How much each orb holds: an orb outside the base shows up only when there is something in it.
  const counts = {
    ...extra,
    questy: (q.active ?? 0) + (q.paused ?? 0),
    spanok: h.sleepMin || (h.week ?? []).length ? 1 : 0,
    udalosti: m.dailyLogs ?? 0,
    projekty: m.projects ?? 0,
    spravy: m.chatMessages ?? 0,
  }
  return layoutOrbs(activeOrbs({ counts, state: orbState })).map((n) => {
    // What Jarvis wrote for the orb (data/orbs/<id>.json) wins over the built-in number.
    const c = orbState.content?.[n.id] ?? {}
    const base = data[n.id] ?? { label: n.label ?? n.id, value: count(extra[n.id]), sub: '' }
    return { ...n, ...base, ...(c.value ? { value: c.value } : {}), ...(c.sub ? { sub: c.sub } : c.value ? { sub: '' } : {}), alert: c.alert === true }
  })
}

/** The set of orbs changed (new snapshot, apps, Jarvis added one): labels and the 3D world follow. */
function refreshNodes() {
  if (!snapshot) return
  nodes = buildNodes(snapshot)
  ui?.setSnapshot(snapshot, nodes)
  core?.setNodes?.(nodes)
  dossier?.setOrbs?.(nodes)
}

function applyOrbs(o) {
  if (!o || !Array.isArray(o.custom)) return
  const before = orbState?.content ?? {}
  orbState = { hidden: o.hidden ?? [], pinned: o.pinned ?? [], custom: o.custom, content: o.content ?? {} }
  refreshNodes()
  // The orb that is open right now got new content: its inside redraws too.
  const open = dossier?.isOpen() ? dossier.node() : null
  if (open && orbState.content[open]?.updatedAt && orbState.content[open].updatedAt !== before[open]?.updatedAt) dossier.refresh?.(open)
}

/** Počty vnútorných svetov: krátko čaká pri štarte, inak sa doplnia neskôr. */
async function loadInnerCounts(waitMs) {
  try {
    const res = await fetch('/api/inner', { cache: 'no-store', signal: AbortSignal.timeout(waitMs) })
    const body = await res.json()
    if (body.ok) innerCounts = body.counts ?? {}
    return body.ok
  } catch {
    return false
  }
}

// ── časové funkcie (žiadny stav medzi snímkami) ───────────────────────────

const FLOW_BASE = 0.075
const FLOW_BOOST = 0.55
const FLARE_TAU = 1.8

/** Rozžiarenie uzla a fáza toku častíc ako uzavretý vzorec z časov udalostí. */
function flareOf(times = [], t, T) {
  let f = 0
  let extra = 0
  for (const at of times) {
    if (at > t) continue
    const decay = Math.exp(-(t - at) / FLARE_TAU)
    f += decay
    extra += FLARE_TAU * (1 - decay)
  }
  return { f: Math.min(1.4, f), phase: FLOW_BASE * T + FLOW_BOOST * extra }
}

function pulseOf(times, t) {
  let p = 0
  for (const at of times) if (at <= t && t - at < 4) p += Math.exp(-(t - at) / 0.5)
  return Math.min(1, p)
}

const lastActive = (cues, t, hold) => {
  let hit = null
  for (const c of cues) if (c.t <= t && t < c.end + hold) hit = c
  return hit
}

// ── scéna ────────────────────────────────────────────────────────────────

function prepareScene(data) {
  const cfg = data.config ?? {}
  const day = parseDay(cfg.date) ?? new Date()
  const [hh = 0, mm = 0, ss = 0] = String(cfg.clock ?? '').split(':').map(Number)
  const base = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm, ss)
  if (!cfg.clock) base.setTime(Date.now())
  const jarvis = data.cues.filter((c) => c.kind === 'jarvis').map((c, i) => ({ ...c, key: `j${i}` }))
  const user = cfg.userLines === false ? [] : data.cues.filter((c) => c.kind === 'user').map((c, i) => ({ ...c, key: `u${i}` }))
  // Bez strážcu scrollovania: žiadne udalosti o Instagrame a Thonny, žiadne prepínanie okna na ne.
  const cleanSet = (set) => {
    if (!set) return set
    const out = { ...set }
    delete out.instagram
    if (GUARD_RE.test(`${out.app ?? ''} ${out.host ?? ''}`)) {
      delete out.app
      delete out.host
    }
    return Object.keys(out).length ? out : undefined
  }
  const events = [...(cfg.preLog ?? []), ...(cfg.events ?? [])]
    .filter((e) => !isGuardEvent(e))
    .map((e, i) => ({ type: 'info', ...e, set: cleanSet(e.set), key: `e${i}` }))
    .sort((a, b) => a.at - b.at)
  const flareTimes = {}
  for (const e of events) if (e.node) (flareTimes[e.node] ??= []).push(e.at)
  const pulseTimes = events.filter((e) => e.at >= 0).map((e) => e.at)

  // Rozhovor: každá veta používateľa otvára ťah, Jarvisove repliky a akcie patria k nemu.
  const dialog = [...user.map((c) => ({ ...c, who: 'user' })), ...jarvis.map((c) => ({ ...c, who: 'jarvis' }))].sort((a, b) => a.t - b.t)
  const turns = []
  for (const c of dialog) {
    if (c.who === 'user' || !turns.length) turns.push({ key: `s${turns.length}`, user: c.who === 'user' ? c : null, jarvis: [], from: c.t })
    if (c.who === 'jarvis') turns[turns.length - 1].jarvis.push({ ...c, words: wordTimes(c.text, c.t, c.end) })
  }
  turns.forEach((tn, i) => {
    tn.to = turns[i + 1]?.from ?? Infinity
    tn.actions = events.filter((e) => (e.type === 'action' || e.type === 'done') && e.at >= tn.from && e.at < tn.to)
  })
  const focusCues = events.filter((e) => e.focus).map((e) => ({ at: e.at, node: typeof e.focus === 'string' ? e.focus : e.node, caption: e.caption ?? null }))
  return { id: data.id, base, jarvis, user, events, flareTimes, pulseTimes, turns, focusCues, initial: cleanSet(cfg.state) ?? {}, total: data.total }
}

/** Rozhovor scény v čase st: hotové ťahy, slová Jarvisa podľa titulku, akcie ako čipy. */
function sceneTurns(st) {
  const out = []
  for (const tn of scene.turns) {
    const userDone = tn.user && st >= tn.user.end - 0.05
    const started = tn.jarvis.some((j) => j.t <= st)
    if (!userDone && !started) continue
    const parts = []
    const items = [
      ...tn.jarvis.filter((j) => j.t <= st).map((j) => ({ at: j.t, j })),
      ...tn.actions.filter((e) => e.at <= st).map((e) => ({ at: e.at, e })),
    ].sort((a, b) => a.at - b.at)
    let streaming = false
    for (const it of items) {
      if (it.j) {
        const shown = it.j.words.filter((w) => st >= w.start - 0.04).map((w) => w.w)
        const live = st < it.j.end
        streaming ||= live
        parts.push({ kind: 'text', text: shown.join(' '), cursor: live })
      } else {
        const tool = { id: it.e.key, label: it.e.text, icon: it.e.icon, node: it.e.node ?? null, status: st - it.e.at < 0.9 ? 'run' : 'ok' }
        const last = parts[parts.length - 1]
        if (last?.kind === 'tools') last.items.push(tool)
        else parts.push({ kind: 'tools', items: [tool] })
      }
    }
    const state = streaming ? 'streaming' : started ? 'done' : 'thinking'
    out.push({ key: tn.key, user: userDone ? tn.user.text : null, via: 'voice', parts, state })
  }
  return out
}

// ── štart ────────────────────────────────────────────────────────────────

const canvas = document.getElementById('gl')
const now = () => performance.now() / 1000
const T0 = now()
const api = createApi({ token: params.get('token') })
/** Record mode: the chip, the indicator and the microphone chunks (record.js). */
let record = null

let snapshot
let scene = null
let audio = null
let ui
let core
let dossier = null
let chat
let speech
let nodes
let sceneClock = null
let sceneFrozen = null
let captureTime = 0
let captureClockBase = Date.now()
let lastFrameT = null
const live = { entries: [], cues: [], userCues: [], flareTimes: {}, pulses: [], aw: null, connected: false }
const voice = { server: 'idle', serverAt: 0, level: 0, heard: null, heardAt: 0, local: null, localAt: 0, lastSpeakAt: -10, notice: null }
const world = { focus: null, caption: null }
let status = null
let film = params.get('film') === '1'
let keysHidden = false
let wake = null
let jobs = null
/** Photos, videos and audio as floating cards (media-cards.js). */
let mediaCards = null
/** Dropped files and imports (drop.js) and the people review (people.js). Not in capture and scenes. */
let drop = null
let people = null
let jobsSince = null
let micState = 'off'
/** Jeden prehrávač hlasu: appka na ploche, inak karta v prehliadači, keď appka nebeží. */
// One window owns the voice (the server decides: the desktop before the app window before a browser
// tab, the oldest among equals). A second window opened next to it shows Jarvis but stays silent.
let myWindow = null
let voiceOwner = null
const ownsAudio = () => (myWindow && voiceOwner ? myWindow === voiceOwner : DESKTOP || !(Number(status?.desktop) > 0))

// Pokojový režim plochy: bez vstupu a bez Jarvisa ~30 fps a nižšie DPR, CSS animácie stoja.
const IDLE_AFTER_S = 20
const IDLE_FPS = 15
const IDLE_DPR = 1.25
let lastInput = now()
let idle = false

/** Stránka v pozadí (okno plochy zakryté) nemaľuje DOM: zmeny sa dokreslia po zobrazení. */
const pendingPaint = new Map()
function paint(key, fn) {
  if (!document.hidden) return fn()
  pendingPaint.set(key, fn)
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  for (const fn of pendingPaint.values()) fn()
  pendingPaint.clear()
})
const waveBuf = new Float32Array(128)

/** Voľná plocha pre jadro: stredný stĺpec medzi doskami, od lišty po titulok. */
function zone() {
  const pad = 8
  const top = document.getElementById('top').getBoundingClientRect().bottom
  const sub = document.getElementById('subtitle').getBoundingClientRect()
  const mid = document.getElementById('voice').getBoundingClientRect()
  return {
    left: mid.left + pad,
    right: mid.right - pad,
    top: top + pad,
    bottom: Math.max(top + 160, sub.top - pad),
  }
}

let labelBounds = null
function layout() {
  const z = zone()
  const dpr = window.devicePixelRatio || 1
  core.layout(window.innerWidth, window.innerHeight, idle ? Math.min(IDLE_DPR, dpr) : dpr, z)
  labelBounds = { top: document.getElementById('top').getBoundingClientRect().bottom - 6, bottom: document.getElementById('subtitle').getBoundingClientRect().top - 8 }
  ui.sizeCanvases()
}

function sceneTime() {
  if (!scene) return null
  if (CAPTURE) return captureTime
  if (sceneFrozen !== null) return sceneFrozen
  if (!sceneClock) return null
  const t = sceneClock.time()
  if (t > scene.total + 4) {
    sceneClock.stop()
    sceneClock = null
    sceneFrozen = t
  }
  return t
}

function compute(T) {
  const t = sceneTime()
  const f = {
    T,
    voice: 0,
    pulse: 0,
    boot: 1,
    ignite: 0,
    igniteT: -1,
    shockT: -1,
    wave: null,
    flares: {},
    entries: [],
    logT: T,
    cue: null,
    cueT: T,
    userCue: null,
    userLevel: 0,
    clock: new Date(),
    state: {},
    voiceState: 'idle',
    listen: 0,
    focus: null,
    toolNodes: {},
    film,
    chat: null,
  }

  if (scene) {
    const st = t ?? 0
    const started = t !== null
    f.boot = started ? (START_AT > 1.2 && !CAPTURE ? 1 : 0.3 + 0.7 * easeOut(st / 1.25)) : 0.3
    if (started && st < 2) {
      f.ignite = 0.9 * Math.exp(-(((st - 0.45) / 0.38) ** 2))
      f.igniteT = st
      f.shockT = st - 0.25
    }
    const events = scene.events.filter((e) => e.at <= (started ? st : 0))
    const state = { ...scene.initial }
    for (const e of events) if (e.set) Object.assign(state, e.set)
    f.state = state
    f.entries = events
      .slice()
      .reverse()
      .map((e) => ({ key: e.key, at: e.at, when: new Date(scene.base.getTime() + e.at * 1000), type: e.type, icon: e.icon, text: e.text }))
    f.logT = started ? st : 0
    f.clock = new Date(scene.base.getTime() + (started ? st : 0) * 1000)
    if (started) {
      f.pulse = pulseOf(scene.pulseTimes, st)
      f.cue = lastActive(scene.jarvis, st, 1.15)
      f.cueT = st
      f.userCue = lastActive(scene.user, st, 0.9)
      if (f.userCue) f.userLevel = syntheticLevel(f.userCue.text, f.userCue.t, Math.max(0.6, f.userCue.text.length / 15), st)
      if (audio) {
        f.voice = levelAt(audio, st)
        f.wave = waveAt(audio, st, waveBuf)
      } else if (f.cue) {
        f.voice = syntheticLevel(f.cue.text, f.cue.t, f.cue.end - f.cue.t, st)
        f.wave = syntheticWave(f.cue.text, f.cue.t, f.cue.end - f.cue.t, st, waveBuf)
      }
      for (const n of nodes) f.flares[n.id] = flareOf(scene.flareTimes[n.id], st, T)
      const speakingCue = scene.jarvis.find((c) => c.t <= st && st < c.end)
      const userCue = scene.user.find((c) => c.t <= st && st < c.end)
      f.voiceState = speakingCue ? 'speaking' : userCue ? 'listening' : 'idle'
      f.listen = userCue ? f.userLevel : 0
      // Časy `since` v osi T (live prehrávanie: performance.now, capture: 100 + t).
      for (const e of scene.events) if (e.node && (e.type === 'action' || e.type === 'done') && e.at <= st && st - e.at < 1.4) f.toolNodes[e.node] = T - (st - e.at)
      const fc = lastActive(scene.focusCues.map((c) => ({ ...c, t: c.at, end: c.at + 10 })), st, 0)
      if (fc) {
        f.focus = { node: fc.node, since: T - (st - fc.at) }
        world.caption = fc.caption
      }
      f.chat = sceneTurns(st)
    } else {
      for (const n of nodes) f.flares[n.id] = flareOf([], 0, T)
      f.chat = []
    }
    return f
  }

  // Live: pri otvorení sa jadro zapáli, udalosti zo SSE pulzujú a rozžiaria uzly.
  const age = CAPTURE ? 99 : T - T0
  f.boot = 0.25 + 0.75 * easeOut(age / 2.2)
  if (age < 3) {
    f.ignite = 0.7 * Math.exp(-(((age - 0.7) / 0.45) ** 2))
    f.igniteT = age
    f.shockT = age - 0.55
  }
  f.pulse = pulseOf(live.pulses, T)
  f.entries = film ? live.entries.filter((e) => e.film) : live.entries
  f.logT = T

  // Hlas Jarvisa: skutočné audio z TTS, inak v1 udalosť `say` so syntetickou obálkou.
  const level = speech.voiceLevel()
  const speakingNow = speech.speaking()
  if (speakingNow) voice.lastSpeakAt = T
  const ttsCue = speech.cue()
  if (ttsCue) {
    f.cue = ttsCue
    f.cueT = T
    f.voice = level
    f.wave = speech.wave(waveBuf)
  } else {
    f.cue = lastActive(live.cues, T, 1.15)
    f.cueT = T
    if (f.cue) {
      f.voice = syntheticLevel(f.cue.text, f.cue.t, f.cue.end - f.cue.t, T)
      f.wave = syntheticWave(f.cue.text, f.cue.t, f.cue.end - f.cue.t, T, waveBuf)
    } else if (speakingNow) {
      f.voice = level
      f.wave = speech.wave(waveBuf)
    }
  }
  f.userCue = lastActive(live.userCues, T, 1.6)

  // Stav hlasu: lokálne počúvanie (klik, medzerník) má prednosť, potom audio, potom server.
  // Push-to-talk drží „listening", kým je medzerník dole (bez časového limitu).
  const localListening = voice.local === 'listening' && (Boolean(ptt) || T - voice.localAt < 15)
  const localTranscribing = voice.local === 'transcribing' && T - voice.localAt < 30
  const server = T - voice.serverAt < 90 ? voice.server : 'idle'
  const active = chat.activeState()
  let vs = 'idle'
  if (localListening || server === 'listening') vs = 'listening'
  else if (localTranscribing || server === 'transcribing') vs = 'transcribing'
  else if (speakingNow || T - voice.lastSpeakAt < 0.6 || f.cue) vs = 'speaking'
  else if (server === 'thinking' || active) vs = 'thinking'
  else if (server === 'wake') vs = 'wake'
  f.voiceState = vs
  // Úroveň mikrofónu: push-to-talk z vlastného analyzéra, „Ahoj Jarvis" zo streamu wake.js, mock zo servera.
  f.listen = vs !== 'listening' ? 0 : ptt && speech.micOpen ? speech.listenLevel() : wake?.active ? voice.wakeLevel ?? 0 : voice.level
  if (world.focus && T - world.focus.since > 14) world.focus = null
  f.focus = world.focus
  f.toolNodes = chat.busyNodes()
  // Úlohy na pozadí: jemný prúd z uzla projekty do jadra, kým niečo beží.
  if (jobs?.active) f.toolNodes.projekty ??= jobsSince ?? (jobsSince = T)
  else jobsSince = null
  // What he is doing right now: the turn in progress first, then work in the background. Hidden while
  // he listens or speaks, the subtitle and the wave own that place then.
  const quiet = vs === 'idle' || vs === 'thinking' || vs === 'wake'
  const running = jobs?.working ?? []
  // The turn he is in the middle of comes first, every job in the background has a line of its own under it.
  f.work = !quiet || scene || CAPTURE ? [] : [...(vs === 'thinking' ? [chat.work() ?? { label: null, since: null }] : []), ...running]
  f.working = running.length > 0
  for (const n of nodes) f.flares[n.id] = flareOf(live.flareTimes[n.id], T, T)
  if (CAPTURE) f.clock = new Date(captureClockBase + T * 1000)
  f.state = { app: null }
  return f
}

let idleFrame = 0
let lastVoiceAttr = null
let lastFilmAttr = null
function renderFrame(T) {
  const dt = lastFrameT === null ? 0.016 : clamp(T - lastFrameT, 0, 0.1)
  lastFrameT = T
  const f = compute(T)
  core.frame(T, f)
  dossier?.frame()
  appsWorld?.frame()
  ui.renderClock(f.clock)
  ui.renderState(f.state, f.clock)
  ui.renderLog(f.entries, f.logT)
  ui.renderSubtitle(f.cue, f.cueT)
  if (scene) {
    ui.renderPromptCue(f.userCue, f.cueT)
    chat.renderStatic(f.chat)
  } else {
    if (f.voiceState === 'listening' || f.voiceState === 'transcribing') ui.renderLive(voice.heard && T - voice.heardAt < 8 ? `<span class="dim">${esc(voice.heard)}</span>` : null)
    else if (voice.notice && T - voice.notice.at < 2.6) ui.renderLive(`<span class="dim">${esc(voice.notice.text)}</span>`)
    else ui.renderPromptCue(f.userCue, T)
    chat.frame(dt)
  }
  const orbState = f.voiceState === 'idle' && status?.wake === true ? 'wake' : f.voiceState
  ui.renderOrb(orbState, f.voiceState === 'listening' ? f.listen : f.voice, T)
  ui.renderWork(f.work, Date.now())
  ui.renderWave(f.wave, f.voice, T)
  ui.renderMicWave(f.listen, f.voiceState === 'listening' && !scene, T)
  // V pokoji stačí štítky posúvať každú druhú snímku (kamera sa hýbe pomaly).
  idleFrame = (idleFrame + 1) % 2
  const points = idle && idleFrame ? null : core.project()
  if (points) ui.renderLabels(points, { flares: f.flares, focus: f.focus, toolNodes: f.toolNodes, caption: world.caption, hover: CAPTURE ? null : core.info?.().hover ?? null, bounds: labelBounds })
  const offline = !scene && !MOCK && !CAPTURE && !live.connected
  ui.renderPlaceholder(offline ? 'offline' : f.voiceState)
  ui.renderKeys(keysHidden ? 'none' : scene ? 'scene' : document.activeElement === ui.el.input ? 'typing' : f.voiceState === 'listening' ? 'listening' : f.voiceState === 'thinking' || f.voiceState === 'speaking' ? 'busy' : 'idle')
  if (lastVoiceAttr !== f.voiceState) document.body.dataset.voice = lastVoiceAttr = f.voiceState
  if (lastFilmAttr !== film) {
    lastFilmAttr = film
    document.body.classList.toggle('film', film)
  }
  if (CAPTURE) syncAnimations(T)
  return f
}

/** Capture: CSS animácie (počasie, kurzor, orb) zastavené presne na čase T. */
function syncAnimations(T) {
  for (const a of document.getAnimations()) {
    if (a.playState !== 'paused') a.pause()
    a.currentTime = T * 1000
  }
}

// ── live: udalosti ────────────────────────────────────────────────────────

const DEFAULT_ICON = { alert: 'alarm', action: 'bolt', done: 'check', voice: 'wave', info: 'info' }

/** Strážca scrollovania (Instagram, Thonny) z HUD vypadol: tieto udalosti sa nikde neukazujú. */
const GUARD_RE = /instagram|thonny/i
const isGuardEvent = (ev) => ev?.type === 'guard' || ev?.source === 'guard' || GUARD_RE.test(`${ev?.text ?? ''} ${ev?.say ?? ''} ${ev?.heard ?? ''}`)

function pushLive(ev, at, { animate = true, safe = false } = {}) {
  if (isGuardEvent(ev)) return
  const type = ev.type === 'voice' ? 'info' : ev.type
  live.entries.unshift({
    key: `l${ev.id ?? `${Math.round(at * 1000)}-${live.entries.length}`}`,
    at: animate ? at : at - 100,
    when: ev.ts ? new Date(ev.ts) : new Date(),
    type,
    icon: ev.icon ?? DEFAULT_ICON[ev.type] ?? 'info',
    text: ev.text || ev.say,
    film: film || safe,
  })
  live.entries = live.entries.slice(0, 24)
  if (!animate) return
  live.pulses.push(at)
  live.pulses = live.pulses.filter((p) => at - p < 5)
  if (ev.node) (live.flareTimes[ev.node] ??= []).push(at)
  if (ev.heard) {
    live.userCues.push({ key: `h${ev.id ?? at}`, text: ev.heard, t: at, end: at + Math.max(1.1, ev.heard.length / 24) })
    live.userCues = live.userCues.slice(-3)
  }
  if (ev.say && !speech.speaking()) {
    const start = at + 0.1
    live.cues.push({ key: `s${ev.id ?? at}`, text: ev.say, t: start, end: start + Math.max(1.4, ev.say.length / 14) })
    live.cues = live.cues.slice(-4)
  }
}

function onChat(ev) {
  chat.apply(ev)
  const T = now()
  if (ev.phase === 'start') live.pulses.push(T)
  if (ev.phase === 'tool' && ev.node && ev.status === 'run') (live.flareTimes[ev.node] ??= []).push(T)
  if (ev.phase === 'tool' && ev.status === 'ok' && ev.label) pushLive({ type: 'done', icon: toolIcon(ev), text: ev.label, node: ev.node ?? undefined }, T)
  if (ev.phase === 'tool' && ev.status === 'error') pushLive({ type: 'alert', icon: toolIcon(ev), text: `${ev.label ?? ev.name} · chyba` }, T)
  if (ev.phase === 'error') pushLive({ type: 'alert', icon: 'alarm', text: `Mozog · ${ev.message ?? 'chyba'}` }, T)
  if (ev.phase === 'done' && ev.stopped) chat.apply({ turn: ev.turn, phase: 'stopped' })
}

function onVoice(v) {
  if (!v?.state) return
  const T = now()
  voice.server = v.state
  voice.serverAt = T
  voice.level = Number(v.level) || 0
  if (v.heard) {
    voice.heard = v.heard
    voice.heardAt = T
  }
  // Server pokročil (prepis, premýšľanie, reč): lokálny stav končí. Idle hneď po stlačení ignoruj.
  if (!ptt && v.state !== 'listening' && v.state !== 'wake' && (v.state !== 'idle' || T - voice.localAt > 1.5)) voice.local = null
  if (v.state === 'wake') pushLive({ type: 'info', icon: 'wake', text: 'Ahoj Jarvis · počúvam' }, T, { safe: true })
}

function onWorld(w) {
  if (!w) return
  if (w.panel === 'settings') return settings?.open(w.tab)
  // A flare without a camera move: an orb Jarvis just added or filled lights up.
  if (w.flare) (live.flareTimes[w.flare] ??= []).push(now())
  if (w.focus === 'appky') return focusNode('appky', w.app ?? null)
  world.focus = w.focus ? { node: w.focus, since: now() } : null
  world.caption = w.focus ? w.caption ?? null : null
  if (w.focus) (live.flareTimes[w.focus] ??= []).push(now())
}

function onSnapshot(s) {
  if (!s?.memory) return
  snapshot = s
  refreshNodes()
}

function onStatus(s) {
  if (!s) return
  status = s
  speech?.setLang(s.lang)
  if (typeof s.film === 'boolean' && s.film !== film) setFilm(s.film, { remote: true })
  // Pripojila sa appka na ploche: karta v prehliadači stíchne.
  if (!ownsAudio() && speech?.speaking()) speech.stop()
  renderStatusChips()
}

/** Capture a scény sú video: lišta ukáže pripravený stav, nie stav servera pri renderi. */
const SHOW_STATUS = { brain: 'ready', model: 'sonnet', tts: 'edge', voice: 'sk-SK-LukasNeural', wake: false, memory: { ok: true } }

function renderStatusChips() {
  if (CAPTURE || scene) return ui.renderStatus(SHOW_STATUS, { film, snapshotAge: null, connected: true })
  paint('status', () => {
    const generated = snapshot?.generatedAt ? Date.parse(snapshot.generatedAt) : NaN
    const snapshotAge = Number.isFinite(generated) ? (Date.now() - generated) / 1000 : null
    ui.renderStatus(status, { film, snapshotAge, connected: live.connected, micState })
  })
}

function connectEvents() {
  const source = openEvents(`/api/events?client=${SURFACE}`)
  const on = (name, fn) =>
    source.addEventListener(name, (e) => {
      try {
        fn(JSON.parse(e.data))
      } catch (err) {
        console.error(`SSE ${name}:`, err)
      }
    })
  on('history', (list) => {
    const known = new Set(live.entries.map((x) => x.key))
    for (const ev of list) if (!known.has(`l${ev.id}`)) pushLive(ev, now(), { animate: false })
    live.entries.sort((a, b) => b.at - a.at || b.when - a.when)
  })
  on('hud', (ev) => pushLive(ev, now()))
  on('chat', (ev) => {
    wakeUp()
    onChat(ev)
  })
  // Hrá len vlastník zvuku (appka na ploche má prednosť pred kartami v Chrome).
  on('tts', (msg) => {
    if (!ownsAudio()) return
    wakeUp()
    speech.enqueue(msg)
  })
  on('voice', (v) => {
    if (v?.state && v.state !== 'idle') wakeUp()
    onVoice(v)
  })
  initControl({ on })
  record = initRecord({ on, toast: (text, o) => ui.toast(text, o), ownsAudio, token: params.get('token'), desktop: DESKTOP })
  // Results of jobs as notifications of the system: the desktop app shows them, a click opens the job.
  on('notify', (n) => {
    if (NATIVE && typeof desk()?.post === 'function') desk().post({ type: 'notify', title: n?.title ?? 'Jarvis', body: n?.body ?? '', job: n?.job ?? null, quiet: n?.quiet === true })
  })
  on('world', (w) => {
    wakeUp()
    onWorld(w)
  })
  on('snapshot', (snap) => paint('snapshot', () => onSnapshot(snap)))
  // Úlohy: bez wakeUp, bežiaca úloha pokojový režim nebrzdí.
  on('job', (job) => jobs?.apply(job))
  on('apps', (a) => applyApps(a))
  on('suggest', (s) => renderSuggest(s?.items))
  // Which window am I and which one speaks. A window that is not the owner says so once and stays quiet.
  let saidSecond = false
  let secondTimer = 0
  const ownerChanged = () => {
    clearTimeout(secondTimer)
    if (ownsAudio()) return void wake?.start()
    wake?.stop()
    if (speech?.speaking()) speech.stop()
    // Said once, and only when it still holds a moment later (windows come and go while one reloads).
    secondTimer = setTimeout(() => {
      if (ownsAudio() || saidSecond || CAPTURE || scene) return
      saidSecond = true
      ui.toast('Jarvis už beží v inom okne. Toto okno je len na pozeranie, hovorí a počúva to prvé.', { iconName: 'info', ms: 12_000 })
    }, 2500)
  }
  on('you', (m) => {
    myWindow = m?.id ?? null
  })
  on('owner', (m) => {
    voiceOwner = m?.id ?? null
    ownerChanged()
  })
  // The page changed (somebody edited Jarvis, an update) or the server started again: load it again,
  // once Jarvis is neither listening nor speaking. The conversation comes back from the server.
  let bootId = null
  let reloading = false
  const reloadSoon = () => {
    if (reloading || CAPTURE || scene) return
    reloading = true
    const started = now()
    const go = () => {
      const busy = Boolean(ptt) || speech?.speaking() || speech?.recording || record?.pending()
      if (busy && now() - started < 30) return void setTimeout(go, 700)
      location.reload()
    }
    go()
  }
  on('reload', () => reloadSoon())
  on('boot', (b) => {
    if (!b?.id) return
    if (bootId && b.id !== bootId) reloadSoon()
    bootId = b.id
  })
  // Jarvis moved to another place (Settings → Plocha): this one gives itself back.
  on('surface', (s) => {
    if (!s?.keep || s.keep === SURFACE) return
    const where = s.keep === 'desktop' ? 'na plochu' : s.keep === 'app' ? 'do vlastného okna' : 'do prehliadača'
    // The Mac app moves by itself: to the desktop, into its window, or it ends for a browser page.
    if (NATIVE) {
      const d = window.__jarvisDesktop
      if (typeof d?.moved === 'function') return d.moved(s.keep)
      if (typeof d?.leave === 'function') return d.leave()
      return ui.toast(`Presťahoval som sa ${where}. Plochu vypnete cez krúžok v lište hore: Vypnúť Jarvisa a vrátiť pôvodnú plochu.`, { iconName: 'info', ms: 20_000 })
    }
    // A window of the browser without tabs closes itself (it is the only page in it). A tab is closed by its owner.
    if (SURFACE === 'app') {
      window.close()
      setTimeout(() => ui.toast(`Presťahoval som sa ${where}. Toto okno môžete zavrieť.`, { iconName: 'info', ms: 20_000 }), 400)
      return
    }
    ui.toast(`Presťahoval som sa ${where}. Túto kartu môžete zavrieť.`, { iconName: 'info', ms: 20_000 })
  })
  on('orbs', (o) => paint('orbs', () => applyOrbs(o)))
  // The inside of a planet changed (a task deleted or rewritten here, in another window or by Jarvis): the open board redraws.
  on('inner', (m) => m?.node && dossier?.refresh?.(m.node))
  on('settings', (st) => settings?.apply(st))
  on('job-feed', (m) => jobs?.feed(m.id, m.entry))
  on('import', (ev) => drop?.applyImport(ev))
  on('video', videoEvent)
  // show_media from the brain: each file floats as its own card.
  on('media', (m) => Array.isArray(m?.items) && mediaCards?.show(m.items))
  on('status', onStatus)
  on('mode', (m) => typeof m?.film === 'boolean' && setFilm(m.film, { remote: true }))
  source.addEventListener('open', () => {
    if (!live.connected) pushLive({ type: 'info', icon: 'wave', text: 'Udalosti · pripojené' }, now(), { safe: true })
    live.connected = true
    refreshStatus()
  })
  source.addEventListener('error', () => {
    live.connected = false
    renderStatusChips()
  })
}

async function refreshStatus() {
  try {
    onStatus(await api.status())
  } catch {
    status = null
    renderStatusChips()
  }
}

async function loadHistory() {
  if (DEMO) return chat.loadHistory(DEMO_HISTORY)
  if (film) return
  try {
    const list = await api.history()
    if (Array.isArray(list)) chat.loadHistory(list)
  } catch {
    // starší server bez histórie: rozhovor začína prázdny
  }
}

// ── akcie: písanie, hlas, stop, natáčanie ─────────────────────────────────

const errorText = (err, what) => (err.status === 404 ? `${what}: server ešte nepozná toto API.` : err.status === 0 ? `${what}: server neodpovedá.` : `${what}: ${err.message}`)

// ── Odporúčam: what Jarvis would add next (hud/server/suggest.mjs). A click says it to him, the cross drops it. ──
const suggestEl = document.getElementById('suggest')
function renderSuggest(items) {
  const mod = document.getElementById('mod-suggest')
  if (!mod || !suggestEl) return
  const list = (Array.isArray(items) ? items : []).slice(0, 2)
  mod.hidden = !list.length || film
  suggestEl.innerHTML = list
    .map((i) => `<li class="sg-i"><button type="button" class="sg-go" data-say="${escAttr(i.say)}"><b>${escAttr(i.title)}</b>${i.why ? `<span>${escAttr(i.why)}</span>` : ''}</button><button type="button" class="sg-x" data-drop="${escAttr(i.id)}" aria-label="Nechcem: ${escAttr(i.title)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></li>`)
    .join('')
}
const escAttr = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
suggestEl?.addEventListener('click', (e) => {
  const drop = e.target.closest('[data-drop]')
  if (drop) {
    fetch('/api/suggest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dismiss: drop.dataset.drop }) })
      .then((r) => r.json())
      .then((b) => renderSuggest(b.items))
      .catch(() => {})
    return
  }
  const go = e.target.closest('[data-say]')
  if (go) send(go.dataset.say, 'text')
})
const loadSuggest = () =>
  fetch('/api/suggest', { cache: 'no-store' })
    .then((r) => r.json())
    .then((b) => renderSuggest(b.items))
    .catch(() => {})

async function send(text, via = 'text') {
  const clean = String(text ?? '').trim()
  if (!clean) return
  speech.unlock()
  // Files waiting above the command bar go with this message.
  const files = drop?.take() ?? []
  try {
    const res = await api.chat(clean, via, { ...(MOCK ? { mock: true } : {}), ...(files.length ? { attachments: files.map((a) => a.rel) } : {}) })
    if (res?.turn !== undefined) {
      chat.apply({ turn: res.turn, phase: 'user', text: clean, via, attachments: files })
      chat.apply({ turn: res.turn, phase: 'start' })
    }
  } catch (err) {
    drop?.restore(files)
    const turn = `local-${Date.now()}`
    chat.apply({ turn, phase: 'user', text: clean, via })
    chat.apply({ turn, phase: 'error', message: errorText(err, 'Správa neodišla') })
  }
}

// Push-to-talk: nahráva prehliadač (MediaRecorder), prepis robí server (POST /api/stt) a sám ho pošle
// do chatu ako via: "voice". Mock ide po starom cez /api/listen (server odsimuluje počúvanie).
const PTT_MIN_MS = 250
const PTT_TAP_S = 0.35
let ptt = null // {source: 'key'|'orb', since, toggle, ready, stopAsked}

async function pttStart(source) {
  speech.unlock()
  if (ptt) return
  if (MOCK) return mockListen()
  // Skočiť Jarvisovi do reči: hlas hneď stíchne, server starý ťah preruší sám pri novej správe.
  if (speech.speaking()) speech.stop()
  ptt = { source, since: now(), toggle: false, ready: false, stopAsked: false }
  voice.local = 'listening'
  voice.localAt = now()
  voice.heard = null
  voice.notice = null
  // Without a local Whisper on the server the browser recognises speech itself (Chrome, Edge).
  const local = status?.sttEngine === 'mlx' || status?.sttEngine === 'faster'
  if (!local) {
    if (status?.sttEngine === 'off') {
      ptt = null
      voice.local = null
      return ui.toast('Hlasové ovládanie je vypnuté (JARVIS_STT=off).', { kind: 'warn', iconName: 'mic' })
    }
    ptt.browser = true
    const started = speech.recogStart((text) => (voice.heard = text))
    if (!started) {
      ptt = null
      voice.local = null
      ui.toast(speech.canRecognise ? 'Mikrofón nie je dostupný. Povoľ ho pre túto stránku.' : 'Toto okno nevie rozpoznávať reč. Otvor HUD v Chrome alebo Edge, alebo zapni lokálny Whisper (docs/HLAS.md).', { kind: 'warn', iconName: 'mic', ms: 8000 })
      return
    }
    ptt.ready = true
    if (ptt.stopAsked) pttStop()
    return
  }
  const ok = await speech.recStart()
  // Esc or a short tap while the microphone opens: the recording is dropped right away.
  if (!ptt) {
    if (ok) speech.recCancel()
    return
  }
  if (!ok) {
    ptt = null
    voice.local = null
    ui.toast('Mikrofón nie je dostupný. Povoľ ho pre túto stránku.', { kind: 'warn', iconName: 'mic', ms: 6000 })
    return
  }
  ptt.ready = true
  if (ptt.stopAsked) pttStop()
}

async function pttStop({ cancel = false } = {}) {
  const p = ptt
  if (!p) return
  if (!p.ready && !cancel) {
    p.stopAsked = true
    return
  }
  ptt = null
  if (p.browser) {
    const heard = await speech.recogStop({ cancel })
    voice.local = null
    if (cancel || !heard) return
    if (heard.error === 'not-allowed' || heard.error === 'service-not-allowed') return ui.toast('Prehliadač nepustil mikrofón. Povoľ ho pre túto stránku.', { kind: 'warn', iconName: 'mic', ms: 6000 })
    if (!heard.text) {
      voice.notice = { text: 'Nič som nepočul', at: now() }
      return
    }
    return send(heard.text, 'voice')
  }
  if (cancel) {
    speech.recCancel()
    voice.local = null
    return
  }
  const rec = await speech.recStop()
  if (!rec || rec.ms < PTT_MIN_MS || !rec.blob.size) {
    voice.local = null
    return
  }
  if (rec.silent) {
    voice.local = null
    voice.notice = { text: 'Nič som nepočul', at: now() }
    return
  }
  // Kým server nepošle `voice transcribing`, riadok ukazuje prepis hneď.
  voice.local = 'transcribing'
  voice.localAt = now()
  const files = drop?.take() ?? []
  try {
    const res = await api.stt(rec.blob, files.map((a) => a.rel))
    if (res?.text) {
      if (res.turn !== undefined && res.turn !== null) {
        chat.apply({ turn: res.turn, phase: 'user', text: res.text, via: 'voice', attachments: files })
        chat.apply({ turn: res.turn, phase: 'start' })
      }
    } else {
      drop?.restore(files)
      voice.notice = { text: 'Nič som nepočul', at: now() }
    }
  } catch (err) {
    drop?.restore(files)
    ui.toast(esc(errorText(err, 'Prepis hlasu')), { kind: 'warn', iconName: 'mic' })
  } finally {
    if (voice.local === 'transcribing') voice.local = null
  }
}

/** Mock: server odsimuluje počúvanie aj prepis (druhé volanie počúvanie zruší). */
async function mockListen() {
  if (speech.speaking()) speech.stop()
  voice.local = 'listening'
  voice.localAt = now()
  try {
    await api.listen('once', { mock: true })
  } catch (err) {
    voice.local = null
    ui.toast(esc(errorText(err, 'Počúvanie')), { kind: 'warn', iconName: 'mic' })
  }
}

/** Esc: nahrávka sa zahodí, hlas stíchne, server preruší mozog aj TTS. */
function stopAll() {
  if (ptt) pttStop({ cancel: true })
  speech.stop()
  chat.stopActive()
  if (MOCK && (voice.local === 'listening' || voice.server === 'listening')) api.listen('once', { mock: true }).catch(() => undefined)
  voice.local = null
  api.stop().catch(() => undefined)
}

function setFilm(on, { remote = false } = {}) {
  if (film === on) return
  film = on
  chat.setFilm(on)
  dossier?.setFilm(on)
  if (on) appsWorld?.close()
  // Names of people must not stay on a recorded screen.
  if (on) people?.close()
  document.body.classList.toggle('film', on)
  renderStatusChips()
  if (!remote && !CAPTURE && !scene) api.mode(on).catch((err) => ui.toast(esc(errorText(err, 'Režim natáčania')), { kind: 'warn', iconName: 'film' }))
  if (!CAPTURE) ui.toast(on ? 'Režim natáčania · história a mená sú skryté' : 'Režim natáčania vypnutý', { iconName: 'film', ms: 2600 })
  if (!on && !scene) loadHistory()
}

async function toggleWake() {
  speech.unlock()
  const next = !(status?.wake === true)
  try {
    const res = await api.wake(next)
    if (status) status = { ...status, wake: res?.wake ?? next }
    renderStatusChips()
    if (res?.error) ui.toast(esc(res.error), { kind: 'warn', iconName: 'wake' })
  } catch (err) {
    ui.toast(esc(errorText(err, 'Ahoj Jarvis')), { kind: 'warn', iconName: 'wake' })
  }
}

function applyApps(a) {
  if (!a || !Array.isArray(a.picked)) return
  appsState = { picked: a.picked }
  setWorldApps(appsState.picked)
  appsWorld?.sync(appsState)
  if (!snapshot || !ui) return
  refreshNodes()
}

function focusNode(id, appId = null) {
  if (!id) return
  world.focus = { node: id, since: now() }
  // Tvoje appky: namiesto vnútra pamäte sa otvorí výber appiek nad svetom.
  if (id === 'appky') {
    dossier?.close()
    if (!film) appsWorld?.open(appId)
  }
  // Klik na uzol otvorí vnútro planéty z pamäte (v režime natáčania len prelet kamery).
  else if (!film) {
    appsWorld?.close()
    dossier?.open(id)
  }
  world.caption = null
  ;(live.flareTimes[id] ??= []).push(now())
}

// ── scéna ────────────────────────────────────────────────────────────────

async function startScene(offset) {
  stopScene()
  sceneFrozen = null
  if (audio) sceneClock = await play(audio, offset, { muted: MUTED })
  else {
    const started = now()
    sceneClock = { time: () => offset + (now() - started), stop() {} }
  }
  ui.toast(null)
}

function stopScene() {
  sceneClock?.stop()
  sceneClock = null
  sceneFrozen = null
}

// ── ovládanie ─────────────────────────────────────────────────────────────

function toggleFullscreen() {
  // The Mac app in its own window: the window itself goes full screen, like with ⌃⌘F.
  if (NATIVE && !DESKTOP && typeof desk()?.fullscreen === 'function') return desk().fullscreen()
  if (document.fullscreenElement) document.exitFullscreen()
  else document.documentElement.requestFullscreen?.().catch(() => undefined)
}

/** The Mac app: margins of the menu bar and the Dock, the global shortcut ⌃⌥J, coming above the windows (or the window forward). */
function bindDesktop() {
  const input = ui.el.input
  let hotkeyAt = 0
  window.addEventListener('jarvis-desktop', (e) => {
    const d = e.detail ?? {}
    if (d.type === 'insets') requestAnimationFrame(layout)
    else if (d.type === 'raised') wakeUp()
    else if (d.type === 'notify-open') {
      // A click on a notification about a job: show that job.
      wakeUp()
      jobs?.open(typeof d.job === 'string' ? d.job : null)
    }
    else if (d.type === 'hotkey') {
      wakeUp()
      if (d.phase === 'down') {
        hotkeyAt = now()
        pttStart('hotkey')
      } else if (d.phase === 'up') {
        // Podržanie ≥ 300 ms = hovoril, odošli. Ťuknutie = zahodiť, potom zavrieť alebo písať.
        if (now() - hotkeyAt >= 0.3) pttStop()
        else {
          pttStop({ cancel: true })
          if (d.wasRaised) desk()?.dismiss?.()
          else input.focus()
        }
      }
    }
  })
}

/** Narrow windows: the folded side panes slide back over the world from a button in the top bar. */
function bindFolds() {
  const sides = [
    ['l', document.getElementById('fold-l'), document.getElementById('pane-l')],
    ['r', document.getElementById('fold-r'), document.getElementById('pane-r')],
  ]
  const set = (side, on) => {
    for (const [s, btn] of sides) {
      const open = s === side ? on : false
      document.body.classList.toggle(`open-${s}`, open)
      btn?.setAttribute('aria-expanded', String(open))
    }
  }
  for (const [side, btn] of sides) btn?.addEventListener('click', () => set(side, !document.body.classList.contains(`open-${side}`)))
  // A click on the world or Esc folds the pane away again. A wider window has no folded panes at all.
  canvas.addEventListener('pointerdown', () => set(null, false))
  window.addEventListener('keydown', (e) => e.key === 'Escape' && set(null, false))
  window.addEventListener('resize', () => set(null, false))
}

function bindControls() {
  const input = ui.el.input
  const cmd = ui.el.cmd

  window.addEventListener('keydown', (e) => {
    speech.unlock()
    const typing = document.activeElement === input
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (scene) {
      if (e.code === 'Space') {
        e.preventDefault()
        startScene(START_AT)
      } else if (e.code === 'Escape') {
        stopScene()
        ui.toast('<kbd>Medzerník</kbd> spustí scénu', { ms: 0, iconName: 'film' })
      } else if (e.key === 'f' || e.key === 'F') toggleFullscreen()
      else if (e.key === 'n' || e.key === 'N') setFilm(!film)
      return
    }
    if (e.key === 'Escape' && appsWorld?.isOpen()) {
      appsWorld.back()
      return
    }
    if (e.key === 'Escape' && dossier?.isOpen()) {
      dossier.back()
      return
    }
    if (e.key === 'Escape') {
      const busy = Boolean(ptt) || speech.speaking() || chat.activeState() || voice.local === 'listening' || ['listening', 'transcribing', 'thinking', 'speaking'].includes(voice.server)
      if (busy) stopAll()
      else if (typing && input.value) input.value = ''
      // Nie je čo zrušiť a HUD je vytiahnutý nad okná: Esc ho vráti späť na plochu.
      else if (DESKTOP && desk()?.isRaised) {
        input.blur()
        desk().dismiss?.()
      } else if (typing) input.blur()
      return
    }
    if (typing) return
    if (e.code === 'Space') {
      e.preventDefault()
      if (!e.repeat) pttStart('key')
    } else if (e.key === 'Enter' || e.key === '/') {
      e.preventDefault()
      input.focus()
    } else if (e.key === 'n' || e.key === 'N') setFilm(!film)
    else if ((e.key === 'f' || e.key === 'F') && !DESKTOP) toggleFullscreen()
    else if (e.key === 'h' || e.key === 'H') keysHidden = !keysHidden
  })

  // Pustenie medzerníka nahrávku odošle (aj keď medzitým fokus odišiel z okna).
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && ptt?.source === 'key') {
      e.preventDefault()
      pttStop()
    }
  })
  window.addEventListener('blur', () => {
    if (ptt?.source === 'key') pttStop()
  })

  cmd.addEventListener('submit', (e) => {
    e.preventDefault()
    const text = input.value
    input.value = ''
    send(text, 'text')
  })
  input.addEventListener('focus', () => cmd.classList.add('is-focus'))
  input.addEventListener('blur', () => cmd.classList.remove('is-focus'))
  // Orb: podržať = hovoriť, pustiť = odoslať. Krátky klik prepne na nahrávanie do ďalšieho kliku.
  ui.el.orb.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    if (scene) return startScene(START_AT)
    if (ptt?.toggle) return pttStop()
    if (MOCK && (voice.local === 'listening' || voice.server === 'listening')) return stopAll()
    pttStart('orb')
  })
  ui.el.orb.addEventListener('pointerup', () => {
    if (!ptt || ptt.source !== 'orb' || ptt.toggle) return
    if (now() - ptt.since < PTT_TAP_S) ptt.toggle = true
    else pttStop()
  })
  ui.el.orb.addEventListener('click', (e) => e.preventDefault())
  // The line above the command bar: a click on background work opens its progress.
  ui.el.work?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-job]')
    if (row?.dataset.job) jobs?.open(row.dataset.job)
  })
  // Po kliknutí na čip alebo orb fokus preč, inak by medzerník „klikol" tlačidlo namiesto počúvania.
  for (const b of document.querySelectorAll('button')) b.addEventListener('mouseup', () => b.blur())
  document.getElementById('chip-film').addEventListener('click', () => setFilm(!film))
  // Hand control: the camera chip opens the camera window and the hand cursor (hands.js).
  const handsChip = document.getElementById('chip-hands')
  const HANDS = { off: ['is-off', 'Ruky'], loading: ['is-warn', 'Ruky sa pripravujú'], on: ['is-on', 'Ruky'], blocked: ['is-err', 'Kamera zamietnutá'], error: ['is-err', 'Ruky nefungujú'] }
  const hands = createHands({
    isHot: (x, y) => !dossier?.isOpen() && !appsWorld?.isOpen() && Boolean(core.pick?.(x, y)),
    onState: ({ state: s }) => {
      const [cls, text] = HANDS[s] ?? HANDS.off
      handsChip.classList.remove('is-off', 'is-on', 'is-warn', 'is-err')
      handsChip.classList.add(cls)
      handsChip.querySelector('span').textContent = text
      handsChip.setAttribute('aria-pressed', String(s === 'on' || s === 'loading'))
      if (s === 'on') ui.toast('Ovládanie rukami beží · štipni prstami a klikneš', { iconName: 'kamera', ms: 3600 })
    },
  })
  handsChip.addEventListener('click', () => hands.toggle())
  // Links to the guide open inside Jarvis, other web links in the browser (links.js).
  initLinks({ desktop: NATIVE, toast: (text) => ui.toast(text, { iconName: 'web', ms: 2600 }) })
  if (params.get('debug') === '1') window.__hands = hands
  document.getElementById('chip-jobs').addEventListener('click', () => jobs?.open())
  document.getElementById('chip-voice').addEventListener('click', toggleWake)

  // Uzly: klik na objekt v 3D alebo na jeho popisok priblíži kameru.
  document.getElementById('labels').addEventListener('click', (e) => {
    const hit = e.target.closest('[data-node]')
    if (hit) focusNode(hit.dataset.node)
  })
  let drag = null
  canvas.addEventListener('pointerdown', (e) => {
    // A drag belongs to the pointer that started it. The mouse and the hand cursor (hands.js) are two
    // pointers: moves of one must never be read as steps of the other's drag.
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 }
    // A press made by hand has no real pointer to capture.
    if (e.isTrusted) canvas.setPointerCapture?.(e.pointerId)
  })
  canvas.addEventListener('pointerup', (e) => {
    if (drag && e.pointerId !== drag.id) return
    // Vo vnútri planéty klik a dvojklik rieši dossier (výber položky, prelet k nej).
    if (dossier?.isOpen() || appsWorld?.isOpen()) {
      drag = null
      return
    }
    if (drag && drag.moved < 6) {
      const id = core.pick?.(e.clientX, e.clientY)
      // Klik na uzol ho priblíži, klik do prázdna vráti kameru na autopilota.
      if (id) focusNode(id)
      else {
        dossier?.close()
        world.focus = null
        world.caption = null
      }
    }
    drag = null
  })
  canvas.addEventListener('wheel', (e) => core.zoom?.(e.deltaY), { passive: true })

  // Akýkoľvek vstup vráti plnú kvalitu (pokojový režim plochy).
  for (const type of ['pointerdown', 'wheel', 'keydown']) window.addEventListener(type, wakeUp, { capture: true, passive: true })

  let hideTimer
  const hideLater = () => {
    clearTimeout(hideTimer)
    if (!DESKTOP) hideTimer = setTimeout(() => document.body.classList.add('hide-cursor'), 3000)
  }
  window.addEventListener('pointermove', (e) => {
    wakeUp()
    document.body.classList.remove('hide-cursor')
    hideLater()
    core.setPointer?.(e.clientX, e.clientY)
    if (drag && e.pointerId === drag.id) {
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      drag.moved += Math.abs(dx) + Math.abs(dy)
      drag.x = e.clientX
      drag.y = e.clientY
      if (drag.moved > 6) core.drag?.(dx, dy)
    }
  })
  // A drag never outlives its pointer: let go anywhere (over a panel, outside the window) ends it.
  for (const type of ['pointerup', 'pointercancel']) {
    window.addEventListener(type, (e) => {
      if (drag && e.pointerId === drag.id && e.target !== canvas) drag = null
    })
  }
  window.addEventListener('blur', () => (drag = null))
  document.addEventListener('pointerleave', () => core.setPointer?.(null, null))
  window.addEventListener('pointerdown', () => speech.unlock())
  hideLater()
}

// ── pokojový režim plochy ─────────────────────────────────────────────────

function wakeUp() {
  lastInput = now()
  if (idle) setIdle(false)
}

function setIdle(on) {
  idle = on
  document.documentElement.classList.toggle('hud-idle', on)
  desk()?.post?.({ type: 'log', text: on ? `pokoj: ${IDLE_FPS} fps, DPR ${IDLE_DPR}` : 'plná kvalita' })
  // Nižšie DPR jadra v pokoji, plné hneď pri prebudení (svet beží ďalej v tom istom čase T).
  layout()
  if (on) speech.micRelease()
}

/** Pokoj: appka na ploche, HUD nie je vytiahnutý, 20 s bez vstupu, Jarvis nič nerobí, kamera doma. */
function updateIdle(f, T) {
  const want =
    !desk()?.isRaised &&
    T - lastInput > IDLE_AFTER_S &&
    f.voiceState === 'idle' &&
    !f.focus &&
    (core.info?.().phase ?? 'home') === 'home' &&
    !chat.activeState() &&
    !speech.speaking() &&
    !ptt
  if (want !== idle) setIdle(want)
}

// ── main ─────────────────────────────────────────────────────────────────

async function preloadImages(urls) {
  await Promise.all(
    urls.map(
      (src) =>
        new Promise((done) => {
          const img = new Image()
          img.onload = img.onerror = () => (img.decode ? img.decode().catch(() => undefined).then(done) : done())
          img.src = src
        }),
    ),
  )
}

async function main() {
  if (CAPTURE) document.body.classList.add('capture')
  if (SCENE_ID) document.body.classList.add('scene')
  // Scény a capture idú zo statického snapshotu (čísla sedia so scenárom), live zo živého.
  snapshot = await api.snapshot()
  if (SCENE_ID) {
    const data = await api.scene(SCENE_ID)
    scene = prepareScene(data)
    if (data.audio) audio = await loadAudio(data.audio)
  }
  const counted = await loadInnerCounts(SCENE_ID ? 1 : 2500)
  if (!SCENE_ID) loadSuggest()
  if (!SCENE_ID && !CAPTURE) {
    try {
      const a = await (await fetch('/api/apps', { cache: 'no-store', signal: AbortSignal.timeout(2000) })).json()
      appsState = { picked: Array.isArray(a.picked) ? a.picked : [] }
    } catch {
      // bez servera ostane planéta s pozvánkou
    }
  }
  if (!SCENE_ID && !CAPTURE) {
    try {
      const o = await (await fetch('/api/orbs', { cache: 'no-store', signal: AbortSignal.timeout(2000) })).json()
      if (Array.isArray(o.custom)) orbState = { hidden: o.hidden ?? [], pinned: o.pinned ?? [], custom: o.custom, content: o.content ?? {} }
    } catch {
      // bez servera ostane základná sada orbov
    }
  }
  setWorldApps(appsState.picked)
  nodes = buildNodes(snapshot)
  await document.fonts.ready

  speech = createSpeech({
    desktop: NATIVE,
    onBlocked: () => paint('blocked', () => ui.toast('Klikni kamkoľvek, aby Jarvis mohol hovoriť', { kind: 'warn', iconName: 'speaker', ms: 6000 })),
    onError: (err) => console.warn('hlas:', err?.message ?? err),
    onPlayed: (turn, seq) => {
      fetch('/api/tts/played', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ turn, seq }) }).catch(() => undefined)
    },
  })
  ui = createUI({ capture: CAPTURE })
  const reveal = CAPTURE || SCENE_ID ? null : createReveal({ onOpen: (id) => jobs?.open(id) })
  mediaCards =
    CAPTURE || SCENE_ID
      ? null
      : createMediaCards({
          fileUrl: api.fileUrl,
          reserveTop: () => reveal?.reserved() ?? 0,
          // Esc and space belong to what is open above the cards.
          blocked: () => Boolean(settings?.isOpen?.() || document.body.classList.contains('job-open') || document.querySelector('.gv')),
          escFirst: () => Boolean(reveal?.isOpen()),
        })
  if (!CAPTURE && !SCENE_ID) initVideo({ token: params.get('token'), fileUrl: api.fileUrl, ownsAudio })
  jobs = createJobs({
    api,
    ui,
    capture: CAPTURE,
    // What waits for him is asked by Jarvis in the conversation; the center of the screen shows only results.
    onFinished: (job) => {
      if (job.status !== 'done') return
      reveal?.show(job)
      // Every photo, video and audio the job made floats as a card of its own.
      const media = (job.artifacts ?? []).filter((a) => a.kind === 'image' || a.kind === 'video' || a.kind === 'audio')
      if (media.length) mediaCards?.show(media)
    },
    onChange: () => paint('jobs', () => ui.renderJobsChip(jobs.active, jobs.waiting, jobs.asking)),
  })
  chat = createChat({ onSend: (text, via) => send(text, via), capture: CAPTURE, fileUrl: api.fileUrl, login: api.login, openTerminal: api.openTerminal, onMedia: (item) => mediaCards?.open(item) })
  if (!CAPTURE && !SCENE_ID) {
    people = createPeople({ api, ui, isFilm: () => film, onApplied: () => drop?.load() })
    drop = createDrop({ api, ui, desktop: NATIVE, onSend: (text, via) => send(text, via), onReview: () => people.open() })
  }
  ui.setSnapshot(snapshot, nodes)
  if (!counted && !SCENE_ID)
    loadInnerCounts(30_000).then((ok) => {
      if (ok) refreshNodes()
    })
  if (film) {
    chat.setFilm(true)
    document.body.classList.add('film')
  }

  const m = snapshot.memory ?? {}
  const ringText = `J.A.R.V.I.S.  ·  PAMÄŤ  ·  ${nf(m.notes ?? 0)} POZNÁMOK  ·  ${nf(m.people ?? 0)} ĽUDÍ  ·  ${nf(m.projects ?? 0)} PROJEKTOV  ·  ${nf(m.dailyLogs ?? 0)} DNÍ V DENNÍKU  ·`
  const num = (key) => (params.has(key) && Number.isFinite(Number(params.get(key))) ? Number(params.get(key)) : undefined)
  core = await createCore(canvas, { quality: QUALITY, capture: CAPTURE, ringText, nodes, bloom: num('bloom'), bloomRadius: num('bloomr'), bloomThreshold: num('bloomt'), debug: params.has('debug') })
  if (!CAPTURE && !SCENE_ID && core.inner) {
    dossier = createDossier({ core, canvas, api, onClose: () => (world.focus = null), onAsk: (text) => text && send(text, 'text') })
    dossier.setFilm(film)
    dossier.setOrbs(nodes)
    appsWorld = createAppsWorld({
      core,
      canvas,
      onClose: () => {
        world.focus = null
        world.caption = null
      },
      onChange: (a) => applyApps(a),
      // „Napojiť s Jarvisom" a vlastné appky idú do rozhovoru ako bežná správa: zvyšok vedie Jarvis.
      onAsk: (text) => text && send(text, 'text'),
    })
    warmAppTiles()
  }
  if (params.has('debug')) {
    window.__hudCore = core
    window.__hudDossier = dossier
    window.__hudDrop = drop
  }
  layout()
  window.addEventListener('resize', layout)
  if (NATIVE && !CAPTURE) bindDesktop()
  // Dosky sa dotočia (prechod 1,4 s), potom presný layout jadra.
  setTimeout(layout, 1500)
  document.body.classList.remove('is-loading')
  renderStatusChips()

  if (!scene) {
    const t = now()
    const generated = snapshot.generatedAt ? new Date(snapshot.generatedAt) : null
    const stamp = generated ? `${generated.getDate()}. ${generated.getMonth() + 1}. ${String(generated.getHours()).padStart(2, '0')}:${String(generated.getMinutes()).padStart(2, '0')}` : 'načítaný'
    const sched = snapshot.schedule ?? { items: [] }
    const day = parseDay(sched.day)
    const n = (sched.items ?? []).filter((it) => it.kind !== 'routine').length
    const routinesToday = (snapshot.routines ?? []).length
    pushLive({ type: 'info', icon: 'pamat', text: `Pamäť · načítaná ${stamp}` }, CAPTURE ? -98 : t + 0.5, { safe: true })
    pushLive({ type: 'info', icon: 'fotky', text: `Pamäť · ${nf(m.notes ?? 0)} ${plural(m.notes ?? 0, 'poznámka', 'poznámky', 'poznámok')}`, node: 'fotky' }, CAPTURE ? -97.5 : t + 0.8, { safe: true })
    pushLive({ type: 'info', icon: 'rutiny', text: `Rutiny · dnes ${routinesToday}`, node: 'rutiny' }, CAPTURE ? -97.2 : t + 1.1, { safe: true })
    pushLive({ type: 'info', icon: 'kalendar', text: `Kalendár ${day ? shortDate(day) : ''} · ${n} ${plural(n, 'položka', 'položky', 'položiek')}`, node: 'kalendar' }, CAPTURE ? -97 : t + 1.4, { safe: true })
    await loadHistory()
    if (DEMO) demoJobs(jobs.apply, { capture: CAPTURE })
    else if (!CAPTURE) api.jobs().then((list) => jobs.load(Array.isArray(list) ? list : list?.jobs ?? []), () => undefined)
    if (!CAPTURE) {
      connectEvents()
      refreshStatus()
      setInterval(refreshStatus, 30_000)
      drop?.load()
      people?.openFromHash()
      if (film) api.mode(true).catch(() => undefined)
    }
  }

  if (CAPTURE) {
    await preloadImages(['spravy', 'fotky', 'udalosti', 'spanok', 'kalendar', 'rutiny', 'projekty', 'questy'].map((n) => `/img/holo/${n}.png`))
    window.__hud = {
      duration: scene?.total ?? null,
      seek(t) {
        captureTime = t
        renderFrame(scene ? 100 + t : t)
        return true
      },
    }
    renderFrame(scene ? 100 : 30)
    window.__hudReady = true
    return
  }

  bindControls()
  bindFolds()
  settings = createSettings({ onToast: (text) => ui.toast(esc(text), { kind: 'warn', iconName: 'sliders', ms: 5000 }) })
  document.getElementById('chip-set')?.addEventListener('click', () => settings.open())
  document.getElementById('chip-mobile')?.addEventListener('click', () => settings.open('mobil'))
  if (!scene && location.hash.startsWith('#appky')) focusNode('appky', decodeURIComponent(location.hash.split('/')[1] ?? '') || null)
  // First run: the memory is empty until the onboarding in Claude is done.
  // The first setup is a conversation with Jarvis right here. On the very first start he speaks first;
  // when it was interrupted, one sentence picks it up again.
  if (!scene)
    fetch('/api/setup', { cache: 'no-store' })
      .then((r) => r.json())
      .then((s) => {
        if (s?.setup && !s.setup.done && s.setup.startedAt && s.setup.hotove?.length) ui.toast('Nastavenie ešte nie je dokončené. Povedz alebo napíš <kbd>pokračuj</kbd> a Jarvis ťa prevedie zvyškom.', { iconName: 'pamat', ms: 14000 })
      })
      .catch(() => undefined)
  if (scene) ui.toast('<kbd>Medzerník</kbd> spustí scénu · <kbd>Esc</kbd> zastaví · <kbd>F</kbd> celá obrazovka', { ms: 0, iconName: 'film' })
  else {
    // „Ahoj Jarvis" zo streamu prehliadača (wake.js). Server ho zapína cez POST /api/listen/wake.
    wake = createWake({
      desktop: NATIVE,
      onLevel: (l) => (voice.wakeLevel = l),
      onState: (st) => {
        micState = st
        renderStatusChips()
      },
      onError: (err) => console.warn('mikrofón:', err?.message ?? err),
    })
    // Only the window that owns the voice listens for the wake word (a second window would take the microphone over).
    if (ownsAudio()) wake.start()
  }

  // Plná kvalita: každý rAF. Pokoj na ploche: časovač 24 fps bez rAF (hlavné vlákno sa nebudí 120x za
  // sekundu). Skrytá stránka ide cez rAF, ktorý sa sám zastaví. Svet beží ďalej v reálnom čase T.
  function tick() {
    const T = now()
    const f = renderFrame(T)
    if (DESKTOP && !scene) updateIdle(f, T)
    if (idle && !document.hidden) setTimeout(tick, 1000 / IDLE_FPS)
    else requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  desk()?.post?.({ type: 'ready' })
}

main().catch((err) => {
  console.error(err)
  document.body.classList.remove('is-loading')
  const toast = document.getElementById('toast')
  toast.hidden = false
  toast.textContent = `Chyba: ${err.message}`
})
