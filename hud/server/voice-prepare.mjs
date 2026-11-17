/**
 * Gets the voice ready before the HUD opens: `node scripts/voice.mjs prepare`.
 *
 *   uv       is the program that runs the Python workers installed
 *   plan     which speech-to-text engine and model this computer gets (server/stt-plan.mjs)
 *   tts      the voice's Python packages, a test sentence and the most common phrases
 *   whisper  the model (downloaded with resume and checked against its SHA-256), the worker's
 *            Python packages and a test: the sentence the voice just said is transcribed back
 *
 * Nothing here may leave the setup broken. Whatever fails (no uv, no network, a full disk, a slow
 * processor) ends in a recorded fallback to the browser's speech recognition with a sentence that
 * says why, and a later start tries again when it makes sense. Every wait has a time limit.
 *
 * Progress goes to the callback and into data/voice/prepare.json, which is also the lock: a second
 * prepare started meanwhile follows the first one instead of downloading the same files twice.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { effectiveLang } from './config.mjs'
import { MODELS, PROGRESS_FILE, VOICE_DIR, findModel, freshPlan, modelBytes, modelsDir, planFingerprint, prepareRunning, probeSpecs, publicSpecs, readPlan, readProgress, sttWorker, usablePlan, writePlan } from './stt-plan.mjs'
import { stopTts, synthesize, ttsInfo, warmCommonPhrases } from './tts.mjs'
import { errMsg, findBin, ROOT, sleep, spawnBin, workerEnv } from './util.mjs'
import { voiceById } from './voices.mjs'

/** Where the models come from. HF_ENDPOINT may name a mirror: every file is checked against its SHA-256 whatever the source. */
const HF = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[\w./-]*)?$/i.test(process.env.HF_ENDPOINT ?? '') ? process.env.HF_ENDPOINT.replace(/\/+$/, '') : 'https://huggingface.co'
/** No byte for this long means the connection is dead: the request is dropped and resumed. */
const STALL_MS = 45_000
const DOWNLOAD_LIMIT_MS = 3 * 3600_000
const ENV_LIMIT_MS = 25 * 60_000
/** A test sentence slower than this is no use for push-to-talk: the next smaller model is tried. */
const SLOW_MS = 4000
const SAMPLE = { sk: 'Dobrý deň. Čo mám dnes v kalendári?', cs: 'Dobrý den. Co mám dnes v kalendáři?' }

