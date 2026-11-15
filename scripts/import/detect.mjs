/**
 * Recognises what the user dropped in: which service the export comes from and in which shape
 * (zip, unzipped folder, single file). Only reads file names and the first bytes of a few files.
 *
 *   const det = await detectExport('/path/to/export.zip')
 *   → { source, kind: 'zip'|'dir'|'file', confidence: 0..1, details: {…}, label } | null
 *
 * `null` means the path does not exist or cannot be read. Something readable but unknown
 * comes back with source 'unknown' (or 'file' for an ordinary document or picture).
 */
import { readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import * as ai from './parsers/ai.mjs'
import * as discord from './parsers/discord.mjs'
import * as meta from './parsers/meta.mjs'
import * as music from './parsers/music.mjs'
import * as takeout from './parsers/takeout.mjs'
import * as telegram from './parsers/telegram.mjs'
import * as whatsapp from './parsers/whatsapp.mjs'
import { openSource } from './source.mjs'
import { SOURCE_NAME, fmtBytes, plural } from './util.mjs'

const FILE_TYPES = {
  obrázok: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tiff', '.svg'],
  pdf: ['.pdf'],
  dokument: ['.doc', '.docx', '.odt', '.rtf', '.pages', '.ppt', '.pptx', '.key'],
  text: ['.txt', '.md', '.markdown', '.html', '.htm', '.json', '.xml', '.yaml', '.yml'],
  tabuľka: ['.csv', '.tsv', '.xls', '.xlsx', '.numbers', '.ods'],
  zvuk: ['.mp3', '.m4a', '.wav', '.ogg', '.opus', '.aac', '.flac'],
  video: ['.mp4', '.mov', '.mkv', '.webm', '.avi'],
  kontakt: ['.vcf'],
  kalendár: ['.ics'],
}
export const fileType = (name) => {
  const ext = extname(name).toLowerCase()
  return Object.entries(FILE_TYPES).find(([, exts]) => exts.includes(ext))?.[0] ?? null
}

async function sniffHealth(src) {
  const entry = src.find(/(?:^|\/)apple_health_export\/[^/]+\.xml$/i) ?? (src.entries.length <= 12 ? src.find(/(?:^|\/)(export|exportovat|exportovať)\.xml$/i) : null)
  if (!entry) return null
  const head = await src.head(entry.name, 3000).catch(() => '')
  if (!/<HealthData|HKQuantityTypeIdentifier|<!DOCTYPE HealthData/i.test(head) && !/apple_health_export/i.test(entry.name)) return null
  return { source: 'health', confidence: 0.9, details: { file: entry.name, user: null } }
}

/** Sniffers in the order they are tried. The first confident answer wins. */
const SNIFFERS = [meta.sniff, whatsapp.sniff, discord.sniff, telegram.sniff, ai.sniff, music.sniffSpotify, music.sniffApple, takeout.sniff, sniffHealth]

/** What is inside an opened source: { source, confidence, details }. */
export async function fingerprint(src) {
  let best = null
  for (const sniff of SNIFFERS) {
    let hit = null
    try {
      hit = await sniff(src)
    } catch {
      hit = null
    }
    if (!hit) continue
    if (!best || hit.confidence > best.confidence) best = hit
    if (best.confidence >= 0.9) break
  }
  if (best) return best
  if (src.kind === 'file') {
    const type = fileType(src.entries[0].name)
    if (type) return { source: 'file', confidence: 0.6, details: { type, name: src.entries[0].name } }
  }
  return { source: 'unknown', confidence: 0, details: { files: src.entries.length } }
}

function labelOf(det, src) {
  const size = fmtBytes(src.bytes)
  const d = det.details
  const who = d.user ?? d.title ?? null
  const bits = (...xs) => xs.filter(Boolean).join(', ')
  switch (det.source) {
    case 'whatsapp': {
      const n = Math.max(d.threads ?? 1, src.parts)
      return n > 1 ? `WhatsApp, ${plural(n, 'konverzácia', 'konverzácie', 'konverzácií')} (${size})` : `WhatsApp konverzácia (${bits(who, size)})`
    }
    case 'facebook':
      return `${d.format === 'e2ee' ? 'Messenger, záloha šifrovaných četov' : 'Facebook export'} (${bits(who, d.format === 'html' ? 'formát HTML' : d.format === 'media' ? 'len fotky a videá' : null, size)})`
    case 'instagram':
      return `Instagram export (${bits(who, d.format === 'html' ? 'formát HTML' : d.format === 'media' ? 'len fotky a videá' : null, size)})`
    case 'takeout':
      return `Google Takeout (${bits(d.youtube ? 'história YouTube' : d.products?.slice(0, 3).join(', '), size)})`
    case 'health':
      return `Apple Zdravie export (${size})`
    case 'file':
      return `Súbor ${d.name} (${bits(d.type, size)})`
    case 'unknown':
      return `Neznámy obsah: ${basename(src.path)} (${size})`
    default:
      return `${SOURCE_NAME[det.source]} export (${bits(who, size)})`
  }
}

/**
 * Opens a path and recognises it. A folder that only holds the zip parts of one export
 * (Meta and Google split big exports into several zips) is read as one source.
 * Returns { src, det }; the caller closes src.
 */
export async function openAndDetect(paths) {
  const list = Array.isArray(paths) ? paths : [paths]
  let src = await openSource(list)
  let det = await fingerprint(src)
  const kind = src.kind
  if (det.source === 'unknown' && kind === 'dir' && list.length === 1) {
    let zips = []
    try {
      zips = (await readdir(src.path)).filter((f) => /\.zip$/i.test(f) && !f.startsWith('.')).sort()
    } catch {
      zips = []
    }
    if (zips.length && zips.length <= 60) {
      const dir = src.path
      try {
        const combined = await openSource(zips.map((z) => join(dir, z)))
        const inner = await fingerprint(combined)
        if (inner.source !== 'unknown') {
          await src.close()
          src = combined
          det = { ...inner, details: { ...inner.details, parts: zips.length } }
        } else await combined.close()
      } catch {
        // a broken zip in the folder: keep the plain folder answer
      }
    }
  }
  if (src.parts > 1) det.details.parts = src.parts
  return { src, det: { source: det.source, kind, confidence: det.confidence, details: det.details, label: labelOf(det, src) } }
}

export async function detectExport(path) {
  let src = null
  try {
    const opened = await openAndDetect(path)
    src = opened.src
    return opened.det
  } catch {
    return null
  } finally {
    await src?.close().catch(() => {})
  }
}
