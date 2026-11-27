/**
 * Inner worlds of the planets: every item of a node (people, projects, goals, days, notes…)
 * with its importance and links, for the 3D dive into a planet (public/js/world/inner.js).
 * Everything comes from the local memory folder.
 *
 *   GET /api/inner                 item counts for planet labels
 *   GET /api/inner/:node           { title, color, layout, groups, items: [{ id, t, s, imp, g, y, links, r, k }] }
 *   GET /api/inner/:node/:id       item detail for the inspector
 *   GET /api/inner-art?game=Name   the picture of a game from this computer (hud/server/game-art.mjs)
 *
 * Privacy: in filming mode 403 (inner worlds cannot be entered).
 */
import { chatStats, readDay } from './chatlog.mjs'
import { getConfig } from './config.mjs'
import { calendarRange } from './memory/calendar.mjs'
import { FOLDERS, STATUS_LABEL, checkboxes, dayStats, firstParagraph, getIndex, inFolder, ofKind, plain, section, slugify, statusOf, todos } from './memory/index.mjs'
import { gameArt } from './game-art.mjs'
import { customOrb, getOrbState, orbContent } from './orbs.mjs'
import { routineRunsOn } from './snapshot.mjs'
import { sendStored } from './upload.mjs'
import { addDays, errMsg, isoDay, sendJson } from './util.mjs'

/** Planets with fixed art in the 3D world. Extra memory folders reuse the art of a known moon when the name matches. */
export const PLANETS = {
  ludia: { title: 'Ľudia', color: '#7ff3ff', layout: 'cluster' },
  projekty: { title: 'Projekty', color: '#7ff3ff', layout: 'cluster' },
  questy: { title: 'Ciele', color: '#ffb25c', layout: 'cluster' },
  kalendar: { title: 'Kalendár', color: '#ffb25c', layout: 'board' },
  rutiny: { title: 'Rutiny', color: '#7ff3ff', layout: 'board' },
  udalosti: { title: 'Denník', color: '#7ff3ff', layout: 'years' },
  spravy: { title: 'Rozhovory', color: '#5fe6ff', layout: 'years' },
  fotky: { title: 'Poznámky', color: '#9fd8ff', layout: 'cluster' },
  spanok: { title: 'Spánok', color: '#7fb8ff', layout: 'years' },
  ulohy: { title: 'Úlohy', color: '#ffb25c', layout: 'board' },
  posta: { title: 'Pošta', color: '#7ff3ff', layout: 'cluster' },
}
/** Optional collections: a folder with this name in memory/ shows up as a small moon. */
export const EXTRA = {
  knihy: { title: 'Knihy', color: '#ffd59a' },
  filmy: { title: 'Filmy', color: '#ff9ac8' },
  miesta: { title: 'Miesta', color: '#9affc8' },
  hudba: { title: 'Hudba', color: '#b49aff' },
  skola: { title: 'Škola', color: '#8fb8ff' },
  zdroje: { title: 'Zdroje', color: '#c8f0ff' },
  content: { title: 'Obsah', color: '#ff7ab8' },
  hry: { title: 'Hry', color: '#8cff8c' },
}

const nf = (n) => new Intl.NumberFormat('sk-SK').format(n)
const norm = (values) => {
  const max = Math.max(1e-9, ...values)
  return values.map((v) => v / max)
}
const cut = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''))
const shortDay = (day) => `${Number(day.slice(8))}. ${Number(day.slice(5, 7))}. ${day.slice(0, 4)}`
const yearFrac = (day) => Number(day.slice(0, 4)) + (Number(day.slice(5, 7)) - 1) / 12 + Number(day.slice(8)) / 372
const WEEKDAYS = ['Nedeľa', 'Pondelok', 'Utorok', 'Streda', 'Štvrtok', 'Piatok', 'Sobota']
const MONTHS = ['január', 'február', 'marec', 'apríl', 'máj', 'jún', 'júl', 'august', 'september', 'október', 'november', 'december']
const fmtMin = (m) => `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min`

