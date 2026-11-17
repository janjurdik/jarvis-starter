/**
 * Live snapshot for the HUD: everything the panels and the 3D world show at a glance.
 * Built from the local memory folder (people, projects, goals, daily log, to-dos, calendar),
 * config/jarvis.json (name, city, routines) and Open-Meteo (weather). Refreshed on start and
 * every few minutes, pushed to the page over SSE.
 *
 * Privacy: in filming mode `forFilm()` removes people's names, private events and goal names.
 */
import { join } from 'node:path'
import { getConfig } from './config.mjs'
import { calendarRange, nameDayOf } from './memory/calendar.mjs'
import { FOLDERS, dayStats, getIndex, goals, ofKind, sleepScore, stats, todos } from './memory/index.mjs'
import { chatStats } from './chatlog.mjs'
import { send } from './sse.mjs'
import { BRAIN_DIR, DOW_SHORT, addDays, dowOf, errMsg, isoDay, log, writeFileAtomic } from './util.mjs'
import { getWeather } from './weather.mjs'

const LIVE_FILE = join(BRAIN_DIR, 'snapshot.json')
const REFRESH_MS = 3 * 60_000

let live = null
let refreshing = null
let lastOk = null
let lastError = null
let filmNames = []

export const filmNameList = () => filmNames

export const memoryStatus = () => ({ ok: Boolean(lastOk) && !lastError, source: live?.source ?? 'empty', at: lastOk, error: lastError, notes: live?.memory?.notes ?? 0 })

const FOLDER_LABEL = { [FOLDERS.people]: 'Ľudia', [FOLDERS.projects]: 'Projekty', [FOLDERS.goals]: 'Ciele', [FOLDERS.days]: 'Denník', [FOLDERS.notes]: 'Poznámky' }
const labelOf = (folder) => FOLDER_LABEL[folder] ?? folder.charAt(0).toUpperCase() + folder.slice(1)

