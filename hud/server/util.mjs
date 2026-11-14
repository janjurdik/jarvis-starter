/**
 * Spoločné pomocné funkcie servera. Bez závislostí.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** Repository root (the folder the user opens in Claude). */
export const REPO = join(ROOT, '..')
export const HOME = homedir()
export const IS_WIN = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'
/** Runtime data (caches, logs, state). Never committed. */
export const DATA_DIR = process.env.JARVIS_DATA_DIR || join(REPO, 'data')
export const BRAIN_DIR = join(DATA_DIR, 'brain')
export const TTS_DIR = join(DATA_DIR, 'tts')

/** Text do jedného riadku bez riadiacich znakov, orezaný na `max`. */
export const clean = (value, max) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''

/** Viacriadkový text: zachová \n, odstráni ostatné riadiace znaky. */
export const cleanBlock = (value, max) =>
  typeof value === 'string'
    ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max)
    : ''

export const slug = (value) => clean(value, 24).toLowerCase().replace(/[^a-z0-9-]/g, '')

export const isLoopback = (ip = '') => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  })
  res.end(data)
}

export function readBody(req, limit = 16_384) {
  return new Promise((done, fail) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        fail(Object.assign(new Error('telo požiadavky je príliš veľké'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    req.on('error', fail)
  })
}

/** Binárne telo (zvuk z prehliadača) ako Buffer. */
export function readRaw(req, limit = 4_000_000) {
  return new Promise((done, fail) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        fail(Object.assign(new Error('nahrávka je príliš veľká'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks)))
    req.on('error', fail)
  })
}

/** JSON telo ako objekt, inak chyba so `status` 400. Prázdne telo = {}. */
export async function readJson(req, limit) {
  const raw = await readBody(req, limit)
  if (!raw.trim()) return {}
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    throw Object.assign(new Error('telo musí byť JSON'), { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('telo musí byť JSON objekt'), { status: 400 })
  return body
}

/** Zápis cez dočasný súbor, aby čitateľ nikdy nevidel polovičný obsah. */
export async function writeFileAtomic(file, data, mode = 0o644) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, data, { mode })
  await chmod(tmp, mode)
  await rename(tmp, file)
}

/**
 * Copy of an environment with extra directories in front of PATH. On Windows the variable is
 * usually spelled `Path`: the existing key is reused, so the child never gets two of them.
 */
export function withPath(env, dirs = []) {
  const out = { ...env }
  const key = Object.keys(out).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  out[key] = [...dirs, out[key] ?? ''].filter(Boolean).join(delimiter)
  return out
}

/** First existing path from the list. */
export function firstExisting(...paths) {
  return paths.flat().find((p) => p && existsSync(p)) ?? null
}

/**
 * Finds an executable by name: explicit override, then PATH (with PATHEXT on Windows),
 * then the usual per-user install locations. Works when started from launchd or Task Scheduler,
 * where PATH is minimal.
 */
export function findBin(name, { override = null, extraDirs = [] } = {}) {
  if (override && existsSync(override)) return override
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter),
    ...extraDirs,
    join(HOME, '.local', 'bin'),
    join(HOME, '.cargo', 'bin'),
    dirname(process.execPath),
    ...(IS_WIN
      ? [join(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'), 'npm'), join(process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links')]
      : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']),
  ].filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, name + ext)
      if (existsSync(full)) return full
    }
  }
  return null
}

const isShim = (bin) => IS_WIN && /\.(cmd|bat)$/i.test(bin ?? '')
/** Quotes one argument for cmd.exe (only used for .cmd shims, which need a shell). */
const winQuote = (arg) => (/[\s"&|<>^()]/.test(String(arg)) ? `"${String(arg).replace(/"/g, '""')}"` : String(arg))

/**
 * spawn() that also works for Windows .cmd shims (an npm-installed CLI): those need a shell,
 * and with a shell Node does not quote arguments, so paths with spaces are quoted here.
 * Real executables (.exe, macOS and Linux binaries) are started directly.
 */
export function spawnBin(bin, args = [], opts = {}) {
  if (isShim(bin)) return spawn(winQuote(bin), args.map(winQuote), { windowsHide: true, ...opts, shell: true })
  return spawn(bin, args, { windowsHide: true, ...opts })
}

/** Timestamped log line. */
export function log(scope, ...args) {
  const t = new Date().toLocaleTimeString('sk-SK', { hour12: false })
  console.log(`${t} [${scope}]`, ...args)
}

export const errMsg = (err) => (err instanceof Error ? err.message : String(err))

/** Dátum v miestnom čase ako YYYY-MM-DD. */
export function isoDay(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number)
  return isoDay(new Date(y, m - 1, d + n))
}

/** Miestna polnoc dňa YYYY-MM-DD v ms. */
export function dayStartMs(day) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

export const hhmm = (ms) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const DOW_SHORT = ['Ne', 'Po', 'Ut', 'St', 'Št', 'Pi', 'So']
export const DOW_LONG = ['nedeľa', 'pondelok', 'utorok', 'streda', 'štvrtok', 'piatok', 'sobota']

export function dowOf(day) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

/** Obmedzí paralelizmus na `limit` naraz, poradie výsledkov ostáva. */
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
