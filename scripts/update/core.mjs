/**
 * Shared ground of the updater: paths, small file helpers and the rules about what an update may touch.
 *
 * The helpers come from scripts/lib.mjs. When that file cannot be loaded (a half applied or broken
 * update), local copies take over, so `rollback` keeps working no matter what the update did.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

let lib = null
try {
  lib = await import('../lib.mjs')
} catch {
  lib = null
}

const HERE = dirname(fileURLToPath(import.meta.url))

export const REPO = lib?.REPO ?? join(HERE, '..', '..')
export const DATA_DIR = lib?.DATA_DIR ?? (process.env.JARVIS_DATA_DIR || join(REPO, 'data'))
export const IS_WIN = lib?.IS_WIN ?? process.platform === 'win32'
export const IS_MAC = lib?.IS_MAC ?? process.platform === 'darwin'

export const findBin =
  lib?.findBin ??
  ((name) => {
    const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : ['']
    for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
      for (const ext of exts) if (existsSync(join(dir, name + ext))) return join(dir, name + ext)
    }
    return null
  })

/** Runs a command and returns { code, out }. Never throws. */
export const sh =
  lib?.sh ??
  ((bin, args = [], { timeout = 20_000, cwd = REPO } = {}) =>
    new Promise((done) => {
      let out = ''
      let child
      try {
        child = spawn(bin, args, { cwd, windowsHide: true, shell: IS_WIN && /\.(cmd|bat)$/i.test(bin) })
      } catch (err) {
        return done({ code: 1, out: String(err?.message ?? err) })
      }
      const timer = setTimeout(() => child.kill(), timeout)
      child.stdout.on('data', (d) => (out = `${out}${d}`.slice(-200_000)))
      child.stderr.on('data', (d) => (out = `${out}${d}`.slice(-200_000)))
      child.on('error', (err) => {
        clearTimeout(timer)
        done({ code: 1, out: `${out}${err.message}` })
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        done({ code: code ?? 1, out: out.trim() })
      })
    }))

export const parseArgs =
  lib?.parseArgs ??
  ((argv = process.argv.slice(2)) => ({
    flags: new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2))),
    rest: argv.filter((a) => !a.startsWith('--')),
  }))

// ── where the updater keeps its things ──

export const MANIFEST = 'jarvis.manifest.json'
/** Version of the plan and session file format. A newer updater refuses files written by an older one. */
export const SCHEMA = 1
export const DEFAULT_REPO = 'janjurdik/jarvis-starter'
export const DEFAULT_BRANCH = 'main'

export const UPDATE_DIR = join(DATA_DIR, 'update')
export const P = {
  base: join(UPDATE_DIR, 'base'),
  incoming: join(UPDATE_DIR, 'incoming'),
  conflicts: join(UPDATE_DIR, 'conflicts'),
  backup: join(UPDATE_DIR, 'backup'),
  tmp: join(UPDATE_DIR, 'tmp'),
  state: join(UPDATE_DIR, 'state.json'),
  plan: join(UPDATE_DIR, 'plan.json'),
  session: join(UPDATE_DIR, 'session.json'),
  check: join(UPDATE_DIR, 'check.json'),
  announced: join(UPDATE_DIR, 'announced.json'),
  history: join(UPDATE_DIR, 'history.json'),
}

// ── paths ──

export const toPosix = (p) => p.split(sep).join('/')
/** Absolute path of a repository relative posix path, inside `root`. */
export const abs = (rel, root = REPO) => join(root, ...rel.split('/'))

/** A path from a manifest is only used when it cannot leave the folder. */
export function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 400) return false
  if (rel.includes('\\') || rel.includes(':') || rel.includes('\0') || rel.startsWith('/')) return false
  return rel.split('/').every((part) => part && part !== '.' && part !== '..')
}

/** Turns what the user typed (absolute, relative, with backslashes) into a repository relative posix path. */
export function relFromInput(input) {
  const full = isAbsolute(input) ? input : resolve(REPO, input)
  const rel = toPosix(relative(REPO, full))
  return safeRel(rel) ? rel : null
}

/** Shipped files that live inside a protected folder (the same exception .gitignore makes). */
const SHIPPED_IN_PROTECTED = ['memory/README.md']

/**
 * Paths an update never reads, writes or deletes: the user's memory, setup, secrets and runtime data.
 * Checked for every path that comes from upstream, whatever the manifest says.
 */
export function isProtected(path) {
  if (SHIPPED_IN_PROTECTED.includes(path)) return false
  // `.ENV` and `Memory/x` are the same files as `.env` and `memory/x` on macOS and Windows.
  const rel = String(path).toLowerCase()
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  if (/^\.env(\..*)?$/.test(base) && base !== '.env.example') return true
  if (rel === 'config/jarvis.json') return true
  return ['memory/', 'data/', 'node_modules/', 'hud/desktop/build/', '.git/'].some((dir) => rel.startsWith(dir)) || rel.includes('/node_modules/') || rel.includes('/.git/')
}

