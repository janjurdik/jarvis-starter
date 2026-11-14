/**
 * User configuration from config/jarvis.json (created by the onboarding, never committed).
 * Re-read when the file changes, so the HUD picks up edits without a restart.
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from './util.mjs'

export const CONFIG_FILE = process.env.JARVIS_CONFIG || join(REPO, 'config', 'jarvis.json')
const EXAMPLE_FILE = join(REPO, 'config', 'jarvis.example.json')

const DEFAULTS = {
  name: '',
  address: 'pane',
  formal: true,
  city: 'Bratislava',
  language: 'sk',
  routines: [],
}

let cache = { mtime: -1, value: null }

function read(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function getConfig() {
  let mtime = 0
  try {
    mtime = statSync(CONFIG_FILE).mtimeMs
  } catch {
    mtime = 0
  }
  if (cache.value && cache.mtime === mtime) return cache.value
  const raw = (mtime ? read(CONFIG_FILE) : null) ?? read(EXAMPLE_FILE) ?? {}
  const value = { ...DEFAULTS, ...raw, configured: Boolean(mtime) }
  // Before the onboarding nothing is scheduled: the example routines are only a template.
  value.routines = (mtime && Array.isArray(raw.routines) ? raw.routines : [])
    .filter((r) => r && typeof r.id === 'string' && /^[a-z0-9-]+$/.test(r.id))
    .map((r) => ({ id: r.id, title: String(r.title ?? r.id), time: /^\d{1,2}:\d{2}$/.test(r.time ?? '') ? r.time.padStart(5, '0') : '08:00', days: r.days ?? 'daily', enabled: r.enabled !== false }))
  cache = { mtime, value }
  return value
}
