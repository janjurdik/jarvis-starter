/**
 * Building blocks of the computer scan: safe file access, bounded directory walks,
 * plist / VDF / zip readers, a read-only SQLite helper and Slovak formatting.
 *
 * Everything here is read-only towards the user's system. The only place the scan writes to
 * is data/scan/ (the report and short-lived copies of databases it needs to query).
 */
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { copyFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { DATA_DIR, IS_MAC, IS_WIN, findBin, sh } from '../lib.mjs'

export const HOME = homedir()
export const SCAN_DIR = join(DATA_DIR, 'scan')
export const IS_LINUX = process.platform === 'linux'

const env = (name, fallback) => process.env[name] || fallback
/** Windows roots (also defined on other systems so the code paths stay simple). */
export const APPDATA = env('APPDATA', join(HOME, 'AppData', 'Roaming'))
export const LOCALAPPDATA = env('LOCALAPPDATA', join(HOME, 'AppData', 'Local'))
export const PROGRAMDATA = env('ProgramData', 'C:\\ProgramData')
export const PROGRAMFILES = env('ProgramFiles', 'C:\\Program Files')
export const PROGRAMFILES86 = env('ProgramFiles(x86)', 'C:\\Program Files (x86)')
/** macOS ~/Library/Application Support. */
export const MAC_SUPPORT = join(HOME, 'Library', 'Application Support')

/** Per-user application data folder of an app: one name per platform ({ mac, win, linux }). */
export function appData({ mac, win, linux }) {
  if (IS_MAC) return mac ? join(MAC_SUPPORT, mac) : null
  if (IS_WIN) return win ? join(APPDATA, win) : null
  return linux ? join(HOME, '.config', linux) : null
}

// ── errors ──
export const errText = (err) => (err instanceof Error ? err.message : String(err)).slice(0, 300)
/** The system refused access: on macOS this means a privacy permission is missing, not a bug. */
export const isDenied = (err) => err?.code === 'EPERM' || err?.code === 'EACCES'

// ── macOS privacy (TCC) ──
/**
 * Locations that macOS guards with a privacy prompt or with Full Disk Access. The scan never
 * touches them unless the user allowed the matching id with --allow. Returns that id or null.
 */
export function guarded(path) {
  if (!path) return null
  // an offline network share can block every file call for half a minute
  if (IS_WIN) return path.startsWith('\\\\') ? 'volumes' : null
  if (isMount(path) || [...mounts].some((m) => path.startsWith(m + sep))) return 'volumes'
  if (!IS_MAC) return null
  const lib = join(HOME, 'Library') + sep
  const p = path.endsWith(sep) ? path : path + sep
  if (p.startsWith('/Volumes/')) return 'volumes'
  if (/\.photoslibrary\//.test(p)) return 'photos'
  if (!p.startsWith(lib)) return null
  const rest = p.slice(lib.length)
  if (rest.startsWith('Mobile Documents/') || rest.startsWith('CloudStorage/')) return 'icloud'
  if (rest.startsWith('Application Support/AddressBook/')) return 'contacts'
  if (rest.startsWith('Calendars/') || rest.startsWith('Group Containers/group.com.apple.calendar/')) return 'calendar'
  if (rest.startsWith('Reminders/') || rest.startsWith('Group Containers/group.com.apple.reminders/')) return 'reminders'
  if (rest.startsWith('Messages/')) return 'messages'
  if (rest.startsWith('Safari/')) return 'safari'
  if (rest.startsWith('Group Containers/group.com.apple.notes/')) return 'applenotes'
  if (rest.startsWith('Mail/') || rest.startsWith('Accounts/') || rest.startsWith('Application Support/com.apple.TCC/')) return 'fulldisk'
  if (rest.startsWith('Containers/') || rest.startsWith('Group Containers/')) return 'appdata'
  return null
}

// ── small file helpers (never throw) ──
export const exists = (path) => Boolean(path) && existsSync(path)

export function statOf(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/** lstat without following links: enough to learn that something is there and when it changed. */
export function lstatOf(path) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

export const isDir = (path) => statOf(path)?.isDirectory() === true

/**
 * True for a file that only exists in the cloud (iCloud "optimised storage", OneDrive or Dropbox
 * online-only). Opening it would download it, so the scan looks at its name only.
 */
export function isOffline(path, st = statOf(path)) {
  if (!st) return true
  if (IS_WIN) return /\\(OneDrive[^\\]*|Dropbox|Google Drive|iCloudDrive|pCloudDrive)\\/i.test(path)
  return st.size > 0 && st.blocks === 0
}

export function readText(path, max = 2_000_000) {
  try {
    const st = statSync(path)
    if (!st.isFile()) return null
    if (st.size <= max) return readFileSync(path, 'utf8')
    return readHead(path, max)
  } catch {
    return null
  }
}

/** First `bytes` of a file as text. */
export function readHead(path, bytes = 2048) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.toString('utf8', 0, n)
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Last `bytes` of a file as text. */
export function readTail(path, bytes = 2048) {
  let fd
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const len = Math.min(size, bytes)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function readJson(path, max = 20_000_000) {
  const text = readText(path, max)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ── folders that may never answer ──
let mounts = new Set()
/**
 * Remembers where other file systems are mounted (network shares, virtual machines, FUSE drives).
 * Reading such a folder can block for a minute when the other side sleeps, so walks never enter
 * them. Reads the system's mount table only, it does not touch the mounts themselves.
 */
export async function loadMounts() {
  const found = new Set()
  const remote = /nfs|smb|cifs|afp|webdav|davfs|sshfs|fuse|9p|ftp/i
  // only mounts inside the home folder and remote ones matter; a separate /home disk is fine
  const add = (path, type) => {
    if (path && path !== '/' && path !== HOME && (path.startsWith(HOME + sep) || remote.test(type ?? ''))) found.add(path)
  }
  try {
    if (IS_MAC) {
      const res = await sh('/sbin/mount', [], { timeout: 4000 })
      for (const m of res.out.matchAll(/ on (\/.*?) \(([a-z0-9_]+)[,)]/g)) add(m[1], m[2])
    } else if (IS_LINUX) {
      for (const line of (readText('/proc/mounts', 400_000) ?? '').split('\n')) {
        const [, path, type] = line.split(' ')
        add(path?.replace(/\\040/g, ' '), type)
      }
    }
  } catch {
    // no mount table: walks still have their time limits
  }
  mounts = found
  return found
}
export const isMount = (path) => mounts.has(path)

/** readdir that gives up when the folder does not answer (a sleeping disk, a dead network share). */
function readdirTimed(dir, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`folder did not answer in ${ms} ms: ${dir}`), { code: 'ETIMEDOUT' })), ms)
    readdir(dir, { withFileTypes: true }).then(
      (entries) => {
        clearTimeout(timer)
        resolve(entries)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Directory entries (Dirent[]). `denied` is true when the system refused access. `wait` is how
 * long the folder may take to answer (longer when a system dialog is waiting for the person).
 */
export async function list(dir, wait = 5000) {
  if (!dir || isMount(dir)) return { ok: false, denied: false, entries: [] }
  try {
    return { ok: true, denied: false, entries: await readdirTimed(dir, wait) }
  } catch (err) {
    return { ok: false, denied: isDenied(err), entries: [] }
  }
}

/** Names inside a directory, [] when it is missing or unreadable. */
export async function names(dir) {
  return (await list(dir)).entries.map((e) => e.name)
}

export const firstExisting = (...paths) => paths.flat().find((p) => exists(p)) ?? null

// ── concurrency and walks ──
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/** Folders that never hold anything about the person. */
const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'venv', 'env', '__pycache__', 'dist', 'build', 'target', 'out', 'Pods', 'DerivedData', 'bower_components',
  'site-packages', 'obj', 'bin', 'pkg', 'tmp', 'temp', 'cache', 'Cache', 'Caches', 'logs', '$RECYCLE.BIN', 'System Volume Information',
])
/** Bundles that look like folders but are one document or one library. */
const PACKAGE_RE = /\.(app|photoslibrary|musiclibrary|tvlibrary|imovielibrary|fcpbundle|logicx|band|xcodeproj|xcworkspace|framework|bundle|plugin|pkg|lproj|rtfd|playground|sparsebundle|vmwarevm|pvm|utm|theater|aplibrary|scriv|key|pages|numbers|dSYM|xcassets|git)$/i

export const skipDir = (name) => name.startsWith('.') || name.startsWith('$') || SKIP_DIRS.has(name) || PACKAGE_RE.test(name)

/**
 * Breadth-first walk with hard limits (depth, number of folders, deadline). `visit(dir, entries, err)`
 * is called once per folder and returns the names of the sub-folders to descend into.
 * `root` is a path or a list of { path, depth } starting points. Links are never followed.
 */
export async function walk(root, { maxDepth = 4, maxDirs = 20_000, deadline = Infinity, conc = 16 } = {}, visit) {
  let level = Array.isArray(root) ? root : [{ path: root, depth: 0 }]
  let dirs = 0
  let truncated = false
  while (level.length) {
    const next = []
    await mapLimit(level, conc, async (dir) => {
      if (Date.now() > deadline || dirs >= maxDirs) {
        truncated = true
        return
      }
      dirs++
      let entries
      const from = Date.now()
      try {
        entries = await readdirTimed(dir.path)
      } catch (err) {
        if (err?.code === 'ETIMEDOUT') truncated = true
        visit(dir, null, err)
        return
      } finally {
        if (process.env.JARVIS_SCAN_DEBUG && Date.now() - from > 300) console.error(`[scan] slow folder ${Date.now() - from} ms: ${dir.path}`)
      }
      const down = visit(dir, entries, null)
      if (down && dir.depth < maxDepth) {
        for (const name of down) {
          const path = join(dir.path, name)
          if (!mounts.has(path)) next.push({ path, depth: dir.depth + 1 })
        }
      }
    })
    level = next
  }
  return { dirs, truncated }
}

/** Counts files by extension under a folder and, optionally, sums their size. Bounded. */
export async function countFiles(root, { maxDepth = 5, maxDirs = 4000, maxStats = 0, deadline = Infinity, wanted = null } = {}) {
  const byExt = new Map()
  let files = 0
  let bytes = 0
  let newest = 0
  let stats = 0
  const toStat = []
  const res = await walk(root, { maxDepth, maxDirs, deadline }, (dir, entries) => {
    if (!entries) return null
    const down = []
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!skipDir(e.name)) down.push(e.name)
      } else if (e.isFile() && !e.name.startsWith('.')) {
        const ext = extOf(e.name)
        if (wanted && !wanted.has(ext)) continue
        files++
        byExt.set(ext, (byExt.get(ext) ?? 0) + 1)
        if (stats < maxStats) {
          stats++
          toStat.push(join(dir.path, e.name))
        }
      }
    }
    return down
  })
  await mapLimit(toStat, 24, async (file) => {
    try {
      const st = await stat(file)
      bytes += st.size
      if (st.mtimeMs > newest) newest = st.mtimeMs
    } catch {
      // unreadable file: not counted
    }
  })
  return { files, bytes, newest, byExt, truncated: res.truncated, sized: toStat.length }
}

