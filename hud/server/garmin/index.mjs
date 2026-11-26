/**
 * Garmin Connect as a live source of body data: sleep, HRV, resting heart rate, body battery,
 * steps, stress, training readiness and workouts.
 *
 * The Python worker next to this file (garmin_worker.py, started through `uv run`) is the only
 * part that talks to Garmin. This module runs it, merges what it returns into the daily log
 * (memory/dennik/YYYY-MM-DD.md) and keeps a compact cache for the briefs and the voice brain.
 *
 *   <data>/garmin/garmin_tokens.json   session tokens written by the worker (0600, folder 0700)
 *   <data>/garmin/days.json            { version, source, syncedAt, days: { "<day>": {…} } }
 *   <data>/garmin/state.json           last attempt, last error, what the sync wrote into the notes
 *   <data>/logs/garmin.log             one line per sync
 *
 * Credentials: the password is typed either into the login card in the HUD (server/login.mjs, which
 * hands it to loginSession() below) or into the worker's own terminal prompt (`node scripts/garmin.mjs
 * login`, for people who like a terminal). From the card it goes to the worker on its stdin and
 * nowhere else: never a process argument or the environment (other processes can read those),
 * never a file, the log, the chat or the brain.
 *
 * Fields in the daily log header (all optional, the user may also write them by hand):
 *   spanok: 7:12              sleep, hours:minutes        spanok_zdroj: garmin   who wrote `spanok`
 *   spanok_skore: 82          Garmin sleep score          spanok_fazy: hlboky 1:25, lahky 3:50, rem 1:40, bdely 0:17
 *   zaspal: 23:41             vstal: 06:53
 *   hrv: 62                   tep_pokoj: 48               bateria: 88            bateria_rano: 85
 *   kroky: 9412               stres: 31                   pripravenost: 74
 * Workouts are lines under the heading "## Tréning".
 *
 * Whose value is it: a field in a note is rewritten only when it is missing or when it still holds
 * exactly what the sync wrote last time (state.json remembers that). `spanok` is also guarded by
 * `spanok_zdroj: garmin`: a sleep the user said or typed is never replaced.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FOLDERS, MEMORY_DIR } from '../memory/index.mjs'
import { DATA_DIR, REPO, ROOT, addDays, clean, errMsg, findBin, isoDay, sleep, spawnBin, withPath, writeFileAtomic } from '../util.mjs'

export const GARMIN_DIR = join(DATA_DIR, 'garmin')
export const TOKEN_FILE = join(GARMIN_DIR, 'garmin_tokens.json')
export const CACHE_FILE = join(GARMIN_DIR, 'days.json')
export const STATE_FILE = join(GARMIN_DIR, 'state.json')
export const LOG_FILE = join(DATA_DIR, 'logs', 'garmin.log')
const LOCK_FILE = join(GARMIN_DIR, 'sync.lock')
const WORKER = join(ROOT, 'server', 'garmin', 'garmin_worker.py')
/** The worker was verified with this interpreter line: uv fetches it when the computer has none. */
const PYTHON = '3.12'
const KEEP_DAYS = 400
const LOCK_STALE_MS = 5 * 60_000

const MESSAGES = {
  not_connected: 'Garmin nie je pripojený.',
  needs_login: 'Prihlásenie do Garminu vypršalo alebo ho Garmin zrušil. Treba sa prihlásiť znova.',
  rate_limited: 'Garmin dočasne odmieta požiadavky. Skúsim to neskôr.',
  network: 'Garmin sa nepodarilo zastihnúť (sieť alebo výpadok na strane Garminu).',
  no_uv: 'Chýba program uv, cez ktorý Jarvis spúšťa pripojenie na Garmin.',
  failed: 'Synchronizácia s Garminom zlyhala.',
}

// ── files ──────────────────────────────────────────────────────────────

function ensureDir() {
  mkdirSync(GARMIN_DIR, { recursive: true, mode: 0o700 })
  // A folder or a token file restored from a backup may have come back readable by others.
  for (const [path, mode] of [[GARMIN_DIR, 0o700], [TOKEN_FILE, 0o600]]) {
    try {
      if (existsSync(path)) chmodSync(path, mode)
    } catch {
      // Windows keeps its own access lists
    }
  }
}

function readJson(file, fallback) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' ? raw : fallback
  } catch {
    return fallback
  }
}

/** Is there a saved Garmin session on this computer? Cheap: one small file read. */
export function garminConnected() {
  const t = readJson(TOKEN_FILE, null)
  return Boolean(t && (t.di_token || t.di_refresh_token))
}

export function readCache() {
  const c = readJson(CACHE_FILE, {})
  return { version: 1, source: c.source ?? null, syncedAt: c.syncedAt ?? null, days: c.days && typeof c.days === 'object' ? c.days : {} }
}

export function readState() {
  const s = readJson(STATE_FILE, {})
  return { ...s, written: s.written && typeof s.written === 'object' ? s.written : {} }
}

