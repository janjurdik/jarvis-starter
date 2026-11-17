/**
 * `plan`: downloads the newest version, compares it three-way with the baseline and with what is
 * on disk, and decides for every file what an update would do. Nothing in the install changes.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MANIFEST, P, REPO, SCHEMA, abs, cmpVersion, fileHash, installMode, isGenerated, isProtected, plural, readBuf, readJson, rmDir, walk, writeJson } from './core.mjs'
import { currentVersion, ensureBaseline } from './baseline.mjs'
import { changelogSince } from './check.mjs'
import { treeManifest } from './manifest.mjs'
import { mergeFile } from './merge.mjs'
import { verifyRelease } from './signature.mjs'
import { fetchIncoming, upstream } from './source.mjs'

const SCHEDULE_FILES = new Set(['scripts/schedule.mjs', 'scripts/autostart.mjs', 'scripts/routine.mjs', 'scripts/run-hidden.vbs'])
const MINE_LIMIT = 300

const WHY = {
  clean: 'zmenil si ho ty aj nová verzia, ale každý na inom mieste: spojím to automaticky',
  conflicts: (n) => `ty aj nová verzia ste zmenili tie isté miesta (${plural(n, 'miesto', 'miesta', 'miest')})`,
  binary: 'zmenil si ho ty aj nová verzia a nie je to text, neviem ho spojiť',
  'no-base': 'zmenil si ho ty aj nová verzia a nemám pôvodnú verziu na porovnanie',
  unknown: 'líši sa od novej verzie a neviem, kto ho zmenil (chýba pôvodná verzia)',
  'add-exists': 'nová verzia pridáva súbor, ktorý už máš s iným obsahom',
  'deleted-local': 'ty si ho zmazal, nová verzia ho mení',
  'deleted-upstream': 'nová verzia ho ruší, ty si ho upravil',
}

const FAIL = {
  offline: 'Neviem stiahnuť novú verziu: nie som pripojený na internet.',
  'not-found': 'Neviem stiahnuť novú verziu: zdroj aktualizácií sa nenašiel.',
  'source-missing': 'Lokálny zdroj aktualizácií (JARVIS_UPDATE_SOURCE) neexistuje.',
  'bad-archive': 'Stiahnutý balík sa nedal rozbaliť alebo v ňom nie je Jarvis.',
}

/** dependencies of a package.json as one comparable string. */
export function depsKey(buf) {
  try {
    const pkg = JSON.parse(buf.toString('utf8'))
    return JSON.stringify(['dependencies', 'devDependencies', 'optionalDependencies'].map((k) => Object.entries(pkg[k] ?? {}).sort()))
  } catch {
    return ''
  }
}

/** Keys of a JSON object, nested objects as "a.b". Arrays count as values. */
function jsonKeys(buf) {
  const out = new Set()
  const visit = (value, prefix) => {
    for (const [key, v] of Object.entries(value)) {
      out.add(prefix + key)
      if (v && typeof v === 'object' && !Array.isArray(v)) visit(v, `${prefix}${key}.`)
    }
  }
  try {
    const parsed = JSON.parse(buf.toString('utf8'))
    if (parsed && typeof parsed === 'object') visit(parsed, '')
  } catch {
    // not JSON: no keys
  }
  return out
}

/** Variable names in an env file, commented out ones included. */
const envKeys = (buf) => new Set([...String(buf ?? '').matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]{2,})\s*=/gm)].map((m) => m[1]))

/** New settings upstream offers that the user does not have yet. */
function newSettings() {
  const pick = (rel, read, userFile) => {
    const next = readBuf(abs(rel, P.incoming))
    const user = readBuf(userFile)
    if (!next || !user) return []
    const before = read(readBuf(abs(rel, P.base)) ?? readBuf(abs(rel)) ?? Buffer.alloc(0))
    const have = read(user)
    return [...read(next)].filter((key) => !before.has(key) && !have.has(key)).sort()
  }
  return {
    newConfigKeys: pick('config/jarvis.example.json', jsonKeys, process.env.JARVIS_CONFIG || join(REPO, 'config', 'jarvis.json')),
    newEnvKeys: pick('.env.example', envKeys, join(REPO, '.env')),
  }
}

/** Notes the author wrote for Claude: updates/<version>.md for every version on the way. */
function migrations(from, to) {
  let names = []
  try {
    names = readdirSync(join(P.incoming, 'updates'))
  } catch {
    names = []
  }
  return names
    .map((name) => /^v?(\d+\.\d+\.\d+)\.md$/.exec(name))
    .filter((m) => m && cmpVersion(m[1], from) > 0 && cmpVersion(m[1], to) <= 0)
    .sort((a, b) => cmpVersion(a[1], b[1]))
    .map((m) => ({ version: m[1], file: `updates/${m[0]}`, text: (readBuf(join(P.incoming, 'updates', m[0])) ?? '').toString('utf8').slice(0, 8000) }))
}