/** Importance of a note: length, backlinks and freshness. */
function importance(ix, notes, boost = () => 0) {
  const now = Date.now()
  return norm(notes.map((n) => Math.log1p(n.words) + 1.6 * Math.log1p(ix.backlinks.get(n.rel)?.size ?? 0) + (now - n.mtime < 30 * 864e5 ? 1.2 : 0) + boost(n)))
}

const idOf = (n) => `n:${slugify(n.rel.replace(/\.md$/, ''))}`

/** Links between notes (wiki links in both directions), as item ids. */
function linksOf(ix, n) {
  const out = new Set()
  for (const l of n.links) {
    const t = ix.byTitle.get(slugify(l))
    if (t && t !== n) out.add(idOf(t))
  }
  for (const rel of ix.backlinks.get(n.rel) ?? []) {
    const t = ix.byRel.get(rel)
    if (t) out.add(idOf(t))
  }
  return [...out]
}

function notesWorld(ix, notes, { group = () => 'iné', groupLabel = (g) => g, sub = () => null, boost, round = false, kind = 'note' } = {}) {
  const imp = importance(ix, notes, boost)
  const items = notes.map((n, i) => ({ id: idOf(n), t: n.title, s: sub(n), img: null, imp: imp[i], g: group(n), links: linksOf(ix, n), r: round, k: kind }))
  const groups = [...new Set(items.map((i) => i.g))].map((key) => ({ key, label: groupLabel(key) }))
  return { items, groups }
}

// ── planets ────────────────────────────────────────────────────────────

const relationOf = (n) => String(n.fm.vztah ?? n.fm['vzťah'] ?? n.fm.relation ?? '').trim().toLowerCase() || 'ostatní'

