/**
 * Shared helpers of the importer: paths, text normalisation, Meta mojibake repair,
 * streaming JSON and CSV readers (exports can have hundreds of megabytes) and formatting.
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

export const SOURCES = ['instagram', 'facebook', 'whatsapp', 'discord', 'telegram', 'chatgpt', 'claude', 'spotify', 'applemusic', 'takeout', 'health', 'file', 'unknown']
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

// Windows-1252 code points of the bytes 0x80 to 0x9F (the other flavour of the same damage).
const CP1252 = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
  [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91],
  [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98],
  [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
])
const utf8Strict = new TextDecoder('utf-8', { fatal: true })

/**
 * Meta exports store UTF-8 bytes as separate latin1 code points ("Å¡" instead of "š").
 * Turns them back into real text. Strings that are not damaged come back untouched.
 */
export function fixMojibake(s) {
  if (typeof s !== 'string' || !s) return s ?? ''
  let high = false
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) {
      high = true
      break
    }
  }
  if (!high) return s
  const bytes = Buffer.allocUnsafe(s.length)
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c <= 0xff) bytes[i] = c
    else if (CP1252.has(c)) bytes[i] = CP1252.get(c)
    else return s
  }
  try {
    return utf8Strict.decode(bytes).normalize('NFC')
  } catch {
    return s
  }
}

/** Applies fixMojibake to every string of a parsed JSON value, in place. */
export function fixMojibakeDeep(v) {
  if (typeof v === 'string') return fixMojibake(v)
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = fixMojibakeDeep(v[i])
    return v
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) v[k] = fixMojibakeDeep(v[k])
  }
  return v
}

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

// ── streaming JSON ─────────────────────────────────────────────────────

const WS = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09

/**
 * Reads a JSON document of any size from an async iterable of Buffers.
 * `want(path)` is asked when a value starts (path = keys and array indexes from the root):
 * true captures that whole value, parses it and passes it to `onValue(path, value)`.
 * Containers that are not wanted are walked into, other values are skipped.
 * So a 2 GB array of conversations is handled one conversation at a time.
 */
