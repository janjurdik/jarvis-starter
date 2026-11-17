// Tvoje appky: three steps on one page.
//   1 Appky          the user clicks every app they use (preselected from the computer scan)
//   2 S čím pomôžem  what Jarvis should help with, suggestions from what people asked for
//   3 Napojenie      only the picked apps, each with its one next step (connector, export, file…)
// Saved to the server on every change (POST /api/apps), so Jarvis and the 3D world see it at once.
// Inside the desktop orb the page runs as ?embed=1 in an iframe and talks to the HUD by postMessage.
// Deep link: #<app id> opens step 3 at that app.

import { APPS, APP_BY_ID, GROUPS, HOW, WANTS } from './catalog.js'
import { appColor, appSvg, isDark } from './glyph.js'
import { icon } from '/js/icons.js'

const EMBED = new URLSearchParams(location.search).has('embed')
const app = document.getElementById('app')
const dock = document.getElementById('dock')
const dockText = document.getElementById('dock-text')
const dockIcons = document.getElementById('dock-icons')
const dockNext = document.getElementById('dock-next')
const dockBack = document.getElementById('dock-back')
const stepsNav = document.getElementById('steps')

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const plural = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many)
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const SEARCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'

const state = { step: 0, picked: new Set(), wants: new Set(), own: [], detected: new Set(), connected: new Set(), query: '', fresh: true, focus: null }

// ── server ──────────────────────────────────────────────────────────────────

let saveTimer = 0
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    fetch('/api/apps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ picked: [...state.picked], wants: [...state.wants] }),
    })
      .then((r) => r.json())
      .then((data) => post('saved', data))
      .catch(() => undefined)
  }, 350)
}

function post(action, data = null) {
  if (EMBED) parent.postMessage({ type: 'jarvis-apps', action, data }, location.origin)
}

async function load() {
  try {
    const res = await fetch('/api/apps', { cache: 'no-store' })
    const data = await res.json()
    state.detected = new Set(data.detected ?? [])
    state.connected = new Set(data.connected ?? [])
    state.wants = new Set(data.wants ?? [])
    if (data.picked?.length) {
      state.picked = new Set(data.picked)
      state.fresh = false
    } else {
      // First visit: everything the scan found is already on, the user only unclicks what they don't use.
      state.picked = new Set(state.detected)
    }
  } catch {
    // Opened without the HUD server: the page still works, it only can't save.
  }
}

// ── step 1: apps ────────────────────────────────────────────────────────────

function tileHtml(a) {
  const hex = appColor(a)
  const cls = ['tile', state.picked.has(a.id) ? 'on' : '', isDark(hex) ? 'dark' : ''].filter(Boolean).join(' ')
  return (
    `<button type="button" class="${cls}" data-id="${a.id}" style="--c:${hex}" aria-pressed="${state.picked.has(a.id)}">` +
    (state.detected.has(a.id) ? '<i class="found" title="Našiel som v tvojom počítači"></i>' : '') +
    `<span class="orb"><span class="blob"></span>${appSvg(a)}</span>` +
    `<span class="name">${esc(a.name)}</span><span class="tick">${CHECK}</span></button>`
  )
}

