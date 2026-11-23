#!/usr/bin/env node
/**
 * J.A.R.V.I.S. HUD server.
 *
 * Serves the app, Jarvis's brain (Claude Code CLI on the user's own Claude subscription), voice
 * (Edge TTS, optional local Whisper), a live snapshot of the local memory folder and events over
 * SSE. API: docs/API.md.
 *
 *   npm start                        http://localhost:4545
 *   JARVIS_MOCK=1 npm start          without Claude, mock answers (to try the UI)
 *   PORT=4600 npm start              another port
 *
 * Settings come from .env (see .env.example) and config/jarvis.json.
 */
import './server/env.mjs'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, createReadStream, readFileSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { quietNow } from './server/alarm.mjs'
import { Brain, EFFORT, MODEL } from './server/brain.mjs'
import { AntigravityBrain } from './server/brain-antigravity.mjs'
import { CodexBrain } from './server/brain-codex.mjs'
import { aiProvider } from './server/provider.mjs'
import { chatMetrics, currentTurnId, currentTurnInfo, getHistory, hudAction, initChat, onFilmChange, onVoiceChange, sayText, sendChat, setVoice, stopChat, ttsPlayed, voiceState } from './server/chat.mjs'
import { CONFIG_FILE, getConfig } from './server/config.mjs'
import { createJob, initJobs, jobDetail, jobFile, jobsContextNote, listJobs, loadJobs, replyJob, stopAllJobs, stopJob, waitNudge } from './server/jobs.mjs'
import { normalizeCard } from './server/cards.mjs'
import { FILES, MEMORY_DIR, getIndex, stats } from './server/memory/index.mjs'
import { attachMic, micStats, micStatus, micWorkerState, onVoice, setMicWake, stopMic, wakeAvailable } from './server/mic.mjs'
import { currentSnapshot, filmNameList, forFilm, memoryStatus, refreshSnapshot, startSnapshots } from './server/snapshot.mjs'
import { openStream, send, sendHud, setGreeting, clientCount, desktopCount, setOnRolesChange } from './server/sse.mjs'
import { saveState, setPersist, state } from './server/state.mjs'
import { pruneTtsCache, stopTts, ttsFileExists, ttsInfo, warmCommonPhrases } from './server/tts.mjs'
import { BRAIN_DIR, DATA_DIR, REPO, clean, errMsg, isLoopback, log, readJson, readRaw, sendJson, slug, winSys, writeFileAtomic } from './server/util.mjs'
import { STT_ENGINE, sttLocal, sttState, stopStt, transcribeAudio, warmStt } from './server/stt.mjs'
import { getWeather } from './server/weather.mjs'
import { routeHands } from './server/hands.mjs'
import { routeInner } from './server/inner.mjs'
import { lifeStatus, startLife } from './server/life.mjs'
import { systemNotify } from './server/notify.mjs'
import { initImports, loadImports, resolveAttachments, routeImportGet, routeImportPost } from './server/imports.mjs'
import { startUpdateWatch, updateInfo } from './server/updates.mjs'
import { callProblems } from './server/call.mjs'
import { getApps, saveApps } from './server/apps.mjs'
import { closeAppWindow, normalizeSurface } from './server/surface.mjs'
import { applyCall, applySettings, brainSettings, initSettings, previewVoice, settingsBody, testCall } from './server/settings.mjs'
import { routeVideoGet, routeVideoPost, stopVideo } from './server/video.mjs'
import { changeOrbs, getOrbs } from './server/orbs.mjs'
import { getSetup, noteSetup, setupContextNote } from './server/setup.mjs'
import { addSuggestion, dismissSuggestion, suggestContextNote, suggestions } from './server/suggest.mjs'
import { FIRST_RUN_TEXT, addressOf } from './server/persona.mjs'

const ROOT = import.meta.dirname
const PORT = Number(process.env.PORT ?? process.env.HUD_PORT ?? 4545)
const HOST = process.env.HUD_HOST ?? '127.0.0.1'
/** A secondary instance (tests, screenshots) keeps its hands off the saved state. */
const PRIMARY = process.env.JARVIS_SECONDARY !== '1'
/** Where Jarvis lives since the last move: { keep: desktop | app | browser, at: ms }. Null until somebody moved him. */
let lastKeep = null
/** Set while a restart waits for the jobs in the background to finish (POST /api/restart). */
let restartTimer = null
const MOCK_ALL = process.env.JARVIS_MOCK === '1'
const PUBLIC_DIR = join(ROOT, 'public')
const MODULES_DIR = join(REPO, 'node_modules')
const BOOTED = Date.now()
setPersist(PRIMARY)

/** Token pre POST zo siete (HUD_HOST=0.0.0.0). Loopback ho nepotrebuje. */
function hudToken() {
  if (process.env.JARVIS_HUD_TOKEN) return process.env.JARVIS_HUD_TOKEN
  const file = join(BRAIN_DIR, 'token')
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    const token = randomBytes(24).toString('hex')
    writeFileAtomic(file, token + '\n', 0o600).catch(() => {})
    return token
  }
}
const HUD_TOKEN = hudToken()
/** Token pre MCP jarvis-hud → /api/brain/hud, nový pri každom štarte servera. */
const BRAIN_TOKEN = randomBytes(24).toString('hex')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
}

