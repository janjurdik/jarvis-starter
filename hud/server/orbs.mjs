/**
 * The orbs of the 3D world as data, so Jarvis can extend his own interface.
 *
 * Two things live here:
 *
 *   data/orbs.json        which orbs exist besides the built-in ones, and which are hidden or pinned
 *                         { hidden: [id], pinned: [id], custom: [{ id, label, icon, color, shape, kind, folder }] }
 *   data/orbs/<id>.json   what an orb shows: the number on its label and the inside of the planet
 *                         { value, sub, alert, items, groups, panel, updatedAt }
 *
 * `panel` is a list of ready-made components (stat, bars, list, ring, spark, steps, text,
 * actions). Jarvis describes what should be on screen and the HUD draws it, so a new feature
 * (mail triage, a habit tracker, a budget) needs no new front-end code. docs/ORBY.md has the
 * whole vocabulary.
 *
 *   GET  /api/orbs             { hidden, pinned, custom, content: { id: { value, sub, alert, panel } }, shapes, icons }
 *   POST /api/orbs             { action: add|update|remove|hide|show|pin|unpin|content|clear, id, … }
 *
 * Everything here is display data. Text is cut to sane lengths and never treated as markup.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, clean, cleanBlock } from './util.mjs'

const ORBS_FILE = join(DATA_DIR, 'orbs.json')
const CONTENT_DIR = join(DATA_DIR, 'orbs')

/** Built-in orbs (hud/public/js/orbs.js). A custom orb may not take one of these ids. */
export const BUILTIN = ['appky', 'posta', 'kalendar', 'ulohy', 'rutiny', 'questy', 'spanok', 'ludia', 'udalosti', 'fotky', 'projekty', 'spravy', 'skola', 'knihy', 'filmy', 'hudba', 'miesta', 'zdroje', 'content', 'hry']
/** Holograms a custom orb can borrow (hud/public/js/world/nodes.js). */
export const SHAPES = ['orb', 'posta', 'ludia', 'skola', 'knihy', 'filmy', 'miesta', 'hudba', 'satnik', 'zdroje', 'hry', 'ulohy', 'content', 'kalendar', 'rutiny', 'projekty', 'questy', 'spravy', 'fotky', 'udalosti', 'spanok']
export const ICONS = ['info', 'mail', 'todo', 'kalendar', 'people', 'person', 'heart', 'chart', 'book', 'music', 'film', 'globe', 'code', 'note', 'folder', 'bell', 'flag', 'sparkle', 'bolt', 'shield', 'search', 'phone', 'card', 'coffee', 'cap', 'pin', 'news', 'gift', 'play', 'app', 'laptop', 'route', 'hourglass', 'check', 'alarm', 'sun', 'cloud', 'memory', 'eye', 'target', 'link', 'archive']
const ACCENTS = ['ice', 'amber', 'red', 'green']
const MAX_CUSTOM = 12
const MAX_ITEMS = 400

const isId = (id) => typeof id === 'string' && /^[a-z][a-z0-9-]{1,23}$/.test(id)
const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
const fail = (message) => Object.assign(new Error(message), { status: 400 })

function readJsonFile(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  } catch {
    return null
  }
}

function writeJsonFile(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

// ── registry ───────────────────────────────────────────────────────────

function cleanCustom(c) {
  if (!c || !isId(c.id) || BUILTIN.includes(c.id)) return null
  const label = clean(c.label, 24)
  if (!label) return null
  return {
    id: c.id,
    label,
    icon: ICONS.includes(c.icon) ? c.icon : 'sparkle',
    color: isColor(c.color) ? c.color.toLowerCase() : '#7ff3ff',
    shape: SHAPES.includes(c.shape) ? c.shape : 'orb',
    kind: c.kind === 'moon' ? 'moon' : 'planet',
    // A folder in the memory whose notes fill the inside of the orb (memory/<folder>/).
    ...(typeof c.folder === 'string' && /^[a-z0-9][a-z0-9 _-]{0,31}$/i.test(c.folder) ? { folder: c.folder } : {}),
  }
}

export function getOrbState() {
  const raw = readJsonFile(ORBS_FILE) ?? {}
  const ids = (list) => [...new Set((Array.isArray(list) ? list : []).filter(isId))]
  const custom = []
  for (const c of Array.isArray(raw.custom) ? raw.custom : []) {
    const ok = cleanCustom(c)
    if (ok && !custom.some((x) => x.id === ok.id) && custom.length < MAX_CUSTOM) custom.push(ok)
  }
  return { hidden: ids(raw.hidden).filter((id) => id !== 'appky'), pinned: ids(raw.pinned), custom }
}

const saveState = (state) => writeJsonFile(ORBS_FILE, { hidden: state.hidden, pinned: state.pinned, custom: state.custom })

export const customOrb = (id) => getOrbState().custom.find((c) => c.id === id) ?? null
export const knownOrb = (id) => BUILTIN.includes(id) || Boolean(customOrb(id))

// ── content: label numbers, items and the component panel ──────────────

const accent = (a) => (ACCENTS.includes(a) ? a : undefined)
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''))