const size = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.round(bytes / 1e6)} MB`)
const plain = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

function withTimeout(promise, ms, message) {
  let timer
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

// ── download ──────────────────────────────────────────────────────────────

async function sizeOf(file) {
  try {
    return (await stat(file)).size
  } catch {
    return -1
  }
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * One file with resume: what is already in `<dest>.part` is kept and the rest is asked for with a
 * Range request. A dead connection is dropped after STALL_MS and picked up again where it stopped.
 */
async function downloadFile(url, dest, size, onBytes, signal) {
  const part = `${dest}.part`
  let failures = 0
  for (;;) {
    let have = Math.max(0, await sizeOf(part))
    if (have > size) {
      await rm(part, { force: true })
      have = 0
    }
    if (have === size) break
    const startedAt = have
    const ctl = new AbortController()
    const stop = () => ctl.abort(signal?.reason ?? new Error('zrušené'))
    signal?.addEventListener('abort', stop, { once: true })
    let stall = setTimeout(() => ctl.abort(new Error('spojenie neodpovedá')), STALL_MS)
    try {
      if (signal?.aborted) stop()
      const res = await fetch(url, { headers: { 'user-agent': 'jarvis-starter', ...(have ? { range: `bytes=${have}-` } : {}) }, signal: ctl.signal, redirect: 'follow' })
      if (res.status === 416) {
        await rm(part, { force: true })
        continue
      }
      if (!res.ok || !res.body) throw new Error(`server odpovedal ${res.status}`)
      // 206 continues the file, anything else starts it again from the first byte.
      const resumed = res.status === 206 && new RegExp(`^bytes ${have}-`).test(res.headers.get('content-range') ?? '')
      if (!resumed) have = 0
      const counter = new Transform({
        transform(chunk, _enc, done) {
          have += chunk.length
          clearTimeout(stall)
          stall = setTimeout(() => ctl.abort(new Error('spojenie neodpovedá')), STALL_MS)
          onBytes(have)
          done(null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(part, { flags: resumed ? 'a' : 'w' }), { signal: ctl.signal })
      if (have !== size) throw new Error('súbor prišiel neúplný')
      break
    } catch (err) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('zrušené')
      if (err?.code === 'ENOSPC') throw Object.assign(new Error('na disku došlo miesto'), { cause: 'disk' })
      // An attempt that moved forward does not count against the limit: a slow line still gets there.
      failures = (await sizeOf(part)) > startedAt + 1_000_000 ? 0 : failures + 1
      if (failures >= 5) {
        // fetch only says "fetch failed": the code underneath tells a dead network from everything else.
        const offline = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(err?.cause?.code)
        throw new Error(offline ? 'model sa nedá stiahnuť, skontroluj pripojenie na internet' : `sťahovanie zlyhalo: ${errMsg(ctl.signal.reason ?? err)}`)
      }
      await sleep(Math.min(20_000, 1500 * 2 ** failures))
    } finally {
      clearTimeout(stall)
      signal?.removeEventListener('abort', stop)
    }
  }
  await rename(part, dest)
}

/** Every file of a model must have the SHA-256 this release was tested with. A wrong file is removed. */
async function verifyModel(dir, model, { removable }) {
  for (const f of model.files) {
    const got = await sha256(join(dir, f.path))
    if (got === f.sha256) continue
    if (removable) await unlink(join(dir, f.path)).catch(() => {})
    throw new Error(`súbor ${f.path} má nesprávny odtlačok`)
  }
}

/** A model into Jarvis's own folder. Files that are complete are kept, the rest is downloaded. */
async function fetchModel(engine, name, onProgress, signal) {
  const model = MODELS[engine][name]
  const dir = join(modelsDir(), `${engine}-${name}`)
  await mkdir(dir, { recursive: true })
  const total = modelBytes(engine, name)
  let done = 0
  for (const f of model.files) {
    const dest = join(dir, f.path)
    if ((await sizeOf(dest)) !== f.size) {
      const url = `${HF}/${model.repo}/resolve/${model.rev}/${f.path}`
      await downloadFile(url, dest, f.size, (n) => onProgress(done + n, total), signal)
    }
    done += f.size
    onProgress(done, total)
  }
  return dir
}

// ── the Whisper worker ────────────────────────────────────────────────────

/** Starts the worker of a plan and talks to it in JSON lines. */
function startWorker(uv, plan, ref) {
  const { args, env } = sttWorker(plan, ref, effectiveLang())
  const child = spawnBin(uv, args, { cwd: ROOT, env: workerEnv(env), stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map()
  let seq = 0
  let errTail = ''
  let fail = () => {}
  const ready = new Promise((resolve, reject) => {
    fail = reject
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.ready) return resolve(msg)
      const job = waiting.get(msg.id)
      if (!job) return
      waiting.delete(msg.id)
      if (msg.ok) job.resolve(msg)
      else job.reject(new Error(msg.error || 'prepis zlyhal'))
    })
  })
  ready.catch(() => {})
  child.stderr.on('data', (d) => (errTail = `${errTail}${d}`.slice(-600)))
  child.stdin.on('error', () => {})
  const gone = (why) => {
    const err = new Error(why)
    fail(err)
    for (const job of waiting.values()) job.reject(err)
    waiting.clear()
  }
  child.on('error', (err) => gone(errMsg(err)))
  child.on('exit', (code) => gone(`Whisper worker skončil (${code})${errTail.trim() ? `: ${errTail.trim().split('\n').pop().slice(0, 200)}` : ''}`))
  return {
    ready,
    ask(file) {
      const id = `p${++seq}`
      return withTimeout(
        new Promise((resolve, reject) => {
          waiting.set(id, { resolve, reject })
          child.stdin.write(JSON.stringify({ id, path: file, prompt: '' }) + '\n')
        }),
        120_000,
        'prepis skúšobnej vety trval viac ako 2 minúty',
      )
    },
    stop() {
      // Closing stdin ends the Python loop by itself, the signal is for a worker that is still starting.
      child.stdin.end()
      child.kill('SIGTERM')
    },
  }
}

/** Runs a short `uv run … --probe` and returns the JSON line it printed, or null. */
function probeRun(uv, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawnBin(uv, args, { cwd: ROOT, env: workerEnv({ PYTHONUNBUFFERED: '1' }), stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return resolve(null)
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.stdout.on('data', (d) => (out = `${out}${d}`.slice(-4000)))
    child.on('error', () => resolve(null))
    child.on('exit', () => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()))
      } catch {
        resolve(null)
      }
    })
  })
}

/** A second and a half of a plain tone as a WAV file: something to decode when no voice could make a sentence. */
async function toneFile() {
  const rate = 16000
  const n = Math.round(rate * 1.5)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 6000), i * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  const file = join(VOICE_DIR, 'tone.wav')
  await writeFile(file, Buffer.concat([head, data]))
  return file
}

// ── progress file (also the lock) ─────────────────────────────────────────

function saveProgress(fields) {
  try {
    mkdirSync(VOICE_DIR, { recursive: true })
    const tmp = `${PROGRESS_FILE}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now(), ...fields }) + '\n')
    renameSync(tmp, PROGRESS_FILE)
  } catch {
    // progress is a courtesy, the work goes on without it
  }
}

