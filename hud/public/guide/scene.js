// Scene engine for the export guide.
// A scene is plain data: a frame (phone, browser or app window), one or more screens built from
// generic items, and a list of actions a cursor performs on them. Every source reuses this engine,
// so adding a source means writing data in guides.js, never new drawing code.
//
//   {
//     frame: 'phone' | 'browser' | 'app',
//     url: 'takeout.google.com',            // browser address bar or app window title
//     screens: { main: Screen, next: Screen },   // or put bar/side/items directly on the scene
//     acts: [['tap', 'id'], ['go', 'next'], ['set', 'format', 'JSON'], ...],
//   }
//   Screen = { bar: { title, back, id, avatar, right: [{ id, icon }] }, side: [items], sideFoot, items: [items], tabbar }
//
// Actions: tap, pick (tap + select a radio option), tick / untick (tap + checkbox or switch),
// go / back (slide to another screen), set (change a value with emphasis), open / close (sheet, menu
// or dialog), show / hide (reveal an item), hot (highlight), type, run (progress bar), clear
// (uncheck everything on the screen), swap (change a label), toast, scroll, wait.

const ICON = {
  gear: 'M12 9.4a2.6 2.6 0 1 0 0 5.2a2.6 2.6 0 0 0 0-5.2ZM12 5.8a6.2 6.2 0 1 0 0 12.4a6.2 6.2 0 0 0 0-12.4ZM12 3v2.8M12 18.2V21M3 12h2.8M18.2 12H21M5.6 5.6l2 2M16.4 16.4l2 2M5.6 18.4l2-2M16.4 7.6l2-2',
  user: 'M12 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8ZM4.5 20.5c1-4 4-5.5 7.5-5.5s6.5 1.5 7.5 5.5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  dots: 'M12 4.6a.9.9 0 1 0 0 1.8a.9.9 0 0 0 0-1.8ZM12 11.1a.9.9 0 1 0 0 1.8a.9.9 0 0 0 0-1.8ZM12 17.6a.9.9 0 1 0 0 1.8a.9.9 0 0 0 0-1.8Z',
  dotsh: 'M5.5 11.1a.9.9 0 1 0 0 1.8a.9.9 0 0 0 0-1.8ZM12 11.1a.9.9 0 1 0 0 1.8a.9.9 0 0 0 0-1.8ZM18.5 11.1a.9.9 0 1 0 0 1.8a.9.9 0 0 0 0-1.8Z',
  chev: 'M9 5.5l6.5 6.5L9 18.5',
  back: 'M15 5.5L8.5 12l6.5 6.5',
  lock: 'M6.5 11h11v9h-11zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  down: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14',
  file: 'M7 3.5h7l4 4V20.5H7zM14 3.5v4h4',
  zip: 'M7 3.5h7l4 4V20.5H7zM14 3.5v4h4M10.5 10v1.5M10.5 13.5V15M10.5 17v1.5',
  mail: 'M3.5 6.5h17v11h-17zM3.5 7l8.5 6.5L20.5 7',
  share: 'M12 15V3.5M8 7l4-4 4 4M6 11.5v8h12v-8',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  search: 'M11 18a7 7 0 1 0 0-14a7 7 0 0 0 0 14ZM16.2 16.2L20.5 20.5',
  folder: 'M3.5 6.5h6l2 2.5h9v10.5h-17z',
  shield: 'M12 3.5l7.5 3v5.5c0 4.5-3.2 7.6-7.5 8.5c-4.3-.9-7.5-4-7.5-8.5V6.5z',
  clock: 'M12 20.5a8.5 8.5 0 1 0 0-17a8.5 8.5 0 0 0 0 17ZM12 7.5V12l3 2',
  phone: 'M8 2.5h8a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5ZM10.5 18.5h3',
  laptop: 'M5 5.5h14v10H5zM2.5 19h19',
  globe: 'M12 20.5a8.5 8.5 0 1 0 0-17a8.5 8.5 0 0 0 0 17ZM3.5 12h17M12 3.5c2.5 2.5 3.5 5.3 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.3-3.5-8.5s1-6 3.5-8.5Z',
  ext: 'M14 4.5h5.5V10M19.5 4.5L11 13M17.5 13.5v6h-13v-13h6',
  cable: 'M12 21v-6.5M8.5 14.5h7V9h-7zM10.5 9V5M13.5 9V5',
  cloud: 'M7.5 18.5a4.5 4.5 0 0 1-.6-8.96A5.5 5.5 0 0 1 17.6 10.6a4 4 0 0 1-.6 7.9z',
  x: 'M6 6l12 12M18 6L6 18',
  play: 'M8 5.5v13l10.5-6.5z',
  pause: 'M8.5 5.5v13M15.5 5.5v13',
  replay: 'M4.5 12a7.5 7.5 0 1 0 2.4-5.5M4.5 4.5v3.5H8',
  left: 'M19 12H5M11 6l-6 6 6 6',
  right: 'M5 12h14M13 6l6 6-6 6',
  clip: 'M19 11.5l-7.5 7.5a4.6 4.6 0 0 1-6.5-6.5l8-8a3.1 3.1 0 0 1 4.4 4.4l-8 8a1.6 1.6 0 0 1-2.2-2.2l7.2-7.2',
  air: 'M12 13.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3ZM7.8 18.2a6 6 0 1 1 8.4 0M5 20.5a9.8 9.8 0 1 1 14 0',
  heart: 'M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20Z',
  chat: 'M4.5 5.5h15v10.5h-8l-4.5 3.5v-3.5h-2.5z',
  spark: 'M11 4l1.7 5.3L18 11l-5.3 1.7L11 18l-1.7-5.3L4 11l5.3-1.7zM18.5 16v4.5M16.25 18.25h4.5',
  note: 'M9 17.5V5.5l10-2v12M9 17.5a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0ZM19 15.5a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0Z',
  pin: 'M12 21s6.5-6 6.5-11a6.5 6.5 0 0 0-13 0c0 5 6.5 11 6.5 11ZM12 12.5a2.5 2.5 0 1 0 0-5a2.5 2.5 0 0 0 0 5Z',
  book: 'M5 4.5h10.5a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3zM5 16.5a3 3 0 0 1 3-3h10.5',
  image: 'M4 5.5h16v13H4zM4 15l4.5-4 4 3.5 3-2.5 4.5 4',
  bell: 'M6.5 16.5v-5.5a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14zM10.5 20.5h3',
  home: 'M4 11l8-7 8 7v9.5h-5v-6h-6v6H4z',
  plus: 'M12 5v14M5 12h14',
  info: 'M12 20.5a8.5 8.5 0 1 0 0-17a8.5 8.5 0 0 0 0 17ZM12 11v5.5M12 7.2v.6',
  warn: 'M12 4l9 15.5H3zM12 10v4.5M12 16.8v.6',
  plug: 'M9 3.5v5M15 3.5v5M6.5 8.5h11v3a5.5 5.5 0 0 1-11 0zM12 17v3.5',
  dot: 'M12 10a2 2 0 1 0 0 4a2 2 0 0 0 0-4Z',
}

