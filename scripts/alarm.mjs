#!/usr/bin/env node
/**
 * Jarvis's alarm clock. At the set time he plays a chime and says the morning brief out loud
 * through the computer's speakers, whether the HUD window is open or not. A few minutes earlier
 * Claude prepares the brief (routines/budik.md): sleep when it is known, weather, today's
 * calendar, deadlines and what Jarvis did overnight. Without Claude (no network, no subscription)
 * he still says a shorter brief straight from the memory.
 *
 *   node scripts/alarm.mjs                          the alarm now (also --json)
 *   node scripts/alarm.mjs set 06:30                every day at 6:30
 *   node scripts/alarm.mjs set 06:30 --days weekdays    daily | weekdays | weekend | po,st,pi
 *   node scripts/alarm.mjs set 06:30 --call         also ring the mobile (docs/HOVORY.md), --no-call turns it off
 *   node scripts/alarm.mjs off | on                 turn it off or back on
 *   node scripts/alarm.mjs test                     wake me now: prepare the brief with Claude and ring
 *   node scripts/alarm.mjs test --quick             ring now with the short brief from memory, no Claude
 *   node scripts/alarm.mjs ring                     what the system scheduler runs at the alarm time
 *
 * The time lives in config/jarvis.json under "alarm". `set`, `on` and `off` register it in the
 * system scheduler right away (scripts/schedule.mjs install).
 */
// .env first: the modules below read JARVIS_MEMORY_DIR and JARVIS_DATA_DIR when they load.
import '../hud/server/env.mjs'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { daysLabel, markRang, nextAlarmAt, nightStart, overnightWork, parseAlarm, readPrepared, weekdaysOf } from '../hud/server/alarm.mjs'
import { callReady } from '../hud/server/call.mjs'
import { CONFIG_FILE, getConfig } from '../hud/server/config.mjs'
import { calendarRange } from '../hud/server/memory/calendar.mjs'
import { dayStats, getIndex, todos } from '../hud/server/memory/index.mjs'
import { getWeather } from '../hud/server/weather.mjs'
import { addDays, isoDay } from '../hud/server/util.mjs'
import { DATA_DIR, IS_MAC, IS_WIN, LOG_DIR, REPO, callOut, hudAlive, notify, postHud, sh } from './lib.mjs'

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')[0]))
const value = (name) => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i < 0) return null
  return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1] ?? null
}
const rest = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && /^--(days)$/.test(argv[i - 1])))
const action = rest[0] ?? 'status'
const asJson = flags.has('json')

mkdirSync(LOG_DIR, { recursive: true })
const log = (msg) => appendFileSync(join(LOG_DIR, 'alarm.log'), `${new Date().toISOString()} ${msg}\n`)

// ── spoken Slovak ───────────────────────────────────────────────────────

