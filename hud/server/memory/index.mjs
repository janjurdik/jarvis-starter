/**
 * Jarvis memory: a folder of plain markdown notes on the user's own computer.
 *
 *   memory/
 *     ja.md                  who the user is (profile from the onboarding interview)
 *     ludia/<Name>.md        people        frontmatter: vztah, narodeniny
 *     projekty/<Name>.md     projects      frontmatter: stav
 *     ciele/<Name>.md        goals         frontmatter: stav, body with "- [ ]" steps
 *     dennik/YYYY-MM-DD.md   daily log     frontmatter: spanok (hours), nalada (1-5)
 *     poznamky/**            anything else
 *     ulohy.md               to-do list ("- [ ] text (do 2026-12-01)")
 *     kalendar.md            events ("- 2026-12-01 14:00-15:00 Title @ Place")
 *     schranka/              outputs of scheduled routines (briefs, summaries)
 *
 * Any other top-level folder (knihy, filmy, miesta, ...) is indexed as its own collection.
 * The index is rebuilt lazily when files change (cheap mtime scan), no database needed.
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { REPO, isoDay, writeFileAtomic } from '../util.mjs'

export const MEMORY_DIR = resolve(process.env.JARVIS_MEMORY_DIR || join(REPO, 'memory'))

/** Folder names are Slovak on purpose: the user reads and edits this folder by hand. */
export const FOLDERS = { people: 'ludia', projects: 'projekty', goals: 'ciele', days: 'dennik', notes: 'poznamky', inbox: 'schranka' }
export const FILES = { me: 'ja.md', todos: 'ulohy.md', calendar: 'kalendar.md' }

const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules', '.DS_Store'])
const MAX_FILES = 20_000
const MAX_BYTES = 400_000
const RESCAN_MS = 5_000

export const slugify = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

// ── parsing ────────────────────────────────────────────────────────────

/** Small YAML subset: `key: value`, inline lists `[a, b]` and block lists of `- item`. */
export function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { fm: {}, body: text }
  const fm = {}
  let listKey = null
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && listKey) {
      fm[listKey].push(unquote(item[1]))
      continue
    }
    const kv = /^([A-Za-z0-9_\-À-ɏ]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    const raw = kv[2].trim()
    if (raw === '') {
      fm[key] = []
      listKey = key
      continue
    }
    listKey = null
    if (/^\[.*\]$/.test(raw)) fm[key] = raw.slice(1, -1).split(',').map((v) => unquote(v.trim())).filter(Boolean)
    else fm[key] = unquote(raw)
  }
  for (const [k, v] of Object.entries(fm)) if (Array.isArray(v) && v.length === 0) fm[k] = ''
  return { fm, body: text.slice(m[0].length) }
}

const unquote = (v) => String(v).replace(/^(['"])(.*)\1$/, '$2').trim()

/** Markdown to plain text (for previews and search snippets). */
export function plain(md) {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

export const firstParagraph = (body, max = 320) => {
  const text = plain(body)
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, ' ').trim())
    .find((p) => p.length > 20 && !/^- \[.\]/.test(p))
  return text ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : ''
}

/** Lines under a heading that matches `re`, until the next heading of the same or higher level. */
export function section(body, re) {
  const lines = String(body ?? '').split(/\r?\n/)
  const out = []
  let level = 0
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      if (level && h[1].length <= level) break
      if (!level && re.test(h[2])) level = h[1].length
      continue
    }
    if (level) out.push(line)
  }
  return out.join('\n').trim()
}

/** Checkbox items: `- [ ] text` / `- [x] text`. */
export function checkboxes(body) {
  const out = []
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const m = /^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/.exec(line)
    if (m) out.push({ done: m[1] !== ' ', text: m[2].trim() })
  }
  return out
}

const wikiLinks = (body) => [...String(body ?? '').matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map((m) => m[1].trim())

// ── index ──────────────────────────────────────────────────────────────

let index = null
let lastScan = 0
let building = null

async function walk(dir, out) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    // top-level archiv (imported conversations) and prilohy (attachments) are data, not notes
    if (dir === MEMORY_DIR && (e.name === 'archiv' || e.name === 'prilohy')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await walk(full, out)
    else if (e.isFile() && extname(e.name).toLowerCase() === '.md') out.push(full)
  }
}

