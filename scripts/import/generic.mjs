// Import of anything, without a parser written in advance.
//
// Jarvis does not ship a parser for every app in the world. When the user hands over a copy of
// their data that the importer does not recognise (or whose format changed), the agent looks at
// it, understands the format and maps it himself:
//
//   inspect <path>          a map of the export: folders, file types and short samples of the
//                           files that most likely hold the content, so the format can be read
//                           off without opening gigabytes
//   ingest <file.jsonl>     loads messages the agent wrote out in one plain shape into the same
//                           archive every other import uses (search, people, digests)
//
// The plain shape, one JSON object per line:
//   { "thread": "id of the conversation", "title": "Jana Nováková", "kind": "dm" | "group",
//     "from": "Jana Nováková", "me": false, "at": "2024-05-01T10:00:00Z", "text": "Ahoj" }
// `me: true` marks the user's own messages. `at` is an ISO time or a unix time in ms or s.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { createInterface } from 'node:readline'
import { buildCandidates, refreshLinked } from './people.mjs'
import { openSource } from './source.mjs'
import { createStore, recordImport } from './store.mjs'
import { ARCHIVE_DIR, CHAT_SOURCES, SOURCE_NAME, UserError, day, fmtInt, plural, readJson, writeJson } from './util.mjs'
import { join } from 'node:path'

const TEXT_EXT = new Set(['.json', '.jsonl', '.csv', '.tsv', '.txt', '.html', '.htm', '.xml', '.md', '.vcf', '.ics', '.ndjson', '.yaml', '.yml', '.log'])
const HINT = /mess|chat|conversation|inbox|thread|dm|direct|history|sms|talk|post|comment|contact|friend|follow|listen|stream|watch|search|activity|note/i
const SAMPLE_BYTES = 1500
const SOURCES_FILE = join(ARCHIVE_DIR, 'sources.json')

/** The outline of a JSON value three levels deep: keys and types, not the content. */
function shape(value, depth = 0) {
  if (Array.isArray(value)) return value.length ? [`${value.length}×`, shape(value[0], depth + 1)] : []
  if (value && typeof value === 'object') {
    if (depth >= 3) return '{…}'
    return Object.fromEntries(Object.entries(value).slice(0, 24).map(([k, v]) => [k, shape(v, depth + 1)]))
  }
  return typeof value === 'string' ? (value.length > 40 ? 'text' : `"${value}"`) : typeof value
}