export async function scanJson(chunks, want, onValue) {
  const VALUE = 0
  const KEY = 1
  const KEYSTR = 2
  const COLON = 3
  const AFTER = 4
  const CAPTURE = 5
  const SKIPSTR = 6
  const SKIPLIT = 7
  const stack = []
  let state = VALUE
  let esc = false
  let inStr = false
  let depth = 0
  let parts = []
  let from = 0
  let path = null
  let first = true

  const curPath = () => stack.map((f) => (f.arr ? f.idx : f.key))
  const take = (chunk, end) => {
    parts.push(chunk.subarray(from, end))
    const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts)
    parts = []
    return buf.toString('utf8')
  }

  for await (let chunk of chunks) {
    if (typeof chunk === 'string') chunk = Buffer.from(chunk)
    let i = 0
    if (first) {
      first = false
      if (chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) i = 3
    }
    if (state === CAPTURE || state === KEYSTR) from = 0
    for (; i < chunk.length; i++) {
      const c = chunk[i]
      switch (state) {
        case VALUE: {
          if (WS(c)) break
          if (c === 0x5d) {
            // "]" right after "[" or after a trailing comma: the array ends
            stack.pop()
            state = AFTER
            break
          }
          path = curPath()
          if (want(path)) {
            state = CAPTURE
            from = i
            parts = []
            esc = false
            inStr = c === 0x22
            depth = c === 0x7b || c === 0x5b ? 1 : 0
          } else if (c === 0x7b) {
            stack.push({ arr: false, key: null, idx: 0 })
            state = KEY
          } else if (c === 0x5b) {
            stack.push({ arr: true, key: null, idx: 0 })
            state = VALUE
          } else if (c === 0x22) {
            state = SKIPSTR
            esc = false
          } else {
            state = SKIPLIT
          }
          break
        }
        case SKIPSTR:
          if (esc) esc = false
          else if (c === 0x5c) esc = true
          else if (c === 0x22) state = AFTER
          break
        case SKIPLIT:
          if (c === 0x2c || c === 0x5d || c === 0x7d || WS(c)) {
            state = AFTER
            i--
          }
          break
        case KEY:
          if (WS(c) || c === 0x2c) break
          if (c === 0x7d) {
            stack.pop()
            state = AFTER
          } else if (c === 0x22) {
            state = KEYSTR
            from = i
            parts = []
            esc = false
          }
          break
        case KEYSTR:
          if (esc) esc = false
          else if (c === 0x5c) esc = true
          else if (c === 0x22) {
            stack[stack.length - 1].key = JSON.parse(take(chunk, i + 1))
            state = COLON
          }
          break
        case COLON:
          if (c === 0x3a) state = VALUE
          break
        case AFTER: {
          if (WS(c)) break
          const top = stack[stack.length - 1]
          if (c === 0x2c) {
            if (top?.arr) {
              top.idx++
              state = VALUE
            } else {
              state = KEY
            }
          } else if (c === 0x5d || c === 0x7d) {
            stack.pop()
          }
          break
        }
        case CAPTURE: {
          let end = -1
          let again = false
          if (inStr) {
            if (esc) esc = false
            else if (c === 0x5c) esc = true
            else if (c === 0x22) {
              inStr = false
              if (depth === 0) end = i + 1
            }
          } else if (c === 0x22) {
            inStr = true
          } else if (c === 0x7b || c === 0x5b) {
            depth++
          } else if (c === 0x7d || c === 0x5d) {
            if (depth === 0) {
              end = i
              again = true
            } else if (--depth === 0) {
              end = i + 1
            }
          } else if (depth === 0 && (c === 0x2c || WS(c))) {
            end = i
            again = true
          }
          if (end >= 0) {
            const text = take(chunk, end)
            state = AFTER
            if (again) i--
            const r = onValue(path, JSON.parse(text))
            if (r && typeof r.then === 'function') await r
          }
          break
        }
      }
    }
    if (state === CAPTURE || state === KEYSTR) parts.push(chunk.subarray(from))
  }
  // a bare literal at the very end of the document (no closing bracket after it)
  if (state === CAPTURE && parts.length) {
    const text = Buffer.concat(parts).toString('utf8').trim()
    if (text) {
      const r = onValue(path, JSON.parse(text))
      if (r && typeof r.then === 'function') await r
    }
  }
}

/** Elements of a top-level JSON array, one by one. */
export const scanJsonArray = (chunks, onItem) => scanJson(chunks, (p) => p.length === 1, (_p, v) => onItem(v))

// ── streaming CSV ──────────────────────────────────────────────────────

/** Rows of a CSV stream as arrays of strings (quotes, escaped quotes and line breaks in fields). */
export async function* csvRows(chunks, delimiter = ',') {
  const decoder = new TextDecoder('utf-8')
  let row = []
  let field = ''
  let quoted = false
  let pendingQuote = false
  let started = false
  const feed = function* (text) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (quoted) {
        if (pendingQuote) {
          pendingQuote = false
          if (ch === '"') {
            field += '"'
            continue
          }
          quoted = false
          // falls through to the unquoted handling of this character
        } else if (ch === '"') {
          pendingQuote = true
          continue
        } else {
          field += ch
          continue
        }
      }
      if (ch === '"' && field === '') {
        quoted = true
      } else if (ch === delimiter) {
        row.push(field)
        field = ''
      } else if (ch === '\n') {
        row.push(field)
        field = ''
        yield row
        row = []
      } else if (ch !== '\r') {
        field += ch
      }
    }
  }
  for await (const chunk of chunks) {
    let text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    if (!started) {
      started = true
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    }
    yield* feed(text)
  }
  if (field !== '' || row.length) {
    row.push(field)
    yield row
  }
}

/** Throttled progress reporter: `report(0..1, 'Slovak stage')`. */
export function progressReporter(emit, everyMs = 150) {
  let last = 0
  let lastStage = ''
  return (fraction, stage) => {
    if (!emit) return
    const now = Date.now()
    if (stage === lastStage && now - last < everyMs && fraction < 1) return
    last = now
    lastStage = stage
    emit({ progress: Math.max(0, Math.min(1, Math.round(fraction * 1000) / 1000)), stage })
  }
}