function renderApps() {
  const q = state.query.trim().toLowerCase()
  const match = (a) => !q || a.name.toLowerCase().includes(q) || a.id.includes(q)
  const groups = GROUPS.map((g) => ({ g, list: APPS.filter((a) => a.group === g.id && match(a)) })).filter((x) => x.list.length)
  const found = state.detected.size
  app.innerHTML =
    `<section class="hero"><h1>Čo všetko <em>používaš?</em></h1>` +
    `<p>${
      found && state.fresh
        ? `Zapol som ${found} ${plural(found, 'appku, ktorú', 'appky, ktoré', 'appiek, ktoré')} som našiel v počítači. Klikni na všetko ostatné, čo máš v telefóne alebo v počítači, a odklikni, čo nepoužívaš.`
        : 'Klikni na všetko, čo máš v telefóne alebo v počítači. Čím viac, tým lepšie ťa spoznám. Nič sa zatiaľ nepripája, to príde v treťom kroku.'
    }</p></section>` +
    `<label class="search">${SEARCH}<input id="q" type="search" placeholder="Hľadať appku" value="${esc(state.query)}" autocomplete="off"></label>` +
    (groups.length
      ? groups.map(({ g, list }) => `<section class="group"><h2>${esc(g.name)}</h2><div class="grid">${list.map(tileHtml).join('')}</div></section>`).join('')
      : `<p class="empty">Takú appku v zozname nemám. Povedz ju Jarvisovi a nájde cestu, ako ju pripojiť.</p>`)
  const input = document.getElementById('q')
  input.addEventListener('input', () => {
    state.query = input.value
    const pos = input.selectionStart
    renderApps()
    const again = document.getElementById('q')
    again.focus()
    again.setSelectionRange(pos, pos)
  })
}

function toggleApp(tile) {
  const id = tile.dataset.id
  const on = !state.picked.has(id)
  if (on) state.picked.add(id)
  else state.picked.delete(id)
  tile.classList.toggle('on', on)
  tile.setAttribute('aria-pressed', String(on))
  if (on) {
    tile.classList.remove('pop')
    void tile.offsetWidth
    tile.classList.add('pop')
    splash(tile)
  }
  renderDock()
  save()
}

// ── liquid tiles: tilt toward the pointer, the blob wobbles while hovered ───

const noise = document.getElementById('liquid-noise')
const map = document.getElementById('liquid-map')
let liquidTile = null
let liquidT0 = 0
let liquidRaf = 0

function liquidFrame(t) {
  const k = Math.min(1, (t - liquidT0) / 260)
  const amp = liquidTile ? 16 * k : 16 * (1 - k)
  map.setAttribute('scale', amp.toFixed(2))
  const f = 0.016 + 0.006 * Math.sin(t / 380)
  noise.setAttribute('baseFrequency', `${f.toFixed(4)} ${(f * 1.4).toFixed(4)}`)
  noise.setAttribute('seed', String(Math.floor(t / 90) % 40))
  if (liquidTile || k < 1) liquidRaf = requestAnimationFrame(liquidFrame)
  else document.querySelectorAll('.tile.liquid').forEach((el) => el.classList.remove('liquid'))
}

function liquid(tile) {
  if (tile === liquidTile) return
  document.querySelectorAll('.tile.liquid').forEach((el) => el !== tile && el.classList.remove('liquid'))
  liquidTile = tile
  liquidT0 = performance.now()
  tile?.classList.add('liquid')
  cancelAnimationFrame(liquidRaf)
  liquidRaf = requestAnimationFrame(liquidFrame)
}

app.addEventListener('pointermove', (e) => {
  const tile = e.target.closest?.('.tile')
  if (tile) {
    const r = tile.getBoundingClientRect()
    tile.style.setProperty('--ry', `${((e.clientX - r.left) / r.width - 0.5) * 16}deg`)
    tile.style.setProperty('--rx', `${(0.5 - (e.clientY - r.top) / r.height) * 16}deg`)
  }
  liquid(tile ?? null)
})
app.addEventListener('pointerout', (e) => {
  const tile = e.target.closest?.('.tile')
  if (tile && !tile.contains(e.relatedTarget)) {
    tile.style.setProperty('--rx', '0deg')
    tile.style.setProperty('--ry', '0deg')
    if (liquidTile === tile) liquid(null)
  }
})

// ── step 2: wants ───────────────────────────────────────────────────────────

