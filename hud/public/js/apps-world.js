// Tvoje appky: the inside of the orb. Every app floats in space as a glass disc with its real
// icon, grouped into constellations (Správy, Mail a kalendár, …). A click opens an app and takes it into
// Jarvis: it lights up amber and a thread of light connects it to the core. The whole map fits
// the free zone, the wheel flies closer, a click on a constellation name flies to it.
//
// The 3D part is the shared inner world (world/inner.js, layout "atlas"); this file is the layer
// above it: names, search, the detail of one app, the tray of what is already in Jarvis and the
// selection itself (GET/POST /api/apps, SSE `apps`).
//
//   const apps = createAppsWorld({ core, canvas, onClose, onAsk })
//   apps.open(appId?)   apps.close()   apps.back()   apps.frame()   apps.sync(state)   apps.isOpen()

import { APPS, APP_BY_ID, GROUPS, HOW } from '../apps/catalog.js'
import { appColor, appShape, appSvg, isDark } from '../apps/glyph.js'
import { icon } from './icons.js'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const TILE = 192
const COLOR = '#7ff3ff'
const NAME_LABELS = 44
const AD_URL = 'https://www.superclovek.ai/?utm_source=jarvis&utm_medium=app&utm_campaign=appky'
const OWN_MAX = 12

function injectCss() {
  if (document.getElementById('apps-world-css')) return
  const link = document.createElement('link')
  link.id = 'apps-world-css'
  link.rel = 'stylesheet'
  link.href = '/css/apps-world.css'
  document.head.append(link)
}

// ── icons as textures ──────────────────────────────────────────────────

const tiles = new Map()

/** A round glass disc with the app's mark, as a data URL the inner world loads like any image. */
function tileUrl(app) {
  const hit = tiles.get(app.id)
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = c.height = TILE
  const g = c.getContext('2d')
  const hex = appColor(app)
  const dark = isDark(hex)
  const tint = dark ? '#cfe3e8' : hex
  const r = TILE / 2
  // The disc: near black glass, the brand colour gathers toward the rim.
  const body = g.createRadialGradient(r * 0.8, r * 0.62, r * 0.05, r, r, r)
  body.addColorStop(0, '#16242b')
  body.addColorStop(0.62, '#0a1319')
  body.addColorStop(1, '#050b0f')
  g.fillStyle = body
  g.fillRect(0, 0, TILE, TILE)
  const rim = g.createRadialGradient(r, r, r * 0.55, r, r, r)
  rim.addColorStop(0, `${tint}00`)
  rim.addColorStop(1, `${tint}55`)
  g.fillStyle = rim
  g.fillRect(0, 0, TILE, TILE)
  // A soft highlight on the upper left, like light on a lens.
  const shine = g.createRadialGradient(r * 0.62, r * 0.42, 0, r * 0.62, r * 0.42, r * 0.7)
  shine.addColorStop(0, 'rgba(255,255,255,0.16)')
  shine.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = shine
  g.fillRect(0, 0, TILE, TILE)
  const shape = appShape(app)
  const s = TILE * 0.46
  g.save()
  g.shadowColor = tint
  g.shadowBlur = TILE * 0.09
  g.fillStyle = dark ? '#f2fbff' : tint
  if (shape.d) {
    g.translate(r - s / 2, r - s / 2)
    g.scale(s / 24, s / 24)
    g.fill(new Path2D(shape.d))
  } else {
    g.font = `700 ${shape.text.length > 1 ? s * 0.66 : s * 0.9}px "Inter Tight", system-ui, sans-serif`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(shape.text, r, r + TILE * 0.02)
  }
  g.restore()
  const url = c.toDataURL('image/png')
  tiles.set(app.id, url)
  return url
}

/** Draws the icons a few at a time while the page is idle, so opening the orb never stutters. */
export function warmAppTiles() {
  const todo = APPS.filter((a) => !tiles.has(a.id))
  const step = (deadline) => {
    while (todo.length && (!deadline || deadline.timeRemaining() > 6)) tileUrl(todo.shift())
    if (todo.length) (window.requestIdleCallback ?? ((fn) => setTimeout(fn, 60)))(step)
  }
  ;(window.requestIdleCallback ?? ((fn) => setTimeout(fn, 800)))(step)
}