/** Statické mounty: URL prefix → priečinok. Z node_modules len to, čo appka naozaj načíta. */
const MOUNTS = [
  { prefix: '/vendor/three/', dir: join(MODULES_DIR, 'three'), allow: /^(build|examples\/jsm)\//, cache: true },
  // Hand tracking (MediaPipe): the bundle and its WebAssembly, run in the page. The version is in the
  // address (the same as in package.json and in public/js/hands.js), so a browser never mixes cached
  // parts of two versions.
  { prefix: '/vendor/mediapipe-0.10.35/', dir: join(MODULES_DIR, '@mediapipe', 'tasks-vision'), allow: /^(vision_bundle\.mjs|wasm\/vision_wasm(_nosimd)?_internal\.(js|wasm))$/, cache: true },
  { prefix: '/vendor/fonts/', dir: join(MODULES_DIR, '@fontsource', 'jetbrains-mono', 'files'), allow: /\.woff2$/, cache: true },
  { prefix: '/vendor/fontsource/', dir: join(MODULES_DIR, '@fontsource'), allow: /^[a-z0-9-]+\/files\/[^/]+\.woff2$/, cache: true },
  { prefix: '/', dir: PUBLIC_DIR, allow: /./, cache: false },
]

/** The only inline script of the app is the import map of index.html: its hash is allowed, nothing else inline runs. */
function importMapHash() {
  try {
    const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8')
    const body = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
    return body ? `'sha256-${createHash('sha256').update(body).digest('base64')}'` : ''
  } catch {
    return ''
  }
}
const CSP = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' lets the hand tracking module compile its WebAssembly. It does not allow eval of text.
  `script-src 'self' 'wasm-unsafe-eval' ${importMapHash()}`.trim(),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss://localhost:* wss://127.0.0.1:*",
  // Finished jobs show a preview of the web page they made.
  'frame-src http: https:',
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

// ── pomocné ────────────────────────────────────────────────────────────────

/** Cesta vnútri `base`, inak null. Chráni pred `../` a zakódovanými lomkami. */
function safeJoin(base, rel) {
  let decoded
  try {
    decoded = decodeURIComponent(rel)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const full = normalize(join(base, decoded))
  return full === base || full.startsWith(base + sep) ? full : null
}

const tokenOk = (given, expected) => {
  const a = Buffer.from(String(given ?? ''))
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Who is asking. "Local" is only a request made on this computer straight to localhost: loopback
 * socket, a localhost Host header and no proxy headers. Everything else is remote and needs the
 * token, including requests that a tunnel or `tailscale serve` forwards from 127.0.0.1, and a
 * foreign web page that points its own domain at 127.0.0.1 (DNS rebinding).
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'tailscale-user-login']
const hostName = (req) => String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase()
const isIpHost = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^\[[0-9a-f:.]+\]$/.test(h)
function isLocal(req) {
  return isLoopback(req.socket.remoteAddress) && LOCAL_HOSTS.has(hostName(req)) && !PROXY_HEADERS.some((h) => req.headers[h] !== undefined)
}
/** Names this server may be reached under from the network, when the user opened it on purpose (HUD_HOST=0.0.0.0): JARVIS_ALLOWED_HOSTS. */
const remoteHosts = () => new Set(String(process.env.JARVIS_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean))
/** A Host header we do not know is refused outright: it is either a misconfigured tunnel or an attack. */
function hostAllowed(req) {
  const h = hostName(req)
  return LOCAL_HOSTS.has(h) || isIpHost(h) || remoteHosts().has(h)
}

/** The token is 192 random bits from the header, or ?token= where headers cannot be set (EventSource). */
function remoteTokenOk(req, url = null) {
  const given = req.headers['x-hud-token'] ?? url?.searchParams.get('token') ?? ''
  return Boolean(given) && tokenOk(given, HUD_TOKEN)
}

/**
 * Prehliadač posiela Origin. Cudzia stránka otvorená v tom istom Chrome by inak mohla cez localhost
 * spustiť príkaz (CSRF, WebSocket hijacking) a mozog ovláda počítač. Bez Origin = curl, skripty, MCP.
 */
function originOk(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** POST len z loopbacku (z vlastnej stránky), zo siete s x-hud-token. */
function allowPost(req) {
  if (isLocal(req)) return originOk(req)
  return originOk(req) && remoteTokenOk(req)
}

/** Osobné dáta (rozhovor, snapshot, hlas) zo siete len s tokenom v hlavičke alebo ?token= (EventSource). */
function allowRead(req, url) {
  if (isLocal(req)) return true
  return remoteTokenOk(req, url)
}
const PRIVATE_GET = /^\/(api\/(events|status|mode|chat\/history|metrics|snapshot|weather|jobs|apps|settings|orbs|inner|setup|attachment|import|update|video|hands)|tts\/)/

async function serveFile(req, res, file, { cache, immutable = false }) {
  let info
  try {
    info = await stat(file)
  } catch {
    return false
  }
  if (info.isDirectory()) return serveFile(req, res, join(file, 'index.html'), { cache })
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const headers = {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    // The page may load only what this server gives it and may not be framed by another site:
    // a second wall behind the escaping in the page (the brain behind this page controls a computer).
    ...(type.startsWith('text/html') ? { 'content-security-policy': CSP, 'referrer-policy': 'no-referrer', 'x-frame-options': 'SAMEORIGIN' } : {}),
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : cache ? 'public, max-age=86400' : 'no-cache',
    'accept-ranges': 'bytes',
    'last-modified': info.mtime.toUTCString(),
  }
  // Range kvôli <audio> a posúvaniu v MP3.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : info.size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : info.size - 1
    start = Math.max(0, start)
    end = Math.min(info.size - 1, end)
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` })
      res.end()
      return true
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1 })
    if (req.method === 'HEAD') return res.end(), true
    createReadStream(file, { start, end }).pipe(res)
    return true
  }
  res.writeHead(200, { ...headers, 'content-length': info.size })
  if (req.method === 'HEAD') return res.end(), true
  createReadStream(file).pipe(res)
  return true
}

// ── brain, voice, status ──────────────────────────────────────────────────

let statusTimer = null
function statusChanged() {
  clearTimeout(statusTimer)
  statusTimer = setTimeout(() => send('status', statusBody()), 40)
}

// Jarvis as a living thing: wishes on the days that matter and a word about the computer he lives in (server/life.mjs).
const life = PRIMARY
  ? startLife({
      canSpeak: () => clientCount() > 0 && !state.film && voiceState() === 'idle' && !currentTurnId(),
      brainReady: () => Boolean(brain) && !MOCK_ALL && brain.status().state === 'ready',
      speakTurn: (text) => sendChat({ text, via: 'text', hidden: true }),
      say: (text) => {
        if (clientCount() === 0) return
        announceQueue.push({ say: text })
        drainAnnounce().catch((err) => log('life', errMsg(err)))
      },
      toast: (text, icon, type) => sendHud({ type, text, icon, say: null, heard: null, node: null, source: 'jarvis' }),
      notify: systemNotify,
      quiet: () => quietNow(getConfig()),
    })
  : null
setOnRolesChange(() => {
  statusChanged()
  // Somebody opened the desktop: a wish that waited for the morning can be said now.
  life?.again()
})
initSettings({ statusChanged, primary: PRIMARY })

/** The agent Jarvis runs on: Claude Code, Codex or Antigravity (server/provider.mjs). */
const AI = aiProvider()
const CLAUDE = AI.bin()
const brainOpts = { hudUrl: `http://127.0.0.1:${PORT}`, token: BRAIN_TOKEN, onStatus: statusChanged, warmup: PRIMARY }
const brain = MOCK_ALL ? null : AI.id === 'codex' ? new CodexBrain(brainOpts) : AI.id === 'antigravity' ? new AntigravityBrain(brainOpts) : new Brain(brainOpts)

function statusBody() {
  const b = brain?.status()
  const tts = ttsInfo()
  return {
    ok: true,
    brain: MOCK_ALL ? 'mock' : b.state,
    model: MOCK_ALL ? 'mock' : b.model,
    ai: AI.id,
    aiName: AI.name,
    effort: EFFORT,
    tts: tts.provider,
    voice: tts.voice,
    stt: sttState(),
    sttEngine: STT_ENGINE,
    lang: (process.env.JARVIS_LANG || 'sk').toLowerCase().startsWith('cs') ? 'cs-CZ' : 'sk-SK',
    wake: state.wake && wakeAvailable(),
    wakeAvailable: wakeAvailable(),
    mic: micStatus(),
    wakeVia: state.wake && micStatus() === 'streaming' ? 'browser' : null,
    wakeWorker: micWorkerState(),
    wakeStats: micStats(),
    film: state.film,
    mock: MOCK_ALL,
    voiceState: voiceState(),
    // Battery, free disk and internet, as Jarvis last saw them (server/life.mjs).
    life: lifeStatus(),
    turn: currentTurnId(),
    memory: memoryStatus(),
    brainInfo: b ? { pid: b.pid, startMs: b.startMs, turns: b.turns, lastError: b.lastError, mcp: b.mcp, limit: b.limit } : null,
    primary: PRIMARY,
    clients: clientCount(),
    desktop: desktopCount(),
    uptimeS: Math.round((Date.now() - BOOTED) / 1000),
  }
}

const snapshotFor = () => currentSnapshot({ film: state.film })

initChat({ brain, getSnapshot: () => snapshotFor() ?? {}, getNames: filmNameList, getExtraContext: () => [jobsContextNote(), setupContextNote(), suggestContextNote()].filter(Boolean).join('\n'), mockAll: MOCK_ALL })
setGreeting(() => {
  // An open HUD means push-to-talk should be ready (a cold local Whisper takes a while).
  if (PRIMARY) warmStt()
  if (PRIMARY) firstRun()
  return greeting()
})

/**
 * The very first start: nobody has to type anything, Jarvis speaks first and leads the setup from
 * there (persona.mjs, section Úvodné nastavenie). Once per installation: after the greeting the
 * setup file exists and later starts stay quiet.
 */
let firstRunStarted = false
function firstRun() {
  if (firstRunStarted || MOCK_ALL || !brain) return
  const setup = getSetup()
  // `startedAt` is written with the first greeting: the preparation alone (scripts/setup.mjs) does not count.
  if (setup.done || setup.startedAt) return
  firstRunStarted = true
  const t0 = Date.now()
  const tick = async () => {
    // The brain needs a few seconds after a cold start. Nobody at the screen any more: next time.
    if (clientCount() === 0 || Date.now() - t0 > 90_000) return (firstRunStarted = false)
    if (brain.status().state !== 'ready' || currentTurnId() || voiceState() !== 'idle') return setTimeout(tick, 700)
    try {
      await noteSetup({})
      sendChat({ text: FIRST_RUN_TEXT, via: 'text', hidden: true })
    } catch (err) {
      log('setup', errMsg(err))
    }
  }
  setTimeout(tick, 2500)
}
const greeting = () => [
  ['status', statusBody()],
  ['mode', { film: state.film }],
  ['voice', { state: voiceState(), heard: null, level: null, turn: currentTurnId() }],
]

/** Mock listening: states, microphone levels and a transcript without any speech engine. */
async function mockListen(text, silent) {
  setVoice('listening', { level: 0 })
  const t0 = Date.now()
  while (Date.now() - t0 < 2000) {
    const t = (Date.now() - t0) / 1000
    const level = Math.max(0, Math.min(1, 0.35 + 0.35 * Math.sin(t * 9) * Math.sin(t * 2.3) + (t > 1.6 ? -0.4 : 0)))
    setVoice('listening', { level: Math.round(level * 100) / 100 })
    await new Promise((r) => setTimeout(r, 100))
  }
  setVoice('transcribing')
  await new Promise((r) => setTimeout(r, 450))
  sendChat({ text: text || 'Čo mám dnes v kalendári?', via: 'voice', mock: true, silent })
}

// ── memory refresh ────────────────────────────────────────────────────────

async function pushSnapshot(reason) {
  const snap = await refreshSnapshot(reason)
  if (snap) send('snapshot', state.film ? forFilm(snap) : snap)
  statusChanged()
  return snap
}

/** The persona is built from ja.md and the config: when either changes, the brain restarts once it is idle. */
const personaStamp = () => [join(MEMORY_DIR, FILES.me), CONFIG_FILE].map((f) => { try { return statSync(f).mtimeMs } catch { return 0 } }).join('|')
let lastPersona = personaStamp()
setInterval(() => {
  const now = personaStamp()
  if (now === lastPersona || !brain?.proc || brain.state !== 'ready' || currentTurnId()) return
  lastPersona = now
  brain.restart('zmena profilu v pamäti', { warmup: false }).catch((err) => log('brain', errMsg(err)))
}, 20_000).unref()

// ── events ────────────────────────────────────────────────────────────────

const EVENT_TYPES = new Set(['info', 'action', 'alert', 'done', 'guard', 'voice'])

/** A LOG line from another local process (routines, scripts). */
async function postEvent(req, res) {
  if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'udalosti len z localhostu' })
  const body = await readJson(req)
  const event = {
    type: EVENT_TYPES.has(body.type) ? body.type : 'info',
    text: clean(body.text, 140),
    icon: slug(body.icon) || null,
    say: clean(body.say, 240) || null,
    heard: clean(body.heard, 140) || null,
    node: slug(body.node) || null,
    source: clean(body.source, 24) || null,
  }
  if (!event.text && !event.say) return sendJson(res, 400, { ok: false, error: 'chýba text alebo say' })
  const sent = sendHud(event)
  return sendJson(res, 202, { ok: true, id: sent.id, clients: clientCount() })
}

/**
 * A routine reaches out: a card in the chat, a LOG line and (unless silent) Jarvis says it aloud.
 * Body: { title, text, say?, node?, icon?, silent? }. Loopback only.
 */
let announceSeq = 0
async function postAnnounce(req, res) {
  if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'len z localhostu' })
  const body = await readJson(req, 64_000)
  const title = clean(body.title, 60) || 'Jarvis'
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text && !body.say) return sendJson(res, 400, { ok: false, error: 'chýba text' })
  const card = normalizeCard({ kind: 'text', title, icon: slug(body.icon) || 'routine', node: slug(body.node) || 'rutiny', text: text.replace(/\s+/g, ' ').slice(0, 400), accent: 'ice' }, `c-r${++announceSeq}-${Date.now().toString(36)}`)
  if (card.ok) {
    send('chat', { turn: `routine-${announceSeq}`, phase: 'card', card: card.card })
    // A card on its own is a finished turn: without this the chat keeps showing the thinking dots under it.
    send('chat', { turn: `routine-${announceSeq}`, phase: 'done', text: '', ms: 0, stopped: false })
  }
  sendHud({ type: 'done', text: `${title} · pripravené`, icon: 'routine', say: null, heard: null, node: 'rutiny', source: 'jarvis' })
  const spoken = clean(body.say, 900) || clean(text, 900)
  if (body.silent !== true && spoken && clientCount() > 0) {
    announceQueue.push({ say: spoken })
    drainAnnounce().catch((err) => log('announce', errMsg(err)))
  }
  pushSnapshot('rutina').catch(() => {})
  return sendJson(res, 202, { ok: true, clients: clientCount() })
}

