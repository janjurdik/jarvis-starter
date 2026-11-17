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
  const sections = (d.sections ?? []).map((s) => `<section><h4>${esc(s.title)}</h4><ul>${s.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></section>`).join('')
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
    ${d.text ? `<p class="dz-hero-text">${esc(d.text)}</p>` : ''}
    ${steps}${sections}${people}${projects}${gallery}${timeline}
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

export function createDossier({ core, canvas = document.querySelector('canvas'), onClose = () => {}, onOpen = () => {}, onAsk = () => {} } = {}) {
  injectCss()
  const inner = core.inner
  const root = document.createElement('div')
  root.id = 'dossier'
  root.className = 'dz'
  root.hidden = true
  root.innerHTML = `<header class="dz-head"><div class="dz-kicker"></div><div class="dz-headline"></div><div class="dz-comment"></div><div class="dz-legend"></div></header>
    <aside class="dz-kit" hidden><div class="dz-kit-in"></div></aside>
    <div class="dz-tags"></div>
    <div class="dz-tip" hidden><b></b><span></span></div>
    <aside class="dz-hero" hidden><button type="button" class="dz-x" aria-label="Zavrieť detail">×</button><div class="dz-hero-in"></div></aside>
    <div class="dz-light" hidden><img alt=""></div>
    <div class="dz-hint"><span>ťahaj</span> otáčanie · <span>koliesko / pinch</span> let · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> · <span>dvojklik</span> priletieť · <kbd>Esc</kbd> späť</div>`
  document.body.append(root)
  const el = {
    kicker: root.querySelector('.dz-kicker'),
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
  }
  const tagPool = Array.from({ length: LABELS }, () => {
    const t = document.createElement('button')
    t.type = 'button'
    t.className = 'dz-tag'
    t.hidden = true
    el.tags.append(t)
    return t
  })

  const yearPool = Array.from({ length: 8 }, () => {
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
  }

  function header(d) {
    el.kicker.textContent = 'Vnútro planéty'
    el.headline.textContent = d?.title ?? titleOf(node) ?? ''
    const items = d?.items ?? []
    el.comment.textContent = !d ? 'Vstupujem…' : !items.length && node === 'posta' && !d.panel ? 'Pošta ešte nie je pripojená. Povedz „pripoj mi poštu" a prevediem ťa tým.' : !items.length ? (d.panel ? '' : 'Zatiaľ je tu prázdno. Stačí povedať a začnem to sem zapisovať.') : `${nfmt(items.length)} ${items.length === 1 ? 'položka' : items.length < 5 && items.length > 1 ? 'položky' : 'položiek'}`
    // Časová os: najnovšie roky, klik preletí k ich galaxii. Inak skupiny ako legenda.
    const years = d?.layout === 'years'
    const groups = years ? [...(d?.groups ?? [])].reverse().slice(0, 12) : (d?.groups ?? []).slice(0, 8)
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
      inner.setData(d)
      // A world that is still being computed is retried a few times.
      if (d.pending && tries++ < 8) retry = setTimeout(() => open && node === id && loadWorld(id), 5000)
    } catch (err) {
      if (err?.name === 'AbortError') return
      if (err?.film) return close()
      el.comment.textContent = `Toto sa teraz nedá načítať. (${err?.message ?? 'chyba'})`
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
    el.hero.scrollTop = 0
    el.hero.hidden = false
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
      t.hidden = false
      const fs = Math.max(0.8, Math.min(2.2, 260 / g.depth))
      const tf = `translate3d(${g.x.toFixed(1)}px,${g.y.toFixed(1)}px,0) translate(-50%,-100%) scale(${fs.toFixed(2)})`
      if (t._tf !== tf) t.style.transform = t._tf = tf
    }
    const list = inner.labels(LABELS)
    const w = inner.world()
    for (let k = 0; k < tagPool.length; k++) {
      const t = tagPool[k]
      const l = list[k]
      if (!l) {
        if (!t.hidden) t.hidden = true
        continue
      }
      if (t._i !== l.i) {
        t._i = l.i
        t.textContent = l.item.t
        t.classList.toggle('is-sel', l.i === w?.sel)
      }
      t.classList.toggle('is-sel', l.i === w?.sel)
      t.hidden = false
      const tf = `translate3d(${l.x.toFixed(1)}px,${(l.y + l.r + 6).toFixed(1)}px,0) translateX(-50%)`
      if (t._tf !== tf) t.style.transform = t._tf = tf
    }
    // Hover: názov a jedna informácia pri položke.
    const h = w && w.hover >= 0 && w.hover !== w.sel ? w.hover : -1
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

  // ── vstupy ──
  let press = null
  canvas.addEventListener('pointerdown', (e) => {
    if (!open) return
    press = { x: e.clientX, y: e.clientY, moved: 0 }
  })
  window.addEventListener('pointermove', (e) => {
    if (press) press.moved += Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y)
    if (press) {
      press.x = e.clientX
      press.y = e.clientY
    }
  })
  canvas.addEventListener('pointerup', (e) => {
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
    t.addEventListener('click', (e) => {
      e.stopPropagation()
      if (Number.isInteger(t._i)) select(t._i, { fly: true })
    })
  el.hero.querySelector('.dz-x').addEventListener('click', () => deselect())
  el.heroIn.addEventListener('click', (e) => {
    const link = e.target.closest('.dz-link')
    if (link) return follow(link.dataset.node, link.dataset.id)
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

  return { open: openNode, close, back, setFilm, setOrbs, frame, isOpen: () => open, node: () => node, data: () => data }
}
