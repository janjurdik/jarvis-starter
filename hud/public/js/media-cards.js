// Fotky, videá a zvuk na ploche: každý súbor je vlastná plávajúca sklenená karta v pomere strán
// toho, čo ukazuje (reel 9:16 ostane na výšku). Viac súborov naraz sú karty vedľa seba, mierne
// posunuté do hĺbky. Kartu chytí myš aj prst a presunie kamkoľvek, klik ju dá dopredu, krížik
// alebo Esc (tú vpredu) ju zavrie, sama nezmizne. Video hrá hneď bez zvuku a dookola, klik zapne
// zvuk, medzerník na vybranej karte pustí a zastaví, tenká čiara dole ukazuje a posúva čas.
// Všetko ostáva v Jarvisovi, nič sa neotvára v inej appke.

import { esc } from './format.js'

const MAX_ON_SCREEN = 8
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const X_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>'
const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.8v12.4L18.6 12Z"/></svg>'
const PAUSE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5h2.6v13H8zM13.4 5.5H16v13h-2.6z"/></svg>'
const SND_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="s-body" d="M4 9.2h3l4.6-3.9v13.4L7 14.8H4a1 1 0 0 1-1-1v-3.6a1 1 0 0 1 1-1Z"/>' +
  '<path class="s-on" d="M15 9a4.2 4.2 0 0 1 0 6M17.9 6.4a7.8 7.8 0 0 1 0 11.2"/><path class="s-off" d="m15.5 9.5 5 5M20.5 9.5l-5 5"/></svg>'

function loadCss() {
  if (document.getElementById('media-cards-css')) return
  const link = document.createElement('link')
  link.id = 'media-cards-css'
  link.rel = 'stylesheet'
  link.href = '/css/media-cards.css'
  document.head.appendChild(link)
}

const clock = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

/**
 * reserveTop: px at the top of the free zone that is taken (the job-done card above new cards).
 * blocked: something above the cards is open (a dialog, the job view), Esc and space belong to it.
 * escFirst: a card above these (the job-done card) takes Esc before them.
 */