async function writeState(state) {
  ensureDir()
  await writeFileAtomic(STATE_FILE, `${JSON.stringify(state, null, 1)}\n`, 0o600)
}

function logLine(msg) {
  try {
    mkdirSync(join(DATA_DIR, 'logs'), { recursive: true })
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    // a log that cannot be written must not break the sync
  }
}

/**
 * The terminal login, for power users and for docs: the login card in the HUD is the normal way.
 * The brain never shows these lines to the user (it opens the card, or open_terminal opens a window).
 */
export function loginCommands() {
  return {
    mac: `cd '${REPO.replace(/'/g, `'\\''`)}' && node scripts/garmin.mjs login`,
    windows: `cd '${REPO.replace(/'/g, "''")}'; node scripts/garmin.mjs login`,
  }
}

/**
 * How to connect, in the answers of sync and status: the login card (`ask_login` on the screen,
 * `node scripts/garmin.mjs connect` from a script or the setup chat). The terminal line stays only
 * for people who want it and is never read out to the user.
 */
const connectInfo = () => ({ connect: 'card', terminal: loginCommands() })

// ── formatting ─────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0')
/** 432 → "7:12" */
export const hm = (min) => `${Math.floor(min / 60)}:${pad(Math.round(min % 60))}`
/** 432 → "7 h 12 min" */
export const hMin = (min) => (min < 60 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${pad(Math.round(min % 60))} min`)
const shortDay = (day) => `${Number(day.slice(8))}. ${Number(day.slice(5, 7))}.`
const sk = (n, digits = 1) => String(Number(n).toFixed(digits)).replace('.', ',').replace(/,0+$/, '')

const ACTIVITY = {
  running: 'Beh', trail_running: 'Trailový beh', treadmill_running: 'Beh na páse', track_running: 'Beh na dráhe', street_running: 'Beh',
  cycling: 'Bicykel', road_biking: 'Cestný bicykel', mountain_biking: 'Horský bicykel', gravel_cycling: 'Gravel', indoor_cycling: 'Stacionárny bicykel', virtual_ride: 'Virtuálna jazda', e_bike_fitness: 'Elektrobicykel',
  walking: 'Chôdza', casual_walking: 'Chôdza', speed_walking: 'Rýchla chôdza', hiking: 'Turistika', mountaineering: 'Horolezectvo',
  strength_training: 'Sila', indoor_cardio: 'Kardio', hiit: 'HIIT', cardio: 'Kardio', elliptical: 'Eliptický trenažér', stair_climbing: 'Schody', indoor_rowing: 'Veslársky trenažér', rowing: 'Veslovanie',
  lap_swimming: 'Plávanie', open_water_swimming: 'Plávanie vonku', swimming: 'Plávanie',
  yoga: 'Joga', pilates: 'Pilates', breathwork: 'Dýchanie', meditation: 'Meditácia', stretching: 'Strečing', mobility: 'Mobilita',
  resort_skiing_snowboarding_ws: 'Lyžovanie', resort_skiing: 'Lyžovanie', backcountry_skiing: 'Skialp', cross_country_skiing_ws: 'Bežky', skate_skiing_ws: 'Bežky', snowboarding_ws: 'Snowboard',
  soccer: 'Futbal', tennis: 'Tenis', padel: 'Padel', basketball: 'Basketbal', volleyball: 'Volejbal', golf: 'Golf', bouldering: 'Bouldering', indoor_climbing: 'Lezenie', rock_climbing: 'Lezenie',
  boxing: 'Box', mixed_martial_arts: 'Bojové umenia', floor_climbing: 'Schody', multi_sport: 'Multišport', other: 'Tréning',
}
export const activityLabel = (type) => ACTIVITY[type] ?? (String(type ?? 'tréning').replace(/_(ws|v2)$/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) || 'Tréning')

/** "- 17:42 Beh: Večerný beh, 45 min, 8,2 km, tep 148, 520 kcal" */
export function activityLine(a) {
  const label = activityLabel(a.type)
  const name = clean(a.name ?? '', 80).replace(/[[\]#*_`]/g, '').trim()
  const parts = [hMin(a.minutes)]
  if (a.distanceKm) parts.push(`${sk(a.distanceKm)} km`)
  if (a.avgHr) parts.push(`tep ${Math.round(a.avgHr)}`)
  if (a.calories) parts.push(`${Math.round(a.calories)} kcal`)
  return `- ${a.start.slice(11, 16)} ${label}${name && name.toLowerCase() !== label.toLowerCase() ? `: ${name}` : ''}, ${parts.join(', ')}`
}

const PHASES = [['deep', 'hlboky'], ['light', 'lahky'], ['rem', 'rem'], ['awake', 'bdely']]
const PHASE_LABEL = { hlboky: 'hlboký', lahky: 'ľahký', rem: 'REM', bdely: 'bdelý' }

