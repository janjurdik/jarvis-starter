/**
 * `apply`, `resolve` and `rollback`: the steps that change files.
 *
 * Everything an update is about to change or delete is copied to data/update/backup/<time>/ first.
 * Files with overlapping changes are not overwritten: their three versions go to
 * data/update/conflicts/ and wait for Claude to write the final file.
 */
import { readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MANIFEST, MANIFEST_SIG, P, SCHEMA, abs, copyInto, errMsg, exists, hashOf, readBuf, readJson, relFromInput, removeFile, rmDir, stamp, writeFile, writeJson } from './core.mjs'
import { treeManifest } from './manifest.mjs'
import { hasMarkers, mergeFile } from './merge.mjs'
import { depsKey } from './plan.mjs'
import { doctorReady } from './verify.mjs'

/** A plan older than this is made again: upstream may have moved on. */
const PLAN_MAX_AGE = 12 * 3600_000

const HINT = {
  conflicts: 'Prečítaj .local (úpravy používateľa) a .incoming (nová verzia), oba oproti .base. V .merged sú sporné miesta označené. Do skutočného súboru zapíš verziu, ktorá zachová úmysel používateľa aj novinku z novej verzie.',
  'no-base': 'Pôvodná verzia chýba. Porovnaj .local a .incoming (.merged ukazuje, kde sa líšia) a zapíš súbor, ktorý má novinky a zároveň úpravy používateľa.',
  binary: 'Nie je to text. Vyber jednu verziu: resolve --take local (nechá súbor používateľa) alebo --take incoming (nová verzia). Ak to nie je jasné, spýtaj sa.',
  'deleted-local': 'Používateľ súbor zmazal. Ak ho nová verzia potrebuje (iné súbory ho načítavajú), vráť ho: resolve --take incoming. Inak ho nechaj zmazaný: resolve --take local.',
  'deleted-upstream': 'Nová verzia súbor zrušila. Pozri v .local, čo si používateľ upravil, a ak to má zmysel, prenes to na nové miesto. Potom resolve --take incoming (súbor zmaže) alebo --take local (nechá ho).',
}

export const conflictFiles = (rel) => Object.fromEntries(['base', 'local', 'incoming', 'merged'].map((kind) => [kind, `${abs(rel, P.conflicts)}.${kind}`]))
const existing = (files) => Object.fromEntries(Object.entries(files).map(([kind, file]) => [kind, exists(file) ? file : null]))

export function listBackups() {
  try {
    return readdirSync(P.backup)
      .filter((id) => exists(join(P.backup, id, 'backup.json')))
      .sort()
  } catch {
    return []
  }
}

export function appendHistory(entry) {
  const list = readJson(P.history, [])
  writeJson(P.history, [...(Array.isArray(list) ? list : []), entry].slice(-100))
}

/**
 * Puts every file of a backup back and deletes what the update added. What is on disk right now
 * goes to <backup>/after/ first, so even a rollback can be looked into afterwards.
 */
function restore(dir, meta) {
  const after = join(dir, 'after')
  rmDir(after)
  for (const rel of [...meta.changed, ...meta.added]) if (exists(abs(rel))) copyInto(abs(rel), abs(rel, after))
  let restored = 0
  let removed = 0
  for (const rel of meta.changed) {
    copyInto(abs(rel, join(dir, 'files')), abs(rel))
    restored++
  }
  for (const rel of meta.added) {
    if (!exists(abs(rel))) continue
    removeFile(abs(rel))
    removed++
  }
  if (exists(join(dir, 'base'))) {
    rmDir(P.base)
    renameSync(join(dir, 'base'), P.base)
  }
  if (exists(join(dir, 'state.json'))) copyInto(join(dir, 'state.json'), P.state)
  else if (!meta.hadState) {
    rmDir(P.state)
    rmDir(P.base)
  }
  return { restored, removed }
}

const INTERRUPTED = 'Predošlá aktualizácia sa prerušila uprostred zápisu. Najprv ju vráť späť: node scripts/update.mjs rollback'