const HOURS = ['dvanásť', 'jedna', 'dve', 'tri', 'štyri', 'päť', 'šesť', 'sedem', 'osem', 'deväť', 'desať', 'jedenásť', 'dvanásť', 'trinásť', 'štrnásť', 'pätnásť', 'šestnásť', 'sedemnásť', 'osemnásť', 'devätnásť', 'dvadsať', 'dvadsaťjeden', 'dvadsaťdva', 'dvadsaťtri']
const AT_HOURS = ['o polnoci', 'o jednej', 'o druhej', 'o tretej', 'o štvrtej', 'o piatej', 'o šiestej', 'o siedmej', 'o ôsmej', 'o deviatej', 'o desiatej', 'o jedenástej', 'o dvanástej', 'o trinástej', 'o štrnástej', 'o pätnástej', 'o šestnástej', 'o sedemnástej', 'o osemnástej', 'o devätnástej', 'o dvadsiatej', 'o dvadsiatej prvej', 'o dvadsiatej druhej', 'o dvadsiatej tretej']
const minutesWord = (m) => (m === 0 ? '' : m < 10 ? ` nula ${m}` : ` ${m}`)
/** "06:30" → "šesť 30" (the voice reads the number), for "Je …". */
const clockSpoken = (h, m) => `${HOURS[h]}${minutesWord(m)}`
/** "09:30" → "o deviatej 30", for events. */
const atSpoken = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? '')
  return m ? `${AT_HOURS[Number(m[1])] ?? `o ${m[1]}`}${minutesWord(Number(m[2]))}` : ''
}
const degrees = (n) => {
  const a = Math.abs(n)
  const word = a === 1 ? 'stupeň' : a >= 2 && a <= 4 ? 'stupne' : 'stupňov'
  return `${n < 0 ? 'mínus ' : ''}${a} ${word}`
}
const list = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} a ${items.at(-1)}`)

// ── config ──────────────────────────────────────────────────────────────

function readRawConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeAlarm(alarm) {
  const raw = readRawConfig() ?? {}
  raw.alarm = alarm
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, `${JSON.stringify(raw, null, 2)}\n`)
}

/** Registers the alarm (and everything else) in the system scheduler. */
async function register() {
  if (!IS_MAC && !IS_WIN) return { ok: false, detail: 'Plánovanie je pripravené pre macOS a Windows.' }
  const res = await sh(process.execPath, [join(REPO, 'scripts', 'schedule.mjs'), 'install'], { timeout: 120_000 })
  const failed = res.out.split('\n').filter((l) => /✗/.test(l))
  return { ok: res.code === 0 && !failed.length, detail: failed.join(' ').trim() || null }
}

function describe(alarm) {
  if (!alarm) return 'Budík nie je nastavený.'
  if (!alarm.enabled) return `Budík je vypnutý (bol nastavený na ${alarm.time}).`
  const next = nextAlarmAt(alarm)
  const when = next ? (isoDay(next) === isoDay() ? 'dnes' : isoDay(next) === addDays(isoDay(), 1) ? 'zajtra' : `${next.getDate()}. ${next.getMonth() + 1}.`) : null
  return `Budík: ${alarm.time} ${daysLabel(alarm.days)}${alarm.call ? ', aj hovorom na mobil' : ''}.${when ? ` Najbližšie ${when} o ${alarm.time}.` : ''}`
}

/** What the user must know so the alarm really rings. */
function caveats(alarm) {
  const out = []
  if (IS_MAC) out.push('Počítač musí ostať zapnutý: MacBook nechaj otvorený a v zásuvke. Pred budíkom ho Jarvis nenechá zaspať, zatvorené veko ho ale uspí.')
  if (IS_WIN) out.push('Počítač nechaj zapnutý alebo v režime spánku a v zásuvke, Windows ho na budík zobudí. Vypnutý ani v režime hibernácie nezazvoní.')
  out.push('Zvuk z reproduktorov nesmie byť úplne vypnutý.')
  if (alarm?.call && !callReady()) out.push('Hovory ešte nie sú nastavené, takže budík zavolá až po nastavení (docs/HOVORY.md).')
  return out
}

// ── the brief without Claude ────────────────────────────────────────────

/** A short spoken brief straight from the memory: no Claude, no network except the weather. */
async function quickBrief(cfg, now = new Date()) {
  const you = (formal, informal) => (cfg.formal !== false ? formal : informal)
  const today = isoDay(now)
  const parts = []

  try {
    const ix = await getIndex()
    const days = dayStats(ix, { since: addDays(today, -1) }).filter((d) => Number.isFinite(d.sleepMin))
    const last = days.at(-1)
    if (last) {
      const h = Math.floor(last.sleepMin / 60)
      const m = last.sleepMin % 60
      parts.push(`Podľa denníka ${you('ste spali', 'si spal')} ${h} ${h === 1 ? 'hodinu' : h >= 2 && h <= 4 ? 'hodiny' : 'hodín'}${m ? ` a ${m} minút` : ''}.`)
    }
  } catch {
    // no memory yet
  }

  try {
    const w = await getWeather(cfg.city, 1)
    parts.push(`Vonku ${Math.abs(w.tempC) >= 2 && Math.abs(w.tempC) <= 4 ? 'sú' : 'je'} ${degrees(w.tempC)}, ${w.text}${Number.isFinite(w.highC) ? `, cez deň najviac ${degrees(w.highC)}` : ''}.`)
  } catch {
    // offline: no weather
  }

  try {
    const events = await calendarRange(today, today)
    const timed = events.filter((e) => e.time && e.kind !== 'birthday' && e.kind !== 'nameday').slice(0, 3)
    const people = events.filter((e) => e.kind === 'birthday').map((e) => e.person).slice(0, 2)
    if (timed.length) parts.push(`Dnes ${you('vás', 'ťa')} čaká ${list(timed.map((e) => `${atSpoken(e.time)} ${e.title.replace(/^!+\s*/, '')}`))}.`)
    if (people.length) parts.push(`Narodeniny má dnes ${list(people)}.`)
  } catch {
    // no calendar
  }

  try {
    const due = (await todos()).filter((t) => !t.done && t.due && t.due <= today).slice(0, 3)
    if (due.length) parts.push(`Dnes treba stihnúť: ${list(due.map((t) => t.text.replace(/[.!]+$/, '')))}.`)
  } catch {
    // no tasks
  }

  const night = overnightWork({ since: nightStart(now), now })
  const done = night.jobs.filter((j) => j.status === 'done').map((j) => j.title)
  const waiting = night.jobs.filter((j) => j.status === 'needs_ok').map((j) => j.title)
  if (done.length) parts.push(`Kým ${you('ste spali', 'si spal')}, dokončil som ${done.length === 1 ? 'úlohu' : 'úlohy'} ${list(done)}.`)
  if (waiting.length) parts.push(`Na ${you('váš', 'tvoj')} súhlas čaká ${list(waiting)}.`)
  if (night.inbox.length && !done.length) parts.push(`Cez noc pribudlo v schránke ${night.inbox.length === 1 ? `${night.inbox[0].title}` : `${night.inbox.length} výsledkov rutín`}.`)

  if (parts.length <= 1) parts.push(`Na dnes v pamäti nič nemám. Keď ${you('mi poviete', 'mi povieš')}, čo ${you('vás', 'ťa')} čaká, budem to vedieť.`)
  return parts.join(' ')
}

function greeting(cfg, now = new Date()) {
  const address = String(cfg.address ?? '').trim()
  const hello = now.getHours() < 10 ? 'Dobré ráno' : now.getHours() < 18 ? 'Dobrý deň' : 'Dobrý večer'
  return `${hello}${address ? `, ${address}` : ''}. Je ${clockSpoken(now.getHours(), now.getMinutes())}.`
}

// ── ring ────────────────────────────────────────────────────────────────

async function waitForPrepared(day, ms) {
  const lock = join(DATA_DIR, 'routine-budik.lock')
  const until = Date.now() + ms
  for (;;) {
    const ready = readPrepared(day)
    if (ready) return ready
    let running = false
    try {
      running = Date.now() - statSync(lock).mtimeMs < 30 * 60_000
    } catch {
      running = false
    }
    if (!running || Date.now() > until) return null
    await new Promise((r) => setTimeout(r, 4000))
  }
}

async function ring({ test = false, quick = false } = {}) {
  const cfg = getConfig()
  const alarm = cfg.alarm
  const now = new Date()
  const day = isoDay(now)
  log(`${test ? 'skúška' : 'budík'} zvoní`)
  if (!test) markRang(now)

  // The brief Claude prepared a few minutes ago. When it is still being written, give it a moment.
  const prepared = quick ? null : await waitForPrepared(day, test ? 0 : 3 * 60_000)
  const body = prepared?.say || (await quickBrief(cfg, now))
  const spoken = `${greeting(cfg, now)} ${body}`.replace(/\s+/g, ' ').trim()
  log(prepared ? 'brief od Clauda' : 'krátky brief z pamäte')

  // The HUD shows the card (and the written brief), the speakers say it: an alarm must not depend on an open window.
  if (await hudAlive()) {
    await postHud('/api/announce', { title: prepared?.title || 'Dobré ráno', text: (prepared?.text || body).replace(/^#+\s*/gm, '').replace(/[*_`>]/g, '').trim(), say: spoken, node: 'rutiny', icon: 'alarm', silent: true })
  }
  await notify('Jarvis: Dobré ráno', body)

  const phone = alarm?.call ? spoken : prepared?.call || ''
  if (phone && callReady()) {
    callOut(phone, 'budik')
    log('volám na mobil')
  }

  const { speakLocal } = await import('../hud/server/speak.mjs')
  const res = await speakLocal(spoken, { chime: true, force: true })
  log(res.ok ? `povedané (${res.via})` : 'nepodarilo sa prehrať zvuk')
  return { ok: res.ok, via: res.via, prepared: Boolean(prepared), text: spoken }
}