/** Header fields of the daily log for one synced day, as the strings that go into the file. */
export function noteFields(d) {
  const f = {}
  const s = d.sleep
  if (s?.minutes > 0) {
    f.spanok = hm(s.minutes)
    if (s.score) f.spanok_skore = String(Math.round(s.score))
    const phases = PHASES.filter(([k]) => Number.isFinite(s[k]) && s[k] !== null).map(([k, name]) => `${name} ${hm(s[k])}`)
    if (phases.length) f.spanok_fazy = phases.join(', ')
    if (s.bed) f.zaspal = s.bed
    if (s.wake) f.vstal = s.wake
  }
  if (d.hrv) f.hrv = String(Math.round(d.hrv))
  if (d.rhr) f.tep_pokoj = String(Math.round(d.rhr))
  if (d.bodyBattery?.max) f.bateria = String(Math.round(d.bodyBattery.max))
  if (d.bodyBattery?.wake) f.bateria_rano = String(Math.round(d.bodyBattery.wake))
  if (d.steps) f.kroky = String(Math.round(d.steps))
  if (d.stress) f.stres = String(Math.round(d.stress))
  if (d.readiness?.score) f.pripravenost = String(Math.round(d.readiness.score))
  return f
}

/** "hlboky 1:25, lahky 3:50" → [{ name: 'hlboký', min: 85 }, …] (reads what noteFields wrote). */
export function parsePhases(value) {
  return [...String(value ?? '').matchAll(/([a-zà-ž]+)\s+(\d{1,2}):(\d{2})/gi)].map((m) => ({ name: PHASE_LABEL[m[1].toLowerCase()] ?? m[1], min: Number(m[2]) * 60 + Number(m[3]) }))
}

/** One spoken-friendly line about a synced day: the night, then the body numbers. */
export function describeDay(d) {
  const out = []
  const s = d.sleep
  if (s?.minutes > 0) {
    const phases = PHASES.filter(([k]) => k !== 'awake' && Number.isFinite(s[k]) && s[k] !== null).map(([k, name]) => `${PHASE_LABEL[name]} ${hMin(s[k])}`)
    out.push(`spánok ${hMin(s.minutes)}${s.score ? `, skóre ${Math.round(s.score)}` : ''}${s.bed && s.wake ? `, od ${s.bed} do ${s.wake}` : ''}${phases.length ? ` (${phases.join(', ')})` : ''}`)
  }
  if (d.hrv) out.push(`HRV ${Math.round(d.hrv)} ms`)
  if (d.rhr) out.push(`pokojový tep ${Math.round(d.rhr)}`)
  if (d.bodyBattery?.wake) out.push(`body battery ráno ${Math.round(d.bodyBattery.wake)}`)
  else if (d.bodyBattery?.max) out.push(`body battery najviac ${Math.round(d.bodyBattery.max)}`)
  if (d.readiness?.score) out.push(`pripravenosť na tréning ${Math.round(d.readiness.score)}`)
  if (d.stress) out.push(`stres ${Math.round(d.stress)}`)
  if (d.steps) out.push(`${new Intl.NumberFormat('sk-SK').format(Math.round(d.steps))} krokov`)
  for (const a of d.activities ?? []) out.push(activityLine(a).replace(/^- /, ''))
  return out.join(' · ')
}

const hasData = (d) => Boolean(d.sleep?.minutes || d.hrv || d.rhr || d.bodyBattery || d.steps || d.stress || d.readiness || d.activities?.length)

// ── merging one day into its note ──────────────────────────────────────

const FIELD_ORDER = ['spanok', 'spanok_skore', 'spanok_fazy', 'zaspal', 'vstal', 'hrv', 'tep_pokoj', 'bateria', 'bateria_rano', 'kroky', 'stres', 'pripravenost']
/** The HUD also reads these spellings of the sleep field: a note that has one already has its sleep. */
const SLEEP_KEYS = ['spanok', 'spánok', 'sleep']
const SOURCE_KEY = 'spanok_zdroj'
const TRAINING = /^#{1,6}\s+Tr[ée]ning\s*$/i