export async function apply() {
  if (readJson(P.session)?.phase === 'applying') return { ok: false, reason: 'interrupted', next: INTERRUPTED }
  if (readJson(P.session)?.phase === 'applied') {
    return { ok: false, reason: 'in-progress', next: 'Jedna aktualizácia je rozrobená. Dokonči ju (node scripts/update.mjs finish) alebo ju vráť späť (node scripts/update.mjs rollback).' }
  }
  const plan = readJson(P.plan)
  const again = 'Spusti znova: node scripts/update.mjs plan'
  if (!plan?.ok || !plan.available) return { ok: false, reason: 'no-plan', next: `Nemám plán aktualizácie. ${again}` }
  if (plan.schema !== SCHEMA || Date.now() - Date.parse(plan.at) > PLAN_MAX_AGE) return { ok: false, reason: 'stale-plan', next: `Plán je starý. ${again}` }
  const incoming = treeManifest(P.incoming)
  if (!incoming || incoming.version !== plan.latest.version) return { ok: false, reason: 'stale-plan', next: `Stiahnutá verzia chýba alebo nesedí s plánom. ${again}` }
  const drift = Object.entries(plan.hashes)
    .filter(([rel, hash]) => hashOf(abs(rel)) !== hash)
    .map(([rel]) => rel)
  if (drift.length) return { ok: false, reason: 'stale-plan', changed: drift, next: `Od plánu sa zmenili súbory (${drift.slice(0, 5).join(', ')}). ${again}` }

  const before = await doctorReady()

  let id = stamp()
  while (exists(join(P.backup, id))) id = `${id}x`
  const dir = join(P.backup, id)
  const meta = { schema: SCHEMA, id, at: new Date().toISOString(), from: plan.current.version, to: plan.latest.version, changed: [], added: [], hadState: exists(P.state), rolledBack: null }
  // The manifest is replaced by finish and the lock file may be rewritten by npm install: both belong to the backup.
  for (const rel of new Set([...plan.update, ...plan.add, ...plan.remove, ...plan.conflict.map((c) => c.path), MANIFEST, MANIFEST_SIG, 'package-lock.json'])) {
    if (exists(abs(rel))) {
      copyInto(abs(rel), abs(rel, join(dir, 'files')))
      meta.changed.push(rel)
    } else {
      meta.added.push(rel)
    }
  }
  if (meta.hadState) copyInto(P.state, join(dir, 'state.json'))
  writeJson(join(dir, 'backup.json'), meta)

  // Marks the moment files start to change: a run that dies in here is noticed and rolled back first.
  writeJson(P.session, { schema: SCHEMA, phase: 'applying', at: meta.at, from: meta.from, to: meta.to, backup: id })

  const done = { updated: [], added: [], removed: [], merged: [] }
  const conflicts = []
  try {
    for (const rel of plan.update) {
      copyInto(abs(rel, P.incoming), abs(rel))
      done.updated.push(rel)
    }
    for (const rel of plan.add) {
      copyInto(abs(rel, P.incoming), abs(rel))
      done.added.push(rel)
    }
    for (const rel of plan.remove) {
      removeFile(abs(rel))
      done.removed.push(rel)
    }
    rmDir(P.conflicts)
    for (const c of plan.conflict) {
      const local = readBuf(abs(c.path))
      const next = readBuf(abs(c.path, P.incoming))
      const base = c.kind === 'both' || c.kind.startsWith('deleted') ? readBuf(abs(c.path, P.base)) : null
      const res = local && next ? await mergeFile({ local, base: c.kind === 'both' ? base : null, incoming: next }) : null
      if (c.auto === 'clean' && res?.auto === 'clean') {
        writeFileSync(abs(c.path), res.merged)
        done.merged.push(c.path)
        continue
      }
      const files = conflictFiles(c.path)
      if (base) writeFile(files.base, base)
      if (local) writeFile(files.local, local)
      if (next) writeFile(files.incoming, next)
      if (res?.merged) writeFile(files.merged, res.merged)
      conflicts.push({ path: c.path, kind: c.kind, auto: res?.auto ?? c.auto, why: c.why, resolved: false, take: null })
    }
  } catch (err) {
    restore(dir, meta)
    rmDir(P.conflicts)
    rmDir(P.session)
    meta.rolledBack = new Date().toISOString()
    writeJson(join(dir, 'backup.json'), meta)
    return { ok: false, reason: 'write-failed', detail: errMsg(err), next: 'Zápis súborov zlyhal. Všetko som vrátil do stavu pred aktualizáciou. Zavri programy, ktoré môžu súbory držať (HUD, editor), a skús to znova od plan.' }
  }

  writeJson(P.session, { schema: SCHEMA, phase: 'applied', at: new Date().toISOString(), from: meta.from, to: meta.to, backup: id, mode: plan.mode, doctorReady: before.ready, applied: done, conflicts, notes: plan.notes, changelog: plan.changelog })
  rmDir(P.plan)

  return {
    ok: true,
    from: meta.from,
    to: meta.to,
    backup: id,
    applied: { updated: done.updated.length, added: done.added.length, removed: done.removed.length, merged: done.merged.length },
    merged: done.merged,
    conflicts: conflicts.map((c) => ({ path: c.path, kind: c.kind, auto: c.auto, why: c.why, hint: HINT[c.kind] ?? HINT[c.auto] ?? HINT.conflicts, files: existing(conflictFiles(c.path)) })),
    notes: plan.notes,
    next: conflicts.length
      ? 'Pri každom konflikte prečítaj jeho verzie (files), zapíš výsledný súbor na pôvodné miesto a potvrď ho: node scripts/update.mjs resolve <cesta>. Keď sú všetky vyriešené: node scripts/update.mjs finish'
      : 'Všetko sa spojilo bez konfliktov. Sprav, čo hovoria poznámky autora (notes.migrations), a dokonči: node scripts/update.mjs finish',
  }
}

