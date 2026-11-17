/**
 * The speech-to-text plan: which engine and which Whisper model this computer gets.
 *
 *   planStt(specs)   pure decision, specs in → { engine, model, sizeMb, reason, … } out
 *   probeSpecs()     reads the machine: RAM, cores, architecture, free disk, GPU, uv, cached models
 *
 * `node scripts/voice.mjs prepare` records the decision in data/voice/stt-plan.json once the model
 * is downloaded and a test sentence was transcribed. The server, the doctor and the settings API
 * read that record, so the choice is the same from start to start and visible to the user.
 *
 * Models are multilingual only (Slovak and Czech matter), never the English-only `.en` or
 * `distil` variants. Every model is pinned to one revision with the size and SHA-256 of each file.
 *
 * Only Node built-ins and files from this repo: the doctor runs before `npm install`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { getConfig } from './config.mjs'
import { DATA_DIR, HOME, IS_WIN, ROOT, findBin } from './util.mjs'

export const VOICE_DIR = join(DATA_DIR, 'voice')
export const PLAN_FILE = join(VOICE_DIR, 'stt-plan.json')
/** Progress of a running `voice.mjs prepare` (also its lock: pid and a heartbeat). */
export const PROGRESS_FILE = join(VOICE_DIR, 'prepare.json')

const MB = 1e6
const file = (path, size, sha256) => ({ path, size, sha256 })

/**
 * Whisper models Jarvis knows how to download itself. `auto` picks from `large-v3-turbo` and
 * `small`; `medium` and `base` are there for JARVIS_WHISPER_MODEL. `base` is never picked
 * automatically: in Slovak it gets roughly every second word wrong, the browser does better.
 */
export const MODELS = {
  mlx: {
    'large-v3-turbo': {
      repo: 'mlx-community/whisper-large-v3-turbo',
      rev: 'a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb',
      files: [
        file('config.json', 268, 'b34fc29e4e11e0a25e812775dd67f4dd16fc2c8eb43d28ae25ff7d660ecb6379'),
        file('weights.safetensors', 1613977612, '951ed3fc1203e6a62467abb2144a96ce7eafca8fa77e3704fdb8635ff3e7f8a6'),
      ],
    },
    medium: {
      repo: 'mlx-community/whisper-medium-mlx',
      rev: '7fc08c4eac4c316526498f147dfdee6f6303f975',
      files: [
        file('config.json', 268, '3ff0b3f17a5a3a614327ffd835a3c8f6c78f39cbd39e84dbff4b0ae267c4d2e4'),
        file('weights.npz', 1524924912, '10b597c2bcb1bcc38b2d3d24cd4f0885f461a7cd70e8444d6ad5a763ece549ea'),
      ],
    },
    small: {
      repo: 'mlx-community/whisper-small-mlx',
      rev: '45f3915923c7a79a5a5b5a7d909d39aeb0e5630e',
      files: [
        file('config.json', 266, 'e8f58e638208af66d5d5d67801259dc7a12d199e971967a9f9d33a8e3635668e'),
        file('weights.npz', 481307592, '55b6674c9b339702d486e2b1573839a66f8ec8f821ed2886993ef717a86b09f5'),
      ],
    },
    base: {
      repo: 'mlx-community/whisper-base-mlx',
      rev: '1e3e249fb8d01c655324bd6841b1deadffd6d04c',
      files: [
        file('config.json', 262, '737220a6d958b3ad48e78f840fa991556266983c84ea2ca40e413389c62e4c2f'),
        file('weights.npz', 143724204, '2f57d5f3ef473054c638961f90716f4ee415e8108de81313eccb2c5fd62eff0b'),
      ],
    },
  },
  faster: {
    'large-v3-turbo': {
      repo: 'dropbox-dash/faster-whisper-large-v3-turbo',
      rev: '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
      files: [
        file('config.json', 2263, 'b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e'),
        file('model.bin', 1617884929, 'e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da'),
        file('preprocessor_config.json', 340, '7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711'),
        file('tokenizer.json', 2710337, '297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd'),
        file('vocabulary.json', 1068114, 'c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1'),
      ],
    },
    medium: {
      repo: 'Systran/faster-whisper-medium',
      rev: '08e178d48790749d25932bbc082711ddcfdfbc4f',
      files: [
        file('config.json', 2257, '3622a2ddc41ec0e0fd4e68c13c6830f03b90c38d89aaad184de02c8c642cf807'),
        file('model.bin', 1527906378, '9b45e1009dcc4ab601eff815b61d80e60ce3fd8c74c1a14f4a282258286b51ae'),
        file('tokenizer.json', 2203239, 'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab'),
        file('vocabulary.txt', 459861, '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913'),
      ],
    },
    small: {
      repo: 'Systran/faster-whisper-small',
      rev: '536b0662742c02347bc0e980a01041f333bce120',
      files: [
        file('config.json', 2370, 'b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828'),
        file('model.bin', 483546902, '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671'),
        file('tokenizer.json', 2203239, 'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab'),
        file('vocabulary.txt', 459861, '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913'),
      ],
    },
    base: {
      repo: 'Systran/faster-whisper-base',
      rev: 'ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66',
      files: [
        file('config.json', 2309, '56a6d8110d311f19c8f0471e562832c7527f146b567275bfca59fcf7c184da9a'),
        file('model.bin', 145217532, 'd01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9'),
        file('tokenizer.json', 2203239, 'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab'),
        file('vocabulary.txt', 459861, '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913'),
      ],
    },
  },
}

