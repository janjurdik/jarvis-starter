/**
 * User configuration from config/jarvis.json (created by the onboarding, never committed).
 * Re-read when the file changes, so the HUD picks up edits without a restart.
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseAlarm } from './alarm.mjs'
import { REPO } from './util.mjs'
import { isPitch, isRate, isVoiceId, langOf } from './voices.mjs'

export const CONFIG_FILE = process.env.JARVIS_CONFIG || join(REPO, 'config', 'jarvis.json')
export const EXAMPLE_FILE = join(REPO, 'config', 'jarvis.example.json')

const DEFAULTS = {
  name: '',
  address: 'pane',
  formal: true,
  city: 'Bratislava',
  language: 'sk',
  routines: [],
  /** Hours when Jarvis does not speak on his own, "22:30-07:00". Empty string turns it off. */
  quiet: '22:30-07:00',
  /** The activity log: which app was in front, once a minute. hud/server/activity.mjs normalises this block; docs/AKTIVITA.md */
  activity: { enabled: true, titles: false, retentionDays: 90, idleMinutes: 5, ignore: [] },
  /** The pulse: a check every few minutes that needs no Claude. */
  pulse: { enabled: true, every: 5, eventLead: 15, dueAt: '17:00' },
  /** Who the assistant is: the name it answers to and whether it speaks as a man or a woman. */
  assistant: { name: 'Jarvis', gender: 'male' },
  /** The voice: an Edge voice id (null = the default for the language and the assistant's gender), optional rate and pitch. */
  voice: { id: null, rate: null, pitch: null },
  /** How to address the user in gendered words ("pripravený" or "pripravená"): male, female or null when unknown. */
  userGender: null,
  /** Speech recognition: auto (local Whisper when the computer can run it), browser or whisper. */
  stt: 'auto',
}

const GENDERS = ['male', 'female']
/** A short name on one line: letters, digits, spaces and a few signs, at most `max` characters. */
const shortName = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>"`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '')
const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

/**
 * JARVIS_LANG as the user set it in .env (or the shell). It wins over `language` in the config.
 * A value that getConfig() put there itself (see below) does not count: it travels to child
 * processes, and there the config must stay in charge.
 */
const ENV_LANG = process.env.JARVIS_LANG_FROM_CONFIG === '1' ? '' : process.env.JARVIS_LANG || ''
export const LANG_FROM_ENV = Boolean(ENV_LANG)
/** Language of the voice and of speech recognition: sk or cs. */
export const effectiveLang = (cfg = getConfig()) => langOf(ENV_LANG || cfg.language)

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
  value.language = langOf(raw.language)
  // Everything else in Jarvis (and every worker it starts) reads the language from JARVIS_LANG.
  // Without the variable in .env, the config's language stands in for it.
  if (!ENV_LANG) {
    process.env.JARVIS_LANG = value.language
    process.env.JARVIS_LANG_FROM_CONFIG = '1'
  }
  const a = obj(raw.assistant)
  value.assistant = { name: shortName(a.name, 24) || DEFAULTS.assistant.name, gender: GENDERS.includes(a.gender) ? a.gender : DEFAULTS.assistant.gender }
  const v = obj(raw.voice)
  value.voice = { id: isVoiceId(v.id) ? v.id : null, rate: isRate(v.rate) ? v.rate : null, pitch: isPitch(v.pitch) ? v.pitch : null }
  value.userGender = GENDERS.includes(raw.userGender) ? raw.userGender : null
  value.stt = ['auto', 'browser', 'whisper'].includes(raw.stt) ? raw.stt : DEFAULTS.stt
  // The alarm clock (scripts/alarm.mjs). Like routines, only from the user's own config.
  value.alarm = mtime ? parseAlarm(raw.alarm) : null
  cache = { mtime, value }
  return value
}
