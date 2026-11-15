/**
 * One way to read an export, whatever shape the user dropped in: a zip, an unzipped folder,
 * a single file, or several zips of one multi-part export. Entries have POSIX style names
 * relative to the export root. The original files are only ever read.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { isZipFile, openZip } from '../lib/zip.mjs'
import { UserError, decodeText } from './util.mjs'

const MAX_ENTRIES = 600_000
const SKIP = new Set(['.DS_Store', 'Thumbs.db', '__MACOSX', 'desktop.ini'])

async function walkDir(root) {
  const out = []
  const todo = ['']
  while (todo.length && out.length < MAX_ENTRIES) {
    const rel = todo.pop()
    let items
    try {
      items = await readdir(join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const it of items) {
      if (SKIP.has(it.name) || it.name.startsWith('._')) continue
      const name = rel ? `${rel}/${it.name}` : it.name
      if (it.isDirectory()) todo.push(name)
      else if (it.isFile()) out.push(name)
    }
  }
  return out
}

async function openPart(path) {
  const full = resolve(path)
  let info
  try {
    info = await stat(full)
  } catch {
    throw new UserError(`Súbor alebo priečinok neexistuje: ${path}`)
  }
  if (info.isDirectory()) {
    const names = await walkDir(full)
    const entries = []
    for (const name of names) {
      let size = 0
      try {
        size = (await stat(join(full, name))).size
      } catch {
        continue
      }
      entries.push({ name, size })
    }
    return {
      kind: 'dir',
      path: full,
      bytes: entries.reduce((s, e) => s + e.size, 0),
      entries,
      read: (e) => readFile(join(full, e.name)),
      head: (e, n) => headOfFile(join(full, e.name), n),
      stream: (e) => createReadStream(join(full, e.name)),
      extract: async (e, dest) => {
        await mkdir(dirname(dest), { recursive: true })
        await pipeline(createReadStream(join(full, e.name)), createWriteStream(dest))
      },
      close: async () => {},
    }
  }
  if (await isZipFile(full)) {
    const zip = await openZip(full)
    return {
      kind: 'zip',
      path: full,
      bytes: info.size,
      entries: zip.entries.filter((e) => !e.isDir && !e.name.startsWith('__MACOSX/') && !SKIP.has(basename(e.name))),
      read: (e, opts) => zip.read(e, opts),
      head: (e, n) => zip.head(e, n),
      stream: (e) => zip.stream(e),
      extract: (e, dest) => zip.extract(e, dest),
      close: () => zip.close(),
    }
  }
  const entry = { name: basename(full), size: info.size }
  return {
    kind: 'file',
    path: full,
    bytes: info.size,
    entries: [entry],
    read: () => readFile(full),
    head: (_e, n) => headOfFile(full, n),
    stream: () => createReadStream(full),
    extract: async (_e, dest) => {
      await mkdir(dirname(dest), { recursive: true })
      await pipeline(createReadStream(full), createWriteStream(dest))
    },
    close: async () => {},
  }
}

async function headOfFile(path, bytes = 4096) {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/**
 * Opens one path or several (parts of the same export) as a single source.
 *   src.kind        'zip' | 'dir' | 'file' (of the first part)
 *   src.entries     [{ name, size }] over all parts, first part wins on equal names
 *   src.get(name) / src.find(regex) / src.filter(regex)
 *   src.read(name) → Buffer, src.text(name), src.json(name), src.head(name, bytes), src.stream(name)
 *   src.extract(name, dest), src.close()
 */
export async function openSource(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean)
  if (!list.length) throw new UserError('Chýba cesta k exportu.')
  const parts = []
  const temp = []
  const byName = new Map()
  const entries = []

  const addPart = (part) => {
    parts.push(part)
    for (const e of part.entries) {
      if (byName.has(e.name)) continue
      const entry = { name: e.name, size: e.size, part, raw: e }
      byName.set(e.name, entry)
      entries.push(entry)
    }
  }
  try {
    for (const p of list) addPart(await openPart(p))
  } catch (err) {
    for (const p of parts) await p.close()
    throw err
  }

  const need = (name) => {
    const e = typeof name === 'string' ? byName.get(name) : name
    if (!e) throw new Error(`V exporte chýba súbor ${name}`)
    return e
  }
  const src = {
    kind: parts[0].kind,
    path: parts[0].path,
    paths: parts.map((p) => p.path),
    parts: parts.length,
    bytes: parts.reduce((s, p) => s + p.bytes, 0),
    entries,
    get: (name) => byName.get(name) ?? null,
    has: (name) => byName.has(name),
    find: (re) => entries.find((e) => re.test(e.name)) ?? null,
    filter: (re) => entries.filter((e) => re.test(e.name)),
    read: (name, opts) => {
      const e = need(name)
      return e.part.read(e.raw, opts)
    },
    text: async (name) => decodeText(await src.read(name)),
    json: async (name) => JSON.parse(await src.text(name)),
    head: async (name, bytes = 4096) => {
      const e = need(name)
      return decodeText(await e.part.head(e.raw, bytes))
    },
    /** First raw bytes of an entry (to recognise a file type without trusting its name). */
    headBytes: (name, bytes = 16) => {
      const e = need(name)
      return e.part.head(e.raw, bytes)
    },
    stream: (name) => {
      const e = need(name)
      return e.part.stream(e.raw)
    },
    extract: (name, dest) => {
      const e = need(name)
      return e.part.extract(e.raw, dest)
    },
    /** Unpacks a zip that sits inside the export into a temp folder and adds its files. */
    async addNested(name, prefix = '') {
      const dir = await mkdtemp(join(tmpdir(), 'jarvis-import-'))
      temp.push(dir)
      const file = join(dir, 'nested.zip')
      await src.extract(name, file)
      const part = await openPart(file)
      part.entries = part.entries.map((e) => ({ ...e, name: `${prefix}${e.name}`, inner: e }))
      const wrap = (fn) => (e, ...rest) => fn(e.inner, ...rest)
      addPart({ ...part, read: wrap(part.read), head: wrap(part.head), stream: wrap(part.stream), extract: wrap(part.extract) })
    },
    async close() {
      for (const p of parts) await p.close()
      for (const dir of temp) await rm(dir, { recursive: true, force: true }).catch(() => {})
    },
  }
  return src
}