export const modelBytes = (engine, name) => (MODELS[engine]?.[name]?.files ?? []).reduce((n, f) => n + f.size, 0)
export const modelSizeMb = (engine, name) => Math.round(modelBytes(engine, name) / MB)

/**
 * Models `auto` chooses from, best first. On a processor without a GPU only `small` is chosen;
 * JARVIS_WHISPER_MODEL can still ask for a bigger one.
 */
const LADDER = ['large-v3-turbo', 'small']
const LABEL = { 'large-v3-turbo': 'najpresnejší model large-v3-turbo', medium: 'model medium', small: 'menší model small', base: 'najmenší model base' }
/** Disk the Python environment of an engine takes on first use (packages in the uv cache), in MB. */
const ENV_MB = { mlx: 1300, faster: 500, cuda: 2600 }
/** Free space that must stay on the disk after everything is downloaded. */
const RESERVE_MB = 1500
/** NVIDIA libraries faster-whisper needs for the GPU, added to `uv run` only on a CUDA plan. */
export const CUDA_WITH = ['nvidia-cublas-cu12==12.9.2.10', 'nvidia-cudnn-cu12==9.26.1.1']

const gb = (mb) => `${(Math.round(mb / 100) / 10).toFixed(1).replace('.', ',')} GB`
const ramText = (ram) => `${Math.round(ram)} GB pamäte`

/** What the user asked for: off | browser | auto | whisper | mlx | faster. Anything else is auto. */
export function normalizeChoice(value) {
  const v = String(value ?? '').toLowerCase().trim()
  return ['off', 'browser', 'auto', 'whisper', 'mlx', 'faster'].includes(v) ? v : 'auto'
}

/**
 * A model override: a known name (`small`), an alias (`turbo`), or a repository id or folder the
 * engine loads on its own. English-only models are refused, they cannot do Slovak.
 */
export function parseModelOverride(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (/(^|[.\-_/])en($|[.\-_])|distil/i.test(raw)) return { rejected: raw }
  const name = raw.toLowerCase()
  const alias = { turbo: 'large-v3-turbo', 'large-turbo': 'large-v3-turbo', large: 'large-v3-turbo' }[name] ?? name
  if (MODELS.mlx[alias]) return { name: alias }
  return { custom: raw }
}

/**
 * The decision. `specs`:
 *   platform, arch       process.platform, process.arch
 *   ramGb, cores         total memory in GiB, logical cores
 *   freeDiskMb           free space where models and Python packages go (null = unknown)
 *   gpu                  { vendor: 'nvidia' | 'apple' | null, vramMb }
 *   uv                   is uv installed
 *   choice               off | browser | auto (default) | whisper | mlx | faster
 *   modelOverride        JARVIS_WHISPER_MODEL
 *   cached               ['mlx/large-v3-turbo', …] models already on the disk
 *   envReady             the engine's Python packages are already installed
 *   device               'cpu' keeps the plan off the GPU
 *   exclude              model names to skip (a model that turned out too slow here)
 */