/**
 * Push-to-talk from the page with a local Whisper: the body is a recording (audio/webm from
 * MediaRecorder, ogg, wav, mp4). With ?send=1 (default) the transcript goes straight to the chat.
 */
async function postStt(req, res) {
  const url = new URL(req.url ?? '/', 'http://hud.local')
  const sendIt = url.searchParams.get('send') !== '0'
  const audio = await readRaw(req, 6_000_000)
  if (!sttLocal()) return sendJson(res, 409, { ok: false, error: 'lokálny prepis reči nie je zapnutý, stránka má použiť rozpoznávanie v prehliadači', engine: STT_ENGINE })
  if (audio.length < 1200) return sendJson(res, 400, { ok: false, error: 'nahrávka je prázdna' })
  if (voiceState() === 'speaking' || currentTurnId()) stopChat('počúvanie')
  setVoice('transcribing')
  const t0 = Date.now()
  try {
    const { text, ms } = await transcribeAudio(audio, req.headers['content-type'])
    const clean1 = clean(text, 2000)
    log('stt', `prepis ${ms} ms (spolu ${Date.now() - t0} ms), ${clean1 ? `${clean1.length} znakov` : 'ticho'}`)
    if (!clean1) {
      setVoice('idle')
      sendHud({ type: 'info', text: 'Nič som nepočul', icon: 'mic', say: null, heard: null, node: null, source: 'hud' })
      return sendJson(res, 200, { ok: true, text: '', turn: null, ms: Date.now() - t0 })
    }
    // Files waiting above the command bar go with the spoken message too (?attach=<JSON list of paths>).
    let attach = []
    try {
      attach = JSON.parse(url.searchParams.get('attach') ?? '[]')
    } catch {
      attach = []
    }
    const turn = sendIt ? sendChat({ text: clean1, via: 'voice', attachments: await resolveAttachments(attach) }) : null
    if (!sendIt) setVoice('idle')
    return sendJson(res, 200, { ok: true, text: clean1, turn, ms: Date.now() - t0 })
  } catch (err) {
    setVoice('idle')
    return sendJson(res, 502, { ok: false, error: `prepis zlyhal: ${errMsg(err)}` })
  }
}

