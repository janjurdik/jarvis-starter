// Export guide page: overview of sources, per-source walkthrough and the progress the user keeps.
// Routing is the URL hash: #instagram, #whatsapp/android, optionally #whatsapp/android/3 for a step.
// Content lives in sources.json (list of sources) and guides.js (steps and scenes).
// Progress is kept in localStorage under jarvis.guide.v1 as { [id]: { s, at } }:
// s is 0 not yet, 1 requested, 2 downloaded, 3 in Jarvis; at is the request date (YYYY-MM-DD).

import { Scene, icon } from './scene.js'
import { GUIDES, AFTER } from './guides.js'

const KEY = 'jarvis.guide.v1'
const PREFS = 'jarvis.guide.prefs'
const STATES = ['Ešte nie', 'Požiadané', 'Stiahnuté', 'V Jarvisovi']
const LEVELS = ['', 'ľahké', 'stredné', 'náročnejšie']
const DEVICE = { phone: 'phone', computer: 'laptop', web: 'globe' }

const app = document.getElementById('app')
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
/** Escapes text and turns [[Label|English]] into a button chip. */
const fmt = (s) => esc(s).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => `<span class="key">${a}${b ? ` <i>${b}</i>` : ''}</span>`)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

let meta = null
let byId = new Map()
let store = read(KEY)
let prefs = read(PREFS)
let scene = null
let overviewY = 0
let autoTimer = 0
const cur = { id: null, variant: null, step: 0, steps: [], paused: false }

// ── storage ─────────────────────────────────────────────────────────────────

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? {}
  } catch {
    return {}
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode or a full disk: the page still works, it just forgets.
  }
}

// ── dates and states ────────────────────────────────────────────────────────

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const day = (iso) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const plus = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
const fmtDay = (date) => `${date.getDate()}. ${date.getMonth() + 1}.${date.getFullYear() === new Date().getFullYear() ? '' : ` ${date.getFullYear()}`}`

/** States a source can be in: things with no waiting skip "Požiadané", Steam needs no file at all. */
const allowed = (src) => (src.auto ? [0, 3] : src.waits ? [0, 1, 2, 3] : [0, 2, 3])
const stateOf = (id) => store[id]?.s ?? 0

function setState(id, s) {
  const prev = store[id] ?? {}
  if (s === 0) delete store[id]
  else store[id] = { s, at: s === 1 ? (prev.s === 1 && prev.at ? prev.at : today()) : prev.at }
  write(KEY, store)
  paint()
}

/** "malo by prísť do …" computed from the request date and the waiting time in the research. */
function eta(src, at) {
  const from = day(at)
  const out = []
  if (src.waitDays === 0) out.push('malo by prísť ešte v ten deň')
  else if (src.waitDays) out.push(`malo by prísť do ${fmtDay(plus(from, src.waitDays))}`)
  else if (src.waitHint) out.push(`zvyčajne príde o ${src.waitHint}`)
  if (src.maxDays) out.push(`najneskôr do ${fmtDay(plus(from, src.maxDays))}`)
  return out
}

function stateLine(src, long) {
  const st = store[src.id]
  const s = st?.s ?? 0
  if (s === 1 && st.at) {
    const bits = eta(src, st.at)
    const late = src.waitDays != null && new Date() > plus(day(st.at), src.waitDays + 1)
    if (long) return `Požiadané <b>${fmtDay(day(st.at))}</b>. ${bits.length ? `${bits.map((b, i) => (i === 0 ? b[0].toUpperCase() + b.slice(1) : b)).join(', ')}.` : ''}${late ? ' Už by to malo byť v maile, pozri aj spam.' : ''}`
    return late ? `${fmtDay(day(st.at))} · pozri mail aj spam` : `${fmtDay(day(st.at))}${bits[0] ? ` · ${bits[0]}` : ''}`
  }
  if (s === 2) return long ? 'Súbor máš. Teraz ho pretiahni do okna Jarvisa.' : 'pretiahni súbor Jarvisovi'
  if (s === 3) return long ? 'Hotovo. Jarvis to má v pamäti.' : 'hotovo'
  return ''
}