/** Waits for a prepare that another process is running and returns what it left behind. */
export async function followPrepare(onProgress = () => {}, limitMs = DOWNLOAD_LIMIT_MS) {
  const until = Date.now() + limitMs
  let last = ''
  while (Date.now() < until) {
    const p = readProgress()
    if (p?.step) {
      const key = `${p.step}|${p.state}|${p.pct}|${p.text}`
      if (key !== last) onProgress({ step: p.step, state: p.state, pct: p.pct ?? null, text: p.text ?? '' })
      last = key
    }
    if (p?.done && p.result) return p.result
    if (!prepareRunning()) break
    await sleep(700)
  }
  return summary(readPlan(), ['Príprava hlasu beží v inom okne.'])
}

function summary(rec, notes = []) {
  const tts = rec?.tts ?? { provider: ttsInfo().provider, voice: ttsInfo().voice, ok: false }
  return {
    ok: true,
    stt: { engine: rec?.engine ?? 'browser', model: rec?.model ?? null, status: rec?.status ?? 'fallback', device: rec?.device ?? null, sizeMb: rec?.sizeMb ?? null, reason: rec?.reason ?? '', modelDir: rec?.modelDir ?? null },
    tts,
    notes: [...new Set([...(rec?.notes ?? []), ...notes])],
  }
}

// ── the steps ─────────────────────────────────────────────────────────────