const DAY_RULE = {
  daily: () => true,
  denne: () => true,
  weekdays: (d) => d >= 1 && d <= 5,
  'po-pi': (d) => d >= 1 && d <= 5,
  weekend: (d) => d === 0 || d === 6,
  vikend: (d) => d === 0 || d === 6,
}
/** Does a routine run on the given day? `days` is "daily", "weekdays", "weekend" or a list like "po,st,pi". */
export function routineRunsOn(routine, day) {
  const rule = String(routine.days ?? 'daily').toLowerCase().trim()
  const wd = dowOf(day)
  if (DAY_RULE[rule]) return DAY_RULE[rule](wd)
  const map = { ne: 0, po: 1, ut: 2, st: 3, 'št': 4, stv: 4, pi: 5, so: 6, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
  const list = rule.split(/[\s,]+/).map((t) => map[t]).filter((n) => n !== undefined)
  return list.length ? list.includes(wd) : true
}

function healthBlock(ix) {
  const today = isoDay()
  const days = dayStats(ix, { since: addDays(today, -7) }).filter((d) => Number.isFinite(d.sleepMin))
  const latest = days.at(-1) ?? null
  const week = days.map((d) => ({ day: d.day, dow: DOW_SHORT[dowOf(d.day)], sleepMin: d.sleepMin, score: sleepScore(d.sleepMin) }))
  return {
    day: latest?.day ?? null,
    sleepMin: latest?.sleepMin ?? null,
    sleepScore: sleepScore(latest?.sleepMin),
    mood: dayStats(ix, { since: addDays(today, -1) }).at(-1)?.mood ?? null,
    week,
    avgSleepMin: week.length ? Math.round(week.reduce((s, d) => s + d.sleepMin, 0) / week.length) : null,
  }
}

function scheduleItems(events, dueTodos, day) {
  const items = events
    .filter((e) => e.day === day && e.kind !== 'birthday' && e.kind !== 'nameday')
    .map((e) => ({ time: e.allDay ? null : e.time, end: e.end, title: e.title, place: e.place, kind: e.allDay ? 'allday' : 'event' }))
  for (const t of dueTodos) if (t.due === day && !t.done) items.push({ time: null, end: null, title: t.text, place: null, kind: 'deadline' })
  return items.sort((a, b) => (a.time ?? '99').localeCompare(b.time ?? '99'))
}

async function build() {
  const cfg = getConfig()
  const today = isoDay()
  const tomorrow = addDays(today, 1)
  const errors = []
  const part = async (name, fn) => {
    try {
      return await fn()
    } catch (err) {
      errors.push(`${name}: ${errMsg(err)}`)
      return null
    }
  }
  const ix = await getIndex({ force: true })
  const [events, todoList, weather, chat] = await Promise.all([
    part('kalendár', () => calendarRange(today, addDays(today, 14))),
    part('úlohy', todos),
    part('počasie', () => getWeather(cfg.city, 3)),
    part('rozhovory', chatStats),
  ])
  filmNames = ofKind(ix, 'person').flatMap((p) => [p.title, p.title.split(/\s+/)[0]]).filter((n) => n.length > 2)
  const s = stats(ix)
  const goalList = goals(ix)
  const open = (todoList ?? []).filter((t) => !t.done)
  const core = new Set(Object.values(FOLDERS))
  const sources = Object.entries(s.folders)
    .filter(([folder]) => folder !== FOLDERS.inbox)
    .map(([folder, count]) => ({ name: labelOf(folder), count }))
    .sort((a, b) => b.count - a.count)
  return {
    generatedAt: new Date().toISOString(),
    source: errors.length ? 'partial' : 'live',
    errors,
    owner: cfg.name || null,
    configured: cfg.configured,
    memory: {
      notes: s.notes,
      words: s.words,
      since: s.since,
      people: s.people,
      projects: s.projects,
      goals: s.goals,
      dailyLogs: s.days,
      other: s.other,
      chatMessages: chat?.messages ?? 0,
      chatDays: chat?.days ?? 0,
      sources,
      /** Extra collections (any other top-level folder in memory/), shown as small moons. */
      extra: Object.fromEntries(Object.entries(s.folders).filter(([folder]) => !core.has(folder))),
    },
    health: healthBlock(ix),
    schedule: {
      day: today,
      items: scheduleItems(events ?? [], todoList ?? [], today),
      tomorrow: { day: tomorrow, items: scheduleItems(events ?? [], todoList ?? [], tomorrow) },
      nameDays: nameDayOf(today),
    },
    celebrations: (events ?? [])
      .filter((e) => e.kind === 'birthday' || e.kind === 'nameday')
      .map((e) => {
        const days = Math.round((new Date(`${e.day}T12:00:00`) - new Date(`${today}T12:00:00`)) / 86_400_000)
        return { kind: e.kind, name: e.person, day: e.day, daysUntil: days, when: days === 0 ? 'dnes' : days === 1 ? 'zajtra' : days === 2 ? 'pozajtra' : `o ${days} dní`, age: e.age ?? null }
      }),
    todo: { open: open.length, today: open.filter((t) => t.due && t.due <= today).length },
    routines: [
      ...(cfg.alarm?.enabled && routineRunsOn(cfg.alarm, today) ? [{ id: 'budik', time: cfg.alarm.time, name: 'Budík', bot: 'Jarvis' }] : []),
      ...cfg.routines.filter((r) => r.enabled && routineRunsOn(r, today)).map((r) => ({ id: r.id, time: r.time, name: r.title, bot: 'Jarvis' })),
    ],
    weather,
    quests: {
      active: goalList.filter((q) => q.status === 'active').length,
      paused: goalList.filter((q) => q.status === 'paused').length,
      names: goalList.filter((q) => q.status === 'active').map((q) => q.name),
    },
  }
}

export async function refreshSnapshot(reason = 'interval') {
  if (refreshing) return refreshing
  refreshing = (async () => {
    const t0 = Date.now()
    try {
      const snap = await build()
      live = snap
      lastOk = snap.generatedAt
      lastError = snap.errors.length ? snap.errors.join('; ') : null
      await writeFileAtomic(LIVE_FILE, JSON.stringify(snap, null, 2) + '\n', 0o600)
      if (reason !== 'interval' || snap.errors.length) log('snapshot', `${reason}: ${snap.source} za ${Date.now() - t0} ms${snap.errors.length ? ` · ${snap.errors.join(' · ')}` : ''}`)
      return snap
    } catch (err) {
      lastError = errMsg(err)
      log('snapshot', `obnova zlyhala: ${lastError}`)
      return live
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

/** Refresh on start and on an interval. Every refresh is pushed to the page as SSE `snapshot`. */
export async function startSnapshots(getFilm) {
  const tick = async (reason) => {
    const snap = await refreshSnapshot(reason)
    if (snap) send('snapshot', getFilm() ? forFilm(snap) : snap)
  }
  await tick('štart')
  setInterval(() => tick('interval'), REFRESH_MS).unref()
}

export function currentSnapshot({ film = false } = {}) {
  if (!live) return null
  return film ? forFilm(live) : live
}

// ── filming mode ───────────────────────────────────────────────────────

function hasName(text) {
  const t = ` ${String(text).toLowerCase()} `
  return filmNames.some((n) => t.includes(n.toLowerCase()))
}

const filmItem = (item) => (hasName(item.title) || item.kind === 'event' ? { ...item, title: 'Súkromná udalosť', place: null } : { ...item })

/** Copy of the snapshot without people's names (first name on name days stays), private events and goal names. */
export function forFilm(snap) {
  const out = structuredClone(snap)
  out.film = true
  if (out.schedule) {
    out.schedule.items = (out.schedule.items ?? []).map(filmItem)
    if (out.schedule.tomorrow) out.schedule.tomorrow.items = (out.schedule.tomorrow.items ?? []).map(filmItem)
  }
  out.celebrations = (out.celebrations ?? [])
    .filter((c) => c.kind === 'nameday')
    .map((c) => ({ ...c, name: String(c.name ?? '').split(/\s+/)[0], age: null }))
    .filter((c, i, arr) => c.name && arr.findIndex((x) => x.name === c.name && x.day === c.day) === i)
  if (out.quests) out.quests.names = []
  return out
}
