/**
 * Calendar for the HUD: events from memory/kalendar.md, optional iCal feeds (CALENDAR_ICS_URL,
 * e.g. the secret address of a Google or iCloud calendar) and birthdays / name days of the
 * people in memory/ludia.
 *
 * kalendar.md lines:
 *   - 2026-12-01 14:00-15:00 Zubár @ Poliklinika      one event with time and place
 *   - 2026-12-24 Štedrý deň                           all-day event
 *   - po 10:00-11:30 Prednáška @ A217                 every Monday (po ut st št pi so ne)
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT, addDays, dayStartMs, dowOf, errMsg, isoDay, log } from '../util.mjs'
import { FILES, MEMORY_DIR, getIndex, ofKind } from './index.mjs'

const NAMEDAYS = JSON.parse(readFileSync(join(ROOT, 'server/assets/namedays-sk.json'), 'utf8')).days
const WEEKDAYS = { ne: 0, po: 1, ut: 2, st: 3, 'št': 4, stv: 4, pi: 5, so: 6 }
const ICS_TTL_MS = 10 * 60_000

/** Calendar name of the day (first in the list), e.g. 11-09 → Teodor. */
export function nameDayOf(day) {
  const first = (NAMEDAYS[day.slice(5)] ?? [])[0]
  return first && !/rok|sviatok|deň/i.test(first) ? [first] : []
}

const pad = (n) => String(n).padStart(2, '0')
const timeToMs = (day, time) => {
  const [h, m] = time.split(':').map(Number)
  return dayStartMs(day) + (h * 60 + m) * 60_000
}

function makeEvent({ day, time = null, end = null, title, place = null, kind = 'event', person = null, age = null }) {
  return { day, time, end, allDay: !time, title, place, kind, person, age, startMs: time ? timeToMs(day, time) : dayStartMs(day) }
}

// ── kalendar.md ────────────────────────────────────────────────────────

const LINE = /^\s*[-*]\s+(?:\[.\]\s+)?(\S+)\s+(?:(\d{1,2}:\d{2})(?:\s*[-–]\s*(\d{1,2}:\d{2}))?\s+)?(.+?)\s*$/

async function fileEvents(from, to) {
  let text
  try {
    text = await readFile(join(MEMORY_DIR, FILES.calendar), 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line)
    if (!m) continue
    const [, when, start, end, rest] = m
    const [title, place] = rest.split(/\s+@\s+/)
    const base = { time: start ? start.padStart(5, '0') : null, end: end ? end.padStart(5, '0') : null, title: title.trim(), place: place?.trim() || null }
    if (/^\d{4}-\d{2}-\d{2}$/.test(when)) {
      if (when >= from && when <= to) out.push(makeEvent({ day: when, ...base }))
      continue
    }
    const wd = WEEKDAYS[when.toLowerCase().replace(/[.:,]$/, '')]
    if (wd === undefined) continue
    for (let day = from; day <= to; day = addDays(day, 1)) if (dowOf(day) === wd) out.push(makeEvent({ day, ...base }))
  }
  return out
}

// ── iCal feeds ─────────────────────────────────────────────────────────

const icsCache = new Map()

function unfold(text) {
  return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
}

/** DTSTART value → { day, time|null, ms }. Times with a TZID are taken as local wall time. */
function parseIcsDate(value, params = '') {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, , z] = m
  if (h === undefined || /VALUE=DATE(?!-)/i.test(params)) return { day: `${y}-${mo}-${d}`, time: null, date: new Date(Number(y), Number(mo) - 1, Number(d)) }
  const date = z ? new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi))) : new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi))
  return { day: isoDay(date), time: `${pad(date.getHours())}:${pad(date.getMinutes())}`, date }
}

const unescapeIcs = (s) => String(s ?? '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim()

function parseIcs(text) {
  const events = []
  let cur = null
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') cur = { exdates: [] }
    else if (line === 'END:VEVENT') {
      if (cur?.start && cur.summary) events.push(cur)
      cur = null
    } else if (cur) {
      const at = line.indexOf(':')
      if (at < 0) continue
      const [name, ...params] = line.slice(0, at).split(';')
      const value = line.slice(at + 1)
      const p = params.join(';')
      if (name === 'DTSTART') cur.start = parseIcsDate(value, p)
      else if (name === 'DTEND') cur.end = parseIcsDate(value, p)
      else if (name === 'SUMMARY') cur.summary = unescapeIcs(value)
      else if (name === 'LOCATION') cur.location = unescapeIcs(value)
      else if (name === 'RRULE') cur.rrule = Object.fromEntries(value.split(';').map((kv) => kv.split('=')))
      else if (name === 'EXDATE') for (const v of value.split(',')) cur.exdates.push(parseIcsDate(v, p)?.day)
      else if (name === 'STATUS') cur.status = value
      else if (name === 'RECURRENCE-ID') cur.override = parseIcsDate(value, p)?.day
    }
  }
  return events.filter((e) => e.status !== 'CANCELLED')
}

const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

