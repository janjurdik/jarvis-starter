// Vnútro planéty: klik na uzol 3D sveta spustí ponor kamery cez atmosféru planéty do jej
// vlastného vesmíru (world/inner.js cez core.inner). Tu je DOM vrstva nad ním: hlavička,
// popisky najbližších položiek, hover s jednou informáciou, inspektor detailu po kliku,
// lightbox a ovládanie letu (drag otáča, koliesko a pinch letí, WASD/šípky, dvojklik priletí).
// Esc ide po krokoch: lightbox → inspektor → von z planéty.
//
// Súkromie: v režime natáčania sa do vnútra nedá vstúpiť, pri zapnutí sa okamžite vyletí
// von a zahodia sa dáta aj obrázky z pamäte stránky. Server v tom režime vracia 403.
//
//   const dossier = createDossier({ core, canvas, onClose })
//   dossier.open('ludia')      dossier.back()      dossier.close()
//   dossier.setFilm(true)      dossier.frame()     (každú snímku po core.frame)
//   dossier.isOpen()

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const nfmt = (n) => new Intl.NumberFormat('sk-SK').format(n)

/** Farba atmosféry pri ponore, kým nepríde JSON sveta (potom platí jeho color). */
const COLOR = {
  ludia: '#7ff3ff', spravy: '#5fe6ff', projekty: '#7ff3ff', fotky: '#9fd8ff', udalosti: '#7ff3ff', spanok: '#7fb8ff',
  kalendar: '#ffb25c', rutiny: '#7ff3ff', questy: '#ffb25c', skola: '#8fb8ff', knihy: '#ffd59a', filmy: '#ff9ac8',
  miesta: '#9affc8', hudba: '#b49aff', zdroje: '#c8f0ff', ulohy: '#ffb25c', content: '#ff7ab8', posta: '#7ff3ff', hry: '#8cff8c',
}
const TITLE = {
  ludia: 'Ľudia', spravy: 'Rozhovory', projekty: 'Projekty', fotky: 'Poznámky', udalosti: 'Denník', spanok: 'Spánok',
  kalendar: 'Kalendár', rutiny: 'Rutiny', questy: 'Ciele', skola: 'Škola', knihy: 'Knihy', filmy: 'Filmy', miesta: 'Miesta',
  hudba: 'Hudba', zdroje: 'Zdroje', ulohy: 'Úlohy', content: 'Obsah', posta: 'Pošta', hry: 'Hry',
}
/** Item ids are global ("n:<path>"), links from the inspector need no per-node prefix. */
const PREFIX = {}
const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
const LABELS = 16
/** A board (Úlohy, Kalendár) names every row, not only the most important items. */
const ROW_LABELS = 72

function injectCss() {
  if (document.getElementById('dossier-css')) return
  const link = document.createElement('link')
  link.id = 'dossier-css'
  link.rel = 'stylesheet'
  link.href = '/css/dossier.css'
  document.head.append(link)
}

const img = (src, cls = '', alt = '') => (src ? `<img class="${cls}" src="${esc(src)}" alt="${esc(alt)}" decoding="async" draggable="false">` : '')

