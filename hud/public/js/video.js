// The video theater. Jarvis gets a link to a video (the brain calls video_open, or POST /api/video),
// the server downloads and analyses it and this module shows it over the 3D world: the picture in a
// holographic frame, a rail with chapters, the waveform and the places where people speak, and the
// transcript that follows playback. Jarvis can jump to a time himself (SSE `video` → seek): an amber
// marker flies along the rail and a short caption says where he is going.
//
//   initVideo({ token, fileUrl, ownsAudio })     once, from main.js
//   videoEvent(ev)                                every SSE `video` event
//
// Keys work only while the theater has the focus (click it): Space or K play and pause, ← → 5 s
// (with Shift 30 s), ↑ ↓ volume, M mute, T transcript, / search, Esc close. They are caught in the
// capture phase, so the HUD under it does not start push-to-talk. With the focus in the command bar
// the HUD keys work as always: the user keeps talking to Jarvis while the video plays.
//
// Everything on screen is real: percent from the download, numbers from the metadata, the waveform
// from the sound of the file. Nothing here opens a video on its own, the brain decides that.

import { esc, plural } from './format.js'

const RATES = [1, 1.25, 1.5, 2, 0.75]
const LANGS = { sk: 'slovensky', cs: 'česky', en: 'anglicky', de: 'nemecky', pl: 'poľsky', hu: 'maďarsky', es: 'španielsky', fr: 'francúzsky', it: 'taliansky', uk: 'ukrajinsky', ru: 'rusky' }
const SOURCES = { subtitles: 'titulky', auto: 'automatické titulky', whisper: 'vlastný prepis' }

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const clamp = (x, a, b) => Math.min(b, Math.max(a, x))
const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16

/** 754 → "12:34", 3725 → "1:02:05". */
function clock(seconds, long = false) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h || long ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Lower case without diacritics, with a map back to positions in the original text (for highlighting). */
function foldMap(text) {
  let out = ''
  const map = []
  for (let i = 0; i < text.length; i++) {
    const f = text[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    for (let k = 0; k < f.length; k++) map.push(i)
    out += f
  }
  map.push(text.length)
  return { text: out, map }
}
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="f" d="M8 5.2v13.6a.6.6 0 0 0 .92.5l10.4-6.8a.6.6 0 0 0 0-1L8.92 4.7A.6.6 0 0 0 8 5.2Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5v14M15.5 5v14" stroke-width="2.6"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4.5V9h4.5"/></svg>',
  fwd: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.5V9h-4.5"/></svg>',
  sound: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5Z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/></svg>',
  mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5Z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  lines: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5h16M4 12h11M4 17.5h14"/></svg>',
  find: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="m15.2 15.2 4.3 4.3"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 14.5 5.5-5.5 5.5 5.5"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 9.5 5.5 5.5 5.5-5.5"/></svg>',
  again: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.5V9h-4.5"/></svg>',
}

function injectCss() {
  if (document.getElementById('video-css')) return
  const link = document.createElement('link')
  link.id = 'video-css'
  link.rel = 'stylesheet'
  link.href = '/css/video.css'
  document.head.append(link)
}

let theater = null

/** Builds the theater (hidden until a video opens) and restores the one that is open on the server. */
export function initVideo(opts = {}) {
  if (!theater) theater = createTheater(opts)
  return theater
}

/** One SSE `video` event from the server. */
export function videoEvent(ev) {
  theater?.apply(ev)
}