export const extOf = (name) => {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

// ── text helpers ──
/** Lowercase without diacritics: "Životopis" → "zivotopis". */
export const plain = (text) => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

export const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null)
export const mb = (bytes) => Math.round((bytes / 1_048_576) * 10) / 10
export const gb = (bytes) => Math.round((bytes / 1_073_741_824) * 10) / 10

/** "350 MB" or "51 GB" from megabytes. */
export const sizeText = (megabytes) => (megabytes >= 1024 ? `${Math.round(megabytes / 102.4) / 10} GB` : megabytes < 1 ? 'menej ako 1 MB' : `${Math.round(megabytes)} MB`)

/** Slovak plural: sk(3, 'poznámka', 'poznámky', 'poznámok') → "3 poznámky". */
export function sk(n, one, few, many) {
  const word = n === 1 ? one : n >= 2 && n <= 4 ? few : many
  return `${n.toLocaleString('sk-SK')} ${word}`
}

/** "pred 3 dňami" style age of a timestamp. */
export function ago(ms) {
  if (!ms) return 'neznámo kedy'
  const days = Math.floor((Date.now() - ms) / 86_400_000)
  if (days <= 0) return 'dnes'
  if (days === 1) return 'včera'
  if (days < 30) return `pred ${days} dňami`
  if (days < 45) return 'pred mesiacom'
  if (days < 365) return `pred ${Math.round(days / 30)} mesiacmi`
  const years = Math.round(days / 365)
  return years === 1 ? 'pred rokom' : `pred ${years} rokmi`
}