/** One change to the orbs of the 3D world (hud/server/orbs.mjs): the page redraws the ring at once. */
function orbAction(body) {
  // `reload` only tells the open pages that the files changed (scripts/orb.mjs wrote them itself).
  const result = body.action === 'reload' ? { summary: 'Načítané.' } : changeOrbs(body)
  const orbs = getOrbs()
  send('orbs', orbs)
  if (body.action !== 'reload') {
    log('orbs', `${body.action} ${body.id ?? ''}`)
    // A new or changed orb flares up so the eye finds it.
    if (['add', 'update', 'show', 'pin', 'content'].includes(body.action)) send('world', { focus: null, flare: String(body.id ?? '') })
  }
  return { ok: true, ...result, ...orbs }
}

/** What the onboarding and the page need to know about this installation. */
async function setupBody() {
  const cfg = getConfig()
  const mem = stats(await getIndex())
  return {
    ok: true,
    configured: cfg.configured,
    name: cfg.name || null,
    claude: Boolean(CLAUDE),
    ai: AI.id,
    setup: getSetup(),
    brain: MOCK_ALL ? 'mock' : brain.status().state,
    brainError: brain?.status().lastError ?? null,
    memoryDir: MEMORY_DIR,
    notes: mem.notes,
    tts: ttsInfo().provider,
    sttEngine: STT_ENGINE,
    wakeAvailable: wakeAvailable(),
    routines: cfg.routines,
    platform: process.platform,
    node: process.version,
  }
}

// ── router ────────────────────────────────────────────────────────────────

