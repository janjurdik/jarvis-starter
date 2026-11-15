/**
 * Writing memory notes from the importer: generated overview notes (music, YouTube, games)
 * and careful edits of person notes that keep everything the user or Jarvis wrote before.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isoDay, writeFileAtomic } from '../../hud/server/util.mjs'
import { MEMORY_DIR } from './util.mjs'

const KEEP = /^## Zapamätané\s*$/m

/** Lines from a `## heading` to the next heading of the same or a higher level. */
export function cutSection(text, heading) {
  const lines = String(text).split('\n')
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`)
  if (start < 0) return { before: text, section: '', after: '' }
  let end = start + 1
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++
  return { before: lines.slice(0, start).join('\n'), section: lines.slice(start, end).join('\n'), after: lines.slice(end).join('\n') }
}

/**
 * Writes a note that the importer owns (it is rebuilt on every import). A `## Zapamätané`
 * section that Jarvis added to the old version is carried over.
 * Returns the path relative to the memory folder.
 */
export async function writeGeneratedNote(rel, frontmatter, body) {
  const full = join(MEMORY_DIR, rel)
  let kept = ''
  try {
    const old = await readFile(full, 'utf8')
    if (KEEP.test(old)) kept = cutSection(old, 'Zapamätané').section.trim()
  } catch {
    // first version of the note
  }
  const fm = Object.entries({ ...frontmatter, aktualizovane: isoDay() })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  await writeFileAtomic(full, `---\n${fm}\n---\n${body.trim()}\n${kept ? `\n${kept}\n` : ''}`)
  return rel
}

/** Splits a note into the raw frontmatter lines and the body, without re-formatting anything. */
export function splitNote(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { lines: [], body: text }
  return { lines: m[1].split(/\r?\n/), body: text.slice(m[0].length) }
}

/**
 * Sets keys in raw frontmatter lines. Other lines stay exactly as they were, a block list
 * under a replaced key is removed, a null value leaves the key alone.
 */
export function setFrontmatter(lines, values) {
  const out = [...lines]
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue
    const text = Array.isArray(value) ? `${key}: [${value.join(', ')}]` : `${key}: ${value}`
    const at = out.findIndex((l) => new RegExp(`^${key}\\s*:`, 'i').test(l))
    if (at < 0) {
      out.push(text)
      continue
    }
    let end = at + 1
    while (end < out.length && /^\s+-\s+/.test(out[end])) end++
    out.splice(at, end - at, text)
  }
  return out
}

export const joinNote = (lines, body) => `${lines.length ? `---\n${lines.join('\n')}\n---\n` : ''}${body.replace(/^\n+/, '')}`