/** Joins the first `max` items and says how many were left out. */
export function some(items, max = 6) {
  const head = items.slice(0, max).join(', ')
  return items.length > max ? `${head} a ďalších ${items.length - max}` : head
}

export const uniq = (items) => [...new Set(items.filter(Boolean))]
export const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,}/gi
/** Path shown to people: home folder shortened to ~. */
export const tilde = (path) => (path && path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path)

// ── property lists (macOS) ──
const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** Minimal XML plist parser: dict, array, string, numbers, booleans, dates (as text). Binary data becomes null. */
export function parsePlist(xml) {
  const re = /<(key|string|integer|real|date|data)>([\s\S]*?)<\/\1>|<(true|false)\s*\/>|<(dict|array)>|<\/(dict|array)>|<(dict|array|string|data)\s*\/>/g
  const stack = []
  let root = null
  const put = (value) => {
    const top = stack[stack.length - 1]
    if (!top) root = value
    else if (Array.isArray(top.value)) top.value.push(value)
    else if (top.key != null) {
      top.value[top.key] = value
      top.key = null
    }
  }
  let m
  while ((m = re.exec(xml))) {
    if (m[1] === 'key') {
      const top = stack[stack.length - 1]
      if (top) top.key = xmlText(m[2])
    } else if (m[1]) {
      put(m[1] === 'integer' || m[1] === 'real' ? Number(m[2]) : m[1] === 'data' ? null : xmlText(m[2]))
    } else if (m[3]) {
      put(m[3] === 'true')
    } else if (m[4]) {
      const value = m[4] === 'dict' ? {} : []
      put(value)
      stack.push({ value, key: null })
    } else if (m[5]) {
      stack.pop()
    } else if (m[6]) {
      put(m[6] === 'dict' ? {} : m[6] === 'array' ? [] : m[6] === 'string' ? '' : null)
    }
  }
  return root
}