export function createMediaCards({ fileUrl = (u) => u, reserveTop = () => 0, blocked = () => false, escFirst = () => false } = {}) {
  loadCss()
  const root = document.createElement('div')
  root.className = 'mc'
  document.body.appendChild(root)
  /** url → card state */
  const cards = new Map()
  let zTop = 1
  let batchSeq = 0
  let raf = 0
  let opened = 0

  // ── where cards may stand: the free middle of the HUD (as the apps map and the result card) ──
  function zone() {
    const cs = getComputedStyle(document.documentElement)
    const rem = parseFloat(cs.fontSize) || 16
    const px = (name) => {
      const v = cs.getPropertyValue(name).trim()
      return v.endsWith('rem') ? parseFloat(v) * rem : parseFloat(v) || 0
    }
    const W = window.innerWidth
    const H = window.innerHeight
    let z = {
      left: px('--safe-left') + px('--edge') + px('--lw') + px('--gap'),
      right: W - (px('--safe-right') + px('--edge') + px('--rw') + px('--gap')),
      top: px('--safe-top') + px('--top-h'),
      // The command bar and the voice line stay free at the bottom.
      bottom: H - px('--safe-bottom') - 6.4 * rem,
    }
    if (z.right - z.left < 300) z = { ...z, left: 16, right: W - 16 }
    const reserved = Math.max(0, Number(reserveTop()) || 0)
    if (reserved && z.bottom - (z.top + reserved) > 220) z.top += reserved
    return { ...z, w: z.right - z.left, h: Math.max(160, z.bottom - z.top), rem }
  }

  /** Default proportions until the file says its own. */
  const guessAspect = (kind) => (kind === 'video' ? 16 / 9 : kind === 'image' ? 4 / 3 : null)

  /** Sizes and places the cards of one batch side by side in the free zone, slightly staggered in depth. */
  function layout(batch) {
    const all = [...cards.values()].filter((c) => c.batch === batch && !c.moved)
    if (!all.length) return
    const z = zone()
    const gap = 1.4 * z.rem
    // Photos and videos stand in a row, audio players (small) in a column under it.
    const list = all.filter((c) => c.kind !== 'audio')
    const audio = all.filter((c) => c.kind === 'audio')
    const n = list.length
    // Several cards may use the middle of the screen like the result card does, a bit wider than the free zone between the panes.
    const W = window.innerWidth
    const span = n <= 1 ? z.w : Math.min(W - 32, Math.max(z.w, W * 0.6))
    const left = Math.min(Math.max(16, z.left + z.w / 2 - span / 2), W - 16 - span)
    const audioW = Math.min(23 * z.rem, z.w * 0.9, W - 32)
    const audioH = 8.6 * z.rem
    const audioBlock = audio.length ? audio.length * audioH + (audio.length - 1) * 0.6 * z.rem + (n ? gap : 0) : 0
    const rowH = Math.max(140, z.h - audioBlock)
    const baseH = rowH * (n === 1 ? 0.94 : n === 2 ? 0.86 : 0.78)
    const capW = span * (n === 1 ? 0.8 : n === 2 ? 0.5 : 0.42)
    const size = list.map((c) => {
      const a = c.aspect ?? guessAspect(c.kind)
      let h = baseH
      let w = h * a
      if (w > capW) {
        w = capW
        h = w / a
      }
      return { w, h }
    })
    // Too wide for the zone side by side: everything shrinks a bit and the rest overlaps like a fanned stack.
    let total = size.reduce((s, x) => s + x.w, 0) + gap * Math.max(0, n - 1)
    const fit = n ? Math.max(0.6, Math.min(1, (span * 1.15) / total)) : 1
    for (const s of size) {
      s.w *= fit
      s.h *= fit
    }
    total = size.reduce((s, x) => s + x.w, 0) + gap * Math.max(0, n - 1)
    const tallest = size.reduce((m, x) => Math.max(m, x.h), 0)
    // The row and the audio column together sit in the middle of the zone.
    const blockTop = z.top + Math.max(0, (z.h - (tallest + audioBlock)) / 2)
    const step = total > span ? (span - size[n - 1].w) / Math.max(1, n - 1) : null
    let x = step === null ? left + (span - total) / 2 : left
    const mid = (n - 1) / 2
    list.forEach((c, i) => {
      const { w, h } = size[i]
      const off = n > 1 ? (i % 2 ? 1 : -1) * Math.min(z.h * 0.03, 18) : 0
      place(c, x, blockTop + (tallest - h) / 2 + off, w, h)
      c.el.style.setProperty('--turn', `${n > 1 ? ((mid - i) / Math.max(1, mid)) * 7 : 0}deg`)
      c.el.style.setProperty('--depth', `${n > 1 ? -Math.abs(i - mid) * 40 : 0}px`)
      x += step === null ? w + gap : step
    })
    // The middle card is the one in front, the small audio players above the row.
    const order = list.map((c, i) => [c, Math.abs(i - mid)]).sort((a, b) => b[1] - a[1])
    for (const [c] of order) front(c, false)
    let y = blockTop + (n ? tallest + gap : 0)
    for (const c of audio) {
      place(c, z.left + (z.w - audioW) / 2, y, audioW, audioH)
      y += audioH + 0.6 * z.rem
      front(c, false)
    }
  }

  /** Keeps a card fully on the screen. */
  function clampPos(c, x, y) {
    const W = window.innerWidth
    const H = window.innerHeight
    const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0
    return [Math.min(Math.max(0, x), Math.max(0, W - c.w)), Math.min(Math.max(top, y), Math.max(top, H - c.h))]
  }

  function place(c, x, y, w = c.w, h = c.h) {
    c.w = Math.round(w)
    c.h = Math.round(h)
    ;[c.x, c.y] = clampPos(c, x, y)
    c.el.style.width = `${c.w}px`
    c.el.style.height = `${c.h}px`
    c.el.style.transform = `translate3d(${Math.round(c.x)}px, ${Math.round(c.y)}px, 0)`
  }

  function front(c, focus = true) {
    c.el.style.zIndex = String(++zTop)
    if (focus) c.el.focus({ preventScroll: true })
  }

  const topCard = () => [...cards.values()].sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex))[0] ?? null

  // ── one card ──
  function build(item, batch, index) {
    const kind = item.kind
    const el = document.createElement('div')
    el.className = `mc-card k-${kind}${kind !== 'image' ? ' is-paused' : ''}`
    el.tabIndex = 0
    el.setAttribute('role', 'group')
    el.setAttribute('aria-label', item.name || (kind === 'video' ? 'Video' : kind === 'audio' ? 'Zvuk' : 'Fotka'))
    el.style.setProperty('--i', String(index))
    const src = esc(fileUrl(item.url))
    let media = ''
    if (kind === 'image') media = `<img src="${src}" alt="${esc(item.name ?? '')}" decoding="async" draggable="false">`
    else if (kind === 'video') media = `<video src="${src}" muted loop playsinline autoplay preload="metadata" disablepictureinpicture></video>`
    else media = `<audio src="${src}" preload="metadata"></audio><canvas class="mc-wave" aria-hidden="true"></canvas>`
    const timed = kind !== 'image'
    el.innerHTML =
      `<div class="mc-in"><div class="mc-media">${media}</div>` +
      (kind === 'audio' ? `<div class="mc-au"><button type="button" class="mc-pp" aria-label="Pustiť">${PLAY_SVG}${PAUSE_SVG}</button><span class="mc-au-name">${esc(item.name ?? '')}</span></div>` : '') +
      (kind === 'video' ? `<span class="mc-snd" aria-hidden="true">${SND_SVG}</span><span class="mc-big" aria-hidden="true">${PLAY_SVG}</span>` : '') +
      (kind !== 'audio' && item.name ? `<span class="mc-name">${esc(item.name)}</span>` : '') +
      (timed ? '<div class="mc-scrub" role="slider" aria-label="Čas" tabindex="-1"><i class="mc-line"><b class="mc-fill"></b></i><span class="mc-time"></span></div>' : '') +
      '<div class="mc-sheen"></div><div class="mc-rim"></div></div>' +
      `<button type="button" class="mc-x" aria-label="Zavrieť">${X_SVG}</button>`
    root.appendChild(el)
    const c = { key: item.url, item, kind, el, batch, x: 0, y: 0, w: 0, h: 0, aspect: null, moved: false, media: el.querySelector('img, video, audio'), fill: el.querySelector('.mc-fill'), time: el.querySelector('.mc-time'), timeText: '' }
    c.aspect = guessAspect(kind)
    wire(c)
    return c
  }

  function fail(c, text) {
    c.el.classList.add('is-fail')
    c.el.querySelector('.mc-media').innerHTML = `<div class="mc-fail"><span>${esc(text)}</span>${c.item.name ? `<small>${esc(c.item.name)}</small>` : ''}</div>`
    c.media = null
    if (c.kind === 'image' || c.kind === 'video') {
      c.aspect = 16 / 10
      if (!c.moved) layout(c.batch)
    }
  }

  function wire(c) {
    const { el, media, kind } = c
    if (kind === 'image') {
      media.addEventListener('load', () => {
        if (media.naturalWidth && media.naturalHeight) c.aspect = media.naturalWidth / media.naturalHeight
        el.classList.add('is-ready')
        if (!c.moved) layout(c.batch)
      })
      media.addEventListener('error', () => fail(c, 'Tento obrázok tu neukážem.'))
    } else {
      media.addEventListener('loadedmetadata', () => {
        if (kind === 'video' && media.videoWidth && media.videoHeight) {
          c.aspect = media.videoWidth / media.videoHeight
          if (!c.moved) layout(c.batch)
        }
        el.classList.add('is-ready')
        tick()
      })
      media.addEventListener('error', () => fail(c, kind === 'video' ? 'Toto video tu neprehrám.' : 'Tento zvuk tu neprehrám.'))
      media.addEventListener('play', () => {
        el.classList.remove('is-paused')
        loop()
      })
      media.addEventListener('pause', () => {
        el.classList.add('is-paused')
        tick()
      })
      media.addEventListener('volumechange', () => el.classList.toggle('is-sound', !media.muted && kind === 'video'))
      if (kind === 'video') media.play?.().catch(() => el.classList.add('is-paused'))
      const pp = el.querySelector('.mc-pp')
      pp?.addEventListener('click', (e) => {
        e.stopPropagation()
        toggle(c)
      })
      scrubber(c)
    }
    el.querySelector('.mc-x').addEventListener('click', (e) => {
      e.stopPropagation()
      close(c)
    })
    el.querySelector('.mc-x').addEventListener('pointerdown', (e) => e.stopPropagation())
    drag(c)
  }

  /** Video: the click turns the sound on (only one card speaks at a time) and off. Audio: play and pause. */
  function sound(c) {
    const m = c.media
    if (!m) return
    if (c.kind === 'audio') return toggle(c)
    if (m.muted) {
      for (const o of cards.values()) if (o !== c && o.kind === 'video' && o.media) o.media.muted = true
      for (const o of cards.values()) if (o !== c && o.kind === 'audio' && o.media && !o.media.paused) o.media.pause()
      m.muted = false
      if (m.paused) m.play().catch(() => {})
    } else m.muted = true
  }

  function toggle(c) {
    const m = c.media
    if (!m) return
    if (m.paused) {
      if (c.kind === 'audio') {
        // One sound at a time: other audio pauses, videos go quiet and keep playing.
        for (const o of cards.values()) {
          if (o === c || !o.media) continue
          if (o.kind === 'audio') o.media.pause()
          else if (o.kind === 'video') o.media.muted = true
        }
        analyse(c)
      }
      m.play().catch(() => {})
    } else m.pause()
  }

  function drag(c) {
    const { el } = c
    let start = null
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.mc-scrub, .mc-pp')) return
      front(c)
      start = { id: e.pointerId, px: e.clientX, py: e.clientY, x: c.x, y: c.y, moved: false }
      el.setPointerCapture(e.pointerId)
    })
    el.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) {
        if (!start && e.pointerType === 'mouse' && !reduced()) tilt(c, e)
        return
      }
      const dx = e.clientX - start.px
      const dy = e.clientY - start.py
      if (!start.moved && Math.hypot(dx, dy) < 5) return
      if (!start.moved) {
        start.moved = true
        c.moved = true
        el.classList.add('is-drag')
      }
      place(c, start.x + dx, start.y + dy)
    })
    const end = (e) => {
      if (!start || e.pointerId !== start.id) return
      const wasDrag = start.moved
      start = null
      el.classList.remove('is-drag')
      if (!wasDrag && e.type === 'pointerup') sound(c)
    }
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    el.addEventListener('pointerleave', () => {
      el.style.setProperty('--rx', '0deg')
      el.style.setProperty('--ry', '0deg')
    })
  }

  function tilt(c, e) {
    const r = c.el.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width - 0.5
    const y = (e.clientY - r.top) / r.height - 0.5
    c.el.style.setProperty('--ry', `${(x * 8).toFixed(2)}deg`)
    c.el.style.setProperty('--rx', `${(-y * 7).toFixed(2)}deg`)
    c.el.style.setProperty('--mx', `${((x + 0.5) * 100).toFixed(1)}%`)
    c.el.style.setProperty('--my', `${((y + 0.5) * 100).toFixed(1)}%`)
  }

  /** The thin line at the bottom: shows where playback is, a click or a drag on it jumps there. */
  function scrubber(c) {
    const bar = c.el.querySelector('.mc-scrub')
    let on = false
    const seek = (e) => {
      const m = c.media
      if (!m || !Number.isFinite(m.duration) || !m.duration) return
      const r = bar.getBoundingClientRect()
      m.currentTime = Math.min(m.duration - 0.05, Math.max(0, ((e.clientX - r.left) / r.width) * m.duration))
      tick()
    }
    bar.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      front(c)
      on = true
      bar.setPointerCapture(e.pointerId)
      c.el.classList.add('is-scrub')
      seek(e)
    })
    bar.addEventListener('pointermove', (e) => on && seek(e))
    const stop = (e) => {
      if (!on) return
      on = false
      c.el.classList.remove('is-scrub')
      e.stopPropagation()
    }
    bar.addEventListener('pointerup', stop)
    bar.addEventListener('pointercancel', stop)
  }

  // ── audio: a glowing line that moves with the sound ──
  function analyse(c) {
    if (c.analyser || !c.media) return
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      const ctx = new Ctx()
      const srcNode = ctx.createMediaElementSource(c.media)
      const an = ctx.createAnalyser()
      an.fftSize = 1024
      srcNode.connect(an)
      an.connect(ctx.destination)
      c.ctx = ctx
      c.analyser = an
      c.buf = new Uint8Array(an.fftSize)
    } catch {
      c.analyser = null
    }
  }

  function drawWave(c) {
    const cv = c.el.querySelector('.mc-wave')
    if (!cv) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = cv.clientWidth
    const h = cv.clientHeight
    if (!w || !h) return
    if (cv.width !== Math.round(w * dpr)) {
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
    }
    const g = cv.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)
    const playing = c.media && !c.media.paused
    const pts = 96
    g.beginPath()
    for (let i = 0; i <= pts; i++) {
      const t = i / pts
      let v = 0
      if (playing && c.analyser) {
        c.analyser.getByteTimeDomainData(c.buf)
        v = (c.buf[Math.floor(t * (c.buf.length - 1))] - 128) / 128
      }
      // The ends stay calm, the middle carries the sound.
      const env = Math.sin(Math.PI * t)
      const y = h / 2 + v * env * h * 0.42
      if (i === 0) g.moveTo(0, y)
      else g.lineTo(t * w, y)
    }
    g.strokeStyle = 'rgba(127, 243, 255, 0.95)'
    g.lineWidth = 1.6
    g.shadowColor = 'rgba(95, 230, 255, 0.85)'
    g.shadowBlur = playing ? 12 : 4
    g.stroke()
  }

  /** Progress lines and the time left, for every card at once, only while something plays. */
  function tick() {
    for (const c of cards.values()) {
      const m = c.media
      if (!m || c.kind === 'image') continue
      const d = Number.isFinite(m.duration) ? m.duration : 0
      const p = d ? Math.min(1, m.currentTime / d) : 0
      if (c.fill) c.fill.style.transform = `scaleX(${p.toFixed(4)})`
      const left = d ? `−${clock(d - m.currentTime)}` : ''
      if (c.time && left !== c.timeText) c.time.textContent = c.timeText = left
      if (c.kind === 'audio') drawWave(c)
    }
  }

  function loop() {
    if (raf) return
    const step = () => {
      tick()
      raf = [...cards.values()].some((c) => c.media && c.kind !== 'image' && !c.media.paused) ? requestAnimationFrame(step) : 0
    }
    raf = requestAnimationFrame(step)
  }

  function close(c) {
    if (!cards.has(c.key)) return
    cards.delete(c.key)
    c.el.classList.add('is-out')
    if (c.media && c.kind !== 'image') {
      c.media.pause()
      c.media.removeAttribute('src')
      c.media.load?.()
    }
    c.ctx?.close?.().catch(() => {})
    setTimeout(() => c.el.remove(), reduced() ? 0 : 320)
    if (!cards.size) root.classList.remove('has-cards')
  }

  function add(items, { single = false } = {}) {
    const fresh = []
    for (const raw of items) {
      if (!raw?.url || !['image', 'video', 'audio'].includes(raw.kind)) continue
      const have = cards.get(raw.url)
      if (have) {
        front(have, single)
        have.el.classList.remove('is-pulse')
        void have.el.offsetWidth
        have.el.classList.add('is-pulse')
        continue
      }
      if (fresh.length >= MAX_ON_SCREEN) break
      fresh.push(raw)
    }
    if (!fresh.length) return
    // Too many on the screen: the oldest step aside for the new ones.
    while (cards.size + fresh.length > MAX_ON_SCREEN * 2) close([...cards.values()].sort((a, b) => Number(a.el.style.zIndex) - Number(b.el.style.zIndex))[0])
    const batch = ++batchSeq
    fresh.forEach((item, i) => {
      const c = build(item, batch, i)
      cards.set(c.key, c)
    })
    root.classList.add('has-cards')
    layout(batch)
    // A card opened on its own from the chat lands a little apart from the last one.
    if (single && fresh.length === 1) {
      const c = cards.get(fresh[0].url)
      const shift = (opened++ % 4) * 28
      if (shift) place(c, c.x + shift, c.y + shift)
      front(c)
    }
    requestAnimationFrame(() => {
      for (const it of fresh) cards.get(it.url)?.el.classList.add('is-on')
    })
  }

  window.addEventListener('resize', () => {
    for (const c of cards.values()) place(c, c.x, c.y)
    const batches = new Set([...cards.values()].filter((c) => !c.moved).map((c) => c.batch))
    for (const b of batches) layout(b)
  })

  // Captured before the HUD's own keys: space on a chosen video is play and pause, not push-to-talk.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!cards.size || e.metaKey || e.ctrlKey || e.altKey) return
      const active = document.activeElement
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return
      if (blocked()) return
      if (e.key === 'Escape') {
        // The job-done card above the media closes first.
        if (escFirst()) return
        const c = topCard()
        if (!c) return
        e.preventDefault()
        e.stopPropagation()
        close(c)
        return
      }
      if (e.code === 'Space') {
        const card = active?.closest?.('.mc-card')
        const c = card && [...cards.values()].find((x) => x.el === card)
        if (!c || !c.media || c.kind === 'image') return
        e.preventDefault()
        e.stopPropagation()
        if (!e.repeat) toggle(c)
      }
    },
    true,
  )

  return {
    /** Several items at once: each its own card, side by side. */
    show(items, _opts = {}) {
      add(Array.isArray(items) ? items : [items])
    },
    /** One item from a chat thumbnail: opens it, or brings its card to the front. */
    open(item) {
      add([item], { single: true })
    },
    closeAll() {
      for (const c of [...cards.values()]) close(c)
    },
    get count() {
      return cards.size
    },
  }
}
