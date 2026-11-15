/**
 * Files dropped into the HUD window.
 *
 * The body of POST /api/upload is streamed straight to disk (data/inbox/<id>/<name>), never held
 * in memory: a data export can have 10+ GB. Every upload gets its own folder, so the file keeps
 * the name it had on the user's computer (the importer reads the WhatsApp contact or the
 * Instagram account from it). A dropped folder arrives file by file into the same upload.
 *
 *   begin  → { id }            checks the name, the size and the free disk space before a byte is sent
 *   put    → one file          POST /api/upload?id=<id>&path=<relative path>
 *   finish → { root, name… }   the path handed to the importer (imports.mjs)
 *
 * Nothing here opens, unpacks or runs what was uploaded. Attachments (memory/prilohy) are served
 * back as plain downloads, only bitmap images are shown inline.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, realpath, rename, rm, stat, statfs, unlink } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MEMORY_DIR } from './memory/index.mjs'
import { DATA_DIR, clean, errMsg, log } from './util.mjs'

export const INBOX_DIR = join(DATA_DIR, 'inbox')
export const ATTACH_DIR = join(MEMORY_DIR, 'prilohy')

const GB = 1024 ** 3
const MAX_BYTES = Math.max(1, Number(process.env.JARVIS_UPLOAD_MAX_GB) || 200) * GB
/** Free space that has to stay on the disk after an upload (the importer needs room to unpack). */
const RESERVE_BYTES = 1 * GB
const MAX_FILES = 250_000
const MAX_OPEN = 12
const STALE_MS = 3 * 24 * 3600_000
const NAME_MAX = 140
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i

export const fail = (status, message) => Object.assign(new Error(message), { status })