/** Reads a (binary or XML) plist on macOS. Null when missing, unreadable or guarded. */
export async function readPlist(path, { allowGuarded = false } = {}) {
  if (!IS_MAC || !exists(path)) return null
  if (!allowGuarded && guarded(path)) return null
  const res = await sh('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', path], { timeout: 8000 })
  if (res.code !== 0 || !res.out.includes('<plist')) return null
  return parsePlist(res.out)
}

// ── Valve KeyValues (Steam .vdf / .acf) ──
export function parseVdf(text) {
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g
  const root = {}
  const stack = [root]
  let key = null
  let m
  while ((m = re.exec(text))) {
    if (m[2] === '{') {
      const child = {}
      if (key != null) stack[stack.length - 1][key] = child
      stack.push(child)
      key = null
    } else if (m[2] === '}') {
      if (stack.length > 1) stack.pop()
      key = null
    } else if (key == null) {
      key = m[1].replace(/\\(.)/g, '$1')
    } else {
      stack[stack.length - 1][key] = m[1].replace(/\\(.)/g, '$1')
      key = null
    }
  }
  return root
}

// ── zip ──
/**
 * File names inside a zip, read from its central directory only (no extraction, no content).
 * Handles zip64, which large data exports use. Null when the file is not a readable zip.
 */