/** One component of the panel. Anything unknown is dropped: the HUD only draws what it has a part for. */
/** A value on a card may arrive as a number („value": 14): it is shown as written, never dropped. */
const text = (v, max) => clean(typeof v === 'number' && Number.isFinite(v) ? String(v) : v, max)

function cleanComponent(c) {
  if (!c || typeof c !== 'object') return null
  const title = clean(c.title, 48) || undefined
  const list = (items, max, fn) => (Array.isArray(items) ? items : []).slice(0, max).map(fn).filter(Boolean)
  switch (c.type) {
    case 'stat':
      return strip({ type: 'stat', label: clean(c.label, 40), value: text(c.value, 16), unit: clean(c.unit, 12), caption: clean(c.caption, 80), accent: accent(c.accent) })
    case 'ring': {
      const value = num(c.value)
      return value === null ? null : strip({ type: 'ring', label: clean(c.label, 40), value: Math.max(0, Math.min(100, value)), caption: clean(c.caption, 80), accent: accent(c.accent) })
    }
    case 'bars':
      return {
        type: 'bars',
        ...(title ? { title } : {}),
        items: list(c.items, 8, (i) => (num(i?.value) === null ? null : strip({ label: clean(i.label, 32), value: num(i.value), accent: accent(i.accent) }))),
      }
    case 'spark':
      return { type: 'spark', ...(title ? { title } : {}), series: list(c.series, 31, (i) => (num(i?.value) === null ? null : { label: clean(i.label, 12), value: num(i.value) })) }
    case 'list':
      return {
        type: 'list',
        ...(title ? { title } : {}),
        // `say`: a click sends this sentence to Jarvis, so a row can be a button ("Priprav odpoveď na …").
        items: list(c.items, 12, (i) => (clean(i?.label, 80) ? strip({ label: clean(i.label, 80), sub: clean(i.sub, 100), value: text(i.value, 16), accent: accent(i.accent), say: clean(i.say, 240) }) : null)),
      }
    case 'steps':
      return { type: 'steps', ...(title ? { title } : {}), items: list(c.items, 14, (i) => (clean(i?.text, 100) ? { text: clean(i.text, 100), done: i.done === true } : null)) }
    case 'text':
      return clean(c.text, 600) ? strip({ type: 'text', title, text: clean(c.text, 600) }) : null
    case 'actions':
      return { type: 'actions', items: list(c.items, 4, (i) => (clean(i?.label, 28) && clean(i?.say, 240) ? { label: clean(i.label, 28), say: clean(i.say, 240) } : null)) }
    default:
      return null
  }
}

function cleanContent(raw) {
  if (!raw || typeof raw !== 'object') return null
  const groups = (Array.isArray(raw.groups) ? raw.groups : []).slice(0, 12).map((g) => (clean(g?.key, 32) ? { key: clean(g.key, 32), label: clean(g.label ?? g.key, 32) } : null)).filter(Boolean)
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .slice(0, MAX_ITEMS)
    .map((it, i) => {
      const t = clean(it?.t ?? it?.title, 80)
      if (!t) return null
      const imp = num(it.imp)
      // `text` is the content itself (what the mail says, not just its subject) and keeps its paragraphs.
      return strip({
        id: `o:${clean(it.id, 40) || i}`,
        t,
        s: clean(it.s ?? it.sub, 120),
        g: clean(it.g ?? it.group, 32) || 'iné',
        imp: imp === null ? 0.4 : Math.max(0, Math.min(1, imp)),
        from: clean(it.from, 80),
        at: clean(it.at ?? it.when, 40),
        text: cleanBlock(it.text, 4000),
        reply: cleanBlock(it.reply, 2000),
        say: clean(it.say, 200),
        // The label of the button that sends `say` (default „Vybav to").
        act: clean(it.act, 28),
      })
    })
    .filter(Boolean)
  const panel = (Array.isArray(raw.panel) ? raw.panel : []).slice(0, 12).map(cleanComponent).filter((c) => c && (!('items' in c) || c.items.length) && (!('series' in c) || c.series.length))
  return strip({
    value: text(raw.value, 12),
    sub: clean(raw.sub, 40),
    alert: raw.alert === true ? true : undefined,
    groups: groups.length ? groups : undefined,
    items: items.length ? items : undefined,
    panel: panel.length ? panel : undefined,
    updatedAt: typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt)) ? raw.updatedAt : new Date().toISOString(),
  })
}

const contentFile = (id) => join(CONTENT_DIR, `${id}.json`)

/** What an orb shows, already cleaned. null when Jarvis has not written anything for it. */
export function orbContent(id) {
  if (!isId(id)) return null
  return cleanContent(readJsonFile(contentFile(id)))
}

