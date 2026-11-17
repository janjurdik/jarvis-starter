/**
 * Shared helpers of the importer: paths, names of sources, text normalisation and formatting.
 */
import '../../hud/server/env.mjs'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MEMORY_DIR } from '../../hud/server/memory/index.mjs'
import { writeFileAtomic } from '../../hud/server/util.mjs'

export { MEMORY_DIR }
export const ARCHIVE_DIR = join(MEMORY_DIR, 'archiv')
export const DIGEST_DIR = join(ARCHIVE_DIR, 'digests')

export const SOURCE_NAME = {
  instagram: 'Instagram',
  facebook: 'Facebook a Messenger',
  whatsapp: 'WhatsApp',
  discord: 'Discord',
  telegram: 'Telegram',
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  spotify: 'Spotify',
  applemusic: 'Apple Music',
  takeout: 'Google Takeout',
  health: 'Apple Zdravie',
  steam: 'Steam',
  file: 'Súbor',
  unknown: 'Neznámy súbor',
}
/** Sources that produce message threads in the archive. */
export const CHAT_SOURCES = ['instagram', 'facebook', 'whatsapp', 'discord', 'telegram', 'chatgpt', 'claude']

// Sources the agent mapped on his own (import.mjs ingest) are known by the name the user's app has.
try {
  for (const [id, label] of Object.entries(JSON.parse(readFileSync(join(ARCHIVE_DIR, 'sources.json'), 'utf8')))) {
    if (!/^[a-z][a-z0-9-]{1,23}$/.test(id) || typeof label !== 'string') continue
    SOURCE_NAME[id] ??= label.slice(0, 40)
    if (!CHAT_SOURCES.includes(id)) CHAT_SOURCES.push(id)
  }
} catch {
  // nothing imported this way yet
}

/** Error with a message meant for the user (Slovak, no stack trace needed). */
export class UserError extends Error {}

// ── text ───────────────────────────────────────────────────────────────

/** Lowercase without diacritics, for comparing and searching. */
export const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣]/gu

/** Name tokens for matching people: no diacritics, emoji, punctuation or digits. */
export function nameTokens(name) {
  return fold(String(name ?? '').replace(EMOJI, ' '))
    .replace(/#\d{1,4}\b/g, ' ')
    .replace(/[^a-z\s._-]+/g, ' ')
    .split(/[\s._-]+/)
    .filter(Boolean)
}
export const normName = (name) => nameTokens(name).join(' ')

export const shortHash = (s) => createHash('md5').update(String(s)).digest('hex').slice(0, 10)

/** File-system safe, lower-case identifier that stays the same on every import. */
export function safeId(raw) {
  let s = fold(raw)
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  if (!s) s = `t-${shortHash(raw)}`
  if (s.length > 90) s = `${s.slice(0, 78)}-${shortHash(raw)}`
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/.test(s)) s = `${s}-t`
  return s
}

/** File name that is safe on macOS and Windows, keeping diacritics. */
export const safeFileName = (name) =>
  String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 120)

/** One line of text for previews. */
export const oneLine = (s, max = 140) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// ── time and numbers ───────────────────────────────────────────────────

/** ISO UTC string from milliseconds, or null when the value is not a usable date. */
export function iso(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0 || n > 4_102_444_800_000) return null
  return new Date(n).toISOString()
}

export const day = (isoString) => String(isoString ?? '').slice(0, 10)

/** "2026-01-31 18:20" in this computer's time zone (messages are stored in UTC). */
export function localStamp(isoString) {
  const d = new Date(isoString)
  if (Number.isNaN(d.getTime())) return String(isoString ?? '')
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 1234567 → "1 234 567" (Slovak grouping). */
export const fmtInt = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

/** 1288490188 → "1,2 GB". */
export function fmtBytes(bytes) {
  const n = Number(bytes) || 0
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let v = n
  let u = 0
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000
    u++
  }
  const text = u === 0 || v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace('.', ',').replace(/,0$/, '')
  return `${text} ${units[u]}`
}

/** Slovak plural: plural(5, 'správa', 'správy', 'správ') → "5 správ". */
export const plural = (n, one, few, many) => `${fmtInt(n)} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`

// ── files ──────────────────────────────────────────────────────────────

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

export const writeJson = (path, data) => writeFileAtomic(path, `${JSON.stringify(data, null, 1)}\n`)

/** Text of a buffer: UTF-8, or UTF-16 when it starts with that byte order mark. */
export function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  return buf.toString('utf8')
}
