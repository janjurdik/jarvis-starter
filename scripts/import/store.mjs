/**
 * The local message archive inside the memory folder:
 *
 *   archiv/index.json                 imports done so far
 *   archiv/identity.json              who is the user, which identity belongs to which person note
 *   archiv/<source>/threads.json      one record per conversation
 *   archiv/<source>/<threadId>.jsonl  one message per line, oldest first
 *   archiv/<source>/media/<threadId>/ a few photos of the other person (avatar candidates)
 *
 * Importing the same conversation again merges into the existing file without duplicates.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { writeFileAtomic } from '../../hud/server/util.mjs'
import { ARCHIVE_DIR, readJson, safeId, shortHash, writeJson } from './util.mjs'

export const INDEX_FILE = join(ARCHIVE_DIR, 'index.json')
export const IDENTITY_FILE = join(ARCHIVE_DIR, 'identity.json')
export const CANDIDATES_FILE = join(ARCHIVE_DIR, 'candidates.json')
export const SKIP = '__skip__'

const MAX_PHOTOS = 12
const MAX_PHOTO_BYTES = 3 * 1024 * 1024
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.gif'])

/** Image type from the first bytes of a file, as an extension, or null. */
function imageExt(b) {
  if (!b || b.length < 12) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg'
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return '.png'
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return '.webp'
  if (b.toString('latin1', 0, 4) === 'GIF8') return '.gif'
  if (b.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|mif1|hevc)/.test(b.toString('latin1', 8, 12))) return '.heic'
  return null
}

export async function loadIdentity() {
  const data = await readJson(IDENTITY_FILE, null)
  return { me: Array.isArray(data?.me) ? data.me.filter((x) => typeof x === 'string' && x) : [], map: data?.map && typeof data.map === 'object' ? data.map : {} }
}
export const saveIdentity = (identity) => writeJson(IDENTITY_FILE, { me: [...new Set(identity.me)], map: identity.map })

export const loadIndex = async () => (await readJson(INDEX_FILE, [])) ?? []
export const loadThreads = async (source) => (await readJson(join(ARCHIVE_DIR, source, 'threads.json'), [])) ?? []

/** Sources that have a threads.json in the archive. */
export async function archivedSources() {
  let dirs = []
  try {
    dirs = await readdir(ARCHIVE_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  return dirs.filter((d) => d.isDirectory() && existsSync(join(ARCHIVE_DIR, d.name, 'threads.json'))).map((d) => d.name)
}

/** Messages of one thread file, oldest first. Broken lines are skipped. */
export async function readThread(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // a half-written line from an interrupted run
    }
  }
  return out
}

/** Fixed key order: the search reads these lines without parsing them. */
export function serialize(m) {
  const rec = { t: m.t, from: m.from ?? '', me: Boolean(m.me), text: m.text ?? '', type: m.type ?? 'text' }
  if (m.media?.length) rec.media = m.media
  if (m.reactions?.length) rec.reactions = m.reactions
  return JSON.stringify(rec)
}

/** Dedupe keys of a list: time + sender + text, with a counter for real repeats ("ok", "ok"). */
function keysOf(list) {
  const seen = new Map()
  return list.map((m) => {
    const base = `${m.t}|${m.from}|${m.text}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}#${n}`
  })
}

/**
 * Writer for one source. `put(meta, messages)` merges a conversation, `finish()` saves the
 * thread list. meta: { id, title, kind, participants, self }. A message may carry `photo`
 * (entry name inside the export): a few of those are copied out as avatar candidates.
 */
