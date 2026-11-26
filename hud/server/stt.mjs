/**
 * Speech to text for push-to-talk and the wake word.
 *
 * What the user asks for (JARVIS_STT in .env, or `stt` in config/jarvis.json):
 *   auto     default: a local Whisper when this computer can run one, otherwise the browser.
 *            Which engine and model is decided by server/stt-plan.mjs and prepared ahead by
 *            `node scripts/voice.mjs prepare` (model download, a test sentence).
 *   whisper  a local Whisper even on a weak computer
 *   mlx      local mlx-whisper worker (Apple Silicon), audio never leaves the Mac
 *   faster   local faster-whisper worker (Windows, Linux, Intel Macs)
 *   browser  the page uses the browser's own speech recognition (Chrome, Edge). No install.
 *   off      voice input disabled.
 *
 * STT_ENGINE is the engine in use right now: 'browser' | 'mlx' | 'faster' | 'off'. With `auto` it
 * is 'browser' until the plan is prepared and switches by itself once it is (reloadStt).
 * The local worker starts on first use and exits after 15 minutes of silence.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { effectiveLang } from './config.mjs'
import { freshPlan, modelRef, probeSpecs, readPlan, recordFits, sttChoice, sttWorker, usablePlan } from './stt-plan.mjs'
import { BRAIN_DIR, errMsg, findBin, log, ROOT, spawnBin, workerEnv } from './util.mjs'

const UV = findBin('uv', { override: process.env.UV_BIN })
const isLocal = (engine) => engine === 'mlx' || engine === 'faster'

/**
 * The engine to use right now.
 *   - off and browser are taken as they are.
 *   - A prepared plan (stt-plan.json for this request, model on the disk) is used as recorded.
 *   - An explicit mlx or faster works as before even without a prepare: the worker fetches the
 *     model on its first start. Never on the GPU, that path must be verified by the prepare first.
 *   - auto and whisper wait for the prepare, the browser listens meanwhile (pending).
 */
function resolve() {
  const choice = sttChoice()
  const base = { choice, engine: 'browser', model: null, ref: null, device: null, pending: false, reason: '' }
  if (choice === 'off' || choice === 'browser') return { ...base, engine: choice }
  const rec = usablePlan()
  if (rec) return { ...base, engine: rec.engine, model: rec.model, ref: modelRef(rec), device: rec.device ?? null, reason: rec.reason ?? '' }
  if (choice === 'mlx' || choice === 'faster') {
    const { plan } = freshPlan({ device: 'cpu', envReady: true, specs: probeSpecs({ gpu: false }) })
    if (!isLocal(plan.engine)) return { ...base, reason: plan.reason }
    return { ...base, engine: plan.engine, model: plan.model, ref: modelRef(plan), device: plan.device, reason: plan.reason }
  }
  const stored = readPlan()
  const settled = recordFits(stored, choice) && stored.status !== 'ready'
  return { ...base, pending: !settled, reason: settled ? (stored.reason ?? '') : 'Lokálny Whisper sa ešte pripravuje.' }
}

let active = resolve()
/** Active engine: 'browser' | 'mlx' | 'faster' | 'off'. A live binding, it changes when the plan does. */
export let STT_ENGINE = active.engine
export const sttLocal = () => isLocal(STT_ENGINE)
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

/** What the settings and the doctor show: the engine in use, the model and why. */
export const sttActive = () => ({ choice: active.choice, engine: active.engine, model: active.model, device: active.device, pending: active.pending, reason: active.reason })

/**
 * Reads the request and the plan again: after `voice.mjs prepare` finished, after the settings
 * changed. A running worker of another engine or model is stopped, the next sentence starts the new one.
 * Returns true when the engine in use or the pending state changed.
 */
