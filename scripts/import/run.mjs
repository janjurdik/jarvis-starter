/**
 * One import from start to end: recognise the export, parse it into the archive, remember
 * who the user is, refresh people that are already linked and count the new candidates.
 */
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { fileType, openAndDetect } from './detect.mjs'
import * as ai from './parsers/ai.mjs'
import * as discord from './parsers/discord.mjs'
import * as meta from './parsers/meta.mjs'
import * as music from './parsers/music.mjs'
import * as takeout from './parsers/takeout.mjs'
import * as telegram from './parsers/telegram.mjs'
import * as whatsapp from './parsers/whatsapp.mjs'
import { buildCandidates, refreshLinked } from './people.mjs'
import { createStore, loadIdentity, loadIndex, loadThreads, recordImport, saveIdentity, archivedSources } from './store.mjs'
import { ARCHIVE_DIR, CHAT_SOURCES, MEMORY_DIR, SOURCE_NAME, UserError, day, fmtInt, plural, progressReporter, safeFileName } from './util.mjs'

const PARSERS = {
  instagram: { run: meta.run, sniff: meta.sniff },
  facebook: { run: meta.run, sniff: meta.sniff },
  whatsapp: { run: whatsapp.run, sniff: whatsapp.sniff },
  discord: { run: discord.run, sniff: discord.sniff },
  telegram: { run: telegram.run, sniff: telegram.sniff },
  chatgpt: { run: ai.run, sniff: ai.sniff },
  claude: { run: ai.run, sniff: ai.sniff },
  spotify: { run: music.runSpotify, sniff: music.sniffSpotify },
  applemusic: { run: music.runApple, sniff: music.sniffApple },
  takeout: { run: takeout.run, sniff: takeout.sniff },
}

const stampId = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

/**
 * Copies an ordinary file into memory/prilohy/<YYYY-MM>/ (never overwrites).
 * → { ok, path, rel, type, sizeKB }
 */
export async function importFile(path) {
  const full = resolve(String(path ?? ''))
  let info
  try {
    info = await stat(full)
  } catch {
    throw new UserError(`Súbor neexistuje: ${path}`)
  }
  if (!info.isFile()) throw new UserError('Toto nie je súbor. Priečinok s exportom načítaj príkazom run.')
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const dir = join(MEMORY_DIR, 'prilohy', month)
  await mkdir(dir, { recursive: true })
  const ext = extname(full)
  const stem = safeFileName(basename(full, ext)) || 'subor'
  let name = `${stem}${ext}`
  for (let i = 2; existsSync(join(dir, name)); i++) name = `${stem}-${i}${ext}`
  await copyFile(full, join(dir, name))
  return { ok: true, path: join(dir, name), rel: `prilohy/${month}/${name}`, type: fileType(name) ?? 'iné', sizeKB: Math.max(1, Math.round(info.size / 1024)) }
}