function kindOf(folder, name, rel) {
  if (rel === FILES.me) return 'me'
  if (rel === FILES.todos || rel === FILES.calendar) return 'system'
  if (folder === FOLDERS.people) return 'person'
  if (folder === FOLDERS.projects) return 'project'
  if (folder === FOLDERS.goals) return 'goal'
  if (folder === FOLDERS.days && /^\d{4}-\d{2}-\d{2}$/.test(name)) return 'day'
  if (folder === FOLDERS.inbox) return 'inbox'
  return 'note'
}

async function build() {
  const files = []
  await walk(MEMORY_DIR, files)
  const prev = index?.byRel ?? new Map()
  const list = []
  for (const full of files) {
    const rel = relative(MEMORY_DIR, full).split(sep).join('/')
    let info
    try {
      info = await stat(full)
    } catch {
      continue
    }
    const old = prev.get(rel)
    if (old && old.mtime === info.mtimeMs && old.size === info.size) {
      list.push(old)
      continue
    }
    if (info.size > MAX_BYTES) continue
    let text
    try {
      text = await readFile(full, 'utf8')
    } catch {
      continue
    }
    const { fm, body } = parseFrontmatter(text)
    const name = basename(rel, '.md')
    const folder = rel.includes('/') ? rel.split('/')[0] : ''
    if (name.toLowerCase() === 'readme') continue
    list.push({
      rel,
      full,
      name,
      folder,
      kind: kindOf(folder, name, rel),
      title: (typeof fm.title === 'string' && fm.title) || (typeof fm.nazov === 'string' && fm.nazov) || name,
      fm,
      body,
      mtime: info.mtimeMs,
      created: info.birthtimeMs || info.mtimeMs,
      size: info.size,
      words: body.split(/\s+/).filter(Boolean).length,
      links: wikiLinks(body),
    })
  }
  const byRel = new Map(list.map((n) => [n.rel, n]))
  const byTitle = new Map()
  for (const n of list) {
    for (const key of [n.title, n.name]) {
      const k = slugify(key)
      if (k && !byTitle.has(k)) byTitle.set(k, n)
    }
  }
  const backlinks = new Map()
  for (const n of list) {
    for (const l of n.links) {
      const target = byTitle.get(slugify(l))
      if (!target || target === n) continue
      if (!backlinks.has(target.rel)) backlinks.set(target.rel, new Set())
      backlinks.get(target.rel).add(n.rel)
    }
  }
  index = { list, byRel, byTitle, backlinks, builtAt: Date.now() }
  return index
}

/** Current index. Rescans the folder at most every few seconds. */
export async function getIndex({ force = false } = {}) {
  if (index && !force && Date.now() - lastScan < RESCAN_MS) return index
  if (!building) {
    building = build().finally(() => {
      lastScan = Date.now()
      building = null
    })
  }
  return building
}

export const ofKind = (ix, kind) => ix.list.filter((n) => n.kind === kind)
export const inFolder = (ix, folder) => ix.list.filter((n) => n.folder === folder)
export const findNote = (ix, ref) => ix.byRel.get(String(ref ?? '').replace(/^\/+/, '')) ?? ix.byRel.get(`${ref}.md`) ?? ix.byTitle.get(slugify(String(ref ?? '').replace(/\.md$/i, ''))) ?? null

// ── domain helpers ─────────────────────────────────────────────────────

const STATUS = [
  [/^(akt|active|bez|prebieha|rozprac)/i, 'active'],
  [/^(poz|paus|stoj|odlo)/i, 'paused'],
  [/^(hot|done|dokon|spln)/i, 'done'],
  [/^(nap|idea|pl[aá]n)/i, 'idea'],
  [/^(zru|cancel)/i, 'cancelled'],
]
export const STATUS_LABEL = { active: 'aktívny', paused: 'pozastavený', done: 'hotový', idea: 'nápad', cancelled: 'zrušený' }
export function statusOf(n) {
  const raw = String(n.fm.stav ?? n.fm.status ?? '').trim()
  return STATUS.find(([re]) => re.test(raw))?.[1] ?? 'active'
}

export function goals(ix) {
  return ofKind(ix, 'goal').map((n) => {
    const steps = checkboxes(n.body)
    return {
      rel: n.rel,
      name: n.title,
      status: statusOf(n),
      stepsDone: steps.filter((s) => s.done).length,
      stepsTotal: steps.length,
      nextStep: steps.find((s) => !s.done)?.text ?? null,
      goal: firstParagraph(n.body, 200),
      mtime: n.mtime,
    }
  })
}

