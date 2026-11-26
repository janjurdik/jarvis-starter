/**
 * "Hey Jarvis" from the browser microphone (optional). The page streams 16 kHz mono int16 PCM
 * over the WebSocket /api/mic (frames of 1280 samples), a persistent Python worker
 * (openWakeWord + Silero VAD, started through uv) looks for the wake word and records the rest
 * of the sentence, the local Whisper worker transcribes it and the text goes to the chat.
 * Needs a local speech-to-text engine (JARVIS_STT=mlx or faster), see docs/HLAS.md.
 *
 * Only the latest client is active. While Jarvis speaks and 0.6 s after, the wake word is not
 * searched (echo from the speakers). A wake word interrupts a running answer.
 */
import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { WebSocketServer } from 'ws'
import { sttLocal, transcribeFile } from './stt.mjs'
import { BRAIN_DIR, errMsg, findBin, log, ROOT, spawnBin, workerEnv } from './util.mjs'

const UV = findBin('uv', { override: process.env.UV_BIN })

/** Wake word needs uv (Python worker) and a local Whisper to transcribe the command. */
export const wakeAvailable = () => Boolean(UV) && sttLocal()

/** Removes "Hey Jarvis" (and common mishearings) from a transcript. */
export function stripWakeWord(text) {
  const plain = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const match = /\b(?:(?:hey|hej|ej|hi)[\s,]+)?(d?[zj]arv[iy]s\w*|jervis\w*|charvis\w*)\b[\s,.!?:]*/.exec(plain)
  if (!match) return text.trim()
  const before = text.slice(0, match.index)
  const after = text.slice(match.index + match[0].length)
  return `${before} ${after}`.replace(/\s+/g, ' ').replace(/^[\s,.!?]+|[\s,]+$/g, '').trim()
}
const REC_DIR = join(BRAIN_DIR, 'stt')
const ECHO_TAIL_MS = 600
const STREAM_LIVE_MS = 1500
const WORKER_IDLE_MS = 10 * 60_000

let opts = {
  setVoice: () => {},
  voiceState: () => 'idle',
  onCommand: () => {},
  onNothing: () => {},
  onWakeWord: () => {},
  statusChanged: () => {},
  fallback: async () => {},
}
let wakeOn = false
let client = null
let lastFrameAt = 0
let lastStatus = 'off'
let suppressed = false
let unsuppressTimer = null
let worker = null
let workerReady = null
let workerUp = false
let workerIdleTimer = null
let lastLevelAt = 0
let wakeAt = 0
let busy = false
const stats = { wakes: 0, commands: 0, last: null }

export const micStatus = () => (!wakeOn ? 'off' : Date.now() - lastFrameAt < STREAM_LIVE_MS ? 'streaming' : 'waiting')
export const micStats = () => stats

// ── worker ─────────────────────────────────────────────────────────────

function frame(kind, payload) {
  const head = Buffer.alloc(5)
  head[0] = kind
  head.writeUInt32LE(payload.length, 1)
  return Buffer.concat([head, payload])
}

function sendCtrl(obj) {
  if (worker?.stdin.writable) worker.stdin.write(frame(2, Buffer.from(JSON.stringify(obj), 'utf8')))
}