const WORLDS = {
  ludia: (ix) => {
    const people = ofKind(ix, 'person')
    const projects = ofKind(ix, 'project')
    const w = notesWorld(ix, people, { group: relationOf, sub: (n) => [relationOf(n) !== 'ostatní' ? relationOf(n) : null, firstParagraph(n.body, 60)].filter(Boolean).join(' · ') || null, round: true, kind: 'person' })
    // Projects appear as small stars so the links person ↔ project are visible.
    const linked = projects.filter((p) => w.items.some((it) => it.links.includes(idOf(p))))
    for (const p of linked) w.items.push({ id: idOf(p), t: p.title, s: 'projekt', img: null, imp: 0.12, g: 'projekty', links: linksOf(ix, p), k: 'project' })
    if (linked.length) w.groups.push({ key: 'projekty', label: 'projekty' })
    return w
  },
  projekty: (ix) =>
    notesWorld(ix, ofKind(ix, 'project'), {
      group: statusOf,
      groupLabel: (g) => STATUS_LABEL[g] ?? g,
      sub: (n) => [STATUS_LABEL[statusOf(n)], firstParagraph(n.body, 60)].filter(Boolean).join(' · '),
      boost: (n) => (statusOf(n) === 'active' ? 1.5 : 0),
      kind: 'project',
    }),
  questy: (ix) =>
    notesWorld(ix, ofKind(ix, 'goal'), {
      group: statusOf,
      groupLabel: (g) => STATUS_LABEL[g] ?? g,
      sub: (n) => {
        const steps = checkboxes(n.body)
        return steps.length ? `${steps.filter((s) => s.done).length}/${steps.length} krokov` : STATUS_LABEL[statusOf(n)]
      },
      boost: (n) => (statusOf(n) === 'active' ? 2 : 0),
      kind: 'goal',
    }),
  fotky: (ix) =>
    notesWorld(ix, ix.list.filter((n) => n.kind === 'note' && !(n.folder in EXTRA)), {
      group: (n) => n.folder || 'pamäť',
      sub: (n) => cut(firstParagraph(n.body, 80), 80) || null,
    }),
  udalosti: (ix) => {
    const days = ofKind(ix, 'day')
    const imp = norm(days.map((n) => Math.log1p(n.words)))
    const items = days.map((n, i) => ({ id: `d:${n.name}`, t: shortDay(n.name), s: cut(firstParagraph(n.body, 70), 70) || null, img: null, imp: imp[i], g: n.name.slice(0, 4), y: yearFrac(n.name), k: 'day' }))
    return { items, groups: [...new Set(items.map((i) => i.g))].sort().map((key) => ({ key, label: key })) }
  },
  spravy: async () => {
    const { perDay } = await chatStats()
    const imp = norm(perDay.map((d) => Math.log1p(d.turns)))
    const items = perDay.map((d, i) => ({ id: `c:${d.day}`, t: shortDay(d.day), s: `${d.turns} ${d.turns === 1 ? 'výmena' : d.turns < 5 ? 'výmeny' : 'výmen'} s Jarvisom`, img: null, imp: imp[i], g: d.day.slice(0, 4), y: yearFrac(d.day), k: 'chat' }))
    return { items, groups: [...new Set(items.map((i) => i.g))].sort().map((key) => ({ key, label: key })) }
  },
  spanok: (ix) => {
    // Sleep and mood the user said, plus the body numbers a watch adds (Garmin sync): HRV, resting heart rate, body battery, steps.
    const days = dayStats(ix).filter((d) => d.sleepMin || d.mood || d.hrv || d.rhr || d.bb || d.steps)
    const items = days.map((d) => ({
      id: `s:${d.day}`,
      t: shortDay(d.day),
      s: [d.sleepMin ? `spánok ${fmtMin(d.sleepMin)}` : null, d.score ? `skóre ${d.score}` : null, d.hrv ? `HRV ${d.hrv}` : null, d.rhr ? `tep ${d.rhr}` : null, d.bb ? `body battery ${d.bb}` : null, d.steps ? `${nf(d.steps)} krokov` : null, d.mood ? `nálada ${d.mood}/5` : null].filter(Boolean).join(' · '),
      img: null,
      imp: d.sleepMin ? Math.min(1, d.sleepMin / 540) : 0.3,
      g: d.day.slice(0, 4),
      y: yearFrac(d.day),
      k: 'sleep',
      // The numbers the body landscape of the 3D world draws (public/js/world/inner.js, METRICS).
      day: d.day,
      m: { sleep: d.sleepMin, hrv: d.hrv, rhr: d.rhr, bb: d.bb, steps: d.steps },
    }))
    return { items, groups: [...new Set(items.map((i) => i.g))].sort().map((key) => ({ key, label: key })) }
  },
  // A board in four columns: today, tomorrow, the rest of the week and what comes after it. The
  // weekly timetable (the same thing at the same hour every week) is left out of the last one.
  kalendar: async () => {
    const today = isoDay()
    const events = await calendarRange(today, addDays(today, 30))
    const weekly = new Map()
    for (const e of events) {
      const k = `${new Date(`${e.day}T12:00:00`).getDay()}|${e.time ?? ''}|${e.title}`
      weekly.set(k, (weekly.get(k) ?? 0) + 1)
    }
    const items = []
    events.forEach((e, i) => {
      const d = new Date(`${e.day}T12:00:00`)
      const days = Math.round((d - new Date(`${today}T12:00:00`)) / 86_400_000)
      if (days >= 7 && weekly.get(`${d.getDay()}|${e.time ?? ''}|${e.title}`) >= 3) return
      const date = `${d.getDate()}. ${d.getMonth() + 1}.`
      const near = days <= 1
      items.push({
        id: `e:${e.day}:${i}`,
        t: near && e.time ? `${e.time} ${e.title}` : e.title,
        s: [near ? null : days < 7 ? `${WEEKDAYS[d.getDay()]} ${date}` : date, near ? null : e.time, e.place].filter(Boolean).join(' · ') || (e.time ? null : 'celý deň'),
        img: null,
        imp: Math.max(0.08, 1 - days / 30),
        g: days <= 0 ? 'Dnes' : days === 1 ? 'Zajtra' : days < 7 ? 'Tento týždeň' : 'Neskôr',
        k: 'event',
        ev: e,
      })
    })
    return { items, groups: ['Dnes', 'Zajtra', 'Tento týždeň', 'Neskôr'].filter((k) => items.some((i) => i.g === k)).map((key) => ({ key, label: key })) }
  },
  // A board, like tasks: what runs today (in the order of the day), what runs on other days, what is switched off.
  // The alarm is a routine too. The number on the orb is the number of rows under „Dnes" and „Inokedy" (routineCounts).
  rutiny: () => {
    const items = routineRows().map((r) => ({ id: `r:${r.id}`, t: r.title, s: r.when, img: null, imp: r.group === 'Dnes' ? 0.9 : r.group === 'Inokedy' ? 0.6 : 0.25, g: r.group, k: 'routine' }))
    return { items, groups: ['Dnes', 'Inokedy', 'Vypnuté'].filter((k) => items.some((i) => i.g === k)).map((key) => ({ key, label: key })) }
  },
  // A board: by term when most tasks have one (overdue first), otherwise by the sections of the task file.
  ulohy: async () => {
    const today = isoDay()
    const week = addDays(today, 7)
    const list = (await todos()).filter((t) => !t.done).map((t, i) => ({ ...t, i }))
    const byTerm = list.length > 0 && list.filter((t) => t.due).length * 2 >= list.length
    const term = (t) => (!t.due ? 'Bez termínu' : t.due < today ? 'Po termíne' : t.due === today ? 'Dnes' : t.due <= week ? 'Do týždňa' : 'Neskôr')
    const order = ['Po termíne', 'Dnes', 'Do týždňa', 'Neskôr', 'Bez termínu']
    const sorted = [...list].sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.i - b.i)
    const items = sorted.map((t) => ({
      id: `t:${t.i}`,
      t: cut(t.text, 60),
      s: [byTerm ? t.group : null, t.due ? (t.due < today ? `mešká od ${shortDay(t.due)}` : t.due === today ? (byTerm ? null : 'dnes') : `do ${shortDay(t.due)}`) : null].filter(Boolean).join(' · ') || null,
      img: null,
      imp: t.due ? (t.due <= today ? 1 : Math.max(0.3, 1 - (new Date(t.due) - new Date(today)) / (30 * 864e5))) : 0.25,
      g: byTerm ? term(t) : (t.group ?? 'Úlohy'),
      k: 'todo',
      full: t.text,
      // Which line of ulohy.md this is, for a click that deletes or rewrites it (POST /api/todos).
      ref: { text: t.text, due: t.due, n: t.n },
    }))
    const keys = byTerm ? order.filter((k) => items.some((i) => i.g === k)) : [...new Set(list.map((t) => t.group ?? 'Úlohy'))]
    return { items, groups: keys.map((key) => ({ key, label: key })) }
  },
}

