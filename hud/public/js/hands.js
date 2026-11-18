// Hand control: the camera sees the user's hands and they move a cursor over the desktop.
//
//   one hand             the palm leads the cursor
//   pinch                thumb and forefinger together and apart again: a click
//   pinch and move       a drag: turns the world, moves the camera window
//   both hands pinched   pulled apart or together: zoom
//
// The picture never leaves this page. It is read here, by a model that runs in the browser
// (MediaPipe Hand Landmarker from /vendor, the model file comes from /api/hands/model).
// Gestures become ordinary pointer and wheel events, so everything a mouse can do works by hand
// and no other part of the HUD needs to know about hands.
//
//   const hands = createHands({ onState, isHot })
//   hands.toggle()                       camera window + tracking on and off
//   onState({ state, hands })            'off' | 'loading' | 'on' | 'blocked' | 'error'
//   isHot(x, y)                          is there something to click in the 3D world at this point

const CSS_HREF = '/css/hands.css'
// The version is part of the address: it has to match package.json and the mount in hud/server.mjs.
const LIB = '/vendor/mediapipe-0.10.35'
const VISION = `${LIB}/vision_bundle.mjs`
const WASM = `${LIB}/wasm`
const MODEL = '/api/hands/model'
const STORE = 'jarvis.hands.cam'

/** Joints of one hand that are joined by a line in the camera window. */
const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
]
const PALM = [0, 5, 9, 13, 17]
/** The part of the camera picture that covers the whole screen, so nobody has to reach its edges. */
const BOX = { x0: 0.16, x1: 0.84, y0: 0.14, y1: 0.76 }
const PINCH_ON = 0.3
const PINCH_OFF = 0.46
/** A pinch has to travel this far (px) before it is a drag. Inside it the cursor holds still, so a click lands where it was aimed. */
const DEAD = 30
const CLICKABLE = 'button, a[href], input, textarea, select, label, summary, [role="button"], [data-node], [data-ask], [data-act], [data-key], .chip'

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))

/** One Euro filter: steady when the hand rests, quick when it moves. */
function euro(minCutoff = 1.4, beta = 0.035) {
  let x = null
  let dx = 0
  let t0 = 0
  const alpha = (cut, dt) => 1 / (1 + 1 / (2 * Math.PI * cut * dt))
  return (v, t) => {
    if (x === null || t - t0 > 0.4) {
      x = v
      dx = 0
      t0 = t
      return v
    }
    const dt = Math.max(1e-3, t - t0)
    t0 = t
    const d = (v - x) / dt
    dx += alpha(1, dt) * (d - dx)
    x += alpha(minCutoff + beta * Math.abs(dx), dt) * (v - x)
    return x
  }
}

function injectCss() {
  if (document.querySelector(`link[href="${CSS_HREF}"]`)) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = CSS_HREF
  document.head.append(link)
}

const CURSOR_SVG = `<svg viewBox="-50 -50 100 100" aria-hidden="true">
  <g class="hc-spin"><circle class="hc-ring" r="34"/><path class="hc-ticks" d="M0-44v7M0 37v7M-44 0h7M37 0h7"/></g>
  <path class="hc-brackets" d="M-27-19v-8h8M19-27h8v8M27 19v8h-8M-19 27h-8v-8"/>
  <circle class="hc-track" r="21"/><circle class="hc-press" r="21" pathLength="100"/>
  <circle class="hc-dot" r="3.4"/>
</svg>`

