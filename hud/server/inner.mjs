/**
 * Inner worlds of the planets: every item of a node (people, projects, goals, days, notes…)
 * with its importance and links, for the 3D dive into a planet (public/js/world/inner.js).
 * Everything comes from the local memory folder.
 *
 *   GET /api/inner                 item counts for planet labels
 *   GET /api/inner/:node           { title, color, layout, groups, items: [{ id, t, s, imp, g, y, links, r, k }] }
 *   GET /api/inner/:node/:id       item detail for the inspector
 *
 * Privacy: in filming mode 403 (inner worlds cannot be entered).
 */
import { chatStats, readDay } from './chatlog.mjs'
import { getConfig } from './config.mjs'
import { calendarRange } from './memory/calendar.mjs'
import { FOLDERS, STATUS_LABEL, checkboxes, dayStats, firstParagraph, getIndex, inFolder, ofKind, plain, section, slugify, statusOf, todos } from './memory/index.mjs'
import { addDays, errMsg, isoDay, sendJson } from './util.mjs'

/** Planets with fixed art in the 3D world. Extra memory folders reuse the art of a known moon when the name matches. */
export const PLANETS = {
  ludia: { title: 'Ľudia', color: '#7ff3ff', layout: 'cluster' },
  projekty: { title: 'Projekty', color: '#7ff3ff', layout: 'cluster' },
  questy: { title: 'Ciele', color: '#ffb25c', layout: 'cluster' },
  kalendar: { title: 'Kalendár', color: '#ffb25c', layout: 'cluster' },
  rutiny: { title: 'Rutiny', color: '#7ff3ff', layout: 'cluster' },
  udalosti: { title: 'Denník', color: '#7ff3ff', layout: 'years' },
  spravy: { title: 'Rozhovory', color: '#5fe6ff', layout: 'years' },
  fotky: { title: 'Poznámky', color: '#9fd8ff', layout: 'cluster' },
  spanok: { title: 'Spánok', color: '#7fb8ff', layout: 'years' },
  ulohy: { title: 'Úlohy', color: '#ffb25c', layout: 'cluster' },
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
}

const nf = (n) => new Intl.NumberFormat('sk-SK').format(n)
const norm = (values) => {
  const max = Math.max(1e-9, ...values)
  return values.map((v) => v / max)
}
const cut = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''))
const shortDay = (day) => `${Number(day.slice(8))}. ${Number(day.slice(5, 7))}. ${day.slice(0, 4)}`
const yearFrac = (day) => Number(day.slice(0, 4)) + (Number(day.slice(5, 7)) - 1) / 12 + Number(day.slice(8)) / 372
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
    const days = dayStats(ix).filter((d) => d.sleepMin || d.mood)
    const items = days.map((d) => ({
      id: `s:${d.day}`,
      t: shortDay(d.day),
      s: [d.sleepMin ? `spánok ${fmtMin(d.sleepMin)}` : null, d.mood ? `nálada ${d.mood}/5` : null].filter(Boolean).join(' · '),
      img: null,
      imp: d.sleepMin ? Math.min(1, d.sleepMin / 540) : 0.3,
      g: d.day.slice(0, 4),
      y: yearFrac(d.day),
      k: 'sleep',
    }))
    return { items, groups: [...new Set(items.map((i) => i.g))].sort().map((key) => ({ key, label: key })) }
  },
  kalendar: async () => {
    const today = isoDay()
    const events = await calendarRange(today, addDays(today, 60))
    const items = events.map((e, i) => {
      const days = Math.round((new Date(`${e.day}T12:00:00`) - new Date(`${today}T12:00:00`)) / 86_400_000)
      return {
        id: `e:${e.day}:${i}`,
        t: e.title,
        s: `${shortDay(e.day)}${e.time ? ` · ${e.time}` : ''}${e.place ? ` · ${e.place}` : ''}`,
        img: null,
        imp: Math.max(0.08, 1 - days / 45),
        g: MONTHS[Number(e.day.slice(5, 7)) - 1],
        k: 'event',
        ev: e,
      }
    })
    return { items, groups: [...new Set(items.map((i) => i.g))].map((key) => ({ key, label: key })) }
  },
  rutiny: () => {
    const items = getConfig().routines.map((r) => ({ id: `r:${r.id}`, t: r.title, s: `${r.time} · ${r.enabled ? 'zapnutá' : 'vypnutá'}`, img: null, imp: r.enabled ? 0.8 : 0.3, g: r.enabled ? 'zapnuté' : 'vypnuté', k: 'routine' }))
    return { items, groups: [...new Set(items.map((i) => i.g))].map((key) => ({ key, label: key })) }
  },
  ulohy: async () => {
    const list = (await todos()).filter((t) => !t.done)
    const today = isoDay()
    const items = list.map((t, i) => ({
      id: `t:${i}`,
      t: cut(t.text, 60),
      s: [t.group, t.due ? `do ${shortDay(t.due)}` : null].filter(Boolean).join(' · ') || null,
      img: null,
      imp: t.due ? (t.due <= today ? 1 : Math.max(0.3, 1 - (new Date(t.due) - new Date(today)) / (30 * 864e5))) : 0.25,
      g: t.group ?? 'Úlohy',
      k: 'todo',
      full: t.text,
    }))
    return { items, groups: [...new Set(items.map((i) => i.g))].map((key) => ({ key, label: key })) }
  },
}

