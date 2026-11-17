/**
 * The user's apps: what they picked on /apps/ ("Tvoje appky") and what Jarvis should help with.
 * Stored in data/apps.json ({ picked, wants, at }), so the onboarding in Claude, the routines and
 * the HUD all read the same thing. It lives in data/ and not in config/jarvis.json because the page
 * is used before the onboarding writes the config, and a config file means "Jarvis is set up". The computer scan (data/scan/scan.json)
 * preselects apps it found, and Claude connectors that are already connected are marked as such.
 *
 *   GET  /api/apps   { picked, wants, at, detected, connected }
 *   POST /api/apps   { picked?, wants? }  → saves, the desktop shows the new icons at once
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { APPS, APP_BY_ID, WANTS } from '../public/apps/catalog.js'
import { DATA_DIR } from './util.mjs'

const SCAN_FILE = join(DATA_DIR, 'scan', 'scan.json')
export const APPS_FILE = join(DATA_DIR, 'apps.json')
const WANT_IDS = new Set(WANTS.map((w) => w.id))

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

export function getApps() {
  const raw = readSaved()
  const picked = Array.isArray(raw?.picked) ? raw.picked.filter((id) => APP_BY_ID.has(id)) : []
  const wants = Array.isArray(raw?.wants) ? raw.wants.filter((id) => WANT_IDS.has(id)) : []
  const { detected, connected } = fromScan()
  return { picked, wants, at: typeof raw?.at === 'string' ? raw.at : null, detected, connected }
}

/** Saves the selection. Unknown ids are dropped; a field that is not sent stays as it was. */
export function saveApps(body = {}) {
  const prev = readSaved()
  const pick = (list, ok) => [...new Set((Array.isArray(list) ? list : []).filter((id) => typeof id === 'string' && ok(id)))]
  const next = {
    picked: body.picked !== undefined ? pick(body.picked, (id) => APP_BY_ID.has(id)) : pick(prev.picked, (id) => APP_BY_ID.has(id)),
    wants: body.wants !== undefined ? pick(body.wants, (id) => WANT_IDS.has(id)) : pick(prev.wants, (id) => WANT_IDS.has(id)),
    at: new Date().toISOString(),
  }
  mkdirSync(dirname(APPS_FILE), { recursive: true })
  writeFileSync(APPS_FILE, `${JSON.stringify(next, null, 2)}\n`)
  return getApps()
}