export function icon(name, cls = '') {
  return `<svg class="gi${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[name] ?? ICON.dot}"/></svg>`
}

// ── item builders (used by guides.js) ───────────────────────────────────────
// A label is a string, or [slovak, english] when the research verified the Slovak one.

export const row = (id, label, o = {}) => ({ k: 'row', id, label, ...o })
export const head = (label, right) => ({ k: 'head', label, right })
export const btn = (id, label, o = {}) => ({ k: 'btn', id, label, ...o })
export const chk = (id, label, on = false, o = {}) => ({ k: 'chk', id, label, on, ...o })
export const tog = (id, label, on = false) => ({ k: 'tog', id, label, on })
export const opt = (id, label, on = false, o = {}) => ({ k: 'opt', id, label, on, ...o })
export const txt = (label) => ({ k: 'txt', label })
export const big = (label, sub) => ({ k: 'big', label, sub })
export const field = (id, label, val = '') => ({ k: 'field', id, label, val })
export const mail = (id, o) => ({ k: 'mail', id, ...o })
export const file = (id, name, meta, o = {}) => ({ k: 'file', id, name, meta, ...o })
export const prog = (id, label) => ({ k: 'prog', id, label })
export const fill = (n = 3) => ({ k: 'fill', n })
export const chat = () => ({ k: 'chat' })
export const who = (name, sub) => ({ k: 'who', name, sub })
export const apps = (list) => ({ k: 'apps', list })
export const sheet = (id, items, o = {}) => ({ k: 'sheet', id, items, ...o })
export const hid = (item) => ({ ...item, hidden: true })