const unquote = (v) => String(v ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim()

function findKey(fm, names) {
  for (const name of names) {
    const re = new RegExp(`^${name}\\s*:(.*)$`, 'iu')
    const i = fm.findIndex((l) => re.test(l))
    if (i >= 0) return { i, key: fm[i].slice(0, fm[i].indexOf(':')).trim(), value: unquote(re.exec(fm[i])[1]) }
  }
  return null
}

/**
 * Merges one synced day into the text of its daily log. Pure: text in, text out.
 * Everything the sync does not own stays byte for byte as it was.
 *
 *   text         current content of the note ('' when it does not exist)
 *   d            the day as the worker returned it
 *   prev         what the sync wrote into this note last time ({ field: value, activities: [lines] })
 *   activitiesOk false = the workout list could not be read, leave the workout lines alone
 *
 * Returns { text, written, changed: [field], kept: [field] }.
 */
export function mergeDayNote(text, d, prev = {}, { activitiesOk = true } = {}) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const bom = text.startsWith('﻿') ? '﻿' : ''
  const lines = text.slice(bom.length).split(/\r?\n/)
  let fm = []
  let body = lines
  let hadFm = false
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
    if (end > 0) {
      fm = lines.slice(1, end)
      body = lines.slice(end + 1)
      hadFm = true
    }
  }
  const fresh = noteFields(d)
  const written = { ...prev }
  delete written.activities
  const changed = []
  const kept = []
  const added = []

  for (const field of FIELD_ORDER) {
    const want = fresh[field]
    if (want === undefined) continue
    const isSleep = field === 'spanok'
    const cur = findKey(fm, isSleep ? SLEEP_KEYS : [field])
    const last = prev[field]
    const marker = isSleep ? findKey(fm, [SOURCE_KEY]) : null
    const fromGarmin = marker?.value.toLowerCase() === 'garmin'
    if (!cur) {
      added.push([field, want])
      written[field] = want
      changed.push(field)
      if (isSleep && marker) fm.splice(marker.i, 1)
      continue
    }
    const ours = isSleep ? fromGarmin && (last === undefined || cur.value === last) : last !== undefined ? cur.value === last : cur.value === want
    if (!ours) {
      // The user's own value: keep it, and stop claiming it came from the watch.
      kept.push(field)
      delete written[field]
      if (isSleep && fromGarmin) {
        fm.splice(marker.i, 1)
        changed.push(SOURCE_KEY)
      }
      continue
    }
    written[field] = want
    if (cur.value !== want) {
      fm[cur.i] = `${cur.key}: ${want}`
      changed.push(field)
    }
  }
  // New fields go to the end of the header, `spanok_zdroj` right under `spanok`.
  for (const [field, value] of added) {
    fm.push(`${field}: ${value}`)
    if (field === 'spanok') fm.push(`${SOURCE_KEY}: garmin`)
  }

  // ── workouts: lines under "## Tréning", matched by their start time ──
  const prevLines = Array.isArray(prev.activities) ? prev.activities : []
  let nextLines = prevLines
  if (activitiesOk) {
    // Two workouts that start in the same minute would fight over one line: the first one wins.
    const want = (d.activities ?? []).map((a) => ({ key: a.start.slice(11, 16), line: activityLine(a) })).filter((w, i, all) => all.findIndex((x) => x.key === w.key) === i)
    nextLines = []
    let h = body.findIndex((l) => TRAINING.test(l))
    const sectionEnd = () => {
      let end = h + 1
      while (end < body.length && !/^#{1,6}\s+/.test(body[end])) end++
      return end
    }
    if (h >= 0) {
      // Lines the sync wrote for workouts that are gone from Garmin (deleted or moved) are removed.
      const keys = new Set(want.map((w) => w.key))
      for (let i = sectionEnd() - 1; i > h; i--) {
        const m = /^-\s+(\d{2}:\d{2})\s/.exec(body[i])
        if (m && prevLines.includes(body[i]) && !keys.has(m[1])) {
          body.splice(i, 1)
          changed.push('trening')
        }
      }
    }
    for (const w of want) {
      const end = h >= 0 ? sectionEnd() : -1
      let at = -1
      for (let i = h + 1; h >= 0 && i < end; i++) if (body[i].startsWith(`- ${w.key} `)) at = i
      if (at >= 0) {
        if (body[at] === w.line) nextLines.push(w.line)
        else if (prevLines.includes(body[at])) {
          body[at] = w.line
          nextLines.push(w.line)
          changed.push('trening')
        } else kept.push('trening')
        continue
      }
      if (h < 0) {
        while (body.length && body.at(-1).trim() === '') body.pop()
        if (body.length) body.push('')
        body.push('## Tréning', '', w.line, '')
        h = body.length - 4
      } else {
        let ins = sectionEnd()
        while (ins > h + 1 && body[ins - 1].trim() === '') ins--
        if (ins === h + 1) body.splice(ins++, 0, '')
        body.splice(ins, 0, w.line)
      }
      nextLines.push(w.line)
      changed.push('trening')
    }
  }
  if (nextLines.length) written.activities = nextLines

  if (!changed.length) return { text, written, changed, kept }
  const head = fm.length || hadFm ? ['---', ...fm, '---'] : []
  let out = bom + [...head, ...body].join(eol)
  if (!out.endsWith(eol)) out += eol
  return { text: out, written, changed, kept }
}

// ── the worker ─────────────────────────────────────────────────────────

const uvBin = () => findBin('uv', { override: process.env.UV_BIN })
export const uvReady = () => Boolean(uvBin())

function workerEnv() {
  const env = withPath(process.env)
  // The library would also accept tokens from this variable: only our own folder is ever used.
  delete env.GARMINTOKENS
  env.PYTHONUTF8 = '1'
  env.PYTHONIOENCODING = 'utf-8'
  return env
}

