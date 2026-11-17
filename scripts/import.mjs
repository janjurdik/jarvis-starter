#!/usr/bin/env node
/**
 * Importer of data exports into Jarvis's memory. Everything stays on this computer.
 *
 *   node scripts/import.mjs detect <path> [--json]
 *   node scripts/import.mjs inspect <path> [--json]        a map of an export nobody wrote a parser for
 *   node scripts/import.mjs ingest <file.jsonl> --source <id> [--name "App"] [--json]
 *   node scripts/import.mjs run <path> [<more parts>] [--source x] [--me "Full Name"] [--progress] [--json]
 *   node scripts/import.mjs people [--all] [--json]
 *   node scripts/import.mjs apply <decisions.json> [--json]
 *   node scripts/import.mjs list [--json]
 *   node scripts/import.mjs search "<query>" [--person "Name"] [--source x] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit 20] [--json]
 *   node scripts/import.mjs thread <source> <threadId> [--around ISO] [--limit 80] [--json]
 *   node scripts/import.mjs steam [--dir <Steam folder>] [--json]
 *   node scripts/import.mjs file <path> [--json]
 *
 * A few common exports are read directly (Instagram, Facebook / Messenger, WhatsApp, Discord,
 * Telegram, ChatGPT, Claude, Spotify, Apple Music, Google Takeout). Anything else, and any of
 * those whose format changed, goes the general way: `inspect` shows the agent what the export
 * looks like, he maps it and loads it with `ingest`. The original is only read, never changed.
 */
import './lib.mjs'
import { readFile } from 'node:fs/promises'
import { openAndDetect } from './import/detect.mjs'
import { ingestMessages, inspectExport } from './import/generic.mjs'
import { applyDecisions, buildCandidates } from './import/people.mjs'
import { importFile, listImports, runImport } from './import/run.mjs'
import { formatHits, search, thread } from './import/search.mjs'
import { importSteam } from './import/steam.mjs'
import { SOURCE_NAME, UserError, day, fmtInt, localStamp, oneLine, plural } from './import/util.mjs'

const VALUE_FLAGS = new Set(['source', 'me', 'person', 'from', 'to', 'limit', 'around', 'dir', 'name'])

function parse(argv) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      rest.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const name = (eq > 0 ? a.slice(2, eq) : a.slice(2)).toLowerCase()
    if (eq > 0) flags[name] = a.slice(eq + 1)
    else if (VALUE_FLAGS.has(name) && i + 1 < argv.length) flags[name] = argv[++i]
    else flags[name] = true
  }
  return { flags, rest }
}

const { flags, rest } = parse(process.argv.slice(2))
const [command, ...args] = rest
const json = Boolean(flags.json)
const print = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)

const HELP = `Import údajov do pamäte Jarvisa

  node scripts/import.mjs detect <cesta>          zistí, čo je to za export
  node scripts/import.mjs run <cesta>             načíta export do archívu (voľby: --source, --me "Meno", --progress)
  node scripts/import.mjs inspect <cesta>         ukáže, čo v exporte je a ako vyzerajú jeho súbory (pre neznámy formát)
  node scripts/import.mjs ingest <súbor.jsonl> --source <id> [--name "Appka"]   načíta správy v jednotnom tvare
  node scripts/import.mjs people                  ľudia z konverzácií, ktorí čakajú na potvrdenie (--all aj tí s pár správami)
  node scripts/import.mjs apply <rozhodnutia.json> zapíše potvrdených ľudí do pamäte
  node scripts/import.mjs list                    čo je už načítané
  node scripts/import.mjs search "<text>"         hľadá v správach (voľby: --person, --source, --from, --to, --limit)
  node scripts/import.mjs thread <zdroj> <id>     ukáže jednu konverzáciu (voľby: --around, --limit)
  node scripts/import.mjs steam                   načíta hry zo Steamu na tomto počítači
  node scripts/import.mjs file <cesta>            uloží obyčajný súbor do príloh

Pridaj --json a dostaneš výsledok ako JSON. Všetko ostáva na tomto počítači.`