const extraWorld = (folder) => (ix) => notesWorld(ix, inFolder(ix, folder), { group: (n) => String(n.fm.stav ?? n.fm.zaner ?? n.fm['žáner'] ?? n.fm.typ ?? folder), sub: (n) => cut(firstParagraph(n.body, 80), 80) || null })

/** An orb Jarvis made (or Pošta): the notes of its memory folder, if it has one. Its own items are added in world(). */
const customWorld = (custom) => (ix) => (custom?.folder ? notesWorld(ix, inFolder(ix, custom.folder), { group: (n) => String(n.fm.stav ?? n.fm.typ ?? custom.label), sub: (n) => cut(firstParagraph(n.body, 80), 80) || null }) : { items: [], groups: [] })

async function world(node) {
  const ix = await getIndex()
  const custom = customOrb(node)
  const build = WORLDS[node] ?? (EXTRA[node] ? extraWorld(node) : custom || node === 'posta' ? customWorld(custom) : null)
  if (!build) return null
  const meta = PLANETS[node] ?? (EXTRA[node] ? { ...EXTRA[node], layout: 'cluster' } : { title: custom.label, color: custom.color, layout: 'cluster' })
  const w = await build(ix)
  // Games get the cover or the icon this computer already has.
  if (node === 'hry') for (const it of w.items) if (await gameArt(it.t)) it.img = `/api/inner-art?game=${encodeURIComponent(it.t)}&w=256`
  // What Jarvis wrote for this orb (data/orbs/<id>.json): its own items and the component panel.
  const content = orbContent(node)
  if (content?.items) {
    w.items.push(...content.items.map((it) => ({ id: it.id, t: it.t, s: it.s ?? it.from ?? null, img: null, imp: it.imp, g: it.g, k: 'orb', text: it.text ?? null, from: it.from ?? null, at: it.at ?? null, reply: it.reply ?? null, say: it.say ?? null, act: it.act ?? null })))
    const keys = new Set(w.groups.map((g) => g.key))
    for (const g of content.groups ?? []) if (!keys.has(g.key)) w.groups.push(g), keys.add(g.key)
    for (const it of content.items) if (!keys.has(it.g)) w.groups.push({ key: it.g, label: it.g }), keys.add(it.g)
  }
  // `ev`, `full` and `text` are server-side helpers for details, not part of the wire format.
  return { title: meta.title, color: meta.color, layout: meta.layout, groups: w.groups, items: w.items.map(({ ev, full, text, from, at, reply, say, ...it }) => it), panel: content?.panel ?? null, updatedAt: content?.updatedAt ?? null, _raw: w.items }
}