export function resolve(input, take = null) {
  const session = readJson(P.session)
  if (session?.phase !== 'applied') return { ok: false, reason: 'no-update', next: 'Žiadna aktualizácia nie je rozrobená.' }
  const rel = input ? relFromInput(input) : null
  const conflict = session.conflicts.find((c) => c.path === rel)
  const open = () => session.conflicts.filter((c) => !c.resolved).map((c) => c.path)
  if (!conflict) return { ok: false, reason: 'unknown-path', remaining: open(), next: `Taký konflikt nepoznám. Otvorené: ${open().join(', ') || 'žiadne'}.` }
  const files = conflictFiles(rel)
  const target = abs(rel)
  const put = (file) => (exists(file) ? copyInto(file, target) : removeFile(target))

  if (take === 'local') put(files.local)
  else if (take === 'incoming') put(files.incoming)
  else if (take === 'merged') {
    if (!exists(files.merged)) return { ok: false, reason: 'no-merged', next: 'Tento konflikt nemá spojenú verziu. Zapíš súbor sám alebo zvoľ --take local či --take incoming.' }
    if (hasMarkers(readBuf(files.merged))) return { ok: false, reason: 'markers', next: 'Spojená verzia ešte obsahuje značky konfliktu. Zapíš výsledný súbor sám a potom spusti resolve bez --take.' }
    copyInto(files.merged, target)
  } else if (take) {
    return { ok: false, reason: 'bad-take', next: 'Za --take patrí local, incoming alebo merged.' }
  } else {
    const now = readBuf(target)
    if (!now && !conflict.kind.startsWith('deleted')) return { ok: false, reason: 'missing-file', next: `Súbor ${rel} neexistuje. Zapíš ho, alebo zvoľ --take local či --take incoming.` }
    if (now && hasMarkers(now)) return { ok: false, reason: 'markers', next: `V súbore ${rel} ostali značky konfliktu. Dopíš výslednú verziu bez nich.` }
    const was = readBuf(files.local)
    if (now && was && now.equals(was)) return { ok: false, reason: 'unchanged', next: `Súbor ${rel} je rovnaký ako pred aktualizáciou, novinky z novej verzie v ňom nie sú. Ak to tak má ostať, potvrď to: resolve ${rel} --take local` }
  }
  conflict.resolved = true
  conflict.take = take ?? 'manual'
  writeJson(P.session, session)
  const remaining = open()
  return { ok: true, path: rel, take: conflict.take, remaining, next: remaining.length ? `Ostáva vyriešiť: ${remaining.join(', ')}` : 'Všetky konflikty sú vyriešené. Dokonči: node scripts/update.mjs finish' }
}

export function rollback(wanted = null) {
  const ids = listBackups()
  const id = wanted ? ids.find((x) => x === wanted) : ids[ids.length - 1]
  if (!id) return { ok: false, reason: 'no-backup', backups: ids, next: wanted ? `Zálohu ${wanted} nemám. Dostupné: ${ids.join(', ') || 'žiadne'}.` : 'Nemám žiadnu zálohu, nie je čo vracať.' }
  const dir = join(P.backup, id)
  const meta = readJson(join(dir, 'backup.json'))
  if (!meta || !Array.isArray(meta.changed) || !Array.isArray(meta.added)) return { ok: false, reason: 'bad-backup', next: `Záloha ${id} je poškodená.` }
  if (!wanted && meta.rolledBack) return { ok: false, reason: 'already', backups: ids, next: `Posledná aktualizácia už je vrátená späť. Staršiu zálohu vyber menom: node scripts/update.mjs rollback <${ids.join(' | ')}>` }

  let counts
  try {
    counts = restore(dir, meta)
  } catch (err) {
    return { ok: false, reason: 'write-failed', detail: errMsg(err), next: `Niektorý súbor sa nedal vrátiť. Záloha je celá v ${join(dir, 'files')}, zavri HUD a skús rollback znova.` }
  }
  for (const item of [P.session, P.plan, P.conflicts, P.incoming, P.check, P.tmp]) rmDir(item)
  meta.rolledBack = new Date().toISOString()
  writeJson(join(dir, 'backup.json'), meta)
  appendHistory({ type: 'rollback', at: meta.rolledBack, version: meta.from, undone: meta.to, backup: id })

  const pkgAfter = readBuf(abs('package.json', join(dir, 'after')))
  const pkgNow = readBuf(abs('package.json'))
  const npmInstall = Boolean(pkgAfter && pkgNow && depsKey(pkgAfter) !== depsKey(pkgNow))
  return {
    ok: true,
    backup: id,
    version: meta.from,
    undone: meta.to,
    restored: counts.restored,
    removed: counts.removed,
    npmInstall,
    next: `Jarvis je späť na verzii ${meta.from}.${npmInstall ? ' Balíčky sa líšia, spusti npm install.' : ''} Reštartuj HUD: node scripts/hud.mjs --restart`,
  }
}
