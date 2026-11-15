/**
 * Is there a newer version upstream? Cheap (two small downloads), safe to call from the HUD server
 * and never throws: being offline is an answer, not an error.
 */
import { MANIFEST, P, cmpVersion, errMsg, installMode, plural, readJson, writeJson } from './core.mjs'
import { currentVersion, customizedPaths, ensureBaseline } from './baseline.mjs'
import { cleanManifest } from './manifest.mjs'
import { readUpstream, upstream } from './source.mjs'

/** Sections of a CHANGELOG.md ("## 1.2.0 (2026-12-01)") newer than `from` and not newer than `to`. */
export function changelogSince(text, from, to = null) {
  const out = []
  let keep = false
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^##\s+\[?v?(\d+\.\d+\.\d+)/.exec(line)
    if (m) keep = cmpVersion(m[1], from) > 0 && (!to || cmpVersion(m[1], to) <= 0)
    else if (/^#\s/.test(line)) keep = false
    if (keep) out.push(line)
  }
  return out.join('\n').trim()
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max).trimEnd()}\n…` : text)

const WHY = {
  offline: 'nie som pripojený na internet',
  'not-found': 'zdroj aktualizácií sa nenašiel',
  'bad-manifest': 'zdroj aktualizácií má poškodený zoznam súborov',
  'source-missing': 'lokálny zdroj aktualizácií neexistuje',
}

async function run() {
  const at = new Date().toISOString()
  const up = upstream()
  let baseline = { kind: 'none', version: null, files: {}, missing: [] }
  try {
    baseline = await ensureBaseline({ fetch: false, retro: true })
  } catch {
    // a baseline that cannot be written (read-only folder) does not stop the check
  }
  const current = { version: currentVersion(baseline), base: baseline.kind === 'none' ? null : baseline.version }
  const customized = baseline.kind === 'none' ? null : customizedPaths(baseline).length
  const rest = { mode: installMode(), customized, source: up.label, inProgress: ['applied', 'applying'].includes(readJson(P.session)?.phase), at }

  let latest = null
  let reason = null
  const man = await readUpstream(MANIFEST, up)
  if (man.ok) {
    let parsed = null
    try {
      parsed = cleanManifest(JSON.parse(man.buf.toString('utf8')))
    } catch {
      parsed = null
    }
    if (parsed) latest = { version: parsed.version, released: parsed.released }
    else reason = 'bad-manifest'
  } else if (man.reason === 'not-found') {
    // An upstream without a manifest (a fork that never ran the release script): package.json still tells the version.
    const pkg = await readUpstream('package.json', up)
    let version = null
    try {
      version = pkg.ok ? JSON.parse(pkg.buf.toString('utf8')).version : null
    } catch {
      version = null
    }
    if (typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version)) latest = { version, released: null }
    else reason = pkg.ok ? 'bad-manifest' : pkg.reason
  } else {
    reason = man.reason
  }

  if (!latest) {
    return { ok: false, reason, current, latest: null, available: false, changelog: '', summary: `Neviem teraz overiť, či je nová verzia: ${WHY[reason] ?? reason}.`, ...rest }
  }

  const available = cmpVersion(latest.version, current.version) > 0
  let changelog = ''
  if (available) {
    const log = await readUpstream('CHANGELOG.md', up)
    if (log.ok) changelog = clip(changelogSince(log.buf.toString('utf8'), current.version, latest.version), 3000)
  }
  const mine = customized ? ` Máš ${plural(customized, 'vlastnú úpravu', 'vlastné úpravy', 'vlastných úprav')}, pri aktualizácii ich zachovám.` : ''
  const summary = available ? `Vyšla nová verzia Jarvisa ${latest.version}, ty máš ${current.version}.${mine} Mám ju nainštalovať?` : `Máš najnovšiu verziu Jarvisa (${current.version}).`
  return { ok: true, current, latest, available, changelog, summary, ...rest }
}

/** Runs the check and remembers the result in data/update/check.json. */
export async function check() {
  let result
  try {
    result = await run()
  } catch (err) {
    result = { ok: false, reason: 'error', detail: errMsg(err), current: null, latest: null, available: false, changelog: '', summary: 'Kontrola aktualizácií zlyhala.', at: new Date().toISOString() }
  }
  try {
    const before = readJson(P.check)
    // A failed try does not erase what the last successful check found.
    if (result.ok || !before?.ok) writeJson(P.check, result)
    else writeJson(P.check, { ...before, lastTry: { at: result.at, reason: result.reason } })
  } catch {
    // the cache is a convenience
  }
  return result
}

/** The last remembered check, or null. */
export const cachedCheck = () => readJson(P.check)