// ── small html pieces ───────────────────────────────────────────────────────

const glyph = (mono) => `<span class="glyph" aria-hidden="true"><b${mono.length > 2 ? ' class="is-3"' : ''}>${esc(mono)}</b></span>`
const devices = (src) => src.devices.map((d) => icon(DEVICE[d])).join('')

function stateButton(src) {
  return `<button class="state" type="button" data-cycle="${src.id}"><span class="state-d">${allowed(src).map(() => '<i></i>').join('')}</span><span class="state-t"></span>${icon('replay')}<span class="state-x"></span></button>`
}

function segControl(src) {
  return `<div class="seg" role="group" aria-label="Stav exportu" data-seg="${src.id}" data-n="${allowed(src).length}">${allowed(src).map((s) => `<button type="button" data-s="${s}" aria-pressed="false"><i></i>${STATES[s]}</button>`).join('')}</div><p class="seg-x" data-segx="${src.id}" aria-live="polite"></p>`
}

function tile(src, alias) {
  const name = alias?.name ?? src.name
  return `<article class="tile" data-src="${src.id}">
    <a class="tile-a" href="#${src.id}">
      ${glyph(alias?.mono ?? src.mono)}
      <strong>${esc(name)}</strong>
      <span class="tile-g">${esc(alias?.gives ?? src.gives)}</span>
      <span class="tile-m">
        <span>${icon('clock')}<span>${esc(src.time)}</span></span>
        <span>${icon(DEVICE[src.devices[0]])}<span>${esc(src.where)}</span></span>
        <span><span class="lvl lvl-${src.level}" aria-hidden="true"><i></i><i></i><i></i></span><span>${LEVELS[src.level]}</span></span>
      </span>
    </a>
    ${stateButton(src)}
  </article>`
}

// ── overview ────────────────────────────────────────────────────────────────

function overview() {
  const first = meta.start.map((id, i) => {
    const s = byId.get(id)
    return `<a class="first-c" href="#${s.id}"><span class="first-n" aria-hidden="true">${i + 1}</span><strong>${esc(s.name)}</strong><span>${esc(s.why ?? s.gives)}</span><em>${icon('clock')}${esc(s.time)}</em></a>`
  })
  const groups = meta.groups.map((g) => {
    const tiles = g.tiles.map((id) => {
      const src = byId.get(id)
      return tile(src, src.group === g.id ? null : src.also?.find((a) => a.group === g.id))
    })
    return `<section class="sec" aria-labelledby="g-${g.id}"><div class="sec-h"><h2 id="g-${g.id}">${esc(g.name)}</h2><span>${tiles.length} ${tiles.length === 1 ? 'zdroj' : tiles.length < 5 ? 'zdroje' : 'zdrojov'}</span></div><div class="tiles">${tiles.join('')}</div></section>`
  })
  app.innerHTML = `<div class="view wrap">
    <section class="hero">
      <div>
        <span class="eyebrow">Sprievodca exportmi</span>
        <h1 id="h">Čo všetko mi vieš dať</h1>
        <p class="lead">Čím viac o tebe viem, tým viac ti pomôžem. Každá appka ti vie vydať tvoje vlastné dáta. Ukážem ti krok za krokom, kde na to kliknúť.</p>
      </div>
      <div class="sum glass" aria-live="polite">
        <div class="sum-n"><b id="sum-n">0</b><span>z ${meta.sources.length} hotové</span></div>
        <div class="sum-bar" id="sum-bar" aria-hidden="true">${meta.sources.map((s) => `<i data-tick="${s.id}"></i>`).join('')}</div>
        <div class="sum-l" id="sum-l"></div>
      </div>
    </section>
    <section class="sec" aria-labelledby="g-first">
      <div class="sec-h"><h2 id="g-first">Začni týmito tromi</h2><span>najviac úžitku za najmenej práce</span></div>
      <div class="first">${first.join('')}</div>
      <p class="live">${icon('plug')}<span>Mail a kalendár sa neexportujú. <b>Pripojíš ich v Claude cez Konektory</b> a Jarvis ich potom číta naživo.</span></p>
    </section>
    ${groups.join('')}
  </div>`
  document.title = 'Jarvis · Sprievodca exportmi'
  paint()
}