function startWorker() {
  if (workerReady) return workerReady
  if (!UV) return Promise.reject(new Error('uv sa nenašiel'))
  workerReady = (async () => {
    await mkdir(REC_DIR, { recursive: true, mode: 0o700 })
    const thresh = /^[\d.]+$/.test(process.env.JARVIS_WAKE_THRESHOLD ?? '') ? process.env.JARVIS_WAKE_THRESHOLD : '0.5'
    log('mic', 'spúšťam wake worker (openWakeWord + Silero VAD)')
    const proc = spawnBin(UV, ['run', '--quiet', join(ROOT, 'server/wake/wake_worker.py')], {
      cwd: ROOT,
      env: workerEnv({ PYTHONUNBUFFERED: '1', WAKE_REC_DIR: REC_DIR, WAKE_THRESHOLD: thresh }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    worker = proc
    proc.stdin.on('error', () => {})
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('wake worker nenaštartoval do 10 minút')), 600_000)
      createInterface({ input: proc.stdout }).on('line', (line) => {
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (msg.event === 'ready') {
          clearTimeout(timer)
          workerUp = true
          log('mic', 'wake worker pripravený')
          if (suppressed) sendCtrl({ cmd: 'suppress', on: true })
          resolve()
          return
        }
        onWorkerEvent(msg)
      })
      createInterface({ input: proc.stderr }).on('line', (line) => {
        if (/error|traceback|exception/i.test(line)) log('mic', `worker: ${line.slice(0, 200)}`)
      })
      proc.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`wake worker skončil (${code})`))
        if (worker === proc) {
          worker = null
          workerReady = null
          workerUp = false
          busy = false
          log('mic', `wake worker skončil (${code})`)
          if (wakeOn) setTimeout(() => wakeOn && !workerReady && startWorker().catch((e) => log('mic', errMsg(e))), 3000)
        }
      })
    })
  })()
  workerReady.catch((err) => {
    log('mic', errMsg(err))
    workerReady = null
  })
  return workerReady
}

function stopWorker() {
  worker?.kill('SIGTERM')
  worker = null
  workerReady = null
  workerUp = false
}

/** Stav wake workera pre /api/status. */
export const micWorkerState = () => (workerUp ? 'ready' : workerReady ? 'starting' : 'off')

function scheduleWorkerIdle() {
  clearTimeout(workerIdleTimer)
  if (wakeOn) return
  workerIdleTimer = setTimeout(() => !wakeOn && stopWorker(), WORKER_IDLE_MS)
  workerIdleTimer.unref()
}

// ── udalosti z workera ─────────────────────────────────────────────────

function onWorkerEvent(msg) {
  if (msg.event === 'wake') {
    stats.wakes++
    wakeAt = Date.now()
    busy = true
    log('mic', `„Hey Jarvis" (skóre ${msg.score})`)
    opts.onWakeWord()
    opts.setVoice('wake')
    setTimeout(() => busy && opts.setVoice('listening', { level: 0 }), 100)
    return
  }
  if (msg.event === 'level') {
    const now = Date.now()
    if (!busy || now - lastLevelAt < 40) return
    lastLevelAt = now
    opts.setVoice('listening', { level: msg.level })
    return
  }
  if (msg.event === 'end') handleEnd(msg).catch((err) => log('mic', errMsg(err)))
}

/** Text po wake slove: bez „Hey Jarvis" a bez chvosta „…vis" z pre-rollu. */
export function cleanCommand(text) {
  let t = stripWakeWord(String(text ?? ''))
  t = t.replace(/^\s*(?:hey|hej|ej)?[\s,]*(?:d?[zj]a)?(?:rvis|vis|wis|is)(?=[\s,.!?:]|$)[\s,.!?:]*/i, '')
  return t.replace(/^[\s,.!?:]+/, '').trim()
}

async function handleEnd(msg) {
  const conn = client
  const tEnd = Date.now()
  if (!msg.path) {
    busy = false
    if (msg.reason !== 'cancel') {
      log('mic', `po wake slove ticho (${msg.reason})`)
      opts.setVoice('idle')
      opts.onNothing()
    }
    return
  }
  opts.setVoice('transcribing')
  try {
    const { text, ms } = await transcribeFile(msg.path)
    const command = cleanCommand(text)
    stats.last = { wakeToEndMs: tEnd - wakeAt, sttMs: ms, endToChatMs: Date.now() - tEnd, audioMs: msg.audio_ms, reason: msg.reason, chars: command.length }
    log('mic', `príkaz: ${msg.audio_ms} ms zvuku (${msg.reason}), prepis ${ms} ms, koniec vety → chat ${Date.now() - tEnd} ms, ${command ? `${command.length} znakov` : 'prázdny'}`)
    busy = false
    if (!command) {
      opts.setVoice('idle')
      opts.onNothing()
      return
    }
    stats.commands++
    opts.onCommand(command, { mock: conn?.mock === true, silent: conn?.silent === true })
  } catch (err) {
    busy = false
    opts.setVoice('idle')
    log('mic', `prepis zlyhal: ${errMsg(err)}`)
  } finally {
    unlink(msg.path).catch(() => {})
  }
}

