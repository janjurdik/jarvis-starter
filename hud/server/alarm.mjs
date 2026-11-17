/**
 * The alarm clock and the night: what the scripts and the HUD share about waking the user up.
 *
 *   config/jarvis.json  "alarm": { "time": "06:30", "days": "weekdays", "enabled": true, "call": false, "prepare": 20 }
 *
 * The system scheduler runs two things (scripts/schedule.mjs): the routine `budik` with --prepare
 * a few minutes ahead (Claude writes the morning brief, silently) and `scripts/alarm.mjs ring` at
 * the alarm time (a chime and the brief out loud through the computer's speakers, HUD or not).
 *
 * Quiet hours end for the day once the alarm has rung: the user is up, reminders may speak again.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MEMORY_DIR, FOLDERS, parseFrontmatter } from './memory/index.mjs'
import { BRAIN_DIR, DATA_DIR, addDays, hhmm, isoDay } from './util.mjs'

export const ALARM_DIR = join(DATA_DIR, 'alarm')
const RANG_FILE = join(ALARM_DIR, 'rang.json')
export const preparedFile = (day) => join(ALARM_DIR, `${day}.json`)

const WD = { ne: 0, po: 1, ut: 2, st: 3, 'št': 4, stv: 4, pi: 5, so: 6, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
export const WD_NAMES = ['ne', 'po', 'ut', 'st', 'št', 'pi', 'so']

/** "daily" → null (every day), otherwise the list of weekdays (0 = Sunday). Same rules as routines. */
export function weekdaysOf(days) {
  const rule = String(days ?? 'daily').toLowerCase().trim()
  if (rule === 'daily' || rule === 'denne' || rule === '') return null
  if (rule === 'weekdays' || rule === 'po-pi' || rule === 'pracovne') return [1, 2, 3, 4, 5]
  if (rule === 'weekend' || rule === 'vikend' || rule === 'víkend') return [6, 0]
  const list = rule.split(/[\s,]+/).map((t) => WD[t]).filter((n) => n !== undefined)
  return list.length ? [...new Set(list)] : null
}

/** How the days read in a sentence: "každý deň", "v pracovné dni", "cez víkend", "po, st, pi". */
export function daysLabel(days) {
  const wd = weekdaysOf(days)
  if (!wd) return 'každý deň'
  const key = [...wd].sort().join(',')
  if (key === '1,2,3,4,5') return 'v pracovné dni'
  if (key === '0,6') return 'cez víkend'
  return [...wd].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WD_NAMES[d]).join(', ')
}

/** The alarm from the raw config value, or null when there is none. */
export function parseAlarm(raw) {
  if (!raw || typeof raw !== 'object') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw.time ?? '').trim())
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null
  return {
    time: `${m[1].padStart(2, '0')}:${m[2]}`,
    days: typeof raw.days === 'string' && raw.days.trim() ? raw.days.trim() : 'daily',
    enabled: raw.enabled !== false,
    call: raw.call === true,
    // Minutes ahead of the alarm when Claude prepares the spoken brief.
    prepare: Math.min(90, Math.max(5, Math.round(Number(raw.prepare) || 20))),
    // What the user wants to hear after the alarm, in this order (routines/budik.md). Empty = the default brief.
    rano: Array.isArray(raw.rano) ? raw.rano.filter((t) => RANO.has(t)) : [],
  }
}

/** Topics of the morning brief the user can choose (scripts/alarm.mjs set … --rano pocasie,den,posta). */
export const RANO_TOPICS = {
  spanok: 'ako som spal',
  pocasie: 'počasie',
  den: 'čo ma dnes čaká',
  ulohy: 'úlohy a termíny',
  posta: 'maily, ktoré čakajú na odpoveď',
  skola: 'škola: hodiny, testy a odovzdávky',
  trening: 'tréning na dnes',
  ludia: 'narodeniny a meniny mojich ľudí',
  noc: 'čo Jarvis spravil, kým som spal',
  svet: 'tri správy zo sveta',
  peniaze: 'výdavky a čo sa obnovuje',
  citat: 'jedna myšlienka na deň',
}
const RANO = new Set(Object.keys(RANO_TOPICS))

/** The next moment the alarm rings after `from`, or null. */
export function nextAlarmAt(alarm, from = new Date()) {
  if (!alarm?.enabled) return null
  const [h, mi] = alarm.time.split(':').map(Number)
  const wd = weekdaysOf(alarm.days)
  for (let i = 0; i <= 7; i++) {
    const at = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, h, mi, 0, 0)
    if (at <= from) continue
    if (!wd || wd.includes(at.getDay())) return at
  }
  return null
}

/**
 * When the brief is prepared: `prepare` minutes before the alarm. Crossing midnight moves the days
 * one back (an alarm at 00:10 on Monday is prepared on Sunday evening).
 */