async function routePost(req, res, path) {
  if (path === '/api/event') {
    if (!originOk(req)) return sendJson(res, 403, { ok: false, error: 'cudzí origin' })
    return postEvent(req, res)
  }
  if (path === '/api/announce') {
    if (!originOk(req)) return sendJson(res, 403, { ok: false, error: 'cudzí origin' })
    return postAnnounce(req, res)
  }
  if (path === '/api/brain/hud') {
    if (!isLocal(req) || !tokenOk(req.headers['x-brain-token'], BRAIN_TOKEN)) return sendJson(res, 403, { ok: false, error: 'zlý token' })
    const body = await readJson(req, 64_000)
    if (body.action === 'memory_changed') {
      pushSnapshot('zápis do pamäte').catch(() => {})
      return sendJson(res, 200, { ok: true })
    }
    if (body.action === 'call') {
      // The brain asked for a phone call: the call script runs on its own, the turn does not wait for it.
      const problems = callProblems()
      const text = clean(body.text, 1200).replace(/^-+/, '')
      if (problems.length) return sendJson(res, 400, { ok: false, error: `Hovory nie sú nastavené. ${problems[0]} Postup je v docs/HOVORY.md.` })
      if (!text) return sendJson(res, 400, { ok: false, error: 'chýba text' })
      if (currentTurnInfo()?.mock) return sendJson(res, 200, { ok: true, mock: true })
      spawn(process.execPath, [join(REPO, 'scripts', 'call.mjs'), text, '--source=hud'], { cwd: REPO, detached: true, stdio: 'ignore', windowsHide: true }).unref()
      sendHud({ type: 'action', text: 'Volám na mobil', icon: 'alarm', say: null, heard: null, node: null, source: 'jarvis' })
      return sendJson(res, 200, { ok: true })
    }
    if (body.action === 'suggest') {
      // An idea from Jarvis himself, or one he takes off the list because it is done or unwanted.
      if (body.done) await dismissSuggestion(body.done)
      else await addSuggestion(body.idea ?? {})
      const items = suggestions()
      send('suggest', { items })
      return sendJson(res, 200, { ok: true, items })
    }
    if (body.action === 'setup') {
      const setup = await noteSetup(body.note ?? {})
      send('setup', setup)
      return sendJson(res, 200, { ok: true, setup })
    }
    if (body.action === 'orb') {
      try {
        return sendJson(res, 200, orbAction(body.orb ?? {}))
      } catch (err) {
        return sendJson(res, err.status ?? 500, { ok: false, error: err.message })
      }
    }
    // The brain's `settings` tool: the same change POST /api/settings makes (server/settings.mjs).
    if (body.action === 'settings') return sendJson(res, 200, await brainSettings(body))
    const result = String(body.action ?? '').startsWith('job_') ? await jobAction(body) : hudAction(body)
    return sendJson(res, result.ok ? 200 : 400, result)
  }
  if (!allowPost(req)) return sendJson(res, 403, { ok: false, error: 'POST len z localhostu alebo s x-hud-token' })
  if (path === '/api/stt') return postStt(req, res)
  // Uploads (streamed bodies), imports and the people review: server/imports.mjs.
  if (await routeImportPost(req, res, new URL(req.url ?? '/', 'http://hud.local'), { local: isLocal(req), film: state.film })) return
  // The video theater: open a link, seek, play and pause (server/video.mjs).
  if (await routeVideoPost(req, res, path)) return
  const body = await readJson(req, 32_000)
  if (path === '/api/settings') return sendJson(res, 200, await applySettings(body))
  if (path === '/api/settings/preview') return sendJson(res, 200, await previewVoice(body))
  // Phone calls: the keys go into .env on this computer, and a test call proves they work. Only from this computer.
  if (path === '/api/settings/call' || path === '/api/settings/call/test') {
    if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'len z localhostu' })
    try {
      return sendJson(res, 200, path.endsWith('/test') ? await testCall() : await applyCall(body))
    } catch (err) {
      return sendJson(res, err.status ?? 500, { ok: false, error: err.message })
    }
  }
  const jobPath = /^\/api\/jobs\/(j\d+)\/(stop|reply)$/.exec(path)
  if (jobPath) {
    try {
      const job = jobPath[2] === 'stop' ? stopJob(jobPath[1]) : replyJob(jobPath[1], body.text)
      return sendJson(res, 200, { ok: true, job })
    } catch (err) {
      return sendJson(res, err.status ?? 500, { ok: false, error: err.message })
    }
  }
  if (path === '/api/control') {
    // Jarvis is working the mouse, the keyboard or the browser (scripts/control.mjs): the desktop shows
    // a frame around the screen and a reticle where he acts. Only from this computer.
    if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'len z localhostu' })
    const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null)
    send('control', { on: body.on !== false, label: clean(body.label, 60) || null, x: num(body.x), y: num(body.y), click: body.click === true })
    return sendJson(res, 200, { ok: true })
  }
  if (path === '/api/open-url') {
    // A link clicked in the desktop app, which is one window without tabs: it opens in the default
    // browser. Only for a click made on this computer, and only web addresses.
    if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'len z localhostu' })
    let target = null
    try {
      target = new URL(String(body.url ?? ''))
    } catch {
      target = null
    }
    if (!target || !['http:', 'https:'].includes(target.protocol)) return sendJson(res, 400, { ok: false, error: 'len http a https adresy' })
    const [bin, args] = process.platform === 'darwin' ? ['/usr/bin/open', [target.href]] : process.platform === 'win32' ? [winSys('rundll32.exe'), ['url.dll,FileProtocolHandler', target.href]] : ['xdg-open', [target.href]]
    spawn(bin, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', (err) => log('hud', `odkaz sa neotvoril: ${errMsg(err)}`)).unref()
    return sendJson(res, 200, { ok: true })
  }
  if (path === '/api/surface/keep') {
    // The launcher opened Jarvis in his place: every other place gives itself back (server/surface.mjs).
    const keep = normalizeSurface(body.keep)
    if (!keep) return sendJson(res, 400, { ok: false, error: 'keep: desktop, app alebo browser' })
    lastKeep = { keep, at: Date.now() }
    send('surface', { keep })
    const closed = keep === 'app' ? 0 : closeAppWindow(DATA_DIR)
    log('hud', `Jarvis je teraz: ${keep}${closed ? ', okno appky zavreté' : ''}`)
    return sendJson(res, 200, { ok: true, keep, clients: clientCount() })
  }
  if (path === '/api/apps/open') {
    // Setup (scripts/hud.mjs --apps) or Jarvis: the camera flies to the Tvoje appky orb and the picker opens.
    const app = slug(body.app) || null
    send('world', { focus: 'appky', caption: null, app })
    return sendJson(res, 200, { ok: true, clients: clientCount() })
  }
  if (path === '/api/apps') {
    const apps = saveApps(body)
    send('apps', apps)
    log('apps', `${apps.picked.length} appiek, ${apps.own.length} vlastných`)
    send('suggest', { items: suggestions() })
    return sendJson(res, 200, { ok: true, ...apps })
  }
  if (path === '/api/suggest') {
    if (body.dismiss !== undefined) await dismissSuggestion(body.dismiss)
    else if (body.add) await addSuggestion(body.add)
    else return sendJson(res, 400, { ok: false, error: 'dismiss alebo add' })
    const items = suggestions()
    send('suggest', { items })
    return sendJson(res, 200, { ok: true, items })
  }
  if (path === '/api/orbs') return sendJson(res, 200, orbAction(body))
  if (path === '/api/jobs') {
    const job = await createJob({ task: body.task, title: body.title, weight: body.weight, mock: body.mock === true, silent: body.silent === true })
    return sendJson(res, 202, { ok: true, job })
  }

  switch (path) {
    case '/api/chat': {
      const attachments = await resolveAttachments(body.attachments)
      const turn = sendChat({ text: body.text, via: body.via, mock: body.mock === true, silent: body.silent === true, scenario: typeof body.scenario === 'string' ? body.scenario : null, attachments })
      return sendJson(res, 202, { ok: true, turn })
    }
    case '/api/chat/stop':
      return sendJson(res, 200, { ok: true, ...stopChat('stop') })
    case '/api/listen': {
      // Server-side listening exists only as a mock (UI tests). Real voice comes from the page.
      if (body.mock === true || MOCK_ALL) {
        if (voiceState() === 'speaking' || currentTurnId()) stopChat('počúvanie')
        mockListen(clean(body.text, 400), body.silent === true).catch((err) => log('listen', errMsg(err)))
        return sendJson(res, 202, { ok: true, state: 'listening', mock: true })
      }
      return sendJson(res, 409, { ok: false, error: 'hovor cez medzerník v okne HUD' })
    }
    case '/api/listen/wake': {
      if (body.on === true && !wakeAvailable()) return sendJson(res, 409, { ok: false, error: 'Hey Jarvis potrebuje lokálny prepis reči (pozri docs/HLAS.md)' })
      state.wake = body.on === true
      await saveState()
      setMicWake(state.wake)
      statusChanged()
      return sendJson(res, 200, { ok: true, wake: state.wake, mic: micStatus(), wakeVia: statusBody().wakeVia })
    }
    case '/api/mode': {
      if (typeof body.film !== 'boolean') return sendJson(res, 400, { ok: false, error: 'film musí byť true alebo false' })
      const changed = state.film !== body.film
      state.film = body.film
      await saveState()
      if (changed) {
        onFilmChange(state.film)
        send('mode', { film: state.film })
        const snap = snapshotFor()
        if (snap) send('snapshot', snap)
        // Clean brain memory: nothing from the conversation before filming (names) may reach the screen.
        if (state.film && brain?.proc) brain.restart('režim natáčania', { warmup: false }).catch((err) => log('brain', errMsg(err)))
        statusChanged()
      }
      return sendJson(res, 200, { ok: true, film: state.film })
    }
    case '/api/stt/warm':
      warmStt()
      return sendJson(res, 202, { ok: true, stt: sttState() })
    case '/api/say':
      return sendJson(res, 202, { ok: true, turn: sayText(body.text) })
    case '/api/tts/played':
      return sendJson(res, 200, { ok: ttsPlayed(body.turn, Number(body.seq)) })
    case '/api/brain/restart':
      if (!brain) return sendJson(res, 409, { ok: false, error: 'mock režim, mozog nebeží' })
      brain.restart('ručný reštart').catch((err) => log('brain', errMsg(err)))
      return sendJson(res, 202, { ok: true })
    case '/api/restart': {
      // `node scripts/hud.mjs --restart` asks first. A restart ends every job in the background, and a
      // job that restarts the HUD itself would end in the middle of its own restart. So while something
      // runs, the restart waits: the server does it on its own once the last job is done.
      if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'len z localhostu' })
      const busy = listJobs().filter((j) => j.status === 'running' || j.status === 'queued').length
      if (!busy) return sendJson(res, 200, { ok: true, deferred: false })
      if (!restartTimer) {
        log('hud', `reštart počká na ${busy} bežiacu úlohu`)
        restartTimer = setInterval(() => {
          const left = listJobs().filter((j) => j.status === 'running' || j.status === 'queued').length
          if (left) return
          clearInterval(restartTimer)
          restartTimer = null
          log('hud', 'úlohy dobehli, reštartujem sa')
          spawn(process.execPath, [join(REPO, 'scripts', 'hud.mjs'), '--restart', '--now'], { cwd: REPO, detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref()
        }, 2000)
        restartTimer.unref()
      }
      return sendJson(res, 200, { ok: true, deferred: true, jobs: busy })
    }
    case '/api/quit':
      // Lets `node scripts/hud.mjs --stop` end the server no matter who started it.
      if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'len z localhostu' })
      sendJson(res, 200, { ok: true })
      setTimeout(() => shutdown('api/quit'), 50)
      return
    case '/api/snapshot/refresh': {
      const snap = await pushSnapshot('ručne')
      return sendJson(res, 200, { ok: true, source: snap?.source ?? null, errors: snap?.errors ?? [] })
    }
    default:
      return sendJson(res, 404, { ok: false, error: `nenájdené: POST ${path}` })
  }
}

