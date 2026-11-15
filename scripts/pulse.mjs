#!/usr/bin/env node
/**
 * The pulse: what makes Jarvis speak up without being asked, many times a day, at no cost.
 *
 * The system scheduler runs this script every few minutes (scripts/schedule.mjs registers it).
 * It does not call Claude. It reads the memory folder and decides whether something is due now:
 *
 *   - a reminder from memory/pripomienky.md whose time has come,
 *   - a calendar event that starts in a few minutes,
 *   - tasks with a deadline today that are still open late in the afternoon.
 *
 * When something is due, Jarvis says it in the HUD and sends a system notification. A reminder or
 * an event marked as urgent (text starting with "!") also rings the user's mobile, when calls are
 * set up (docs/HOVORY.md). Each thing is announced once. In quiet hours he neither speaks nor calls.
 *
 *   node scripts/pulse.mjs             run one check now
 *   node scripts/pulse.mjs --dry-run   only print what would be announced
 *   node scripts/pulse.mjs --json      the same as data
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig } from '../hud/server/config.mjs'
import { calendarRange } from '../hud/server/memory/calendar.mjs'
import { MEMORY_DIR, todos } from '../hud/server/memory/index.mjs'
import { isoDay } from '../hud/server/util.mjs'
import { callReady } from '../hud/server/call.mjs'
import { DATA_DIR, LOG_DIR, callOut, hudAlive, inWindow, notify, parseArgs, postHud } from './lib.mjs'

const { flags } = parseArgs()
const dry = flags.has('dry-run')
const cfg = getConfig()
const now = new Date()
const today = isoDay(now)
const minutesNow = now.getHours() * 60 + now.getMinutes()
const DIR = join(DATA_DIR, 'pulse')
const STATE_FILE = join(DIR, 'state.json')
const REMINDERS = join(MEMORY_DIR, 'pripomienky.md')

let state = { fired: {} }
try {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
} catch {
  state = { fired: {} }
}
state.fired ??= {}
const seen = (id) => Boolean(state.fired[id])

const formal = cfg.formal !== false
const you = (formal_, informal) => (formal ? formal_ : informal)
const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
const inMinutes = (n) => (n <= 1 ? 'O chvíľu' : n < 5 ? `O ${n} minúty` : `O ${n} minút`)

/** Things to say now: { id, title, text, say, node, urgent }. A leading "!" marks what is worth a phone call. */
const urgentOf = (s) => ({ urgent: /^!+\s*/.test(s), text: s.replace(/^!+\s*/, '') })
const due = []

// ── reminders: "- [ ] 2026-11-16 15:30 Zavolať mame" ──
let reminderLines = null
try {
  reminderLines = readFileSync(REMINDERS, 'utf8').split(/\r?\n/)
} catch {
  reminderLines = null
}
const firedLines = []
if (reminderLines) {
  reminderLines.forEach((line, i) => {
    const m = /^\s*[-*]\s+(?:\[ \]\s+)?(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?\s+(.+)$/.exec(line)
    if (!m) return
    const [, day, time, raw] = m
    const { urgent, text: what } = urgentOf(raw)
    const at = new Date(`${day}T${(time ?? '09:00').padStart(5, '0')}:00`)
    if (Number.isNaN(at.getTime()) || at > now) return
    const id = `rem|${day}|${time ?? ''}|${raw}`
    if (seen(id)) return
    const late = now - at > 3 * 3600_000
    due.push({ id, title: 'Pripomienka', text: what, say: `${late ? 'Zmeškaná pripomienka' : 'Pripomínam'}: ${what.replace(/[.!]+$/, '')}.`, node: 'kalendar', urgent })
    firedLines.push(i)
  })
}

// ── calendar: an event that starts within the lead time ──
try {
  for (const ev of await calendarRange(today, today)) {
    const start = toMin(ev.time)
    if (start === null || ev.kind === 'birthday' || ev.kind === 'nameday') continue
    const left = start - minutesNow
    if (left < 0 || left > cfg.pulse.eventLead) continue
    const id = `ev|${today}|${ev.time}|${ev.title}`
    if (seen(id)) continue
    const place = ev.place ? `, ${ev.place}` : ''
    const { urgent, text: title } = urgentOf(ev.title)
    due.push({ id, title: `${ev.time} ${title}`, text: `${title}${place}`, say: `${inMinutes(left)} ${you('máte', 'máš')} ${title}${place}.`, node: 'kalendar', urgent })
  }
} catch (err) {
  if (flags.has('json') === false && dry) console.log(`kalendár sa nepodarilo načítať: ${err.message}`)
}

// ── deadlines: open tasks due today, once, late in the afternoon ──
try {
  const dueAt = toMin(cfg.pulse.dueAt)
  const id = `due|${today}`
  if (dueAt !== null && minutesNow >= dueAt && !seen(id)) {
    const open = (await todos()).filter((t) => !t.done && t.due && t.due <= today)
    if (open.length) {
      const names = open.slice(0, 3).map((t) => t.text.replace(/[.!]+$/, ''))
      const more = open.length > 3 ? ` a ${open.length - 3} ďalšie` : ''
      due.push({ id, title: 'Dnešné termíny', text: open.map((t) => t.text).join(' · '), say: `Dnes ${you('máte', 'máš')} ešte termín: ${names.join(', ')}${more}.`, node: 'projekty' })
    }
  }
} catch {
  // no task file yet
}

if (flags.has('json')) console.log(JSON.stringify({ ok: true, at: now.toISOString(), quiet: inWindow(cfg.quiet), due }, null, 2))
else if (dry) console.log(due.length ? due.map((d) => `• ${d.say}`).join('\n') : 'Teraz nie je čo ohlásiť.')
if (dry || !due.length) process.exit(0)

// ── deliver ──
mkdirSync(DIR, { recursive: true })
mkdirSync(LOG_DIR, { recursive: true })
const hush = inWindow(cfg.quiet)
const alive = await hudAlive()
const canCall = !hush && callReady()
for (const d of due) {
  if (d.urgent && canCall) callOut(d.say, 'pulz')
  if (alive) await postHud('/api/announce', { title: d.title, text: d.text, say: d.say, node: d.node, icon: 'alarm', silent: hush })
  await notify(`Jarvis: ${d.title}`, d.say)
  state.fired[d.id] = now.toISOString()
  appendFileSync(join(LOG_DIR, 'pulse.log'), `${now.toISOString()} ${hush ? '(ticho) ' : ''}${d.urgent && canCall ? '(volám) ' : ''}${d.say}\n`)
}

// Reminders that were said are ticked off in the file, so the user sees what is behind them.
if (firedLines.length && reminderLines) {
  for (const i of firedLines) reminderLines[i] = reminderLines[i].replace(/^(\s*[-*]\s+)(?:\[ \]\s+)?/, '$1[x] ')
  writeFileSync(REMINDERS, reminderLines.join('\n'))
}
const cutoff = Date.now() - 3 * 86_400_000
for (const [id, at] of Object.entries(state.fired)) if (new Date(at).getTime() < cutoff) delete state.fired[id]
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
