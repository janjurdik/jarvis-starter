/**
 * `finish`: checks that the updated install works and, when it does, makes the new version the
 * baseline for the next update. `status` and `customizations` live here too.
 */
import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { IS_MAC, MANIFEST, MANIFEST_SIG, P, REPO, SCHEMA, abs, cmpVersion, copyInto, exists, findBin, installMode, plural, readBuf, readJson, rmDir, sh, walk, writeFile, writeJson } from './core.mjs'
import { appendHistory, listBackups } from './apply.mjs'
import { currentVersion, customizedPaths, ensureBaseline, loadState, localManifest } from './baseline.mjs'
import { cachedCheck } from './check.mjs'
import { manifestText, treeManifest } from './manifest.mjs'
import { diffStat, hasMarkers } from './merge.mjs'
import { depsKey } from './plan.mjs'
import { upstream } from './source.mjs'
import { doctorReady, smoke, syntaxCheck } from './verify.mjs'

const KEEP_BACKUPS = 5

export async function finish({ install = true } = {}) {
  const session = readJson(P.session)
  if (session?.phase === 'applying') return { ok: false, reason: 'interrupted', next: 'Aktualizácia sa prerušila uprostred zápisu. Vráť ju späť: node scripts/update.mjs rollback' }
  if (session?.phase !== 'applied') return { ok: false, reason: 'no-update', next: 'Žiadna aktualizácia nie je rozrobená. Začni: node scripts/update.mjs plan' }
  if (session.schema > SCHEMA) return { ok: false, reason: 'newer-session', next: 'Rozrobenú aktualizáciu začala novšia verzia aktualizačných skriptov, než je teraz v priečinku. Vráť ju späť: node scripts/update.mjs rollback' }
  const open = session.conflicts.filter((c) => !c.resolved).map((c) => c.path)
  if (open.length) return { ok: false, reason: 'conflicts', conflicts: open, next: `Ešte nie sú vyriešené konflikty: ${open.join(', ')}. Zapíš výsledné súbory a potvrď každý: node scripts/update.mjs resolve <cesta>` }
  const marked = [...session.applied.merged, ...session.conflicts.map((c) => c.path)].filter((rel) => hasMarkers(readBuf(abs(rel))))
  if (marked.length) return { ok: false, reason: 'markers', files: marked, next: `V súboroch ostali značky konfliktu: ${marked.join(', ')}. Dopíš výslednú verziu bez nich a spusti finish znova.` }

  const backupDir = join(P.backup, session.backup)
  const checks = []

  const pkgBefore = readBuf(abs('package.json', join(backupDir, 'files')))
  const pkgNow = readBuf(abs('package.json'))
  const depsChanged = Boolean(pkgBefore && pkgNow && depsKey(pkgBefore) !== depsKey(pkgNow)) || [...session.applied.updated, ...session.applied.added].includes('package-lock.json')
  if (depsChanged && install) {
    const npm = findBin('npm')
    const res = npm ? await sh(npm, ['install', '--no-audit', '--no-fund'], { timeout: 600_000 }) : { code: 1, out: 'npm sa nenašiel' }
    checks.push({ id: 'npm', ok: res.code === 0, detail: res.code === 0 ? 'balíčky sú nainštalované (npm install)' : `npm install zlyhal: ${res.out.slice(-600)}` })
  }

  const syntax = await syntaxCheck()
  checks.push({ id: 'syntax', ok: syntax.failed.length === 0, detail: syntax.failed.length ? syntax.failed.map((f) => `${f.file}: ${f.detail}`).join('\n') : `${plural(syntax.count, 'skript', 'skripty', 'skriptov')} bez chyby` })

  const doctor = await doctorReady()
  const doctorOk = doctor.parsed && (session.doctorReady !== true || doctor.ready === true)
  checks.push({ id: 'doctor', ok: doctorOk, detail: !doctor.parsed ? `kontrola počítača sa nedala spustiť: ${doctor.detail ?? ''}` : doctorOk ? 'kontrola počítača dopadla ako pred aktualizáciou' : `pred aktualizáciou bolo všetko pripravené, teraz chýba: ${doctor.failing.join(', ')}` })

  const hud = await smoke()
  checks.push({ id: 'smoke', ok: hud.ok, detail: hud.detail })

  if (checks.some((c) => !c.ok)) {
    return { ok: false, reason: 'verify-failed', from: session.from, to: session.to, checks, next: 'Nová verzia neprešla kontrolou. Oprav, čo zlyhalo, a spusti finish znova. Ak to nejde, vráť všetko späť: node scripts/update.mjs rollback' }
  }

  // The new version becomes the baseline. The old one moves into the backup, so a rollback is complete.
  const incoming = treeManifest(P.incoming)
  if (!incoming) return { ok: false, reason: 'no-incoming', checks, next: 'Stiahnutá verzia zmizla z data/update/incoming, neviem si ju uložiť ako východisko. Vráť aktualizáciu (rollback) a spusti ju znova od plan.' }
  if (exists(P.base)) {
    try {
      renameSync(P.base, join(backupDir, 'base'))
    } catch {
      rmDir(P.base)
    }
  }
  for (const rel of Object.keys(incoming.files)) copyInto(abs(rel, P.incoming), abs(rel, P.base))
  const now = new Date().toISOString()
  writeJson(P.state, { version: incoming.version, at: now, source: 'update', ref: null, files: incoming.files, missing: [] })
  if (exists(join(P.incoming, MANIFEST))) copyInto(join(P.incoming, MANIFEST), abs(MANIFEST))
  // The signature belongs to the manifest: the new one replaces the old one without a question.
  if (exists(join(P.incoming, MANIFEST_SIG))) copyInto(join(P.incoming, MANIFEST_SIG), abs(MANIFEST_SIG))
  else writeFile(abs(MANIFEST), manifestText({ name: incoming.name, version: incoming.version, released: incoming.released ?? now, files: incoming.files }))

  const counts = Object.fromEntries(Object.entries(session.applied).map(([key, list]) => [key, list.length]))
  appendHistory({ type: 'update', at: now, from: session.from, version: session.to, backup: session.backup, applied: counts, resolved: session.conflicts.map((c) => ({ path: c.path, take: c.take })) })
  for (const item of [P.incoming, P.conflicts, P.plan, P.session, P.tmp]) rmDir(item)
  // The HUD reads the remembered check: it must not keep offering the version that was just installed.
  const checked = cachedCheck()
  if (checked) writeJson(P.check, { ...checked, ok: true, available: false, current: { version: session.to, base: session.to }, changelog: '', summary: `Máš najnovšiu verziu Jarvisa (${session.to}).`, inProgress: false, at: now })
  for (const id of listBackups().slice(0, -KEEP_BACKUPS)) rmDir(join(P.backup, id))

  const notes = session.notes ?? {}
  const followups = []
  if (notes.restartHud) followups.push('Reštartuj HUD, aby bežal na novej verzii: node scripts/hud.mjs --restart')
  if (notes.schedule) followups.push('Znova zaregistruj rutiny: node scripts/schedule.mjs install')
  if (notes.desktop && IS_MAC) followups.push('Zostav nanovo appku na plochu: sh hud/desktop/build.sh --open')
  if (depsChanged && !install) followups.push('Nainštaluj balíčky: npm install')
  if (notes.newConfigKeys?.length) followups.push(`Nové nastavenia, ktoré môžeš pridať do config/jarvis.json: ${notes.newConfigKeys.join(', ')} (vzor je v config/jarvis.example.json)`)
  if (notes.newEnvKeys?.length) followups.push(`Nové voľby pre .env: ${notes.newEnvKeys.join(', ')} (popis je v .env.example)`)
  if (session.mode === 'git') followups.push(`Zmeny sú v pracovnom priečinku gitu, nič som necommitol. Ulož ich: git add -A && git commit -m "Update Jarvis to ${session.to}"`)

  return {
    ok: true,
    from: session.from,
    version: session.to,
    applied: counts,
    checks,
    changelog: session.changelog ?? '',
    followups,
    backup: session.backup,
    summary: `Jarvis je na verzii ${session.to} (predtým ${session.from}). Tvoje úpravy, pamäť aj nastavenie ostali. Keby niečo nesedelo, vrátiš to: node scripts/update.mjs rollback`,
  }
}

