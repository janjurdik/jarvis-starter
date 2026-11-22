// Modul Rozhovor: vety používateľa, streaming odpovede Jarvisa s kurzorom, nástroje ako čipy
// a bohaté karty inline. Živý režim skladá ťahy z SSE udalostí `chat`, scéna a capture
// dostanú hotový zoznam ťahov pre čas t (renderStatic), takže obraz je funkcia času.

import { holoImage, icon, NODE_ICON, toolIcon } from './icons.js'
import { clamp, esc, nf } from './format.js'

const SUGGESTIONS = [
  { icon: 'kalendar', text: 'Čo mám dnes?' },
  { icon: 'todo', text: 'Aké mám otvorené úlohy?' },
  { icon: 'questy', text: 'Ako som na tom s cieľmi?' },
  { icon: 'pamat', text: 'Čo o mne vieš?' },
]

/** Karta od Jarvisa (hud_card): stat, list, chart alebo text, všetky polia voliteľné. */
export function cardHtml(card = {}) {
  const acc = card.accent === 'amber' ? ' acc-amber' : card.accent === 'red' ? ' acc-red' : ''
  const holo = holoImage(card.node)
  const ic = card.icon || NODE_ICON[card.node] || 'sparkle'
  let body = ''
  if (card.value !== undefined && card.value !== null && card.value !== '') {
    const value = typeof card.value === 'number' ? nf(card.value) : String(card.value)
    body += `<div class="card-v">${esc(value)}${card.unit ? `<small>${esc(card.unit)}</small>` : ''}</div>`
  }
  if (Array.isArray(card.series) && card.series.length) {
    const vals = card.series.map((s) => Number(s.value) || 0)
    const max = Math.max(...vals, 1)
    const hi = card.series.findIndex((s) => s.highlight) >= 0 ? card.series.findIndex((s) => s.highlight) : vals.length - 1
    body += `<div class="card-chart">${card.series
      .map((s, i) => `<span class="cc${i === hi ? ' hi' : ''}" title="${esc(s.value)}"><i style="height:${Math.max(6, Math.round((vals[i] / max) * 100))}%"></i><em>${esc(s.label ?? '')}</em></span>`)
      .join('')}</div>`
  }
  if (Array.isArray(card.items) && card.items.length) {
    body += `<ul class="card-list">${card.items
      .slice(0, 8)
      .map((it) => `<li><span class="cl-l">${esc(it.label ?? '')}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span><span class="cl-v">${esc(it.value ?? '')}</span></li>`)
      .join('')}</ul>`
  }
  if (card.text) body += `<p class="card-text">${esc(card.text)}</p>`
  if (card.caption) body += `<div class="card-c">${esc(card.caption)}</div>`
  return (
    `<div class="card${acc}${holo ? ' has-holo' : ''}">${holo ? `<img class="card-holo" src="${holo}" alt="" decoding="async">` : ''}` +
    `<div class="card-h">${icon(ic)}<span>${esc(card.title ?? '')}</span></div>${body}</div>`
  )
}

function toolHtml(tool) {
  const status = tool.status === 'error' ? 'error' : tool.status === 'ok' ? 'ok' : 'run'
  const label = tool.label || tool.name || 'Pracujem'
  return `<span class="tool ${status}">${icon(toolIcon(tool))}<span>${esc(label)}${status === 'run' ? '…' : ''}</span>${icon('check', 'tk')}</span>`
}

const thinkingHtml = '<span class="thinking" aria-label="Jarvis premýšľa"><i></i><i></i><i></i></span>'

const ATT_ICON = { pdf: 'note', doc: 'note', table: 'chart', audio: 'music', video: 'film', archive: 'archive' }
/** Where the page gets a private file from (main.js passes api.fileUrl, which adds the token when needed). */
let fileUrl = (url) => url

