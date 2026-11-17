/**
 * Activity log: what the user was doing on the computer during the day. It is the source of the
 * evening diary and of answers like "what did I do today" or "how long did I play".
 *
 * What one sample holds: the name of the app in front (and which game it is, when it is a known
 * game), how long there was no keyboard or mouse input, and whether the screen was locked.
 * What is never read: window contents, keystrokes, screenshots, the clipboard, web addresses.
 * Window titles are off unless the user turns them on (`activity.titles`), and then only for
 * browsers and editors on Windows. Apps on the ignore list are stored as "private" without a name.
 *
 * Two writers, one file per day:
 *   - the HUD server samples every 60 s (startActivity),
 *   - the pulse (scripts/pulse.mjs, every few minutes from the system scheduler) adds a sample when
 *     the HUD is not running, so there are no holes in the day.
 * Records are appended as one JSON line each to <data>/activity/YYYY-MM-DD.jsonl (mode 0600).
 * Nothing leaves the computer. Reading and summarising is in activity-report.mjs.
 *
 * Record: { t, o, src, d, st, idle, app?, id?, game?, title?, priv? }
 *   t     unix seconds of the sample          o     UTC offset in minutes at that moment
 *   src   "hud" | "pulse"                     d     seconds this sample may stand for (its sampler's interval)
 *   st    "active" | "passive" (no input, but a film, a call or a game runs) | "idle" | "locked"
 *   idle  seconds since the last keyboard or mouse input
 *   app   name of the app in front, id = bundle id (macOS) or process name (Windows)
 *   game  name of the game, when the app in front is a known game
 *   priv  1 = an app from the ignore list was in front; its name is not stored
 */
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { CONFIG_FILE, getConfig } from './config.mjs'
import { DATA_DIR, IS_MAC, IS_WIN, ROOT, addDays, errMsg, findBin, isoDay, log } from './util.mjs'

export const ACTIVITY_DIR = join(DATA_DIR, 'activity')
export const dayFile = (day) => join(ACTIVITY_DIR, `${day}.jsonl`)
const GAMES_FILE = join(ACTIVITY_DIR, 'games.json')
const PRUNE_MARK = join(ACTIVITY_DIR, '.pruned')
const HELPER = join(ROOT, 'server', 'activity-helper.ps1')
const DAY_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
/** A day of samples is about 200 kB. A file far beyond that means something loops: stop writing. */
const MAX_DAY_BYTES = 8_000_000
/** No input for longer than this while a film or a game runs is still "away". */
const PASSIVE_LIMIT_S = 4 * 3600

// ── configuration ──
/** Never recorded by name, whatever the user's own list says: password managers and authenticators. */
export const DEFAULT_IGNORE = ['1Password', 'Bitwarden', 'KeePass', 'KeePassXC', 'KeePassium', 'Keychain Access', 'Kľúčenka', 'Passwords', 'Heslá', 'LastPass', 'Dashlane', 'Proton Pass', 'Enpass', 'NordPass', 'Keeper', 'Strongbox', 'Authy', 'Secrets']

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.(app|exe)$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * The `activity` block of config/jarvis.json with safe defaults:
 *   { enabled: true, titles: false, retentionDays: 90, idleMinutes: 5, ignore: [] }
 * Nothing is recorded before the first setup (no config file yet). JARVIS_ACTIVITY=0 turns the log
 * off for one process, JARVIS_ACTIVITY=1 forces it on (tests).
 */
export function activityConfig(cfg = getConfig()) {
  const a = cfg?.activity && typeof cfg.activity === 'object' && !Array.isArray(cfg.activity) ? cfg.activity : {}
  const int = (v, fallback, min, max) => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) && n >= min ? Math.min(max, n) : fallback
  }
  const own = (Array.isArray(a.ignore) ? a.ignore : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 80)).slice(0, 300)
  const forced = process.env.JARVIS_ACTIVITY
  const reason = forced === '0' ? 'env' : forced === '1' ? null : !cfg?.configured ? 'setup' : a.enabled === false ? 'config' : null
  return {
    enabled: reason === null,
    /** Why it is off: "env" (JARVIS_ACTIVITY=0), "setup" (Jarvis is not set up yet), "config" (turned off by the user). */
    reason,
    titles: a.titles === true,
    retentionDays: int(a.retentionDays, 90, 1, 3650),
    idleMinutes: int(a.idleMinutes, 5, 1, 120),
    ignore: [...DEFAULT_IGNORE, ...own],
    ownIgnore: own,
  }
}

