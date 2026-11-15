#!/usr/bin/env node
/**
 * Updates Jarvis to a newer version without losing what the user changed.
 *
 *   node scripts/update.mjs check            is there a newer version?
 *   node scripts/update.mjs plan             download it and say what would change (changes nothing)
 *   node scripts/update.mjs apply            back up, apply everything safe, set conflicts aside
 *   node scripts/update.mjs resolve <path>   mark a conflict as solved [--take local|incoming|merged]
 *   node scripts/update.mjs finish           verify the install and make the new version the baseline
 *   node scripts/update.mjs rollback [time]  put everything back as it was before the update
 *   node scripts/update.mjs status           where an update in progress stands
 *   node scripts/update.mjs customizations   what the user changed compared with the shipped version
 *
 * Every command takes --json. Never touched: memory/, config/jarvis.json, .env, data/.
 * How it works and the procedure for Claude: docs/AKTUALIZACIE.md.
 *
 * Environment: JARVIS_UPDATE_REPO=owner/name, JARVIS_UPDATE_BRANCH, JARVIS_UPDATE_SOURCE=<folder or
 * .tar.gz, replaces the network>, JARVIS_UPDATE_BASE_SOURCE=<pristine copy of the installed version>,
 * JARVIS_UPDATE_GIT=0 (do not use git), JARVIS_UPDATE_TAR=0 (do not use the system tar),
 * JARVIS_UPDATE_SMOKE=0 (skip the HUD start test), JARVIS_UPDATE_CHECK=0 (no automatic checks).
 */
import { parseArgs, plural } from './update/core.mjs'

const argv = process.argv.slice(2)
/** Options that carry a value (--take local, --take=local). The rest goes through parseArgs. */
const values = {}
const plain = []
for (let i = 0; i < argv.length; i++) {
  const m = /^--(take)(?:=(.*))?$/.exec(argv[i])
  if (!m) plain.push(argv[i])
  else values[m[1]] = m[2] ?? argv[++i] ?? ''
}
const { flags, rest } = parseArgs(plain)
const [command = 'help', ...args] = rest
const json = flags.has('json')

const say = (...lines) => console.log(lines.join('\n'))
const list = (title, items, max = 12) => {
  if (!items?.length) return
  say(`\n  ${title}`)
  for (const item of items.slice(0, max)) say(`    ${item}`)
  if (items.length > max) say(`    … a ďalších ${items.length - max}`)
}
const indent = (text, pad = '    ') => String(text).split('\n').map((line) => `${pad}${line}`).join('\n')

function printCheck(r) {
  say(`\n  ${r.summary}`)
  if (r.ok && r.available && r.changelog) say('\n  Čo je nové:\n', indent(r.changelog))
  if (r.ok && r.available) say('\n  Pokračuj: node scripts/update.mjs plan')
  say('')
}

function printPlan(r) {
  say(`\n  ${r.summary}`)
  if (!r.ok || !r.available) return say('')
  for (const w of r.warnings) say(`\n  ! ${w}`)
  list('Aktualizuje sa (nemenil si ich):', r.update)
  list('Pribudne:', r.add)
  list('Odstráni sa (nová verzia ich už nemá):', r.remove)
  list('Tvoje úpravy, ostávajú bez zmeny:', r.keep)
  list('Spojím automaticky (ty aj nová verzia, každý inde):', r.conflict.filter((c) => c.auto === 'clean').map((c) => c.path))
  list('Treba spojiť ručne:', r.conflict.filter((c) => c.auto !== 'clean').map((c) => `${c.path}  (${c.why})`))
  if (r.counts.mine) say(`\n  Tvoje vlastné súbory (${r.counts.mine}): nedotknem sa ich.`)
  list('Po aktualizácii:', r.notes.list)
  say('\n  Nič sa zatiaľ nezmenilo. Pokračuj: node scripts/update.mjs apply\n')
}

function printApply(r) {
  if (!r.ok) return say(`\n  ${r.next}\n`)
  const a = r.applied
  say(`\n  Nová verzia ${r.to} je nahratá (záloha: ${r.backup}).`)
  say(`  Aktualizované: ${a.updated}, pridané: ${a.added}, odstránené: ${a.removed}, spojené automaticky: ${a.merged}.`)
  list('Spojené automaticky (oplatí sa na ne pozrieť):', r.merged)
  if (r.conflicts.length) {
    say(`\n  ${plural(r.conflicts.length, 'súbor čaká', 'súbory čakajú', 'súborov čaká')} na ručné spojenie. Tvoje verzie som nechal na mieste:`)
    for (const c of r.conflicts) {
      say(`\n    ${c.path}`, `      ${c.why}`, `      ${c.hint}`)
      for (const [kind, file] of Object.entries(c.files)) if (file) say(`      ${kind.padEnd(9)}${file}`)
    }
  }
  list('Poznámky:', r.notes.list)
  say(`\n  ${r.next}\n`)
}