/** Writes the stored states into whatever is on the page: tiles, segmented controls and the summary. */
function paint() {
  for (const el of app.querySelectorAll('[data-src]')) {
    const src = byId.get(el.dataset.src)
    const s = stateOf(src.id)
    const steps = allowed(src)
    el.className = `tile s-${s}`
    const btn = el.querySelector('.state')
    btn.querySelector('.state-t').textContent = STATES[s]
    btn.querySelector('.state-x').textContent = stateLine(src, false)
    btn.querySelectorAll('.state-d i').forEach((d, i) => d.classList.toggle('on', i <= steps.indexOf(s) && s > 0))
    const next = steps[(steps.indexOf(s) + 1) % steps.length]
    btn.setAttribute('aria-label', `${src.name}, stav: ${STATES[s]}. Stlačením zmeníš na ${STATES[next]}.`)
  }
  for (const el of app.querySelectorAll('[data-seg]')) {
    const s = stateOf(el.dataset.seg)
    el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.s) === s)))
  }
  for (const el of app.querySelectorAll('[data-segx]')) el.innerHTML = stateLine(byId.get(el.dataset.segx), true)
  const n = document.getElementById('sum-n')
  if (!n) return
  const count = (s) => meta.sources.filter((x) => stateOf(x.id) === s).length
  n.textContent = count(3)
  for (const t of document.querySelectorAll('[data-tick]')) t.className = `s-${stateOf(t.dataset.tick)}`
  const bits = [`<span class="l-3">V Jarvisovi: ${count(3)}</span>`]
  if (count(2)) bits.push(`<span class="l-2">Stiahnuté, čaká na pretiahnutie: ${count(2)}</span>`)
  if (count(1)) bits.push(`<span class="l-1">Čakáš na mail: ${count(1)}</span>`)
  if (!count(1) && !count(2) && !count(3)) bits.push('<span>Zatiaľ nič. Začni prvým zdrojom nižšie.</span>')
  document.getElementById('sum-l').innerHTML = bits.join('')
}

// ── guide ───────────────────────────────────────────────────────────────────

const FACTS = [
  ['need', 'Čo potrebuješ', 'phone'],
  ['time', 'Ako dlho to trvá', 'clock'],
  ['arrives', 'Ako to príde', 'mail'],
  ['file', 'Čo dostaneš', 'zip'],
]

const WAYS = [
  ['air', 'AirDrop', 'Z iPhonu na Mac. Najrýchlejšie.'],
  ['cloud', 'iCloud Drive alebo Disk Google', 'V telefóne ho tam ulož, v počítači otvor.'],
  ['mail', 'Poslať si mailom', 'Len pri menších súboroch.'],
  ['cable', 'Kábel', 'Pripoj telefón k počítaču a súbor skopíruj.'],
]

