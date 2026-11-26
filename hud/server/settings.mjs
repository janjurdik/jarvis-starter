/**
 * Settings the user changes from the HUD, and Jarvis himself on a spoken request: the voice, who
 * the assistant is, how the user is addressed, quiet hours, the language and speech recognition.
 *
 *   GET  /api/settings          current values and the options to choose from
 *   POST /api/settings          a partial object, checked strictly, merged into config/jarvis.json
 *   POST /api/settings/preview  { voice, text? } → a short clip in that voice, before saving
 *
 * Everything lives in config/jarvis.json (keys nobody here knows are kept as they are). A change
 * applies at once: the voice is read again for every sentence, speech recognition is reloaded,
 * and the page gets the SSE event `settings`. The persona picks up names and addressing when the
 * server restarts the brain after the config file changed.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, watchFile } from 'node:fs'
import { join } from 'node:path'
import { callConfig, callProblems, placeCall } from './call.mjs'
import { CONFIG_FILE, EXAMPLE_FILE, LANG_FROM_ENV, effectiveLang, getConfig } from './config.mjs'
import { setMicWake, wakeAvailable } from './mic.mjs'
import { send } from './sse.mjs'
import { saveState, state } from './state.mjs'
import { PLAN_FILE, PROGRESS_FILE, prepareNeeded, prepareRunning, sttSummary } from './stt-plan.mjs'
import { STT_ENGINE, reloadStt, restartStt, sttActive } from './stt.mjs'
import { edgeAvailable, speakable, synthesize, ttsInfo, warmCommonPhrases } from './tts.mjs'
import { DATA_DIR, REPO, clean, errMsg, log, writeFileAtomic } from './util.mjs'
import { defaultVoiceId, isPitch, isRate, resolveVoice, voiceById, voiceList } from './voices.mjs'
import { aiProvider } from './provider.mjs'
import { MODES, routingInfo } from './routing.mjs'
import { normalizeSurface, resolveSurface, startMove, surfacesFor } from './surface.mjs'

const bad = (message, status = 400) => Object.assign(new Error(message), { status })
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const GENDERS = ['male', 'female']
/** Names, forms of address and cities: letters, digits, spaces and a few signs on one line. */
const NAME_RE = /^[\p{L}\p{N} .,'’-]*$/u

let hooks = { statusChanged: () => {}, primary: false }
let summaryCache = null
let prepareChild = null
let pushTimer = null

// ── reading ───────────────────────────────────────────────────────────────

/** The plan with the computer's specs. Probing costs a moment (a GPU query on Windows), so it is kept until something changes. */
function plan() {
  summaryCache ??= sttSummary()
  return summaryCache
}

/** Progress of a prepare that is running now: { step, state, pct, text }, otherwise null. */
function prepareProgress() {
  const p = prepareRunning()
  return p ? { step: p.step ?? null, state: p.state ?? null, pct: p.pct ?? null, text: p.text ?? '' } : null
}

// ── phone calls (Twilio): the keys live in .env, never in the page ─────────────────────────────

const ENV_FILE = join(REPO, '.env')
const CALL_KEYS = { sid: 'TWILIO_ACCOUNT_SID', token: 'TWILIO_AUTH_TOKEN', from: 'TWILIO_FROM', to: 'JARVIS_CALL_TO' }
const mask = (n) => String(n).replace(/\d(?=\d{3})/g, '•')

/** What the page may know about the calls: whether they work and what is missing. Never the keys themselves. */
function callSummary() {
  const c = callConfig()
  const problems = callProblems(c)
  return { ready: problems.length === 0, problems, has: { sid: Boolean(c.sid), token: Boolean(c.token), from: Boolean(c.from), to: Boolean(c.to) }, from: c.from || null, to: c.to ? mask(c.to) : null }
}

/** Writes the given keys into .env (changing a line that is there, adding one that is not) and into this process. */
async function setEnv(pairs) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : []
  for (const [key, value] of Object.entries(pairs)) {
    const line = `${key}=${value}`
    const at = lines.findIndex((l) => new RegExp(`^\\s*#?\\s*${key}\\s*=`).test(l) && !/^\s*#/.test(l))
    if (at >= 0) lines[at] = line
    else lines.push(line)
    process.env[key] = value
  }
  await writeFileAtomic(ENV_FILE, `${lines.join('\n').replace(/\n+$/, '')}\n`, 0o600)
}

/** POST /api/settings/call: { sid?, token?, from?, to? }. Empty fields keep what is there. */
export async function applyCall(body) {
  if (!isObj(body)) throw bad('Telo má byť JSON objekt.')
  onlyKeys(body, Object.keys(CALL_KEYS), 'Telefonáty')
  const pairs = {}
  for (const [k, env] of Object.entries(CALL_KEYS)) {
    if (body[k] === undefined || body[k] === '') continue
    const v = String(body[k]).replace(k === 'from' || k === 'to' ? /[\s()-]/g : /\s/g, '')
    if (!/^[\x21-\x7e]{4,80}$/.test(v) || v.includes('=') || v.includes('#')) throw bad(`${env}: neplatná hodnota`)
    if ((k === 'from' || k === 'to') && !/^\+[1-9]\d{6,14}$/.test(v)) throw bad(`${k === 'to' ? 'Tvoj mobil' : 'Číslo v Twiliu'}: medzinárodný tvar, napríklad +421900123456`)
    if (k === 'sid' && !/^AC[0-9a-f]{32}$/i.test(v)) throw bad('Account SID začína na AC a má 34 znakov.')
    pairs[env] = v
  }
  if (Object.keys(pairs).length) await setEnv(pairs)
  return { ok: true, call: callSummary() }
}

/** POST /api/settings/call/test: one real call to the user's own mobile. */
export async function testCall() {
  const problems = callProblems()
  if (problems.length) throw bad(problems[0], 409)
  const cfg = getConfig()
  try {
    const r = await placeCall({ text: `Dobrý deň${cfg.address ? `, ${cfg.address}` : ''}. Tu ${cfg.assistant?.name || 'Jarvis'}. Toto je skúška, hovory fungujú.`, reply: false, source: 'skúška z nastavení' })
    return { ok: true, call: callSummary(), to: r.to }
  } catch (err) {
    throw bad(clean(errMsg(err), 240), 502)
  }
}

/** Where Jarvis lives on this computer: desktop (the macOS app), app (his own window) or browser (a plain page). */
export function surfaceOf(cfg = getConfig()) {
  return resolveSurface({ config: cfg.surface ?? null, dataDir: DATA_DIR }).surface
}

export function settingsBody() {
  const cfg = getConfig()
  const ai = aiProvider()
  const voice = resolveVoice(cfg)
  const voices = voiceList(cfg)
  const known = voices.find((v) => v.id === voice.id)
  const tts = ttsInfo()
  const p = plan()
  const active = sttActive()
  const a = cfg.alarm
  return {
    ok: true,
    assistant: { name: cfg.assistant.name, gender: cfg.assistant.gender },
    voice: { id: voice.id, rate: voice.rate, pitch: voice.pitch, label: known?.label ?? voice.id, gender: known?.gender ?? null, source: cfg.voice.id ? 'config' : process.env.JARVIS_EDGE_VOICE === voice.id ? 'env' : 'default', provider: tts.provider },
    voices,
    user: { name: cfg.name ?? '', address: String(cfg.address ?? ''), formal: cfg.formal !== false, gender: cfg.userGender, city: cfg.city ?? '', birthday: cfg.birthday ?? null },
    call: callSummary(),
    quiet: cfg.quiet,
    alarm: a ? { enabled: a.enabled, time: a.time, days: a.days, call: a.call } : null,
    stt: {
      engine: STT_ENGINE,
      model: active.model,
      choice: active.choice,
      // JARVIS_STT in .env wins over the setting: the page shows the choice but cannot change it.
      locked: Boolean(String(process.env.JARVIS_STT ?? '').trim()),
      pending: active.pending,
      plan: { engine: p.engine, model: p.model, sizeMb: p.sizeMb, device: p.device, status: p.status, reason: p.reason, notes: p.notes },
      specs: p.specs,
      prepare: prepareProgress(),
    },
    wake: { available: wakeAvailable(), on: state.wake && wakeAvailable() },
    // What Jarvis runs on and how he picks the model for background jobs (routing.mjs).
    brain: { id: ai.id, name: ai.name, product: ai.product, plan: ai.plan, routing: routingInfo() },
    surface: surfaceOf(cfg),
    surfaces: surfacesFor(),
    platform: process.platform,
    language: effectiveLang(cfg),
    // JARVIS_LANG in .env wins over the setting.
    languageLocked: LANG_FROM_ENV,
    configured: cfg.configured,
    // Anonymous statistics (telemetry.mjs): on unless turned off here, in .env or by DO_NOT_TRACK.
    telemetry: { on: cfg.telemetry !== false && !['0', 'false'].includes(String(process.env.JARVIS_TELEMETRY ?? '')) && !['1', 'true'].includes(String(process.env.DO_NOT_TRACK ?? '')), locked: ['0', 'false'].includes(String(process.env.JARVIS_TELEMETRY ?? '')) || ['1', 'true'].includes(String(process.env.DO_NOT_TRACK ?? '')) },
  }
}

/** The page hears about every change (and about the progress of a download, at most once a second). */
function pushSettings() {
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    send('settings', settingsBody())
  }, 250)
}