function renderWants() {
  app.innerHTML =
    `<section class="hero"><h1>S čím ti mám <em>pomáhať?</em></h1>` +
    '<p>Vyber všetko, čo by ti uľahčilo deň. Toto chcú ľudia najčastejšie. Ak tu niečo chýba, dopíš to vlastnými slovami.</p></section>' +
    `<div class="wants">${WANTS.map(
      (w) => `<button type="button" class="want${state.wants.has(w.id) ? ' on' : ''}" data-want="${w.id}" aria-pressed="${state.wants.has(w.id)}">${icon(w.icon)}<span>${esc(w.name)}</span></button>`,
    ).join('')}</div>` +
    `<form class="own" id="own"><input id="own-in" type="text" maxlength="140" placeholder="Niečo vlastné, napríklad: pripomínať mi lieky"><button class="btn ghost" type="submit">Pridať</button></form>` +
    `<div class="own-list">${state.own.map((t) => `<span>${esc(t)}</span>`).join('')}</div>`
  document.getElementById('own').addEventListener('submit', (e) => {
    e.preventDefault()
    const input = document.getElementById('own-in')
    const text = input.value.trim()
    if (!text) return
    state.own.push(text)
    // Own wishes go straight to Jarvis as a sentence, he writes them into memory himself.
    fetch('/api/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'info', icon: 'pamat', text: `Prianie: ${text}`, source: 'appky' }) }).catch(() => undefined)
    post('wish', text)
    renderWants()
  })
}

// ── step 3: plan ────────────────────────────────────────────────────────────

const LANES = [
  { how: ['connector', 'beeper'], title: 'Pripojíš naživo', text: 'Raz pripojíš a odvtedy to vidím naživo: čo prišlo, čo ťa čaká, čo treba vybaviť.' },
  { how: ['export'], title: 'Pošleš mi kópiu svojich dát', text: 'Každá appka ti vie dať kópiu toho, čo o tebe má. Požiadaj o všetky naraz, prídu do pár dní. Súbor potom stačí pretiahnuť do Jarvisa.' },
  { how: ['file'], title: 'Pošleš mi súbor', text: 'Stačí pretiahnuť súbor do okna Jarvisa. Prečítam ho a zapamätám si, čo je dôležité.' },
  { how: ['auto'], title: 'Vidím sám', text: 'Tieto nájdem v počítači. Pri niektorých sa macOS raz opýta na povolenie.' },
  { how: ['ask'], title: 'Vymyslíme spolu', text: 'Na tieto nemám hotovú cestu. Povedz mi, čo z nich chceš, a nájdem spôsob.' },
]

function rowHtml(a) {
  const hex = appColor(a)
  const cls = `row${isDark(hex) ? ' dark' : ''}`
  let line = esc(a.gives)
  let act = ''
  if (a.how === 'connector') {
    line = state.connected.has(a.id)
      ? `${esc(a.gives)}`
      : `<span class="path">Claude<i>›</i>Nastavenia<i>›</i>Konektory<i>›</i>${esc(a.connector)}</span>`
    act = state.connected.has(a.id) ? '<span class="act ok">Pripojené</span>' : ''
  } else if (a.how === 'beeper') {
    line = 'V Beeperi zapni konektor pre Claude: Nastavenia › Vývojári.'
  } else if (a.how === 'export') {
    act = `<a class="act" href="/guide/#${encodeURIComponent(a.guide)}" target="${EMBED ? '_blank' : '_self'}">Ukázať ako</a>`
  } else if (a.how === 'file') {
    line = `${esc(a.gives)} Súbor: ${esc(a.file)}.`
  } else if (a.how === 'ask') {
    act = `<button type="button" class="act" data-ask="${a.id}">Povedať Jarvisovi</button>`
  }
  return `<div class="${cls}" id="app-${a.id}" style="--c:${hex}"><span class="mk">${appSvg(a)}</span><div><b>${esc(a.name)}</b><span>${line}</span></div>${act}</div>`
}

function renderPlan() {
  const picked = APPS.filter((a) => state.picked.has(a.id))
  if (!picked.length) {
    app.innerHTML = `<section class="hero"><h1>Zatiaľ nič</h1><p>Vráť sa do prvého kroku a vyber appky, ktoré používaš.</p></section>`
    return
  }
  const live = picked.filter((a) => a.how === 'connector' && !state.connected.has(a.id)).length
  app.innerHTML =
    `<section class="hero"><h1>Takto to <em>prepojíme</em></h1>` +
    `<p>${picked.length} ${plural(picked.length, 'appka', 'appky', 'appiek')}. ${
      live ? `Najviac mi dá ${live} ${plural(live, 'pripojenie', 'pripojenia', 'pripojení')} naživo, začni nimi.` : 'Ukážem ti pri každej, čo spraviť. Zvyšok zvládnem sám.'
    }</p></section>` +
    `<div class="plan">${LANES.map((lane) => {
      const list = picked.filter((a) => lane.how.includes(a.how))
      if (!list.length) return ''
      return `<section class="lane"><h2>${lane.title}</h2><p>${lane.text}</p><div class="rows">${list.map(rowHtml).join('')}</div></section>`
    }).join('')}</div>` +
    `<div class="done-card" id="done-card" hidden><h2>Uložené</h2><p>Jarvis to už vidí. Appky plávajú na ploche v orbe Tvoje appky a kedykoľvek sa k nim vrátiš klikom naň.</p></div>`
  if (state.focus) {
    const row = document.getElementById(`app-${state.focus}`)
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      row.classList.add('flash')
      setTimeout(() => row.classList.remove('flash'), 2400)
    }
    state.focus = null
  }
}