function guide(src, variantId, stepNo) {
  const def = GUIDES[src.id]
  const variant = def.variants ? (def.variants.find((v) => v.id === variantId) ?? def.variants[0]) : null
  const g = variant ?? def
  cur.id = src.id
  cur.variant = variant?.id ?? null
  cur.steps = g.steps
  cur.step = clamp((stepNo ?? 1) - 1, 0, g.steps.length - 1)
  cur.paused = false

  const list = meta.sources
  const nextSrc = list[(list.indexOf(src) + 1) % list.length]
  const after = g.after ?? AFTER[src.group]
  const steps = g.steps.map(
    (s, i) => `<li data-i="${i}"><button class="st-h" type="button" data-step="${i}"><span class="st-n">${i + 1}</span><span class="st-t">${esc(s.t)}</span></button>
      <div class="st-b"><p>${fmt(s.d)}</p>${s.note ? `<p class="st-note">${fmt(s.note)}</p>` : ''}${
        s.link ? `<div class="st-link"><a class="btn btn-primary" href="${esc(s.link.url)}" target="_blank" rel="noopener">${icon('ext')}Otvoriť v prehliadači</a>${s.link.hint ? `<small>${esc(s.link.hint)}</small>` : ''}</div>` : ''
      }</div></li>`,
  )

  app.innerHTML = `<div class="view wrap">
    <a class="back" href="#">${icon('left')}Všetky zdroje</a>
    <div class="g-top">
    <header class="g-head">
      ${glyph(src.mono)}
      <h1 id="h" tabindex="-1">${esc(src.name)}</h1>
      <p class="lead">${esc(src.gives)}</p>
      <div class="g-meta">
        <span class="pill">${icon('clock')}${esc(src.time)}</span>
        <span class="pill">${devices(src)}${esc(src.where)}</span>
        <span class="pill"><span class="lvl lvl-${src.level}" aria-hidden="true"><i></i><i></i><i></i></span>${LEVELS[src.level]}</span>
      </div>
    </header>
    <section class="status glass" aria-label="Ako ďaleko si">
      <span class="status-h">Ako ďaleko si s týmto zdrojom</span>
      ${segControl(src)}
    </section>
    </div>
    ${
      def.variants
        ? `<div class="variants" role="group" aria-label="Verzia návodu">${def.variants.map((v) => `<button type="button" data-variant="${v.id}" aria-pressed="${v === variant}">${esc(v.name)}</button>`).join('')}</div>`
        : ''
    }
    <section class="box glass" aria-labelledby="b-before">
      <h2 id="b-before">${icon('info')}Skôr než začneš</h2>
      <ul class="facts">${FACTS.map(([k, label, ic]) => `<li>${icon(k === 'need' ? (g.onPhone ? 'phone' : 'laptop') : ic)}<b>${label}</b><span>${fmt(g.before[k])}</span></li>`).join('')}</ul>
      ${g.note ? `<p class="box-note">${fmt(g.note)}</p>` : ''}
    </section>
    <section class="player glass" id="player" aria-label="Postup krok za krokom">
      <div class="pl-steps">
        <div class="pl-count"><span aria-live="polite">Krok <b id="pl-i">1</b> z ${g.steps.length}</span><span>${src.auto ? '' : 'Animácia ukazuje, kam ťuknúť'}</span></div>
        <ol class="steps" id="steps">${steps.join('')}</ol>
      </div>
      <div class="pl-stage">
        <div class="stage" id="stage" aria-hidden="true"></div>
        <div class="pl-ctl">
          <button class="ctl" type="button" id="replay" aria-label="Prehrať animáciu znova">${icon('replay')}<span>Znova</span></button>
          <button class="ctl" type="button" id="pause" aria-pressed="false" aria-label="Zastaviť animáciu">${icon('pause')}<span>Zastaviť</span></button>
          <button class="ctl ctl-auto" type="button" id="auto" aria-pressed="${prefs.auto ? 'true' : 'false'}"><span>Kroky idú samé</span><i></i></button>
        </div>
      </div>
      <div class="pl-foot">
        <div class="pl-nav">
          <button class="btn" type="button" id="prev">${icon('left')}Späť</button>
          <div class="dots" id="dots">${g.steps.map((s, i) => `<button type="button" data-step="${i}" aria-label="Krok ${i + 1}: ${esc(s.t)}"></button>`).join('')}</div>
          <button class="btn btn-primary" type="button" id="next"><span id="next-t">Ďalej</span>${icon('right')}</button>
        </div>
        <p class="keys">Kroky prepínaš aj šípkami <kbd>←</kbd> <kbd>→</kbd></p>
      </div>
    </section>
    <div class="after${g.watch?.length ? '' : ' is-one'}">
      ${g.watch?.length ? `<section class="box glass" aria-labelledby="b-watch"><h2 id="b-watch">${icon('warn')}Na čo si dať pozor</h2><ul class="watch">${g.watch.map((w) => `<li>${icon('warn')}<span>${fmt(w)}</span></li>`).join('')}</ul></section>` : ''}
      <section class="box glass" id="co-dalej" aria-labelledby="b-after">
        <h2 id="b-after">${icon('down')}${src.auto ? 'Čo bude ďalej' : 'Čo s tým súborom'}</h2>
        ${
          g.onPhone
            ? `<h3>Súbor máš v telefóne? Dostaň ho do počítača.</h3><ul class="ways">${WAYS.map(([ic, name, text]) => `<li>${icon(ic)}<b>${name}</b><span>${text}</span></li>`).join('')}</ul>`
            : ''
        }
        <div class="drop">
          <div class="drop-art" aria-hidden="true"><span class="drop-win"><b></b></span><span class="drop-file">${src.auto ? 'HRY' : 'ZIP'}</span></div>
          <div>
            <p class="drop-main">${src.auto ? 'Nič nesťahuješ ani nepretiahneš. Stačí to Jarvisovi povedať.' : 'Pretiahni ho do okna Jarvisa na ploche (alebo ťukni na sponku pri písaní). Netreba nič rozbaľovať.'}</p>
            <h3>Čo potom spraví Jarvis</h3>
            <ol class="next">${after.map((a) => `<li><span>${esc(a)}</span></li>`).join('')}</ol>
            <p class="privacy">${icon('lock')}Všetko ostáva v tvojom počítači.</p>
          </div>
        </div>
        <div class="mark"><span class="status-h">Už to máš? Označ si, ako ďaleko si.</span>${segControl(src)}</div>
      </section>
    </div>
    <nav class="more" aria-label="Ďalšie zdroje">
      <a class="btn" href="#">${icon('left')}Všetky zdroje</a>
      <a class="more-n" href="#${nextSrc.id}">${glyph(nextSrc.mono)}<span><small>Ďalší zdroj</small><strong>${esc(nextSrc.name)}</strong></span>${icon('right')}</a>
    </nav>
  </div>`
  document.title = `${src.name} · Sprievodca exportmi`
  paint()
  showStep(cur.step)
  watchStage()
}