export async function createStore(source, src) {
  const dir = join(ARCHIVE_DIR, source)
  await mkdir(dir, { recursive: true })
  const byId = new Map((await loadThreads(source)).map((t) => [t.id, t]))
  const pendingFile = join(dir, 'pending-media.json')
  const pending = (await readJson(pendingFile, {})) ?? {}
  const stats = { threads: 0, messages: 0, added: 0, from: null, to: null, people: new Set(), touched: new Set(), photos: 0 }
  let tails = null

  /** Finds an entry by its last three path segments (photos of multi-part exports). */
  const byTail = (uri) => {
    if (!tails) {
      tails = new Map()
      for (const e of src.entries) tails.set(e.name.split('/').slice(-3).join('/'), e.name)
    }
    return tails.get(String(uri).split('/').slice(-3).join('/')) ?? null
  }

  async function copyPhoto(id, entryName) {
    const entry = src.get(entryName)
    if (!entry || entry.size > MAX_PHOTO_BYTES || entry.size < 512) return null
    let ext = extname(entryName).toLowerCase()
    if (!IMAGE_EXT.has(ext)) {
      // Meta often stores photos without any extension: the first bytes tell what it is
      if (ext) return null
      ext = imageExt(await src.headBytes(entry.name, 16))
      if (!ext) return null
    }
    const name = `${safeId(basename(entryName, extname(entryName))).slice(0, 60) || shortHash(entryName)}${ext}`
    const dest = join(dir, 'media', id, name)
    if (!existsSync(dest)) await src.extract(entry.name, dest)
    return `${source}/media/${id}/${name}`
  }

  async function put(meta, messages) {
    const id = safeId(meta.id)
    const list = messages.filter((m) => m && m.t)
    if (!list.length) return null
    // one spelling of every name and text (macOS and iPhone like decomposed accents)
    const nfc = (v) => (typeof v === 'string' ? v.normalize('NFC') : v)
    meta = { ...meta, title: nfc(meta.title), self: nfc(meta.self), participants: (meta.participants ?? []).map(nfc) }
    for (const m of list) {
      m.from = nfc(m.from ?? '')
      m.text = nfc(m.text ?? '')
    }
    const file = join(dir, `${id}.jsonl`)
    const old = existsSync(file) ? await readThread(file) : []

    // avatar candidates: newest photos sent by the other person in a private chat
    if (meta.kind === 'dm') {
      const want = list.filter((m) => m.photo && !m.me).sort((a, b) => (a.t < b.t ? 1 : -1))
      let got = 0
      let tried = 0
      for (const m of want) {
        if (got >= MAX_PHOTOS || tried >= 40) break
        tried++
        const name = src.has(m.photo) ? m.photo : byTail(m.photo)
        if (!name) {
          // Meta splits big exports: the file may live in another part, remember it for a later run
          if (source !== 'instagram' && source !== 'facebook') continue
          const queue = (pending[id] ??= [])
          if (queue.length < MAX_PHOTOS && !queue.some((q) => q.uri === m.photo)) queue.push({ uri: m.photo, t: m.t, from: m.from })
          continue
        }
        const rel = await copyPhoto(id, name).catch(() => null)
        if (rel) {
          m.media = [rel]
          got++
        }
      }
    }

    const map = new Map()
    const oldKeys = keysOf(old)
    old.forEach((m, i) => map.set(oldKeys[i], m))
    const newKeys = keysOf(list)
    let added = 0
    list.forEach((m, i) => {
      const had = map.get(newKeys[i])
      if (had) {
        if (m.media && !had.media) had.media = m.media
        if (meta.self) had.me = Boolean(m.me)
        if (m.reactions?.length) had.reactions = m.reactions
      } else {
        map.set(newKeys[i], m)
        if (m.type !== 'system') added++
      }
    })
    const all = [...map.values()].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))

    // photos sent by the other side that were waiting for their part of the export
    if (pending[id]?.length) {
      const rest = []
      for (const q of pending[id]) {
        const name = src.has(q.uri) ? q.uri : byTail(q.uri)
        const rel = name ? await copyPhoto(id, name).catch(() => null) : null
        const target = rel ? all.find((m) => m.t === q.t && m.from === q.from && m.type === 'photo' && !m.media) : null
        if (target) target.media = [rel]
        else if (!name) rest.push(q)
      }
      if (rest.length) pending[id] = rest
      else delete pending[id]
    }

    // keep only the newest few copies
    const withMedia = all.filter((m) => m.media?.length)
    for (const m of withMedia.slice(0, Math.max(0, withMedia.length - MAX_PHOTOS))) {
      for (const rel of m.media) await unlink(join(ARCHIVE_DIR, rel)).catch(() => {})
      delete m.media
    }

    await writeFileAtomic(file, `${all.map(serialize).join('\n')}\n`)

    const real = all.filter((m) => m.type !== 'system')
    const by = {}
    for (const m of real) if (m.from) by[m.from] = (by[m.from] ?? 0) + 1
    const names = [...new Set([...(meta.participants ?? []), ...Object.keys(by)].filter(Boolean))]
    const prev = byId.get(id)
    const record = {
      id,
      title: meta.title || prev?.title || names.filter((n) => n !== meta.self).join(', ') || id,
      kind: meta.kind ?? prev?.kind ?? 'dm',
      participants: names.slice(0, 200),
      count: real.length,
      mine: real.filter((m) => m.me).length,
      first: (real[0] ?? all[0]).t,
      last: (real[real.length - 1] ?? all[all.length - 1]).t,
      file: `${source}/${id}.jsonl`,
      photos: all.filter((m) => m.media?.length).length,
      self: meta.self ?? prev?.self ?? null,
      by: Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 200)),
    }
    byId.set(id, record)
    stats.touched.add(id)
    stats.threads++
    stats.messages += list.filter((m) => m.type !== 'system').length
    stats.added += added
    if (!stats.from || record.first < stats.from) stats.from = record.first
    if (!stats.to || record.last > stats.to) stats.to = record.last
    for (const n of names) if (n !== record.self) stats.people.add(n)
    return record
  }

  /** Photos that waited for another part of the export and can be copied from this one. */
  async function resolvePending() {
    for (const id of Object.keys(pending)) {
      if (stats.touched.has(id) || !byId.has(id)) continue
      if (!pending[id].some((q) => src.has(q.uri) || byTail(q.uri))) continue
      const file = join(dir, `${id}.jsonl`)
      const all = await readThread(file)
      const rest = []
      let changed = false
      for (const q of pending[id]) {
        const name = src.has(q.uri) ? q.uri : byTail(q.uri)
        const rel = name ? await copyPhoto(id, name).catch(() => null) : null
        const target = rel ? all.find((m) => m.t === q.t && m.from === q.from && m.type === 'photo' && !m.media) : null
        if (target) {
          target.media = [rel]
          changed = true
          stats.photos++
        } else if (!name) rest.push(q)
      }
      if (rest.length) pending[id] = rest
      else delete pending[id]
      if (changed) {
        await writeFileAtomic(file, `${all.map(serialize).join('\n')}\n`)
        const rec = byId.get(id)
        rec.photos = all.filter((m) => m.media?.length).length
      }
    }
  }

  async function finish() {
    await resolvePending()
    const threads = [...byId.values()].sort((a, b) => (a.last < b.last ? 1 : -1))
    await writeJson(join(dir, 'threads.json'), threads)
    if (Object.keys(pending).length) await writeJson(pendingFile, pending)
    else await unlink(pendingFile).catch(() => {})
    return { threads: stats.threads, messages: stats.messages, added: stats.added, from: stats.from, to: stats.to, people: stats.people.size, totalThreads: threads.length, photos: stats.photos }
  }

  return { dir, put, finish, stats, has: (id) => byId.has(safeId(id)) }
}

/** Adds one line to archiv/index.json. */
export async function recordImport(entry) {
  const index = await loadIndex()
  index.push(entry)
  await writeJson(INDEX_FILE, index)
  return index
}