/** Attachments sent with a message: thumbnails of images, a named chip for anything else. */
function attachmentsHtml(items) {
  if (!Array.isArray(items) || !items.length) return ''
  return `<div class="msg-att">${items
    .map((a) =>
      a.type === 'image'
        ? `<img class="ma-img" src="${esc(fileUrl(`/api/attachment?path=${encodeURIComponent(a.rel)}`))}" alt="${esc(a.name ?? '')}" title="${esc(a.name ?? '')}" loading="lazy" decoding="async">`
        : `<span class="ma-file" title="${esc(a.name ?? '')}">${icon(ATT_ICON[a.type] ?? 'note')}<span>${esc(a.name ?? '')}</span></span>`,
    )
    .join('')}</div>`
}

/** Veta používateľa (alebo prázdny string). */
function userHtml(turn) {
  if (!turn.user) return ''
  const via = turn.via === 'voice' ? `<span class="via">${icon('mic')}</span>` : ''
  const att = attachmentsHtml(turn.attachments)
  const bubble = `<div class="msg-user">${via}${esc(turn.user)}</div>`
  return att ? `<div class="msg-u">${att}${bubble}</div>` : bubble
}

/**
 * Bloky odpovede Jarvisa ako HTML, každý zvlášť (pri streamingu sa mení len posledný).
 * parts: [{kind: 'text', text, cursor} | {kind: 'tools', items} | {kind: 'card', card}].
 */
function jarvisBlocks(turn) {
  const parts = turn.parts ?? []
  const blocks = []
  for (const p of parts) {
    if (p.kind === 'text' && (p.text || p.cursor)) blocks.push(`<p class="say">${esc(p.text)}${p.cursor ? '<i class="cursor"></i>' : ''}</p>`)
    else if (p.kind === 'tools' && p.items.length) blocks.push(`<div class="tools">${p.items.map(toolHtml).join('')}</div>`)
    else if (p.kind === 'card' && p.card) blocks.push(cardHtml(p.card))
  }
  if (turn.state === 'thinking') blocks.push(thinkingHtml)
  if (turn.state === 'error') blocks.push(`<div class="msg-err">${icon('alarm')}<span>${esc(turn.error || 'Niečo sa pokazilo.')}</span></div>`)
  if (turn.state === 'stopped') blocks.push('<div class="msg-stopped">Prerušené.</div>')
  return blocks
}

const tpl = document.createElement('template')
const nodeOf = (html) => {
  tpl.innerHTML = html
  return tpl.content.firstElementChild
}

/** Zosúladí jeden riadok ťahu s modelom, mení len bloky, ktoré sa zmenili. */
function patchTurn(row, turn) {
  const user = userHtml(turn)
  if (row._user !== user) {
    const fresh = !row._user
    row._userEl?.remove()
    row._userEl = user ? nodeOf(user) : null
    if (row._userEl) {
      if (fresh && row._born) row._userEl.classList.add('enter')
      row.prepend(row._userEl)
    }
    row._user = user
  }
  const blocks = jarvisBlocks(turn)
  if (!row._j) {
    row._j = document.createElement('div')
    row._j.className = 'msg-j'
    row._blocks = []
    row.append(row._j)
  }
  let addedCard = null
  blocks.forEach((html, i) => {
    if (row._blocks[i] === html) return
    const fresh = nodeOf(html)
    const old = row._j.children[i]
    if (old) old.replaceWith(fresh)
    else {
      // Nový blok (čip, karta, odsek) vpláva, prepis existujúceho (stream) nie.
      if (row._born) fresh.classList.add('enter')
      row._j.append(fresh)
      if (fresh.classList.contains('card')) addedCard = fresh
    }
    row._blocks[i] = html
  })
  row._born = true
  return addedCard
  while (row._j.children.length > blocks.length) row._j.lastElementChild.remove()
  row._blocks.length = blocks.length
  row._j.hidden = blocks.length === 0
}