export function zipNames(path, max = 20_000) {
  let fd
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const tailLen = Math.min(size, 65_557)
    const tail = Buffer.alloc(tailLen)
    readSync(fd, tail, 0, tailLen, size - tailLen)
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (end < 0) return null
    let cdSize = tail.readUInt32LE(end + 12)
    let cdOffset = tail.readUInt32LE(end + 16)
    if (cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = end - 20
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) return null
      const rec = Buffer.alloc(56)
      readSync(fd, rec, 0, 56, Number(tail.readBigUInt64LE(loc + 8)))
      if (rec.readUInt32LE(0) !== 0x06064b50) return null
      cdSize = Number(rec.readBigUInt64LE(40))
      cdOffset = Number(rec.readBigUInt64LE(48))
    }
    const len = Math.min(cdSize, 6_000_000)
    const cd = Buffer.alloc(len)
    readSync(fd, cd, 0, len, cdOffset)
    const out = []
    let p = 0
    while (p + 46 <= len && out.length < max && cd.readUInt32LE(p) === 0x02014b50) {
      const nameLen = cd.readUInt16LE(p + 28)
      out.push(cd.toString('utf8', p + 46, p + 46 + nameLen))
      p += 46 + nameLen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32)
    }
    return out
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// ── SQLite (always on a private copy) ──
let sqliteModule
async function nodeSqlite() {
  if (sqliteModule !== undefined) return sqliteModule
  const emit = process.emitWarning
  // node:sqlite prints an "experimental" warning on first use; it would only confuse people
  process.emitWarning = (warning, ...rest) => (String(warning?.message ?? warning).includes('SQLite') ? undefined : emit.call(process, warning, ...rest))
  try {
    sqliteModule = await import('node:sqlite')
  } catch {
    sqliteModule = null
  }
  return sqliteModule
}

/** True when the scan can query SQLite files on this computer (Node 22.5+ or the sqlite3 program). */
export async function canSqlite() {
  return Boolean((await nodeSqlite()) || findBin('sqlite3'))
}

/**
 * Copies a database (with its -wal and -shm companions) into data/scan/tmp, runs `fn(query)` on the
 * copy and removes it again. `query(sql)` returns rows as objects. The original file is only read.
 * Throws when the file cannot be copied (the caller decides whether that means "needs permission").
 */
export async function withDbCopy(source, fn, { maxBytes = 3_000_000_000 } = {}) {
  const st = await stat(source)
  if (st.size > maxBytes) throw new Error(`database is too large (${gb(st.size)} GB)`)
  const dir = join(SCAN_DIR, 'tmp', `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  const copy = join(dir, 'db.sqlite')
  let db = null
  try {
    await copyFile(source, copy)
    for (const suffix of ['-wal', '-shm']) {
      if (exists(source + suffix)) await copyFile(source + suffix, copy + suffix).catch(() => {})
    }
    const mod = await nodeSqlite()
    let query
    if (mod) {
      db = new mod.DatabaseSync(copy)
      query = (sql) => db.prepare(sql).all()
    } else {
      const bin = findBin('sqlite3')
      if (!bin) throw new Error('no SQLite reader available')
      query = async (sql) => {
        const res = await sh(bin, ['-json', copy, sql], { timeout: 30_000 })
        if (res.code !== 0) throw new Error(res.out.slice(0, 200))
        return res.out ? JSON.parse(res.out) : []
      }
    }
    return await fn(query)
  } finally {
    try {
      db?.close()
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Removes leftovers of an interrupted run. */
export function cleanTmp() {
  rmSync(join(SCAN_DIR, 'tmp'), { recursive: true, force: true })
}

// ── Windows PowerShell ──
/** Runs a PowerShell script (Windows only) and returns its text output, '' on failure. */
export async function powershell(script, timeout = 20_000) {
  if (!IS_WIN) return ''
  const bin = findBin('powershell') ?? 'powershell.exe'
  const full = `$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8\n${script}`
  const encoded = Buffer.from(full, 'utf16le').toString('base64')
  const res = await sh(bin, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeout })
  // the exit code only reflects the last statement: a script that printed its JSON is good enough
  return res.code === 124 ? '' : res.out
}

/** PowerShell script whose last statement is `... | ConvertTo-Json`. Null when it fails. */
export async function powershellJson(script, timeout) {
  const out = await powershell(script, timeout)
  const start = out.search(/[[{]/)
  const end = Math.max(out.lastIndexOf('}'), out.lastIndexOf(']'))
  if (start < 0 || end < start) return null
  try {
    return JSON.parse(out.slice(start, end + 1))
  } catch {
    return null
  }
}

/** One value from the Windows registry via reg.exe, null when missing. */
export async function regValue(key, name) {
  if (!IS_WIN) return null
  const res = await sh('reg.exe', ['query', key, '/v', name], { timeout: 6000 })
  if (res.code !== 0) return null
  const m = res.out.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+REG_\\w+\\s+(.+)`, 'i'))
  return m ? m[1].trim() : null
}