async function runOne(paths, { source = null, me = null, emit = null } = {}) {
  const progress = progressReporter(emit)
  progress(0, 'Otváram export')
  const { src, det } = await openAndDetect(paths)
  try {
    if (source === 'file' && src.kind === 'file') det.source = 'file'
    else if (source && source !== det.source && source !== 'unknown') {
      const parser = PARSERS[source]
      if (!parser) throw new UserError(`Zdroj „${source}" nepoznám. Poznám: ${Object.keys(PARSERS).join(', ')}.`)
      const forced = await parser.sniff(src)
      if (!forced || (forced.source !== source && !(forced.source in PARSERS && PARSERS[forced.source].run === parser.run))) {
        throw new UserError(`Tento súbor nevyzerá ako export zo služby ${SOURCE_NAME[source] ?? source}.`)
      }
      det.source = source
      det.details = forced.details
    }
    // several WhatsApp zips in one folder are separate conversations, not parts of one export
    if (det.source === 'whatsapp' && src.parts > 1) {
      const parts = src.paths
      await src.close()
      const results = []
      let n = 0
      for (const p of parts) {
        progress(n++ / parts.length, `Čítam konverzácie (${n} z ${parts.length})`)
        results.push(await runOne(p, { source: 'whatsapp', me, emit: null }))
      }
      // a later chat may have revealed who the user is: read the undecided ones once more
      const known = results.find((r) => r.me)?.me
      if (known) {
        for (let i = 0; i < parts.length; i++) {
          if (!results[i].me) results[i] = { ...(await runOne(parts[i], { source: 'whatsapp', me: known, emit: null })), added: results[i].added }
        }
      }
      progress(1, 'Hotovo')
      const first = results[0]
      const froms = results.map((r) => r.from).filter(Boolean).sort()
      const tos = results.map((r) => r.to).filter(Boolean).sort()
      const threads = results.reduce((s, r) => s + r.threads, 0)
      const messages = results.reduce((s, r) => s + r.messages, 0)
      return {
        ...first,
        threads,
        messages,
        from: froms[0] ?? null,
        to: tos[tos.length - 1] ?? null,
        me: results.find((r) => r.me)?.me ?? null,
        candidates: results[results.length - 1].candidates,
        added: results.reduce((s, r) => s + (r.added ?? 0), 0),
        people: results.reduce((s, r) => s + (r.people ?? 0), 0),
        notes: [],
        digests: [...new Set(results.flatMap((r) => r.digests ?? []))],
        summary: `WhatsApp: ${plural(threads, 'konverzácia', 'konverzácie', 'konverzácií')}, ${plural(messages, 'správa', 'správy', 'správ')}.`,
        warnings: [...new Set(results.flatMap((r) => r.warnings))],
      }
    }
    if (det.source === 'file') {
      const res = await importFile(src.path)
      return { ok: true, id: `file-${stampId()}`, source: 'file', threads: 0, messages: 0, people: 0, from: null, to: null, me: null, archiveDir: ARCHIVE_DIR, candidates: 0, summary: `Súbor ${basename(res.path)} som uložil do príloh.`, notes: [res.rel], warnings: [], path: res.path, rel: res.rel, type: res.type, sizeKB: res.sizeKB }
    }
    if (det.source === 'health') throw new UserError('Export z Apple Zdravia zatiaľ neviem načítať. Spánok a náladu môžeš Jarvisovi povedať priamo, zapíše si ich do denníka.')
    const parser = PARSERS[det.source]
    if (!parser) throw new UserError('Tento súbor alebo priečinok nepoznám. Viem načítať exporty z Instagramu, Facebooku a Messengera, WhatsAppu, Discordu, Telegramu, ChatGPT, Claude, Spotify, Apple Music a Google Takeout (história YouTube).')

    const identity = await loadIdentity()
    const isChat = CHAT_SOURCES.includes(det.source)
    const store = isChat ? await createStore(det.source, src) : null
    const warnings = []
    const notes = []
    const digests = []
    const ctx = {
      src,
      det,
      identity,
      options: { me: me || null },
      progress,
      warn: (text) => {
        if (text && !warnings.includes(text) && warnings.length < 40) warnings.push(text)
      },
      note: (rel) => notes.push(rel),
      digest: (path) => digests.push(path),
      put: (m, messages) => store.put(m, messages),
    }
    let out
    try {
      out = (await parser.run(ctx)) ?? {}
    } catch (err) {
      // keep the list of threads in step with the files that were already written
      if (store?.stats.threads) await store.finish().catch(() => {})
      throw err
    }
    progress(0.96, 'Ukladám')
    const totals = store ? await store.finish() : { threads: 0, messages: 0, added: 0, from: null, to: null, people: 0, ...(out.stats ?? {}) }
    if (out.mediaOnly) {
      progress(1, 'Hotovo')
      const text = totals.photos
        ? `Táto časť exportu obsahuje len fotky a videá. Doplnil som z nej ${plural(totals.photos, 'fotku', 'fotky', 'fotiek')} k načítaným konverzáciám.`
        : 'Táto časť exportu obsahuje len fotky a videá, žiadne správy. Pretiahni sem aj časť so správami (alebo celý priečinok so všetkými časťami naraz).'
      return { ok: true, id: `${det.source}-${stampId()}`, source: det.source, threads: 0, messages: 0, people: 0, from: null, to: null, me: null, archiveDir: ARCHIVE_DIR, candidates: (await buildCandidates()).total, summary: text, notes: [], warnings, added: 0, digests: [] }
    }
    if (isChat && !totals.threads) throw new UserError('V exporte som nenašiel žiadne správy.')

    // names the user goes by, for the next imports
    let changed = false
    for (const name of [out.me, out.handle, out.name]) {
      if (name && name !== 'ja' && !identity.me.includes(name)) {
        identity.me.push(name)
        changed = true
      }
    }
    if (changed) await saveIdentity(identity)

    let id = `${det.source}-${stampId()}`
    const taken = new Set((await loadIndex()).map((e) => e.id))
    for (let n = 2; taken.has(id); n++) id = `${det.source}-${stampId()}-${n}`
    await recordImport({ id, source: det.source, importedAt: new Date().toISOString(), file: src.paths.length > 1 ? src.paths : src.path, threads: totals.threads, messages: totals.messages, added: totals.added ?? 0, from: totals.from, to: totals.to })

    let candidates = 0
    if (isChat && det.source !== 'chatgpt' && det.source !== 'claude') {
      progress(0.98, 'Hľadám ľudí v konverzáciách')
      digests.push(...(await refreshLinked(det.source)))
      candidates = (await buildCandidates()).total
    }
    const label = SOURCE_NAME[det.source]
    const summary =
      out.summary ??
      `${label}: ${plural(totals.threads, 'konverzácia', 'konverzácie', 'konverzácií')}, ${plural(totals.messages, 'správa', 'správy', 'správ')} od ${day(totals.from)} do ${day(totals.to)}.` +
        (totals.added !== totals.messages ? ` Nových od minula: ${fmtInt(totals.added)}.` : '') +
        (candidates ? ` Ľudia na potvrdenie: ${fmtInt(candidates)}.` : '')
    progress(1, 'Hotovo')
    return {
      ok: true,
      id,
      source: det.source,
      threads: totals.threads,
      messages: totals.messages,
      people: det.source === 'chatgpt' || det.source === 'claude' ? 0 : (totals.people ?? 0),
      from: totals.from,
      to: totals.to,
      me: out.me ?? null,
      archiveDir: ARCHIVE_DIR,
      candidates,
      summary,
      notes,
      warnings,
      added: totals.added ?? 0,
      digests,
    }
  } finally {
    await src.close().catch(() => {})
  }
}

/** `import.mjs run`: one path, or several parts of the same export. */
export const runImport = (paths, options) => runOne(paths, options)

/** `import.mjs list`: imports so far and what the archive holds per source. */
export async function listImports() {
  const imports = await loadIndex()
  const sources = []
  for (const source of await archivedSources()) {
    const threads = await loadThreads(source)
    if (!threads.length) continue
    const firsts = threads.map((t) => t.first).sort()
    const lasts = threads.map((t) => t.last).sort()
    sources.push({ source, name: SOURCE_NAME[source] ?? source, threads: threads.length, messages: threads.reduce((s, t) => s + t.count, 0), from: firsts[0], to: lasts[lasts.length - 1] })
  }
  return {
    ok: true,
    imports,
    sources,
    totals: { threads: sources.reduce((s, x) => s + x.threads, 0), messages: sources.reduce((s, x) => s + x.messages, 0) },
    archiveDir: ARCHIVE_DIR,
  }
}