// ── item detail ────────────────────────────────────────────────────────

function noteDetail(ix, n) {
  const steps = checkboxes(n.body)
  const chips = []
  if (n.kind === 'person') {
    if (relationOf(n) !== 'ostatní') chips.push(relationOf(n))
    if (n.fm.narodeniny) chips.push(`narodeniny ${n.fm.narodeniny}`)
  }
  if (steps.length) chips.push(`${steps.filter((s) => s.done).length} z ${steps.length} krokov`)
  const what = n.kind === 'person' ? 'Človek' : n.kind === 'project' ? `Projekt · ${STATUS_LABEL[statusOf(n)]}` : n.kind === 'goal' ? `Cieľ · ${STATUS_LABEL[statusOf(n)]}` : 'Poznámka'
  const related = linksOf(ix, n)
    .map((id) => ix.list.find((x) => idOf(x) === id))
    .filter(Boolean)
  const people = related.filter((x) => x.kind === 'person').slice(0, 8).map((p) => ({ id: idOf(p), name: p.title, node: 'ludia', img: null }))
  const projects = related.filter((x) => x.kind === 'project' || x.kind === 'goal').slice(0, 8).map((p) => ({ id: idOf(p), title: p.title, sub: p.kind === 'goal' ? 'cieľ' : STATUS_LABEL[statusOf(p)], node: p.kind === 'goal' ? 'questy' : 'projekty' }))
  const mentions = [...(ix.backlinks.get(n.rel) ?? [])].map((rel) => ix.byRel.get(rel)).filter((x) => x?.kind === 'day').sort((a, b) => b.name.localeCompare(a.name)).slice(0, 12)
  const remembered = section(n.body, /^zapam[äa]tan[ée]/i).split('\n').map((l) => plain(l.replace(/^\s*[-*]\s+/, ''))).filter(Boolean).slice(-8)
  return {
    kind: n.kind,
    title: n.title,
    sub: what,
    round: n.kind === 'person',
    chips,
    text: firstParagraph(n.body, 600),
    steps: steps.slice(0, 14),
    sections: remembered.length ? [{ title: 'Zapamätané', lines: remembered }] : [],
    people,
    projects,
    timeline: mentions.map((d) => ({ label: shortDay(d.name) })),
  }
}

