/**
 * Anonymous usage statistics (docs/TELEMETRIA.md). Once a day, Jarvis tells the author how many
 * installs there are, on which system and version, and how much the main features are used, so he
 * knows what to improve. Counts and choices only: never a text, a name, a file, the memory, a city,
 * an email or anything typed or said. The install id is random and tied to nothing.
 *
 * Off: Settings → Asistent → Anonymné štatistiky, or `"telemetry": false` in config/jarvis.json,
 * or JARVIS_TELEMETRY=0 / DO_NOT_TRACK=1 in .env. Off means nothing is sent at all.
 * A secondary instance (JARVIS_SECONDARY=1), the mock brain and tests never send.
 *
 *   data/telemetry.json   { id, lastSent, counts: { text, voice } }
 *   GET /api/telemetry    { on, reason, lastSent, endpoint, preview }: exactly what the next ping would send
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { release } from 'node:os'
import { join } from 'node:path'
import { getConfig } from './config.mjs'
import { DATA_DIR, REPO, errMsg, log, writeFileAtomic } from './util.mjs'

export const TELEMETRY_FILE = join(DATA_DIR, 'telemetry.json')
export const ENDPOINT = process.env.JARVIS_TELEMETRY_URL || 'https://jarvis-telemetry.janjurdik.com/v1/ping'
const DAY = 86_400_000
/** A ping goes out when the last one is older than this (a day minus some slack for the check interval). */
const EVERY = 20 * 3_600_000
const CHECK = 3 * 3_600_000

let file = null
let saveTimer = null
let info = async () => ({})

function read() {
  if (file) return file
  let raw = {}
  try {
    raw = JSON.parse(readFileSync(TELEMETRY_FILE, 'utf8'))
  } catch {
    // first start, or a broken file: a new random id
  }
  file = {
    id: /^[0-9a-f]{32}$/.test(raw.id ?? '') ? raw.id : randomBytes(16).toString('hex'),
    lastSent: typeof raw.lastSent === 'string' ? raw.lastSent : null,
    counts: { text: Number(raw.counts?.text) || 0, voice: Number(raw.counts?.voice) || 0 },
  }
  return file
}

function save(now = false) {
  clearTimeout(saveTimer)
  const write = () => writeFileAtomic(TELEMETRY_FILE, `${JSON.stringify(read(), null, 2)}\n`).catch(() => {})
  if (now) return write()
  saveTimer = setTimeout(write, 5000)
  saveTimer.unref?.()
}

/** Why statistics are off, or null when they are on. */
export function offReason(env = process.env, cfg = getConfig()) {
  if (cfg.telemetry === false) return 'settings'
  if (env.JARVIS_TELEMETRY === '0' || env.JARVIS_TELEMETRY === 'false') return 'env'
  if (env.DO_NOT_TRACK === '1' || env.DO_NOT_TRACK === 'true') return 'do-not-track'
  if (env.JARVIS_SECONDARY === '1' || env.JARVIS_MOCK === '1' || env.NODE_TEST_CONTEXT) return 'test'
  return null
}

/** One more conversation turn written or said (chat.mjs). Only the number is kept. */
export function countTurn(via, env = process.env) {
  if (offReason(env)) return
  const f = read()
  if (via === 'voice') f.counts.voice++
  else f.counts.text++
  save()
}

// ── what is sent ───────────────────────────────────────────────────────────

function osVersion(platform = process.platform) {
  try {
    if (platform === 'darwin') {
      const r = spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 3000 })
      return String(r.stdout ?? '').trim().split('.')[0] || ''
    }
    if (platform === 'win32') {
      const [major, , build] = release().split('.').map(Number)
      return major === 10 && build >= 22000 ? '11' : String(major || '')
    }
    return release().split('.').slice(0, 2).join('.')
  } catch {
    return ''
  }
}

const readJsonFile = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Entries of a folder changed since `since` (ms). Names are only counted, never sent. */
function countSince(dir, since, test = () => true) {
  try {
    return readdirSync(dir).filter((name) => test(name) && statSync(join(dir, name)).mtimeMs >= since).length
  } catch {
    return 0
  }
}

export const notesBucket = (n) => (n >= 200 ? '200+' : n >= 50 ? '50-199' : n >= 10 ? '10-49' : n >= 1 ? '1-9' : '0')