const initials = (name) =>
  String(name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()

function heroHtml(d) {
  const media = d.img ? `<div class="dz-hero-media${d.round ? ' is-round' : ''}${d.wide ? ' is-wide' : ''}">${img(d.img, '', d.title)}</div>` : ''
  const chips = d.chips?.length ? `<div class="dz-chips">${d.chips.map((c) => `<span>${esc(c)}</span>`).join('')}</div>` : ''
  const stats = d.stats?.length ? `<div class="dz-stats">${d.stats.map((s) => `<div><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`).join('')}</div>` : ''
  const steps = d.steps?.length ? `<ul class="dz-steps">${d.steps.map((s) => `<li class="${s.done ? 'is-done' : ''}">${esc(s.text)}</li>`).join('')}</ul>` : ''
  // A section is a list of lines, or one block of text that keeps its paragraphs (the reply Jarvis prepared).
  const paras = (text) => String(text).split(/\n{2,}/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('')
  const sections = (d.sections ?? []).map((s) => `<section><h4>${esc(s.title)}</h4>${s.text ? `<div class="dz-prose">${paras(s.text)}</div>` : `<ul>${(s.lines ?? []).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`}</section>`).join('')
  const body = d.paragraphs?.length ? `<div class="dz-prose">${d.paragraphs.map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>` : d.text ? `<p class="dz-hero-text">${esc(d.text)}</p>` : ''
  const actions = d.actions?.length ? `<div class="dz-acts">${d.actions.map((a, i) => `<button type="button" class="dz-act${i ? ' is-quiet' : ''}" data-say="${esc(a.say)}">${esc(a.label)}</button>`).join('')}</div>` : ''
  const timeline = d.timeline?.length ? `<section><h4>Dni v denníku</h4><div class="dz-chips">${d.timeline.map((t) => `<span>${esc(t.label)}</span>`).join('')}</div></section>` : ''
  const people = d.people?.length
    ? `<section><h4>Ľudia</h4><div class="dz-links">${d.people
        .map((p) => `<button type="button" class="dz-link is-person" data-node="${esc(p.node ?? 'ludia')}" data-id="${esc(p.id)}"><span class="dz-av">${p.img ? img(p.img, '', p.name) : `<i>${esc(initials(p.name))}</i>`}</span><span>${esc(p.name)}</span></button>`)
        .join('')}</div></section>`
    : ''
  const projects = d.projects?.length
    ? `<section><h4>Projekty</h4><div class="dz-links">${d.projects
        .map((p) => `<button type="button" class="dz-link" data-node="${esc(p.node ?? 'projekty')}" data-id="${esc(p.id)}"><span>${esc(p.title)}</span>${p.sub ? `<em>${esc(p.sub)}</em>` : ''}</button>`)
        .join('')}</div></section>`
    : ''
  const gallery = d.gallery?.length ? `<section><h4>Obrázky</h4><div class="dz-gallery">${d.gallery.map((g) => `<button type="button" data-full="${esc(g.full ?? g.img)}">${img(g.img, '', g.caption ?? '')}</button>`).join('')}</div></section>` : ''
  return `${media}<div class="dz-hero-body">
    <div class="dz-hero-title">${esc(d.title)}</div>
    ${d.sub ? `<div class="dz-sub">${esc(d.sub)}</div>` : ''}
    ${chips}${stats}
    ${body}
    ${steps}${sections}${actions}${people}${projects}${gallery}${timeline}
  </div>`
}

// ── kit: hotové komponenty, z ktorých si Jarvis skladá vnútro orbu (docs/ORBY.md) ──

const ACCENT = { amber: 'is-amber', red: 'is-red', green: 'is-green' }
const acc = (a) => ACCENT[a] ?? ''

/** One component of an orb's panel as HTML. Everything is escaped: the content is data Jarvis wrote. */
function kitHtml(c) {
  const title = c.title ? `<h4>${esc(c.title)}</h4>` : ''
  if (c.type === 'stat')
    return `<section class="kit kit-stat ${acc(c.accent)}"><span class="kit-label">${esc(c.label)}</span><b>${esc(c.value)}${c.unit ? `<i>${esc(c.unit)}</i>` : ''}</b>${c.caption ? `<span class="kit-cap">${esc(c.caption)}</span>` : ''}</section>`
  if (c.type === 'ring') {
    const v = Math.max(0, Math.min(100, Number(c.value) || 0))
    return `<section class="kit kit-ring ${acc(c.accent)}"><svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="27"/><circle class="kit-arc" cx="32" cy="32" r="27" pathLength="100" stroke-dasharray="${v} 100"/></svg><div><b>${Math.round(v)}<i>%</i></b><span class="kit-label">${esc(c.label)}</span>${c.caption ? `<span class="kit-cap">${esc(c.caption)}</span>` : ''}</div></section>`
  }
  if (c.type === 'bars') {
    const max = Math.max(1e-9, ...c.items.map((i) => Math.abs(i.value)))
    return `<section class="kit kit-bars">${title}${c.items.map((i) => `<div class="kit-bar ${acc(i.accent)}"><span>${esc(i.label)}</span><em><u style="width:${((Math.abs(i.value) / max) * 100).toFixed(1)}%"></u></em><b>${esc(nfmt(i.value))}</b></div>`).join('')}</section>`
  }
  if (c.type === 'spark') {
    const vals = c.series.map((p) => p.value)
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const span = max - min || 1
    const pts = vals.map((v, i) => `${((i / Math.max(1, vals.length - 1)) * 100).toFixed(2)},${(34 - ((v - min) / span) * 30).toFixed(2)}`)
    return `<section class="kit kit-spark">${title}<svg viewBox="0 0 100 38" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,38 ${pts.join(' ')} 100,38"/><polyline points="${pts.join(' ')}"/></svg><div class="kit-axis"><span>${esc(c.series[0]?.label ?? '')}</span><span>${esc(c.series.at(-1)?.label ?? '')}</span></div></section>`
  }
  if (c.type === 'list')
    return `<section class="kit kit-list">${title}<ul>${c.items
      .map((i) => `<li class="${acc(i.accent)}">${i.say ? `<button type="button" class="kit-row" data-say="${esc(i.say)}">` : '<div class="kit-row">'}<span><b>${esc(i.label)}</b>${i.sub ? `<em>${esc(i.sub)}</em>` : ''}</span>${i.value ? `<i>${esc(i.value)}</i>` : ''}${i.say ? '</button>' : '</div>'}</li>`)
      .join('')}</ul></section>`
  if (c.type === 'steps') return `<section class="kit kit-steps">${title}<ul class="dz-steps">${c.items.map((s) => `<li class="${s.done ? 'is-done' : ''}">${esc(s.text)}</li>`).join('')}</ul></section>`
  if (c.type === 'text') return `<section class="kit kit-text">${title}<p>${esc(c.text)}</p></section>`
  if (c.type === 'actions') return `<section class="kit kit-actions">${c.items.map((a) => `<button type="button" data-say="${esc(a.say)}">${esc(a.label)}</button>`).join('')}</section>`
  return ''
}

export function createDossier({ core, canvas = document.querySelector('canvas'), api = null, onClose = () => {}, onOpen = () => {}, onAsk = () => {} } = {}) {
  injectCss()
  const inner = core.inner
  const root = document.createElement('div')
  root.id = 'dossier'
  root.className = 'dz'
  root.hidden = true
  root.innerHTML = `<header class="dz-head">
      <button type="button" class="leave" aria-label="Opustiť"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6 4 12l6 6M4 12h16"/></svg>Opustiť<kbd>Esc</kbd></button>
      <div class="dz-title"><div class="dz-headline"></div><div class="dz-comment"></div></div>
      <div class="dz-legend"></div>
    </header>
    <aside class="dz-kit" hidden><div class="dz-kit-in"></div></aside>
    <div class="dz-tags"></div>
    <div class="dz-tip" hidden><b></b><span></span></div>
    <aside class="dz-hero" hidden><button type="button" class="dz-x" aria-label="Zavrieť detail"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button><div class="dz-hero-in"></div></aside>
    <div class="dz-light" hidden><img alt=""></div>
    <div class="dz-hint"></div>`
  document.body.append(root)
  const el = {
    headline: root.querySelector('.dz-headline'),
    comment: root.querySelector('.dz-comment'),
    legend: root.querySelector('.dz-legend'),
    tags: root.querySelector('.dz-tags'),
    kit: root.querySelector('.dz-kit'),
    kitIn: root.querySelector('.dz-kit-in'),
    tip: root.querySelector('.dz-tip'),
    hero: root.querySelector('.dz-hero'),
    heroIn: root.querySelector('.dz-hero-in'),
    light: root.querySelector('.dz-light'),
    // Over the command bar, which lies over the planet while it is open: the way back has to stay clickable.
    toast: Object.assign(document.createElement('div'), { className: 'dz-toast', hidden: true, innerHTML: '<span></span><button type="button" class="dz-toast-undo">Vrátiť</button>' }),
  }
  el.toast.setAttribute('role', 'status')
  el.toast.setAttribute('aria-live', 'polite')
  document.body.append(el.toast)
  // A label is a small group: the name (a button) and, on a row of the Úlohy board, a tick and a ×.
  const tagPool = Array.from({ length: ROW_LABELS }, () => {
    const t = document.createElement('div')
    t.className = 'dz-tag'
    t.hidden = true
    t.innerHTML = '<button type="button" class="dz-tag-main"></button>'
    t._main = t.firstChild
    el.tags.append(t)
    return t
  })

  const yearPool = Array.from({ length: 12 }, () => {
    const t = document.createElement('button')
    t.type = 'button'
    t.className = 'dz-year'
    t.hidden = true
    el.tags.append(t)
    t.addEventListener('click', (e) => {
      e.stopPropagation()
      if (t._key) inner.flyToGroup(t._key)
    })
    return t
  })

  let film = false
  let open = false
  let node = null
  let data = null
  let sel = -1
  let detailCtrl = null
  let worldCtrl = null
  let retry = null
  let tries = 0
  const cache = new Map()

  async function getJson(path, ctrl) {
    if (cache.has(path)) return cache.get(path)
    const res = await fetch(path, { cache: 'no-store', signal: ctrl.signal })
    const body = await res.json().catch(() => ({ ok: false }))
    if (!res.ok || !body.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { film: body.film })
    if (!body.pending) cache.set(path, body)
    return body
  }

  /** Orbs Jarvis added himself (and their colours): the dossier opens them like the built-in planets. */
  const extra = new Map()
  function setOrbs(list) {
    extra.clear()
    for (const n of list ?? []) if (n.custom) extra.set(n.id, { title: n.label ?? n.id, color: n.color ?? '#7ff3ff' })
  }
  const titleOf = (id) => TITLE[id] ?? extra.get(id)?.title
  const colorOf = (id) => COLOR[id] ?? extra.get(id)?.color

  /** The panel of components Jarvis wrote for this orb, left of the world. */
  function renderKit(d) {
    const panel = d?.panel ?? []
    el.kitIn.innerHTML = panel.map(kitHtml).join('')
    el.kit.hidden = !panel.length
    root.classList.toggle('has-kit', panel.length > 0)
    measureSides()
  }

  // The spoken subtitle lives between the panel on the left and the inspector on the right: how much
  // room each of them takes from the free zone goes to the page as --dz-kit and --dz-hero.
  const voiceEl = document.getElementById('voice')
  function measureSides() {
    const zone = voiceEl?.getBoundingClientRect()
    const side = (node, left) => {
      if (!open || !zone || !node || node.hidden) return 0
      const r = node.getBoundingClientRect()
      if (!r.width || getComputedStyle(node).display === 'none') return 0
      return Math.max(0, Math.round(left ? r.right - zone.left + 20 : zone.right - r.left + 20))
    }
    document.body.style.setProperty('--dz-kit', `${side(el.kit, true)}px`)
    document.body.style.setProperty('--dz-hero', `${side(el.hero, false)}px`)
  }
  window.addEventListener('resize', measureSides)

  // The inspector and the panel hang under the header, wherever it really ends (a long name or a
  // second row of groups makes it taller), so they can never slide under it.
  const headEl = root.querySelector('.dz-head')
  const measureHead = () => {
    const b = headEl.getBoundingClientRect().bottom
    if (b > 0) root.style.setProperty('--head-b', `${Math.round(b)}px`)
  }
  new ResizeObserver(measureHead).observe(headEl)
  window.addEventListener('resize', measureHead)

  const HINT_SPACE = `<span>ťahaj</span> otáčanie · <span>koliesko / pinch</span> let · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> · <span>dvojklik</span> priletieť · <kbd>Esc</kbd> späť`
  /** A board stands still, so it only says what a click does. */
  const HINT_BOARD = '<span>klik</span> otvorí položku · <kbd>Esc</kbd> späť'
  const HINT_TODO = '<span>klik</span> prepíše úlohu · <span>×</span> ju zmaže · <kbd>Esc</kbd> späť'

  function header(d) {
    const hint = d?.layout === 'board' ? ((d.items ?? []).some((i) => i.k === 'todo') ? HINT_TODO : HINT_BOARD) : HINT_SPACE
    const hintEl = root.querySelector('.dz-hint')
    if (hintEl._html !== hint) hintEl.innerHTML = hintEl._html = hint
    el.headline.textContent = d?.title ?? titleOf(node) ?? ''
    const items = d?.items ?? []
    const noMail = Boolean(d) && !items.length && node === 'posta' && !d.panel
    el.comment.textContent = !d ? 'Vstupujem…' : noMail ? 'Pošta ešte nie je pripojená. Keď ju pripojím, uvidíte tu každý mail aj s tým, čo v ňom stojí.' : !items.length ? (d.panel ? '' : 'Zatiaľ je tu prázdno. Stačí povedať a začnem to sem zapisovať.') : `${nfmt(items.length)} ${items.length === 1 ? 'položka' : items.length < 5 && items.length > 1 ? 'položky' : 'položiek'}`
    // An empty mail planet does not leave the user with a sentence to remember: one button says it for him.
    let cta = root.querySelector('.dz-cta')
    if (noMail && !cta) {
      cta = document.createElement('button')
      cta.type = 'button'
      cta.className = 'dz-act dz-cta'
      cta.dataset.say = 'Pripoj mi poštu.'
      cta.textContent = 'Pripojiť poštu'
      cta.addEventListener('click', () => onAsk(cta.dataset.say))
      root.querySelector('.dz-title').append(cta)
    } else if (!noMail && cta) cta.remove()
    // Časová os: najnovšie roky, klik preletí k ich galaxii. Inak skupiny ako legenda.
    const years = d?.layout === 'years'
    const groups = years ? [...(d?.groups ?? [])].reverse().slice(0, 12) : d?.layout === 'board' ? [] : (d?.groups ?? []).slice(0, 8)
    el.legend.innerHTML = groups.length > 1 ? groups.map((g) => (years ? `<button type="button" data-key="${esc(g.key)}">${esc(g.label ?? g.key)}</button>` : `<span>${esc(g.label ?? g.key)}</span>`)).join('') : ''
  }

  async function loadWorld(id) {
    clearTimeout(retry)
    worldCtrl?.abort()
    worldCtrl = new AbortController()
    try {
      const d = await getJson(`/api/inner/${encodeURIComponent(id)}`, worldCtrl)
      if (!open || node !== id) return
      data = d
      header(d)
      renderKit(d)
      // A board is fitted under the header and above the hint, like a page.
      if (d.layout === 'board') d.insets = { top: 122, bottom: 40 }
      inner.setData(d)
      // A world that is still being computed is retried a few times.
      if (d.pending && tries++ < 8) retry = setTimeout(() => open && node === id && loadWorld(id), 5000)
    } catch (err) {
      if (err?.name === 'AbortError') return
      if (err?.film) return close()
      // The server did not answer at all (it is restarting, an update): a few quiet tries before saying so.
      if (err instanceof TypeError && tries++ < 4) {
        retry = setTimeout(() => open && node === id && loadWorld(id), 1500)
        return
      }
      el.comment.textContent = `Toto sa teraz nedá načítať. (${err?.message === 'Failed to fetch' ? 'server neodpovedá' : err?.message ?? 'chyba'})`
    }
  }

  // ── inspektor ──
  function wireHero() {
    for (const im of el.heroIn.querySelectorAll('img')) {
      const fail = () => im.closest('.dz-hero-media, .dz-av, .dz-gallery button')?.classList.add('is-missing')
      if (im.complete && !im.naturalWidth) fail()
      else im.addEventListener('error', fail, { once: true })
    }
    const heroImg = el.heroIn.querySelector('.dz-hero-media:not(.is-round) img')
    heroImg?.addEventListener('click', () => lightbox(heroImg.src))
  }

  function showHero(d) {
    for (const im of el.heroIn.querySelectorAll('img')) im.removeAttribute('src')
    el.heroIn.innerHTML = heroHtml(d)
    el.heroIn.scrollTop = 0
    el.hero.hidden = false
    root.classList.add('has-hero')
    measureSides()
    wireHero()
  }

  /** Detail položky z dát sveta (fotky nepotrebujú server). */
  function localDetail(it) {
    if (!it.img || it.k !== 'photo') return null
    return { kind: 'photo', title: it.t, sub: it.s, img: it.img.replace(/w=\d+/, 'w=1200'), wide: true }
  }

  async function select(i, { fly = false } = {}) {
    const it = inner.item(i)
    if (!it) return deselect()
    // A task is not read, it is rewritten: the click turns its row into a text field.
    if (it.k === 'todo' && it.ref) return startEdit(i)
    sel = i
    inner.highlight(i, 'sel')
    if (fly) inner.flyTo(i)
    const local = localDetail(it)
    if (local) return showHero(local)
    showHero({ title: it.t, sub: it.s, img: it.img ? it.img.replace(/w=\d+/, it.r ? 'w=320' : 'w=640') : null, round: !!it.r })
    detailCtrl?.abort()
    detailCtrl = new AbortController()
    try {
      const d = await getJson(`/api/inner/${encodeURIComponent(node)}/${encodeURIComponent(it.id)}`, detailCtrl)
      if (!open || sel !== i) return
      showHero(d)
    } catch (err) {
      if (err?.film) close()
      // inak ostane základný detail z dát sveta
    }
  }

  function deselect() {
    sel = -1
    detailCtrl?.abort()
    inner.highlight(-1, 'sel')
    for (const im of el.heroIn.querySelectorAll('img')) im.removeAttribute('src')
    el.heroIn.textContent = ''
    el.hero.hidden = true
    root.classList.remove('has-hero')
    measureSides()
  }

  /** Odkaz z inspektora: položka v tomto svete → prelet k nej, inak len jej detail. */
  async function follow(linkNode, id) {
    const w = inner.world()
    const pre = PREFIX[linkNode]
    const cand = [id, pre ? `${pre}:${id}` : null].filter(Boolean)
    const idx = w ? cand.map((c) => w.idIndex.get(c)).find((x) => x !== undefined) : undefined
    if (idx !== undefined) return select(idx, { fly: true })
    detailCtrl?.abort()
    detailCtrl = new AbortController()
    try {
      const d = await getJson(`/api/inner/${encodeURIComponent(node)}/${encodeURIComponent(cand.at(-1))}`, detailCtrl)
      if (open) showHero(d)
    } catch (err) {
      if (err?.film) close()
    }
  }

  function lightbox(src) {
    if (!src) return
    el.light.querySelector('img').src = src
    el.light.hidden = false
  }

  function closeLight() {
    if (el.light.hidden) return false
    el.light.querySelector('img').removeAttribute('src')
    el.light.hidden = true
    return true
  }

  // ── otvorenie a zatvorenie ──

  /** Ponor do planéty. V režime natáčania nič (vráti false). */
  function openNode(id) {
    if (film || !id || !titleOf(id)) return false
    lastInput = performance.now()
    if (open && node === id) return true
    if (open) resetUi()
    if (!inner.enter(id, colorOf(id))) return false
    open = true
    node = id
    data = null
    tries = 0
    root.hidden = false
    root.classList.remove('is-in')
    header(null)
    onOpen(id)
    loadWorld(id)
    return true
  }

  function resetUi() {
    endEdit()
    hideToast()
    clearTimeout(retry)
    worldCtrl?.abort()
    detailCtrl?.abort()
    closeLight()
    deselect()
    renderKit(null)
    for (const t of tagPool) t.hidden = true
    for (const t of yearPool) t.hidden = true
    el.tip.hidden = true
    inner.keys.clear()
  }

  /** Von z planéty: svetlo, návrat k planéte a kamera odletí domov. */
  function close() {
    if (!open) return
    open = false
    resetUi()
    inner.exit()
    data = null
    root.classList.remove('is-in')
    root.hidden = true
    measureSides()
    onClose()
  }

  /** O krok späť: lightbox → inspektor → von z planéty. */
  function back() {
    if (closeLight()) return
    if (sel >= 0 || !el.hero.hidden) return deselect()
    close()
  }

  /** Režim natáčania: vyletieť hneď a zahodiť všetko (obrázky aj JSON) z pamäte stránky. */
  function setFilm(on) {
    film = Boolean(on)
    if (!film) return
    close()
    cache.clear()
  }

  // ── snímka: popisky, hover ──
  function frame() {
    const st = inner.state()
    if (!open) {
      // Popisky hlavného sveta sa vrátia až keď vnútro naozaj zmizne (po svetle pri výlete).
      if (st.phase !== 'in' && st.phase !== 'leaving' && document.body.classList.contains('inner-open')) document.body.classList.remove('inner-open')
      return
    }
    const inside = st.phase === 'in'
    document.body.classList.toggle('inner-open', inside || st.phase === 'leaving')
    root.classList.toggle('is-in', inside && st.open > 0.3)
    if (!inside) {
      for (const t of tagPool) t.hidden = true
      for (const t of yearPool) t.hidden = true
      return
    }
    // Roky časovej osi (Fotky, Udalosti): klik preletí k danej galaxii.
    const years = inner.groupLabels()
    for (let k = 0; k < yearPool.length; k++) {
      const t = yearPool[k]
      const g = years[k]
      if (!g) {
        if (!t.hidden) t.hidden = true
        continue
      }
      if (t._key !== g.key) t.textContent = t._key = g.key
      if (t._left !== g.left) t.classList.toggle('is-col', (t._left = g.left))
      t.hidden = false
      const fs = g.left ? Math.max(0.72, Math.min(1.15, 190 / g.depth)) : Math.max(0.8, Math.min(2.2, 260 / g.depth))
      const tf = `translate3d(${g.x.toFixed(1)}px,${g.y.toFixed(1)}px,0) translate(${g.left ? '0' : '-50%'},-100%) scale(${fs.toFixed(2)})`
      if (t._tf !== tf) t.style.transform = t._tf = tf
    }
    const w = inner.world()
    const board = w?.data?.layout === 'board'
    const list = board ? inner.rowLabels(ROW_LABELS) : inner.labels(LABELS)
    for (let k = 0; k < tagPool.length; k++) {
      const t = tagPool[k]
      const l = list[k]
      if (!l) {
        if (!t.hidden) t.hidden = true
        continue
      }
      // The row being rewritten is the editor now (positioned below), its label steps aside.
      if (editing && editing.id === l.item.id) {
        if (!t.hidden) t.hidden = true
        placeEditor(l)
        continue
      }
      const todo = board && l.item.k === 'todo' && Boolean(l.item.ref)
      const key = `${node}|${l.i}|${board ? 'r' : 't'}|${l.item.t}|${l.item.s ?? ''}`
      t._item = l.item
      if (t._key !== key) {
        t._key = key
        t._i = l.i
        t.classList.toggle('is-row', board)
        if (board) t._main.innerHTML = `<b>${esc(l.item.t)}</b>${l.item.s ? `<i>${esc(l.item.s)}</i>` : ''}`
        else t._main.textContent = l.item.t
        // A row has room for one line of the name: the whole of it is in the tooltip and in the detail a click opens.
        const full = todo ? l.item.ref.text : l.item.t
        t._main.title = board ? full : ''
        if (todo) t._main.setAttribute('aria-label', `Prepísať úlohu: ${full}`)
        else t._main.removeAttribute('aria-label')
        if (todo) rowActs(t, full)
        else if (t._acts) t._acts.hidden = true
        t.classList.toggle('is-todo', todo)
        if (!board) t.style.maxWidth = t.style.fontSize = ''
      }
      t.classList.toggle('is-sel', l.i === w?.sel || (board && l.i === w?.hover))
      t.classList.toggle('is-busy', todo && busy.has(l.item.id))
      t.hidden = false
      let tf
      if (board) {
        // The name sits right of its dot and shrinks with the row when the camera pulls back.
        const mw = `${Math.max(48, l.w).toFixed(0)}px`
        if (t._mw !== mw) t.style.maxWidth = t._mw = mw
        // Rows too close for two lines keep only the name, and the name may use the whole row.
        const tight = l.row < 30
        if (t._tight !== tight) t.classList.toggle('is-tight', (t._tight = tight))
        const fs = `${Math.max(0.66, Math.min(0.94, l.row / (tight ? 27 : 42))).toFixed(2)}rem`
        if (t._fs !== fs) t.style.fontSize = t._fs = fs
        tf = `translate3d(${l.x.toFixed(1)}px,${l.y.toFixed(1)}px,0) translateY(-50%)`
      } else {
        t._mw = t._fs = null
        tf = `translate3d(${l.x.toFixed(1)}px,${(l.y + l.r + 6).toFixed(1)}px,0) translateX(-50%)`
      }
      if (t._tf !== tf) t.style.transform = t._tf = tf
    }
    // Hover: názov a jedna informácia pri položke.
    // On a board the row already carries the name, so the hover only lights it up.
    const h = w && !board && w.hover >= 0 && w.hover !== w.sel ? w.hover : -1
    if (h < 0) {
      if (!el.tip.hidden) el.tip.hidden = true
    } else {
      const s = inner.screenOf(h)
      const it = w.items[h]
      if (!s) el.tip.hidden = true
      else {
        if (el.tip._i !== h) {
          el.tip._i = h
          el.tip.querySelector('b').textContent = it.t
          el.tip.querySelector('span').textContent = it.s ?? ''
        }
        el.tip.hidden = false
        el.tip.style.transform = `translate3d(${(s.x + s.r + 12).toFixed(1)}px,${(s.y - 14).toFixed(1)}px,0)`
      }
    }
  }

  // ── úlohy: × zmaže, ✓ odškrtne, klik na text prepíše (POST /api/todos, server/memory/todo-edit.mjs) ──
  const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>'
  const ICON_OK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12.5l4.2 4.2L18.5 7.8"/></svg>'
  /** Tasks with a request on the way: their row dims and takes no second click. */
  const busy = new Set()
  let editing = null

  function rowActs(t, text) {
    if (!t._acts) {
      t._acts = document.createElement('span')
      t._acts.className = 'dz-row-acts'
      t._acts.innerHTML = `<button type="button" class="dz-row-act" data-act="done">${ICON_OK}</button><button type="button" class="dz-row-act is-del" data-act="delete">${ICON_X}</button>`
      t._acts.addEventListener('click', (e) => {
        e.stopPropagation()
        const b = e.target.closest('[data-act]')
        if (b) todoAct(b.dataset.act, t._item)
      })
      t.append(t._acts)
    }
    t._acts.hidden = false
    t._acts.children[0].setAttribute('aria-label', `Hotovo: ${text}`)
    t._acts.children[0].title = 'Hotovo'
    t._acts.children[1].setAttribute('aria-label', `Zmazať úlohu: ${text}`)
    t._acts.children[1].title = 'Zmazať'
  }

  async function todoPost(body) {
    try {
      if (api?.todos) return await api.todos(body)
      const res = await fetch('/api/todos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      return res.ok && data.ok !== false ? data : { ok: false, error: data.error ?? `HTTP ${res.status}`, stale: res.status === 409 }
    } catch (err) {
      return { ok: false, error: err?.status === 0 || err instanceof TypeError ? 'Server neodpovedá, skúste to o chvíľu.' : err?.message ?? 'Nepodarilo sa.', stale: err?.status === 409 }
    }
  }

  /** The board again from the server, now (the server also tells every other open window). */
  function reload() {
    if (open && node) refresh(node)
  }

  async function todoAct(act, it) {
    if (!it?.ref || busy.has(it.id) || (act !== 'delete' && act !== 'done')) return
    if (editing) endEdit()
    busy.add(it.id)
    const r = await todoPost({ action: act, ref: it.ref })
    busy.delete(it.id)
    if (r.ok) showToast(act === 'delete' ? 'Úloha zmazaná' : 'Úloha splnená', r.undo)
    else showToast(r.error)
    reload()
  }

  // The one place a task is rewritten: a text field over its row, with the term under it.
  const ed = (() => {
    const form = document.createElement('form')
    form.className = 'dz-edit'
    form.hidden = true
    form.setAttribute('aria-label', 'Prepísať úlohu')
    form.innerHTML = `<input class="dz-edit-text" type="text" maxlength="500" autocomplete="off" spellcheck="true" enterkeyhint="done" aria-label="Text úlohy">
      <div class="dz-edit-row"><label class="dz-edit-due"><span>Termín</span><input type="date" aria-label="Termín úlohy"></label><button type="button" class="dz-edit-clear">Bez termínu</button><span class="dz-edit-keys"><kbd>Enter</kbd> uloží · <kbd>Esc</kbd> zruší</span></div>`
    el.tags.append(form)
    return { form, text: form.querySelector('.dz-edit-text'), due: form.querySelector('input[type=date]'), clear: form.querySelector('.dz-edit-clear') }
  })()

  function placeEditor(l) {
    const zone = inner.zone?.() ?? null
    const right = zone ? zone.right : window.innerWidth
    const x = l.x - 10
    const w = Math.max(260, Math.min(Math.max(l.w + 20, 380), right - x - 8))
    const tf = `translate3d(${x.toFixed(1)}px,${(l.y - 22).toFixed(1)}px,0)`
    if (ed.form._tf !== tf) ed.form.style.transform = ed.form._tf = tf
    const ws = `${Math.round(w)}px`
    if (ed.form._w !== ws) ed.form.style.width = ed.form._w = ws
  }

  function startEdit(i) {
    const it = inner.item(i)
    if (!it?.ref || busy.has(it.id)) return
    if (editing) endEdit()
    if (!el.hero.hidden) deselect()
    editing = { id: it.id, i, ref: it.ref, stale: false, busy: false }
    inner.highlight(i, 'sel')
    ed.text.value = it.ref.text
    ed.due.value = it.ref.due ?? ''
    ed.clear.hidden = !it.ref.due
    ed.form.classList.remove('is-busy')
    const l = inner.rowLabels(ROW_LABELS).find((x) => x.i === i)
    if (l) placeEditor(l)
    ed.form.hidden = false
    ed.text.focus({ preventScroll: true })
    ed.text.setSelectionRange(ed.text.value.length, ed.text.value.length)
  }

  function endEdit() {
    if (!editing) return
    const stale = editing.stale
    editing = null
    ed.form.hidden = true
    ed.form._tf = ed.form._w = null
    inner.highlight(-1, 'sel')
    if (document.activeElement && ed.form.contains(document.activeElement)) document.activeElement.blur()
    if (stale) reload()
  }

  async function commitEdit() {
    if (!editing || editing.busy) return
    const { ref, id, i } = editing
    const text = ed.text.value.replace(/\s+/g, ' ').trim()
    const due = ed.due.value || null
    // Nothing changed, or the text was emptied (a task is deleted with ×, not by an empty name): leave it as it was.
    if (!text || (text === ref.text && due === (ref.due ?? null))) {
      if (!text) showToast('Prázdnu úlohu som nechal, ako bola. Zmaže ju ×.')
      return endEdit()
    }
    editing.busy = true
    ed.form.classList.add('is-busy')
    const r = await todoPost({ action: 'edit', ref, text, due })
    const it = inner.item(i)
    if (r.ok && it?.id === id) it.t = text
    if (editing?.id === id) {
      editing.stale = true
      endEdit()
    }
    if (!r.ok) showToast(r.error)
  }

  ed.form.addEventListener('submit', (e) => {
    e.preventDefault()
    commitEdit()
  })
  // Keys typed here are text: neither the push-to-talk space nor the flight keys nor Esc of the planet see them.
  ed.form.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      commitEdit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      endEdit()
    }
  })
  ed.form.addEventListener('keyup', (e) => e.stopPropagation())
  // Leaving the editor saves it; moving between its own fields does not.
  ed.form.addEventListener('focusout', (e) => {
    if (e.relatedTarget && ed.form.contains(e.relatedTarget)) return
    commitEdit()
  })
  // A click on its button or its empty space keeps the focus in the field (Safari does not focus buttons).
  ed.form.addEventListener('mousedown', (e) => {
    if (!e.target.closest('input')) e.preventDefault()
  })
  ed.due.addEventListener('input', () => (ed.clear.hidden = !ed.due.value))
  ed.clear.addEventListener('click', () => {
    ed.due.value = ''
    ed.clear.hidden = true
    ed.text.focus({ preventScroll: true })
  })

  // A short note at the bottom of the board, with a way back for a deleted or ticked task.
  let toastTimer = null
  let toastUndo = null
  function showToast(text, undo = null) {
    clearTimeout(toastTimer)
    toastUndo = undo
    el.toast.querySelector('span').textContent = text
    el.toast.querySelector('.dz-toast-undo').hidden = !undo
    el.toast.hidden = false
    toastTimer = setTimeout(hideToast, undo ? 6000 : 4500)
  }
  function hideToast() {
    clearTimeout(toastTimer)
    toastUndo = null
    el.toast.hidden = true
  }
  el.toast.querySelector('.dz-toast-undo').addEventListener('click', async (e) => {
    e.stopPropagation()
    const undo = toastUndo
    if (!undo) return
    hideToast()
    const r = await todoPost({ action: 'restore', undo })
    if (!r.ok) showToast(r.error)
    reload()
  })

  // ── vstupy ──
  let press = null
  canvas.addEventListener('pointerdown', (e) => {
    if (!open) return
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 }
  })
  window.addEventListener('pointermove', (e) => {
    // Only the pointer that pressed counts (the mouse and the hand cursor are two pointers).
    if (press && e.pointerId !== press.id) return
    if (press) press.moved += Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y)
    if (press) {
      press.x = e.clientX
      press.y = e.clientY
    }
  })
  canvas.addEventListener('pointerup', (e) => {
    if (press && e.pointerId !== press.id) return
    const p = press
    press = null
    if (!open || !p || p.moved >= 6 || inner.state().phase !== 'in') return
    const i = inner.pick(e.clientX, e.clientY)
    if (i >= 0) select(i)
    else deselect()
  })
  canvas.addEventListener('dblclick', (e) => {
    if (!open || inner.state().phase !== 'in') return
    const i = inner.pick(e.clientX, e.clientY)
    if (i >= 0) select(i, { fly: true })
  })
  // Pinch: Safari posiela gesture udalosti, Chrome koliesko s ctrlKey.
  let gScale = 1
  canvas.addEventListener('gesturestart', (e) => {
    if (!open) return
    e.preventDefault()
    gScale = e.scale ?? 1
  })
  canvas.addEventListener('gesturechange', (e) => {
    if (!open) return
    e.preventDefault()
    const s = e.scale ?? 1
    inner.push(Math.max(-40, Math.min(40, (s - gScale) * 90)))
    gScale = s
  })
  window.addEventListener(
    'wheel',
    (e) => {
      if (!open || inner.state().phase !== 'in' || e.target !== canvas) return
      if (e.ctrlKey) {
        e.preventDefault()
        e.stopImmediatePropagation()
        inner.push(Math.max(-40, Math.min(40, -e.deltaY * 2.5)))
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) inner.look(e.deltaX * 0.6, 0)
    },
    { capture: true, passive: false },
  )
  const typing = () => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)
  window.addEventListener('keydown', (e) => {
    if (!open || e.metaKey || e.ctrlKey || e.altKey || typing() || !FLY_KEYS.has(e.code)) return
    e.preventDefault()
    inner.keys.add(e.code)
  })
  window.addEventListener('keyup', (e) => inner.keys.delete(e.code))
  window.addEventListener('blur', () => inner.keys.clear())

  for (const t of tagPool)
    t._main.addEventListener('click', (e) => {
      e.stopPropagation()
      if (Number.isInteger(t._i)) select(t._i, { fly: inner.world()?.data?.layout !== 'board' })
    })
  el.hero.querySelector('.dz-x').addEventListener('click', () => deselect())
  // The big way out: one click leaves the planet, whatever is open inside it.
  root.querySelector('.leave').addEventListener('click', () => close())
  el.heroIn.addEventListener('click', (e) => {
    const link = e.target.closest('.dz-link')
    if (link) return follow(link.dataset.node, link.dataset.id)
    const act = e.target.closest('[data-say]')
    if (act) return onAsk(act.dataset.say)
    const g = e.target.closest('.dz-gallery button')
    if (g) lightbox(g.dataset.full)
  })
  el.legend.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-key]')
    if (b) inner.flyToGroup(b.dataset.key)
  })
  el.light.addEventListener('click', () => closeLight())
  // A row or a button of the panel that carries a sentence: the click says it to Jarvis.
  el.kitIn.addEventListener('click', (e) => {
    const b = e.target.closest('[data-say]')
    if (!b) return
    onAsk(b.dataset.say)
    close()
  })
  el.kit.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true })
  // Koliesko nad inspektorom roluje len jeho obsah.
  el.hero.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true })

  // Pokoj: po 60 s bez vstupu sa z planéty vyletí samo, nech HUD nedrží naplno.
  const IDLE_MS = 60_000
  let lastInput = performance.now()
  for (const type of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'gesturechange'])
    window.addEventListener(type, () => (lastInput = performance.now()), { capture: true, passive: true })
  setInterval(() => {
    if (open && inner.keys.size === 0 && performance.now() - lastInput > IDLE_MS) close()
  }, 5000)

  /** The orb's content changed while it is open (a stráž was checked, a routine filled it, a task was deleted): load it again, unless an item is being read or rewritten. */
  function refresh(id) {
    if (!open || node !== id) return false
    // What is cached for this world is old now, also the details of its items.
    for (const k of [...cache.keys()]) if (k === `/api/inner/${encodeURIComponent(id)}` || k.startsWith(`/api/inner/${encodeURIComponent(id)}/`)) cache.delete(k)
    if (editing) {
      editing.stale = true
      return false
    }
    if (sel >= 0 || !el.hero.hidden) return false
    loadWorld(id)
    return true
  }

  return { open: openNode, close, back, refresh, setFilm, setOrbs, frame, isOpen: () => open, node: () => node, data: () => data }
}