// ── rendering ───────────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const lab = (l) => (Array.isArray(l) ? `<b data-aim>${esc(l[0])}</b><i>${esc(l[1])}</i>` : `<b data-aim>${esc(l)}</b>`)
const plain = (l) => (Array.isArray(l) ? l[0] : l)
const at = (it, cls) =>
  `class="it ${cls}${it.on ? ' is-on' : ''}${it.hidden ? ' is-hidden' : ''}${it.dim ? ' is-dim' : ''}${it.primary ? ' is-primary' : ''}${it.small ? ' is-small' : ''}"${it.id ? ` data-id="${esc(it.id)}"` : ''}`

const ITEM = {
  row: (it) =>
    `<div ${at(it, 'it-row')}>${it.icon ? `<span class="it-ic">${icon(it.icon)}</span>` : ''}<span class="it-lb">${lab(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>${it.val != null ? `<span class="it-val" data-val>${esc(it.val)}</span>` : ''}${it.chev === false ? '' : icon('chev', 'it-chev')}</div>`,
  head: (it) =>
    `<div class="it-head"><span>${esc(plain(it.label))}</span>${it.right ? `<span class="it-hbtn" data-id="${esc(it.right.id)}">${icon(it.right.icon)}</span>` : ''}</div>`,
  btn: (it) => `<div ${at(it, 'it-btn')}>${it.icon ? icon(it.icon) : ''}${it.label ? `<span class="it-lb">${lab(it.label)}</span>` : ''}</div>`,
  chk: (it) => `<div ${at(it, 'it-chk')}><span class="it-box" data-aim>${icon('check')}</span><span class="it-lb">${lab(it.label).replaceAll(' data-aim', '')}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span></div>`,
  tog: (it) => `<div ${at(it, 'it-tog')}><span class="it-lb">${lab(it.label).replaceAll(' data-aim', '')}</span><span class="it-sw" data-aim><i></i></span></div>`,
  opt: (it) => `<div ${at(it, 'it-opt')}><span class="it-lb">${lab(it.label)}</span><span class="it-radio"><i></i></span></div>`,
  txt: (it) => `<p class="it-txt">${esc(it.label)}</p>`,
  big: (it) => `<div class="it-big"><b>${esc(plain(it.label))}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</div>`,
  field: (it) => `<div ${at(it, 'it-field')}><small>${esc(plain(it.label))}</small><span class="it-fv" data-val data-aim>${esc(it.val)}</span></div>`,
  mail: (it) =>
    `<div ${at(it, 'it-mail')}><div class="it-mh">${icon('mail')}<span><b>${esc(it.from)}</b><small></small></span></div>${it.body ? `<p>${esc(it.body)}</p>` : ''}${it.btn ? `<div class="it it-btn is-primary is-small" data-id="${esc(it.id)}-btn">${it.btn === true ? icon('down') : `<span class="it-lb">${lab(it.btn)}</span>`}</div>` : ''}</div>`,
  file: (it) =>
    `<div ${at(it, 'it-file')}><span class="it-fic">${icon(it.icon ?? 'zip')}</span><span class="it-lb"><b data-aim>${esc(it.name)}</b>${it.meta ? `<small>${esc(it.meta)}</small>` : ''}</span>${it.btn ? `<span class="it it-btn is-small" data-id="${esc(it.id)}-btn">${it.btn === true ? icon('down') : `<span class="it-lb">${lab(it.btn)}</span>`}</span>` : ''}</div>`,
  prog: (it) => `<div ${at(it, 'it-prog')}><span class="it-lb"><b>${esc(plain(it.label))}</b></span><span class="it-bar"><i></i></span></div>`,
  fill: (it) => Array.from({ length: it.n }, (_, i) => `<div class="it it-fill"><span style="width:${[52, 68, 41, 60, 47][i % 5]}%"></span></div>`).join(''),
  chat: () => '<div class="it-chat"><span class="l" style="width:58%"></span><span class="r" style="width:44%"></span><span class="l" style="width:36%"></span><span class="r" style="width:62%"></span><span class="l" style="width:50%"></span></div>',
  who: (it) => `<div class="it-who"><span class="sc-av is-big"></span><b>${esc(it.name)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</div>`,
  apps: (it) =>
    `<div class="it-apps">${it.list.map((a) => `<span class="it-app${a.id ? ' is-key' : ''}"${a.id ? ` data-id="${esc(a.id)}"` : ''}><span data-aim>${a.icon ? icon(a.icon) : ''}</span><small>${a.label ? esc(a.label) : ''}</small></span>`).join('')}</div>`,
  sheet: (it) =>
    `<div class="sc-sheet sc-sheet-${it.kind ?? 'sheet'}${it.at ? ` at-${it.at}` : ''}${it.open ? ' is-open' : ''}" data-id="${esc(it.id)}"><i class="sc-scrim"></i><div class="sc-sheet-in">${it.title ? `<div class="sc-sheet-t">${esc(plain(it.title))}</div>` : ''}${items(it.items)}</div></div>`,
}