async function route(req, res) {
  const url = new URL(req.url ?? '/', 'http://hud.local')
  const path = url.pathname

  if (!hostAllowed(req)) return sendJson(res, 421, { ok: false, error: 'neznáma adresa: Jarvis odpovedá len na localhost' })
  if (req.method === 'POST') return routePost(req, res, path)
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'len GET, HEAD a POST' })
  if (PRIVATE_GET.test(path) && !allowRead(req, url)) return sendJson(res, 403, { ok: false, error: 'zo siete len s tokenom (x-hud-token alebo ?token=)' })
  // Another web page open in the same browser may not even poke the API (some GETs start work or call out).
  const site = req.headers['sec-fetch-site']
  if (path.startsWith('/api/') && site !== undefined && site !== 'same-origin' && site !== 'none') return sendJson(res, 403, { ok: false, error: 'cudzia stránka' })

  if (path === '/api/update') return sendJson(res, 200, { ok: true, ...(await updateInfo()) })
  if (path === '/api/events') return openStream(req, res, { role: url.searchParams.get('client') === 'desktop' ? 'desktop' : 'browser' })
  if (path === '/api/status') return sendJson(res, 200, statusBody())
  if (path === '/api/setup') return sendJson(res, 200, await setupBody())
  if (path === '/api/mode') return sendJson(res, 200, { film: state.film })
  if (path === '/api/jobs') return sendJson(res, 200, listJobs())
  if (path === '/api/apps') return sendJson(res, 200, getApps())
  if (path === '/api/suggest') return sendJson(res, 200, { ok: true, items: suggestions() })
  if (path === '/api/settings') return sendJson(res, 200, settingsBody())
  if (path === '/api/orbs') return sendJson(res, 200, { ok: true, ...getOrbs() })
  // An image a finished job named in its result, shown in the middle of the desktop. Only those exact files.
  const jobImg = /^\/api\/jobs\/(j\d+)\/file\/(\d{1,2})$/.exec(path)
  if (jobImg) {
    const file = jobFile(jobImg[1], jobImg[2])
    if (file && (await serveFile(req, res, file, { cache: false })) !== false) return
    return sendJson(res, 404, { ok: false, error: 'súbor nie je' })
  }
  // One job with its assignment and the whole feed, for the detail view.
  const jobOne = /^\/api\/jobs\/(j\d+)$/.exec(path)
  if (jobOne) {
    try {
      return sendJson(res, 200, { ok: true, job: await jobDetail(jobOne[1]) })
    } catch (err) {
      return sendJson(res, err.status ?? 500, { ok: false, error: err.message })
    }
  }
  if (path === '/api/chat/history') return sendJson(res, 200, getHistory())
  if (path === '/api/metrics') return sendJson(res, 200, { turns: chatMetrics(), brain: brain?.status() ?? null })
  if (path === '/api/snapshot') return sendJson(res, 200, snapshotFor() ?? (await refreshSnapshot('prvé načítanie')) ?? {})
  // Inner worlds of the planets from the memory folder (server/inner.mjs), 403 in filming mode.
  if (await routeInner(req, res, url, { film: state.film })) return
  // The model for hand control (server/hands.mjs).
  if (await routeHands(req, res, url)) return
  // Attachments, import status and the people review (server/imports.mjs).
  if (await routeImportGet(req, res, url, { film: state.film })) return
  // Analysed videos: state, transcript and the file itself with range requests (server/video.mjs).
  if (await routeVideoGet(req, res, url)) return
  if (path === '/api/weather') {
    try {
      const days = Math.min(7, Math.max(1, Number(url.searchParams.get('days')) || 3))
      return sendJson(res, 200, await getWeather(url.searchParams.get('place') || getConfig().city, days))
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: errMsg(err) })
    }
  }
  if (path.startsWith('/tts/')) {
    const file = await ttsFileExists(path.slice(5))
    if (file && (await serveFile(req, res, file, { cache: true, immutable: true }))) return
    return sendJson(res, 404, { ok: false, error: 'klip neexistuje' })
  }
  // keep and keepAt: where Jarvis lives since the last move and when it was decided (the desktop app reads it, server/surface.mjs).
  if (path === '/api/health') return sendJson(res, 200, { ok: true, port: PORT, clients: clientCount(), primary: PRIMARY, ...(lastKeep ? { keep: lastKeep.keep, keepAt: lastKeep.at } : {}) })

  for (const mount of MOUNTS) {
    if (!path.startsWith(mount.prefix)) continue
    const rel = path.slice(mount.prefix.length) || 'index.html'
    if (!mount.allow.test(rel)) continue
    const file = safeJoin(mount.dir, rel)
    if (file && (await serveFile(req, res, file, mount))) return
  }
  sendJson(res, 404, { ok: false, error: `nenájdené: ${path}` })
}

