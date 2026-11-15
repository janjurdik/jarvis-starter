#!/usr/bin/env node
/**
 * Looks around the computer and finds out everything it can about its owner, so the guided
 * setup can confirm findings instead of asking dozens of questions.
 *
 *   node scripts/scan.mjs                    summary in Slovak, writes data/scan/scan.json and scan.md
 *   node scripts/scan.mjs --json             prints the JSON
 *   node scripts/scan.mjs --deep             slower probes too (most visited sites, sizes, repo languages)
 *   node scripts/scan.mjs --allow contacts,calendar,reminders,photos,messages
 *                                            sources that macOS guards with a privacy prompt
 *                                            (also: applenotes, icloud, safari)
 *   node scripts/scan.mjs --only apps,notes  only some probe groups (prints, does not overwrite the saved scan,
 *                                            leaves `missing` and `questions` empty)
 *
 * Probe groups: identity, host, apps, notes, ai, code, documents, exports, media, games, comms, browser,
 * private (the --allow sources), hints (school and work). JARVIS_SCAN_DEBUG=1 prints step timings to stderr.
 *
 * Rules the scan keeps:
 *   - read-only: it writes nothing outside data/scan/
 *   - no network: nothing leaves the computer (the only helper that talks to the network is
 *     `claude mcp list`, Claude's own connector check; JARVIS_SCAN_NO_MCP=1 skips it)
 *   - no surprise dialogs: guarded data is only touched after --allow
 *   - never throws, never hangs: every probe group has a time limit, errors go to stats.errors
 *
 * Uses only Node built-ins, so it works before `npm install`.
 */
import './scan/threads.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IS_MAC, parseArgs } from './lib.mjs'
import { ai } from './scan/ai.mjs'
import { apps } from './scan/apps.mjs'
import { browser } from './scan/browser.mjs'
import { code } from './scan/code.mjs'
import { comms } from './scan/comms.mjs'
import { documents } from './scan/documents.mjs'
import { exportsProbe } from './scan/exports.mjs'
import { games } from './scan/games.mjs'
import { host, identity } from './scan/identity.mjs'
import { buildIndex } from './scan/index.mjs'
import { media } from './scan/media.mjs'
import { notes } from './scan/notes.mjs'
import { ALLOW_IDS, privateProbe } from './scan/private.mjs'
import { hints, markdown, missing, questions, summary } from './scan/report.mjs'
import { EMAIL_RE, SCAN_DIR, cleanTmp, errText, isDenied, loadMounts, tilde } from './scan/util.mjs'

const started = Date.now()
const argv = process.argv.slice(2)
const { flags } = parseArgs(argv)
/** Value of `--name a,b` or `--name=a,b` as a list. */
const listArg = (name) => {
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  const at = argv.indexOf(`--${name}`)
  const raw = inline ? inline.slice(name.length + 3) : at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : ''
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
}
const deep = flags.has('deep')
const asJson = flags.has('json')
const allow = new Set(listArg('allow').filter((id) => ALLOW_IDS.includes(id)))
const unknownAllow = listArg('allow').filter((id) => !ALLOW_IDS.includes(id))

/** Probe groups. The first phase runs in parallel, the second one sees its findings. */
const PHASE_1 = { identity, host, apps, notes, ai, code, documents, exports: exportsProbe, media, games, comms, browser, private: privateProbe }
const PHASE_2 = { hints }
const ALIASES = { system: 'host', computer: 'host', connectors: 'ai', music: 'media', photos: 'media', video: 'media', school: 'hints', work: 'hints', contacts: 'private', calendar: 'private', reminders: 'private', messages: 'private', repos: 'code', files: 'documents', docs: 'documents', bookmarks: 'browser', chat: 'comms', mail: 'comms' }
const allGroups = [...Object.keys(PHASE_1), ...Object.keys(PHASE_2)]
const onlyRaw = listArg('only')
const only = onlyRaw.length ? new Set(onlyRaw.map((g) => ALIASES[g] ?? g).filter((g) => allGroups.includes(g))) : null
const selected = (name) => !only || only.has(name)

const CATEGORIES = new Set(['notes', 'apps', 'ai', 'code', 'media', 'games', 'comms', 'browser', 'documents', 'exports', 'calendar', 'contacts', 'photos', 'music', 'system', 'connectors', 'school', 'work'])
const ACTIONS = new Set(['import-notes', 'import-export', 'import-file', 'connect', 'read', 'ask', 'none'])
/** Time limit of one probe group. JARVIS_SCAN_LIMIT (seconds) overrides it, for slow disks or tests. */
const GROUP_LIMIT = Number(process.env.JARVIS_SCAN_LIMIT) > 0 ? Number(process.env.JARVIS_SCAN_LIMIT) * 1000 : deep ? 150_000 : 30_000
/** JARVIS_SCAN_DEBUG=1 prints how long every step took (to stderr). */
const DEBUG = Boolean(process.env.JARVIS_SCAN_DEBUG)