/** `import.mjs inspect`: what is in the export and what its files look like inside. */
export async function inspectExport(paths, { samples = 12 } = {}) {
  const src = await openSource(paths)
  try {
    const files = src.entries.filter((e) => e.size > 0 && !e.name.endsWith('/'))
    const dirs = new Map()
    for (const e of files) {
      const parts = e.name.split('/')
      const dir = parts.length > 1 ? parts.slice(0, Math.min(3, parts.length - 1)).join('/') : '.'
      const d = dirs.get(dir) ?? { dir, files: 0, bytes: 0, types: {} }
      d.files++
      d.bytes += e.size
      const ext = extname(e.name).toLowerCase() || '(bez prípony)'
      d.types[ext] = (d.types[ext] ?? 0) + 1
      dirs.set(dir, d)
    }
    // Files worth reading: text formats, names that smell like content first, then the biggest.
    // One sample per folder and file type, so a thousand files of one conversation format count once.
    const seen = new Set()
    const picked = []
    const ranked = files
      .filter((e) => TEXT_EXT.has(extname(e.name).toLowerCase()))
      .sort((a, b) => (HINT.test(b.name) ? 1 : 0) - (HINT.test(a.name) ? 1 : 0) || b.size - a.size)
    for (const e of ranked) {
      const key = `${e.name.split('/').slice(0, -1).join('/').replace(/[^/]+_\d+|\d{6,}/g, '*')}|${extname(e.name).toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      picked.push(e)
      if (picked.length >= samples) break
    }
    const out = []
    for (const e of picked) {
      const head = (await src.head(e.name, SAMPLE_BYTES)).replace(/\u0000/g, '')
      const item = { file: e.name, bytes: e.size, head }
      if (/\.json$/i.test(e.name) && e.size < 4_000_000) {
        try {
          item.shape = shape(await src.json(e.name))
        } catch {
          // not valid JSON as a whole: the head has to do
        }
      }
      out.push(item)
    }
    return {
      ok: true,
      kind: src.kind,
      path: src.path,
      files: files.length,
      bytes: src.bytes,
      folders: [...dirs.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 40),
      samples: out,
      next: 'Podľa ukážok zisti formát. Správy vypíš do súboru .jsonl v tvare { thread, title, kind, from, me, at, text } (jeden objekt na riadok) a načítaj: node scripts/import.mjs ingest <súbor.jsonl> --source <id> --name "<Názov appky>". Čo nie sú správy (história počúvania, pozerania, príspevky), zhrň rovno do poznámok v pamäti.',
    }
  } finally {
    await src.close().catch(() => {})
  }
}

const toIso = (at) => {
  if (typeof at === 'number' || /^\d{9,13}$/.test(String(at))) {
    const n = Number(at)
    return new Date(n < 1e11 ? n * 1000 : n).toISOString()
  }
  const d = new Date(String(at ?? ''))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Names of sources the user added themself (id → label), next to the built-in ones. */
export async function customSources() {
  return (await readJson(SOURCES_FILE, {})) ?? {}
}

/** `import.mjs ingest`: messages in the plain shape into the archive. */
export async function ingestMessages(file, { source, name = null } = {}) {
  const id = String(source ?? '').toLowerCase().trim()
  if (!/^[a-z][a-z0-9-]{1,23}$/.test(id) || ['file', 'unknown', 'health', 'steam'].includes(id)) throw new UserError('Zdroj potrebuje krátke id: malé písmená, číslice a pomlčky (napríklad --source viber).')
  try {
    await stat(file)
  } catch {
    throw new UserError(`Súbor ${file} som nenašiel.`)
  }
  const label = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || SOURCE_NAME[id] || id
  const threads = new Map()
  let lines = 0
  let bad = 0
  for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) {
    if (!line.trim()) continue
    lines++
    let m
    try {
      m = JSON.parse(line)
    } catch {
      bad++
      continue
    }
    const t = toIso(m.at ?? m.t ?? m.time ?? m.timestamp)
    const text = String(m.text ?? '').trim()
    const thread = String(m.thread ?? m.title ?? '').trim()
    if (!t || !thread || (!text && !m.photo)) {
      bad++
      continue
    }
    const entry = threads.get(thread) ?? { title: String(m.title ?? thread).trim(), kind: m.kind === 'group' ? 'group' : null, messages: [], people: new Set(), self: null }
    const from = String(m.from ?? '').trim() || (m.me ? 'ja' : entry.title)
    if (m.me === true) entry.self = from
    else entry.people.add(from)
    entry.messages.push({ t, from, me: m.me === true, text })
    threads.set(thread, entry)
  }
  if (!threads.size) throw new UserError(`V súbore nie je ani jedna správa v tvare { thread, from, me, at, text }.${bad ? ` Riadkov, ktorým som nerozumel: ${bad}.` : ''}`)

  // A source the archive has not seen yet gets its name remembered, so search and people know what to call it.
  if (!SOURCE_NAME[id] || name) {
    const all = await customSources()
    all[id] = label
    await writeJson(SOURCES_FILE, all)
    SOURCE_NAME[id] = label
    if (!CHAT_SOURCES.includes(id)) CHAT_SOURCES.push(id)
  }
  const store = await createStore(id, { entries: [], has: () => false, get: () => null })
  for (const [thread, e] of threads) {
    e.messages.sort((a, b) => (a.t < b.t ? -1 : 1))
    const participants = [...new Set(e.messages.map((m) => m.from))]
    await store.put({ id: `t${thread}`, title: e.title, kind: e.kind ?? (e.people.size > 1 ? 'group' : 'dm'), participants, self: e.self }, e.messages)
  }
  const totals = await store.finish()
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  await recordImport({ id: `${id}-${stamp}`, source: id, importedAt: new Date().toISOString(), file, threads: totals.threads, messages: totals.messages, added: totals.added ?? 0, from: totals.from, to: totals.to })
  const digests = await refreshLinked(id)
  const candidates = (await buildCandidates()).total
  return {
    ok: true,
    id: `${id}-${stamp}`,
    source: id,
    name: label,
    threads: totals.threads,
    messages: totals.messages,
    added: totals.added ?? 0,
    from: totals.from,
    to: totals.to,
    skipped: bad,
    lines,
    candidates,
    digests,
    summary: `${label}: ${plural(totals.threads, 'konverzácia', 'konverzácie', 'konverzácií')}, ${plural(totals.messages, 'správa', 'správy', 'správ')} od ${day(totals.from)} do ${day(totals.to)}.${bad ? ` Riadkov, ktoré som preskočil: ${fmtInt(bad)}.` : ''}${candidates ? ` Ľudia na potvrdenie: ${fmtInt(candidates)}.` : ''}`,
  }
}