/** The memory, the runtime data and the secrets belong to this user only (a shared family computer has other accounts). */
function lockDown() {
  if (process.platform === 'win32') return
  for (const [path, mode] of [[DATA_DIR, 0o700], [MEMORY_DIR, 0o700], [join(REPO, '.env'), 0o600]]) {
    try {
      chmodSync(path, mode)
    } catch {
      // not there yet, or not ours to change
    }
  }
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    const status = err.status ?? 500
    if (status >= 500) console.error(`✗ ${req.method} ${String(req.url ?? '').split('?')[0]}: ${err.message}`)
    if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message })
    else res.end()
  })
})

// ── background jobs ───────────────────────────────────────────────────────

/** Tools agent_* from the MCP server jarvis-hud. A job inherits silent and mock from the turn that started it. */
async function jobAction(body) {
  const info = currentTurnInfo()
  try {
    if (body.action === 'job_task') return { ok: true, job: await createJob({ task: body.task, title: body.title, weight: body.weight, mock: info?.mock, silent: info?.silent }) }
    if (body.action === 'job_list') return { ok: true, jobs: listJobs() }
    if (body.action === 'job_reply') return { ok: true, job: replyJob(String(body.id ?? ''), body.text) }
    if (body.action === 'job_stop') return { ok: true, job: stopJob(String(body.id ?? '')) }
    return { ok: false, error: `neznáma akcia ${body.action}` }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/** A job's state in Jarvis's own words: the jobs are his hands, he is the one who asks and waits. */
const jobState = (job) =>
  job.status === 'done' ? 'hotovo' : job.status === 'needs_ok' ? (job.wait === 'question' ? 'mám otázku' : 'čakám na súhlas') : 'nepodarilo sa'

/** What Jarvis says about a finished job when the voice brain cannot speak for himself (no brain, mock). */
function jobLine(job) {
  const { address } = addressOf()
  const call = address ? `${address[0].toUpperCase()}${address.slice(1)}, ` : ''
  if (job.status === 'needs_ok') {
    const raw = String(job.needsOk ?? '').trim()
    // After the address the question goes on in lower case ("Pane, ako sa…"), a name or an acronym stays as it is.
    const q = call && /^\p{Lu}\p{Ll}/u.test(raw) ? `${raw[0].toLowerCase()}${raw.slice(1)}` : raw
    return job.wait === 'question' ? `${call}${q}` : `${call}mám pripravené: ${q.replace(/[.?!]\s*$/, '')}. Môžem?`
  }
  if (job.status === 'done') return job.say || `Hotovo: ${job.title}.`
  return `${call}${job.title} sa mi nepodarilo. ${job.say ?? ''}`.trim()
}
/** The voice brain can take a turn of its own right now. */
const brainCanAsk = () => Boolean(brain) && !MOCK_ALL && brain.status().state === 'ready' && clientCount() > 0
const announceQueue = []
let announcing = false
/** Announcements (finished jobs, routines) wait until Jarvis stops talking and no turn or listening runs. */
async function drainAnnounce() {
  if (announcing) return
  announcing = true
  try {
    while (announceQueue.length) {
      while (voiceState() !== 'idle' || currentTurnId()) await new Promise((r) => setTimeout(r, 400))
      const { job, silent, say } = announceQueue.shift()
      // Quiet hours: a job that finishes at night ("cez noc mi priprav…") shows its card, the voice waits for the morning brief.
      const hush = quietNow(getConfig())
      if (say) {
        if (hush) continue
        sayText(say)
        await new Promise((r) => setTimeout(r, 1200))
        continue
      }
      const title = job.title
      // A job that needs him: Jarvis himself asks, in his own words and with the address from the settings.
      if (job.status === 'needs_ok' && !silent && !hush && brainCanAsk()) {
        sendHud({ type: 'alert', text: `${jobState(job)[0].toUpperCase()}${jobState(job).slice(1)} · ${title}`, icon: 'alarm', say: null, heard: null, node: 'projekty', source: 'jarvis' })
        systemNotify({ title: `Jarvis · ${jobState(job)}`, body: job.needsOk ?? title, job: job.id, quiet: hush })
        pushSnapshot('úloha').catch(() => {})
        try {
          sendChat({ text: waitNudge(job), via: 'text', hidden: true })
          // The question is a turn of its own: the next announcement waits until it is said.
          await new Promise((r) => setTimeout(r, 1500))
          continue
        } catch (err) {
          log('jobs', errMsg(err))
        }
      }
      const wait = job.status === 'needs_ok'
      const res = normalizeCard(
        {
          kind: 'text',
          title: wait ? `${jobState(job)[0].toUpperCase()}${jobState(job).slice(1)}: ${title}` : title,
          icon: job.status === 'done' ? 'check' : wait ? 'alarm' : 'shield',
          node: 'projekty',
          accent: job.status === 'done' ? 'ice' : wait ? 'amber' : 'red',
          text: (wait ? job.needsOk : job.summary && job.summary.length > 300 ? `${job.summary.slice(0, 297).trimEnd()}…` : job.summary) || jobLine(job),
          caption: job.cost?.ms ? `${Math.round(job.cost.ms / 1000)} s, ${job.cost.turns} krokov` : null,
        },
        `c-${job.id}-${Date.now().toString(36)}`,
      )
      if (res.ok) {
        send('chat', { turn: `job-${job.id}`, phase: 'card', card: res.card, job: job.id })
        send('chat', { turn: `job-${job.id}`, phase: 'done', text: '', ms: 0, stopped: false })
      }
      sendHud({ type: job.status === 'done' ? 'done' : 'alert', text: `${title} · ${jobState(job)}`, icon: job.status === 'done' ? 'check' : 'alarm', say: null, heard: null, node: 'projekty', source: 'jarvis' })
      pushSnapshot('úloha').catch(() => {})
      // A notification of the system as well: the desktop is under the windows, a toast there is easy to miss.
      systemNotify({
        title: `Jarvis · ${jobState(job)}`,
        body: [title, wait ? job.needsOk : (job.say ?? job.summary)].filter(Boolean).join(': '),
        job: job.id,
        quiet: hush,
      })
      if (!silent && !hush) {
        // Only the short spoken line is read, never the whole written result.
        sayText(jobLine(job).slice(0, 420))
        await new Promise((r) => setTimeout(r, 1200))
      }
    }
  } finally {
    announcing = false
  }
}

initJobs({
  send,
  control: (c) => send('control', c),
  isFilm: () => state.film,
  persist: PRIMARY,
  announce: (job, { silent }) => {
    announceQueue.push({ job, silent })
    drainAnnounce().catch((err) => log('jobs', errMsg(err)))
  },
})
if (PRIMARY) loadJobs().catch(() => {})

initImports({
  send,
  sendHud,
  createJob,
  pushSnapshot,
  isFilm: () => state.film,
  persist: PRIMARY,
  // One sentence after the people review, said once Jarvis is quiet (same queue as routines).
  say: (text) => {
    if (!text || clientCount() === 0) return
    announceQueue.push({ say: text })
    drainAnnounce().catch((err) => log('import', errMsg(err)))
  },
})
if (PRIMARY) loadImports().catch(() => {})
// The activity log (what was in front, every minute): the source of the evening diary. docs/AKTIVITA.md
import('./server/activity.mjs').then((m) => m.startActivity({ primary: PRIMARY })).catch((err) => log('activity', errMsg(err)))

attachMic(server, {
  allow: (req, url) => hostAllowed(req) && originOk(req) && (isLocal(req) || remoteTokenOk(req, url)),
  setVoice,
  voiceState,
  onCommand: (text, { mock, silent }) => {
    try {
      sendChat({ text, via: 'voice', mock, silent })
    } catch (err) {
      log('mic', errMsg(err))
    }
  },
  onNothing: () => sendHud({ type: 'info', text: 'Nič som nepočul', icon: 'mic', say: null, heard: null, node: null, source: 'hud' }),
  // "Hey Jarvis" while thinking is a new command, the running answer is interrupted.
  onWakeWord: () => {
    if (currentTurnId()) stopChat('wake word')
  },
  statusChanged,
  fallback: async () => {},
})
onVoiceChange(onVoice)

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `✗ port ${PORT} je obsadený. Beží už HUD? Iný port: PORT=4546 npm start` : `✗ ${err.message}`)
  process.exit(1)
})