const DUE = /(?:\(?\s*(?:do|termín|due|📅)\s*:?\s*(\d{4}-\d{2}-\d{2})\s*\)?)/i

/** Open and done items of ulohy.md, with an optional due date and the heading they sit under. */
export async function todos() {
  let text = ''
  try {
    text = await readFile(join(MEMORY_DIR, FILES.todos), 'utf8')
  } catch {
    return []
  }
  const out = []
  let group = null
  for (const line of text.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (h) {
      group = h[1].trim()
      continue
    }
    const m = /^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/.exec(line)
    if (!m) continue
    const due = DUE.exec(m[2])?.[1] ?? null
    out.push({ done: m[1] !== ' ', text: m[2].replace(DUE, '').replace(/\s+/g, ' ').trim(), due, group })
  }
  return out
}

/** Sleep and mood per day from the daily log frontmatter. Sleep accepts 7.5, "7,5", "7:30" or "7h 30m". */
export function parseSleepMinutes(value) {
  if (value === undefined || value === null || value === '') return null
  const s = String(value).trim().toLowerCase()
  let m = /^(\d{1,2})[:h]\s*(\d{1,2})?\s*m?(?:in)?\.?$/.exec(s.replace(/\s+/g, ''))
  if (m) return Number(m[1]) * 60 + Number(m[2] ?? 0)
  m = /^(\d{1,2}(?:[.,]\d+)?)\s*(h|hod|hodin|hodín|hodiny)?$/.exec(s)
  if (m) {
    const h = Number(m[1].replace(',', '.'))
    return h > 0 && h <= 24 ? Math.round(h * 60) : null
  }
  return null
}

export function dayStats(ix, { since = null } = {}) {
  return ofKind(ix, 'day')
    .filter((n) => !since || n.name >= since)
    .map((n) => {
      const sleepMin = parseSleepMinutes(n.fm.spanok ?? n.fm['spánok'] ?? n.fm.sleep)
      const mood = Number(String(n.fm.nalada ?? n.fm['nálada'] ?? n.fm.mood ?? '').replace(',', '.'))
      return { day: n.name, sleepMin, mood: Number.isFinite(mood) && mood > 0 ? mood : null, words: n.words }
    })
    .sort((a, b) => a.day.localeCompare(b.day))
}

/** Sleep goal is 8 hours: the HUD ring shows how much of it was reached. */
export const sleepScore = (min) => (Number.isFinite(min) ? Math.round(Math.min(1, min / 480) * 100) : null)

export function stats(ix) {
  const count = (kind) => ofKind(ix, kind).length
  const folders = {}
  for (const n of ix.list) if (n.folder) folders[n.folder] = (folders[n.folder] ?? 0) + 1
  const real = ix.list.filter((n) => n.kind !== 'inbox' && n.kind !== 'system')
  const oldest = real.reduce((min, n) => Math.min(min, n.created), Infinity)
  return {
    notes: real.length,
    words: real.reduce((s, n) => s + n.words, 0),
    people: count('person'),
    projects: count('project'),
    goals: count('goal'),
    days: count('day'),
    other: real.filter((n) => n.kind === 'note').length,
    since: Number.isFinite(oldest) ? isoDay(new Date(oldest)) : null,
    folders,
  }
}

/** Plain-text search over titles and bodies, best matches first. */
export function search(ix, query, { limit = 8 } = {}) {
  const words = slugify(query).split('-').filter((w) => w.length > 1)
  if (!words.length) return []
  const hits = []
  for (const n of ix.list) {
    const title = slugify(n.title)
    const text = n._flat ?? (n._flat = slugify(n.body).replace(/-/g, ' '))
    let score = 0
    for (const w of words) {
      if (title.includes(w)) score += 6
      const at = text.indexOf(w)
      if (at >= 0) score += 1 + Math.min(3, text.split(w).length - 2)
    }
    if (score <= 0) continue
    const body = plain(n.body).replace(/\s+/g, ' ')
    const pos = Math.max(0, body.toLowerCase().indexOf(String(query).toLowerCase().split(/\s+/)[0]))
    hits.push({ rel: n.rel, title: n.title, kind: n.kind, score, snippet: body.slice(Math.max(0, pos - 60), pos + 180).trim() })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}

// ── writing ────────────────────────────────────────────────────────────

/** Resolves a relative path inside the memory folder, or throws. */
export function safePath(rel) {
  const clean = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!clean || clean.includes('\0')) throw new Error('chýba cesta k poznámke')
  const full = resolve(MEMORY_DIR, clean.endsWith('.md') ? clean : `${clean}.md`)
  if (full !== MEMORY_DIR && !full.startsWith(MEMORY_DIR + sep)) throw new Error('cesta musí byť vnútri pamäte')
  return full
}