/** True when the app (by name, bundle id or process name) is on the ignore list. A list entry also covers "Name 7" and "Name Helper". */
export function isIgnored(ignore, app, id = null) {
  const names = [norm(app), norm(id), norm(String(id ?? '').split('.').pop())].filter(Boolean)
  if (!names.length) return false
  for (const entry of ignore) {
    const key = norm(entry)
    if (key && names.some((n) => n === key || n.startsWith(`${key} `))) return true
  }
  return false
}

/** Turns the log on or off in config/jarvis.json. The running HUD notices the change within a minute. */
export function setActivityEnabled(on) {
  let raw
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return { ok: false, reason: 'setup' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'setup' }
  raw.activity = { ...(raw.activity && typeof raw.activity === 'object' && !Array.isArray(raw.activity) ? raw.activity : {}), enabled: Boolean(on) }
  writeFileSync(CONFIG_FILE, `${JSON.stringify(raw, null, 2)}\n`)
  return { ok: true, enabled: Boolean(on) }
}

// ── running system tools (never through a shell) ──
function run(bin, args, { timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, { timeout, maxBuffer: 2_000_000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => resolve(err ? '' : String(stdout ?? '')))
    } catch {
      resolve('')
    }
  })
}

// ── macOS ──
/** Tools whose whole job is to keep the Mac awake: they say nothing about a film or a call running. */
const KEEP_AWAKE_TOOLS = /^(caffeinate|amphetamine|keepingyouawake|lungo|caffeine|theine|jiggler|powerd|coreaudiod)$/i

/**
 * True when an app keeps the display from sleeping (output of `pmset -g assertions`): video in a
 * browser or a player, a video call, a presentation. Only the names of the owning processes are read.
 */
export function holdsDisplayAwake(text) {
  const src = String(text ?? '')
  const owners = [...src.matchAll(/^\s*pid \d+\(([^)]*)\):.*\b(?:NoDisplaySleepAssertion|PreventUserIdleDisplaySleep)\b/gm)].map((m) => m[1].trim())
  if (owners.length) return owners.some((name) => !KEEP_AWAKE_TOOLS.test(name))
  // an older or changed output format without the per-process list: the summary line is all there is
  return !/Listed by owning process/.test(src) && /^\s*PreventUserIdleDisplaySleep\s+1\s*$/m.test(src)
}

/**
 * lsappinfo answers from the launch services database: no Accessibility or Automation permission,
 * no dialog, and it does not touch the app in front. ioreg gives the idle time and the lock state.
 */