function shutdown(signal) {
  log('hud', `koniec (${signal})`)
  brain?.stop()
  stopAllJobs()
  stopVideo()
  stopMic()
  stopTts()
  stopStt()
  setTimeout(() => process.exit(0), 300).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

server.listen(PORT, HOST, async () => {
  const urls = [`http://localhost:${PORT}`]
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(networkInterfaces())) {
      for (const net of list ?? []) if (net.family === 'IPv4' && !net.internal) urls.push(`http://${net.address}:${PORT}`)
    }
  }
  const cfg = getConfig()
  console.log(`\n  J.A.R.V.I.S. HUD${PRIMARY ? '' : ' (vedľajšia inštancia)'}\n`)
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) console.log('  POZOR: Jarvis je otvorený do siete (HUD_HOST). Kto pozná token z data/brain/token, ovláda tento počítač, a po bežnej sieti ide token nešifrovane. Otvor ho radšej len cez šifrovaný tunel (napríklad tailscale serve).\n')
  lockDown()
  for (const u of urls) console.log(`  ${u}`)
  console.log(`\n  mozog: ${MOCK_ALL ? 'MOCK (JARVIS_MOCK=1)' : CLAUDE ? `${AI.name} (${AI.id !== 'claude' ? brain.status().model : `${MODEL}, effort ${EFFORT}`})` : `${AI.product} CLI sa nenašiel`} · hlas: ${ttsInfo().provider} · reč: ${STT_ENGINE}`)
  console.log(`  pamäť: ${MEMORY_DIR}${cfg.configured ? '' : '\n  nastavenie ešte neprebehlo: Jarvis ťa ním prevedie na ploche'}\n`)
  await startSnapshots(() => state.film).catch((err) => log('snapshot', errMsg(err)))
  if (PRIMARY) {
    pruneTtsCache()
      .then(() => warmCommonPhrases())
      .catch(() => {})
    if (brain && CLAUDE && process.env.JARVIS_BRAIN_AUTOSTART !== '0') brain.start('štart servera').catch((err) => log('brain', errMsg(err)))
    if (state.wake) setMicWake(true)
    // A new version on GitHub: say it once and wait for the user's yes (the update itself is docs/AKTUALIZACIE.md).
    startUpdateWatch({
      onAvailable: ({ version, summary }) => {
        const card = normalizeCard({ kind: 'text', title: `Nová verzia Jarvisa ${version}`, icon: 'routine', node: 'rutiny', text: clean(summary, 400) || 'Je dostupná nová verzia.', caption: 'Povedz „aktualizuj Jarvisa"', accent: 'ice' }, `c-u-${Date.now().toString(36)}`)
        if (card.ok) {
          send('chat', { turn: `update-${version}`, phase: 'card', card: card.card })
          send('chat', { turn: `update-${version}`, phase: 'done', text: '', ms: 0, stopped: false })
        }
        sendHud({ type: 'info', text: `Nová verzia ${version}`, icon: 'routine', say: null, heard: null, node: 'rutiny', source: 'jarvis' })
        if (clientCount() > 0) {
          announceQueue.push({ say: `Vyšla nová verzia Jarvisa, ${version}. Stačí povedať aktualizuj a nainštalujem ju tak, aby vám ostali vaše úpravy.` })
          drainAnnounce().catch((err) => log('update', errMsg(err)))
        }
      },
    })
  }
})
