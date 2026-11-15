/**
 * Unpacks a .tar.gz with Node alone. Used when the system `tar` is missing or fails, so an update
 * never depends on which tar a computer happens to have. Regular files only: links and devices
 * are skipped, and nothing can be written outside the target folder.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { safeRel } from './core.mjs'

const text = (buf, from, len) => {
  const slice = buf.subarray(from, from + len)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? len : end).toString('utf8')
}
const octal = (buf, from, len) => parseInt(text(buf, from, len).trim() || '0', 8) || 0

/** Reads "path" out of a pax extended header ("27 path=some/long/name\n"). */
function paxPath(data) {
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(32, at)
    if (space === -1) break
    const len = Number(data.subarray(at, space).toString('utf8'))
    if (!len) break
    const record = data.subarray(space + 1, at + len - 1).toString('utf8')
    if (record.startsWith('path=')) return record.slice(5)
    at += len
  }
  return null
}

/** Unpacks `file` into `dest`, dropping the first `strip` folders of every path. Returns the number of files. */
export function extractTarGz(file, dest, { strip = 1 } = {}) {
  const tar = gunzipSync(readFileSync(file))
  let at = 0
  let count = 0
  let longName = null
  while (at + 512 <= tar.length) {
    const head = tar.subarray(at, at + 512)
    if (head.every((b) => b === 0)) break
    const size = octal(head, 124, 12)
    const type = String.fromCharCode(head[156] || 48)
    const data = tar.subarray(at + 512, at + 512 + size)
    at += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') {
      longName = paxPath(data) ?? longName
      continue
    }
    if (type === 'L') {
      longName = text(data, 0, data.length)
      continue
    }
    if (type === 'g') continue
    const prefix = text(head, 345, 155)
    const name = longName ?? (prefix ? `${prefix}/${text(head, 0, 100)}` : text(head, 0, 100))
    longName = null
    if (type !== '0') continue
    const rel = name.split('/').filter(Boolean).slice(strip).join('/')
    if (!safeRel(rel)) continue
    const target = join(dest, ...rel.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    if (octal(head, 100, 8) & 0o111) {
      try {
        chmodSync(target, 0o755)
      } catch {
        // file systems without permissions (FAT, some Windows setups)
      }
    }
    count++
  }
  return count
}