const result = {
  version: 1,
  at: new Date(started).toISOString(),
  platform: process.platform,
  ms: 0,
  mode: { deep, allow: [...allow], only: only ? [...only] : null },
  host: { model: null, name: null, os: null, laptop: false, battery: false, screens: null, diskFreeGB: null, alwaysOn: null },
  identity: { fullName: null, username: null, emails: [], gitName: null, gitEmail: null, locale: null, languages: [], timezone: null, keyboard: [], appleId: null, avatarPath: null, birthday: null },
  findings: [],
  exports: [],
  permissions: [],
  missing: [],
  questions: [],
  stats: { probes: 0, errors: [], denied: [], timings: {} },
}
const identityPatches = []
// a stray failure in one probe must not take the whole scan down
process.on('unhandledRejection', (err) => result.stats.errors.push({ probe: 'scan', error: errText(err) }))
process.on('uncaughtException', (err) => result.stats.errors.push({ probe: 'scan', error: errText(err) }))

const FOLDERS_PERMISSION = {
  id: 'folders',
  title: 'Plocha, Dokumenty a Stiahnuté',
  gives: 'Čo máš na ploche, v dokumentoch a v stiahnutých súboroch: priečinky s projektmi, životopis, exporty dát z iných služieb.',
  how: 'macOS mi do týchto priečinkov nedovolil nazrieť. V Nastaveniach systému → Súkromie a bezpečnosť → Súbory a priečinky zapni pri Claude (alebo Termináli) Plochu, Dokumenty a Stiahnuté a spusti sken znova.',
}

let indexMemo
/** The shared walk of the home folder, started by the first probe that needs it. */
const sharedIndex = () => {
  if (!indexMemo) {
    const from = Date.now()
    indexMemo = buildIndex({ deadline: from + (deep ? 60_000 : 16_000), deep })
    if (DEBUG) indexMemo.then((index) => console.error(`[scan] home index ${Date.now() - from} ms, ${index.dirs.size} folders, ${index.repos.length} repos${index.truncated ? ', truncated' : ''}`))
  }
  return indexMemo
}

function makeCtx(group, limit) {
  const local = { findings: [], exports: [], permissions: [], identity: [], host: null, errors: [], denied: [], steps: 0 }
  const ctx = {
    group,
    deep,
    allow,
    deadline: Date.now() + Math.max(limit - 3000, limit / 2),
    result,
    local,
    /** One named part of a probe group. A failure is recorded and the group goes on. */
    async step(name, fn) {
      local.steps++
      const from = Date.now()
      try {
        return await fn()
      } catch (err) {
        // "access refused" is not a bug: the source needs a permission
        if (isDenied(err)) local.denied.push(`${group}.${name}`)
        else local.errors.push({ probe: `${group}.${name}`, error: errText(err) })
        return null
      } finally {
        if (DEBUG) console.error(`[scan] ${group}.${name} ${Date.now() - from} ms`)
      }
    },
    finding(f) {
      local.findings.push({
        id: String(f.id),
        category: CATEGORIES.has(f.category) ? f.category : 'apps',
        title: String(f.title ?? f.id),
        detail: String(f.detail ?? '').replace(/\s+/g, ' ').trim(),
        path: f.path || null,
        data: f.data ?? {},
        use: String(f.use ?? ''),
        action: ACTIONS.has(f.action) ? f.action : 'none',
        weight: Math.min(5, Math.max(1, Math.round(Number(f.weight) || 1))),
        group,
      })
    },
    export: (e) => local.exports.push(e),
    permission: (p) => local.permissions.push({ id: p.id, title: p.title, gives: p.gives, how: p.how }),
    folderDenied: () => ctx.permission(FOLDERS_PERMISSION),
    identity: (patch) => local.identity.push(patch),
    host: (info) => (local.host = info),
    async index() {
      const index = await sharedIndex()
      if (index.denied.length) ctx.folderDenied()
      return index
    },
  }
  return ctx
}

function merge(local) {
  result.findings.push(...local.findings)
  result.exports.push(...local.exports)
  for (const p of local.permissions) {
    const at = result.permissions.findIndex((x) => x.id === p.id)
    // a later, more specific explanation (for example "macOS refused") replaces the general one
    if (at >= 0) result.permissions[at] = p
    else result.permissions.push(p)
  }
  identityPatches.push(...local.identity)
  if (local.host) Object.assign(result.host, local.host)
  result.stats.errors.push(...local.errors)
  result.stats.denied.push(...local.denied)
  result.stats.probes += local.steps + 1
}

async function runGroup(name, fn, limit) {
  const ctx = makeCtx(name, limit)
  const from = Date.now()
  let timer
  const outcome = await Promise.race([
    Promise.resolve()
      .then(() => fn(ctx))
      .then(
        () => 'done',
        (err) => err,
      ),
    new Promise((done) => {
      timer = setTimeout(() => done('timeout'), limit)
    }),
  ])
  clearTimeout(timer)
  result.stats.timings[name] = Date.now() - from
  if (DEBUG) console.error(`[scan] group ${name} ${Date.now() - from} ms (${outcome === 'done' ? 'ok' : outcome === 'timeout' ? 'timeout' : 'error'})`)
  if (outcome === 'timeout') ctx.local.errors.push({ probe: name, error: `časový limit ${Math.round(limit / 1000)} s, výsledok je čiastočný` })
  else if (outcome !== 'done' && !isDenied(outcome)) ctx.local.errors.push({ probe: name, error: errText(outcome) })
  // copies, so a group that is still running after its limit cannot change the result any more
  merge({ ...ctx.local, findings: [...ctx.local.findings], exports: [...ctx.local.exports], permissions: [...ctx.local.permissions], identity: [...ctx.local.identity], errors: [...ctx.local.errors] })
}