const workerArgs = (args) => ['run', '--quiet', '--python', PYTHON, WORKER, ...args, '--tokens', GARMIN_DIR]

/** Runs the worker and returns { code, json, err }. `json` is its one line of output. */
function runWorker(args, { timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    const uv = uvBin()
    if (!uv) return resolve({ code: -1, json: { ok: false, error: 'no_uv', message: MESSAGES.no_uv }, err: '' })
    ensureDir()
    let out = ''
    let err = ''
    let done = false
    let child
    const finish = (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      let json = null
      for (const line of out.split(/\r?\n/).reverse()) {
        if (!line.trim().startsWith('{')) continue
        try {
          json = JSON.parse(line)
          break
        } catch {
          // not the result line
        }
      }
      resolve({ code, json, err: err.trim().slice(-2000) })
    }
    try {
      child = spawnBin(uv, workerArgs(args), { cwd: REPO, env: workerEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ code: 1, json: null, err: errMsg(e) })
    }
    const timer = setTimeout(() => {
      child.kill()
      err += '\ntimeout'
      finish(124)
    }, timeout)
    child.stdout.on('data', (d) => (out = `${out}${d}`.slice(-4_000_000)))
    child.stderr.on('data', (d) => (err = `${err}${d}`.slice(-20_000)))
    child.on('error', (e) => {
      err += errMsg(e)
      finish(1)
    })
    child.on('exit', (code) => finish(code ?? 1))
  })
}

/**
 * The interactive login, in the user's own terminal: the worker inherits the terminal and asks
 * for the e-mail, the password (hidden) and a two-factor code there. Returns the exit code.
 */
export function runLogin() {
  return new Promise((resolve) => {
    const uv = uvBin()
    if (!uv) return resolve(-1)
    ensureDir()
    let child
    try {
      child = spawnBin(uv, workerArgs(['login']), { cwd: REPO, env: workerEnv(), stdio: 'inherit' })
    } catch {
      return resolve(1)
    }
    child.on('error', () => resolve(1))
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

/**
 * The login of the HUD's login card: one worker process (`login --stdin`) that lives from the
 * e-mail and password until the session is saved, including the wait for a one-time code.
 *
 *   const s = loginSession()
 *   await s.submit({ email, password })   → { state: 'connected', name } | { state: 'code' } | { state: 'error', error, message, retry? }
 *   await s.code('123456')                → the same shapes (after 'code' or a retryable 'wrong_code')
 *   s.close()                             ends the worker (a card that was closed, a server shutdown)
 *
 * The credentials go to the worker's stdin as one JSON line and are not kept here. The answers
 * the worker prints never carry them.
 */
export function loginSession({ timeout = 12 * 60_000 } = {}) {
  let child = null
  let buf = ''
  let closed = false
  let waiting = null
  const events = []
  const timer = setTimeout(() => close(), timeout)
  timer.unref?.()

  const deliver = (ev) => {
    if (waiting) {
      const w = waiting
      waiting = null
      w(ev)
    } else events.push(ev)
  }
  const next = () => new Promise((resolve) => (events.length ? resolve(events.shift()) : (waiting = resolve)))
  const shape = (ev) => {
    if (ev.event === 'connected') return { state: 'connected', name: clean(ev.name ?? '', 80) || null }
    if (ev.event === 'needs_code') return { state: 'code' }
    const error = ['wrong_credentials', 'wrong_code', 'rate_limited', 'network', 'timeout', 'usage', 'no_uv'].includes(ev.error) ? ev.error : 'failed'
    return { state: 'error', error, message: clean(ev.message ?? '', 200) || MESSAGES.failed, ...(ev.retry === true ? { retry: true } : {}) }
  }

  function close() {
    if (closed) return
    closed = true
    clearTimeout(timer)
    try {
      child?.stdin.end()
    } catch {
      // already gone
    }
    if (child && child.exitCode === null) child.kill()
    deliver({ event: 'error', error: 'failed', message: 'Prihlásenie sa prerušilo.' })
  }

  function start() {
    const uv = uvBin()
    if (!uv) return false
    ensureDir()
    try {
      child = spawnBin(uv, workerArgs(['login', '--stdin']), { cwd: REPO, env: workerEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      logLine(`login card: worker did not start (${clean(errMsg(e), 160)})`)
      return false
    }
    child.stdin.on('error', () => {})
    child.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('{')) continue
        try {
          const ev = JSON.parse(line)
          if (ev && typeof ev.event === 'string') deliver(ev)
        } catch {
          // not a protocol line
        }
      }
      if (buf.length > 100_000) buf = ''
    })
    // stderr holds only the worker's own diagnostics (no secrets); it is not kept.
    child.stderr.on('data', () => {})
    child.on('error', () => deliver({ event: 'error', error: 'failed', message: MESSAGES.failed }))
    // 'close', not 'exit': the last line on stdout may still be on its way when the process exits.
    child.on('close', (code) => {
      closed = true
      clearTimeout(timer)
      deliver({ event: 'error', error: 'failed', message: code === 0 ? 'Prihlásenie skončilo bez odpovede.' : MESSAGES.failed })
    })
    return true
  }

  const send = (obj) => {
    try {
      child.stdin.write(`${JSON.stringify(obj)}\n`)
      return true
    } catch {
      return false
    }
  }

  return {
    get open() {
      return !closed
    },
    async submit({ email, password } = {}) {
      if (child) return { state: 'error', error: 'failed', message: 'Prihlásenie už beží.' }
      if (!start()) {
        closed = true
        clearTimeout(timer)
        return { state: 'error', error: 'no_uv', message: MESSAGES.no_uv }
      }
      send({ email: String(email ?? ''), password: String(password ?? '') })
      const res = shape(await next())
      if (res.state !== 'code') close()
      if (res.state === 'connected') logLine('login card: connected')
      else if (res.state === 'error') logLine(`login card: ${res.error}`)
      return res
    },
    async code(value) {
      if (!child || closed) return { state: 'error', error: 'timeout', message: 'Na kód už nečakám. Prihláste sa znova, Garmin pošle nový.' }
      send({ code: String(value ?? '') })
      const res = shape(await next())
      if (!(res.state === 'error' && res.retry)) close()
      if (res.state === 'connected') logLine('login card: connected after a code')
      else if (res.state === 'error') logLine(`login card: ${res.error}`)
      return res
    },
    close,
  }
}

/** Asks Garmin whether the saved session still works: { connected, valid, name, error }. */
export async function checkGarmin() {
  if (!garminConnected()) return { connected: false, valid: false }
  const res = await runWorker(['status', '--check'], { timeout: 60_000 })
  if (!res.json) return { connected: true, valid: null, error: 'failed', message: MESSAGES.failed }
  if (res.json.ok === false) return { connected: true, valid: null, error: res.json.error, message: res.json.message }
  return { connected: Boolean(res.json.connected), valid: res.json.valid ?? null, name: res.json.name ?? null, error: res.json.error ?? null, message: res.json.message ?? null }
}

// ── lock: one sync at a time (pulse, routine and voice may all ask at once) ──

function takeLock() {
  ensureDir()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_FILE, 'wx', 0o600)
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
      closeSync(fd)
      return true
    } catch {
      const held = readJson(LOCK_FILE, null)
      let alive = false
      try {
        if (held?.pid) {
          process.kill(held.pid, 0)
          alive = true
        }
      } catch {
        alive = false
      }
      if (alive && Date.now() - Number(held.at) < LOCK_STALE_MS) return false
      rmSync(LOCK_FILE, { force: true })
    }
  }
  return false
}