export function planStt(specs = {}) {
  const choice = normalizeChoice(specs.choice)
  const notes = []
  const out = (fields) => ({ choice, engine: 'browser', model: null, repo: null, rev: null, sizeMb: 0, needMb: 0, device: null, compute: null, custom: false, cause: null, reason: '', notes, ...fields })

  if (choice === 'off') return out({ engine: 'off', cause: 'choice', reason: 'Hlasové ovládanie je vypnuté.' })
  if (choice === 'browser') return out({ cause: 'choice', reason: 'Je nastavené rozpoznávanie reči v prehliadači.' })
  if (!specs.uv) return out({ cause: 'uv', reason: 'Chýba program uv, bez neho sa lokálny Whisper nespustí. Zatiaľ sa použije rozpoznávanie v prehliadači.' })

  // Windows on ARM: the engine behind faster-whisper has no build for it yet.
  if (specs.platform === 'win32' && specs.arch === 'arm64') return out({ cause: 'unsupported', reason: 'Lokálny Whisper zatiaľ nebeží na Windows pre procesory ARM. Použije sa rozpoznávanie v prehliadači.' })

  const apple = specs.platform === 'darwin' && specs.arch === 'arm64'
  const forced = choice !== 'auto'
  const engine = choice === 'faster' || !apple ? 'faster' : 'mlx'
  if (choice === 'mlx' && !apple) notes.push('MLX Whisper beží len na Macu s Apple Silicon, použije sa faster-whisper.')
  const ram = Number(specs.ramGb) || 0
  const cores = Number(specs.cores) || 0
  const vram = specs.gpu?.vramMb
  const cuda = engine === 'faster' && specs.platform !== 'darwin' && specs.gpu?.vendor === 'nvidia' && (vram == null || vram >= 3500) && specs.device !== 'cpu'
  const device = engine === 'mlx' ? 'metal' : cuda ? 'cuda' : 'cpu'
  const compute = engine === 'mlx' ? 'float16' : cuda ? 'float16' : 'int8'
  const machine =
    engine === 'mlx'
      ? `Mac s Apple Silicon, ${ramText(ram)}`
      : cuda
        ? `Grafická karta NVIDIA${vram ? ` (${Math.round(vram / 1024)} GB)` : ''}, ${ramText(ram)}`
        : `Procesor s ${cores} jadrami, ${ramText(ram)}`

  // An override wins over the hardware tiers. A name we know is downloaded and checked like any other.
  const override = parseModelOverride(specs.modelOverride)
  if (override?.rejected) notes.push(`Model ${override.rejected} vie len po anglicky, použije sa viacjazyčný.`)
  if (override?.custom) {
    const ref = override.custom
    const local = isAbsolute(ref)
    const repo = local || ref.includes('/') ? ref : engine === 'mlx' ? `mlx-community/whisper-${ref}-mlx` : ref
    return out({ engine, model: ref, repo, sizeMb: null, device, compute, custom: true, reason: `${machine}: vlastný model ${ref}.` })
  }

  let tiers
  if (override?.name) tiers = [override.name]
  else {
    // The big model needs a GPU: Metal on Apple Silicon, CUDA on an NVIDIA card. On a processor alone
    // one sentence takes it around eight seconds (measured), far too long for a conversation.
    const strong = engine === 'mlx' ? ram >= 11 : cuda && ram >= 7
    const usable = engine === 'mlx' ? true : cuda ? ram >= 7 : cores >= 4 && ram >= 7
    tiers = strong ? LADDER : usable ? ['small'] : []
    tiers = tiers.filter((name) => !(specs.exclude ?? []).includes(name))
    if (!tiers.length && forced && !(specs.exclude ?? []).includes('small')) {
      tiers = ['small']
      notes.push('Počítač je na lokálny Whisper slabý, prepis môže trvať dlhšie.')
    }
    if (!tiers.length) return out({ cause: 'weak', reason: `Počítač je na lokálny Whisper slabý (${cores} jadrá, ${ramText(ram)}). Použije sa rozpoznávanie v prehliadači.` })
  }

  const free = specs.freeDiskMb
  const cached = new Set(specs.cached ?? [])
  const envMb = specs.envReady ? 0 : ENV_MB[engine] + (cuda ? ENV_MB.cuda : 0)
  let smallestNeed = 0
  for (const name of tiers) {
    const sizeMb = modelSizeMb(engine, name)
    const have = cached.has(`${engine}/${name}`)
    const download = (have ? 0 : sizeMb) + envMb
    const needMb = download ? download + RESERVE_MB : 0
    smallestNeed = needMb
    if (free != null && free < needMb) continue
    if (name !== tiers[0]) notes.push(`Na ${LABEL[tiers[0]]} nie je dosť miesta na disku (voľné ${gb(free)}).`)
    const why = override?.name
      ? `${LABEL[name] ?? name} podľa nastavenia`
      : name === LADDER[0]
        ? LABEL[name]
        : device === 'cpu'
          ? `${LABEL[name]}, väčší by bol bez grafickej karty pomalý`
          : `${LABEL[name]}, aby počítaču ostala pamäť na ostatné`
    const { repo, rev } = MODELS[engine][name]
    return out({ engine, model: name, repo, rev, sizeMb, needMb, device, compute, reason: `${machine}: ${why} (${gb(sizeMb)}).` })
  }
  return out({ cause: 'disk', needMb: smallestNeed, reason: `Na disku je voľných len ${gb(free)}, lokálny Whisper potrebuje aspoň ${gb(smallestNeed)}. Zatiaľ sa použije rozpoznávanie v prehliadači.` })
}