async function itemDetail(node, id) {
  const ix = await getIndex()
  if (id.startsWith('n:')) {
    const n = ix.list.find((x) => idOf(x) === id)
    return n ? noteDetail(ix, n) : null
  }
  if (id.startsWith('d:') || id.startsWith('s:')) {
    const n = ix.byRel.get(`${FOLDERS.days}/${id.slice(2)}.md`)
    if (!n) return null
    const stat = dayStats(ix, { since: n.name }).find((d) => d.day === n.name)
    const lines = plain(n.body).split('\n').map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean).slice(0, 14)
    return {
      kind: 'day',
      title: shortDay(n.name),
      sub: 'Denník',
      stats: [
        stat?.sleepMin ? { value: fmtMin(stat.sleepMin), label: 'spánok' } : null,
        stat?.score ? { value: String(stat.score), label: 'skóre spánku' } : null,
        stat?.mood ? { value: `${stat.mood}/5`, label: 'nálada' } : null,
        stat?.hrv ? { value: String(stat.hrv), label: 'HRV' } : null,
        stat?.rhr ? { value: String(stat.rhr), label: 'tep v pokoji' } : null,
        stat?.bb ? { value: String(stat.bb), label: 'body battery' } : null,
        stat?.steps ? { value: nf(stat.steps), label: 'krokov' } : null,
      ].filter(Boolean).slice(0, 5),
      sections: lines.length ? [{ title: 'Čo sa dialo', lines }] : [],
      people: n.links.map((l) => ix.byTitle.get(slugify(l))).filter((x) => x?.kind === 'person').slice(0, 8).map((p) => ({ id: idOf(p), name: p.title, node: 'ludia', img: null })),
    }
  }
  if (id.startsWith('c:')) {
    const turns = await readDay(id.slice(2))
    if (!turns.length) return null
    return {
      kind: 'chat',
      title: shortDay(id.slice(2)),
      sub: 'Rozhovor s Jarvisom',
      stats: [{ value: nf(turns.length), label: 'výmen' }],
      sections: [{ title: 'O čom bola reč', lines: turns.slice(-14).map((t) => cut(t.user, 120)) }],
    }
  }
  const w = await world(node)
  const it = w?._raw.find((x) => x.id === id)
  if (!it) return null
  if (it.k === 'event') return { kind: 'event', title: it.t, sub: it.s, chips: [it.ev.kind === 'birthday' ? 'narodeniny' : it.ev.kind === 'nameday' ? 'meniny' : it.ev.allDay ? 'celý deň' : `${it.ev.time}${it.ev.end ? ` až ${it.ev.end}` : ''}`] }
  if (it.k === 'todo') return { kind: 'todo', title: it.full, sub: it.s }
  if (it.k === 'orb') {
    // The content itself, in paragraphs, then the reply Jarvis prepared and one thing to say to him about it.
    const paragraphs = (it.text ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    return {
      kind: 'orb',
      title: it.t,
      sub: [it.from ?? it.s, it.at].filter(Boolean).join(' · ') || null,
      chips: it.g && it.g !== 'iné' ? [it.g] : [],
      paragraphs,
      sections: it.reply ? [{ title: 'Navrhovaná odpoveď', text: it.reply }] : [],
      actions: it.say ? [{ label: it.act || (it.reply ? 'Uprav odpoveď' : 'Vybav to'), say: it.say }] : [],
    }
  }
  if (it.k === 'routine') {
    const r = routineRows().find((x) => `r:${x.id}` === id)
    if (!r) return { kind: 'routine', title: it.t, sub: it.s }
    return {
      kind: 'routine',
      title: r.title,
      sub: r.when,
      chips: [r.enabled ? 'zapnutá' : 'vypnutá'],
      paragraphs: [r.id === 'budik' ? 'Budík zazvoní skladbou a povie vám ranný prehľad. Zvonenie zastavíte tlačidlom na obrazovke, prehľad potom zaznie hneď.' : `Bežím ju sám, bez pýtania. Zadanie je v súbore routines/${r.id}.md a výsledok ukladám do pamäte, do priečinka schranka.`],
      actions: [{ label: r.enabled ? 'Vypnúť' : 'Zapnúť', say: `${r.enabled ? 'Vypni' : 'Zapni'} ${r.id === 'budik' ? 'budík' : `rutinu ${r.title}`}.` }, ...(r.id === 'budik' ? [{ label: 'Zmeniť skladbu', say: 'Chcem si vybrať skladbu na budík.' }] : [{ label: 'Spustiť teraz', say: `Spusti teraz rutinu ${r.title}.` }])],
    }
  }
  return { title: it.t, sub: it.s }
}

// ── routines ───────────────────────────────────────────────────────────

const DAYS_SAY = { daily: 'každý deň', denne: 'každý deň', weekdays: 'v pracovné dni', 'po-pi': 'v pracovné dni', weekend: 'cez víkend', vikend: 'cez víkend' }
const DAY_SAY = { ne: 'v nedeľu', po: 'v pondelok', ut: 'v utorok', st: 'v stredu', 'št': 'vo štvrtok', stv: 'vo štvrtok', pi: 'v piatok', so: 'v sobotu' }
const daysSay = (days) => {
  const rule = String(days ?? 'daily').toLowerCase().trim()
  if (DAYS_SAY[rule]) return DAYS_SAY[rule]
  const list = rule.split(/[\s,]+/).filter(Boolean)
  return list.length === 1 ? (DAY_SAY[list[0]] ?? list[0]) : list.join(', ')
}