export function prepareSlot(alarm) {
  const [h, mi] = alarm.time.split(':').map(Number)
  let minutes = h * 60 + mi - alarm.prepare
  let shift = 0
  if (minutes < 0) {
    minutes += 1440
    shift = -1
  }
  const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  const wd = weekdaysOf(alarm.days)
  const days = !wd || !shift ? alarm.days : wd.map((d) => WD_NAMES[(d + 6) % 7]).join(',')
  return { time, days }
}

/** True when HH:MM `date` falls inside a "22:30-07:00" style window (windows over midnight work too). */
export function inWindow(range, date = new Date()) {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(range ?? '').trim())
  if (!m) return false
  const from = Number(m[1]) * 60 + Number(m[2])
  const to = Number(m[3]) * 60 + Number(m[4])
  const now = date.getHours() * 60 + date.getMinutes()
  return from <= to ? now >= from && now < to : now >= from || now < to
}

function rang() {
  try {
    return JSON.parse(readFileSync(RANG_FILE, 'utf8'))
  } catch {
    return null
  }
}

/** The alarm rang: the morning has started, quiet hours are over for today. */
export function markRang(at = new Date()) {
  mkdirSync(ALARM_DIR, { recursive: true })
  writeFileSync(RANG_FILE, JSON.stringify({ day: isoDay(at), at: at.toISOString() }))
}

/** Quiet hours from the config, except the morning after the alarm rang (the user is awake). */
export function quietNow(cfg, date = new Date()) {
  if (!inWindow(cfg?.quiet, date)) return false
  const r = rang()
  if (r?.day === isoDay(date) && date >= new Date(r.at) && date.getHours() < 12) return false
  return true
}

/** The brief Claude prepared for this morning's alarm: { say, text, at } or null. */
export function readPrepared(day = isoDay()) {
  try {
    const data = JSON.parse(readFileSync(preparedFile(day), 'utf8'))
    return data?.say || data?.text ? data : null
  } catch {
    return null
  }
}

export function writePrepared(day, data) {
  mkdirSync(ALARM_DIR, { recursive: true })
  writeFileSync(preparedFile(day), JSON.stringify({ ...data, at: new Date().toISOString() }, null, 1), { mode: 0o600 })
}

/** Since when "the night" counts: yesterday at 18:00. */
export const nightStart = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 18, 0, 0, 0)

/**
 * What Jarvis did while the user slept: background jobs that ended since `since` (data/brain/jobs.json)
 * and results of routines saved in memory/schranka (a watch that found a mail, a summary).
 * Morning briefs are left out, they are what is being prepared.
 */
export function overnightWork({ since = nightStart(), now = new Date() } = {}) {
  const jobs = []
  try {
    const data = JSON.parse(readFileSync(join(BRAIN_DIR, 'jobs.json'), 'utf8'))
    for (const j of data.jobs ?? []) {
      if (!j.endedAt || j.mock || !['done', 'needs_ok', 'error'].includes(j.status)) continue
      const ended = new Date(j.endedAt)
      if (ended < since || ended > now) continue
      jobs.push({ id: j.id, title: j.title, status: j.status, summary: j.summary ?? '', needsOk: j.needsOk ?? '', say: j.say ?? '', endedAt: j.endedAt })
    }
  } catch {
    // no jobs yet
  }
  const inbox = []
  const dir = join(MEMORY_DIR, FOLDERS.inbox)
  const days = new Set([addDays(isoDay(now), -1), isoDay(now)])
  try {
    for (const name of readdirSync(dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(name)
      if (!m || !days.has(m[1]) || /^(budik|ranny-brief)$/.test(m[2])) continue
      const file = join(dir, name)
      if (statSync(file).mtime < since) continue
      const { fm } = parseFrontmatter(readFileSync(file, 'utf8'))
      inbox.push({ title: String(fm.title ?? m[2]), rel: `${FOLDERS.inbox}/${name}` })
    }
  } catch {
    // no inbox yet
  }
  return { jobs, inbox }
}

/** The night's work as lines for a routine's context (empty string when nothing happened). */
export function overnightText(work = overnightWork()) {
  const lines = []
  const state = { done: 'hotová', needs_ok: 'čaká na súhlas používateľa', error: 'zlyhala' }
  for (const j of work.jobs) {
    const detail = j.status === 'needs_ok' ? j.needsOk : j.summary
    lines.push(`- úloha „${j.title}" (${state[j.status]}, skončila o ${hhmm(new Date(j.endedAt).getTime())})${detail ? `: ${detail.replace(/\s+/g, ' ').slice(0, 400)}` : ''}`)
  }
  for (const r of work.inbox) lines.push(`- výsledok rutiny „${r.title}" v memory/${r.rel}`)
  return lines.join('\n')
}