// ── validation ────────────────────────────────────────────────────────────

function text(value, label, max, { empty = false } = {}) {
  if (typeof value !== 'string') throw bad(`${label}: má to byť text`)
  const v = clean(value, max + 1)
  if (v.length > max) throw bad(`${label}: najviac ${max} znakov`)
  if (!v && !empty) throw bad(`${label}: nemôže ostať prázdne`)
  if (!NAME_RE.test(v)) throw bad(`${label}: len písmená, číslice a bežné znamienka`)
  return v
}

function onlyKeys(obj, allowed, label) {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k))
  if (extra.length) throw bad(`${label}: neznáme nastavenie ${extra.map((k) => String(k).slice(0, 30)).join(', ')}`)
}

const inRange = (value, unit, min, max) => {
  const n = Number(value.slice(0, -unit.length))
  return n >= min && n <= max
}

/**
 * Checks a request body and returns only what may be written. Everything outside the list of
 * known settings is an error, not something to ignore: a typo must not look like a saved change.
 */
export function validateSettings(body, voices) {
  if (!isObj(body)) throw bad('telo musí byť JSON objekt')
  onlyKeys(body, ['assistant', 'voice', 'user', 'quiet', 'stt', 'wake', 'language', 'routing', 'surface', 'telemetry'], 'Nastavenia')
  const patch = {}

  if (body.assistant !== undefined) {
    if (!isObj(body.assistant)) throw bad('assistant: má to byť objekt')
    onlyKeys(body.assistant, ['name', 'gender'], 'assistant')
    patch.assistant = {}
    if (body.assistant.name !== undefined) patch.assistant.name = text(body.assistant.name, 'Meno asistenta', 24)
    if (body.assistant.gender !== undefined) {
      if (!GENDERS.includes(body.assistant.gender)) throw bad('assistant.gender: male alebo female')
      patch.assistant.gender = body.assistant.gender
    }
  }

  if (body.voice !== undefined) {
    const v = typeof body.voice === 'string' || body.voice === null ? { id: body.voice } : body.voice
    if (!isObj(v)) throw bad('voice: má to byť objekt alebo id hlasu')
    onlyKeys(v, ['id', 'rate', 'pitch'], 'voice')
    patch.voice = {}
    if (v.id !== undefined) {
      if (v.id !== null && !voices.some((x) => x.id === v.id)) throw bad('voice.id: taký hlas v zozname nie je')
      patch.voice.id = v.id
    }
    if (v.rate !== undefined) {
      if (v.rate !== null && !(isRate(v.rate) && inRange(v.rate, '%', -50, 100))) throw bad('voice.rate: tvar +10% alebo -10%, od -50% do +100%')
      patch.voice.rate = v.rate
    }
    if (v.pitch !== undefined) {
      if (v.pitch !== null && !(isPitch(v.pitch) && inRange(v.pitch, 'Hz', -50, 50))) throw bad('voice.pitch: tvar +5Hz alebo -5Hz, od -50Hz do +50Hz')
      patch.voice.pitch = v.pitch
    }
  }

  if (body.user !== undefined) {
    if (!isObj(body.user)) throw bad('user: má to byť objekt')
    onlyKeys(body.user, ['name', 'address', 'formal', 'gender', 'city', 'birthday'], 'user')
    patch.user = {}
    if (body.user.name !== undefined) patch.user.name = text(body.user.name, 'Meno', 60)
    if (body.user.address !== undefined) patch.user.address = text(body.user.address, 'Oslovenie', 40, { empty: true })
    if (body.user.city !== undefined) patch.user.city = text(body.user.city, 'Mesto', 60)
    if (body.user.birthday !== undefined) {
      if (body.user.birthday !== null && body.user.birthday !== '' && !/^(\d{4}-)?\d{2}-\d{2}$/.test(String(body.user.birthday))) throw bad('user.birthday: tvar 1990-05-12 alebo 05-12')
      patch.user.birthday = body.user.birthday || null
    }
    if (body.user.formal !== undefined) {
      if (typeof body.user.formal !== 'boolean') throw bad('user.formal: true (vykanie) alebo false (tykanie)')
      patch.user.formal = body.user.formal
    }
    if (body.user.gender !== undefined) {
      if (body.user.gender !== null && !GENDERS.includes(body.user.gender)) throw bad('user.gender: male, female alebo null')
      patch.user.gender = body.user.gender
    }
  }

  if (body.quiet !== undefined) {
    const m = typeof body.quiet === 'string' ? /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(body.quiet.trim()) : null
    if (body.quiet !== '' && !(m && Number(m[1]) < 24 && Number(m[3]) < 24 && Number(m[2]) < 60 && Number(m[4]) < 60)) throw bad('quiet: tvar 22:30-07:00, alebo prázdny text na vypnutie')
    patch.quiet = m ? `${m[1].padStart(2, '0')}:${m[2]}-${m[3].padStart(2, '0')}:${m[4]}` : ''
  }
  if (body.stt !== undefined) {
    if (!['auto', 'browser', 'whisper'].includes(body.stt)) throw bad('stt: auto, browser alebo whisper')
    patch.stt = body.stt
  }
  if (body.language !== undefined) {
    if (!['sk', 'cs'].includes(body.language)) throw bad('language: sk alebo cs')
    patch.language = body.language
  }
  if (body.routing !== undefined) {
    if (!MODES.includes(body.routing)) throw bad('routing: auto, heavy alebo light')
    patch.routing = body.routing
  }
  if (body.telemetry !== undefined) {
    if (typeof body.telemetry !== 'boolean') throw bad('telemetry: true alebo false')
    patch.telemetry = body.telemetry
  }
  if (body.surface !== undefined) {
    const surface = normalizeSurface(body.surface)
    if (!surface || !surfacesFor().includes(surface)) throw bad(`surface: ${surfacesFor().join(', ')}`)
    patch.surface = surface
  }
  if (body.wake !== undefined) {
    const on = isObj(body.wake) ? body.wake.on : body.wake
    if (typeof on !== 'boolean') throw bad('wake: true alebo false')
    patch.wake = on
  }
  const filled = Object.values(patch).some((v) => !isObj(v) || Object.keys(v).length)
  if (!filled) throw bad('nie je čo zmeniť')
  return patch
}