async function prepareTts(emit, notes) {
  const info = ttsInfo()
  if (info.provider !== 'edge') {
    const why = { off: 'Hlas je vypnutý.', browser: 'Jarvis bude hovoriť hlasom prehliadača.', say: 'Jarvis bude hovoriť systémovým hlasom Macu.', elevenlabs: 'Hlas ElevenLabs sa pripraví pri prvej vete.' }[info.provider] ?? 'Hlas netreba pripravovať.'
    emit('tts', 'skipped', null, why)
    // The Mac's own voice can still say the test sentence for Whisper.
    let sample = null
    if (info.provider === 'say') {
      const clip = await withTimeout(synthesize(SAMPLE[effectiveLang()]), 30_000, 'say').catch(() => null)
      if (clip?.file) sample = { file: clip.file, speech: true }
    }
    return { tts: { provider: info.provider, voice: info.voice, ok: info.provider !== 'browser' }, sample }
  }
  const label = voiceById(info.voice)?.label ?? info.voice
  emit('tts', 'downloading', null, 'Pripravujem hlas Jarvisa')
  try {
    const lang = effectiveLang()
    const clip = await withTimeout(synthesize(SAMPLE[lang]), 6 * 60_000, 'hlas sa nepripravil do 6 minút')
    if (clip.provider !== 'edge' || !clip.file) throw new Error('služba hlasu neodpovedá')
    emit('tts', 'verifying', null, 'Nahrávam najčastejšie vety')
    await withTimeout(warmCommonPhrases(), 90_000, 'príprava viet trvala pridlho').catch(() => {})
    emit('tts', 'done', 100, `Hlas je pripravený (${label})`)
    return { tts: { provider: 'edge', voice: info.voice, ok: true }, sample: { file: clip.file, speech: true } }
  } catch (err) {
    const fallback = ttsInfo().provider === 'edge' ? (process.platform === 'darwin' ? 'say' : 'browser') : ttsInfo().provider
    notes.push(`Hlas Edge sa nepodarilo pripraviť (${errMsg(err)}). Jarvis zatiaľ hovorí ${fallback === 'say' ? 'systémovým hlasom Macu' : 'hlasom prehliadača'} a skúsi to znova sám.`)
    emit('tts', 'error', null, 'Hlas sa nepodarilo pripraviť, použije sa náhradný')
    return { tts: { provider: fallback, voice: info.voice, ok: false }, sample: null }
  }
}

/** Can the NVIDIA card really be used? First the driver (cheap), then the libraries (a large download). */
async function cudaWorks(uv, emit) {
  const script = join(ROOT, 'server', 'stt', 'faster_worker.py')
  emit('whisper', 'checking', null, 'Zisťujem, či sa dá použiť grafická karta')
  const base = await probeRun(uv, ['run', '--quiet', script, '--probe'], ENV_LIMIT_MS)
  if (!base?.cuda_devices) return false
  emit('whisper', 'downloading', null, 'Sťahujem knižnice pre grafickú kartu (asi 1,3 GB)')
  const { args } = sttWorker({ engine: 'faster', device: 'cuda' }, '', 'sk')
  const full = await probeRun(uv, [...args, '--probe'], ENV_LIMIT_MS)
  return Boolean(full?.cuda_devices && full.libs)
}

/**
 * Model on the disk, worker running, test sentence transcribed. Returns the finished plan fields
 * or throws. `plan` may come back changed: off the GPU when it cannot be used.
 */
async function prepareWhisper(uv, plan, sample, emit, signal) {
  let dir = null
  if (!plan.custom) {
    emit('whisper', 'checking', null, `Kontrolujem model ${plan.model}`)
    const found = findModel(plan.engine, plan.model)
    if (found) dir = found.dir
    else {
      const total = modelBytes(plan.engine, plan.model)
      let lastPct = -1
      emit('whisper', 'downloading', 0, `Sťahujem model ${plan.model} (${size(total)})`)
      dir = await fetchModel(
        plan.engine,
        plan.model,
        (have, all) => {
          const pct = Math.min(99, Math.floor((have / all) * 100))
          if (pct === lastPct) return
          lastPct = pct
          emit('whisper', 'downloading', pct, `Sťahujem model ${plan.model}: ${size(have)} z ${size(all)}`)
        },
        signal,
      )
    }
    emit('whisper', 'verifying', null, 'Kontrolujem stiahnutý model')
    await verifyModel(dir, MODELS[plan.engine][plan.model], { removable: !found || found.source === 'jarvis' })
  }
  emit('whisper', 'verifying', null, 'Pripravujem Whisper, prvé spustenie trvá pár minút')
  const worker = startWorker(uv, plan, dir ?? plan.repo)
  try {
    await withTimeout(worker.ready, ENV_LIMIT_MS, 'Whisper sa nespustil do 25 minút')
    emit('whisper', 'verifying', null, 'Skúšam prepis reči')
    const file = sample?.file ?? (await toneFile())
    await worker.ask(file)
    // The first sentence pays for loading the model. The second one is what push-to-talk will feel like.
    const res = await worker.ask(file)
    const text = String(res.text ?? '').trim()
    if (sample?.speech && !text) throw new Error('Whisper skúšobnej vete nerozumel')
    return { modelDir: dir, verify: { ms: res.ms, text: text.slice(0, 120), level: sample?.speech ? 'speech' : 'load', heard: sample?.speech ? /kalend/.test(plain(text)) : null } }
  } finally {
    worker.stop()
  }
}