async function probeMac(cfg) {
  const out = { app: null, id: null, path: null, exe: null, pid: null, idle: 0, locked: false, media: false }
  const front = (await run('/usr/bin/lsappinfo', ['front'])).trim()
  if (/^ASN:[0-9a-fx:-]+$/i.test(front)) {
    const info = await run('/usr/bin/lsappinfo', ['info', '-only', 'name,bundleid,bundlepath,executablepath,pid', front])
    out.app = /^"((?:[^"\\]|\\.)*)"\s+ASN:/m.exec(info)?.[1]?.replace(/\\(.)/g, '$1') ?? null
    out.id = /bundleID="([^"]*)"/.exec(info)?.[1] ?? null
    out.path = /bundle path="([^"]*)"/.exec(info)?.[1] ?? null
    out.exe = /executable path="([^"]*)"/.exec(info)?.[1] ?? null
    out.pid = Number(/pid = (\d+)/.exec(info)?.[1]) || null
  }
  const hid = await run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-r', '-d', '1', '-k', 'HIDIdleTime'])
  const ns = Number(/"HIDIdleTime" = (\d+)/.exec(hid)?.[1])
  if (!Number.isFinite(ns)) return null
  out.idle = Math.round(ns / 1e9)
  const root = await run('/usr/sbin/ioreg', ['-n', 'Root', '-d', '1'])
  // locked, at the login window, or another user's session is on the screen (fast user switching)
  out.locked = /"IOConsoleLocked" = Yes/.test(root) || /CGSSessionScreenIsLocked"?\s*=\s*Yes/.test(root) || /kCGSSessionOnConsoleKey"?\s*=\s*No/.test(root) || /^(loginwindow|ScreenSaverEngine)$/.test(out.app ?? '')
  if (!out.app && !out.locked && !root) return null
  if (!out.locked && out.idle >= cfg.idleMinutes * 60) {
    // a film, a video call or a presentation keeps the display awake: the person is there without typing
    out.media = holdsDisplayAwake(await run('/usr/bin/pmset', ['-g', 'assertions']))
  }
  // a Java game shows up as "java": the command line of that one process tells Minecraft from other Java programs (it is not stored)
  if (out.pid && /^java(w)?$/i.test(basename(out.exe ?? out.app ?? ''))) {
    out.minecraft = /minecraft|net\.fabricmc|cpw\.mods|prismlauncher|multimc|lunarclient|badlion/i.test(await run('/bin/ps', ['-o', 'command=', '-p', String(out.pid)]))
  }
  return out
}

// ── Windows: one hidden PowerShell helper that stays alive ──
const powershellBin = () => {
  const sys = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(sys) ? sys : (findBin('powershell') ?? 'powershell.exe')
}
const helperArgs = (titles, once) => ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', HELPER, ...(titles ? ['-Titles'] : []), ...(once ? ['-Once'] : [])]

let helper = null
function stopHelper() {
  const h = helper
  helper = null
  if (!h) return
  try {
    h.proc.stdin.end()
    h.proc.kill()
  } catch {
    // already gone
  }
}