function printFinish(r) {
  if (r.checks) {
    say('')
    for (const c of r.checks) say(`  ${c.ok ? '✓' : '✗'} ${c.detail.split('\n').join('\n    ')}`)
  }
  if (!r.ok) return say(`\n  ${r.next}\n`)
  say(`\n  ${r.summary}`)
  if (r.changelog) say('\n  Čo je nové:\n', indent(r.changelog))
  list('Ešte treba:', r.followups)
  say('')
}

function printStatus(r) {
  say(`\n  ${r.summary}`)
  say(`  Zdroj aktualizácií: ${r.source}. Inštalácia: ${r.mode === 'git' ? 'git klon' : 'rozbalený priečinok'}.`)
  if (r.update) list('Konflikty:', r.update.conflicts.map((c) => `${c.resolved ? '✓' : '·'} ${c.path}${c.take ? `  (${c.take})` : ''}`), 50)
  list('Zálohy (rollback):', r.backups.map((b) => `${b.id}  ${b.from} → ${b.to}${b.rolledBack ? '  (vrátená)' : ''}`))
  say('')
}

function printCustom(r) {
  say(`\n  ${r.summary}`)
  list('Upravené súbory:', r.files.map((f) => `${f.path}  (${f.note})`), 60)
  list('Vlastné súbory:', r.mine, 30)
  say('')
}

const HELP = `
  Aktualizácia Jarvisa

    node scripts/update.mjs check            je vonku novšia verzia?
    node scripts/update.mjs plan             stiahne ju a povie, čo sa zmení (nič nemení)
    node scripts/update.mjs apply            zálohuje, nahrá bezpečné zmeny, konflikty odloží bokom
    node scripts/update.mjs resolve <súbor>  potvrdí vyriešený konflikt [--take local|incoming|merged]
    node scripts/update.mjs finish           overí, že všetko funguje, a aktualizáciu uzavrie
    node scripts/update.mjs rollback [čas]   vráti všetko do stavu pred aktualizáciou
    node scripts/update.mjs status           v akom stave je aktualizácia
    node scripts/update.mjs customizations   čo si oproti pôvodnej verzii zmenil

  Ku každému príkazu ide --json. Viac: docs/AKTUALIZACIE.md
`

async function main() {
  switch (command) {
    case 'check': {
      const { check } = await import('./update/check.mjs')
      return [await check(), printCheck]
    }
    case 'plan': {
      const { plan } = await import('./update/plan.mjs')
      return [await plan({ force: flags.has('force') }), printPlan]
    }
    case 'apply': {
      const { apply } = await import('./update/apply.mjs')
      return [await apply(), printApply]
    }
    case 'resolve': {
      const { resolve } = await import('./update/apply.mjs')
      return [resolve(args[0], 'take' in values ? values.take : null), (r) => say(`\n  ${r.ok ? `Vyriešené: ${r.path} (${r.take}). ` : ''}${r.next}\n`)]
    }
    case 'finish': {
      const { finish } = await import('./update/finish.mjs')
      return [await finish({ install: !flags.has('no-install') }), printFinish]
    }
    case 'rollback': {
      const { rollback } = await import('./update/apply.mjs')
      return [rollback(args[0] ?? null), (r) => say(`\n  ${r.ok ? `Vrátených súborov: ${r.restored}, odstránených (pridala ich aktualizácia): ${r.removed}. ` : ''}${r.next}\n`)]
    }
    case 'status': {
      const { status } = await import('./update/finish.mjs')
      return [status(), printStatus]
    }
    case 'customizations': {
      const { customizations } = await import('./update/finish.mjs')
      return [await customizations(), printCustom]
    }
    default:
      say(HELP)
      return [{ ok: command === 'help' }, () => {}]
  }
}

let result
let print
try {
  ;[result, print] = await main()
} catch (err) {
  result = { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err), next: 'Aktualizácia narazila na chybu. Ak už bola nahratá (apply), vráť ju: node scripts/update.mjs rollback' }
  print = (r) => say(`\n  ${r.next}\n  (${r.detail})\n`)
}
if (json && command !== 'help') console.log(JSON.stringify(result, null, 2))
else print(result)
process.exitCode = result.ok ? 0 : 1