/** Days in [from, to] on which the event happens (single or a basic RRULE). */
function occurrences(ev, from, to) {
  const first = ev.start.day
  if (!ev.rrule) return first >= from && first <= to ? [first] : []
  const { FREQ, INTERVAL = '1', UNTIL, COUNT, BYDAY: byday } = ev.rrule
  const interval = Math.max(1, Number(INTERVAL) || 1)
  const until = UNTIL ? parseIcsDate(UNTIL)?.day : null
  const last = until && until < to ? until : to
  const days = []
  const wanted = byday ? byday.split(',').map((d) => BYDAY[d.replace(/^[+-]?\d+/, '')]).filter((d) => d !== undefined) : null
  const firstMs = dayStartMs(first)
  const weekOf = (day) => Math.floor((dayStartMs(day) - firstMs + ((dowOf(first) + 6) % 7) * 86_400_000) / (7 * 86_400_000))
  let n = 0
  // COUNT needs the whole series from the first occurrence, otherwise start at the window.
  const startScan = COUNT ? first : first > from ? first : from
  for (let day = startScan; day <= last; day = addDays(day, 1)) {
    if (day < first) continue
    let hit = false
    if (FREQ === 'DAILY') hit = Math.round((dayStartMs(day) - firstMs) / 86_400_000) % interval === 0
    else if (FREQ === 'WEEKLY') hit = (wanted ? wanted.includes(dowOf(day)) : dowOf(day) === dowOf(first)) && weekOf(day) % interval === 0
    else if (FREQ === 'MONTHLY') hit = day.slice(8) === first.slice(8)
    else if (FREQ === 'YEARLY') hit = day.slice(5) === first.slice(5)
    if (!hit) continue
    n++
    if (COUNT && n > Number(COUNT)) break
    if (day >= from && !ev.exdates.includes(day)) days.push(day)
  }
  return days
}

async function icsEvents(from, to) {
  const urls = (process.env.CALENDAR_ICS_URL ?? '').split(/[,\s]+/).filter((u) => /^https?:\/\//.test(u) || u.startsWith('webcal://'))
  const out = []
  for (const raw of urls) {
    const url = raw.replace(/^webcal:\/\//, 'https://')
    let hit = icsCache.get(url)
    if (!hit || Date.now() - hit.at > ICS_TTL_MS) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        hit = { at: Date.now(), events: parseIcs(await res.text()) }
        icsCache.set(url, hit)
      } catch (err) {
        // never log the URL itself: the address is the secret
        log('calendar', `iCal feed sa nenačítal: ${errMsg(err)}`)
        if (!hit) continue
      }
    }
    const overridden = new Set(hit.events.filter((e) => e.override).map((e) => `${e.summary}|${e.override}`))
    for (const ev of hit.events) {
      for (const day of occurrences(ev, from, to)) {
        if (!ev.override && ev.rrule && overridden.has(`${ev.summary}|${day}`)) continue
        const end = ev.end && ev.start.time && ev.end.time ? ev.end.time : null
        out.push(makeEvent({ day, time: ev.start.time, end, title: ev.summary, place: ev.location || null }))
      }
    }
  }
  return out
}

// ── people: birthdays and name days ────────────────────────────────────

async function peopleEvents(from, to) {
  const ix = await getIndex()
  const out = []
  const people = ofKind(ix, 'person')
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const mmdd = day.slice(5)
    const names = (NAMEDAYS[mmdd] ?? []).map((n) => n.toLowerCase())
    for (const p of people) {
      const born = String(p.fm.narodeniny ?? p.fm.birthday ?? '').trim()
      const b = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(born)
      if (b && `${b[2]}-${b[3]}` === mmdd) {
        out.push(makeEvent({ day, title: `${p.title} má narodeniny`, kind: 'birthday', person: p.title, age: b[1] ? Number(day.slice(0, 4)) - Number(b[1]) : null }))
      }
      const first = p.title.split(/\s+/)[0].toLowerCase()
      if (first && names.includes(first)) out.push(makeEvent({ day, title: `${p.title} má meniny`, kind: 'nameday', person: p.title }))
    }
  }
  return out
}

/** All events between two days (inclusive), sorted by day and time. */
export async function calendarRange(from, to) {
  const [a, b, c] = await Promise.all([fileEvents(from, to), icsEvents(from, to), peopleEvents(from, to)])
  const seen = new Set()
  return [...a, ...b, ...c]
    .filter((e) => {
      const key = `${e.day}|${e.time ?? ''}|${e.title.toLowerCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((x, y) => x.day.localeCompare(y.day) || Number(x.allDay) - Number(y.allDay) || (x.time ?? '').localeCompare(y.time ?? '') || x.title.localeCompare(y.title))
}

export async function addEvent({ day, time = null, end = null, title, place = null }) {
  const { appendUnder } = await import('./index.mjs')
  const line = `- ${day}${time ? ` ${time}${end ? `-${end}` : ''}` : ''} ${String(title).trim()}${place ? ` @ ${place}` : ''}`
  await appendUnder(FILES.calendar, 'Udalosti', line)
  return line
}
