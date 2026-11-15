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
  /** Hours when Jarvis does not speak on his own, "22:30-07:00". Empty string turns it off. */
  quiet: '22:30-07:00',
  /** The pulse: a check every few minutes that needs no Claude. */
  pulse: { enabled: true, every: 5, eventLead: 15, dueAt: '17:00' },
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
    .map((r) => ({
      id: r.id,
      title: String(r.title ?? r.id),
      time: /^\d{1,2}:\d{2}$/.test(r.time ?? '') ? r.time.padStart(5, '0') : '08:00',
      days: r.days ?? 'daily',
      enabled: r.enabled !== false,
      // A watch routine runs every N minutes instead of at a fixed time, optionally only inside a window ("08:00-22:00").
      ...(Number(r.every) >= 5 ? { every: Math.min(1440, Math.round(Number(r.every))) } : {}),
      ...(/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(r.between ?? '') ? { between: r.between } : {}),
      ...(typeof r.model === 'string' && /^[a-z0-9.-]+$/i.test(r.model) ? { model: r.model } : {}),
      // The spoken result of this routine also arrives as a phone call (docs/HOVORY.md).
      ...(r.call === true ? { call: true } : {}),
    }))
  const p = raw.pulse && typeof raw.pulse === 'object' ? raw.pulse : {}
  value.pulse = {
    enabled: p.enabled !== false,
    every: Math.min(60, Math.max(1, Math.round(Number(p.every) || DEFAULTS.pulse.every))),
    eventLead: Math.min(120, Math.max(1, Math.round(Number(p.eventLead) || DEFAULTS.pulse.eventLead))),
    dueAt: /^\d{1,2}:\d{2}$/.test(p.dueAt ?? '') ? p.dueAt.padStart(5, '0') : DEFAULTS.pulse.dueAt,
  }
  value.quiet = typeof raw.quiet === 'string' ? raw.quiet : DEFAULTS.quiet
  cache = { mtime, value }
  return value
}