export function reloadStt() {
  const next = resolve()
  const changed = next.engine !== active.engine || next.ref !== active.ref || next.device !== active.device
  const pendingChanged = next.pending !== active.pending
  active = next
  if (!changed) return pendingChanged
  STT_ENGINE = next.engine
  if (proc) {
    log('stt', 'plán sa zmenil, Whisper worker sa spustí znova')
    dropWorker()
  }
  log('stt', `rozpoznávanie reči: ${next.engine}${next.model ? ` (${next.model})` : ''}`)
  return true
}

/** Ends the running worker so the next sentence starts one with the current settings (a new language). */
export function restartStt() {
  if (proc) dropWorker()
}

/** Ends a worker: closing its input stops the Python loop on its own, the signal covers one that is still starting. */
function end(child) {
  if (!child) return
  child.stdin?.end()
  child.kill('SIGTERM')
}

/** Forgets the running worker at once (its exit arrives later), so the next sentence starts a fresh one. */
function dropWorker() {
  const old = proc
  proc = null
  ready = null
  for (const job of waiting.values()) job.reject(new Error('Whisper worker skončil'))
  waiting.clear()
  end(old)
}

function start() {
  if (ready) return ready
  if (!sttLocal()) return Promise.reject(new Error('lokálny prepis reči nie je zapnutý (pozri docs/HLAS.md)'))
  if (!UV) return Promise.reject(new Error('uv sa nenašiel'))
  const started = active
  const mine = new Promise((resolveReady, reject) => {
    log('stt', `spúšťam Whisper worker (${started.engine}, ${started.model ?? started.ref})`)
    const { args, env } = sttWorker(started, started.ref, effectiveLang())
    const child = spawnBin(UV, args, { cwd: ROOT, env: workerEnv(env), stdio: ['pipe', 'pipe', 'pipe'] })
    proc = child
    const timer = setTimeout(() => {
      reject(new Error('Whisper worker nenaštartoval do 15 minút'))
      child.kill('SIGTERM')
    }, 900_000)
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
        resolveReady()
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
    child.stdin.on('error', () => {})
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
      if (proc === child) {
        proc = null
        ready = null
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Whisper worker skončil (${code})`))
      // A worker that was replaced after a plan change must not take the new one's state with it.
      if (proc !== child) return
      for (const job of waiting.values()) job.reject(new Error('Whisper worker skončil'))
      waiting.clear()
      proc = null
      ready = null
    })
  })
  ready = mine
  mine.catch(() => {})
  return mine
}

function touch() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (!waiting.size) end(proc)
  }, IDLE_MS)
  idleTimer.unref()
}

/** One request to the worker: the file is transcribed, the answer comes back by id. */
async function ask(file, prompt = STT_PROMPT) {
  await start()
  touch()
  const id = `s${++seq}`
  const res = await new Promise((resolveJob, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(new Error('prepis trval viac ako 60 s'))
    }, 60_000)
    waiting.set(id, {
      resolve: (v) => (clearTimeout(timer), resolveJob(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    })
    proc.stdin.write(JSON.stringify({ id, path: file, prompt }) + '\n')
  })
  return { text: res.text ?? '', ms: res.ms }
}

/**
 * Prepis hotového súboru (wake stream, záznam). Súbor maže volajúci. `prompt` nahradí nápovedu
 * s povelmi (záznam dáva koniec doterajšieho prepisu, prázdny reťazec = bez nápovedy).
 */
export const transcribeFile = (file, prompt) => ask(file, prompt ?? STT_PROMPT)

/** Zvuk (Buffer) → text. Súbor žije len počas prepisu. */
export async function transcribeAudio(buffer, contentType = 'audio/webm') {
  const ext = EXT[String(contentType).split(';')[0].trim().toLowerCase()] ?? 'webm'
  await mkdir(DIR, { recursive: true, mode: 0o700 })
  const file = join(DIR, `${randomBytes(8).toString('hex')}.${ext}`)
  await writeFile(file, buffer, { mode: 0o600 })
  try {
    return await ask(file)
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
  end(proc)
}