app.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile')
  if (tile) return toggleApp(tile)
  const want = e.target.closest('.want')
  if (want) {
    const id = want.dataset.want
    const on = !state.wants.has(id)
    if (on) state.wants.add(id)
    else state.wants.delete(id)
    want.classList.toggle('on', on)
    want.setAttribute('aria-pressed', String(on))
    renderDock()
    save()
    return
  }
  const ask = e.target.closest('[data-ask]')
  if (ask) {
    const a = APP_BY_ID.get(ask.dataset.ask)
    post('ask', `Používam ${a.name}. Ako ho napojíme, aby si z neho niečo mal?`)
    ask.textContent = 'Poslané'
    ask.disabled = true
  }
})

// ── splash: a burst in the brand colour when an app turns on ────────────────

function splash(tile) {
  const r = tile.querySelector('.orb').getBoundingClientRect()
  const c = getComputedStyle(tile).getPropertyValue('--c')
  for (let i = 0; i < 10; i++) {
    const p = document.createElement('i')
    const a = (i / 10) * Math.PI * 2 + Math.random() * 0.4
    const d = 34 + Math.random() * 26
    p.style.cssText = `position:fixed;left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px;width:7px;height:7px;margin:-3.5px;border-radius:50%;background:${c};box-shadow:0 0 12px ${c};pointer-events:none;z-index:9;transition:transform .7s cubic-bezier(.22,1,.36,1),opacity .7s`
    document.body.appendChild(p)
    requestAnimationFrame(() => {
      p.style.transform = `translate(${Math.cos(a) * d}px,${Math.sin(a) * d}px) scale(.2)`
      p.style.opacity = '0'
    })
    setTimeout(() => p.remove(), 760)
  }
}

// ── dock and steps ──────────────────────────────────────────────────────────