/** Many probes add what they know about the person: pick the best value for each field. */
function resolveIdentity() {
  const id = result.identity
  const emailCount = new Map()
  const hints = new Map()
  for (const patch of identityPatches) {
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === '') continue
      if (key === 'emails') {
        for (const raw of value) {
          const mail = String(raw ?? '').trim().toLowerCase()
          if (mail.match(EMAIL_RE)?.[0] === mail && !/noreply|@example\.|\.(lan|local|home|internal|localdomain|localhost)$/.test(mail)) emailCount.set(mail, (emailCount.get(mail) ?? 0) + 1)
        }
      } else if (key === 'nameHints') {
        for (const name of value) if (name && String(name).trim()) hints.set(String(name).trim(), (hints.get(String(name).trim()) ?? 0) + 1)
      } else if (Array.isArray(value)) {
        id[key] = [...new Set([...(id[key] ?? []), ...value.filter(Boolean)])]
      } else if (id[key] == null) {
        id[key] = value
      }
    }
  }
  id.emails = [...emailCount.entries()].sort((a, b) => b[1] - a[1]).map(([mail]) => mail)
  const named = [...hints.entries()].filter(([name]) => name.includes(' ')).sort((a, b) => b[1] - a[1])
  // an account name like "jan" is not a full name: prefer what git, the browser or Apple know
  if ((!id.fullName || !id.fullName.includes(' ')) && named.length) id.fullName = named[0][0]
  if (!id.fullName && id.gitName) id.fullName = id.gitName
  id.otherNames = [...hints.keys()].filter((name) => name !== id.fullName)
}

async function main() {
  cleanTmp()
  await loadMounts()
  // with --allow, macOS shows dialogs and the person needs time to answer them
  const limitOf = (name) => (name === 'private' && allow.size ? Math.max(GROUP_LIMIT, 300_000) : GROUP_LIMIT)
  await Promise.all(Object.entries(PHASE_1).filter(([name]) => selected(name)).map(([name, fn]) => runGroup(name, fn, limitOf(name))))
  resolveIdentity()
  for (const [name, fn] of Object.entries(PHASE_2)) if (selected(name)) await runGroup(name, fn, 12_000)

  // one entry per finding id (a guarded source may be reported by two groups)
  const seen = new Map()
  for (const f of result.findings) if (!seen.has(f.id) || f.group === 'private') seen.set(f.id, f)
  result.findings = [...seen.values()].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
  if (!IS_MAC) result.permissions = result.permissions.filter((p) => p.id === 'folders' || p.id === 'browser')
  result.permissions = result.permissions.filter((p) => !allow.has(p.id) || /odmietol|nepodarilo/.test(p.how))
  // what is missing and what to ask only makes sense after a complete scan
  if (!only) {
    result.missing = missing(result)
    result.questions = questions(result)
  }
  for (const id of unknownAllow) result.stats.errors.push({ probe: 'scan', error: `neznáme povolenie --allow ${id} (poznám: ${ALLOW_IDS.join(', ')})` })
  for (const name of onlyRaw) if (!allGroups.includes(ALIASES[name] ?? name)) result.stats.errors.push({ probe: 'scan', error: `neznáma skupina --only ${name} (poznám: ${allGroups.join(', ')})` })
  result.ms = Date.now() - started
  cleanTmp()

  let files = null
  if (!only) {
    try {
      mkdirSync(SCAN_DIR, { recursive: true })
      const json = join(SCAN_DIR, 'scan.json')
      const md = join(SCAN_DIR, 'scan.md')
      writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`)
      writeFileSync(md, markdown(result, { deep }))
      files = { json: tilde(json), md: tilde(md) }
    } catch (err) {
      result.stats.errors.push({ probe: 'scan.write', error: errText(err) })
    }
  }
  if (asJson) return JSON.stringify(result, null, 2)
  return summary(result, { deep, files }) + (only ? '  Čiastočný sken: uložený výsledok v data/scan som nemenil.\n' : '')
}

let output
try {
  output = await main()
} catch (err) {
  // nothing above should get here, but the setup must never see a stack trace
  result.stats.errors.push({ probe: 'scan', error: errText(err) })
  result.ms = Date.now() - started
  output = asJson ? JSON.stringify(result, null, 2) : `\n  Sken sa nepodarilo dokončiť: ${errText(err)}\n`
}
// exit only after the text is flushed (a pipe may still be draining), and do not wait for stragglers
process.stdout.write(`${output}\n`, () => process.exit(0))