const dropLock = () => rmSync(LOCK_FILE, { force: true })

// ── sync ───────────────────────────────────────────────────────────────

const notePath = (day) => join(MEMORY_DIR, FOLDERS.days, `${day}.md`)

/** What the briefs need at a glance: is last night known, and the latest night that is. */
export function overview(cache = readCache(), today = isoDay()) {
  const days = Object.keys(cache.days).sort()
  const lastSleepDay = days.filter((d) => cache.days[d]?.sleep?.minutes > 0).at(-1) ?? null
  return {
    today,
    lastNightKnown: Boolean(cache.days[today]?.sleep?.minutes > 0),
    lastNight: cache.days[today]?.sleep?.minutes > 0 ? { day: today, ...cache.days[today] } : null,
    latestSleep: lastSleepDay ? { day: lastSleepDay, ...cache.days[lastSleepDay].sleep } : null,
    cachedDays: days.length,
    syncedAt: cache.syncedAt,
  }
}

/**
 * Pulls the last `days` days from Garmin and merges them into the daily log and the cache.
 * Never throws. Returns { ok, error?, message, range, changed: [day], created: [day],
 * kept: [{ day, fields }], days: [{ day, … }], … } plus the overview fields.
 *
 * `fixture` (tests only) answers from a file instead of Garmin and is refused unless both
 * JARVIS_MEMORY_DIR and JARVIS_DATA_DIR point somewhere on purpose.
 * `timeout` (ms) caps the wait for a caller that somebody is listening to (the voice brain).
 */