function showStep(i) {
  clearTimeout(autoTimer)
  const n = cur.steps.length
  cur.step = clamp(i, 0, n - 1)
  const step = cur.steps[cur.step]
  for (const li of document.querySelectorAll('#steps li')) {
    const k = Number(li.dataset.i)
    li.classList.toggle('is-on', k === cur.step)
    li.classList.toggle('is-done', k < cur.step)
    li.querySelector('.st-h').setAttribute('aria-expanded', String(k === cur.step))
  }
  for (const d of document.querySelectorAll('#dots button')) {
    const k = Number(d.dataset.step)
    d.classList.toggle('is-done', k < cur.step)
    if (k === cur.step) d.setAttribute('aria-current', 'step')
    else d.removeAttribute('aria-current')
  }
  document.getElementById('pl-i').textContent = cur.step + 1
  document.getElementById('prev').disabled = cur.step === 0
  document.getElementById('next-t').textContent = cur.step === n - 1 ? 'Čo ďalej' : 'Ďalej'
  setPaused(false)

  scene?.stop()
  scene = new Scene(document.getElementById('stage'), step.scene)
  scene.onEnd = () => {
    if (!prefs.auto || cur.paused || cur.step >= n - 1) return
    autoTimer = setTimeout(() => showStep(cur.step + 1), 1600)
  }
  scene.play()
}

function move(dir) {
  if (dir > 0 && cur.step === cur.steps.length - 1) {
    document.getElementById('co-dalej').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
    return
  }
  showStep(cur.step + dir)
}

function setPaused(on) {
  cur.paused = on
  const b = document.getElementById('pause')
  if (!b) return
  b.setAttribute('aria-pressed', String(on))
  b.setAttribute('aria-label', on ? 'Pustiť animáciu' : 'Zastaviť animáciu')
  b.innerHTML = `${icon(on ? 'play' : 'pause')}<span>${on ? 'Pustiť' : 'Zastaviť'}</span>`
  scene?.pause(on)
  if (on) clearTimeout(autoTimer)
}