export function createChat({ onSend, capture = false, fileUrl: toFileUrl = null }) {
  if (toFileUrl) fileUrl = toFileUrl
  const list = document.getElementById('chat')
  const view = document.getElementById('chat-view')
  const empty = document.getElementById('chat-empty')
  /** @type {Map<string, any>} */
  const turns = new Map()
  const rows = new Map()
  let stick = true
  // Rozhovor sa prekresľuje len po zmene (udalosť, dopisovanie), nie každú snímku.
  let dirty = true
  let staticSig = null
  let film = false
  let lastScrollH = 0
  let rendered = false
  let pendingCard = false

  empty.innerHTML =
    '<div class="ce-lead"><b>Som tu.</b> Napíš mi, alebo podrž medzerník a hovor.</div>' +
    `<div class="ce-list">${SUGGESTIONS.map((s) => `<button type="button" class="sugg" data-text="${esc(s.text)}">${icon(s.icon)}<span>${esc(s.text)}</span></button>`).join('')}</div>`
  empty.addEventListener('click', (e) => {
    const b = e.target.closest('.sugg')
    if (b) onSend?.(b.dataset.text, 'text')
  })
  // An attachment the browser cannot draw (HEIC outside Safari, a damaged file) turns into a named chip.
  list.addEventListener(
    'error',
    (e) => {
      const img = e.target
      if (img?.tagName !== 'IMG' || !img.classList.contains('ma-img')) return
      const chip = document.createElement('span')
      chip.className = 'ma-file'
      chip.title = img.alt
      chip.innerHTML = `${icon('fotky')}<span>${esc(img.alt)}</span>`
      img.replaceWith(chip)
    },
    true,
  )
  view.addEventListener('scroll', () => {
    // Selecting text can still push a hidden-overflow box sideways: keep it pinned to the left edge.
    if (view.scrollLeft !== 0) view.scrollLeft = 0
    stick = view.scrollHeight - view.scrollTop - view.clientHeight < 48
    view.classList.toggle('is-scrolled', view.scrollTop > 4)
  })

  const ensure = (id, init = {}) => {
    let t = turns.get(id)
    if (!t) {
      t = { id, key: `t${id}`, user: null, via: 'text', parts: [], state: 'thinking', error: null, at: Date.now(), shown: 0, film, ...init }
      turns.set(id, t)
      while (turns.size > 40) turns.delete(turns.keys().next().value)
    }
    return t
  }
  const lastText = (t) => {
    const last = t.parts[t.parts.length - 1]
    if (last?.kind === 'text') return last
    const p = { kind: 'text', text: '', target: '' }
    t.parts.push(p)
    return p
  }

  /** Živá udalosť z SSE alebo mocku: {turn, phase, ...}. */
  function apply(ev) {
    if (!ev || ev.turn === undefined || ev.turn === null) return
    const t = ensure(String(ev.turn))
    switch (ev.phase) {
      case 'user':
        t.user = ev.text ?? ''
        t.via = ev.via ?? 'text'
        if (Array.isArray(ev.attachments)) t.attachments = ev.attachments
        stick = true
        break
      case 'start':
        if (t.state !== 'done') t.state = 'thinking'
        stick = true
        break
      case 'delta': {
        const p = lastText(t)
        const prev = p.target ?? p.text
        let chunk = ev.text ?? ''
        // Dva textové bloky (napr. pred a po hud_focus) by sa zlepili bez medzery: „pane.Dnes".
        if (/[.?!…:]$/.test(prev) && /^[\p{Lu}\p{N}„]/u.test(chunk)) chunk = ` ${chunk}`
        p.target = prev + chunk
        t.state = 'streaming'
        break
      }
      case 'tool': {
        let group = t.parts[t.parts.length - 1]
        const existing = t.parts.flatMap((p) => (p.kind === 'tools' ? p.items : [])).find((x) => ev.id && x.id === ev.id)
        if (existing) Object.assign(existing, { status: ev.status ?? existing.status, label: ev.label ?? existing.label, icon: ev.icon ?? existing.icon, node: ev.node ?? existing.node })
        else {
          if (group?.kind !== 'tools') {
            group = { kind: 'tools', items: [] }
            t.parts.push(group)
          }
          group.items.push({ id: ev.id, name: ev.name, label: ev.label, icon: ev.icon, node: ev.node, status: ev.status ?? 'run' })
        }
        if (t.state === 'thinking' || t.state === 'streaming') t.state = 'thinking'
        break
      }
      case 'card':
        if (ev.card) {
          t.parts.push({ kind: 'card', card: ev.card })
          // Nová karta sa ukáže celá od vrchu, ďalší text ju nesmie odscrollovať preč.
          pendingCard = true
        }
        break
      case 'done': {
        const full = ev.text ?? ''
        const streamed = t.parts.filter((p) => p.kind === 'text').map((p) => p.target ?? p.text).join('')
        if (full && !streamed.trim()) lastText(t).target = full
        else if (full && full.replace(/\s+/g, '') !== streamed.replace(/\s+/g, '')) {
          // Odpoveď sa líši od streamu (napr. server ju upravil): posledný textový blok nahradí rozdiel.
          const before = t.parts.filter((p) => p.kind === 'text').slice(0, -1).map((p) => p.target ?? p.text).join('')
          if (full.startsWith(before)) lastText(t).target = full.slice(before.length)
        }
        for (const g of t.parts) if (g.kind === 'tools') for (const x of g.items) if (x.status === 'run') x.status = 'ok'
        t.state = 'done'
        break
      }
      case 'error':
        t.state = 'error'
        t.error = ev.message ?? 'Chyba'
        break
      case 'stopped':
        t.state = 'stopped'
        break
      default:
        break
    }
    dirty = true
  }

  /** Esc: aktuálny ťah sa označí ako prerušený. */
  function stopActive() {
    for (const t of turns.values()) {
      if (t.state === 'thinking' || t.state === 'streaming') {
        for (const p of t.parts) if (p.kind === 'text' && p.target !== undefined) p.text = p.target
        for (const g of t.parts) if (g.kind === 'tools') for (const x of g.items) if (x.status === 'run') x.status = 'ok'
        t.state = 'stopped'
      }
    }
    dirty = true
  }

  /** História zo servera: [{turn, user, jarvis, tools, cards, at}]. */
  function loadHistory(items = []) {
    for (const h of items) {
      if (turns.has(String(h.turn))) continue
      const parts = []
      if (Array.isArray(h.tools) && h.tools.length) parts.push({ kind: 'tools', items: h.tools.map((x) => ({ ...x, status: x.status === 'error' ? 'error' : 'ok' })) })
      if (h.jarvis) parts.push({ kind: 'text', text: h.jarvis, target: h.jarvis })
      for (const card of h.cards ?? []) parts.push({ kind: 'card', card })
      const t = ensure(String(h.turn), { user: h.user ?? null, via: h.via ?? 'text', attachments: h.attachments ?? [], parts, state: 'done', at: h.at ? Date.parse(h.at) : Date.now(), history: true })
      t.shown = Infinity
    }
    // Poradie podľa času.
    const sorted = [...turns.values()].sort((a, b) => a.at - b.at)
    turns.clear()
    for (const t of sorted) turns.set(t.id, t)
    dirty = true
  }

  function setFilm(on) {
    film = on
    if (on) for (const t of turns.values()) t.preFilm = true
    dirty = true
  }

  function clear() {
    turns.clear()
    for (const row of rows.values()) row.remove()
    rows.clear()
    dirty = true
  }

  /** Aktívny ťah (premýšľa alebo píše) pre stav hlasu a príkazového riadku. */
  function activeState() {
    let state = null
    for (const t of turns.values()) {
      if (t.state === 'thinking') state = 'thinking'
      else if (t.state === 'streaming') state = state ?? 'streaming'
    }
    return state
  }

  /** The turn Jarvis is working on without saying anything yet: { label (the tool that runs, or null), since (ms) }. */
  function work() {
    let out = null
    for (const t of turns.values()) {
      if (t.state !== 'thinking' || t.history) continue
      const tools = t.parts.flatMap((p) => (p.kind === 'tools' ? p.items : []))
      const run = tools.filter((x) => x.status === 'run').pop()
      out = { label: run ? run.label || run.name || null : null, since: t.at }
    }
    return out
  }

  /** Uzly, na ktorých Jarvis práve pracuje: {node: since}. */
  function busyNodes() {
    const out = {}
    for (const t of turns.values()) for (const g of t.parts) if (g.kind === 'tools') for (const x of g.items) if (x.status === 'run' && x.node) out[x.node] = x.since ?? (x.since = performance.now() / 1000)
    return out
  }

  // ── vykreslenie ──
  function syncRows(model) {
    let addedCard = null
    const keep = new Set(model.map((t) => t.key))
    for (const [key, row] of rows) {
      if (!keep.has(key)) {
        row.remove()
        rows.delete(key)
      }
    }
    model.forEach((t, i) => {
      let row = rows.get(t.key)
      if (!row) {
        row = document.createElement('li')
        row.className = 'turn'
        // Ťahy z histórie pri štarte sa len zobrazia, nové vplávajú.
        row._born = rendered
        rows.set(t.key, row)
      }
      if (list.children[i] !== row) list.insertBefore(row, list.children[i] ?? null)
      const cls = `turn${t.preFilm ? ' pre-film' : ''}`
      if (row._cls !== cls) row.className = row._cls = cls
      addedCard = patchTurn(row, t) ?? addedCard
    })
    rendered = true
    const visible = model.some((t) => !(film && t.preFilm))
    if (empty.hidden !== visible) empty.hidden = visible
    if (view.hidden !== !visible) view.hidden = !visible
    const h = view.scrollHeight
    if (addedCard && pendingCard) {
      // Karta hore v okne rozhovoru (offsetTop je voči .chat-view), kým používateľ sám neodscrolluje.
      view.scrollTop = Math.max(0, addedCard.offsetTop - 12)
      stick = false
      pendingCard = false
    } else if (stick && h !== lastScrollH) view.scrollTop = h
    lastScrollH = h
    const scrolled = view.scrollTop > 4
    if (view._scrolled !== scrolled) view.classList.toggle('is-scrolled', (view._scrolled = scrolled))
  }

  /** Živý režim: písací stroj dobieha stream (plynulo, nie po kusoch zo siete). */
  function frame(dt) {
    if (!dirty) return
    let catching = false
    const model = []
    for (const t of turns.values()) {
      const parts = t.parts.map((p, idx) => {
        if (p.kind !== 'text') return p
        const target = p.target ?? p.text ?? ''
        const isLast = idx === t.parts.length - 1
        if (p.text.length < target.length) {
          const behind = target.length - p.text.length
          const step = Math.max(1, Math.round(Math.max(55 * dt, behind * clamp(dt * 7))))
          p.text = target.slice(0, Math.min(target.length, p.text.length + step))
          catching ||= p.text.length < target.length
        } else if (p.text.length > target.length) p.text = target
        const streaming = t.state === 'streaming' || (t.state === 'done' && p.text.length < target.length)
        return { kind: 'text', text: p.text, cursor: isLast && streaming }
      })
      model.push({ ...t, parts })
    }
    syncRows(model)
    // Kým písací stroj dobieha text, kresli ďalej, potom ticho až do ďalšej udalosti.
    dirty = catching
  }

  /** Scéna a capture: hotové ťahy pre čas t, žiadny vlastný stav. Prekreslí len pri zmene. */
  function renderStatic(model) {
    const sig = model
      .map((t) => `${t.key}:${t.state}:${t.user ? 1 : 0}:${t.parts.map((p) => (p.kind === 'text' ? `${p.text.length}${p.cursor ? 'c' : ''}` : p.kind === 'tools' ? p.items.map((x) => x.status).join('') : 'k')).join(',')}`)
      .join('|')
    if (sig === staticSig) return
    staticSig = sig
    syncRows(model)
  }

  return { apply, stopActive, loadHistory, setFilm, clear, activeState, work, busyNodes, frame, renderStatic, get size() { return turns.size } }
}