export async function syncGarmin({ days = 14, fixture = null, today = null, reason = 'manual', timeout = null } = {}) {
  const n = Math.min(120, Math.max(1, Math.round(Number(days) || 14)))
  if (fixture && !(process.env.JARVIS_MEMORY_DIR && process.env.JARVIS_DATA_DIR)) {
    return { ok: false, error: 'failed', message: 'Skúšobné dáta (--fixture) idú len do skúšobných priečinkov: nastav JARVIS_MEMORY_DIR aj JARVIS_DATA_DIR.' }
  }
  if (!fixture && !garminConnected()) return { ok: false, error: 'not_connected', message: MESSAGES.not_connected, ...connectInfo() }

  // Somebody else is syncing right now: wait for them instead of asking Garmin twice.
  let locked = takeLock()
  for (let i = 0; !locked && i < (timeout ? Math.ceil(timeout / 1000) : 180); i++) {
    await sleep(500)
    locked = takeLock()
  }
  if (!locked) return { ok: false, error: 'failed', message: 'Iná synchronizácia s Garminom stále beží.' }
  try {
    const state = readState()
    const day0 = today ?? isoDay()
    if (!fixture && state.lastOk && Date.now() - new Date(state.lastOk).getTime() < 60_000 && Number(state.lastDays) >= n) {
      return { ok: true, fresh: true, message: 'Dáta z Garminu sú čerstvé.', changed: [], created: [], kept: [], days: rangeFromCache(readCache(), addDays(day0, -(n - 1)), day0), ...overview(readCache(), day0) }
    }
    const args = ['sync', '--days', String(n)]
    if (today) args.push('--today', today)
    if (fixture) args.push('--fixture', fixture)
    const res = await runWorker(args, { timeout: timeout ?? 90_000 + n * 8_000 })
    const at = new Date().toISOString()
    if (!res.json?.ok) {
      const error = res.json?.error ?? 'failed'
      const message = MESSAGES[error] ?? MESSAGES.failed
      state.lastAttempt = at
      state.lastError = { code: error, message, at }
      if (error === 'rate_limited') state.cooldownUntil = new Date(Date.now() + 60 * 60_000).toISOString()
      await writeState(state)
      logLine(`sync ${reason} days=${n} FAILED ${error}${res.json?.message ? ` · ${clean(res.json.message, 200)}` : ''}${!res.json && res.err ? ` · ${clean(res.err.split('\n').at(-1), 200)}` : ''}`)
      return { ok: false, error, message, ...(error === 'needs_login' || error === 'not_connected' ? connectInfo() : {}) }
    }

    const cache = readCache()
    const changed = []
    const created = []
    const kept = []
    for (const d of res.json.days ?? []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d?.day ?? '') || !hasData(d)) continue
      const { day, ...data } = d
      // A failed workout list must not wipe workouts the cache already has.
      if (res.json.activitiesOk === false) data.activities = cache.days[day]?.activities ?? []
      cache.days[day] = data
      const file = notePath(day)
      let text = ''
      let exists = true
      try {
        text = await readFile(file, 'utf8')
      } catch {
        exists = false
      }
      const merged = mergeDayNote(text, d, state.written[day] ?? {}, { activitiesOk: res.json.activitiesOk !== false })
      state.written[day] = merged.written
      if (merged.kept.length) kept.push({ day, fields: [...new Set(merged.kept)] })
      if (merged.text !== text) {
        await writeFileAtomic(file, merged.text)
        ;(exists ? changed : created).push(day)
      }
    }
    const cutoff = addDays(isoDay(), -KEEP_DAYS)
    for (const day of Object.keys(cache.days)) if (day < cutoff) delete cache.days[day]
    for (const day of Object.keys(state.written)) if (day < cutoff) delete state.written[day]
    cache.source = res.json.source ?? 'garmin'
    cache.syncedAt = at
    ensureDir()
    await writeFileAtomic(CACHE_FILE, `${JSON.stringify({ version: 1, source: cache.source, syncedAt: at, days: Object.fromEntries(Object.entries(cache.days).sort(([a], [b]) => a.localeCompare(b))) }, null, 1)}\n`, 0o600)
    state.lastAttempt = at
    state.lastOk = at
    state.lastDays = n
    state.lastError = res.json.partial ? { code: 'rate_limited', message: MESSAGES.rate_limited, at } : null
    state.cooldownUntil = res.json.partial ? new Date(Date.now() + 60 * 60_000).toISOString() : null
    await writeState(state)
    const range = res.json.range ?? { from: addDays(day0, -(n - 1)), to: day0 }
    logLine(`sync ${reason} days=${n} ok ${range.from}..${range.to} · notes changed ${changed.length}, created ${created.length}, user values kept ${kept.length}${res.json.partial ? ' · PARTIAL (rate limit)' : ''}${res.json.warnings?.length ? ` · warnings ${res.json.warnings.length}` : ''}`)
    const o = overview(cache, day0)
    return {
      ok: true,
      source: cache.source,
      partial: Boolean(res.json.partial),
      range,
      changed,
      created,
      kept,
      days: rangeFromCache(cache, range.from, range.to),
      message: `Garmin: ${shortDay(range.from)} až ${shortDay(range.to)}, ${changed.length + created.length ? `zapísané do denníka (${changed.length + created.length} ${changed.length + created.length === 1 ? 'deň' : changed.length + created.length < 5 ? 'dni' : 'dní'})` : 'v denníku bez zmeny'}.`,
      ...o,
    }
  } catch (err) {
    logLine(`sync ${reason} days=${n} FAILED ${errMsg(err)}`)
    return { ok: false, error: 'failed', message: `${MESSAGES.failed} ${errMsg(err)}` }
  } finally {
    dropLock()
  }
}