/** Every routine with the words the board shows: when it runs and in which column it belongs today. */
function routineRows() {
  const cfg = getConfig()
  const today = isoDay()
  const rows = []
  const add = (r, id, title) => {
    const every = Number(r.every) > 0
    const runsToday = r.enabled !== false && (every || routineRunsOn(r, today))
    const when = every ? `každých ${r.every} min${r.between ? `, ${String(r.between).replace('-', ' až ')}` : ''}` : `${r.time ?? ''} · ${daysSay(r.days)}`.replace(/^ · /, '')
    rows.push({ id, title, when, enabled: r.enabled !== false, group: r.enabled === false ? 'Vypnuté' : runsToday ? 'Dnes' : 'Inokedy', sort: every ? '99:99' : (r.time ?? '99:98') })
  }
  if (cfg.alarm?.time) add({ ...cfg.alarm, enabled: cfg.alarm.enabled === true }, 'budik', 'Budík')
  for (const r of cfg.routines) add(r, r.id, r.title)
  return rows.sort((a, b) => a.sort.localeCompare(b.sort))
}

/** The numbers for the orb: how many routines are switched on, and how many of them run today. */
export function routineCounts() {
  const rows = routineRows()
  return { on: rows.filter((r) => r.enabled).length, today: rows.filter((r) => r.group === 'Dnes').length, all: rows.length }
}

// ── router ─────────────────────────────────────────────────────────────

export async function innerCounts() {
  const ix = await getIndex()
  const counts = {
    ludia: ofKind(ix, 'person').length,
    projekty: ofKind(ix, 'project').length,
    questy: ofKind(ix, 'goal').length,
    udalosti: ofKind(ix, 'day').length,
    fotky: ix.list.filter((n) => n.kind === 'note' && !(n.folder in EXTRA)).length,
  }
  for (const folder of Object.keys(EXTRA)) counts[folder] = inFolder(ix, folder).length
  for (const c of getOrbState().custom) counts[c.id] = (c.folder ? inFolder(ix, c.folder).length : 0) + (orbContent(c.id)?.items?.length ?? 0)
  counts.posta = orbContent('posta')?.items?.length ?? 0
  counts.rutiny = routineCounts().on
  return counts
}

export async function routeInner(req, res, url, { film }) {
  const path = url.pathname
  if (path === '/api/inner-art') {
    const file = film ? null : await gameArt(url.searchParams.get('game'))
    if (!file || !(await sendStored(req, res, file, { imagesOnly: true }))) sendJson(res, 404, { ok: false, error: 'obrázok nie je' })
    return true
  }
  if (path !== '/api/inner' && !path.startsWith('/api/inner/')) return false
  if (film) {
    sendJson(res, 403, { ok: false, error: 'režim natáčania', film: true })
    return true
  }
  try {
    if (path === '/api/inner') {
      sendJson(res, 200, { ok: true, counts: await innerCounts(), planets: Object.fromEntries([...Object.entries(PLANETS), ...Object.entries(EXTRA)].map(([k, v]) => [k, v.title])) })
      return true
    }
    const [node, ...rest] = path.slice('/api/inner/'.length).split('/').map(decodeURIComponent)
    const id = rest.join('/')
    if (!PLANETS[node] && !EXTRA[node] && !customOrb(node)) {
      sendJson(res, 404, { ok: false, error: `neznámy svet ${node}` })
      return true
    }
    if (id) {
      const d = await itemDetail(node, id)
      if (!d) sendJson(res, 404, { ok: false, error: 'nenájdené' })
      else sendJson(res, 200, { ok: true, node, id, ...d })
      return true
    }
    const { _raw, ...body } = await world(node)
    sendJson(res, 200, { ok: true, node, ...body })
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: errMsg(err) })
  }
  return true
}
