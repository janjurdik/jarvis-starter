/**
 * Tells apart the two things a person hands over: a copy of their data from some app (an export)
 * and an ordinary file (a document, a picture). It does not try to recognise the app: there is no
 * parser per service, the agent reads the format himself (see generic.mjs).
 *
 *   const det = await detectExport('/path/to/export.zip')
 *   → { source: 'export' | 'file', kind: 'zip'|'dir'|'file', confidence, details: {…}, label } | null
 *
 * `null` means the path does not exist or cannot be read. Only names and sizes are looked at.
 */
import { basename, extname } from 'node:path'
import { openSource } from './source.mjs'
import { fmtBytes } from './util.mjs'

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

/** Formats apps write their data in. A single file like this is an export when it is big or named like one. */
const DATA_EXT = new Set(['.json', '.jsonl', '.ndjson', '.csv', '.tsv', '.xml', '.txt', '.html', '.htm'])
const DATA_NAME = /(^_chat|whatsapp|conversations?|messages?|chat[-_ ]?export|^result\.json$|history|export)/i
const DATA_BYTES = 200 * 1024

function classify(src) {
  if (src.kind !== 'file') return { source: 'export', confidence: 0.8, details: { files: src.entries.length } }
  const name = src.entries[0]?.name ?? basename(src.path)
  const type = fileType(name)
  if (DATA_EXT.has(extname(name).toLowerCase()) && (src.bytes >= DATA_BYTES || DATA_NAME.test(basename(name)))) {
    return { source: 'export', confidence: 0.6, details: { files: 1, type, name } }
  }
  return { source: 'file', confidence: type ? 0.9 : 0.5, details: { type: type ?? 'iné', name } }
}

/** Opens a path (or several parts of one export) and says what it is. Returns { src, det }; the caller closes src. */
export async function openAndDetect(paths) {
  const src = await openSource(Array.isArray(paths) ? paths : [paths])
  const det = classify(src)
  if (src.parts > 1) det.details.parts = src.parts
  const size = fmtBytes(src.bytes)
  const label = det.source === 'file' ? `Súbor ${det.details.name} (${det.details.type}, ${size})` : `Kópia dát: ${basename(src.path)} (${size})`
  return { src, det: { source: det.source, kind: src.kind, confidence: det.confidence, details: det.details, label } }
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