function items(list = []) {
  return list.map((it) => ITEM[it.k](it)).join('')
}

function barIcons(list = []) {
  return list
    .map((b) => (b.avatar ? `<span class="sc-av" data-id="${esc(b.id)}"></span>` : `<span class="sc-bi"${b.id ? ` data-id="${esc(b.id)}"` : ''}>${icon(b.icon)}</span>`))
    .join('')
}

function screen(name, s, first) {
  const bar = s.bar
    ? `<header class="sc-bar">${bar_left(s.bar)}<div class="sc-bar-t"${s.bar.id ? ` data-id="${esc(s.bar.id)}"` : ''}>${s.bar.avatar ? '<span class="sc-av"></span>' : ''}<span>${lab(s.bar.title ?? '')}</span></div><span class="sc-bar-r">${barIcons(s.bar.right)}</span></header>`
    : ''
  const sheets = (s.items ?? []).filter((it) => it.k === 'sheet')
  const body = (s.items ?? []).filter((it) => it.k !== 'sheet')
  const foot = s.sideFoot
    ? `<div class="sc-side-foot"${s.sideFoot.id ? ` data-id="${esc(s.sideFoot.id)}"` : ''}><span class="sc-av"></span><span class="sc-side-name" data-aim>${esc(s.sideFoot.label ?? '')}</span>${barIcons(s.sideFoot.right)}</div>`
    : ''
  const side = s.side ? `<nav class="sc-side"><div class="sc-side-in">${items(s.side)}</div>${foot}</nav>` : ''
  const tabs = s.tabbar
    ? `<footer class="sc-tabbar">${s.tabbar.map((t) => `<span class="sc-tab${t.on ? ' is-on' : ''}"${t.id ? ` data-id="${esc(t.id)}"` : ''}>${t.avatar ? '<span class="sc-av"></span>' : icon(t.icon)}${t.label ? `<small>${esc(t.label)}</small>` : ''}</span>`).join('')}</footer>`
    : ''
  return `<section class="sc-screen${first ? ' is-on' : ''}" data-screen="${esc(name)}">${bar}<div class="sc-cols">${side}<div class="sc-scroll">${items(body)}</div></div>${tabs}${items(sheets)}</section>`
}