const gb = (bytes) => {
  const v = bytes / GB
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} GB`.replace('.', ',')
}

// ── names and paths ───────────────────────────────────────────────────────

/** One file or folder name without anything that could leave its folder. Throws 400 on path tricks. */
export function safeName(raw) {
  const given = String(raw ?? '').normalize('NFC')
  if (!given.trim() || given.includes('\0') || /[\\/]/.test(given) || /^\.+$/.test(given.trim())) throw fail(400, 'Neplatný názov súboru.')
  let name = given
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
  if (name.length > NAME_MAX) {
    const ext = extname(name).slice(0, 16)
    name = name.slice(0, NAME_MAX - ext.length).trim() + ext
  }
  if (!name) throw fail(400, 'Neplatný názov súboru.')
  return RESERVED.test(name) ? `_${name}` : name
}

/** Relative path of a file inside a dropped folder: every segment is checked on its own. */
export function safeRelPath(raw) {
  const given = String(raw ?? '').normalize('NFC')
  if (!given || given.includes('\0') || given.includes('\\') || given.startsWith('/') || given.length > 1000) throw fail(400, 'Neplatná cesta súboru.')
  const parts = given.split('/')
  if (parts.length > 24) throw fail(400, 'Priečinok je vnorený príliš hlboko.')
  return parts.map((p) => {
    if (p === '..' || p === '.' || !p.trim()) throw fail(400, 'Neplatná cesta súboru.')
    return safeName(p)
  })
}

/** `base` joined with `parts`, guaranteed to stay inside `base`. */
function inside(base, parts) {
  const full = resolve(base, ...parts)
  if (full !== base && !full.startsWith(base + sep)) throw fail(400, 'Neplatná cesta súboru.')
  return full
}

/** Free bytes on the disk that holds `dir`, or null when the system does not say. */
export async function freeBytes(dir) {
  try {
    const s = await statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

async function checkSpace(bytes) {
  await mkdir(INBOX_DIR, { recursive: true, mode: 0o700 })
  if (bytes > MAX_BYTES) throw fail(413, `Toto je priveľa naraz (${gb(bytes)}). Najviac zvládnem ${gb(MAX_BYTES)}.`)
  const free = await freeBytes(INBOX_DIR)
  if (free !== null && free < bytes + RESERVE_BYTES) throw fail(507, `Na disku nie je dosť miesta. Treba ${gb(bytes + RESERVE_BYTES)}, voľných je ${gb(free)}.`)
}

// ── uploads in progress ───────────────────────────────────────────────────

/** id → { id, dir, name, folder, root, declared, size, files, at } */
const uploads = new Map()

const stamp = (d = new Date()) => {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Opens an upload: validates the name and the announced size, checks the disk, creates data/inbox/<id>/. */
export async function beginUpload({ name, size = null, folder = false }) {
  const safe = safeName(name)
  const declared = size === null || size === undefined ? null : Number(size)
  if (declared !== null && (!Number.isFinite(declared) || declared < 0)) throw fail(400, 'Neplatná veľkosť.')
  for (const [id, u] of uploads) if (Date.now() - u.at > 6 * 3600_000) await dropUpload(id)
  if (uploads.size >= MAX_OPEN) throw fail(429, 'Naraz sa nahráva príliš veľa vecí. Počkaj, kým sa niečo dokončí.')
  await checkSpace(declared ?? 0)
  const id = `${stamp()}-${Math.random().toString(36).slice(2, 6)}`
  const dir = join(INBOX_DIR, id)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const up = { id, dir, name: safe, folder: folder === true, root: join(dir, safe), declared, size: 0, files: 0, at: Date.now() }
  uploads.set(id, up)
  return up
}

export function getUpload(id) {
  const up = uploads.get(String(id ?? ''))
  if (!up) throw fail(404, 'Toto nahrávanie nepoznám. Skús to pustiť znova.')
  return up
}

/** Forgets an upload and removes what it stored. */
export async function dropUpload(id) {
  const up = uploads.get(id)
  if (!up) return
  uploads.delete(id)
  await rm(up.dir, { recursive: true, force: true }).catch(() => {})
}

/** Removes the stored copy once it is no longer needed. Only ever touches folders inside data/inbox. */
export async function removeInboxDir(dir) {
  const full = resolve(String(dir ?? ''))
  if (!full.startsWith(INBOX_DIR + sep) || full === INBOX_DIR) return
  await rm(full, { recursive: true, force: true }).catch(() => {})
}

/**
 * Streams the request body into the upload. `relPath` is the file's path inside a dropped folder,
 * a single file needs none. Back-pressure comes from pipeline(): the socket is read only as fast
 * as the disk writes.
 */
export async function receiveFile(req, up, relPath = null) {
  if (!up.folder && up.files > 0) throw fail(409, 'Tento súbor je už nahratý.')
  if (up.files >= MAX_FILES) throw fail(413, 'Priečinok má priveľa súborov.')
  const dest = up.folder ? inside(up.root, safeRelPath(relPath)) : up.root
  const lengthHeader = req.headers['content-length']
  const length = lengthHeader === undefined ? null : Number(lengthHeader)
  if (length !== null && (!Number.isFinite(length) || length < 0)) throw fail(400, 'Neplatná veľkosť.')
  // Announced total already passed the disk check in begin; anything beyond it is checked again.
  const budget = up.declared === null ? 0 : Math.max(0, up.declared - up.size)
  if (length !== null && length > budget) await checkSpace(up.size + length)
  if (up.size + (length ?? 0) > MAX_BYTES) throw fail(413, `Toto je priveľa naraz. Najviac zvládnem ${gb(MAX_BYTES)}.`)

  await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
  const part = `${dest}.part`
  let size = 0
  let checkedAt = 0
  const meter = new Transform({
    transform(chunk, _enc, done) {
      size += chunk.length
      if (up.size + size > MAX_BYTES || (length !== null && size > length)) return done(fail(413, 'Súbor je väčší, než bolo ohlásené.'))
      // A body without content-length was never checked against the disk: look every 256 MB.
      if (length === null && size - checkedAt > 256 * 1024 * 1024) {
        checkedAt = size
        freeBytes(INBOX_DIR).then((free) => done(free !== null && free < RESERVE_BYTES ? fail(507, 'Na disku došlo miesto.') : null, chunk), () => done(null, chunk))
        return
      }
      done(null, chunk)
    },
  })
  try {
    await pipeline(req, meter, createWriteStream(part, { flags: 'w', mode: 0o600, highWaterMark: 1024 * 1024 }))
    if (length !== null && size !== length) throw fail(400, 'Nahrávanie sa prerušilo.')
    await rename(part, dest)
  } catch (err) {
    await unlink(part).catch(() => {})
    if (err.status) throw err
    throw fail(err.code === 'ENOSPC' ? 507 : 400, err.code === 'ENOSPC' ? 'Na disku došlo miesto.' : `Nahrávanie sa prerušilo (${errMsg(err)}).`)
  }
  up.size += size
  up.files += 1
  up.at = Date.now()
  return { size, path: dest }
}

/** Closes an upload: what was stored and where. The caller decides what happens with it next. */
export function finishUpload(id) {
  const up = getUpload(id)
  if (!up.files) throw fail(400, 'Nič sa nenahralo.')
  uploads.delete(up.id)
  return up
}

/** Leftovers of interrupted uploads and exports nobody finished: gone after three days. */
export async function pruneInbox() {
  let entries = []
  try {
    entries = await readdir(INBOX_DIR, { withFileTypes: true })
  } catch {
    return
  }
  let removed = 0
  for (const e of entries) {
    const full = join(INBOX_DIR, e.name)
    if (uploads.has(e.name)) continue
    try {
      const info = await stat(full)
      if (Date.now() - info.mtimeMs < STALE_MS) continue
      await rm(full, { recursive: true, force: true })
      removed++
    } catch {
      // someone else removed it
    }
  }
  if (removed) log('upload', `upratané staré nahrávky: ${removed}`)
}

// ── serving files back ────────────────────────────────────────────────────

/** Only bitmap images are ever shown inline. HTML, SVG and the rest could run scripts in the HUD's origin. */
const INLINE = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}
export const isImagePath = (p) => Object.hasOwn(INLINE, extname(String(p)).toLowerCase())

const KINDS = [
  ['image', /\.(png|jpe?g|webp|gif|avif|bmp|heic|heif|tiff?)$/i],
  ['pdf', /\.pdf$/i],
  ['audio', /\.(mp3|m4a|wav|ogg|opus|aac|flac)$/i],
  ['video', /\.(mp4|mov|webm|mkv|avi)$/i],
  ['table', /\.(csv|tsv|xlsx?|numbers|ods)$/i],
  ['doc', /\.(docx?|odt|rtf|pages|txt|md|pptx?|key)$/i],
  ['archive', /\.(zip|tar|gz|7z|rar)$/i],
]
/** Rough type of a file for the chip in the HUD: image, pdf, audio, video, table, doc, archive or file. */
export const fileKind = (name) => KINDS.find(([, re]) => re.test(String(name)))?.[0] ?? 'file'

/**
 * Resolves a relative path against `base` and makes sure the real file (symlinks followed) still
 * lives inside it. Returns the absolute path of an existing regular file, or null.
 */
export async function containedFile(base, rel) {
  const given = String(rel ?? '').replace(/\\/g, '/')
  if (!given || given.includes('\0') || given.startsWith('/') || given.length > 1000) return null
  const full = resolve(base, given)
  if (!full.startsWith(base + sep)) return null
  try {
    const [realBase, real] = await Promise.all([realpath(base), realpath(full)])
    if (!real.startsWith(realBase + sep)) return null
    return (await stat(real)).isFile() ? real : null
  } catch {
    return null
  }
}

/** Attachment path relative to the memory folder ("prilohy/2026-11/foto.jpg") → absolute file, or null. */
export async function attachmentFile(rel) {
  const given = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!given.startsWith('prilohy/')) return null
  return containedFile(ATTACH_DIR, given.slice('prilohy/'.length))
}

/** Sends a stored file. Images inline, everything else as a download that the browser will not render. */
export async function sendStored(req, res, file, { imagesOnly = false } = {}) {
  const type = INLINE[extname(file).toLowerCase()]
  if (imagesOnly && !type) return false
  let info
  try {
    info = await stat(file)
  } catch {
    return false
  }
  const name = clean(file.split(sep).pop(), 200) || 'subor'
  res.writeHead(200, {
    'content-type': type ?? 'application/octet-stream',
    'content-length': info.size,
    'content-disposition': `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'private, max-age=600',
    'last-modified': info.mtime.toUTCString(),
  })
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  createReadStream(file).on('error', () => res.destroy()).pipe(res)
  return true
}