/**
 * The ping, built only from counts and choices. `ctx` comes from the server (settings, setup, memory
 * stats) so this module needs no imports of its own from the rest of the server.
 */
export function buildPayload({ ctx = {}, dataDir = DATA_DIR, now = Date.now() } = {}) {
  const f = read()
  const since = f.lastSent ? Date.parse(f.lastSent) : now - DAY
  const pkg = readJsonFile(join(REPO, 'package.json')) ?? {}
  const watches = readJsonFile(join(dataDir, 'watches.json'))?.watches ?? []
  const apps = readJsonFile(join(dataDir, 'apps.json'))
  const jobs = readJsonFile(join(dataDir, 'brain', 'jobs.json'))
  const jobList = Array.isArray(jobs) ? jobs : Array.isArray(jobs?.jobs) ? jobs.jobs : []
  const cfg = getConfig()
  return {
    v: 1,
    id: f.id,
    version: String(pkg.version ?? ''),
    os: process.platform,
    osVersion: osVersion(),
    arch: process.arch,
    node: Number(process.versions.node.split('.')[0]),
    ai: ctx.ai ?? 'none',
    surface: ctx.surface ?? 'other',
    lang: ctx.lang ?? 'other',
    stt: ctx.stt ?? 'other',
    tts: ctx.tts ?? 'none',
    setup: ctx.setup ?? 'none',
    notes: notesBucket(Number(ctx.notes) || 0),
    counts: {
      text: f.counts.text,
      voice: f.counts.voice,
      jobs: jobList.filter((j) => Date.parse(j?.createdAt ?? '') >= since).length,
      recordings: countSince(join(dataDir, 'recordings'), since, (n) => /^\d{4}-\d{2}-\d{2}/.test(n)),
      screen: countSince(join(dataDir, 'screen'), since),
      watchHits: watches.filter((w) => Date.parse(w?.state?.lastHitAt ?? '') >= since).length,
    },
    state: {
      watches: watches.filter((w) => w?.status === 'active').length,
      routines: (cfg.routines ?? []).filter((r) => r?.enabled !== false).length,
      orbs: Number(ctx.orbs) || 0,
      apps: Array.isArray(apps?.picked) ? apps.picked.length + (apps.own?.length ?? 0) : 0,
    },
    flags: {
      mobile: ctx.mobile === true,
      wake: ctx.wake === true,
      calls: ctx.calls === true,
      alarm: cfg.alarm?.enabled === true,
      activity: cfg.activity?.enabled === true,
    },
  }
}

// ── sending ────────────────────────────────────────────────────────────────

export async function sendPing({ force = false, fetchImpl = fetch, env = process.env } = {}) {
  if (offReason(env)) return { ok: false, skipped: offReason(env) }
  const f = read()
  if (!force && f.lastSent && Date.now() - Date.parse(f.lastSent) < EVERY) return { ok: false, skipped: 'recent' }
  const payload = buildPayload({ ctx: await context() })
  try {
    const res = await fetchImpl(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return { ok: false, status: res.status }
    // Only what was sent is taken off: turns that came in while the ping was on its way stay for the next one.
    f.counts.text = Math.max(0, f.counts.text - payload.counts.text)
    f.counts.voice = Math.max(0, f.counts.voice - payload.counts.voice)
    f.lastSent = new Date().toISOString()
    await save(true)
    return { ok: true }
  } catch (err) {
    // Offline, blocked, the service down: nothing happens, the next check tries again.
    return { ok: false, error: errMsg(err) }
  }
}

/** For Settings: whether it is on, and the exact next ping. */
export async function telemetryInfo() {
  const reason = offReason()
  return { on: !reason, reason, lastSent: read().lastSent, endpoint: ENDPOINT, preview: buildPayload({ ctx: await context() }) }
}

async function context() {
  try {
    return (await info()) ?? {}
  } catch {
    return {}
  }
}

/** Starts the daily ping: a first look a few minutes after the start, then every few hours. */
export function startTelemetry({ context, primary = true } = {}) {
  if (typeof context === 'function') info = context
  if (!primary) return
  const tick = () =>
    sendPing()
      .then((r) => r.ok && log('telemetry', 'anonymné štatistiky odoslané'))
      .catch(() => {})
  setTimeout(tick, 3 * 60_000).unref?.()
  setInterval(tick, CHECK).unref?.()
}

export const _test = { reset: () => ((file = null), clearTimeout(saveTimer)), read, EVERY }