// ── the machine ───────────────────────────────────────────────────────────

/** Where Jarvis keeps the models it downloaded. Outside the repo, so a second Jarvis folder shares them. */
export function modelsDir() {
  if (process.env.JARVIS_MODELS_DIR) return process.env.JARVIS_MODELS_DIR
  if (IS_WIN) return join(process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local'), 'Jarvis', 'models')
  return join(process.env.XDG_CACHE_HOME || join(HOME, '.cache'), 'jarvis', 'models')
}

const uvCacheDir = () => process.env.UV_CACHE_DIR || (IS_WIN ? join(process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local'), 'uv', 'cache') : join(process.env.XDG_CACHE_HOME || join(HOME, '.cache'), 'uv'))

const hfHubDir = () => process.env.HF_HUB_CACHE || join(process.env.HF_HOME || join(process.env.XDG_CACHE_HOME || join(HOME, '.cache'), 'huggingface'), 'hub')

/** Free space in MB on the volume of `dir` (or of its nearest existing parent). Null when it cannot be read. */
export function freeDiskMb(dir) {
  let at = dir
  for (let i = 0; i < 40 && !existsSync(at); i++) {
    const up = dirname(at)
    if (up === at) break
    at = up
  }
  try {
    const s = statfsSync(at)
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / MB)
  } catch {
    return null
  }
}

/** Best effort: an NVIDIA card through nvidia-smi (Windows, Linux), the integrated GPU on Apple Silicon. */
function probeGpu() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? { vendor: 'apple', name: 'Apple Silicon', vramMb: null } : { vendor: null, name: null, vramMb: null }
  const smi = findBin('nvidia-smi', { extraDirs: IS_WIN ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : [] })
  if (!smi) return { vendor: null, name: null, vramMb: null }
  try {
    const res = spawnSync(smi, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
    const line = String(res.stdout ?? '').split(/\r?\n/).find((l) => l.trim())
    if (res.status !== 0 || !line) return { vendor: null, name: null, vramMb: null }
    const [name, mem] = line.split(',').map((s) => s.trim())
    return { vendor: 'nvidia', name: name.slice(0, 80), vramMb: Number.isFinite(Number(mem)) ? Number(mem) : null }
  } catch {
    return { vendor: null, name: null, vramMb: null }
  }
}

const filesComplete = (dir, files) =>
  files.every((f) => {
    try {
      return statSync(join(dir, f.path)).size === f.size
    } catch {
      return false
    }
  })

/**
 * A complete copy of a model on this disk: Jarvis's own folder first, then a snapshot the
 * Hugging Face cache already holds (an earlier Jarvis, another app). Returns { dir, source } or null.
 */
export function findModel(engine, name) {
  const model = MODELS[engine]?.[name]
  if (!model) return null
  const own = join(modelsDir(), `${engine}-${name}`)
  if (filesComplete(own, model.files)) return { dir: own, source: 'jarvis' }
  if (process.env.JARVIS_HF_REUSE === '0') return null
  const snapshots = join(hfHubDir(), `models--${model.repo.replace('/', '--')}`, 'snapshots')
  let revs = []
  try {
    revs = readdirSync(snapshots)
  } catch {
    return null
  }
  for (const rev of [model.rev, ...revs.filter((r) => r !== model.rev)]) {
    const dir = join(snapshots, rev)
    if (filesComplete(dir, model.files)) return { dir, source: 'huggingface' }
  }
  return null
}

export function cachedModels() {
  const list = []
  for (const engine of Object.keys(MODELS)) for (const name of Object.keys(MODELS[engine])) if (findModel(engine, name)) list.push(`${engine}/${name}`)
  return list
}

/** Everything planStt needs to know about this computer. `gpu: false` skips nvidia-smi. */
export function probeSpecs({ gpu = true } = {}) {
  const dir = modelsDir()
  const frees = [freeDiskMb(dir), freeDiskMb(uvCacheDir())].filter((n) => n != null)
  return {
    platform: process.platform,
    arch: process.arch,
    ramGb: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    cores: typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
    cpu: String(os.cpus()[0]?.model ?? '').replace(/\s+/g, ' ').trim(),
    freeDiskMb: frees.length ? Math.min(...frees) : null,
    modelsDir: dir,
    gpu: gpu ? probeGpu() : { vendor: null, name: null, vramMb: null },
    uv: Boolean(findBin('uv', { override: process.env.UV_BIN })),
    cached: cachedModels(),
  }
}

// ── the record ────────────────────────────────────────────────────────────

/** JARVIS_STT in .env wins, then `stt` in config/jarvis.json, then auto. */
export function sttChoice(env = process.env, cfg = getConfig()) {
  const raw = String(env.JARVIS_STT ?? '').toLowerCase().trim()
  if (['off', 'browser', 'auto', 'whisper', 'mlx', 'faster'].includes(raw)) return raw
  return cfg?.stt === 'browser' || cfg?.stt === 'whisper' ? cfg.stt : 'auto'
}

export const modelOverride = (env = process.env) => String(env.JARVIS_WHISPER_MODEL || env.WHISPER_MODEL || '').trim()
const deviceOverride = (env = process.env) => (String(env.JARVIS_WHISPER_DEVICE ?? '').toLowerCase() === 'cpu' ? 'cpu' : null)

/** A recorded plan belongs to one request: the same choice, model override and machine type. */
export const planFingerprint = (choice = sttChoice(), override = modelOverride()) => [choice, override, deviceOverride() ?? '', process.platform, process.arch].join('|')

/**
 * Does a recorded plan answer the current request? Exactly the same request always does. A plan
 * that is ready also serves a request that would end in the same engine: auto and whisper are
 * the same thing on a computer that runs Whisper, and so is the name of the engine it picked.
 * Switching between them must not download or test anything again.
 */
export function recordFits(rec, choice = sttChoice()) {
  if (!rec) return false
  const now = planFingerprint(choice)
  if (rec.fingerprint === now) return true
  if (rec.status !== 'ready') return false
  const rest = (fp) => String(fp).split('|').slice(1).join('|')
  if (rest(rec.fingerprint) !== rest(now)) return false
  const native = process.platform === 'darwin' && process.arch === 'arm64' ? 'mlx' : 'faster'
  const open = (c) => c === 'auto' || c === 'whisper' || c === native
  return (open(choice) && open(rec.choice) && rec.engine === native) || (choice === rec.engine && open(rec.choice))
}

export function readPlan() {
  try {
    const rec = JSON.parse(readFileSync(PLAN_FILE, 'utf8'))
    return rec && typeof rec === 'object' && typeof rec.engine === 'string' && typeof rec.fingerprint === 'string' ? rec : null
  } catch {
    return null
  }
}

export function writePlan(rec) {
  mkdirSync(VOICE_DIR, { recursive: true })
  const tmp = `${PLAN_FILE}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n')
  renameSync(tmp, PLAN_FILE)
}

/** A fresh decision for this computer, nothing is written. */
export function freshPlan({ exclude = [], device = null, envReady = false, specs = probeSpecs() } = {}) {
  const plan = planStt({ ...specs, choice: sttChoice(), modelOverride: modelOverride(), device: device ?? deviceOverride(), exclude, envReady })
  return { plan, specs }
}

/** What the engine gets as WHISPER_MODEL for a plan: a local folder when the model is on the disk, otherwise the repository id. */
export function modelRef(plan) {
  if (plan.custom) return plan.repo
  return findModel(plan.engine, plan.model)?.dir ?? plan.repo
}

/** A recorded plan that can be used right now: prepared for this request and its model still on the disk. */
export function usablePlan(rec = readPlan()) {
  if (!rec || rec.status !== 'ready' || !recordFits(rec)) return null
  if (rec.engine !== 'mlx' && rec.engine !== 'faster') return null
  if (!rec.custom && !findModel(rec.engine, rec.model)) return null
  return rec
}

const RETRY_MS = 6 * 3600_000

/**
 * Does `voice.mjs prepare` have work to do? Yes on the first start, after the request changed,
 * and when the reason for an earlier fallback is gone (uv got installed, the disk has space
 * again, a failed download is a few hours old).
 */
export function prepareNeeded() {
  const choice = sttChoice()
  if (choice === 'off' || choice === 'browser') return false
  const rec = readPlan()
  if (!rec || !recordFits(rec, choice)) return true
  if (rec.status === 'ready') return !usablePlan(rec)
  if (rec.cause === 'uv') return Boolean(findBin('uv', { override: process.env.UV_BIN }))
  if (rec.cause === 'disk') {
    const free = freeDiskMb(modelsDir())
    return free != null && free >= (rec.needMb || 0)
  }
  if (rec.cause === 'error') return Date.now() - Date.parse(rec.at ?? 0) > RETRY_MS
  return false
}

/** Progress of a prepare that is running right now, or null. A dead process or a stale heartbeat does not count. */
export function prepareRunning() {
  try {
    const p = JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'))
    if (!p || p.done || !Number.isInteger(p.pid) || Date.now() - Number(p.at) > 90_000) return null
    process.kill(p.pid, 0)
    return p
  } catch {
    return null
  }
}

export function readProgress() {
  try {
    return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The plan in one object for people and tools (doctor, settings API): the recorded one when it
 * fits the current request, otherwise what a prepare would decide now.
 */
export function sttSummary({ gpu = true } = {}) {
  const choice = sttChoice()
  const rec = readPlan()
  if (recordFits(rec, choice)) {
    const gone = rec.status === 'ready' && !usablePlan(rec)
    return { choice, engine: rec.engine, model: rec.model, sizeMb: rec.sizeMb ?? null, device: rec.device ?? null, reason: gone ? 'Model už na disku nie je, treba ho stiahnuť znova.' : rec.reason, notes: rec.notes ?? [], status: gone ? 'missing' : rec.status, cause: rec.cause ?? null, at: rec.at ?? null, specs: rec.specs ?? null, recorded: true }
  }
  const { plan, specs } = freshPlan({ specs: probeSpecs({ gpu }) })
  const local = plan.engine === 'mlx' || plan.engine === 'faster'
  return { choice, engine: plan.engine, model: plan.model, sizeMb: plan.sizeMb, device: plan.device, reason: plan.reason, notes: plan.notes, status: local ? 'pending' : 'fallback', cause: plan.cause, at: null, specs: publicSpecs(specs), recorded: false }
}

export const publicSpecs = (s) => ({ platform: s.platform, arch: s.arch, cpu: s.cpu, cores: s.cores, ramGb: s.ramGb, freeDiskMb: s.freeDiskMb, gpu: s.gpu?.vendor ? { vendor: s.gpu.vendor, name: s.gpu.name, vramMb: s.gpu.vramMb } : null, uv: s.uv, modelsDir: s.modelsDir })

// ── the worker ────────────────────────────────────────────────────────────

/** Threads for faster-whisper on the CPU: physical cores are what counts, logical ones are a guess at them. */
const cpuThreads = () => {
  const n = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
  return n <= 4 ? Math.max(1, n) : Math.min(8, Math.ceil(n / 2))
}

/**
 * How to start the Whisper worker for an engine: arguments for `uv` and extra environment.
 * `plan` needs { engine, device } and `ref` is the model folder or repository id.
 */
export function sttWorker({ engine, device }, ref, lang) {
  const args = ['run', '--quiet']
  if (engine === 'faster' && device === 'cuda') for (const pkg of CUDA_WITH) args.push('--with', pkg)
  args.push(join(ROOT, 'server', 'stt', engine === 'mlx' ? 'whisper_worker.py' : 'faster_worker.py'))
  const env = {
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    WHISPER_MODEL: ref,
    WHISPER_DEVICE: engine === 'faster' ? (device === 'cuda' ? 'cuda' : 'cpu') : 'metal',
    WHISPER_THREADS: String(cpuThreads()),
    JARVIS_LANG: lang === 'cs' ? 'cs' : 'sk',
    HF_HUB_DISABLE_TELEMETRY: '1',
  }
  return { args, env }
}
