/**
 * The user's apps: what they picked in the orb Tvoje appky, plus apps they typed in by name.
 * Stored in data/apps.json ({ picked, own, at }), so Jarvis in the HUD, the setup and the routines
 * all read the same thing. It lives in data/ and not in config/jarvis.json because the page
 * is used before the onboarding writes the config, and a config file means "Jarvis is set up". The computer scan (data/scan/scan.json)
 * preselects apps it found, and Claude connectors that are already connected are marked as such.
 *
 *   GET  /api/apps   { picked, own, at, detected, connected }
 *   POST /api/apps   { picked?, own? }  → saves, the desktop shows the new icons at once
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { APPS, APP_BY_ID } from '../public/apps/catalog.js'
import { garminConnected } from './garmin/index.mjs'
import { DATA_DIR, clean } from './util.mjs'

const SCAN_FILE = join(DATA_DIR, 'scan', 'scan.json')
export const APPS_FILE = join(DATA_DIR, 'apps.json')

function readSaved() {
  try {
    const raw = JSON.parse(readFileSync(APPS_FILE, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

let scanCache = { mtime: -1, detected: [], connected: [] }

/** Apps the scan found on this computer and connectors that are already connected in Claude. */
function fromScan() {
  let mtime = 0
  try {
    mtime = statSync(SCAN_FILE).mtimeMs
  } catch {
    return { detected: [], connected: [] }
  }
  if (mtime === scanCache.mtime) return scanCache
  let scan = null
  try {
    scan = JSON.parse(readFileSync(SCAN_FILE, 'utf8'))
  } catch {
    return { detected: [], connected: [] }
  }
  const findings = Array.isArray(scan?.findings) ? scan.findings : []
  // Everything the scan says, as one lower-case text. App names are distinctive enough to match on words.
  const text = JSON.stringify([findings.map((f) => [f.title, f.detail, f.data]), scan?.exports ?? []]).toLowerCase()
  const has = (word) => new RegExp(`(^|[^a-z0-9])${word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text)
  const detected = APPS.filter((a) => (a.find ?? []).some(has)).map((a) => a.id)
  const live = findings.find((f) => f.id === 'connectors.list')?.data?.connectors ?? []
  const names = new Set(live.filter((c) => c?.status === 'connected').map((c) => String(c.name).toLowerCase()))
  const connected = APPS.filter((a) => a.how === 'connector' && names.has(String(a.connector).toLowerCase())).map((a) => a.id)
  scanCache = { mtime, detected, connected }
  return scanCache
}

/** Apps the user typed in by name because the catalog does not have them. Plain names, Jarvis works out the rest. */
function cleanOwn(list) {
  const out = []
  for (const name of Array.isArray(list) ? list : []) {
    const n = clean(name, 40)
    if (n && !out.some((x) => x.toLowerCase() === n.toLowerCase()) && out.length < 12) out.push(n)
  }
  return out
}

export function getApps() {
  const raw = readSaved()
  const picked = Array.isArray(raw?.picked) ? raw.picked.filter((id) => APP_BY_ID.has(id)) : []
  const scan = fromScan()
  const detected = scan.detected
  // Garmin is live through the user's own login (scripts/garmin.mjs), not through a Claude connector.
  const connected = garminConnected() ? [...scan.connected, 'garmin'] : scan.connected
  return { picked, own: cleanOwn(raw?.own), at: typeof raw?.at === 'string' ? raw.at : null, detected, connected }
}

/** Saves the selection. Unknown ids are dropped; a field that is not sent stays as it was. */
export function saveApps(body = {}) {
  const prev = readSaved()
  const pick = (list, ok) => [...new Set((Array.isArray(list) ? list : []).filter((id) => typeof id === 'string' && ok(id)))]
  const next = {
    picked: body.picked !== undefined ? pick(body.picked, (id) => APP_BY_ID.has(id)) : pick(prev.picked, (id) => APP_BY_ID.has(id)),
    own: cleanOwn(body.own !== undefined ? body.own : prev.own),
    at: new Date().toISOString(),
  }
  mkdirSync(dirname(APPS_FILE), { recursive: true })
  writeFileSync(APPS_FILE, `${JSON.stringify(next, null, 2)}\n`)
  return getApps()
}