export function status() {
  const state = loadState()
  const manifest = localManifest()
  const session = readJson(P.session)
  const plan = readJson(P.plan)
  const checked = cachedCheck()
  const history = readJson(P.history, [])
  const phase = session?.phase === 'applying' ? 'interrupted' : session?.phase === 'applied' ? 'applied' : plan?.ok && plan.available ? 'planned' : 'idle'
  const open = session?.conflicts?.filter((c) => !c.resolved).map((c) => c.path) ?? []
  const backups = listBackups().map((id) => {
    const meta = readJson(join(P.backup, id, 'backup.json'), {})
    return { id, from: meta.from ?? null, to: meta.to ?? null, at: meta.at ?? null, rolledBack: meta.rolledBack ?? null }
  })
  // A manifest that disagrees with the saved baseline wins: the files were replaced some other way (git pull).
  const version = manifest && (!state || cmpVersion(state.version, manifest.version) !== 0) ? manifest.version : currentVersion(state)
  let summary = `Máš verziu ${version}. Žiadna aktualizácia nie je rozrobená.`
  if (phase === 'interrupted') summary = 'Aktualizácia sa prerušila uprostred zápisu. Vráť ju späť: node scripts/update.mjs rollback'
  else if (phase === 'applied' && open.length) summary = `Aktualizácia na ${session.to} je rozrobená: ostáva vyriešiť ${plural(open.length, 'konflikt', 'konflikty', 'konfliktov')} (${open.join(', ')}).`
  else if (phase === 'applied') summary = `Aktualizácia na ${session.to} je nahratá, ostáva ju overiť: node scripts/update.mjs finish`
  else if (phase === 'planned') summary = `Plán aktualizácie na ${plan.latest.version} je pripravený. Pokračuj: node scripts/update.mjs apply`
  else if (checked?.ok && checked.available) summary = `Máš verziu ${version}, vonku je ${checked.latest.version}.`
  return {
    ok: true,
    phase,
    mode: installMode(),
    source: upstream().label,
    current: { version, base: state?.version ?? null, manifest: manifest?.version ?? null },
    lastCheck: checked ? { at: checked.at, ok: checked.ok, available: checked.available, latest: checked.latest?.version ?? null } : null,
    plan: phase === 'planned' ? { at: plan.at, latest: plan.latest.version, counts: plan.counts } : null,
    update: session?.phase === 'applied' ? { from: session.from, to: session.to, at: session.at, backup: session.backup, conflicts: session.conflicts.map((c) => ({ path: c.path, resolved: c.resolved, take: c.take })), open } : null,
    backups,
    last: Array.isArray(history) && history.length ? history[history.length - 1] : null,
    summary,
  }
}