/** `test`: what the user hears tomorrow, now. Without --quick Claude prepares the brief first. */
async function test() {
  if (!flags.has('quick')) {
    if (!asJson) console.log('Pripravujem ranný brief (jedna až tri minúty)…')
    const res = await sh(process.execPath, [join(REPO, 'scripts', 'routine.mjs'), 'budik', '--prepare', '--now'], { timeout: 25 * 60_000 })
    if (res.code !== 0 && !asJson) console.log('Claude brief nepripravil, poviem krátky brief z pamäte. Podrobnosti: data/logs/routine-budik.log')
  }
  return ring({ test: true, quick: flags.has('quick') })
}

// ── main ────────────────────────────────────────────────────────────────

const out = (data, text) => {
  if (asJson) console.log(JSON.stringify(data, null, 2))
  else console.log(text)
}

if (action === 'set') {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(rest[1] ?? '')
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    console.error('Napíš čas v tvare 06:30. Napríklad: node scripts/alarm.mjs set 06:30 --days weekdays')
    process.exit(1)
  }
  const prev = getConfig().alarm
  const days = value('days') ?? prev?.days ?? 'daily'
  if (value('days') && !weekdaysOf(days) && !/^(daily|denne)$/i.test(days)) {
    console.error('Dni: daily, weekdays, weekend alebo zoznam ako po,st,pi.')
    process.exit(1)
  }
  const alarm = parseAlarm({ time: `${m[1]}:${m[2]}`, days, enabled: true, call: flags.has('call') ? true : flags.has('no-call') ? false : prev?.call === true, prepare: prev?.prepare })
  writeAlarm(alarm)
  const reg = await register()
  log(`nastavený ${alarm.time} ${alarm.days}`)
  const notes = caveats(alarm)
  out({ ok: reg.ok, alarm, next: nextAlarmAt(alarm)?.toISOString() ?? null, summary: describe(alarm), registered: reg.ok, problem: reg.detail, notes }, [describe(alarm), reg.ok ? 'Zapísané v systéme, zazvoní aj keď je Claude aj HUD zatvorený.' : `Do systému sa ho nepodarilo zapísať: ${reg.detail ?? 'pozri node scripts/schedule.mjs status'}`, ...notes].join('\n'))
  process.exit(reg.ok ? 0 : 1)
} else if (action === 'off' || action === 'on') {
  const prev = getConfig().alarm
  if (!prev) {
    out({ ok: false, summary: 'Budík ešte nie je nastavený.' }, 'Budík ešte nie je nastavený. Nastavíš ho: node scripts/alarm.mjs set 06:30')
    process.exit(1)
  }
  const alarm = { ...prev, enabled: action === 'on' }
  writeAlarm(alarm)
  const reg = await register()
  out({ ok: reg.ok, alarm, summary: describe(alarm), problem: reg.detail }, describe(alarm))
  process.exit(reg.ok ? 0 : 1)
} else if (action === 'ring' || action === 'test') {
  const res = action === 'ring' ? await ring() : await test()
  out(res, res.ok ? `Zazvonil som a povedal:\n${res.text}` : `Text budíka:\n${res.text}\n\nZvuk sa nepodarilo prehrať. Pozri data/logs/alarm.log.`)
  process.exit(res.ok ? 0 : 1)
} else if (action === 'preview') {
  // The short brief from memory as text, without a sound (used by tests and the onboarding).
  const cfg = getConfig()
  const text = `${greeting(cfg)} ${await quickBrief(cfg)}`
  out({ ok: true, text }, text)
  process.exit(0)
} else {
  const alarm = getConfig().alarm
  const prepared = readPrepared()
  out({ ok: true, alarm, next: nextAlarmAt(alarm)?.toISOString() ?? null, summary: describe(alarm), preparedToday: Boolean(prepared), notes: alarm?.enabled ? caveats(alarm) : [] }, [describe(alarm), alarm?.enabled ? caveats(alarm).join('\n') : 'Nastavíš ho: node scripts/alarm.mjs set 06:30 (alebo povedz Jarvisovi „zobuď ma o 6:30").'].join('\n'))
  process.exit(0)
}