const ownApp = (name) => ({ id: `own:${fold(name).replace(/[^a-z0-9]+/g, '-').slice(0, 32)}`, name, group: 'own', mono: name.trim().slice(0, 1).toUpperCase(), color: '#7FF3FF', how: 'ask', gives: 'Tvoja vlastná appka. Jarvis vymyslí, ako sa k nej dostať.', own: true })

// ── the world ──────────────────────────────────────────────────────────

/**
 * @param {{ core: object, canvas?: HTMLCanvasElement, onClose?: () => void, onAsk?: (text: string) => void, onChange?: (apps: object) => void }} opts
 */
export function createAppsWorld({ core, canvas = document.querySelector('canvas'), onClose = () => {}, onAsk = () => {}, onChange = () => {} }) {
  injectCss()
  const inner = core.inner
  const state = { picked: new Set(), own: [], detected: new Set(), connected: new Set(), loaded: false }
  let open = false
  let applied = null
  let apps = []
  let index = new Map()
  let sel = null
  let query = ''
  let saveTimer = 0
  let lastInput = performance.now()

  const root = document.createElement('div')
  root.className = 'aw'
  root.hidden = true
  root.innerHTML = `
    <header class="aw-head">
      <button type="button" class="leave" aria-label="Opustiť"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6 4 12l6 6M4 12h16"/></svg>Opustiť<kbd>Esc</kbd></button>
      <div class="aw-titles"><div class="aw-title">Tvoje appky</div><div class="aw-sub"></div></div>
      <label class="aw-search">${icon('search')}<input type="search" placeholder="Hľadať appku" autocomplete="off" spellcheck="false" aria-label="Hľadať appku"></label>
      <nav class="aw-groups" aria-label="Skupiny appiek"></nav>
    </header>
    <div class="aw-labels"></div>
    <a class="aw-ad" href="${AD_URL}" target="_blank" rel="noopener" aria-label="Staň sa AI Superčlovekom. Kurz od autorov Jarvisa.">
      <span class="aw-ad-in">
        <img class="aw-ad-mark" src="/img/satorai-symbol.svg" alt="" width="52" height="48" decoding="async">
        <span class="aw-ad-text"><b>Staň sa AI<br>Superčlovekom</b><i>Kurz od autorov Jarvisa</i></span>
        <span class="aw-ad-go" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h13M12.5 6l6 6-6 6"/></svg></span>
      </span>
    </a>
    <div class="aw-tip" hidden><b></b><span class="aw-tip-how"></span><span class="aw-tip-gives"></span></div>
    <aside class="aw-card" hidden></aside>
    <footer class="aw-tray">
      <div class="aw-tray-list" role="list"></div>
      <form class="aw-own"><input type="text" maxlength="40" placeholder="Iná appka? Napíš ju" aria-label="Pridať vlastnú appku"><button type="submit" aria-label="Pridať">${icon('plus')}</button></form>
    </footer>
    <div class="aw-hint"><span>klik</span> otvorí appku · <span>koliesko</span> priblíži · <span>ťahaj</span> rozhliadni sa</div>`
  document.body.append(root)
  const el = {
    sub: root.querySelector('.aw-sub'),
    search: root.querySelector('.aw-search input'),
    groups: root.querySelector('.aw-groups'),
    labels: root.querySelector('.aw-labels'),
    ad: root.querySelector('.aw-ad'),
    tip: root.querySelector('.aw-tip'),
    card: root.querySelector('.aw-card'),
    tray: root.querySelector('.aw-tray-list'),
    own: root.querySelector('.aw-own'),
  }
  const groupLabels = new Map()
  const namePool = Array.from({ length: NAME_LABELS }, () => {
    const t = document.createElement('span')
    t.className = 'aw-name'
    t.hidden = true
    el.labels.append(t)
    return t
  })

  // ── data ──
  function catalog() {
    const own = state.own.map(ownApp)
    apps = [...APPS, ...own]
    index = new Map(apps.map((a) => [a.id, a]))
    const groups = [...GROUPS.filter((g) => APPS.some((a) => a.group === g.id)).map((g) => ({ key: g.id, label: g.name })), ...(own.length ? [{ key: 'own', label: 'Tvoje vlastné' }] : []), { key: 'ad', label: '', slot: [31, 9.5] }]
    const items = [
      // The core: Jarvis himself, under the map. Every app has a thread to it, the picked ones glow.
      { id: 'core', t: 'Jarvis', g: 'core', fixed: true, p: [0, -1.2, 6], size: 4.6, imp: 1, color: COLOR, links: apps.map((a) => a.id) },
      ...apps.map((a) => ({ id: a.id, t: a.name, s: a.gives, g: a.group, img: tileUrl(a), r: true, imp: 0.5, k: 'app' })),
    ]
    return { title: 'Tvoje appky', color: COLOR, layout: 'atlas', groups, items }
  }

  /** How much of the free zone the header takes on top and the tray at the bottom, so the map fits between them. */
  function insets() {
    const z = inner.zone()
    if (!z) return null
    const head = root.querySelector('.aw-head').getBoundingClientRect()
    const hint = root.querySelector('.aw-hint')
    const tray = root.querySelector('.aw-tray').getBoundingClientRect()
    const low = hint.offsetParent ? hint.getBoundingClientRect().top : tray.top
    return { top: Math.max(60, head.bottom - z.top + 30), bottom: Math.max(60, z.bottom - low + 58) }
  }

  function renderGroups(groups) {
    el.groups.innerHTML = `<button type="button" data-key="">Všetko</button>${groups
      .filter((g) => !g.slot)
      .map((g) => `<button type="button" data-key="${esc(g.key)}">${esc(g.label)}</button>`)
      .join('')}`
    for (const t of groupLabels.values()) t.remove()
    groupLabels.clear()
    for (const g of groups) {
      if (g.slot) continue
      const t = document.createElement('button')
      t.type = 'button'
      t.className = 'aw-group'
      t.dataset.key = g.key
      t.innerHTML = `<span>${esc(g.label)}</span><i></i>`
      t.hidden = true
      el.labels.append(t)
      groupLabels.set(g.key, t)
    }
  }

  const idxOf = (id) => inner.world()?.idIndex.get(id) ?? -1
  const count = () => state.picked.size

  function marks() {
    const w = inner.world()
    if (!w) return
    const set = new Set([0])
    for (const id of state.picked) {
      const i = w.idIndex.get(id)
      if (i !== undefined) set.add(i)
    }
    inner.setMarks(set)
  }

  function renderSub() {
    const n = count()
    const found = [...state.detected].filter((id) => state.picked.has(id)).length
    el.sub.textContent = n
      ? `${n} ${n === 1 ? 'appka je' : n < 5 ? 'appky sú' : 'appiek je'} v Jarvisovi${found ? ` · ${found} som našiel v počítači sám` : ''}`
      : 'Klikni na všetko, čo používaš. Čo vyberieš, to sa naučím čítať.'
    for (const [key, t] of groupLabels) {
      const k = apps.filter((a) => a.group === key && state.picked.has(a.id)).length
      t.querySelector('i').textContent = k ? String(k) : ''
    }
  }

  const status = (a) => {
    if (a.how === 'connector' || a.how === 'garmin') return state.connected.has(a.id) ? { text: 'pripojené', tone: 'ok' } : { text: 'čaká na pripojenie', tone: 'wait' }
    if (a.how === 'auto') return { text: 'vidím sám', tone: 'ok' }
    if (a.how === 'export') return { text: 'čaká na kópiu dát', tone: 'wait' }
    if (a.how === 'file') return { text: 'čaká na súbor', tone: 'wait' }
    return { text: 'vymyslíme spolu', tone: 'wait' }
  }

  function renderTray() {
    const list = apps.filter((a) => state.picked.has(a.id))
    el.tray.innerHTML = list.length
      ? list
          .map((a) => {
            const st = status(a)
            const hex = appColor(a)
            return `<button type="button" role="listitem" class="aw-chip${sel === a.id ? ' is-sel' : ''}" data-id="${esc(a.id)}" style="--c:${isDark(hex) ? '#cfe3e8' : hex}" title="${esc(a.name)} · ${esc(st.text)}">${appSvg(a, 'aw-chip-mark')}<span>${esc(a.name)}</span><i class="is-${st.tone}"></i></button>`
          })
          .join('')
      : '<span class="aw-tray-empty">Tu sa zbiera, čo si vybral.</span>'
  }

  // ── selection ──
  function save() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/apps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ picked: [...state.picked].filter((id) => APP_BY_ID.has(id)), own: state.own }) })
        const data = await res.json()
        if (data?.ok) onChange(data)
      } catch {
        // The server is away for a moment: the next change saves everything again.
      }
    }, 300)
  }

  function toggle(id, on = !state.picked.has(id)) {
    const a = index.get(id)
    if (!a) return
    if (on) state.picked.add(id)
    else state.picked.delete(id)
    if (a.own && !on) {
      state.own = state.own.filter((n) => ownApp(n).id !== id)
      rebuild()
    }
    if (!on && sel === id) showCard(null)
    marks()
    renderSub()
    renderTray()
    save()
  }

  /** The list of apps changed (an own app came or went): the map is built again in place. */
  function rebuild() {
    const data = catalog()
    renderGroups(data.groups)
    data.insets = insets()
    inner.setData(data)
    applied = null
  }

  // ── the detail of one app ──
  function showCard(id) {
    sel = id
    const a = id ? index.get(id) : null
    for (const c of el.tray.querySelectorAll('.aw-chip')) c.classList.toggle('is-sel', c.dataset.id === id)
    if (!a) {
      el.card.hidden = true
      inner.highlight(-1, 'sel')
      return
    }
    const hex = appColor(a)
    const how = HOW[a.how] ?? HOW.ask
    const st = status(a)
    const picked = state.picked.has(a.id)
    const next =
      a.how === 'connector'
        ? state.connected.has(a.id)
          ? 'Je pripojené naživo. Vidím, čo prišlo a čo ťa čaká.'
          : `Pripája sa raz, v Claude cez konektor ${a.connector}. Prevediem ťa tým.`
        : a.how === 'garmin'
          ? state.connected.has(a.id)
            ? 'Je pripojený. Spánok, tep a tréningy si beriem sám každé ráno.'
            : 'Prihlásiš sa raz do svojho Garmin Connect. Heslo píšeš len ty do terminálu, ja ho nevidím. Prevediem ťa tým.'
          : a.how === 'beeper'
            ? 'Naživo cez Beeper, ak ho máš. Inak vymyslíme inú cestu.'
          : a.how === 'export'
            ? 'Appka ti dá kópiu tvojich dát. Ukážem ti presne kde, a potom ju stačí pretiahnuť sem do okna.'
            : a.how === 'auto'
              ? 'Toto si v počítači nájdem sám. Nič netreba robiť.'
              : a.how === 'file'
                ? `Pretiahni mi sem do okna ${a.file}.`
                : 'Na toto nemám hotovú cestu. Povedz mi a nejakú nájdem: konektor, export alebo vlastný kód.'
    const live = (a.how === 'connector' || a.how === 'garmin') && state.connected.has(a.id)
    const ask = (label, say, quiet = false) => `<button type="button" class="aw-btn${quiet ? ' is-quiet' : ''}" data-ask="${esc(say)}">${esc(label)}</button>`
    // One main step that moves the app forward, and one way to shape what Jarvis does with it.
    const main =
      a.how === 'export'
        ? `<a class="aw-btn" href="/guide/#${encodeURIComponent(a.guide)}" target="_blank" rel="noopener">Ukázať, ako na to</a>`
        : live || a.how === 'auto'
          ? ask('Čo s tým vieš?', `Čo všetko vieš robiť s ${a.name}? Navrhni mi tri veci a nastav tú, ktorú vyberiem.`)
          : a.how === 'file'
            ? ''
            : ask(a.how === 'connector' || a.how === 'garmin' ? 'Pripojiť' : 'Napojiť s Jarvisom', a.how === 'connector' || a.how === 'garmin' ? `Pripoj mi ${a.name}.` : `Používam ${a.name}. Vymysli, ako ju napojiť, a napoj ju.`)
    const more = live || a.how === 'auto' ? ask('Ukáž, čo vidíš', `Ukáž mi, čo práve vidíš v ${a.name}.`, true) : ''
    el.card.innerHTML = `<button type="button" class="aw-x" aria-label="Zavrieť">×</button>
      <div class="aw-card-top" style="--c:${isDark(hex) ? '#cfe3e8' : hex}"><span class="aw-card-mark">${appSvg(a, 'aw-card-svg')}</span><div><b>${esc(a.name)}</b><span class="aw-how is-${st.tone}">${esc(picked ? st.text : how.name.toLowerCase())}</span></div></div>
      <p class="aw-card-gives">${esc(a.gives)}</p>
      <p class="aw-card-next">${esc(next)}</p>
      <div class="aw-card-acts">${picked ? main + more : `<button type="button" class="aw-btn" data-add="${esc(a.id)}">Pridať do Jarvisa</button>`}</div>
      ${picked ? `<button type="button" class="aw-drop" data-drop="${esc(a.id)}">Už nepoužívam</button>` : ''}`
    el.card.hidden = false
    const i = idxOf(a.id)
    if (i >= 0) inner.highlight(i, 'sel')
  }

  // ── search ──
  function applySearch() {
    const w = inner.world()
    if (!w) return
    const q = fold(query.trim())
    if (!q) {
      inner.setDim(null)
      root.classList.remove('is-searching')
      return
    }
    const hits = new Set([0])
    const groupOf = new Map(GROUPS.map((g) => [g.id, fold(g.name)]))
    apps.forEach((a) => {
      if (fold(a.name).includes(q) || (groupOf.get(a.group) ?? '').includes(q)) {
        const i = w.idIndex.get(a.id)
        if (i !== undefined) hits.add(i)
      }
    })
    inner.setDim(hits)
    root.classList.add('is-searching')
    return [...hits].filter((i) => i > 0)
  }

  // ── open and close ──
  async function load() {
    try {
      const data = await (await fetch('/api/apps', { cache: 'no-store' })).json()
      sync(data, { first: !state.loaded })
    } catch {
      // Without the server the map still works, it only cannot save.
    }
    state.loaded = true
  }

  /** New selection from the server (this page saved it, or setup, or another window). */
  function sync(data, { first = false } = {}) {
    if (!data) return
    const ownBefore = state.own.join('|')
    if (Array.isArray(data.detected)) state.detected = new Set(data.detected)
    if (Array.isArray(data.connected)) state.connected = new Set(data.connected)
    if (Array.isArray(data.own)) state.own = data.own.slice(0, OWN_MAX)
    if (Array.isArray(data.picked)) {
      state.picked = new Set([...data.picked, ...state.own.map((n) => ownApp(n).id)])
      // First visit ever: what the computer scan found is already in, the user only removes what is not theirs.
      if (first && !data.picked.length && !data.at && state.detected.size) {
        for (const id of state.detected) state.picked.add(id)
        save()
      }
    }
    if (!open) return
    if (state.own.join('|') !== ownBefore) rebuild()
    marks()
    renderSub()
    renderTray()
    if (sel) showCard(sel)
  }

  function openWorld(appId = null) {
    lastInput = performance.now()
    if (open) {
      if (appId) focusApp(appId)
      return true
    }
    if (!inner.enter('appky', COLOR)) return false
    open = true
    applied = null
    sel = null
    query = ''
    el.search.value = ''
    root.hidden = false
    root.classList.remove('is-in', 'is-searching')
    el.card.hidden = true
    const data = catalog()
    renderGroups(data.groups)
    data.insets = insets()
    inner.setData(data)
    renderSub()
    renderTray()
    load().then(() => appId && focusApp(appId))
    return true
  }

  function focusApp(id) {
    const tryIt = (left) => {
      const i = idxOf(id)
      if (i >= 0 && inner.state().phase === 'in') {
        inner.flyTo(i)
        showCard(id)
      } else if (left > 0 && open) setTimeout(() => tryIt(left - 1), 250)
    }
    tryIt(16)
  }

  function close() {
    if (!open) return
    open = false
    clearTimeout(saveTimer)
    inner.exit()
    inner.keys.clear()
    root.classList.remove('is-in')
    root.hidden = true
    onClose()
  }

  /** One step back: the detail → the search → the overview → out of the orb. */
  function back() {
    if (!el.card.hidden) return showCard(null)
    if (query) {
      query = ''
      el.search.value = ''
      applySearch()
      return
    }
    close()
  }

  // ── every frame: names, constellation titles, the banner, the hover ──
  let zone = null
  function readZone() {
    const cs = getComputedStyle(document.documentElement)
    const rem = parseFloat(cs.fontSize) || 16
    const px = (name) => {
      const v = cs.getPropertyValue(name).trim()
      return v.endsWith('rem') ? parseFloat(v) * rem : parseFloat(v) || 0
    }
    zone = {
      left: px('--safe-left') + px('--edge') + px('--lw') + px('--gap'),
      right: window.innerWidth - (px('--safe-right') + px('--edge') + px('--rw') + px('--gap')),
      top: px('--safe-top') + px('--top-h'),
      bottom: window.innerHeight - px('--safe-bottom') - 5.2 * rem,
    }
  }
  let resizeTimer = 0
  window.addEventListener('resize', () => {
    zone = null
    // The map is packed for the zone it opened in: a new window size gets a new packing.
    clearTimeout(resizeTimer)
    if (open) resizeTimer = setTimeout(() => open && rebuild(), 350)
  })

  function frame() {
    if (!open) return
    const st = inner.state()
    const inside = st.phase === 'in'
    document.body.classList.toggle('inner-open', inside || st.phase === 'leaving')
    root.classList.toggle('is-in', inside && st.open > 0.3)
    const w = inner.world()
    if (!inside || !w) {
      for (const t of namePool) t.hidden = true
      for (const t of groupLabels.values()) t.hidden = true
      el.ad.classList.remove('is-on')
      el.tip.hidden = true
      return
    }
    if (applied !== w) {
      applied = w
      marks()
      if (query) applySearch()
    }
    if (!zone) readZone()
    const z = zone

    // Constellation titles above each honeycomb; the free cell of the grid holds the banner.
    for (const g of inner.groups()) {
      const p = inner.projectPoint({ x: g.c.x, y: g.top ?? g.c.y, z: g.c.z })
      if (g.key === 'ad') {
        const c = inner.projectPoint(g.c)
        if (!c) {
          el.ad.classList.remove('is-on')
          continue
        }
        // The banner is part of the map: it grows as the camera flies closer, but never shrinks below a readable size.
        const width = Math.max(150, Math.min(440, g.w * 0.94 * c.k))
        const tf = `translate3d(${c.x.toFixed(1)}px,${c.y.toFixed(1)}px,0) translate(-50%,-50%) scale(${(width / 300).toFixed(3)})`
        if (el.ad._tf !== tf) el.ad.style.transform = el.ad._tf = tf
        el.ad.classList.toggle('is-on', c.x > z.left - 40 && c.x < z.right + 40 && c.y > z.top + 60 && c.y < z.bottom - 20)
        continue
      }
      const t = groupLabels.get(g.key)
      if (!t) continue
      if (!p || p.x < z.left + 30 || p.x > z.right - 30 || p.y < z.top + 150 || p.y > z.bottom - 70) {
        if (!t.hidden) t.hidden = true
        continue
      }
      t.hidden = false
      const fs = Math.max(0.84, Math.min(1.25, p.k / 4.4))
      const tf = `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0) translate(-50%,-100%) scale(${fs.toFixed(2)})`
      if (t._tf !== tf) t.style.transform = t._tf = tf
    }

    // App names: only where the discs are big enough to read comfortably.
    let used = 0
    for (let i = 1; i < w.items.length && used < namePool.length; i++) {
      const s = inner.screenOf(i)
      if (!s || s.r < 19 || s.x < z.left + 20 || s.x > z.right - 20 || s.y < z.top + 150 || s.y + s.r > z.bottom - 60) continue
      const t = namePool[used++]
      if (t._i !== i) {
        t._i = i
        t.textContent = w.items[i].t
      }
      const on = w.marks[i] === 1
      if (t._on !== on) t.classList.toggle('is-on', (t._on = on))
      const dim = Boolean(w.dim && !w.dim[i])
      if (t._dim !== dim) t.classList.toggle('is-dim', (t._dim = dim))
      t.hidden = false
      const tf = `translate3d(${s.x.toFixed(1)}px,${(s.y + s.r + 5).toFixed(1)}px,0) translateX(-50%)`
      if (t._tf !== tf) t.style.transform = t._tf = tf
    }
    for (let k = used; k < namePool.length; k++) if (!namePool[k].hidden) namePool[k].hidden = true

    // Hover: the name, how it connects and what Jarvis gets from it.
    const h = w.hover > 0 ? w.hover : -1
    const s = h > 0 ? inner.screenOf(h) : null
    if (!s) {
      if (!el.tip.hidden) el.tip.hidden = true
      canvas.style.cursor = ''
    } else {
      const a = index.get(w.items[h].id)
      if (el.tip._i !== h || el.tip._on !== state.picked.has(a.id)) {
        el.tip._i = h
        el.tip._on = state.picked.has(a.id)
        el.tip.querySelector('b').textContent = a.name
        el.tip.querySelector('.aw-tip-how').textContent = state.picked.has(a.id) ? `V Jarvisovi · ${status(a).text}` : `${state.detected.has(a.id) ? 'Našiel som v počítači · ' : ''}${(HOW[a.how] ?? HOW.ask).name}`
        el.tip.querySelector('.aw-tip-gives').textContent = a.gives
      }
      el.tip.hidden = false
      const right = s.x + s.r + 14 + 260 < z.right
      el.tip.style.transform = `translate3d(${(right ? s.x + s.r + 14 : s.x - s.r - 14).toFixed(1)}px,${(s.y - 16).toFixed(1)}px,0)${right ? '' : ' translateX(-100%)'}`
      canvas.style.cursor = 'pointer'
    }
  }

  // ── input ──
  let press = null
  canvas.addEventListener('pointerdown', (e) => {
    if (open) press = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 }
  })
  window.addEventListener('pointermove', (e) => {
    if (!open) return
    if (press && e.pointerId === press.id) {
      press.moved += Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y)
      press.x = e.clientX
      press.y = e.clientY
    }
    // The camera leans a little after the pointer: near and far layers slide over each other.
    inner.sway((e.clientX / window.innerWidth - 0.5) * 0.07, -(e.clientY / window.innerHeight - 0.5) * 0.045)
  })
  canvas.addEventListener('pointerup', (e) => {
    if (press && e.pointerId !== press.id) return
    const p = press
    press = null
    if (!open || !p || p.moved >= 6 || inner.state().phase !== 'in') return
    const i = inner.pick(e.clientX, e.clientY)
    const it = i > 0 ? inner.item(i) : null
    if (!it) return showCard(null)
    // A click opens the app: what it gives, how it stands and the next step. The first click also
    // takes it into Jarvis. Nothing leaves by a click on the map, only by "Už nepoužívam" in its card.
    if (!state.picked.has(it.id)) toggle(it.id, true)
    showCard(it.id)
  })
  canvas.addEventListener('dblclick', (e) => {
    if (!open || inner.state().phase !== 'in') return
    const i = inner.pick(e.clientX, e.clientY)
    if (i > 0) inner.flyTo(i)
  })
  let gScale = 1
  canvas.addEventListener('gesturestart', (e) => {
    if (!open) return
    e.preventDefault()
    gScale = e.scale ?? 1
  })
  canvas.addEventListener('gesturechange', (e) => {
    if (!open) return
    e.preventDefault()
    inner.push(Math.max(-40, Math.min(40, ((e.scale ?? 1) - gScale) * 90)))
    gScale = e.scale ?? 1
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
  const FLY = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
  const typing = () => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)
  window.addEventListener('keydown', (e) => {
    if (!open || e.metaKey || e.ctrlKey || e.altKey || typing() || !FLY.has(e.code)) return
    e.preventDefault()
    inner.keys.add(e.code)
  })
  window.addEventListener('keyup', (e) => inner.keys.delete(e.code))
  window.addEventListener('blur', () => inner.keys.clear())

  el.search.addEventListener('input', () => {
    query = el.search.value
    applySearch()
  })
  el.search.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      const hits = applySearch()
      if (hits?.length) {
        inner.flyTo(hits[0])
        showCard(inner.item(hits[0]).id)
        el.search.blur()
      }
    } else if (e.key === 'Escape') {
      query = ''
      el.search.value = ''
      applySearch()
      el.search.blur()
    }
  })
  el.groups.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-key]')
    if (!b) return
    showCard(null)
    if (b.dataset.key) inner.flyToGroup(b.dataset.key)
    else inner.flyHome()
  })
  el.labels.addEventListener('click', (e) => {
    const b = e.target.closest('.aw-group')
    if (b) inner.flyToGroup(b.dataset.key)
  })
  el.tray.addEventListener('click', (e) => {
    const c = e.target.closest('.aw-chip')
    if (!c) return
    const i = idxOf(c.dataset.id)
    if (i >= 0) inner.flyTo(i)
    showCard(c.dataset.id)
  })
  root.querySelector('.leave').addEventListener('click', () => close())
  el.card.addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b) return
    if (b.classList.contains('aw-x')) return showCard(null)
    if (b.dataset.add) {
      toggle(b.dataset.add, true)
      return showCard(b.dataset.add)
    }
    if (b.dataset.drop) return toggle(b.dataset.drop, false)
    if (b.dataset.ask) {
      onAsk(b.dataset.ask)
      close()
    }
  })
  el.own.addEventListener('submit', (e) => {
    e.preventDefault()
    const input = el.own.querySelector('input')
    const name = input.value.replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!name) return
    input.value = ''
    // A known app typed by name is simply picked.
    const known = APPS.find((a) => fold(a.name) === fold(name))
    if (known) {
      toggle(known.id, true)
      return focusApp(known.id)
    }
    if (state.own.length >= OWN_MAX || state.own.some((n) => fold(n) === fold(name))) return
    state.own.push(name)
    state.picked.add(ownApp(name).id)
    rebuild()
    renderSub()
    renderTray()
    save()
    // Jarvis hears about it at once and works out a way to reach it.
    onAsk(`Používam aj appku ${name}. Zapamätaj si to a zisti, ako sa k nej vieš napojiť.`)
  })
  el.own.querySelector('input').addEventListener('keydown', (e) => e.stopPropagation())
  for (const node of [el.card, el.tray]) node.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true })

  // Rest: after three minutes without input the HUD flies out by itself and stops rendering at full rate.
  for (const type of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'gesturechange']) window.addEventListener(type, () => (lastInput = performance.now()), { capture: true, passive: true })
  setInterval(() => {
    if (open && inner.keys.size === 0 && !typing() && performance.now() - lastInput > 180_000) close()
  }, 5000)

  load()
  return { open: openWorld, close, back, frame, sync, isOpen: () => open }
}