/**
 * Files a tool writes, not a person. The upstream version always wins (npm rewrites the lock file
 * on its own, which must not look like a change the user made).
 */
export const isGenerated = (rel) => rel === 'package-lock.json'

/** Files that are nobody's work: system litter, logs, caches. */
export function isNoise(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  return base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini' || /\.(log|pyc|tmp)$/.test(base) || rel.split('/').some((part) => part === '__pycache__' || part === '.venv')
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv'])

/** Every file under `root` as posix relative paths, without protected paths and litter. */
export function walk(root, { keep = () => true, limit = 20_000 } = {}) {
  const out = []
  const visit = (dir, prefix) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= limit) return
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || isProtected(`${rel}/`) || join(dir, e.name) === DATA_DIR) continue
        visit(join(dir, e.name), rel)
      } else if (e.isFile() && !isProtected(rel) && !isNoise(rel) && keep(rel)) {
        out.push(rel)
      }
    }
  }
  visit(root, '')
  for (const rel of SHIPPED_IN_PROTECTED) if (out.length < limit && keep(rel) && existsSync(join(root, ...rel.split('/')))) out.push(rel)
  return out.sort()
}

// ── content ──

export const isBinary = (buf) => buf.subarray(0, 8000).includes(0)
export const hasCRLF = (buf) => buf.includes('\r\n')
/** Text with Windows line ends turned into plain ones. Binary content is returned as it is. */
export const toLF = (buf) => (isBinary(buf) || !hasCRLF(buf) ? buf : Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'))

/**
 * Identity of a file's content: sha256 of the bytes, for text after turning CRLF into LF.
 * A git checkout on Windows that converts line ends therefore still counts as untouched.
 */
export const fileHash = (buf) => createHash('sha256').update(toLF(buf)).digest('hex')

export function readBuf(file) {
  try {
    return readFileSync(file)
  } catch {
    return null
  }
}

export const hashOf = (file) => {
  const buf = readBuf(file)
  return buf ? fileHash(buf) : null
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Writes through a temporary file, so a reader never sees half of it. */
export function writeFile(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  try {
    renameSync(tmp, file)
  } catch {
    // Windows refuses to rename over a file that something holds open: write in place instead.
    writeFileSync(file, data)
    rmSync(tmp, { force: true })
  }
}

export const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`)

/** Copies a file with its permissions, creating the folders on the way. */
export function copyInto(src, dst) {
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
}

/** Deletes a file and the folders that became empty because of it, never above `root`. */
export function removeFile(file, root = REPO) {
  rmSync(file, { force: true })
  let dir = dirname(file)
  while (dir.startsWith(root) && dir !== root) {
    try {
      rmdirSync(dir)
    } catch {
      break
    }
    dir = dirname(dir)
  }
}

export const rmDir = (dir) => rmSync(dir, { recursive: true, force: true })
export const exists = existsSync

// ── versions and words ──

export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Negative when a is older than b, positive when newer. Unknown versions count as 0.0.0. */
export function cmpVersion(a, b) {
  const x = parseVersion(a) ?? [0, 0, 0]
  const y = parseVersion(b) ?? [0, 0, 0]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/** Slovak plural: plural(3, 'súbor', 'súbory', 'súborov') → "3 súbory". */
export const plural = (n, one, few, many) => `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`

/** Timestamp that is safe as a folder name on every system: 2026-11-15T17-30-05. */
export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
}

export const errMsg = (err) => (err instanceof Error ? err.message : String(err))

/** Runs `fn` over the items, at most `limit` at once. */
export async function mapLimit(items, limit, fn) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i], i)
    }
  })
  await Promise.all(workers)
}

/** "git" for a clone, "archive" for a folder unpacked from a ZIP. */
export const installMode = () => (existsSync(join(REPO, '.git')) ? 'git' : 'archive')

let gitFound
/**
 * Path of a working git, or null. JARVIS_UPDATE_GIT=0 turns git off, a path picks a specific one.
 * On a Mac without the command line tools /usr/bin/git is a stub that opens an install dialog,
 * so it is only used when the tools are really there.
 */
export function git() {
  gitFound ??= (async () => {
    const wish = process.env.JARVIS_UPDATE_GIT
    if (wish === '0' || wish === 'off') return null
    const bin = wish && existsSync(wish) ? wish : findBin('git')
    if (!bin) return null
    if (IS_MAC && bin === '/usr/bin/git' && (await sh('/usr/bin/xcode-select', ['-p'], { timeout: 5000 })).code !== 0) return null
    return (await sh(bin, ['--version'], { timeout: 8000 })).code === 0 ? bin : null
  })()
  return gitFound
}
