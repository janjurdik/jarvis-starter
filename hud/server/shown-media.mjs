/**
 * Photos, videos and audio Jarvis shows on the screen: what a finished job names in its result and
 * what the brain shows on demand (show_media). Each one becomes a floating card on the desktop and a
 * thumbnail in the chat card, so a path never has to be read off the screen.
 *
 *   findMediaPaths(text)      the local media files a text names that really exist (spaces, diacritics, ~, quotes)
 *   stripMediaPaths(text, f)  the same text without those paths, the meaning kept
 *   trimText(text, max)       shortened at a sentence (or a word), never in the middle of a word
 *   registerMedia(file)       allows exactly this file under GET /api/media/<id> for a while
 *   mediaFile(id)             the file behind an id, or null (unknown, expired, gone)
 *   servedFile(file)          what the browser gets: HEIC turned into JPEG on a Mac, the rest as it is
 *
 * Only files registered here (or named by a job, server/jobs.mjs) can be fetched, by an opaque id,
 * never by a path from the address. The registry lives in data/brain/shown-media.json (0600).
 */
import { randomBytes, createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { BRAIN_DIR, DATA_DIR, REPO, errMsg, log, writeFileAtomic } from './util.mjs'

/** Extension → kind and the type the browser gets. A .mov is the same family as mp4: as video/mp4 Chrome plays it too. */
export const MEDIA_TYPES = {
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.avif': { kind: 'image', mime: 'image/avif' },
  '.heic': { kind: 'image', mime: 'image/heic' },
  '.heif': { kind: 'image', mime: 'image/heif' },
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.m4v': { kind: 'video', mime: 'video/mp4' },
  '.mov': { kind: 'video', mime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mp3': { kind: 'audio', mime: 'audio/mpeg' },
  '.m4a': { kind: 'audio', mime: 'audio/mp4' },
  '.wav': { kind: 'audio', mime: 'audio/wav' },
}
export const MEDIA_KINDS = new Set(['image', 'video', 'audio'])
export const MEDIA_MAX = 24
const IMAGE_MAX_BYTES = 60 * 1024 * 1024

export const mediaType = (file) => MEDIA_TYPES[extname(String(file ?? '')).toLowerCase()] ?? null
export const mediaKind = (file) => mediaType(file)?.kind ?? null

const EXT = Object.keys(MEDIA_TYPES).map((e) => e.slice(1)).join('|')
const END_RE = new RegExp(`\\.(?:${EXT})(?![\\p{L}\\p{N}_])`, 'giu')
/** What may stand right before a path: start, space, a quote or a bracket, `:` or `=`. */
const BEFORE = /[\s"'`„“”‚‘’«»(\[{<:=]/u

/** A path as written → the file on this computer. */
export function resolvePath(raw, base = REPO) {
  let p = String(raw ?? '').trim()
  if (!p) return null
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(new URL(p).pathname)
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
    } catch {
      return null
    }
  }
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  if (/^[A-Za-z]:[\\/]/.test(p)) return process.platform === 'win32' ? p : null
  return isAbsolute(p) ? p : resolve(base, p)
}

/** The file is there, is a file and is a kind the screen can show. */
function usable(file) {
  try {
    const info = statSync(file)
    if (!info.isFile() || !mediaKind(file)) return false
    return mediaKind(file) !== 'image' || info.size <= IMAGE_MAX_BYTES
  } catch {
    return false
  }
}

/** Where a path may start inside `line` (indexes), leftmost first: the longest reading is tried first. */
function startsIn(text, from, to) {
  const out = []
  for (let i = from; i < to; i++) {
    const prev = i === 0 ? ' ' : text[i - 1]
    const atFile = text.startsWith('file://', i)
    if (!atFile && !BEFORE.test(prev)) continue
    const rest = text.slice(i, i + 9)
    if (atFile || rest.startsWith('~/') || rest.startsWith('~\\') || rest[0] === '/' || /^[A-Za-z]:[\\/]/.test(rest) || /^(?:memory|data|hud)\//.test(rest)) out.push(i)
  }
  return out
}

/**
 * The local media files a text names, in the order they appear, only the ones that exist. A path
 * may hold spaces and diacritics ("/Users/Ján Jurdik/Jarvis/x.mp4"), start with ~, stand in quotes
 * or backticks, or be a file:// address. Returns [{ file, kind, name, raw }], at most `max`.
 */
export function findMediaPaths(text, { base = REPO, max = MEDIA_MAX } = {}) {
  const src = String(text ?? '')
  const out = []
  const seen = new Set()
  let floor = 0
  for (const m of src.matchAll(END_RE)) {
    if (out.length >= max) break
    const end = m.index + m[0].length
    const lineStart = Math.max(floor, src.lastIndexOf('\n', m.index) + 1)
    for (const i of startsIn(src, lineStart, m.index)) {
      const raw = src.slice(i, end)
      const file = resolvePath(raw, base)
      if (!file || !usable(file)) continue
      floor = end
      if (seen.has(file)) break
      seen.add(file)
      out.push({ file, kind: mediaKind(file), name: basename(file), raw })
      break
    }
  }
  return out
}

/**
 * The text without the paths of media that are shown on the screen anyway: "Video je hotové:
 * /Users/…/reel.mp4 Má 1080x1920" → "Video je hotové. Má 1080x1920". What is left of the sentence
 * stays as it was written.
 */
export function stripMediaPaths(text, found = []) {
  let out = String(text ?? '')
  const raws = [...new Set(found.map((f) => f.raw).filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!raws.length) return out
  // Each shown path becomes a mark first, so only the words around it are tidied, nothing else of the text.
  const M = '\u0001'
  for (const raw of raws) {
    const q = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`(?:file://)?[\`"'„“‚‘«]?${q}[\`"'“”‘’»]?`, 'g'), M)
  }
  return (
    out
      // "a.png, b.mp3 a c.mp4" is one mark, "(a.png)" none at all
      .replace(new RegExp(`${M}(?:[ \\t]*(?:,|;|a|aj|alebo|and)[ \\t]*${M})+`, 'g'), M)
      .replace(new RegExp(`[ \\t]*\\([ \\t]*${M}[ \\t]*\\)`, 'g'), '')
      // "uložené v <path>." and "hotové, <path>." end where the sentence ends
      .replace(new RegExp(`[ \\t]+(?:v|vo|do|na|sem|tu|ako|súbor(?:e|u)?)[ \\t]+${M}(?=[ \\t]*(?:[.,;!?]|$))`, 'gimu'), M)
      .replace(new RegExp(`[ \\t]*[,;][ \\t]*${M}(?=[ \\t]*(?:[.!?]|$))`, 'gm'), '')
      // "Video je hotové: <path> Má 1080x1920" → "Video je hotové. Má 1080x1920"
      .replace(new RegExp(`:[ \\t]*${M}[ \\t]*(?=[.,;!?]|$)`, 'gm'), '')
      .replace(new RegExp(`:[ \\t]*${M}[ \\t]+(?=\\p{Lu})`, 'gu'), '. ')
      .replace(new RegExp(`[ \\t]*${M}[ \\t]*(?=[.,;!?])`, 'g'), '')
      .replace(new RegExp(`^[ \\t]*${M}[ \\t]*[,.;:]?[ \\t]*`, 'gm'), '')
      .replace(new RegExp(M, 'g'), ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/**
 * At most `max` characters, cut after the last whole sentence that fits. A first sentence longer
 * than that is cut after a whole word and ends with "…", never in the middle of one.
 */
export function trimText(text, max) {
  const t = String(text ?? '').trim()
  if (t.length <= max) return t
  const head = t.slice(0, max + 1)
  let cut = -1
  for (const m of head.matchAll(/[.!?…](?=\s|$)/g)) if (m.index < max) cut = m.index + 1
  if (cut >= Math.min(60, max * 0.4)) return t.slice(0, cut).trim()
  const space = t.slice(0, max).search(/\s\S*$/)
  const words = (space > max * 0.5 ? t.slice(0, space) : t.slice(0, max - 1)).replace(/[\s,;:–-]+$/, '')
  return `${words}…`
}

// ── registry: the exact files the screen may fetch ──────────────────────

const REG_FILE = join(BRAIN_DIR, 'shown-media.json')
const TTL_MS = 7 * 24 * 3600_000
const REG_MAX = 400
/** id → { file, kind, name, exp } */
let reg = null
let saveTimer = null

function load() {
  if (reg) return reg
  reg = new Map()
  try {
    const now = Date.now()
    for (const e of JSON.parse(readFileSync(REG_FILE, 'utf8')).items ?? []) if (e?.id && e.exp > now && MEDIA_KINDS.has(e.kind)) reg.set(e.id, e)
  } catch {
    // first time
  }
  return reg
}

function save() {
  if (process.env.JARVIS_MEDIA_PERSIST === '0') return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    writeFileAtomic(REG_FILE, JSON.stringify({ items: [...load().values()] }), 0o600).catch((err) => log('media', errMsg(err)))
  }, 200)
}

/** The public shape the page gets: no path, only the id address. */
export const mediaItem = (e) => ({ id: e.id, kind: e.kind, name: e.name, url: `/api/media/${e.id}` })

/** Allows exactly this file for a week. The same file keeps its id. Returns the entry or null when it cannot be shown. */
export function registerMedia(file, { ttlMs = TTL_MS } = {}) {
  if (!file || !usable(file)) return null
  const map = load()
  const exp = Date.now() + ttlMs
  for (const e of map.values()) {
    if (e.file !== file) continue
    e.exp = exp
    save()
    return e
  }
  const e = { id: `m${randomBytes(8).toString('hex')}`, file, kind: mediaKind(file), name: basename(file), exp }
  map.set(e.id, e)
  if (map.size > REG_MAX) {
    const old = [...map.values()].sort((a, b) => a.exp - b.exp).slice(0, map.size - REG_MAX)
    for (const o of old) map.delete(o.id)
  }
  save()
  return e
}

/** The file behind an id from the address, or null. */
export function mediaFile(id) {
  if (!/^m[0-9a-f]{16}$/.test(String(id ?? ''))) return null
  const e = load().get(id)
  if (!e || e.exp < Date.now()) return null
  return existsSync(e.file) ? e.file : null
}

/**
 * The brain's show_media: paths as it wrote them → registered items, and what could not be shown.
 * Relative paths are taken from the Jarvis folder.
 */
export function registerPaths(paths, { base = REPO } = {}) {
  const items = []
  const skipped = []
  const seen = new Set()
  for (const raw of (Array.isArray(paths) ? paths : [paths]).slice(0, MEDIA_MAX * 2)) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const file = resolvePath(raw.trim().replace(/^["'`]|["'`]$/g, ''), base)
    const e = file ? registerMedia(file) : null
    if (!e) {
      skipped.push(basename(String(raw)))
      continue
    }
    if (seen.has(e.id) || items.length >= MEDIA_MAX) continue
    seen.add(e.id)
    items.push(mediaItem(e))
  }
  return { items, skipped }
}

// ── what the browser gets ───────────────────────────────────────────────

const CACHE_DIR = join(DATA_DIR, 'media-cache')
const converting = new Map()

/**
 * HEIC (iPhone photos) shows only in Safari: on a Mac it is turned into a JPEG once with the
 * system's own sips and that copy is served. Elsewhere the file goes as it is (the card then says
 * it cannot show it). Everything else is served unchanged.
 */
export async function servedFile(file) {
  if (!/\.hei[cf]$/i.test(file) || process.platform !== 'darwin') return file
  const info = await stat(file)
  const out = join(CACHE_DIR, `${createHash('sha1').update(`${file}|${info.mtimeMs}|${info.size}`).digest('hex').slice(0, 20)}.jpg`)
  if (existsSync(out)) return out
  if (!converting.has(out)) {
    converting.set(
      out,
      mkdir(CACHE_DIR, { recursive: true, mode: 0o700 })
        .then(
          () =>
            new Promise((done) => {
              execFile('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', '2800', file, '--out', out], { timeout: 30_000 }, (err) => {
                if (err) log('media', `HEIC sa neprekonvertoval: ${errMsg(err)}`)
                done()
              })
            }),
        )
        .finally(() => converting.delete(out)),
    )
  }
  await converting.get(out)
  return existsSync(out) ? out : file
}