/**
 * The whole preparation. Returns { ok, stt, tts, notes } and never throws.
 *   onProgress({ step, state, pct, text })   step: uv | plan | tts | whisper
 *   force                                    do everything again, even when a plan is prepared
 */
export async function prepareVoice({ onProgress = () => {}, force = false } = {}) {
  if (prepareRunning()) return followPrepare(onProgress)
  let current = { step: 'uv', state: 'checking', pct: null, text: '' }
  let lastSave = 0
  const emit = (step, state, pct, text) => {
    current = { step, state, pct, text }
    if (state !== 'downloading' || Date.now() - lastSave > 400 || pct === null) {
      lastSave = Date.now()
      saveProgress({ ...current, done: false })
    }
    onProgress(current)
  }
  saveProgress({ ...current, done: false })
  const heartbeat = setInterval(() => saveProgress({ ...current, done: false }), 5000)
  const limit = AbortSignal.timeout(DOWNLOAD_LIMIT_MS)
  const notes = []
  let result
  try {
    result = await run({ emit, force, notes, signal: limit })
  } catch (err) {
    // Nothing above is expected to throw, this is the last net: the HUD still opens, with the browser listening.
    notes.push(`Príprava hlasu zlyhala: ${errMsg(err)}`)
    result = { ...summary(readPlan(), notes), ok: false }
  } finally {
    clearInterval(heartbeat)
    stopTts()
  }
  saveProgress({ ...current, done: true, ok: result.ok, result })
  return result
}