const extraWorld = (folder) => (ix) => notesWorld(ix, inFolder(ix, folder), { group: (n) => String(n.fm.stav ?? n.fm.zaner ?? n.fm['žáner'] ?? n.fm.typ ?? folder), sub: (n) => cut(firstParagraph(n.body, 80), 80) || null })

async function world(node) {
  const ix = await getIndex()
  const build = WORLDS[node] ?? (EXTRA[node] ? extraWorld(node) : null)
  if (!build) return null
  const meta = PLANETS[node] ?? { ...EXTRA[node], layout: 'cluster' }
  const w = await build(ix)
  // `ev` and `full` are server-side helpers for details, not part of the wire format.
  return { title: meta.title, color: meta.color, layout: meta.layout, groups: w.groups, items: w.items.map(({ ev, full, ...it }) => it), _raw: w.items }
}

// ── item detail ────────────────────────────────────────────────────────

function noteDetail(ix, n) {
  const steps = checkboxes(n.body)
  const chips = []
  if (n.kind === 'person') {
    if (relationOf(n) !== 'ostatní') chips.push(relationOf(n))
    if (n.fm.narodeniny) chips.push(`narodeniny ${n.fm.narodeniny}`)
  } else if (n.kind === 'project' || n.kind === 'goal') chips.push(STATUS_LABEL[statusOf(n)])
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
    sub: n.rel,
    round: n.kind === 'person',
    chips,
    stats: [
      { value: nf(n.words), label: 'slov' },
      { value: nf(ix.backlinks.get(n.rel)?.size ?? 0), label: 'odkazov' },
      ...(steps.length ? [{ value: `${steps.filter((s) => s.done).length}/${steps.length}`, label: 'krokov' }] : []),
    ],
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
      stats: [stat?.sleepMin ? { value: fmtMin(stat.sleepMin), label: 'spánok' } : null, stat?.mood ? { value: `${stat.mood}/5`, label: 'nálada' } : null].filter(Boolean),
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
  if (it.k === 'routine') {
    const r = getConfig().routines.find((x) => `r:${x.id}` === id)
    return { kind: 'routine', title: it.t, sub: it.s, text: r ? `Rutina beží sama v čase ${r.time}. Zadanie je v súbore routines/${r.id}.md, výsledok nájdeš v pamäti v priečinku schranka.` : null }
  }
  return { title: it.t, sub: it.s }
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
  return counts
}

export async function routeInner(req, res, url, { film }) {
  const path = url.pathname
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
    if (!PLANETS[node] && !EXTRA[node]) {
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