function contentIndex() {
  let files = []
  try {
    files = readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return {}
  }
  const out = {}
  for (const f of files.slice(0, 64)) {
    const id = f.slice(0, -5)
    const c = orbContent(id)
    if (c) out[id] = strip({ value: c.value, sub: c.sub, alert: c.alert, count: c.items?.length, panel: Boolean(c.panel), updatedAt: c.updatedAt })
  }
  return out
}

/** Everything the page needs to draw the ring of orbs. */
export function getOrbs() {
  return { ...getOrbState(), content: contentIndex() }
}

// ── changes ────────────────────────────────────────────────────────────

/**
 * One change to the orbs. Returns { summary } for whoever asked (the brain, the CLI).
 * Throws an Error with status 400 and a Slovak message when the request makes no sense.
 */
export function changeOrbs(body = {}) {
  const action = String(body.action ?? '')
  const id = String(body.id ?? '').toLowerCase().trim()
  const state = getOrbState()
  const without = (list) => list.filter((x) => x !== id)
  if (!isId(id)) throw fail('Orb potrebuje id: malé písmená, číslice a pomlčky, 2 až 24 znakov (napríklad "financie").')

  if (action === 'add' || action === 'update') {
    if (BUILTIN.includes(id)) {
      // A built-in orb is not redefined: asking for it simply brings it (back) into the world.
      saveState({ ...state, hidden: without(state.hidden), pinned: [...new Set([...state.pinned, id])] })
      return { summary: `Orb ${id} je vo svete.` }
    }
    const prev = state.custom.find((c) => c.id === id)
    if (!prev && action === 'update') throw fail(`Orb ${id} neexistuje.`)
    if (!prev && state.custom.length >= MAX_CUSTOM) throw fail(`Vlastných orbov môže byť najviac ${MAX_CUSTOM}. Niektorý najprv odober.`)
    const next = cleanCustom({ ...prev, ...Object.fromEntries(['label', 'icon', 'color', 'shape', 'kind', 'folder'].filter((k) => body[k] !== undefined).map((k) => [k, body[k]])), id })
    if (!next) throw fail('Orb potrebuje názov (label).')
    saveState({ ...state, hidden: without(state.hidden), custom: [...state.custom.filter((c) => c.id !== id), next] })
    if (body.content !== undefined) setContent(id, body.content)
    return { summary: `Orb „${next.label}" ${prev ? 'je upravený' : 'pribudol do sveta'}.` }
  }
  if (action === 'remove') {
    if (BUILTIN.includes(id)) {
      if (id === 'appky') throw fail('Orb Tvoje appky ostáva vždy.')
      saveState({ ...state, hidden: [...new Set([...state.hidden, id])], pinned: without(state.pinned) })
      return { summary: `Orb ${id} je skrytý. Vráti ho „ukáž orb ${id}".` }
    }
    if (!state.custom.some((c) => c.id === id)) throw fail(`Orb ${id} neexistuje.`)
    saveState({ ...state, hidden: without(state.hidden), pinned: without(state.pinned), custom: state.custom.filter((c) => c.id !== id) })
    rmSync(contentFile(id), { force: true })
    return { summary: `Orb ${id} je preč.` }
  }
  if (!knownOrb(id)) throw fail(`Orb ${id} neexistuje.`)
  if (action === 'hide') {
    if (id === 'appky') throw fail('Orb Tvoje appky ostáva vždy.')
    saveState({ ...state, hidden: [...new Set([...state.hidden, id])], pinned: without(state.pinned) })
    return { summary: `Orb ${id} je skrytý.` }
  }
  if (action === 'show' || action === 'pin') {
    saveState({ ...state, hidden: without(state.hidden), pinned: [...new Set([...state.pinned, id])] })
    return { summary: `Orb ${id} je vo svete.` }
  }
  if (action === 'unpin') {
    saveState({ ...state, pinned: without(state.pinned) })
    return { summary: `Orb ${id} sa ukáže, len keď v ňom niečo je.` }
  }
  if (action === 'content') {
    const c = setContent(id, body.content)
    return { summary: `Orb ${id} ukazuje nový obsah${c.panel ? ` (${c.panel.length} ${c.panel.length === 1 ? 'komponent' : c.panel.length < 5 ? 'komponenty' : 'komponentov'})` : ''}.` }
  }
  if (action === 'clear') {
    rmSync(contentFile(id), { force: true })
    return { summary: `Obsah orbu ${id} je zmazaný.` }
  }
  throw fail(`Neznáma akcia ${action}. Poznám add, update, remove, hide, show, pin, unpin, content a clear.`)
}

function setContent(id, raw) {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      throw fail('Obsah orbu musí byť platný JSON.')
    }
  }
  const c = cleanContent(value)
  if (!c) throw fail('Obsah orbu musí byť objekt (value, sub, items, panel).')
  writeJsonFile(contentFile(id), { ...c, updatedAt: new Date().toISOString() })
  return c
}