async function run({ emit, force, notes, signal }) {
  const fingerprint = planFingerprint()
  const recorded = readPlan()

  emit('uv', 'checking', null, 'Hľadám program uv')
  const uv = findBin('uv', { override: process.env.UV_BIN })
  if (uv) emit('uv', 'done', null, 'Program uv je nainštalovaný')
  else {
    emit('uv', 'error', null, 'Program uv chýba, bez neho Jarvis hovorí aj počúva cez prehliadač')
    notes.push(`Nainštaluj uv a spusti prípravu znova: ${process.platform === 'win32' ? 'irm https://astral.sh/uv/install.ps1 | iex (PowerShell)' : 'curl -LsSf https://astral.sh/uv/install.sh | sh'}`)
  }

  const specs = probeSpecs()
  const record = (plan, fields) => {
    const rec = { version: 1, fingerprint, at: new Date().toISOString(), choice: plan.choice, engine: plan.engine, model: plan.model, repo: plan.repo, rev: plan.rev, sizeMb: plan.sizeMb, needMb: plan.needMb, device: plan.device, compute: plan.compute, custom: plan.custom, cause: plan.cause, reason: plan.reason, notes: [...new Set([...plan.notes, ...notes])], specs: publicSpecs(specs), ...fields }
    writePlan(rec)
    return rec
  }

  // A plan that is prepared stays: the choice must not jump between starts.
  const kept = !force && usablePlan(recorded)
  if (kept) {
    emit('plan', 'done', null, kept.reason)
    let tts = kept.tts
    if (!tts?.ok) {
      tts = (await prepareTts(emit, notes)).tts
      writePlan({ ...kept, tts })
    } else emit('tts', 'skipped', null, 'Hlas je už pripravený')
    emit('whisper', 'skipped', null, `Whisper je už pripravený (${kept.model})`)
    return summary({ ...kept, tts }, notes)
  }

  let { plan } = freshPlan({ specs })
  emit('plan', 'done', null, plan.reason)
  const { tts, sample } = await prepareTts(emit, notes)

  if (plan.engine !== 'mlx' && plan.engine !== 'faster') {
    emit('whisper', 'skipped', null, plan.reason)
    return summary(record(plan, { status: 'fallback', tts }), notes)
  }

  const exclude = []
  let device = null
  for (let round = 0; round < 4; round++) {
    try {
      if (plan.device === 'cuda' && !(await cudaWorks(uv, emit))) {
        notes.push('Grafická karta sa na prepis reči nedá použiť, Whisper pobeží na procesore.')
        device = 'cpu'
        plan = freshPlan({ specs, exclude, device }).plan
        if (plan.engine !== 'faster') break
        continue
      }
      const done = await prepareWhisper(uv, plan, sample, emit, signal)
      // Too slow for a conversation: a smaller model, or the browser when there is none (only when the choice was automatic).
      if (done.verify.ms > SLOW_MS && !plan.custom && !process.env.JARVIS_WHISPER_MODEL && !process.env.WHISPER_MODEL) {
        const next = freshPlan({ specs, exclude: [...exclude, plan.model], device }).plan
        if (next.model !== plan.model && (next.engine === plan.engine || plan.choice === 'auto')) {
          notes.push(`Model ${plan.model} je na tomto počítači pomalý (${(done.verify.ms / 1000).toFixed(1).replace('.', ',')} s na vetu).`)
          exclude.push(plan.model)
          plan = next
          if (plan.engine !== 'mlx' && plan.engine !== 'faster') break
          continue
        }
      }
      if (done.verify.heard === false) notes.push('Skúšobnú vetu Whisper prepísal nepresne. Ak ti zle rozumie, pozri docs/HLAS.md.')
      emit('whisper', 'done', 100, `Whisper je pripravený (${plan.model})`)
      return summary(record(plan, { status: 'ready', tts, ...done }), notes)
    } catch (err) {
      if (plan.device === 'cuda') {
        notes.push(`Na grafickej karte sa Whisper nespustil (${errMsg(err)}), skúšam procesor.`)
        device = 'cpu'
        plan = freshPlan({ specs, exclude, device }).plan
        if (plan.engine === 'faster') continue
        break
      }
      const disk = err?.cause === 'disk'
      const reason = `${disk ? 'Na disku došlo miesto' : `Lokálny Whisper sa nepodarilo pripraviť (${errMsg(err)})`}. Jarvis zatiaľ počúva cez prehliadač a neskôr to skúsi znova sám.`
      emit('whisper', 'error', null, reason)
      const failed = { ...plan, engine: 'browser', model: null, sizeMb: 0, device: null, compute: null, cause: disk ? 'disk' : 'error', reason }
      return summary(record(failed, { status: 'failed', tts, tried: { engine: plan.engine, model: plan.model } }), notes)
    }
  }
  // The loop ended on a plan without a local engine: the computer is too slow or too small after all.
  const reason = plan.engine === 'mlx' || plan.engine === 'faster' ? 'Lokálny Whisper je na tomto počítači pomalý. Použije sa rozpoznávanie v prehliadači.' : plan.reason
  emit('whisper', 'skipped', null, reason)
  return summary(record({ ...plan, engine: 'browser', model: null, sizeMb: 0, device: null, compute: null, cause: plan.cause ?? 'weak', reason }, { status: 'fallback', tts }), notes)
}