async function main() {
  switch (command) {
    case 'detect': {
      if (!args[0]) throw new UserError('Chýba cesta k súboru alebo priečinku.')
      const { src, det } = await openAndDetect(args[0])
      await src.close()
      return { ok: true, ...det }
    }
    case 'run': {
      if (!args[0]) throw new UserError('Chýba cesta k exportu.')
      const emit = flags.progress ? print : null
      return runImport(args.length > 1 ? args : args[0], { source: typeof flags.source === 'string' ? flags.source.toLowerCase() : null, me: typeof flags.me === 'string' ? flags.me : null, emit })
    }
    case 'inspect': {
      if (!args[0]) throw new UserError('Chýba cesta k exportu.')
      return inspectExport(args.length > 1 ? args : args[0])
    }
    case 'ingest': {
      if (!args[0]) throw new UserError('Chýba súbor so správami (.jsonl).')
      return ingestMessages(args[0], { source: typeof flags.source === 'string' ? flags.source : null, name: typeof flags.name === 'string' ? flags.name : null })
    }
    case 'people':
      return buildCandidates({ all: Boolean(flags.all) })
    case 'apply': {
      if (!args[0]) throw new UserError('Chýba súbor s rozhodnutiami.')
      let decisions
      try {
        decisions = JSON.parse(args[0] === '-' ? await readStdin() : await readFile(args[0], 'utf8'))
      } catch {
        throw new UserError('Súbor s rozhodnutiami sa nedá prečítať alebo to nie je JSON.')
      }
      return applyDecisions(Array.isArray(decisions) ? decisions : decisions?.decisions)
    }
    case 'list':
      return listImports()
    case 'search':
      return search(args.join(' '), { person: flags.person === true ? null : flags.person, source: flags.source === true ? null : flags.source, from: flags.from === true ? null : flags.from, to: flags.to === true ? null : flags.to, limit: Number(flags.limit) || 20 })
    case 'thread': {
      if (args.length < 2) throw new UserError('Zadaj zdroj a id konverzácie, napríklad: thread instagram jana_123')
      return thread(args[0], args.slice(1).join(' '), { around: flags.around === true ? null : flags.around, limit: Number(flags.limit) || 80 })
    }
    case 'steam':
      return importSteam({ dir: typeof flags.dir === 'string' ? flags.dir : null })
    case 'file': {
      if (!args[0]) throw new UserError('Chýba cesta k súboru.')
      return importFile(args[0])
    }
    default:
      return null
  }
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

/** Human readable output for people who run the script by hand. */
function human(res) {
  const out = []
  switch (command) {
    case 'detect':
      out.push(res.label, `Zdroj: ${SOURCE_NAME[res.source] ?? res.source} · istota ${Math.round(res.confidence * 100)} %`)
      break
    case 'inspect':
      out.push(`${res.files} súborov, ${Math.round(res.bytes / 1e6)} MB`)
      for (const f of res.folders.slice(0, 12)) out.push(`  ${f.dir}: ${f.files} súborov (${Object.entries(f.types).map(([k, v]) => `${v}× ${k}`).join(', ')})`)
      for (const x of res.samples) out.push(`\n── ${x.file} (${Math.round(x.bytes / 1024)} kB)\n${x.head.slice(0, 600)}`)
      out.push(`\n${res.next}`)
      break
    case 'ingest':
      out.push(res.summary)
      if (res.candidates) out.push('Ďalší krok: node scripts/import.mjs people')
      break
    case 'run':
      out.push(res.summary)
      if (res.me) out.push(`Ty v konverzáciách: ${res.me}`)
      for (const n of res.notes ?? []) out.push(`Poznámka: ${n}`)
      for (const w of res.warnings ?? []) out.push(`Pozor: ${w}`)
      if (res.candidates) out.push('Ďalší krok: node scripts/import.mjs people')
      break
    case 'people':
      if (!res.candidates.length) out.push('Nikto nečaká na potvrdenie.')
      for (const c of res.candidates) {
        out.push(`${c.name} · ${fmtInt(c.messages)} správ · ${c.sources.map((s) => s.source).join(', ')} · ${day(c.first)} až ${day(c.last)}${c.suggest.note ? ` · možno „${c.suggest.note}"` : ''}`)
      }
      if (res.hiddenSmall) out.push(`A ďalších ${res.hiddenSmall} ľudí s menej než 15 správami (ukáže ich --all).`)
      break
    case 'apply':
      out.push(`Vytvorené poznámky: ${res.created.length}, doplnené: ${res.merged.length}, preskočení ľudia: ${res.skipped}.`)
      for (const w of res.warnings ?? []) out.push(`Pozor: ${w}`)
      if (res.analysisTask) out.push('', res.analysisTask)
      break
    case 'list':
      if (!res.sources.length) out.push('Zatiaľ nie je načítané nič.')
      for (const s of res.sources) out.push(`${s.name}: ${plural(s.threads, 'konverzácia', 'konverzácie', 'konverzácií')}, ${plural(s.messages, 'správa', 'správy', 'správ')}, ${day(s.from)} až ${day(s.to)}`)
      out.push(`Importov spolu: ${res.imports.length}`)
      break
    case 'search':
      out.push(res.hits.length ? formatHits(res) : 'Nič som nenašiel.')
      break
    case 'thread':
      out.push(`${res.title} (${res.source}, ${fmtInt(res.total)} správ)`, '')
      for (const m of res.messages) out.push(`${localStamp(m.t)} ${m.from}: ${oneLine(m.text || `[${m.type}]`, 300)}`)
      break
    case 'steam':
      out.push(res.summary, `Poznámka: ${res.notes[0]}`)
      break
    case 'file':
      out.push(`Uložené: ${res.rel} (${res.type}, ${fmtInt(res.sizeKB)} kB)`)
      break
  }
  return out.join('\n')
}

try {
  const res = await main()
  if (res === null) {
    if (json) print({ ok: false, error: command ? `Neznámy príkaz: ${command}` : 'Chýba príkaz.' })
    else console.log(HELP)
    process.exitCode = command ? 1 : 0
  } else if (json || flags.progress) print(res)
  else console.log(human(res))
} catch (err) {
  const message = err instanceof UserError || err?.user ? err.message : `Import zlyhal: ${err?.message ?? err}`
  if (json || flags.progress) print({ ok: false, error: message })
  else console.error(message)
  process.exitCode = 1
}