function bar_left(bar) {
  const back = bar.back ? `<span class="sc-bi sc-back">${icon('back')}</span>` : ''
  return `<span class="sc-bar-l">${back}${barIcons(bar.left)}</span>`
}

function normalize(spec) {
  const screens = spec.screens ?? { main: { bar: spec.bar, side: spec.side, sideFoot: spec.sideFoot, items: spec.items, tabbar: spec.tabbar } }
  return { frame: spec.frame ?? 'phone', url: spec.url ?? '', screens, acts: spec.acts ?? [] }
}

function frame(spec) {
  const names = Object.keys(spec.screens)
  const view = `<div class="sc-view">${names.map((n, i) => screen(n, spec.screens[n], i === 0)).join('')}<div class="sc-toast"></div><i class="sc-cur sc-cur-${spec.frame === 'phone' ? 'finger' : 'arrow'}">${spec.frame === 'phone' ? '' : '<svg viewBox="0 0 24 24"><path d="M5 3l14 8.2-6.3 1.5L9.6 19z"/></svg>'}</i></div>`
  if (spec.frame === 'phone') {
    return `<div class="sc sc-phone"><div class="sc-dev"><div class="sc-status"><span>9:41</span><i class="sc-notch"></i><span class="sc-sig"><i></i><i></i><i></i></span></div>${view}<i class="sc-homebar"></i></div><span class="sc-tag">ilustrácia</span></div>`
  }
  const chrome =
    spec.frame === 'browser'
      ? `<div class="sc-chrome"><span class="sc-lights"><i></i><i></i><i></i></span><span class="sc-url">${icon('lock')}<span>${esc(spec.url)}</span></span></div>`
      : `<div class="sc-chrome"><span class="sc-lights"><i></i><i></i><i></i></span><span class="sc-win">${esc(spec.url)}</span></div>`
  return `<div class="sc sc-${spec.frame}"><div class="sc-dev">${chrome}${view}</div><span class="sc-tag">ilustrácia</span></div>`
}

// ── player ──────────────────────────────────────────────────────────────────

const CANCEL = Symbol('cancel')
const TAPS = new Set(['tap', 'pick', 'tick', 'untick'])
const NAV = new Set(['go', 'back', 'open', 'close', 'toast', 'wait', 'scroll'])
const EASE = 'cubic-bezier(0.3, 0.7, 0.2, 1)'
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

export class Scene {
  constructor(host, spec) {
    this.host = host
    this.spec = normalize(spec)
    this.run = 0
    this.paused = false
    this.loop = true
    this.onEnd = null
    this.build()
  }

  build() {
    this.host.innerHTML = frame(this.spec)
    this.view = this.host.querySelector('.sc-view')
    this.cur = this.host.querySelector('.sc-cur')
    this.toastEl = this.host.querySelector('.sc-toast')
    this.screens = [...this.view.querySelectorAll('.sc-screen')]
    this.active = this.screens[0]
    this.pos = null
  }

  /** Plays the actions once, then (when looping) again after a short hold. */
  async play() {
    const run = ++this.run
    this.build()
    if (reduced()) {
      this.final()
      this.onEnd?.()
      return
    }
    try {
      await this.sleep(550, run)
      for (const act of this.spec.acts) {
        await this.gate(run)
        await this.step(act, run)
      }
      this.mark()
      await this.sleep(700, run)
      this.cur.classList.remove('is-in')
      this.onEnd?.()
      if (!this.loop) return
      await this.sleep(2600, run)
      await this.gate(run)
      this.play()
    } catch (err) {
      if (err !== CANCEL) throw err
    }
  }