export async function plan({ force = false } = {}) {
  if (readJson(P.session)?.phase === 'applying') {
    return { ok: false, reason: 'interrupted', summary: 'Predošlá aktualizácia sa prerušila uprostred zápisu. Najprv ju vráť späť: node scripts/update.mjs rollback' }
  }
  if (readJson(P.session)?.phase === 'applied') {
    return { ok: false, reason: 'in-progress', summary: 'Jedna aktualizácia je rozrobená. Dokonči ju (node scripts/update.mjs finish) alebo ju vráť späť (node scripts/update.mjs rollback).' }
  }
  const up = upstream()
  const got = await fetchIncoming(up)
  if (!got.ok) return { ok: false, reason: got.reason, summary: FAIL[got.reason] ?? `Neviem stiahnuť novú verziu (${got.reason}).` }
  // A downloaded version is installed only when the author signed exactly these files.
  if (!up.source && process.env.JARVIS_UPDATE_UNSIGNED !== '1') {
    const signed = verifyRelease(P.incoming)
    if (!signed.ok) {
      rmDir(P.incoming)
      return { ok: false, reason: signed.reason, summary: `Novú verziu neinštalujem: ${signed.detail}. Stiahnutý balík nie je to, čo vydal autor Jarvisa. Skús to neskôr; ak sa to zopakuje, daj mu vedieť.` }
    }
  }
  const incoming = treeManifest(P.incoming)
  if (!incoming) return { ok: false, reason: 'bad-archive', summary: FAIL['bad-archive'] }

  const baseline = await ensureBaseline({ fetch: true, incomingDir: P.incoming })
  const current = { version: currentVersion(baseline), base: baseline.kind === 'none' ? null : baseline.version }
  const latest = { version: incoming.version, released: incoming.released }
  if (cmpVersion(latest.version, current.version) <= 0 && !force) {
    rmDir(P.incoming)
    rmDir(P.plan)
    return { ok: true, available: false, current, latest, summary: `Máš najnovšiu verziu Jarvisa (${current.version}). Nie je čo aktualizovať.` }
  }

  const missing = new Set(baseline.missing)
  const out = { update: [], add: [], remove: [], keep: [], conflict: [] }
  const hashes = {}
  let same = 0
  for (const rel of [...new Set([...Object.keys(baseline.files), ...Object.keys(incoming.files)])].sort()) {
    if (isProtected(rel) || rel === MANIFEST) continue
    const B = baseline.files[rel] ?? null
    const I = incoming.files[rel] ?? null
    const localBuf = readBuf(abs(rel))
    const L = localBuf ? fileHash(localBuf) : null
    if (L === I) {
      same++
      continue
    }
    let kind = null
    if (isGenerated(rel) && I) kind = L === null ? 'add' : 'update'
    else if (B && I) {
      if (L === null) kind = I === B ? 'keep' : 'deleted-local'
      else if (L === B) kind = 'update'
      else if (I === B) kind = 'keep'
      else kind = 'both'
    } else if (B) {
      kind = L === B ? 'remove' : 'deleted-upstream'
    } else {
      kind = L === null ? 'add' : baseline.kind === 'none' ? 'unknown' : 'add-exists'
    }
    if (kind === 'keep') {
      out.keep.push(rel)
      continue
    }
    hashes[rel] = L
    if (kind === 'update' || kind === 'add' || kind === 'remove') {
      out[kind].push(rel)
      continue
    }
    if (kind === 'both' || kind === 'add-exists' || kind === 'unknown') {
      const base = kind === 'both' && !missing.has(rel) ? readBuf(abs(rel, P.base)) : null
      const res = await mergeFile({ local: localBuf, base, incoming: readBuf(abs(rel, P.incoming)) })
      const why = kind === 'add-exists' ? WHY['add-exists'] : kind === 'unknown' ? WHY.unknown : res.auto === 'conflicts' ? WHY.conflicts(res.conflicts) : WHY[res.auto]
      out.conflict.push({ path: rel, kind, auto: res.auto, hunks: res.auto === 'clean' ? 0 : res.conflicts, engine: res.engine, why })
    } else {
      out.conflict.push({ path: rel, kind, auto: 'deleted', hunks: 1, engine: null, why: WHY[kind] })
    }
  }

  const shipped = new Set([...Object.keys(baseline.files), ...Object.keys(incoming.files), MANIFEST])
  const own = walk(REPO, { keep: (rel) => !shipped.has(rel) })
  const mine = own.slice(0, MINE_LIMIT)

  const changed = [...out.update, ...out.add, ...out.remove, ...out.conflict.map((c) => c.path)]
  const nextPkg = readBuf(abs('package.json', P.incoming))
  const herePkg = readBuf(abs('package.json'))
  const notes = {
    npmInstall: changed.includes('package-lock.json') || (changed.includes('package.json') && Boolean(nextPkg) && (!herePkg || depsKey(nextPkg) !== depsKey(herePkg))),
    schedule: changed.some((rel) => rel.startsWith('routines/') || SCHEDULE_FILES.has(rel)),
    desktop: changed.some((rel) => rel.startsWith('hud/desktop/')),
    restartHud: changed.some((rel) => rel.startsWith('hud/') || rel === 'package.json'),
    ...newSettings(),
    migrations: migrations(current.version, latest.version),
    list: [],
  }
  if (notes.npmInstall) notes.list.push('Menia sa balíčky: po aktualizácii treba npm install (finish to spraví sám).')
  if (notes.schedule) notes.list.push('Menia sa rutiny alebo ich plánovanie: po aktualizácii ich znova zaregistruj (node scripts/schedule.mjs install).')
  if (notes.desktop) notes.list.push('Mení sa appka na plochu pre macOS: po aktualizácii ju treba znova zostaviť (sh hud/desktop/build.sh --open).')
  if (notes.restartHud) notes.list.push('Mení sa HUD: po aktualizácii ho reštartuj (node scripts/hud.mjs --restart).')
  if (notes.newConfigKeys.length) notes.list.push(`Nové nastavenia v config/jarvis.example.json, ktoré v config/jarvis.json nemáš: ${notes.newConfigKeys.join(', ')}.`)
  if (notes.newEnvKeys.length) notes.list.push(`Nové voľby v .env.example: ${notes.newEnvKeys.join(', ')}.`)
  if (notes.migrations.length) notes.list.push(`Poznámky autora k verziám ${notes.migrations.map((m) => m.version).join(', ')}: prečítaj ich a sprav, čo hovoria (${notes.migrations.map((m) => m.file).join(', ')}).`)

  const warnings = []
  if (baseline.kind === 'none') warnings.push('Táto inštalácia nemá zoznam súborov svojej verzie (jarvis.manifest.json), takže neviem, čo si menil ty. Každý súbor, ktorý sa líši od novej verzie, beriem ako tvoju úpravu a nič neprepíšem bez spojenia.')
  if (baseline.kind === 'partial') warnings.push(`Pri ${plural(baseline.missing.length, 'súbore', 'súboroch', 'súboroch')} sa mi nepodarilo získať pôvodnú verziu. Ak sa menili aj v novej verzii, porovnám len tvoju a novú.`)
  if (incoming.stale) warnings.push(`Zoznam súborov v novej verzii nesedí s jej obsahom (${incoming.stale}×). Riadim sa skutočnými súbormi.`)
  if (cmpVersion(latest.version, current.version) <= 0) warnings.push(`Nová verzia (${latest.version}) nie je novšia než tvoja (${current.version}). Porovnávam súbory, lebo si to vyžiadal cez --force.`)

  const clean = out.conflict.filter((c) => c.auto === 'clean').length
  const hard = out.conflict.length - clean
  const bits = []
  if (out.update.length) bits.push(`${plural(out.update.length, 'súbor sa aktualizuje', 'súbory sa aktualizujú', 'súborov sa aktualizuje')}`)
  if (out.add.length) bits.push(`${plural(out.add.length, 'pribudne', 'pribudnú', 'pribudne')}`)
  if (out.remove.length) bits.push(`${plural(out.remove.length, 'sa odstráni', 'sa odstránia', 'sa odstráni')}`)
  if (clean) bits.push(`${plural(clean, 'tvoj upravený súbor spojím', 'tvoje upravené súbory spojím', 'tvojich upravených súborov spojím')} s novou verziou automaticky`)
  if (hard) bits.push(`${plural(hard, 'súbor treba spojiť ručne', 'súbory treba spojiť ručne', 'súborov treba spojiť ručne')}`)
  const kept = out.keep.length ? ` ${plural(out.keep.length, 'tvoja úprava ostáva', 'tvoje úpravy ostávajú', 'tvojich úprav ostáva')} bez zmeny.` : ''
  const summary = `Verzia ${latest.version} (máš ${current.version}): ${bits.length ? bits.join(', ') : 'žiadny súbor sa nemení'}.${kept} Pamäť, nastavenie a .env sa nedotknú.`

  const changelog = changelogSince((readBuf(abs('CHANGELOG.md', P.incoming)) ?? '').toString('utf8'), current.version, latest.version).slice(0, 6000)
  const result = {
    ok: true,
    schema: SCHEMA,
    at: new Date().toISOString(),
    available: true,
    mode: installMode(),
    source: up.label,
    baseline: baseline.kind,
    current,
    latest,
    counts: { update: out.update.length, add: out.add.length, remove: out.remove.length, keep: out.keep.length, conflict: out.conflict.length, autoMerge: clean, manual: hard, mine: own.length, same },
    ...out,
    mine,
    mineMore: own.length - mine.length,
    notes,
    warnings,
    changelog,
    summary,
    hashes,
  }
  writeJson(P.plan, result)
  return result
}
