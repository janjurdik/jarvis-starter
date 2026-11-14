/**
 * Automatic cards: the main memory tools (calendar, sleep, celebrations, goals, to-dos, stats)
 * send their data here and the HUD turns it into a card and a node focus right away. Jarvis then
 * only talks and does not have to write card JSON. In filming mode cards contain no names.
 */
import { DOW_LONG, DOW_SHORT, dowOf, isoDay } from './util.mjs'

const fmtMin = (m) => (Number.isFinite(m) ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min` : '–')
const dayTitle = (day) => {
  const today = isoDay()
  const [, m, d] = day.split('-').map(Number)
  const rel = day === today ? 'Dnes' : null
  return `${rel ? `${rel}, ` : ''}${DOW_LONG[dowOf(day)]} ${d}. ${m}.`
}

const SAFE_KINDS = new Set([])

function hasName(text, names) {
  const t = ` ${String(text).toLowerCase()} `
  return names.some((n) => t.includes(n.toLowerCase()))
}

/**
 * tool + dáta z MCP → { card, focus: { node, caption } } alebo null.
 * `film` a `names` (mená z CRM) riadia čistenie pre natáčanie.
 */
export function autoCard(tool, data, { film = false, names = [] } = {}) {
  if (!data || typeof data !== 'object') return null
  if (tool === 'calendar_list') {
    const events = Array.isArray(data.events) ? data.events : []
    const first = data.from
    const own = events.filter((e) => e.kind !== 'birthday' && e.kind !== 'nameday')
    const multi = data.from !== data.to
    const safeTitle = (e) => (film && !(SAFE_KINDS.has(e.kind) && !hasName(e.title, names)) ? 'Súkromná udalosť' : e.title)
    const items = own.slice(0, 8).map((e) => ({
      label: safeTitle(e),
      value: e.allDay ? 'celý deň' : e.time,
      sub: [multi ? `${DOW_SHORT[dowOf(e.day)]} ${Number(e.day.slice(8))}.` : null, film && safeTitle(e) !== e.title ? null : e.place].filter(Boolean).join(' · ') || null,
    }))
    const namedays = [...new Set(events.filter((e) => e.kind === 'nameday' && e.day === first).map((e) => String(e.person ?? '').split(/\s+/)[0]))].filter(Boolean)
    const bdays = events.filter((e) => e.kind === 'birthday' && e.day === first)
    const capParts = []
    if (namedays.length) capParts.push(`Meniny: ${namedays.join(', ')}`)
    if (bdays.length) capParts.push(film ? `${bdays.length}× narodeniny` : `Narodeniny: ${bdays.map((b) => String(b.person).split(/\s+/)[0]).join(', ')}`)
    const now = Date.now()
    const next = own.find((e) => !e.allDay && e.startMs > now - 30 * 60_000)
    if (!items.length) items.push({ label: 'Nič naplánované', value: null, sub: null })
    return {
      card: {
        kind: 'list',
        title: multi ? `Kalendár ${Number(first.slice(8))}. až ${Number(data.to.slice(8))}. ${Number(data.to.slice(5, 7))}.` : dayTitle(first),
        icon: 'calendar',
        node: 'kalendar',
        items,
        caption: capParts.join(' · ') || null,
        accent: next ? 'amber' : 'ice',
      },
      focus: { node: 'kalendar', caption: multi ? 'Kalendár' : dayTitle(first) },
    }
  }
  if (tool === 'get_health') {
    const days = (Array.isArray(data.days) ? data.days : []).filter((d) => Number.isFinite(d.sleepMin))
    if (days.length < 2) return null
    const avg = days.reduce((s, d) => s + d.sleepMin, 0) / days.length
    const scored = days.filter((d) => Number.isFinite(d.score))
    const avgScore = scored.length ? Math.round(scored.reduce((s, d) => s + d.score, 0) / scored.length) : null
    const series = days.slice(-14).map((d) => ({ label: days.length > 8 ? String(Number(d.day.slice(8))) : DOW_SHORT[dowOf(d.day)], value: Math.round(d.sleepMin) }))
    return {
      card: {
        kind: 'chart',
        title: `Spánok, posledných ${days.length} nocí`,
        icon: 'moon',
        node: 'spanok',
        value: fmtMin(avg),
        caption: `priemer${avgScore ? `, skóre ${avgScore}` : ''}`,
        series,
        accent: avg < 360 ? 'red' : avg < 420 ? 'amber' : 'ice',
      },
      focus: { node: 'spanok', caption: 'Spánok' },
    }
  }
  if (tool === 'upcoming_celebrations') {
    const list = (Array.isArray(data.events) ? data.events : []).filter((e) => !film || e.kind === 'nameday')
    const seen = new Set()
    const items = []
    for (const e of list) {
      const name = film ? String(e.person ?? '').split(/\s+/)[0] : e.person
      const key = `${e.kind}|${name}|${e.day}`
      if (!name || seen.has(key)) continue
      seen.add(key)
      items.push({ label: name, value: e.when ?? e.day, sub: e.kind === 'birthday' ? `narodeniny${e.age ? `, ${e.age}` : ''}` : 'meniny' })
    }
    if (!items.length) return null
    return {
      card: { kind: 'list', title: 'Meniny a narodeniny', icon: 'gift', node: 'kalendar', items: items.slice(0, 8), caption: items.length > 8 ? `a ďalší (${items.length - 8})` : null, accent: 'amber' },
      focus: { node: 'kalendar', caption: 'Oslavy' },
    }
  }
  if (tool === 'list_goals') {
    const quests = Array.isArray(data.quests) ? data.quests : []
    if (!quests.length) return null
    const active = quests.filter((q) => q.status === 'active')
    if (film) {
      return {
        card: { kind: 'stat', title: 'Ciele', icon: 'quest', node: 'questy', value: String(active.length), unit: 'aktívnych', caption: `${quests.filter((q) => q.status === 'paused').length} v pauze` },
        focus: { node: 'questy', caption: 'Ciele' },
      }
    }
    return {
      card: {
        kind: 'list',
        title: data.status === 'all' ? 'Ciele' : 'Aktívne ciele',
        icon: 'quest',
        node: 'questy',
        items: quests.slice(0, 8).map((q) => ({ label: q.name, value: `${q.stepsDone}/${q.stepsTotal}`, sub: q.nextStep ? q.nextStep.slice(0, 48) : null })),
        caption: `${active.length} aktívnych`,
      },
      focus: { node: 'questy', caption: 'Ciele' },
    }
  }
  if (tool === 'view_todo') {
    const groups = Array.isArray(data.groups) ? data.groups : []
    return {
      card: {
        kind: 'stat',
        title: 'Otvorené úlohy',
        icon: 'check',
        node: 'projekty',
        value: String(data.total ?? 0),
        caption: groups.length > 1 ? `${groups.length} skupín` : null,
        items:
          film || !Array.isArray(data.items)
            ? groups.slice(0, 6).map((g) => ({ label: g.name, value: String(g.count) }))
            : data.items.slice(0, 8).map((t) => ({ label: hasName(t.text, names) && film ? 'Súkromná úloha' : t.text, value: t.due ? `do ${Number(t.due.slice(8))}. ${Number(t.due.slice(5, 7))}.` : null, sub: t.group ?? null })),
      },
      focus: { node: 'projekty', caption: 'Úlohy' },
    }
  }
  if (tool === 'memory_stats') {
    const nf = (n) => Number(n ?? 0).toLocaleString('sk-SK')
    return {
      card: {
        kind: 'stat',
        title: 'Pamäť',
        icon: 'memory',
        node: 'fotky',
        value: nf(data.notes),
        unit: 'poznámok',
        caption: `${nf(data.words)} slov${data.since ? `, od ${Number(data.since.slice(8))}. ${Number(data.since.slice(5, 7))}. ${data.since.slice(0, 4)}` : ''}`,
        items: [
          { label: 'Ľudia', value: nf(data.people) },
          { label: 'Projekty', value: nf(data.projects) },
          { label: 'Ciele', value: nf(data.goals) },
          { label: 'Dni v denníku', value: nf(data.days) },
          { label: 'Ostatné poznámky', value: nf(data.other) },
        ],
      },
      focus: { node: 'fotky', caption: `${nf(data.notes)} poznámok` },
    }
  }
  if (tool === 'weather') {
    if (!Number.isFinite(data.tempC)) return null
    return {
      card: {
        kind: 'stat',
        title: `Počasie, ${data.place}`,
        icon: data.isDay === false ? 'moon' : data.icon === 'sun' ? 'sun' : 'cloud',
        node: null,
        value: `${data.tempC} °C`,
        caption: `${data.text}${Number.isFinite(data.highC) ? `, dnes ${data.lowC} až ${data.highC} °C` : ''}`,
        items: (Array.isArray(data.hours) ? data.hours : []).slice(0, 6).map((h) => ({ label: h.time, value: `${h.tempC} °C`, sub: h.rainPct ? `dážď ${h.rainPct} %` : null })),
      },
      focus: null,
    }
  }
  return null
}