function renderDock() {
  dock.hidden = false
  dockBack.hidden = state.step === 0
  const n = state.picked.size
  if (state.step === 0) {
    const last = [...state.picked].slice(-6).map((id) => APP_BY_ID.get(id)).filter(Boolean)
    dockIcons.innerHTML = last.map((a) => `<span style="color:${isDark(appColor(a)) ? '#eafbff' : appColor(a)}">${appSvg(a)}</span>`).join('')
    dockText.innerHTML = n ? `<b>${n}</b> ${plural(n, 'appka', 'appky', 'appiek')}` : 'Klikni na appky, ktoré používaš'
    dockNext.textContent = 'Ďalej'
    dockNext.disabled = false
  } else if (state.step === 1) {
    dockIcons.innerHTML = ''
    const w = state.wants.size + state.own.length
    dockText.innerHTML = w ? `<b>${w}</b> ${plural(w, 'vec', 'veci', 'vecí')}, s ktorými pomôžem` : 'Vyber, s čím ti mám pomáhať'
    dockNext.textContent = 'Ďalej'
  } else {
    dockIcons.innerHTML = ''
    dockText.innerHTML = 'Všetko je uložené. Jarvis to vidí.'
    dockNext.textContent = EMBED ? 'Hotovo' : 'Hotovo, späť na plochu'
  }
  for (const b of stepsNav.querySelectorAll('button')) {
    const s = Number(b.dataset.step)
    if (s === state.step) b.setAttribute('aria-current', 'step')
    else b.removeAttribute('aria-current')
  }
}

function go(step) {
  state.step = Math.max(0, Math.min(2, step))
  if (state.step === 0) renderApps()
  else if (state.step === 1) renderWants()
  else renderPlan()
  renderDock()
  window.scrollTo({ top: 0, behavior: 'smooth' })
  post('step', state.step)
}

dockNext.addEventListener('click', () => {
  if (state.step < 2) return go(state.step + 1)
  clearTimeout(saveTimer)
  fetch('/api/apps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ picked: [...state.picked], wants: [...state.wants] }) })
    .then((r) => r.json())
    .then((data) => {
      post('done', { ...data, own: state.own })
      const card = document.getElementById('done-card')
      if (card) card.hidden = false
      if (!EMBED) setTimeout(() => (location.href = '/'), 900)
    })
    .catch(() => undefined)
})
dockBack.addEventListener('click', () => go(state.step - 1))
stepsNav.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-step]')
  if (b) go(Number(b.dataset.step))
})
document.querySelector('.back')?.addEventListener('click', (e) => {
  if (!EMBED) return
  e.preventDefault()
  post('close')
})
document.querySelector('.brand')?.addEventListener('click', (e) => {
  if (!EMBED) return
  e.preventDefault()
  post('close')
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && EMBED && document.activeElement?.tagName !== 'INPUT') post('close')
})

// ── slow star field behind the page (skipped inside the orb, the world is behind it) ─

function sky() {
  const c = document.getElementById('sky')
  if (EMBED || !c) return
  const g = c.getContext('2d')
  const stars = Array.from({ length: 140 }, () => ({ x: Math.random(), y: Math.random(), z: 0.2 + Math.random() * 0.8, p: Math.random() * 6.28 }))
  const fit = () => {
    c.width = innerWidth * devicePixelRatio
    c.height = innerHeight * devicePixelRatio
  }
  fit()
  addEventListener('resize', fit)
  const frame = (t) => {
    g.clearRect(0, 0, c.width, c.height)
    for (const s of stars) {
      const a = 0.25 + 0.35 * s.z * (0.6 + 0.4 * Math.sin(t / 900 + s.p))
      g.fillStyle = `rgba(160,240,255,${a})`
      const x = ((s.x + t * 0.000004 * s.z) % 1) * c.width
      g.beginPath()
      g.arc(x, s.y * c.height, s.z * 1.3 * devicePixelRatio, 0, 6.29)
      g.fill()
    }
    requestAnimationFrame(frame)
  }
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) requestAnimationFrame(frame)
}

// ── start ───────────────────────────────────────────────────────────────────

if (EMBED) {
  document.body.classList.add('embed')
  const back = document.querySelector('.back')
  if (back) back.textContent = 'Zavrieť'
}
await load()
sky()
const deep = decodeURIComponent(location.hash.slice(1))
if (deep && APP_BY_ID.has(deep)) {
  state.focus = deep
  state.picked.add(deep)
  go(2)
} else go(0)
addEventListener('hashchange', () => {
  const id = decodeURIComponent(location.hash.slice(1))
  if (APP_BY_ID.has(id)) {
    state.focus = id
    go(2)
  }
})