function createTheater({ token = null, fileUrl = (u) => u, ownsAudio = () => true } = {}) {
  injectCss()
  const root = document.createElement('section')
  root.className = 'vt'
  root.id = 'video-theater'
  root.hidden = true
  root.tabIndex = -1
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', 'Video')
  root.innerHTML =
    '<div class="vt-shade"></div>' +
    '<div class="vt-in">' +
    '<header class="vt-head">' +
    '<span class="vt-mark" aria-hidden="true"><svg viewBox="0 0 40 40"><circle class="r1" cx="20" cy="20" r="17"/></svg><svg viewBox="0 0 40 40"><path class="r2" d="M20 6.5A13.5 13.5 0 0 1 33.5 20"/><path class="tri" d="M16.6 14.4v11.2l9-5.6Z"/></svg></span>' +
    '<div class="vt-titles"><h2 class="vt-title"></h2><p class="vt-sub"></p></div>' +
    '<div class="vt-tools">' +
    `<button type="button" class="vt-btn vt-tr" data-act="side" aria-pressed="false">${ICON.lines}<span>Prepis</span></button>` +
    `<button type="button" class="vt-btn is-icon vt-x" data-act="close" aria-label="Zavrieť video" title="Zavrieť (Esc)">${ICON.close}</button>` +
    '</div></header>' +
    '<div class="vt-main">' +
    '<div class="vt-stage"><div class="vt-frame">' +
    '<video playsinline preload="metadata" tabindex="-1"></video>' +
    '<div class="vt-scan" aria-live="polite">' +
    '<div class="vt-thumb"></div><div class="vt-sweep"></div>' +
    '<div class="vt-read"><div class="vt-pct"></div><p class="vt-step"></p><div class="vt-bar"><u></u></div></div>' +
    '<div class="vt-fail" hidden><p></p><button type="button" class="vt-btn" data-act="retry">' + ICON.again + '<span>Skúsiť znova</span></button></div>' +
    '<ul class="vt-facts"></ul>' +
    '</div>' +
    '<div class="vt-flash" aria-hidden="true"></div>' +
    `<button type="button" class="vt-play" data-act="toggle" aria-label="Pustiť video"><i>${ICON.play}</i></button>` +
    '<div class="vt-note" role="status"></div>' +
    '<i class="vt-k tl"></i><i class="vt-k tr"></i><i class="vt-k bl"></i><i class="vt-k br"></i>' +
    '</div></div>' +
    '<div class="vt-rail-wrap">' +
    '<div class="vt-rail is-empty" role="slider" tabindex="0" aria-label="Čas vo videu" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">' +
    '<canvas class="dim"></canvas><canvas class="lit"></canvas>' +
    '<div class="vt-trail"></div><div class="vt-ghost"></div><div class="vt-pin"></div><div class="vt-fly"></div>' +
    '</div>' +
    '<div class="vt-tip"><b></b><em></em><span></span></div>' +
    '</div>' +
    '<div class="vt-ctl">' +
    `<button type="button" class="vt-btn is-icon" data-act="toggle" data-role="toggle" aria-label="Pustiť">${ICON.play}</button>` +
    `<button type="button" class="vt-btn is-icon" data-act="back" aria-label="O 5 sekúnd späť" title="5 s späť (←)">${ICON.back}</button>` +
    `<button type="button" class="vt-btn is-icon" data-act="fwd" aria-label="O 5 sekúnd dopredu" title="5 s dopredu (→)">${ICON.fwd}</button>` +
    '<span class="vt-time"><b class="vt-now">0:00</b><s>/</s><span class="vt-dur">0:00</span></span>' +
    '<span class="vt-chap"></span>' +
    '<span class="vt-keys" aria-hidden="true"><span><kbd>Medzerník</kbd>pauza</span><span><kbd>←</kbd><kbd>→</kbd>5 s</span><span><kbd>Esc</kbd>zavrieť</span></span>' +
    '<button type="button" class="vt-btn vt-rate" data-act="rate" aria-label="Rýchlosť prehrávania" title="Rýchlosť"><span class="vt-num">1×</span></button>' +
    `<button type="button" class="vt-btn is-icon" data-act="mute" data-role="mute" aria-label="Stlmiť zvuk" title="Zvuk (M)">${ICON.sound}</button>` +
    '</div>' +
    '</div>' +
    '<div class="vt-scrim" data-act="side"></div>' +
    '<aside class="vt-side vt-cut" aria-label="Prepis videa">' +
    '<div class="vt-side-head"><h3>Prepis</h3><span class="vt-src"></span></div>' +
    `<label class="vt-find">${ICON.find}<input type="search" placeholder="Hľadať v prepise" aria-label="Hľadať v prepise" autocomplete="off" spellcheck="false"><span class="vt-hits" aria-live="polite"></span>` +
    `<button type="button" data-act="prev" aria-label="Predchádzajúci výskyt" hidden>${ICON.up}</button><button type="button" data-act="next" aria-label="Ďalší výskyt" hidden>${ICON.down}</button></label>` +
    '<div class="vt-list"><ol class="vt-lines"></ol><div class="vt-none"><p></p><div class="vt-bar is-open"><u></u></div></div>' +
    '<button type="button" class="vt-btn vt-follow" data-act="follow">Sledovať prehrávanie</button></div>' +
    '</aside>' +
    '</div>'
  document.body.append(root)

  const $ = (sel) => root.querySelector(sel)
  const el = {
    title: $('.vt-title'), sub: $('.vt-sub'), frame: $('.vt-frame'), video: $('video'), thumb: $('.vt-thumb'), read: $('.vt-read'), pct: $('.vt-pct'),
    step: $('.vt-step'), bar: $('.vt-read .vt-bar'), fail: $('.vt-fail'), facts: $('.vt-facts'), flash: $('.vt-flash'), note: $('.vt-note'),
    rail: $('.vt-rail'), dim: $('canvas.dim'), lit: $('canvas.lit'), pin: $('.vt-pin'), ghost: $('.vt-ghost'), fly: $('.vt-fly'), trail: $('.vt-trail'), tip: $('.vt-tip'),
    now: $('.vt-now'), dur: $('.vt-dur'), chap: $('.vt-chap'), toggle: $('[data-role="toggle"]'), mute: $('[data-role="mute"]'), rate: $('.vt-rate .vt-num'), side: $('.vt-tr'),
    src: $('.vt-src'), find: $('.vt-find input'), hits: $('.vt-hits'), prev: $('[data-act="prev"]'), next: $('[data-act="next"]'), lines: $('.vt-lines'), none: $('.vt-none'), follow: $('.vt-follow'), big: $('.vt-play'),
  }

  let open = false
  let video = null // the server's public state of the video on screen
  let url = null
  let step = null // the last progress event
  let failure = null
  let segs = []
  let folded = []
  let lineEls = []
  let peaks = null
  let density = null
  let srcId = null
  let active = -1
  let following = true
  let hits = []
  let hitAt = -1
  let query = ''
  let pending = null // a seek that waits for the file: { t, jarvis }
  let autoplay = false
  let volume = 1
  let duck = 1
  let raf = 0
  let lastPost = 0
  let lastLvl = -1
  let drag = false
  let railW = 0
  let hideTimer = 0
  let noteTimer = 0
  let detailFor = null

  // ── server ────────────────────────────────────────────────────────────

  const headers = () => ({ 'content-type': 'application/json', ...(token ? { 'x-hud-token': token } : {}) })
  async function post(path, body = {}) {
    try {
      const res = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body), cache: 'no-store' })
      return await res.json().catch(() => ({ ok: false }))
    } catch {
      return { ok: false }
    }
  }
  async function get(path) {
    try {
      const res = await fetch(path, { headers: token ? { 'x-hud-token': token } : {}, cache: 'no-store' })
      return await res.json().catch(() => ({ ok: false }))
    } catch {
      return { ok: false }
    }
  }

  const duration = () => (video?.duration > 0 ? video.duration : Number.isFinite(el.video.duration) ? el.video.duration : 0)
  const ready = () => Boolean(video && video.state === 'ready' && video.fileUrl)

  // ── layout ────────────────────────────────────────────────────────────

  /**
   * From the top bar down to the command bar, which always stays free. The spoken subtitle of
   * Jarvis shares the lowest strip with the rail and the controls: while he speaks they dim
   * (video.css), so nothing moves.
   */
  function place() {
    const top = document.getElementById('top')?.getBoundingClientRect().bottom ?? 72
    const sub = document.getElementById('subtitle')?.getBoundingClientRect().bottom ?? window.innerHeight - 130
    const least = Math.min(window.innerHeight * 0.55, 24 * rem())
    const bottom = Math.max(top + least, sub - 0.15 * rem())
    root.style.setProperty('--vt-top', `${Math.round(top)}px`)
    root.style.setProperty('--vt-bottom', `${Math.max(0, Math.round(window.innerHeight - bottom))}px`)
  }

  const drawerMode = () => getComputedStyle(el.side).display !== 'none'

  function show() {
    clearTimeout(hideTimer)
    const was = open
    open = true
    root.hidden = false
    document.body.classList.add('vt-open')
    place()
    if (!was) {
      root.classList.toggle('side-open', root.clientWidth < 40 * rem())
      el.side.setAttribute('aria-pressed', String(root.classList.contains('side-open')))
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('is-on')))
      // The theater takes the keys, unless the user is in the middle of typing to Jarvis.
      const at = document.activeElement
      if (!at || at === document.body || !/^(INPUT|TEXTAREA)$/.test(at.tagName)) root.focus({ preventScroll: true })
    }
    requestAnimationFrame(sizeRail)
  }

  function hide() {
    if (!open) return
    open = false
    cancelAnimationFrame(raf)
    raf = 0
    el.video.pause()
    root.classList.remove('is-on')
    document.body.classList.remove('vt-open')
    if (root.contains(document.activeElement)) document.activeElement.blur()
    hideTimer = setTimeout(() => {
      if (open) return
      root.hidden = true
      el.video.removeAttribute('src')
      el.video.load()
      srcId = null
      video = null
      url = null
      step = null
      failure = null
      pending = null
      detailFor = null
      setTranscript([])
      peaks = null
      el.find.value = ''
      search('')
      root.classList.remove('is-ready', 'is-busy', 'is-error', 'is-paused')
    }, 460)
  }

  // ── header and the analysis overlay ───────────────────────────────────

  function renderHead() {
    let host = ''
    try {
      host = url ? new URL(url).hostname.replace(/^www\./, '') : ''
    } catch {
      host = ''
    }
    el.title.textContent = video?.title || (failure ? 'Video sa nepodarilo otvoriť' : 'Otváram video')
    const parts = []
    const who = video?.uploader || host
    if (who) parts.push(`<span class="vt-who">${esc(who)}</span>`)
    if (video?.duration) parts.push(`<span class="vt-num">${clock(video.duration)}</span>`)
    if (video?.chapters?.length) parts.push(`<span class="vt-extra"><span class="vt-num">${video.chapters.length}</span> ${plural(video.chapters.length, 'kapitola', 'kapitoly', 'kapitol')}</span>`)
    const t = video?.transcript
    if (t?.state === 'ready' && t.lines) parts.push(`<span class="vt-extra"><span class="vt-num">${t.lines}</span> ${plural(t.lines, 'riadok', 'riadky', 'riadkov')} prepisu</span>`)
    const status = failure ? 'Nepodarilo sa' : !video ? 'Čítam údaje' : video.state !== 'ready' ? 'Analyzujem' : t?.state === 'pending' ? 'Počúvam, čo sa hovorí' : ''
    if (status) parts.push(`<span class="vt-status">${status}</span>`)
    el.sub.innerHTML = parts.join('<i></i>')
    root.classList.toggle('is-error', Boolean(failure))
    root.classList.toggle('is-busy', !failure && (!video || video.state !== 'ready' || t?.state === 'pending'))
    root.classList.toggle('is-ready', ready() && !failure)
    root.setAttribute('aria-label', video?.title ? `Video: ${video.title}` : 'Video')
  }

  function fact(state, label, value, word = false) {
    return `<li class="is-${state}"><span>${label}</span><u></u><b${word ? ' class="w"' : ''}>${value}</b></li>`
  }

  function renderScan() {
    if (failure) {
      el.read.hidden = true
      el.facts.hidden = true
      el.fail.hidden = false
      el.fail.querySelector('p').textContent = failure.text || 'Video sa nepodarilo otvoriť.'
      el.fail.querySelector('button').hidden = !url
      return
    }
    el.fail.hidden = true
    el.read.hidden = false
    el.facts.hidden = false
    const pct = step?.step === 'video' && Number.isFinite(step.pct) ? step.pct : null
    el.pct.innerHTML = pct !== null ? `${pct}<small>%</small>` : ''
    el.step.textContent = step?.text || (video ? 'Pripravujem analýzu' : 'Čítam údaje o videu')
    el.bar.classList.toggle('is-open', pct === null)
    el.bar.style.setProperty('--p', pct !== null ? String(pct / 100) : '0')

    const t = video?.transcript
    const key = step?.step
    const rows = []
    rows.push(fact(video ? 'done' : 'run', 'Údaje o videu', video?.duration ? clock(video.duration) : '', false))
    if (t?.state === 'ready') rows.push(fact('done', 'Prepis', String(t.lines)))
    else if (video?.hasFile || (key && key !== 'transcript' && key !== 'probe')) rows.push(fact(t?.source === 'whisper' && t.state === 'pending' ? 'wait' : 'off', 'Prepis', t?.state === 'pending' ? 'neskôr' : 'bez titulkov', true))
    else rows.push(fact(key === 'transcript' ? 'run' : 'wait', 'Prepis', key === 'transcript' ? 'hľadám' : '', true))
    if (video?.hasFile) rows.push(fact('done', 'Video', video.bytes ? `${(video.bytes / 1048576).toFixed(video.bytes > 10485760 ? 0 : 1)} MB` : ''))
    else rows.push(fact(key === 'video' ? 'run' : 'wait', 'Video', pct !== null ? `${pct} %` : key === 'video' && step.state === 'converting' ? 'skladám' : '', pct === null))
    rows.push(fact(video?.peaks ? 'done' : key === 'waveform' ? 'run' : 'wait', 'Zvuk', video?.peaks ? 'zmeraný' : key === 'waveform' ? 'meriam' : '', true))
    el.facts.innerHTML = rows.join('')
  }

  function setThumb() {
    const src = video?.thumbUrl ? fileUrl(video.thumbUrl) : ''
    const want = src ? `url("${src.replace(/"/g, '%22')}")` : ''
    if (el.thumb.dataset.src === src) return
    el.thumb.dataset.src = src
    el.thumb.style.backgroundImage = want
    el.video.poster = src
  }

  // ── the video itself ──────────────────────────────────────────────────

  function applyVolume() {
    el.video.muted = !ownsAudio() || el.video.dataset.muted === '1'
    el.video.volume = clamp(volume * duck, 0, 1)
    const off = el.video.muted || volume === 0
    el.mute.innerHTML = off ? ICON.mute : ICON.sound
    el.mute.setAttribute('aria-label', off ? 'Zapnúť zvuk' : 'Stlmiť zvuk')
    el.mute.setAttribute('aria-pressed', String(off))
  }

  function loadSource() {
    if (!ready() || srcId === video.id) return
    srcId = video.id
    el.video.src = fileUrl(video.fileUrl)
    el.video.playbackRate = 1
    el.rate.textContent = '1×'
    applyVolume()
    el.video.load()
  }

  function play() {
    if (!ready()) return
    el.video.play().catch(() => {
      // The browser wants a click first: the big play button is on screen for that.
      root.classList.add('is-paused')
    })
  }
  const toggle = () => (el.video.paused ? play() : el.video.pause())

  function report(force = false) {
    if (!video || !ready() || !ownsAudio()) return
    const now = performance.now()
    if (!force && now - lastPost < 5000) return
    lastPost = now
    post(`/api/video/${video.id}/position`, { t: Math.round(el.video.currentTime * 10) / 10, paused: el.video.paused, rate: el.video.playbackRate })
  }

  function note(html, ms = 1900) {
    clearTimeout(noteTimer)
    el.note.innerHTML = html
    el.note.classList.add('on')
    noteTimer = setTimeout(() => el.note.classList.remove('on'), ms)
  }

  /** Jumps to a time. When Jarvis does it, the marker flies along the rail first and the picture follows. */
  function seekTo(t, { jarvis = false } = {}) {
    const d = duration()
    const target = clamp(Number(t) || 0, 0, d ? Math.max(0, d - 0.25) : Number(t) || 0)
    if (!ready() || el.video.readyState < 1) {
      pending = { t: target, jarvis }
      if (jarvis) note(`Po stiahnutí skočím na <b>${clock(target)}</b>`, 2600)
      return
    }
    if (!jarvis) {
      el.video.currentTime = target
      frame(true)
      return
    }
    note(`Preskakujem na <b>${clock(target)}</b>`)
    const x0 = d ? (el.video.currentTime / d) * railW : 0
    const x1 = d ? (target / d) * railW : 0
    if (reduced() || !railW) {
      el.video.currentTime = target
      frame(true)
    } else {
      const far = Math.abs(x1 - x0)
      const ms = clamp(380 + far * 0.55, 420, 900)
      el.fly.animate(
        [
          { transform: `translateX(${x0}px) rotate(45deg) scale(0.6)`, opacity: 0 },
          { transform: `translateX(${x0 + (x1 - x0) * 0.08}px) rotate(45deg) scale(1)`, opacity: 1, offset: 0.12 },
          { transform: `translateX(${x1}px) rotate(45deg) scale(1)`, opacity: 1, offset: 0.86 },
          { transform: `translateX(${x1}px) rotate(45deg) scale(2.4)`, opacity: 0 },
        ],
        { duration: ms, easing: 'cubic-bezier(0.6, 0, 0.2, 1)' },
      )
      el.trail.style.left = `${Math.min(x0, x1)}px`
      el.trail.style.width = `${far}px`
      el.trail.classList.toggle('rev', x1 < x0)
      el.trail.style.transformOrigin = x1 < x0 ? '100% 50%' : '0 50%'
      el.trail.animate([{ transform: 'scaleX(0)', opacity: 0.9 }, { transform: 'scaleX(1)', opacity: 0.9, offset: 0.8 }, { transform: 'scaleX(1)', opacity: 0 }], { duration: ms + 250, easing: 'cubic-bezier(0.6, 0, 0.2, 1)' })
      el.flash.classList.remove('go')
      void el.flash.offsetWidth
      el.flash.classList.add('go')
      setTimeout(() => {
        if (!open || !ready()) return
        el.video.currentTime = target
        frame(true)
      }, ms * 0.8)
    }
    following = true
    el.follow.classList.remove('on')
    if (el.video.paused) play()
  }

  // ── transcript ────────────────────────────────────────────────────────

  function setTranscript(list) {
    segs = Array.isArray(list) ? list : []
    folded = new Array(segs.length)
    active = -1
    density = null
    const long = duration() >= 3600 || (segs.at(-1)?.start ?? 0) >= 3600
    el.lines.innerHTML = segs
      .map((s, i) => `<li><button type="button" class="vt-line${long ? ' long' : ''}" data-i="${i}"><time>${clock(s.start, long)}</time><span>${esc(s.text)}</span></button></li>`)
      .join('')
    lineEls = [...el.lines.querySelectorAll('.vt-line')]
    renderNone()
    if (query) search(query)
    drawRail()
    frame(true)
  }

  function renderNone() {
    const t = video?.transcript
    el.none.hidden = segs.length > 0
    el.lines.hidden = segs.length === 0
    const waiting = !video || t?.state === 'pending' || (t?.state === 'ready' && !segs.length)
    el.none.querySelector('p').textContent = failure ? '' : waiting ? (t?.source === 'whisper' ? 'Video nemá titulky. Počúvam, čo sa v ňom hovorí, riadky pribudnú o chvíľu.' : 'Hľadám titulky videa.') : t?.note || 'Toto video nemá prepis.'
    el.none.querySelector('.vt-bar').hidden = !waiting || Boolean(failure)
    const lang = t?.lang ? LANGS[String(t.lang).toLowerCase().slice(0, 2)] ?? String(t.lang).toLowerCase() : ''
    el.src.textContent = segs.length ? [SOURCES[t?.source] ?? '', lang].filter(Boolean).join(', ') : ''
  }

  async function loadDetail() {
    if (!video?.id) return
    const id = video.id
    detailFor = id
    const res = await get(`/api/video/${id}`)
    if (!res.ok || detailFor !== id || video?.id !== id) return
    peaks = Array.isArray(res.peaks) && res.peaks.length ? res.peaks : null
    setTranscript(res.transcript ?? [])
    if (res.position && ready() && pending === null && Number.isFinite(res.position.t) && el.video.currentTime < 1 && res.position.t > 2) pending = { t: res.position.t, jarvis: false }
  }

  /** The line that is being said at time t (binary search), or the last one before it. */
  function lineAt(t) {
    let lo = 0
    let hi = segs.length - 1
    let at = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (segs[mid].start <= t) {
        at = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return at
  }

  function setActive(i) {
    if (i === active) return
    const prev = active
    active = i
    if (prev >= 0 && lineEls[prev]) {
      lineEls[prev].classList.remove('now')
      lineEls[prev].removeAttribute('aria-current')
    }
    // Lines that were already said dim a little: only the ones between the old and the new position change.
    const from = Math.max(0, Math.min(prev, i))
    const to = Math.min(lineEls.length - 1, Math.max(prev, i))
    for (let k = from; k <= to; k++) lineEls[k]?.classList.toggle('past', k < i)
    const node = lineEls[i]
    if (!node) return
    node.classList.add('now')
    node.setAttribute('aria-current', 'true')
    if (following && !el.lines.matches(':hover')) scrollToLine(i)
  }

  function scrollToLine(i, block = 0.38) {
    const node = lineEls[i]
    if (!node) return
    const box = el.lines
    const y = node.offsetTop - box.clientHeight * block + node.offsetHeight / 2
    box.scrollTo({ top: Math.max(0, y), behavior: reduced() ? 'auto' : 'smooth' })
  }

  function search(text) {
    query = fold(String(text ?? '').trim())
    for (const i of hits) {
      const node = lineEls[i]
      if (!node) continue
      node.classList.remove('hit', 'cur')
      node.lastElementChild.textContent = segs[i].text
    }
    hits = []
    hitAt = -1
    if (query.length >= 2) {
      for (let i = 0; i < segs.length; i++) {
        const f = (folded[i] ??= foldMap(segs[i].text))
        let at = f.text.indexOf(query)
        if (at < 0) continue
        hits.push(i)
        const raw = segs[i].text
        let html = ''
        let last = 0
        while (at >= 0) {
          const a = f.map[at]
          const b = f.map[at + query.length] ?? raw.length
          html += `${esc(raw.slice(last, a))}<mark>${esc(raw.slice(a, b))}</mark>`
          last = b
          at = f.text.indexOf(query, at + query.length)
        }
        const node = lineEls[i]
        if (node) {
          node.classList.add('hit')
          node.lastElementChild.innerHTML = html + esc(raw.slice(last))
        }
      }
    }
    const some = hits.length > 0
    el.prev.hidden = el.next.hidden = !some
    el.hits.classList.toggle('none', query.length >= 2 && !some)
    el.hits.textContent = query.length < 2 ? '' : some ? String(hits.length) : 'nič'
    drawRail()
    if (some) {
      // Start at the first hit after the place that is playing.
      const t = el.video.currentTime || 0
      const first = hits.findIndex((i) => segs[i].end >= t)
      goHit(first >= 0 ? first : 0, { scroll: true })
    }
  }

  function goHit(n, { scroll = true } = {}) {
    if (!hits.length) return
    if (hitAt >= 0) lineEls[hits[hitAt]]?.classList.remove('cur')
    hitAt = ((n % hits.length) + hits.length) % hits.length
    lineEls[hits[hitAt]]?.classList.add('cur')
    el.hits.textContent = `${hitAt + 1}/${hits.length}`
    if (scroll) {
      following = false
      el.follow.classList.toggle('on', !el.video.paused)
      scrollToLine(hits[hitAt], 0.3)
    }
  }

  // ── rail ──────────────────────────────────────────────────────────────

  function sizeRail() {
    const w = el.rail.clientWidth
    const h = el.rail.clientHeight
    if (!w || !h) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    railW = w
    for (const c of [el.dim, el.lit]) {
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr)
        c.height = Math.round(h * dpr)
      }
    }
    density = null
    drawRail()
    frame(true)
  }

  /** How much is said in every column of the rail: characters per second, 0 to 1. */
  function densityFor(cols, d) {
    if (density && density.length === cols) return density
    density = new Float32Array(cols)
    if (!d) return density
    for (const s of segs) {
      const len = Math.max(0.4, s.end - s.start)
      const rate = Math.min(1, s.text.length / len / 20)
      const a = clamp(Math.floor((s.start / d) * cols), 0, cols - 1)
      const b = clamp(Math.floor((s.end / d) * cols), 0, cols - 1)
      for (let k = a; k <= b; k++) if (rate > density[k]) density[k] = rate
    }
    return density
  }

  function drawRail() {
    const w = railW
    const h = el.rail.clientHeight
    const d = duration()
    el.rail.classList.toggle('is-empty', !ready() || !d)
    el.rail.setAttribute('aria-valuemax', String(Math.round(d)))
    if (!w || !h) return
    const r = rem()
    const dpr = el.dim.width / w
    const top = 0.55 * r // chapters and search hits
    const bottom = 0.6 * r // where people speak
    const waveTop = top + 0.3 * r
    const waveH = h - waveTop - bottom - 0.25 * r
    const mid = waveTop + waveH / 2
    const stepPx = 3
    const cols = Math.max(1, Math.floor(w / stepPx))
    const said = densityFor(cols, d)
    const chapters = video?.chapters ?? []

    for (const [canvas, lit] of [[el.dim, false], [el.lit, true]]) {
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      // Waveform, mirrored around the middle. Without one (still measuring) a quiet line.
      ctx.fillStyle = lit ? '#c9fbff' : 'rgba(127, 243, 255, 0.24)'
      if (peaks) {
        for (let c = 0; c < cols; c++) {
          const a = Math.floor((c / cols) * peaks.length)
          const b = Math.max(a + 1, Math.floor(((c + 1) / cols) * peaks.length))
          let v = 0
          for (let k = a; k < b && k < peaks.length; k++) if (peaks[k] > v) v = peaks[k]
          const half = Math.max(0.75, Math.pow(v, 0.8) * (waveH / 2))
          ctx.fillRect(c * stepPx, mid - half, 2, half * 2)
        }
      } else ctx.fillRect(0, mid - 0.5, w, 1)
      // Where people speak: a tick per column, taller where more is said.
      ctx.fillStyle = lit ? 'rgba(234, 251, 255, 0.85)' : 'rgba(234, 251, 255, 0.22)'
      for (let c = 0; c < cols; c++) {
        if (!said[c]) continue
        const tall = 1.5 + said[c] * (bottom - 2.5)
        ctx.fillRect(c * stepPx, h - tall, 2, tall)
      }
      // Chapters: bars along the top with a gap between them, and a faint line down through the waveform.
      if (d && chapters.length) {
        for (let i = 0; i < chapters.length; i++) {
          const x0 = (chapters[i].start / d) * w
          const x1 = ((chapters[i].end ?? chapters[i + 1]?.start ?? d) / d) * w
          ctx.fillStyle = lit ? '#7ff3ff' : 'rgba(127, 243, 255, 0.3)'
          ctx.fillRect(x0 + (i ? 1.5 : 0), 2, Math.max(1, x1 - x0 - (i ? 1.5 : 0) - 1.5), 3)
          if (i && !lit) {
            ctx.fillStyle = 'rgba(127, 243, 255, 0.16)'
            ctx.fillRect(Math.round(x0), top, 1, h - top)
          }
        }
      }
      // Search hits: amber diamonds, the same on both layers so they never dim.
      if (d && hits.length) {
        ctx.fillStyle = '#ffb25c'
        ctx.shadowColor = 'rgba(255, 178, 92, 0.9)'
        ctx.shadowBlur = 6
        for (const i of hits) {
          const x = (segs[i].start / d) * w
          ctx.save()
          ctx.translate(x, top - 0.02 * r)
          ctx.rotate(Math.PI / 4)
          ctx.fillRect(-2.6, -2.6, 5.2, 5.2)
          ctx.restore()
        }
        ctx.shadowBlur = 0
      }
    }
  }

  function chapterAt(t) {
    const list = video?.chapters ?? []
    let found = null
    for (const c of list) {
      if (c.start <= t) found = c
      else break
    }
    return found
  }

  function hover(clientX) {
    const box = el.rail.getBoundingClientRect()
    const x = clamp(clientX - box.left, 0, box.width)
    const d = duration()
    const t = d ? (x / box.width) * d : 0
    el.ghost.style.setProperty('--x', `${x}px`)
    el.tip.querySelector('b').textContent = clock(t, d >= 3600)
    el.tip.querySelector('em').textContent = chapterAt(t)?.title ?? ''
    const i = lineAt(t)
    const said = i >= 0 && segs[i].end + 1.5 >= t ? segs[i].text : ''
    el.tip.querySelector('span').textContent = said.length > 120 ? `${said.slice(0, 118).trimEnd()}…` : said
    const wrap = el.tip.parentElement.getBoundingClientRect()
    const tw = el.tip.offsetWidth
    el.tip.style.setProperty('--x', `${clamp(box.left - wrap.left + x - tw / 2, 0, Math.max(0, wrap.width - tw))}px`)
    return t
  }

  // ── every frame while it plays ────────────────────────────────────────

  function frame(force = false) {
    if (!open) return
    const d = duration()
    const t = ready() ? el.video.currentTime || 0 : 0
    const x = d ? clamp(t / d, 0, 1) * railW : 0
    el.pin.style.setProperty('--x', `${x.toFixed(1)}px`)
    el.lit.style.setProperty('--x', `${x.toFixed(1)}px`)
    const long = d >= 3600
    const shown = clock(t, long)
    if (el.now.textContent !== shown || force) {
      el.now.textContent = shown
      el.dur.textContent = clock(d, long)
      el.rail.setAttribute('aria-valuenow', String(Math.round(t)))
      el.rail.setAttribute('aria-valuetext', `${shown} z ${clock(d, long)}`)
      const chap = chapterAt(t)?.title ?? ''
      if (el.chap.textContent !== chap) el.chap.textContent = chap
    }
    if (segs.length) {
      const i = lineAt(t)
      setActive(i >= 0 && segs[i].end + 2 < t && segs[i + 1] ? i : i)
    }
    // The frame glows with the sound, from the measured waveform (no audio graph, so nothing can break playback).
    let lvl = 0
    if (peaks && d && !el.video.paused) lvl = peaks[clamp(Math.floor((t / d) * peaks.length), 0, peaks.length - 1)] ?? 0
    const smooth = lastLvl < 0 ? lvl : lastLvl + (lvl - lastLvl) * 0.25
    if (Math.abs(smooth - lastLvl) > 0.01 || force) {
      lastLvl = smooth
      root.style.setProperty('--lvl', smooth.toFixed(2))
    }
    report()
  }

  function loop() {
    cancelAnimationFrame(raf)
    const tick = () => {
      if (!open || el.video.paused) {
        raf = 0
        return
      }
      frame()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  }

  // ── events from the page ──────────────────────────────────────────────

  el.video.addEventListener('loadedmetadata', () => {
    const v = el.video
    if (v.videoWidth && v.videoHeight) el.frame.style.setProperty('--ar', String(clamp(v.videoWidth / v.videoHeight, 0.5, 2.6)))
    drawRail()
    if (pending) {
      const p = pending
      pending = null
      el.video.currentTime = clamp(p.t, 0, Math.max(0, duration() - 0.25))
      if (p.jarvis) note(`Preskakujem na <b>${clock(p.t)}</b>`)
    }
    frame(true)
    if (autoplay) {
      autoplay = false
      play()
    } else root.classList.add('is-paused')
  })
  el.video.addEventListener('play', () => {
    root.classList.remove('is-paused')
    el.toggle.innerHTML = ICON.pause
    el.toggle.setAttribute('aria-label', 'Pozastaviť')
    loop()
    report(true)
  })
  el.video.addEventListener('pause', () => {
    root.classList.add('is-paused')
    el.toggle.innerHTML = ICON.play
    el.toggle.setAttribute('aria-label', 'Pustiť')
    frame(true)
    report(true)
  })
  el.video.addEventListener('seeked', () => {
    frame(true)
    report(true)
  })
  el.video.addEventListener('timeupdate', () => el.video.paused && frame())
  el.video.addEventListener('ended', () => frame(true))
  el.video.addEventListener('ratechange', () => {
    el.rate.textContent = `${el.video.playbackRate}×`
    report(true)
  })
  el.video.addEventListener('error', () => {
    if (!srcId || !open) return
    failure = { code: 'play', text: 'Stiahnuté video sa v tomto okne nedá prehrať.' }
    renderHead()
    renderScan()
  })
  el.video.addEventListener('click', () => ready() && toggle())

  root.addEventListener('click', (e) => {
    const line = e.target.closest('.vt-line')
    if (line) {
      const s = segs[Number(line.dataset.i)]
      if (!s) return
      following = true
      el.follow.classList.remove('on')
      seekTo(s.start)
      if (el.video.paused) play()
      return
    }
    const act = e.target.closest('[data-act]')?.dataset.act
    if (!act) return
    if (act === 'close') return closeByUser()
    if (act === 'toggle') return toggle()
    if (act === 'back') return seekTo(el.video.currentTime - 5)
    if (act === 'fwd') return seekTo(el.video.currentTime + 5)
    if (act === 'rate') return void (el.video.playbackRate = RATES[(RATES.indexOf(el.video.playbackRate) + 1) % RATES.length])
    if (act === 'mute') return toggleMute()
    if (act === 'side') return toggleSide()
    if (act === 'prev') return goHit(hitAt - 1)
    if (act === 'next') return goHit(hitAt + 1)
    if (act === 'retry' && url) {
      failure = null
      step = null
      renderHead()
      renderScan()
      post('/api/video', { url })
      return
    }
    if (act === 'follow') {
      following = true
      el.follow.classList.remove('on')
      if (active >= 0) scrollToLine(active)
    }
  })

  function toggleMute() {
    el.video.dataset.muted = el.video.dataset.muted === '1' ? '0' : '1'
    applyVolume()
  }

  function toggleSide() {
    if (drawerMode()) {
      const on = root.classList.toggle('side-open')
      el.side.setAttribute('aria-pressed', String(on))
      if (on) el.find.focus({ preventScroll: true })
      else root.focus({ preventScroll: true })
    } else root.classList.toggle('no-side')
    requestAnimationFrame(sizeRail)
  }

  function closeByUser() {
    hide()
    post('/api/video/current/control', { action: 'close' })
  }

  // The user scrolls the transcript: stop following until they ask for it again.
  for (const type of ['wheel', 'touchmove']) {
    el.lines.addEventListener(
      type,
      () => {
        if (!following) return
        following = false
        el.follow.classList.toggle('on', segs.length > 0)
      },
      { passive: true },
    )
  }

  let findTimer = 0
  el.find.addEventListener('input', () => {
    clearTimeout(findTimer)
    findTimer = setTimeout(() => search(el.find.value), 110)
  })

  // Rail: click or drag to seek, hover to see the time and what is said there.
  el.rail.addEventListener('pointermove', (e) => {
    if (!duration()) return
    el.rail.classList.add('is-hover')
    const t = hover(e.clientX)
    if (drag) el.video.currentTime = t
  })
  el.rail.addEventListener('pointerleave', () => !drag && el.rail.classList.remove('is-hover'))
  el.rail.addEventListener('pointerdown', (e) => {
    if (!ready() || !duration() || e.button !== 0) return
    drag = true
    el.rail.classList.add('is-drag')
    el.rail.setPointerCapture(e.pointerId)
    el.video.currentTime = hover(e.clientX)
    frame(true)
  })
  const endDrag = (e) => {
    if (!drag) return
    drag = false
    el.rail.classList.remove('is-drag', 'is-hover')
    if (el.rail.hasPointerCapture?.(e.pointerId)) el.rail.releasePointerCapture(e.pointerId)
  }
  el.rail.addEventListener('pointerup', endDrag)
  el.rail.addEventListener('pointercancel', endDrag)

  // Keys, in the capture phase: while the theater has the focus nothing reaches the HUD under it.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!open || !root.contains(document.activeElement)) return
      const at = document.activeElement
      const inFind = at === el.find
      const onButton = at.tagName === 'BUTTON'
      // Enter on the theater itself still takes the user to the command bar, as everywhere in the HUD.
      if ((e.key === 'Enter' || e.key === '/') && !inFind && !onButton && !(e.metaKey || e.ctrlKey || e.altKey)) {
        if (e.key === '/') {
          e.stopPropagation()
          e.preventDefault()
          if (drawerMode() && !root.classList.contains('side-open')) toggleSide()
          else el.find.focus({ preventScroll: true })
        }
        return
      }
      e.stopPropagation()
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') {
        e.preventDefault()
        if (inFind && el.find.value) {
          el.find.value = ''
          search('')
        } else if (inFind) root.focus({ preventScroll: true })
        else if (drawerMode() && root.classList.contains('side-open') && root.clientWidth >= 40 * rem()) toggleSide()
        else closeByUser()
        return
      }
      if (inFind) {
        if (e.key === 'Enter') {
          e.preventDefault()
          if (hits.length) goHit(hitAt + (e.shiftKey ? -1 : 1))
        }
        return
      }
      if (onButton && (e.key === ' ' || e.key === 'Enter')) return // the focused button does its own thing
      const jump = e.shiftKey ? 30 : 5
      if (e.code === 'Space' || e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        if (!e.repeat) toggle()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        seekTo(el.video.currentTime - jump)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        seekTo(el.video.currentTime + jump)
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        volume = clamp(Math.round((volume + (e.key === 'ArrowUp' ? 0.1 : -0.1)) * 10) / 10, 0, 1)
        el.video.dataset.muted = '0'
        applyVolume()
        note(`Hlasitosť <b>${Math.round(volume * 100)} %</b>`, 900)
      } else if (e.key === 'Home') {
        e.preventDefault()
        seekTo(0)
      } else if (e.key === 'm' || e.key === 'M') toggleMute()
      else if (e.key === 't' || e.key === 'T') toggleSide()
      else if (e.key === '>' || e.key === '<') {
        const i = RATES.slice().sort((a, b) => a - b)
        const k = clamp(i.indexOf(el.video.playbackRate) + (e.key === '>' ? 1 : -1), 0, i.length - 1)
        el.video.playbackRate = i[k]
      }
    },
    true,
  )
  window.addEventListener('keyup', (e) => open && root.contains(document.activeElement) && e.stopPropagation(), true)

  window.addEventListener('resize', () => {
    if (!open) return
    place()
    sizeRail()
  })
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => {
      if (!open) return
      place()
      sizeRail()
    })
    ro.observe(el.rail)
    const voice = document.getElementById('voice')
    if (voice) ro.observe(voice)
  }

  // Jarvis listens or speaks: the video goes quiet so the microphone hears the user and the user hears Jarvis.
  new MutationObserver(() => {
    const v = document.body.dataset.voice
    duck = v === 'listening' || v === 'transcribing' ? 0.1 : v === 'speaking' ? 0.25 : 1
    if (open) applyVolume()
  }).observe(document.body, { attributes: true, attributeFilter: ['data-voice'] })

  // ── events from the server ────────────────────────────────────────────

  function setVideo(next) {
    const first = !video || video.id !== next.id
    video = next
    url = next.url || url
    if (first) {
      segs = []
      peaks = null
      setTranscript([])
    }
    failure = next.state === 'error' ? next.error ?? { text: 'Analýza zlyhala.' } : null
    setThumb()
    renderHead()
    renderScan()
    renderNone()
    if (ready()) loadSource()
    drawRail()
  }

  function apply(ev) {
    if (!ev || typeof ev !== 'object') return
    if (ev.type === 'open') {
      const same = open && ev.video && video?.id === ev.video.id
      if (!same) {
        // Another video replaces the one on screen.
        el.video.pause()
        el.video.removeAttribute('src')
        el.video.load()
        srcId = null
        video = null
        step = null
        failure = null
        pending = null
        setTranscript([])
        peaks = null
        el.thumb.dataset.src = ''
        el.thumb.style.backgroundImage = ''
        root.classList.remove('is-ready', 'is-paused')
        autoplay = ev.restore !== true
      }
      url = ev.url ?? ev.video?.url ?? url
      if (Number.isFinite(ev.startAt) && ev.startAt > 0) pending = { t: ev.startAt, jarvis: false }
      show()
      if (ev.video) {
        setVideo(ev.video)
        if (ev.video.state === 'ready' || ev.video.transcript?.state === 'ready') loadDetail()
      } else {
        renderHead()
        renderScan()
        renderNone()
      }
      return
    }
    if (ev.type === 'error') {
      if (!open || video) return
      failure = ev.error ?? { text: 'Video sa nepodarilo otvoriť.' }
      url = ev.url ?? url
      renderHead()
      renderScan()
      renderNone()
      return
    }
    if (ev.type === 'control' && ev.action === 'close') return hide()
    if (!open) return
    if (ev.type === 'state' && ev.video) {
      if (video && ev.video.id !== video.id) return
      const hadPeaks = video?.peaks
      const hadFile = video?.hasFile
      setVideo(ev.video)
      if ((ev.video.peaks && !hadPeaks) || (ev.video.hasFile && !hadFile)) loadDetail()
      return
    }
    if (!video || ev.id !== video.id) return
    if (ev.type === 'progress') {
      step = ev
      renderScan()
      renderHead()
    } else if (ev.type === 'transcript') loadDetail()
    else if (ev.type === 'seek') seekTo(ev.t, { jarvis: ev.by !== 'user' })
    else if (ev.type === 'control') {
      if (ev.action === 'play') play()
      else if (ev.action === 'pause') el.video.pause()
      else if (ev.action === 'rate' && Number.isFinite(ev.rate)) {
        el.video.playbackRate = ev.rate
        note(`Rýchlosť <b>${ev.rate}×</b>`, 1200)
      }
    }
  }

  // A video that is open on the server (the page was reloaded, or a second window joined): show it, paused.
  get('/api/video').then((res) => {
    if (!res.ok || !res.current || open) return
    const v = (res.videos ?? []).find((x) => x.id === res.current)
    if (v) apply({ type: 'open', url: v.url, video: v, restore: true })
  })

  return { apply, close: closeByUser, isOpen: () => open }
}