/** Asks the long-lived helper for one sample. Starts it when needed, replaces it when it hangs or the titles setting changed. */
function askHelper(titles) {
  if (helper && (helper.titles !== titles || helper.proc.exitCode !== null || helper.proc.killed)) stopHelper()
  if (!helper) {
    if (!existsSync(HELPER)) return Promise.resolve(null)
    let proc
    try {
      proc = spawn(powershellBin(), helperArgs(titles, false), { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      return Promise.resolve(null)
    }
    const h = { proc, titles, waiting: null }
    proc.on('error', () => helper === h && stopHelper())
    proc.on('exit', () => {
      h.waiting?.(null)
      if (helper === h) helper = null
    })
    proc.stdin.on('error', () => {})
    createInterface({ input: proc.stdout }).on('line', (line) => {
      const done = h.waiting
      h.waiting = null
      done?.(line)
    })
    helper = h
  }
  const h = helper
  return new Promise((resolve) => {
    // the first answer includes compiling the helper's native calls, which takes a few seconds
    const timer = setTimeout(() => {
      h.waiting = null
      if (helper === h) stopHelper()
      resolve(null)
    }, 20_000)
    h.waiting = (line) => {
      clearTimeout(timer)
      resolve(line)
    }
    try {
      h.proc.stdin.write('s\n')
    } catch {
      clearTimeout(timer)
      h.waiting = null
      resolve(null)
    }
  })
}

async function probeWin(cfg, { once = false } = {}) {
  let line
  if (once) {
    if (!existsSync(HELPER)) return null
    line = (await run(powershellBin(), helperArgs(cfg.titles, true), { timeout: 25_000 })).trim().split(/\r?\n/).pop()
  } else line = await askHelper(cfg.titles)
  let p
  try {
    p = JSON.parse(line)
  } catch {
    return null
  }
  // no desktop to look at (a scheduled task that runs without a logged-in session): better no sample than a wrong one
  if (!p || p.error) return null
  const exe = typeof p.path === 'string' && p.path ? p.path : null
  return {
    app: (typeof p.desc === 'string' && p.desc.trim()) || (typeof p.name === 'string' && p.name) || null,
    id: typeof p.name === 'string' && p.name ? p.name : null,
    path: exe ? dirname(exe) : null,
    exe,
    pid: Number(p.pid) || null,
    idle: Math.max(0, Math.round(Number(p.idle) || 0)),
    locked: p.locked === true,
    media: p.fullscreen === true,
    minecraft: p.minecraft === true,
    title: cfg.titles && typeof p.title === 'string' && p.title ? p.title : null,
  }
}

// ── Linux (X11 only, when xdotool and xprintidle are installed) ──
async function probeLinux() {
  const xdotool = findBin('xdotool')
  const xprintidle = findBin('xprintidle')
  if (!xdotool || !xprintidle || !process.env.DISPLAY) return null
  const idleMs = Number((await run(xprintidle, [])).trim())
  if (!Number.isFinite(idleMs)) return null
  const pid = Number((await run(xdotool, ['getactivewindow', 'getwindowpid'])).trim()) || null
  let app = null
  if (pid) {
    try {
      app = readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || null
    } catch {
      app = null
    }
  }
  return { app, id: app, path: null, exe: null, pid, idle: Math.round(idleMs / 1000), locked: false, media: false }
}

/** One look at the computer: { app, id, path, exe, idle, locked, media, minecraft?, title? } or null when this system cannot be read. */
export async function probe(cfg = activityConfig(), opts = {}) {
  try {
    if (IS_MAC) return await probeMac(cfg)
    if (IS_WIN) return await probeWin(cfg, opts)
    return await probeLinux()
  } catch {
    return null
  }
}

// ── which game is it ──
/** Process and app names of well-known games whose install folder may not be known (normalised name → game). */
const PROCESS_GAMES = {
  'valorant win64 shipping': 'VALORANT', valorant: 'VALORANT', 'league of legends': 'League of Legends', leagueclientux: 'League of Legends', leagueclient: 'League of Legends',
  robloxplayerbeta: 'Roblox', robloxplayer: 'Roblox', roblox: 'Roblox', 'minecraft windows': 'Minecraft', minecraft: 'Minecraft', 'lunar client': 'Minecraft', 'badlion client': 'Minecraft',
  cs2: 'Counter-Strike 2', dota2: 'Dota 2', 'fortniteclient win64 shipping': 'Fortnite', gta5: 'Grand Theft Auto V', rdr2: 'Red Dead Redemption 2', rocketleague: 'Rocket League',
  r5apex: 'Apex Legends', 'r5apex dx12': 'Apex Legends', overwatch: 'Overwatch 2', wow: 'World of Warcraft', 'world of warcraft': 'World of Warcraft', 'diablo iv': 'Diablo IV', hearthstone: 'Hearthstone',
  eldenring: 'Elden Ring', cyberpunk2077: 'Cyberpunk 2077', witcher3: 'The Witcher 3', bg3: "Baldur's Gate 3", 'bg3 dx11': "Baldur's Gate 3", genshinimpact: 'Genshin Impact', starrail: 'Honkai: Star Rail',
  zenlesszonezero: 'Zenless Zone Zero', escapefromtarkov: 'Escape from Tarkov', rainbowsix: 'Rainbow Six Siege', tslgame: 'PUBG', cod: 'Call of Duty', fc24: 'EA SPORTS FC 24', fc25: 'EA SPORTS FC 25', fc26: 'EA SPORTS FC 26',
  forzahorizon5: 'Forza Horizon 5', 'among us': 'Among Us', terraria: 'Terraria', 'stardew valley': 'Stardew Valley', rustclient: 'Rust', valheim: 'Valheim', destiny2: 'Destiny 2',
  'warframe x64': 'Warframe', pathofexile: 'Path of Exile', 'pathofexile x64': 'Path of Exile', worldoftanks: 'World of Tanks', aces: 'War Thunder', 'osu!': 'osu!', osu: 'osu!', factorio: 'Factorio',
  'the sims 4': 'The Sims 4', 'ts4 x64': 'The Sims 4', 'sc2 x64': 'StarCraft II', 'marvel win64 shipping': 'Marvel Rivals', fivem: 'FiveM', 'geometry dash': 'Geometry Dash', geometrydash: 'Geometry Dash',
}

let gamesCache = { mtime: -1, list: [] }
/** Games known from the last detection run: [{ name, path, exe }], re-read when the file changes. */
export function gameIndex() {
  let mtime = 0
  try {
    mtime = statSync(GAMES_FILE).mtimeMs
  } catch {
    return []
  }
  if (gamesCache.mtime === mtime) return gamesCache.list
  try {
    const data = JSON.parse(readFileSync(GAMES_FILE, 'utf8'))
    gamesCache = { mtime, list: (Array.isArray(data.games) ? data.games : []).filter((g) => g && typeof g.name === 'string') }
  } catch {
    gamesCache = { mtime, list: [] }
  }
  return gamesCache.list
}

/**
 * Detects installed games (scripts/scan/launchers.mjs) and keeps their names, folders and
 * executables for matching. Runs at most once a day from the HUD, in the background. It never
 * opens Desktop, Documents or Downloads, so macOS has no reason to ask for a permission.
 */
export async function refreshGameIndex({ force = false } = {}) {
  try {
    if (!force && Date.now() - statSync(GAMES_FILE).mtimeMs < 20 * 3600_000) return gameIndex()
  } catch {
    // no index yet
  }
  const { detectGames } = await import('../../scripts/scan/launchers.mjs')
  const res = await detectGames({ userFolders: false }, { timeout: 20_000 })
  const games = res.games.filter((g) => g.installed).map((g) => ({ name: g.kind === 'instance' ? 'Minecraft' : g.name, launcher: g.launcher, ...(g.path ? { path: g.path } : {}), ...(g.exe ? { exe: g.exe } : {}) }))
  mkdirSync(ACTIVITY_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(GAMES_FILE, JSON.stringify({ at: new Date().toISOString(), games }), { mode: 0o600 })
  return gameIndex()
}

/** Name of the game the probed app is, or null. Folder first (exact), then executable, then name. */
export function matchGame(p, index = gameIndex()) {
  if (!p) return null
  if (p.minecraft) return 'Minecraft'
  const fold = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const where = [p.path, p.exe].filter(Boolean).map(fold)
  let best = null
  for (const g of index) {
    if (!g.path || g.launcher === 'minecraft') continue
    const dir = fold(g.path)
    if (dir.length > 3 && where.some((w) => w === dir || w.startsWith(`${dir}/`)) && (!best || dir.length > best.dir.length)) best = { dir, name: g.name }
  }
  if (best) return best.name
  const exe = p.exe ? norm(basename(String(p.exe).replace(/\\/g, '/'))) : null
  const names = [norm(p.app), norm(p.id), exe].filter(Boolean)
  // "java" alone says nothing: Minecraft is only matched through its command line (probe) above
  const generic = new Set(['java', 'javaw', 'electron', 'launcher', 'game', 'unitycrashhandler64', 'crashreporter'])
  for (const g of index) {
    if (exe && !generic.has(exe) && g.exe?.some((x) => norm(basename(String(x).replace(/\\/g, '/'))) === exe)) return g.name
  }
  for (const n of names) {
    if (generic.has(n)) continue
    if (PROCESS_GAMES[n]) return PROCESS_GAMES[n]
    const hit = index.find((g) => norm(g.name) === n)
    if (hit) return hit.name
  }
  return null
}

// ── records ──
/**
 * Turns one probe into the record that is stored. Pure, so the tests cover every branch.
 * `every` is how many seconds the sampler waits until its next sample.
 */
export function buildRecord(p, cfg, { source = 'hud', every = 60, now = Date.now(), index = gameIndex() } = {}) {
  const rec = { t: Math.round(now / 1000), o: -new Date(now).getTimezoneOffset(), src: source === 'pulse' ? 'pulse' : 'hud', d: Math.max(30, Math.min(1800, Math.round(every))), st: 'active', idle: Math.max(0, Math.round(Number(p.idle) || 0)) }
  if (p.locked) {
    rec.st = 'locked'
    return rec
  }
  const priv = isIgnored(cfg.ignore, p.app, p.id)
  const game = priv ? null : matchGame(p, index)
  if (rec.idle >= cfg.idleMinutes * 60) {
    // no input: still there when a film, a call or a game (a controller is not "input") keeps going
    rec.st = (p.media || game) && rec.idle < PASSIVE_LIMIT_S ? 'passive' : 'idle'
    if (rec.st === 'idle') return rec
  }
  if (priv) {
    rec.priv = 1
    return rec
  }
  const app = String(p.app ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  if (app) rec.app = app
  const id = String(p.id ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120)
  if (id && id !== app) rec.id = id
  if (game) rec.game = game
  if (cfg.titles && p.title && !game) rec.title = String(p.title).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140)
  return rec
}

/** Last complete record of a day file (reads only the end of the file). */
export function lastRecord(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const len = Math.min(size, 2048)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i])
        if (rec && Number.isFinite(rec.t)) return rec
      } catch {
        // a cut-off line at the start of the window or a half-written last one
      }
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Appends a record to its day file. One short write in append mode is atomic on every system
 * Jarvis runs on, so the HUD and the pulse can write the same file. Returns false when skipped.
 */
export function appendRecord(rec) {
  const file = dayFile(isoDay(new Date(rec.t * 1000)))
  mkdirSync(ACTIVITY_DIR, { recursive: true, mode: 0o700 })
  const last = lastRecord(file)
  if (last) {
    // the same moment twice (a scheduler firing twice after a wake-up)
    if (Math.abs(rec.t - last.t) < 20) return false
    // the pulse only fills in when the HUD sampler is not running
    if (rec.src === 'pulse' && last.src === 'hud' && rec.t - last.t >= 0 && rec.t - last.t < 150) return false
  }
  try {
    if (statSync(file).size > MAX_DAY_BYTES) return false
  } catch {
    // first record of the day
  }
  appendFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 })
  return true
}