/** Replays the scene when the stage changes width, so the cursor keeps landing on its target. */
let stageWatch = null
function watchStage() {
  stageWatch?.disconnect()
  const stage = document.getElementById('stage')
  let width = stage.clientWidth
  let timer = 0
  stageWatch = new ResizeObserver(() => {
    if (Math.abs(stage.clientWidth - width) < 2) return
    width = stage.clientWidth
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!cur.paused) scene?.play()
    }, 220)
  })
  stageWatch.observe(stage)
}

// ── routing and events ──────────────────────────────────────────────────────

function route() {
  clearTimeout(autoTimer)
  scene?.stop()
  scene = null
  stageWatch?.disconnect()
  const [id, a, b] = decodeURIComponent(location.hash.slice(1)).split('/')
  const src = byId.get(id)
  if (!src) {
    const wasGuide = cur.id
    cur.id = null
    overview()
    scrollTo(0, wasGuide ? overviewY : 0)
    if (wasGuide) app.querySelector(`[data-src="${wasGuide}"] .tile-a`)?.focus({ preventScroll: true })
    return
  }
  if (!cur.id) overviewY = scrollY
  const stepFirst = /^\d+$/.test(a ?? '')
  guide(src, stepFirst ? null : a, Number(stepFirst ? a : b) || 1)
  scrollTo(0, 0)
  document.getElementById('h').focus({ preventScroll: true })
}

app.addEventListener('click', (e) => {
  const t = e.target.closest('button')
  if (!t) return
  if (t.dataset.cycle) {
    const src = byId.get(t.dataset.cycle)
    const steps = allowed(src)
    setState(src.id, steps[(steps.indexOf(stateOf(src.id)) + 1) % steps.length])
  } else if (t.dataset.s && t.parentElement.dataset.seg) {
    setState(t.parentElement.dataset.seg, Number(t.dataset.s))
  } else if (t.dataset.step) showStep(Number(t.dataset.step))
  else if (t.dataset.variant) {
    history.replaceState(null, '', `#${cur.id}/${t.dataset.variant}`)
    const y = scrollY
    guide(byId.get(cur.id), t.dataset.variant, 1)
    scrollTo(0, y)
    app.querySelector(`[data-variant="${t.dataset.variant}"]`)?.focus({ preventScroll: true })
  } else if (t.id === 'prev') move(-1)
  else if (t.id === 'next') move(1)
  else if (t.id === 'replay') {
    setPaused(false)
    scene?.play()
  } else if (t.id === 'pause') setPaused(!cur.paused)
  else if (t.id === 'auto') {
    prefs.auto = !prefs.auto
    write(PREFS, prefs)
    t.setAttribute('aria-pressed', String(prefs.auto))
    if (prefs.auto) {
      setPaused(false)
      scene?.play()
    } else clearTimeout(autoTimer)
  }
})

addEventListener('keydown', (e) => {
  if (!cur.id || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return
  if (e.key === 'ArrowRight') move(1)
  else if (e.key === 'ArrowLeft' && cur.step > 0) move(-1)
  else return
  e.preventDefault()
})

// Swipe left or right on the player to change the step.
let touch = null
app.addEventListener('touchstart', (e) => {
  touch = e.target.closest?.('#player') && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null
}, { passive: true })
app.addEventListener('touchend', (e) => {
  if (!touch) return
  const dx = e.changedTouches[0].clientX - touch.x
  const dy = e.changedTouches[0].clientY - touch.y
  touch = null
  if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.6) return
  if (dx < 0 && cur.step < cur.steps.length - 1) showStep(cur.step + 1)
  else if (dx > 0 && cur.step > 0) showStep(cur.step - 1)
}, { passive: true })

addEventListener('hashchange', route)
// Another tab (or the setup flow) changed the progress.
addEventListener('storage', (e) => {
  if (e.key !== KEY) return
  store = read(KEY)
  paint()
})

async function init() {
  try {
    const res = await fetch(new URL('./sources.json', import.meta.url))
    meta = await res.json()
  } catch {
    app.innerHTML = '<p class="boot">Sprievodcu sa nepodarilo načítať. Skús stránku obnoviť.</p>'
    return
  }
  byId = new Map(meta.sources.map((s) => [s.id, s]))
  route()
}

init()