  stop() {
    this.run++
  }

  /** Leaves a highlight on the last tapped element, so the eye stays on it while the scene rests. */
  mark() {
    const last = this.spec.acts.findLast((a) => TAPS.has(a[0]))
    const el = last && this.find(last[1])
    if (el && this.visible(el)) el.classList.add('is-hot')
    return el
  }

  pause(on) {
    this.paused = on
    if (!on) this.wake?.()
  }

  /** End state without movement: every change applied, the last tapped element ringed while it is still on screen. */
  final() {
    const acts = this.spec.acts
    let last = -1
    acts.forEach((a, i) => {
      if (TAPS.has(a[0])) last = i
    })
    // A value changed after the last tap (Format: JSON) matters more than the tapped Save button.
    const keepNav = acts.slice(last + 1).some((a) => a[0] === 'set')
    acts.forEach((a, i) => {
      if (i > last && !keepNav && NAV.has(a[0])) return
      this.mutate(...a)
    })
    if (last < 0) return
    const el = this.find(acts[last][1])
    if (!el || !this.visible(el)) return
    this.scrollTo(el, true)
    el.classList.add('is-aim', 'is-hot')
    const p = this.point(el)
    this.cur.style.transform = `translate(${p.x}px, ${p.y}px)`
    this.cur.classList.add('is-in')
  }

  // ── timing ────────────────────────────────────────────────────────────────

  sleep(ms, run) {
    return new Promise((resolve, reject) => setTimeout(() => (run === this.run ? resolve() : reject(CANCEL)), ms))
  }