// ── potlačenie ozveny ──────────────────────────────────────────────────

/** Volá sa pri každej zmene stavu `voice`. */
export function onVoice(state) {
  if (state === 'speaking') {
    clearTimeout(unsuppressTimer)
    unsuppressTimer = null
    if (!suppressed) {
      suppressed = true
      sendCtrl({ cmd: 'suppress', on: true })
    }
    return
  }
  if (suppressed && !unsuppressTimer) {
    unsuppressTimer = setTimeout(() => {
      unsuppressTimer = null
      if (opts.voiceState() === 'speaking') return
      suppressed = false
      sendCtrl({ cmd: 'suppress', on: false })
    }, ECHO_TAIL_MS)
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────

const toClient = (ws, obj) => {
  if (ws?.readyState === 1) ws.send(JSON.stringify(obj))
}

function checkStatus() {
  const now = micStatus()
  if (now === lastStatus) return
  lastStatus = now
  opts.statusChanged()
  opts.fallback(now).catch(() => {})
}

/**
 * Pripojí /api/mic k HTTP serveru. `allow(req, url)` rozhodne o prístupe (loopback + origin, alebo token).
 */
export function attachMic(server, o) {
  opts = { ...opts, ...o }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://hud.local')
    if (url.pathname !== '/api/mic') {
      socket.destroy()
      return
    }
    if (!opts.allow(req, url)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, url))
  })
  setInterval(checkStatus, 400).unref()
}

function onConnection(ws, url) {
  const prev = client
  ws.mock = url.searchParams.get('mock') === '1'
  ws.silent = url.searchParams.get('silent') === '1'
  ws.desktop = url.searchParams.get('client') === 'desktop'
  // Appka Jarvis na ploche Macu má prednosť: karta v Chrome jej mikrofón nezoberie.
  if (prev && prev !== ws && prev.desktop && !ws.desktop && prev.readyState === prev.OPEN) {
    toClient(ws, { type: 'replaced' })
    ws.close(4002, 'mikrofón má appka na ploche')
    return
  }
  client = ws
  if (prev && prev !== ws) {
    toClient(prev, { type: 'replaced' })
    prev.close(4001, 'nahradené novším klientom')
  }
  // Nový klient = nový stream: rozpracované nahrávanie zo starého sa zahodí.
  sendCtrl({ cmd: 'reset' })
  busy = false
  toClient(ws, { type: 'hello', wake: wakeOn, suppress: suppressed })
  if (wakeOn) startWorker().catch(() => {})
  ws.on('message', (data, isBinary) => {
    if (client !== ws) return
    if (!isBinary) return
    if (!wakeOn) return
    const buf = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)])
    if (buf.length < 2) return
    lastFrameAt = Date.now()
    if (lastStatus !== 'streaming') checkStatus()
    // Kým worker štartuje, zvuk sa zahadzuje: oneskorený backlog by spustil wake so starým zvukom.
    if (workerUp && worker?.stdin.writable) worker.stdin.write(frame(1, buf))
  })
  ws.on('close', () => {
    if (client === ws) {
      client = null
      sendCtrl({ cmd: 'reset' })
      if (busy) opts.setVoice('idle')
      busy = false
    }
  })
  ws.on('error', () => {})
}

/** Zapne alebo vypne „Hey Jarvis" cez prehliadač. */
export function setMicWake(on) {
  wakeOn = Boolean(on) && wakeAvailable()
  toClient(client, { type: 'wake', on: wakeOn })
  if (wakeOn) {
    clearTimeout(workerIdleTimer)
    startWorker().catch(() => {})
  } else {
    sendCtrl({ cmd: 'reset' })
    busy = false
    scheduleWorkerIdle()
  }
  checkStatus()
  opts.statusChanged()
}

export function stopMic() {
  stopWorker()
}