export async function customizations() {
  const baseline = await ensureBaseline({ fetch: true })
  if (baseline.kind === 'none') {
    return { ok: true, baseline: 'none', version: currentVersion(null), count: 0, files: [], mine: [], mineCount: 0, summary: 'Táto inštalácia nemá zoznam súborov svojej verzie (jarvis.manifest.json), takže neviem povedať, čo si menil.' }
  }
  const missing = new Set(baseline.missing)
  const files = customizedPaths(baseline).map((rel) => {
    const local = readBuf(abs(rel))
    if (!local) return { path: rel, status: 'deleted', added: 0, removed: null, note: 'zmazaný' }
    const base = missing.has(rel) ? null : readBuf(abs(rel, P.base))
    const stat = base ? diffStat(base, local) : null
    return { path: rel, status: 'changed', added: stat?.added ?? null, removed: stat?.removed ?? null, note: stat ? `+${stat.added} −${stat.removed} riadkov` : base ? 'binárny súbor' : 'zmenený (pôvodná verzia chýba)' }
  })
  const own = walk(REPO, { keep: (rel) => !(rel in baseline.files) && rel !== MANIFEST && rel !== MANIFEST_SIG })
  return {
    ok: true,
    baseline: baseline.kind,
    version: baseline.version,
    count: files.length,
    files,
    mine: own.slice(0, 300),
    mineCount: own.length,
    summary: `Oproti verzii ${baseline.version} máš ${plural(files.length, 'upravený súbor', 'upravené súbory', 'upravených súborov')} a ${plural(own.length, 'vlastný súbor', 'vlastné súbory', 'vlastných súborov')} navyše.`,
  }
}