/**
 * All records of a day, oldest first. Lines that cannot be read (a crash in the middle of a write,
 * a file edited by hand) are skipped; when two lines were glued together, the second one is rescued.
 */
export function readRecords(day) {
  let text
  try {
    text = readFileSync(dayFile(day), 'utf8')
  } catch {
    return []
  }
  const out = []
  const seen = new Set()
  const take = (raw) => {
    let rec
    try {
      rec = JSON.parse(raw)
    } catch {
      return false
    }
    if (!rec || typeof rec !== 'object' || !Number.isFinite(rec.t) || rec.t <= 0) return true
    const key = `${rec.t}|${rec.src}`
    if (seen.has(key)) return true
    seen.add(key)
    out.push(rec)
    return true
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (take(line)) continue
    const at = line.lastIndexOf('{"t":')
    if (at > 0) take(line.slice(at))
  }
  return out.sort((a, b) => a.t - b.t)
}

/** Days that have a log, oldest first. */
export function activityDays() {
  try {
    return readdirSync(ACTIVITY_DIR).map((n) => DAY_RE.exec(n)?.[1]).filter(Boolean).sort()
  } catch {
    return []
  }
}

/** Removes day files older than the retention. Runs once a day, from whichever writer comes first. */
export function prune(cfg = activityConfig(), now = new Date()) {
  const today = isoDay(now)
  try {
    if (readFileSync(PRUNE_MARK, 'utf8').trim() === today) return 0
  } catch {
    // never pruned
  }
  const cutoff = addDays(today, -cfg.retentionDays)
  let removed = 0
  for (const day of activityDays()) {
    if (day >= cutoff) continue
    rmSync(dayFile(day), { force: true })
    removed++
  }
  try {
    mkdirSync(ACTIVITY_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(PRUNE_MARK, today, { mode: 0o600 })
  } catch {
    // tried again with the next sample
  }
  return removed
}

/**
 * Deletes recorded activity: one day, everything before a day, or everything. Returns the days removed.
 * The list of installed games (games.json) goes with "all".
 */
export function purge({ day = null, before = null, all = false } = {}) {
  const removed = []
  for (const d of activityDays()) {
    if (all || d === day || (before && d < before)) {
      rmSync(dayFile(d), { force: true })
      removed.push(d)
    }
  }
  if (all) {
    rmSync(GAMES_FILE, { force: true })
    rmSync(PRUNE_MARK, { force: true })
  }
  return removed
}

// ── sampling ──
/**
 * Takes one sample and stores it. Used by the HUD every minute and by the pulse.
 * Never throws: returns { ok, record?, written?, reason? }.
 */
export async function sampleOnce({ source = 'hud', every = 60, write = true, once = source === 'pulse' } = {}) {
  try {
    const cfg = activityConfig()
    if (!cfg.enabled) return { ok: false, reason: cfg.reason }
    const p = await probe(cfg, { once })
    if (!p) return { ok: false, reason: 'unsupported' }
    const record = buildRecord(p, cfg, { source, every })
    const written = write ? appendRecord(record) : false
    if (write) prune(cfg)
    return { ok: true, record, written }
  } catch (err) {
    return { ok: false, reason: 'error', error: errMsg(err) }
  }
}

let timer = null
let busy = false
let lastProblem = ''
let failures = 0
let ticks = 0
/**
 * Starts the minute sampler inside the HUD server. Only the main instance records (a second HUD
 * on another port would only write the same thing twice).
 */
export function startActivity({ primary = true } = {}) {
  if (timer || (!primary && process.env.JARVIS_ACTIVITY !== '1')) return
  const tick = async () => {
    // a system that cannot be read (no desktop session, missing tools) is asked again only every ten minutes
    if (busy || (failures >= 3 && ticks++ % 10 !== 0)) return
    busy = true
    try {
      const res = await sampleOnce({ source: 'hud', every: 60, once: false })
      if (!res.ok) stopHelper()
      failures = res.ok || res.reason !== 'unsupported' ? 0 : failures + 1
      const problem = res.ok ? '' : res.reason === 'error' ? `chyba: ${res.error}` : res.reason === 'unsupported' ? 'tento systém neviem čítať' : ''
      if (problem && problem !== lastProblem) log('activity', problem)
      lastProblem = problem
      if (res.ok) refreshGameIndex().catch(() => {})
    } finally {
      busy = false
    }
  }
  timer = setInterval(tick, 60_000)
  timer.unref()
  setTimeout(tick, 4000).unref()
  process.on('exit', stopHelper)
}

export function stopActivity() {
  clearInterval(timer)
  timer = null
  stopHelper()
}

/** Where the log stands: for `scripts/activity.mjs status` and the doctor. */
export function activityStatus() {
  const cfg = activityConfig()
  const days = activityDays()
  let bytes = 0
  for (const d of days) {
    try {
      bytes += statSync(dayFile(d)).size
    } catch {
      // removed meanwhile
    }
  }
  const last = days.length ? lastRecord(dayFile(days[days.length - 1])) : null
  return {
    enabled: cfg.enabled,
    reason: cfg.reason,
    titles: cfg.titles,
    retentionDays: cfg.retentionDays,
    idleMinutes: cfg.idleMinutes,
    ignore: cfg.ownIgnore,
    dir: ACTIVITY_DIR,
    days: days.length,
    firstDay: days[0] ?? null,
    lastDay: days[days.length - 1] ?? null,
    bytes,
    lastSample: last ? { at: new Date(last.t * 1000).toISOString(), src: last.src, st: last.st } : null,
    games: gameIndex().length,
    platform: process.platform,
  }
}