const rangeFromCache = (cache, from, to) =>
  Object.keys(cache.days)
    .filter((d) => d >= from && d <= to)
    .sort()
    .map((day) => ({ day, ...cache.days[day] }))

/** Synced days from the cache, oldest first. */
export function garminDays({ since = null } = {}) {
  const cache = readCache()
  return rangeFromCache(cache, since ?? '0000-00-00', '9999-99-99')
}

/** Disconnects: deletes the session tokens and the sync state. Notes and the cache of days stay. */
export async function logoutGarmin() {
  const had = existsSync(TOKEN_FILE)
  rmSync(TOKEN_FILE, { force: true })
  rmSync(LOCK_FILE, { force: true })
  if (existsSync(STATE_FILE)) {
    // What the sync wrote stays remembered, so a later reconnect still knows which values are its own.
    try {
      await writeState({ written: readState().written })
    } catch {
      // the state is only a convenience
    }
  }
  logLine(`logout ${had ? 'tokens removed' : 'no tokens'}`)
  return { ok: true, removed: had }
}

export function garminStatus() {
  const connected = garminConnected()
  const state = readState()
  const cache = readCache()
  let savedAt = null
  try {
    savedAt = statSync(TOKEN_FILE).mtime.toISOString()
  } catch {
    savedAt = null
  }
  return {
    ok: true,
    connected,
    uv: uvReady(),
    savedAt: connected ? savedAt : null,
    lastSync: state.lastOk ?? null,
    lastAttempt: state.lastAttempt ?? null,
    lastError: state.lastError ?? null,
    ...overview(cache),
    ...(connected ? {} : connectInfo()),
  }
}

// ── automatic sync (called from the pulse) ─────────────────────────────

const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/**
 * Is a background sync due now? Returns { days, reason } or null. Pure, so it can be tested.
 *
 *   interval  every `garmin.every` minutes (default 180, at least 30)
 *   rano      in the morning, until last night's sleep arrives from the watch: every 20 minutes
 *             from shortly before the alarm's brief is prepared (or 05:00 without an alarm) to 13:00
 */
export function autoPlan({ cfg = {}, now = new Date(), state = {}, cache = { days: {} }, tokenSavedAt = 0 } = {}) {
  const g = cfg.garmin && typeof cfg.garmin === 'object' ? cfg.garmin : {}
  if (g.auto === false) return null
  if (state.cooldownUntil && new Date(state.cooldownUntil) > now) return null
  // A session Garmin rejected is not retried until the user logs in again.
  if (state.lastError?.code === 'needs_login' && new Date(state.lastError.at).getTime() >= tokenSavedAt) return null
  const since = state.lastAttempt ? now - new Date(state.lastAttempt) : Infinity
  const today = isoDay(now)
  const minutes = now.getHours() * 60 + now.getMinutes()
  const alarm = cfg.alarm?.enabled ? toMin(cfg.alarm.time) : null
  const from = alarm !== null ? Math.max(0, alarm - (Number(cfg.alarm.prepare) || 20) - 12) : 5 * 60
  // Only for people who sleep with the watch on: otherwise the morning would be spent asking for nothing.
  const wearsAtNight = [1, 2, 3, 4].some((n) => cache.days?.[addDays(today, -n)]?.sleep?.minutes > 0)
  if (wearsAtNight && !(cache.days?.[today]?.sleep?.minutes > 0) && minutes >= from && minutes < 13 * 60 && since >= 20 * 60_000) {
    // Yesterday's final numbers are needed once a day, after that only today.
    const syncedToday = state.lastOk && isoDay(new Date(state.lastOk)) === today
    return { days: syncedToday ? 1 : 2, reason: 'rano' }
  }
  const every = Math.min(1440, Math.max(30, Math.round(Number(g.every) || 180)))
  if (since >= every * 60_000) return { days: 2, reason: 'interval' }
  return null
}

/**
 * For the pulse: starts a background sync when one is due and returns at once. Never throws,
 * never blocks, says nothing. The result goes to <data>/logs/garmin.log.
 */
export function garminAuto(cfg, now = new Date()) {
  try {
    if (!garminConnected()) return false
    let tokenSavedAt = 0
    try {
      tokenSavedAt = statSync(TOKEN_FILE).mtimeMs
    } catch {
      tokenSavedAt = 0
    }
    const plan = autoPlan({ cfg, now, state: readState(), cache: readCache(), tokenSavedAt })
    if (!plan) return false
    const child = spawn(process.execPath, [join(REPO, 'scripts', 'garmin.mjs'), 'sync', '--auto', '--days', String(plan.days), `--reason=${plan.reason}`], { cwd: REPO, detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}