// ── writing ───────────────────────────────────────────────────────────────

/** The config file as the user has it: created from the example when missing, never guessed when broken. */
function readRawConfig() {
  let raw
  try {
    raw = readFileSync(CONFIG_FILE, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw bad(`config/jarvis.json sa nedá prečítať: ${errMsg(err)}`, 500)
    try {
      const example = JSON.parse(readFileSync(EXAMPLE_FILE, 'utf8'))
      return isObj(example) ? example : {}
    } catch {
      return {}
    }
  }
  try {
    const parsed = JSON.parse(raw)
    if (isObj(parsed)) return parsed
  } catch {
    // falls through to the error below
  }
  // Writing over a file that does not parse would throw away whatever the user has in it.
  throw bad('Súbor config/jarvis.json nie je platný JSON. Oprav ho a skús to znova, nič som v ňom nezmenil.', 409)
}

const sub = (raw, key) => (isObj(raw[key]) ? { ...raw[key] } : {})

/**
 * Puts a checked patch into the raw config. Voice and gender follow each other: a new gender
 * brings a matching voice, a new voice sets the gender it speaks with, a new language brings
 * its native voice. Returns the list of what changed.
 */
function mergeInto(raw, patch, cfg) {
  const before = JSON.stringify(raw)
  const lang = patch.language ?? effectiveLang(cfg)
  const current = resolveVoice(cfg)
  const currentInfo = voiceById(current.id)
  const assistant = sub(raw, 'assistant')
  const voice = sub(raw, 'voice')

  if (patch.assistant) Object.assign(assistant, patch.assistant)
  if (patch.voice) {
    for (const [key, value] of Object.entries(patch.voice)) {
      if (value === null) delete voice[key]
      else voice[key] = value
    }
  }
  const askedVoice = patch.voice && 'id' in patch.voice
  const gender = patch.assistant?.gender
  if (gender && !askedVoice && currentInfo?.gender !== gender) voice.id = defaultVoiceId(lang, gender)
  if (askedVoice && patch.voice.id && !gender) {
    const g = voiceById(patch.voice.id)?.gender
    if (g) assistant.gender = g
  }
  if (patch.language && !askedVoice && currentInfo && ['sk', 'cs'].includes(currentInfo.lang) && currentInfo.lang !== lang) voice.id = defaultVoiceId(lang, assistant.gender ?? cfg.assistant.gender)

  if (Object.keys(assistant).length) raw.assistant = assistant
  if (Object.keys(voice).length) raw.voice = voice
  else delete raw.voice
  if (patch.user) {
    if ('name' in patch.user) raw.name = patch.user.name
    if ('address' in patch.user) raw.address = patch.user.address
    if ('formal' in patch.user) raw.formal = patch.user.formal
    if ('city' in patch.user) raw.city = patch.user.city
    if ('birthday' in patch.user) {
      if (patch.user.birthday === null) delete raw.birthday
      else raw.birthday = patch.user.birthday
    }
    if ('gender' in patch.user) {
      if (patch.user.gender === null) delete raw.userGender
      else raw.userGender = patch.user.gender
    }
  }
  if ('quiet' in patch) raw.quiet = patch.quiet
  if ('stt' in patch) raw.stt = patch.stt
  if ('language' in patch) raw.language = patch.language
  if ('routing' in patch) raw.routing = patch.routing
  if ('surface' in patch) raw.surface = patch.surface
  if ('telemetry' in patch) {
    if (patch.telemetry) delete raw.telemetry
    else raw.telemetry = false
  }
  return JSON.stringify(raw) !== before
}

let queue = Promise.resolve()
/** One change at a time: two requests must not read the same file and overwrite each other. */
const serial = (fn) => {
  const next = queue.then(fn, fn)
  queue = next.catch(() => {})
  return next
}

/**
 * Checks, saves and applies a partial settings object. Returns the new settings (as GET) with
 * `changed`: the top-level groups that were asked for.
 */
export function applySettings(body, source = 'hud') {
  return serial(async () => {
    const cfg = getConfig()
    const patch = validateSettings(body, voiceList(cfg))
    if (patch.wake === true && !wakeAvailable()) throw bad('Hey Jarvis potrebuje lokálny prepis reči (pozri docs/HLAS.md)', 409)
    const voiceBefore = resolveVoice(cfg).id
    const surfaceBefore = surfaceOf(cfg)

    const { wake, ...forConfig } = patch
    if (Object.keys(forConfig).length) {
      const raw = readRawConfig()
      if (mergeInto(raw, forConfig, cfg)) await writeFileAtomic(CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n')
    }
    if (wake !== undefined && wake !== state.wake) {
      state.wake = wake
      await saveState()
      setMicWake(state.wake)
    }

    // Live: the next sentence already uses the new voice, speech recognition follows the new choice.
    const now = getConfig()
    if (resolveVoice(now).id !== voiceBefore) warmCommonPhrases().catch(() => {})
    if ('language' in patch) restartStt()
    if ('stt' in patch) refreshStt()
    // Another place for Jarvis: he moves now, not at the next start. The new place opens, the old one closes.
    if ('surface' in patch && surfaceOf(now) !== surfaceBefore && startMove()) log('settings', `sťahujem sa: ${surfaceBefore} → ${surfaceOf(now)}`)
    log('settings', `${source}: ${Object.keys(patch).join(', ')}`)
    hooks.statusChanged()
    const body2 = settingsBody()
    send('settings', body2)
    return { ...body2, changed: Object.keys(patch) }
  })
}

/** A short clip in one voice, without saving anything. The clip sits in the same cache as every other sentence. */
const previews = new Map()
export async function previewVoice(body) {
  if (!isObj(body)) throw bad('telo musí byť JSON objekt')
  onlyKeys(body, ['voice', 'text', 'rate', 'pitch'], 'Ukážka')
  const cfg = getConfig()
  const id = isObj(body.voice) ? body.voice.id : body.voice
  const info = voiceList(cfg).find((v) => v.id === id)
  if (!info) throw bad('voice: taký hlas v zozname nie je')
  const rate = body.rate ?? (isObj(body.voice) ? body.voice.rate : undefined)
  const pitch = body.pitch ?? (isObj(body.voice) ? body.voice.pitch : undefined)
  if (rate != null && !(isRate(rate) && inRange(rate, '%', -50, 100))) throw bad('rate: tvar +10% alebo -10%')
  if (pitch != null && !(isPitch(pitch) && inRange(pitch, 'Hz', -50, 50))) throw bad('pitch: tvar +5Hz alebo -5Hz')
  if (body.text !== undefined && typeof body.text !== 'string') throw bad('text: má to byť text')
  const czech = info.lang === 'cs' || (info.lang !== 'sk' && effectiveLang(cfg) === 'cs')
  const address = String(cfg.address ?? '').trim()
  const sample = speakable(clean(body.text, 200)) || `${czech ? 'Dobrý den' : 'Dobrý deň'}${address ? `, ${address}` : ''}.`
  if (!edgeAvailable()) throw bad('Ukážka hlasu potrebuje program uv a pripojenie na internet.', 503)
  const key = `${id}|${rate ?? ''}|${pitch ?? ''}|${sample}`
  let job = previews.get(key)
  if (!job) {
    job = synthesize(sample, { voice: { id, rate: rate ?? undefined, pitch: pitch ?? undefined } }).finally(() => previews.delete(key))
    previews.set(key, job)
  }
  let clip
  try {
    clip = await job
  } catch (err) {
    throw bad(`Ukážku sa nepodarilo pripraviť: ${errMsg(err)}`, 502)
  }
  return { ok: true, url: clip.url, voice: id, label: info.label, text: sample, durMs: clip.durMs ?? 0, cached: clip.cached === true }
}

/**
 * The `settings` tool of the brain (through /api/brain/hud): with `set` the same change as the
 * HTTP API makes, without it the current values. The answer is short, the brain reads it aloud-ish.
 */
export async function brainSettings(body) {
  // Anonymous statistics: the brain may turn them off for the user, never back on. Only the user does
  // that himself, in Settings or in config/jarvis.json.
  if (body?.set?.telemetry === true) return { ok: false, error: 'Anonymné štatistiky môže zapnúť len používateľ sám: Nastavenia, časť Asistent, Anonymné štatistiky. Ja ich viem len vypnúť.' }
  const full = body?.set === undefined || body.set === null ? settingsBody() : await applySettings(body.set, 'jarvis')
  return {
    ok: true,
    changed: full.changed ?? [],
    assistant: full.assistant,
    voice: { id: full.voice.id, label: full.voice.label, gender: full.voice.gender, rate: full.voice.rate, pitch: full.voice.pitch },
    user: full.user,
    quiet: full.quiet,
    language: full.language,
    stt: { engine: full.stt.engine, model: full.stt.model, choice: full.stt.choice, reason: full.stt.plan.reason },
    wake: full.wake,
    voices: full.voices.map((v) => ({ id: v.id, label: v.label, gender: v.gender, lang: v.lang })),
  }
}

// ── speech recognition follows the plan ───────────────────────────────────

/** Downloads and tries out the local Whisper in the background. The browser listens until it is done. */
function startPrepare() {
  if (!hooks.primary || prepareChild || prepareRunning()) return
  log('settings', 'pripravujem lokálny Whisper na pozadí (node scripts/voice.mjs prepare)')
  const child = spawn(process.execPath, [join(REPO, 'scripts', 'voice.mjs'), 'prepare', '--progress'], { cwd: REPO, stdio: 'ignore', windowsHide: true })
  prepareChild = child
  const over = () => {
    if (prepareChild !== child) return
    prepareChild = null
    planChanged()
  }
  child.on('exit', over)
  child.on('error', over)
}

/** The request or the plan changed: use it, tell the page, and prepare what is missing. */
function refreshStt() {
  summaryCache = null
  if (reloadStt()) hooks.statusChanged()
  if (prepareNeeded()) startPrepare()
}

function planChanged() {
  refreshStt()
  pushSettings()
}

/**
 * Called once by the server. `primary` is false for a second instance (tests, screenshots): it
 * follows a plan somebody else prepares, but never starts a download itself.
 */
export function initSettings({ statusChanged, primary }) {
  hooks = { statusChanged, primary: primary === true }
  // The plan is written by `voice.mjs prepare`, whoever started it (this server, scripts/hud.mjs, the user).
  watchFile(PLAN_FILE, { interval: 3000 }, planChanged)
  watchFile(PROGRESS_FILE, { interval: 1000 }, pushSettings)
  if (hooks.primary) {
    setTimeout(() => prepareNeeded() && startPrepare(), 4000).unref()
    // A server that runs for days still gets its Whisper: a download that failed is tried again
    // after a few hours, a full disk once there is room.
    setInterval(() => prepareNeeded() && startPrepare(), 30 * 60_000).unref()
  }
  process.on('exit', () => prepareChild?.kill())
}