export async function readNoteFile(rel) {
  return readFile(safePath(rel), 'utf8')
}

/** mode: 'append' (default, adds to the end), 'create' (fails if it exists), 'replace'. */
export async function writeNote(rel, content, { mode = 'append' } = {}) {
  const full = safePath(rel)
  await mkdir(dirname(full), { recursive: true })
  const exists = existsSync(full)
  if (mode === 'create' && exists) throw new Error('poznámka už existuje')
  if (mode === 'append' && exists) {
    const old = await readFile(full, 'utf8')
    await writeFileAtomic(full, `${old.replace(/\s+$/, '')}\n${content.replace(/\s+$/, '')}\n`)
  } else {
    await writeFileAtomic(full, `${content.replace(/\s+$/, '')}\n`)
  }
  lastScan = 0
  return relative(MEMORY_DIR, full).split(sep).join('/')
}

/** Adds a line under a heading (creates the heading at the end when missing). */
export async function appendUnder(rel, heading, line) {
  const full = safePath(rel)
  await mkdir(dirname(full), { recursive: true })
  let text = ''
  try {
    text = await readFile(full, 'utf8')
  } catch {
    text = ''
  }
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex((l) => new RegExp(`^#{1,6}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i').test(l))
  if (at < 0) {
    text = `${text.replace(/\s+$/, '')}${text.trim() ? '\n\n' : ''}## ${heading}\n\n${line}\n`
  } else {
    let end = at + 1
    while (end < lines.length && !/^#{1,6}\s+/.test(lines[end])) end++
    while (end > at + 1 && lines[end - 1].trim() === '') end--
    lines.splice(end, 0, line)
    text = lines.join('\n')
  }
  await writeFileAtomic(full, text.endsWith('\n') ? text : `${text}\n`)
  lastScan = 0
}

export async function addTodo(text, due = null) {
  const line = `- [ ] ${String(text).trim()}${due ? ` (do ${due})` : ''}`
  const full = join(MEMORY_DIR, FILES.todos)
  let old = ''
  try {
    old = await readFile(full, 'utf8')
  } catch {
    old = '# Úlohy\n'
  }
  await mkdir(MEMORY_DIR, { recursive: true })
  await writeFileAtomic(full, `${old.replace(/\s+$/, '')}\n${line}\n`)
  return line
}

/** Ticks the first open to-do whose text contains `match`. Returns the item text or null. */
export async function completeTodo(match) {
  const full = join(MEMORY_DIR, FILES.todos)
  let text
  try {
    text = await readFile(full, 'utf8')
  } catch {
    return null
  }
  const want = slugify(match)
  const lines = text.split(/\r?\n/)
  const i = lines.findIndex((l) => /^\s*[-*]\s+\[ \]\s+/.test(l) && slugify(l).includes(want))
  if (i < 0) return null
  lines[i] = lines[i].replace('[ ]', '[x]')
  await writeFile(full, lines.join('\n'))
  return lines[i].replace(/^\s*[-*]\s+\[x\]\s+/, '').trim()
}

/** Today's daily log: appends a line and optionally sets sleep and mood in the frontmatter. */
export async function logDay({ day = isoDay(), text = '', sleepHours = null, mood = null } = {}) {
  const rel = `${FOLDERS.days}/${day}.md`
  const full = safePath(rel)
  await mkdir(dirname(full), { recursive: true })
  let raw = ''
  try {
    raw = await readFile(full, 'utf8')
  } catch {
    raw = ''
  }
  const { fm, body } = parseFrontmatter(raw)
  if (sleepHours !== null && Number.isFinite(Number(sleepHours))) fm.spanok = String(sleepHours)
  if (mood !== null && Number.isFinite(Number(mood))) fm.nalada = String(mood)
  const head = Object.keys(fm).length ? `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n')}\n---\n` : ''
  const nextBody = `${body.replace(/\s+$/, '')}${text.trim() ? `${body.trim() ? '\n' : ''}- ${text.trim()}` : ''}`
  await writeFileAtomic(full, `${head}${nextBody.replace(/^\n+/, '')}\n`)
  lastScan = 0
  return rel
}