export function createHands({ onState = () => {}, isHot = () => false } = {}) {
  injectCss()
  const debug = new URLSearchParams(location.search)
  // For checking without a camera: a video file instead of the live picture (only with ?debug=1).
  const testSrc = debug.get('debug') === '1' ? debug.get('handsrc') : null

  const root = document.createElement('div')
  root.className = 'hcam'
  root.hidden = true
  root.innerHTML = `<div class="hcam-bar"><b>Kamera</b><span class="hcam-s"></span><button type="button" class="hcam-x" aria-label="Vypnúť ovládanie rukami">×</button></div>
    <div class="hcam-view"><video playsinline muted></video><canvas></canvas><i class="hcam-k k1"></i><i class="hcam-k k2"></i><i class="hcam-k k3"></i><i class="hcam-k k4"></i><div class="hcam-wait"></div></div>
    <div class="hcam-hint"><span>štipni</span> klik · <span>štipni a ťahaj</span> otáčanie · <span>obe ruky</span> priblíženie</div>`
  const layer = document.createElement('div')
  layer.className = 'hc-layer'
  layer.innerHTML = `<svg class="hc-link" aria-hidden="true"><line/></svg><div class="hc hc-a" hidden>${CURSOR_SVG}</div><div class="hc hc-b" hidden>${CURSOR_SVG}</div>`
  document.body.append(root, layer)
  const el = {
    video: root.querySelector('video'),
    canvas: root.querySelector('canvas'),
    status: root.querySelector('.hcam-s'),
    wait: root.querySelector('.hcam-wait'),
    link: layer.querySelector('.hc-link'),
    line: layer.querySelector('line'),
    cur: [layer.querySelector('.hc-a'), layer.querySelector('.hc-b')],
  }
  const g = el.canvas.getContext('2d')

  let state = 'off'
  let stream = null
  let landmarker = null
  let raf = 0
  let lastVideoTime = -1
  let gen = 0
  /** Tracked hands, the leading one first: { x, y (camera, mirrored), sx, sy (screen), pinch, ratio, fx, fy, seen } */
  let tracks = []
  let press = null
  let zoom = null
  let wait = false
  let hot = null

  function setState(next, text = '') {
    state = next
    root.classList.toggle('is-on', next === 'on')
    document.body.classList.toggle('hands-on', next === 'on' || next === 'loading')
    el.wait.textContent = next === 'loading' ? text || 'Pripravujem sledovanie rúk' : next === 'blocked' || next === 'error' ? text : ''
    el.wait.hidden = !el.wait.textContent
    onState({ state, hands: tracks.length, text })
  }

  // ── the camera window: dragged anywhere, remembered ──
  function place(x, y) {
    const w = root.offsetWidth || 272
    const h = root.offsetHeight || 250
    const nx = clamp(x, 8, Math.max(8, window.innerWidth - w - 8))
    const ny = clamp(y, 8, Math.max(8, window.innerHeight - h - 8))
    root.style.left = `${nx}px`
    root.style.top = `${ny}px`
    return { x: nx, y: ny }
  }
  function restore() {
    let saved = null
    try {
      saved = JSON.parse(localStorage.getItem(STORE) ?? 'null')
    } catch {
      saved = null
    }
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) place(saved.x, saved.y)
    else place(28, window.innerHeight - 380)
  }
  let move = null
  root.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.hcam-x')) return
    const r = root.getBoundingClientRect()
    move = { dx: e.clientX - r.left, dy: e.clientY - r.top }
    root.classList.add('is-moving')
    e.preventDefault()
  })
  window.addEventListener('pointermove', (e) => {
    if (move) place(e.clientX - move.dx, e.clientY - move.dy)
  })
  window.addEventListener('pointerup', () => {
    if (!move) return
    move = null
    root.classList.remove('is-moving')
    try {
      localStorage.setItem(STORE, JSON.stringify({ x: root.offsetLeft, y: root.offsetTop }))
    } catch {
      // private window: the place is simply not remembered
    }
  })
  window.addEventListener('resize', () => {
    if (!root.hidden) place(root.offsetLeft, root.offsetTop)
  })
  root.querySelector('.hcam-x').addEventListener('click', () => stop())

  // ── events: a hand is a mouse ──
  function fire(type, x, y, target, buttons = 0) {
    const t = target?.isConnected ? target : (document.elementFromPoint(x, y) ?? document.body)
    const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: type === 'pointermove' ? -1 : 0, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true }
    t.dispatchEvent(type === 'click' ? new MouseEvent('click', init) : new PointerEvent(type, init))
    return t
  }
  function wheel(x, y, deltaY) {
    const t = document.elementFromPoint(x, y) ?? document.body
    t.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, deltaY, deltaMode: 0 }))
  }
  function setHot(node) {
    if (hot === node) return
    hot?.classList.remove('hand-hot')
    hot = node
    hot?.classList.add('hand-hot')
  }

  /** Ends a press. A drag is let go; a pinch that never left its spot is a click right there. */
  function release(click) {
    const p = press
    press = null
    if (!p) return
    if (p.dragging) fire('pointerup', p.px, p.py, p.target)
    else if (click) {
      const t = fire('pointerdown', p.x, p.y, p.target, 1)
      fire('pointerup', p.x, p.y, t)
      fire('click', p.x, p.y, t)
      if (t.matches?.('input, textarea')) t.focus()
      pulse(p.x, p.y)
    }
  }
  function pulse(x, y) {
    const ring = document.createElement('i')
    ring.className = 'hc-pulse'
    ring.style.transform = `translate3d(${x}px,${y}px,0)`
    layer.append(ring)
    ring.addEventListener('animationend', () => ring.remove())
  }

  // ── one frame of hands ──
  function measure(lm, aspect) {
    let x = 0
    let y = 0
    for (const i of PALM) {
      x += lm[i].x
      y += lm[i].y
    }
    const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * aspect, lm[a].y - lm[b].y)
    // Mirrored, like a mirror: the right hand is on the right of the picture.
    return { x: 1 - x / PALM.length, y: y / PALM.length, ratio: d(4, 8) / Math.max(1e-4, d(0, 9)), lm }
  }

  /** Landmarks of the hands in this frame ([[{x,y,z}×21], …], camera coordinates 0..1). */
  function update(hands, aspect = 4 / 3, now = performance.now()) {
    const t = now / 1000
    const seen = hands.map((lm) => measure(lm, aspect))
    // Every hand keeps its own cursor from frame to frame: the nearest one before is the same hand.
    const next = []
    const free = [...seen]
    for (const tr of tracks) {
      let best = -1
      let bd = 0.25
      free.forEach((m, i) => {
        const d = Math.hypot(m.x - tr.x, m.y - tr.y)
        if (d < bd) {
          bd = d
          best = i
        }
      })
      if (best >= 0) next.push(Object.assign(tr, free.splice(best, 1)[0], { seen: now }))
      else if (now - tr.seen < 220) next.push(tr)
    }
    for (const m of free) if (next.length < 2) next.push({ ...m, pinch: false, fx: euro(), fy: euro(), seen: now, born: now, sx: 0, sy: 0 })
    tracks = next
    for (const tr of tracks) {
      if (tr.seen !== now) continue
      tr.sx = tr.fx(clamp((tr.x - BOX.x0) / (BOX.x1 - BOX.x0)) * window.innerWidth, t)
      tr.sy = tr.fy(clamp((tr.y - BOX.y0) / (BOX.y1 - BOX.y0)) * window.innerHeight, t)
      tr.pinch = tr.pinch ? tr.ratio < PINCH_OFF : tr.ratio < PINCH_ON
      tr.strength = clamp((0.95 - tr.ratio) / (0.95 - PINCH_ON))
    }
    gestures()
    drawCursors()
    if (state === 'on') {
      const n = tracks.length
      el.status.textContent = n === 0 ? 'ukáž ruku' : zoom ? 'priblíženie' : press?.dragging ? 'ťaháš' : n === 2 ? 'dve ruky' : 'ruka'
    }
  }

  function gestures() {
    const [a, b] = tracks
    if (!a) {
      release(false)
      zoom = null
      wait = false
      setHot(null)
      return
    }
    // Both hands pinched: the distance between them is the zoom.
    if (a.pinch && b?.pinch) {
      const d = Math.max(20, Math.hypot(a.sx - b.sx, a.sy - b.sy))
      if (!zoom) {
        release(false)
        zoom = { d }
      } else {
        const step = Math.log(d / zoom.d)
        if (Math.abs(step) > 0.004) {
          wheel((a.sx + b.sx) / 2, (a.sy + b.sy) / 2, -step * 950)
          zoom.d = d
        }
      }
      wait = true
      setHot(null)
      return
    }
    zoom = null
    // After a zoom the leading hand has to open once before it can click or drag again.
    if (wait) {
      if (!a.pinch) wait = false
      return
    }
    if (a.pinch && !press) {
      press = { x: a.sx, y: a.sy, px: a.sx, py: a.sy, t: performance.now(), target: document.elementFromPoint(a.sx, a.sy), dragging: false, ox: 0, oy: 0 }
    } else if (a.pinch && press) {
      if (!press.dragging) {
        const dx = a.sx - press.x
        const dy = a.sy - press.y
        const far = Math.hypot(dx, dy)
        if (far > DEAD) {
          // The drag starts where the pinch was aimed and carries on without a jump.
          press.dragging = true
          press.ox = (dx / far) * DEAD
          press.oy = (dy / far) * DEAD
          press.target = fire('pointerdown', press.x, press.y, press.target, 1)
        }
      }
      if (press.dragging) {
        press.px = a.sx - press.ox
        press.py = a.sy - press.oy
        fire('pointermove', press.px, press.py, press.target, 1)
      }
    } else if (!a.pinch && press) {
      release(true)
    }
    if (!press) {
      // Hovering: the page hears a moving mouse, and what can be clicked answers the cursor.
      const under = fire('pointermove', a.sx, a.sy, null)
      setHot(under?.closest?.(CLICKABLE) ?? null)
      a.hot = Boolean(hot) || (under?.tagName === 'CANVAS' && isHot(a.sx, a.sy))
    }
  }

  function drawCursors() {
    const [a, b] = tracks
    el.cur.forEach((c, i) => {
      const tr = i === 0 ? a : b
      if (!tr) {
        if (!c.hidden) c.hidden = true
        return
      }
      const held = i === 0 && press && !press.dragging
      const x = held ? press.x : i === 0 && press?.dragging ? press.px : tr.sx
      const y = held ? press.y : i === 0 && press?.dragging ? press.py : tr.sy
      c.hidden = false
      c.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`
      c.style.setProperty('--p', (tr.pinch ? 1 : tr.strength ?? 0).toFixed(3))
      c.classList.toggle('is-pinch', tr.pinch)
      c.classList.toggle('is-drag', i === 0 && Boolean(press?.dragging))
      c.classList.toggle('is-hot', i === 0 && !press && Boolean(tr.hot))
      c.classList.toggle('is-zoom', Boolean(zoom))
      c.classList.toggle('is-second', i === 1)
    })
    const linked = Boolean(zoom && a && b)
    el.link.classList.toggle('is-on', linked)
    if (linked) {
      el.line.setAttribute('x1', a.sx)
      el.line.setAttribute('y1', a.sy)
      el.line.setAttribute('x2', b.sx)
      el.line.setAttribute('y2', b.sy)
    }
  }

  /** The hands as the camera window shows them: bones, joints and the pinch between thumb and forefinger. */
  function drawView() {
    const w = el.canvas.clientWidth
    const h = el.canvas.clientHeight
    const pr = Math.min(2, window.devicePixelRatio || 1)
    if (el.canvas.width !== Math.round(w * pr)) {
      el.canvas.width = Math.round(w * pr)
      el.canvas.height = Math.round(h * pr)
    }
    g.setTransform(pr, 0, 0, pr, 0, 0)
    g.clearRect(0, 0, w, h)
    for (const tr of tracks) {
      if (!tr.lm) continue
      const pt = (i) => [(1 - tr.lm[i].x) * w, tr.lm[i].y * h]
      g.lineWidth = 1.4
      g.strokeStyle = 'rgba(127, 243, 255, 0.8)'
      g.beginPath()
      for (const [i, j] of BONES) {
        g.moveTo(...pt(i))
        g.lineTo(...pt(j))
      }
      g.stroke()
      g.fillStyle = '#eafbff'
      for (let i = 0; i < 21; i++) {
        const [x, y] = pt(i)
        g.beginPath()
        g.arc(x, y, i % 4 === 0 && i ? 2.6 : 1.7, 0, Math.PI * 2)
        g.fill()
      }
      g.strokeStyle = tr.pinch ? '#ffb25c' : 'rgba(255, 178, 92, 0.45)'
      g.lineWidth = tr.pinch ? 2.6 : 1.2
      g.beginPath()
      g.moveTo(...pt(4))
      g.lineTo(...pt(8))
      g.stroke()
    }
  }

  // ── the loop ──
  function tick() {
    raf = requestAnimationFrame(tick)
    if (state !== 'on' || document.hidden) return
    const v = el.video
    if (v.readyState < 2 || v.currentTime === lastVideoTime) return
    lastVideoTime = v.currentTime
    let res = null
    try {
      res = landmarker.detectForVideo(v, performance.now())
    } catch (err) {
      console.warn('[hands]', err)
      return
    }
    update(res?.landmarks ?? [], v.videoWidth / Math.max(1, v.videoHeight))
    drawView()
  }

  async function loadModel() {
    const vision = await import(VISION)
    const files = await vision.FilesetResolver.forVisionTasks(WASM)
    const make = (delegate) =>
      vision.HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      })
    try {
      return await make('GPU')
    } catch {
      return make('CPU')
    }
  }

  async function start() {
    if (state === 'on' || state === 'loading') return
    const mine = ++gen
    root.hidden = false
    restore()
    setState('loading', 'Zapínam kameru')
    try {
      if (testSrc) {
        el.video.src = testSrc
        el.video.loop = true
      } else {
        if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('Toto okno nevie použiť kameru.'), { name: 'NotSupportedError' })
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false })
        if (mine !== gen) return stream.getTracks().forEach((t) => t.stop())
        el.video.srcObject = stream
      }
      await el.video.play().catch(() => {})
      setState('loading', 'Pripravujem sledovanie rúk')
      landmarker ??= await loadModel()
      if (mine !== gen) return
      lastVideoTime = -1
      setState('on')
      el.status.textContent = 'ukáž ruku'
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(tick)
    } catch (err) {
      if (mine !== gen) return
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
      const none = err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError'
      halt()
      setState(denied ? 'blocked' : 'error', denied ? 'Kamera je zamietnutá. Povoľ ju pre Jarvisa v nastaveniach systému a skús to znova.' : none ? 'Nenašiel som žiadnu kameru.' : `Sledovanie rúk sa nespustilo. ${err?.message ?? ''}`.trim())
      el.status.textContent = ''
    }
  }

  /** Lets the camera go and takes every trace of the hands off the screen. The window stays if there is something to say. */
  function halt() {
    cancelAnimationFrame(raf)
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    el.video.pause()
    el.video.srcObject = null
    if (testSrc) el.video.removeAttribute('src')
    release(false)
    tracks = []
    zoom = null
    wait = false
    setHot(null)
    drawCursors()
    g.clearRect(0, 0, el.canvas.width, el.canvas.height)
  }

  function stop() {
    gen++
    halt()
    root.hidden = true
    setState('off')
  }

  window.addEventListener('pagehide', halt)

  return {
    start,
    stop,
    toggle: () => (state === 'on' || state === 'loading' ? stop() : start()),
    isOn: () => state === 'on',
    state: () => state,
    /** For checks without a camera: hands as landmark lists, as if the model had just seen them. */
    feed: (hands, aspect, now) => update(hands, aspect, now),
    tracks: () => tracks.map(({ sx, sy, pinch, ratio }) => ({ sx, sy, pinch, ratio })),
  }
}
