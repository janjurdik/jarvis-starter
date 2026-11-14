/**
 * Speech to text for push-to-talk and the wake word.
 *
 * Engines (JARVIS_STT):
 *   browser  the page uses the browser's own speech recognition (Chrome, Edge). No install. Default.
 *   mlx      local mlx-whisper worker (Apple Silicon, needs uv and ffmpeg), audio never leaves the Mac.
 *   faster   local faster-whisper worker (Windows, Linux, Intel Macs; needs uv), slower on CPU.
 *   off      voice input disabled.
 * The local worker starts on first use and exits after 15 minutes of silence.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { BRAIN_DIR, ROOT, errMsg, findBin, log, spawnBin } from './util.mjs'

const UV = findBin('uv', { override: process.env.UV_BIN })
const FFMPEG = findBin('ffmpeg')
const WANT = (process.env.JARVIS_STT || 'browser').toLowerCase()

function pickEngine() {
  if (WANT === 'off' || WANT === 'browser') return WANT
  if (WANT === 'mlx') return UV && FFMPEG ? 'mlx' : 'browser'
  if (WANT === 'faster') return UV ? 'faster' : 'browser'
  return 'browser'
}
/** Active engine: 'browser' | 'mlx' | 'faster' | 'off'. */
export const STT_ENGINE = pickEngine()
export const sttLocal = () => STT_ENGINE === 'mlx' || STT_ENGINE === 'faster'
const WORKER = STT_ENGINE === 'faster' ? 'server/stt/faster_worker.py' : 'server/stt/whisper_worker.py'
const DIR = join(BRAIN_DIR, 'stt')
const IDLE_MS = 15 * 60_000
const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/aac': 'aac' }

/** Vocabulary hint for Whisper: typical commands in the user's language. */
export const STT_PROMPT = process.env.JARVIS_STT_PROMPT || 'Hey Jarvis, čo mám dnes v kalendári? Aké mám úlohy? Zapamätaj si, že. Otvor mi Spotify. Čo ma čaká zajtra? Ciele, projekty, denník.'

let proc = null
let ready = null
let seq = 0
const waiting = new Map()
let idleTimer = null

function start() {
  if (ready) return ready
  if (!sttLocal()) return Promise.reject(new Error('lokálny prepis reči nie je zapnutý (pozri docs/HLAS.md)'))
  if (!UV) return Promise.reject(new Error('uv sa nenašiel'))
  ready = new Promise((resolve, reject) => {
    log('stt', `spúšťam Whisper worker (${STT_ENGINE}), prvý štart sťahuje model`)
    const child = spawnBin(UV, ['run', '--quiet', join(ROOT, WORKER)], {
      cwd: ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PATH: [FFMPEG ? dirname(FFMPEG) : null, process.env.PATH ?? ''].filter(Boolean).join(delimiter) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    proc = child
    const timer = setTimeout(() => reject(new Error('Whisper worker nenaštartoval do 15 minút')), 900_000)
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.ready) {
        clearTimeout(timer)
        log('stt', 'Whisper worker pripravený')
        resolve()
        return
      }
      const job = waiting.get(msg.id)
      if (!job) return
      waiting.delete(msg.id)
      if (msg.ok) job.resolve(msg)
      else job.reject(new Error(msg.error || 'prepis zlyhal'))
    })
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (/error|traceback/i.test(line)) log('stt', line.slice(0, 200))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Whisper worker skončil (${code})`))
      for (const job of waiting.values()) job.reject(new Error('Whisper worker skončil'))
      waiting.clear()
      proc = null
      ready = null
    })
  })
  ready.catch(() => {})
  return ready
}

function touch() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (!waiting.size) proc?.kill('SIGTERM')
  }, IDLE_MS)
  idleTimer.unref()
}

/** Prepis hotového súboru (wake stream). Súbor maže volajúci. */
export async function transcribeFile(file) {
  await start()
  touch()
  const id = `s${++seq}`
  const res = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(new Error('prepis trval viac ako 60 s'))
    }, 60_000)
    waiting.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    })
    proc.stdin.write(JSON.stringify({ id, path: file, prompt: STT_PROMPT }) + '\n')
  })
  return { text: res.text ?? '', ms: res.ms }
}

/** Zvuk (Buffer) → text. Súbor žije len počas prepisu. */
export async function transcribeAudio(buffer, contentType = 'audio/webm') {
  const ext = EXT[String(contentType).split(';')[0].trim().toLowerCase()] ?? 'webm'
  await mkdir(DIR, { recursive: true, mode: 0o700 })
  const file = join(DIR, `${randomBytes(8).toString('hex')}.${ext}`)
  await writeFile(file, buffer, { mode: 0o600 })
  try {
    await start()
    touch()
    const id = `s${++seq}`
    const res = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('prepis trval viac ako 60 s'))
      }, 60_000)
      waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
      proc.stdin.write(JSON.stringify({ id, path: file, prompt: STT_PROMPT }) + '\n')
    })
    return { text: res.text ?? '', ms: res.ms }
  } finally {
    unlink(file).catch(() => {})
  }
}

/** Zahreje model vopred (napr. keď UI otvorí mikrofón). */
export function warmStt() {
  if (!sttLocal()) return
  start()
    .then(touch)
    .catch((err) => log('stt', errMsg(err)))
}

export const sttState = () => (!sttLocal() ? STT_ENGINE : proc ? (waiting.size ? 'busy' : 'ready') : 'off')

export function stopStt() {
  proc?.kill('SIGTERM')
}