  gate(run) {
    if (!this.paused) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.wake = () => (run === this.run ? resolve() : reject(CANCEL))
    })
  }

  // ── lookups ───────────────────────────────────────────────────────────────

  find(id) {
    const sel = `[data-id="${CSS.escape(id)}"]`
    return this.active.querySelector(sel) ?? this.view.querySelector(sel)
  }

  visible(el) {
    if (el.closest('.sc-screen') !== this.active) return false
    if (el.closest('.is-hidden')) return false
    const sheet = el.closest('.sc-sheet')
    return !sheet || sheet.classList.contains('is-open')
  }

  /** Where the cursor should land, in view coordinates. */
  point(el) {
    const aim = el.matches('[data-aim]') ? el : (el.querySelector('[data-aim]') ?? el)
    const r = aim.getBoundingClientRect()
    const v = this.view.getBoundingClientRect()
    const x = aim.tagName === 'B' ? r.left + Math.min(r.width / 2, r.height * 2.2) : r.left + r.width / 2
    return { x: clamp(x - v.left, 6, v.width - 6), y: clamp(r.top + r.height / 2 - v.top, 6, v.height - 6) }
  }

  // ── state changes (no animation, shared by play and final) ────────────────

  mutate(op, a, b) {
    const el = typeof a === 'string' && !['go', 'back', 'toast'].includes(op) ? this.find(a) : null
    switch (op) {
      case 'go':
      case 'back':
        for (const s of this.screens) s.classList.toggle('is-on', s.dataset.screen === a)
        this.active = this.screens.find((s) => s.dataset.screen === a) ?? this.active
        break
      case 'set':
        if (el) {
          el.querySelector('[data-val]').textContent = b
          el.classList.add('is-hot')
        }
        break
      case 'tick':
        el?.classList.add('is-on', 'is-hot')
        break
      case 'untick':
        el?.classList.remove('is-on')
        break
      case 'pick':
        if (el) {
          for (const o of el.parentElement.querySelectorAll('.it-opt')) o.classList.remove('is-on', 'is-hot')
          el.classList.add('is-on', 'is-hot')
        }
        break
      case 'clear':
        for (const c of this.active.querySelectorAll('.it-chk, .it-tog')) c.classList.remove('is-on', 'is-hot')
        break
      case 'open':
        el?.classList.add('is-open')
        break
      case 'close':
        el?.classList.remove('is-open')
        break
      case 'show':
        el?.classList.remove('is-hidden')
        break
      case 'hide':
        el?.classList.add('is-hidden')
        break
      case 'hot':
        el?.classList.add('is-hot')
        break
      case 'type':
        if (el) el.querySelector('[data-val]').textContent = b
        break
      case 'run':
        el?.classList.add('is-full')
        break
      case 'swap':
        if (el) (el.querySelector('b') ?? el).textContent = b
        break
      case 'toast':
        this.toastEl.textContent = a
        this.toastEl.classList.add('is-on')
        break
    }
  }

  // ── animated steps ────────────────────────────────────────────────────────

  async step([op, a, b], run) {
    if (TAPS.has(op)) {
      await this.tap(a, run)
      if (op !== 'tap') this.mutate(op, a)
      return this.sleep(op === 'tap' ? 120 : 320, run)
    }
    switch (op) {
      case 'wait':
        return this.sleep(a, run)
      case 'go':
      case 'back':
        return this.slide(a, op === 'go' ? 1 : -1, run)
      case 'set':
        return this.setValue(a, b, run)
      case 'type':
        return this.typeText(a, b, run)
      case 'scroll':
        return this.scrollTo(this.find(a), false, run)
      case 'run': {
        const el = this.find(a)
        el?.classList.add('is-run')
        await this.sleep(1700, run)
        el?.classList.add('is-full')
        return
      }
      case 'show': {
        const el = this.find(a)
        this.mutate(op, a)
        if (el) {
          await this.scrollTo(el, false, run)
          el.animate([{ opacity: 0, transform: 'translateY(0.6em)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: EASE })
        }
        return this.sleep(480, run)
      }
      case 'toast':
        this.mutate(op, a)
        await this.sleep(1500, run)
        this.toastEl.classList.remove('is-on')
        return
      case 'open':
      case 'close':
        this.mutate(op, a)
        return this.sleep(460, run)
      default:
        this.mutate(op, a, b)
        return this.sleep(300, run)
    }
  }

  async tap(id, run) {
    const el = this.find(id)
    if (!el) return
    await this.scrollTo(el, false, run)
    el.classList.add('is-aim')
    const p = this.point(el)
    const v = this.view.getBoundingClientRect()
    const from = this.pos ?? { x: v.width * 0.72, y: v.height * 0.84 }
    const ms = clamp(360 + Math.hypot(p.x - from.x, p.y - from.y) * 1.25, 460, 950)
    const tr = (q) => `translate(${q.x}px, ${q.y}px)`
    this.cur.style.transform = tr(p)
    this.cur.animate([{ transform: tr(from) }, { transform: tr(p) }], { duration: ms, easing: 'cubic-bezier(0.5, 0, 0.2, 1)' })
    this.cur.classList.add('is-in')
    this.pos = p
    await this.sleep(ms + 110, run)
    this.cur.classList.add('is-down')
    el.classList.add('is-press')
    this.ripple(p)
    await this.sleep(190, run)
    this.cur.classList.remove('is-down')
    await this.sleep(230, run)
    el.classList.remove('is-press', 'is-aim')
  }

  ripple(p) {
    const r = document.createElement('i')
    r.className = 'sc-rip'
    r.style.left = `${p.x}px`
    r.style.top = `${p.y}px`
    this.view.append(r)
    setTimeout(() => r.remove(), 700)
  }

  async slide(name, dir, run) {
    const from = this.active
    const to = this.screens.find((s) => s.dataset.screen === name)
    if (!to || to === from) return
    const phone = this.spec.frame === 'phone'
    const shift = phone ? 100 : 6
    to.classList.add('is-on')
    this.active = to
    const opts = { duration: 400, easing: EASE }
    to.animate([{ transform: `translateX(${shift * dir}%)`, opacity: phone ? 1 : 0 }, { transform: 'none', opacity: 1 }], opts)
    from.animate([{ transform: 'none', opacity: 1 }, { transform: `translateX(${(phone ? -28 : -6) * dir}%)`, opacity: 0 }], opts)
    await this.sleep(400, run)
    from.classList.remove('is-on')
    await this.sleep(220, run)
  }

  async setValue(id, value, run) {
    const el = this.find(id)
    const v = el?.querySelector('[data-val]')
    if (!v) return
    await this.scrollTo(el, false, run)
    v.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-0.5em)' }], { duration: 180, fill: 'forwards' })
    await this.sleep(190, run)
    v.getAnimations().forEach((x) => x.cancel())
    this.mutate('set', id, value)
    v.animate(
      [{ opacity: 0, transform: 'translateY(0.5em) scale(0.9)' }, { opacity: 1, transform: 'scale(1.16)', offset: 0.55 }, { opacity: 1, transform: 'none' }],
      { duration: 520, easing: EASE },
    )
    await this.sleep(900, run)
  }

  async typeText(id, text, run) {
    const v = this.find(id)?.querySelector('[data-val]')
    if (!v) return
    v.textContent = ''
    for (const ch of text) {
      v.textContent += ch
      await this.sleep(55, run)
    }
    await this.sleep(240, run)
  }

  /** Scrolls the list so the element sits comfortably inside the visible part. */
  async scrollTo(el, instant, run) {
    const list = el?.closest('.sc-scroll, .sc-side-in, .sc-sheet-in')
    if (!list) return
    const lr = list.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const pad = Math.min(lr.height * 0.16, r.height)
    let d = 0
    if (r.bottom > lr.bottom - pad) d = r.bottom - lr.bottom + pad
    else if (r.top < lr.top + pad) d = r.top - lr.top - pad
    const start = list.scrollTop
    const end = clamp(start + d, 0, list.scrollHeight - list.clientHeight)
    if (Math.abs(end - start) < 2) return
    if (instant) {
      list.scrollTop = end
      return
    }
    const t0 = performance.now()
    const ms = clamp(Math.abs(end - start) * 3, 380, 800)
    await new Promise((resolve, reject) => {
      const tick = (t) => {
        if (run !== this.run) return reject(CANCEL)
        const k = clamp((t - t0) / ms, 0, 1)
        list.scrollTop = start + (end - start) * (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2)
        if (k < 1) requestAnimationFrame(tick)
        else resolve()
      }
      requestAnimationFrame(tick)
    })
    await this.sleep(160, run)
  }
}

/** Lists actions whose target does not exist in the scene (used when adding a source). */
export function checkScene(spec) {
  const s = normalize(spec)
  const ids = new Set()
  const names = new Set(Object.keys(s.screens))
  const walk = (list = []) => {
    for (const it of list) {
      if (it.id) ids.add(it.id)
      if ((it.k === 'mail' || it.k === 'file') && it.btn) ids.add(`${it.id}-btn`)
      if (it.right?.id) ids.add(it.right.id)
      if (it.items) walk(it.items)
      if (it.list) walk(it.list)
    }
  }
  for (const sc of Object.values(s.screens)) {
    walk(sc.items)
    walk(sc.side)
    walk(sc.tabbar)
    walk(sc.bar?.right)
    walk(sc.bar?.left)
    walk(sc.sideFoot?.right)
    if (sc.bar?.id) ids.add(sc.bar.id)
    if (sc.sideFoot?.id) ids.add(sc.sideFoot.id)
  }
  const bad = []
  for (const [op, a] of s.acts) {
    if (op === 'wait' || op === 'toast' || op === 'clear') continue
    if (op === 'go' || op === 'back') {
      if (!names.has(a)) bad.push(`${op} ${a}`)
    } else if (!ids.has(a)) bad.push(`${op} ${a}`)
  }
  return bad
}
