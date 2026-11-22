// Jadro Jarvisa ako celý 3D svet za obrazovkou: galaxia z v1 v strede, hviezdna
// obloha s hmlovinami, holografická podlaha v diaľke, objemové svetlo jadra,
// dátové prúdy, uzly pamäte ako holografické objekty a sklené rybky medzi nimi.
// Kamera je režisér.
//
// Verejné API (kompatibilné s v1):
//   const core = await createCore(canvas, { quality, capture, ringText, nodes, bloom, bloomRadius, bloomThreshold, debug })
//   core.layout(w, h, dpr, zone)      zone = voľná plocha medzi panelmi v CSS px {left, right, top, bottom}
//   core.frame(T, f)                  jedna snímka, všetko je funkcia T a f (deterministické v capture)
//   core.project()                    [{ id, x, y, r, side, alpha, visible, scale, focus, depth }] v CSS px, x/y = stred uzla
//   core.pick(x, y)                   id uzla pod kurzorom (CSS px) alebo null
//   core.setPointer(x, y)             parallax a hover (CSS px), null = myš mimo okna
//   core.drag(dx, dy), core.zoom(d)   ručné ovládanie, po 3,5 s nečinnosti návrat na autopilota
//   core.info()                       { focus, focusK, phase, hover, dpr, fps }
//   core.inner.enter(node, color)     ponor kamery cez atmosféru planéty do jej vnútorného sveta
//   core.inner.setData(data)          položky vnútra { items, groups, layout, color } (pred aj po ponore)
//   core.inner.exit()                 späť: z vnútra von k planéte a kamera sa vráti domov
//   core.inner.state()                { phase: off|diving|in|leaving|out, node, open 0..1 }
//   core.inner.pick/item/highlight/labels/flyTo/look/push/keys   ovládanie vnútra (world/inner.js)
//   Kým je vnútro otvorené, drag/zoom/setPointer idú do vnútra a pick() vracia null.
//
// Nové polia rámca f (všetky voliteľné, bez nich je svet v pokoji):
//   f.voiceState  'idle' | 'wake' | 'listening' | 'transcribing' | 'thinking' | 'speaking'
//   f.voice       0..1 hlasitosť Jarvisa (TTS), f.listen 0..1 hlasitosť mikrofónu
//   f.focus       { node, since } | null   since je v tej istej časovej osi ako T
//   f.toolNodes   { [node]: since } alebo [node, ...]   uzly, na ktorých Jarvis práve pracuje
//   f.film        režim natáčania (svet neukazuje nič súkromné, len ho prijíma)

import * as THREE from 'three'
import { createDirector } from './world/director.js'
import { createEnvironment } from './world/env.js'
import { createFish } from './world/fish.js'
import { createFlows } from './world/flows.js'
import { R, createHeart } from './world/heart.js'
import { createInner } from './world/inner.js'
import { DEPTH_SPREAD, createNodes } from './world/nodes.js'
import { createPost } from './world/post.js'
import { createSpace } from './world/space.js'
import { Ramp, clamp, follow, rng } from './world/util.js'

const FOV = 34
const TAN = Math.tan(THREE.MathUtils.degToRad(FOV / 2))
const FLOOR_Y = -9.5
/** Polomer objektu uzla v CSS px pri domácej kamere (v hĺbke 0). */
const NODE_PX = 48
/** Odhad výšky HTML štítka uzla (názov, hodnota, podnadpis) na voľbu strany. */
const LABEL_PX = 70

const num = (x, d = 0) => (Number.isFinite(x) ? x : d)

function toolSet(t) {
  const out = new Set()
  if (!t) return out
  if (Array.isArray(t)) for (const id of t) out.add(id)
  else if (t instanceof Set) for (const id of t) out.add(id)
  else for (const [id, v] of Object.entries(t)) if (v !== false && v !== null && v !== undefined) out.add(id)
  return out
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{quality?: 'high'|'low', capture?: boolean, ringText?: string, nodes?: {id: string, u: number, v: number, z: number, side?: string}[],
 *          bloom?: number, bloomRadius?: number, bloomThreshold?: number, debug?: boolean, dprCap?: number, cameraEl?: number,
 *          today?: Date|string}} opts
 */
export async function createCore(canvas, opts = {}) {
  const high = opts.quality !== 'low'
  const capture = !!opts.capture
  try {
    await document.fonts.load('500 40px "JetBrains Mono"')
  } catch {
    // písmo nie je kritické, text po kruhu sa vykreslí náhradným
  }

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: capture,
  })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setClearColor(0x000000, 1)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 1400)

  const U = {
    uTime: { value: 0 },
    uPR: { value: 1 },
    uScale: { value: 40 },
    uBoot: { value: 1 },
    uVoice: { value: 0 },
    uPulse: { value: 0 },
    uListen: { value: 0 },
    uThink: { value: 0 },
    uThinkPhase: { value: 0 },
    uSpeak: { value: 0 },
    uFloorY: { value: FLOOR_Y },
    uFogNear: { value: 32 },
    uFogFar: { value: 170 },
  }

  const env = createEnvironment(renderer, U, { high })
  scene.add(env.mesh)
  const space = createSpace(U, { high, rand: rng(911), floorY: FLOOR_Y })
  scene.add(space.root)
  const heart = createHeart(U, { high, rand: rng(20261107), ringText: opts.ringText ?? 'J.A.R.V.I.S.  ·  PAMÄŤ  ·' })
  scene.add(heart.root)
  // Kalendár uzla ukazuje skutočný mesiac. Dátum sa určí raz pri štarte (alebo z opts.today), nie v renderi.
  const today = opts.today ? new Date(opts.today) : new Date()
  const flows = createFlows(U, { high, rand: rng(77) })
  const nodes = createNodes(U, { high, rand: rng(4242), nodes: opts.nodes ?? [], today, onFree: (index) => flows.setOn(index, 0) })
  scene.add(nodes.root)
  scene.add(flows.points, ...flows.curves)
  /** Where each orb sits right now (u, v, z, size ease toward the values of its definition). */
  for (const n of nodes.items) n.cur = { u: num(n.u), v: num(n.v), z: num(n.z), size: num(n.size, 1) }
  const fish = createFish(U, { high, rand: rng(1306) })
  scene.add(fish.mesh)

  const post = createPost(renderer, scene, camera, {
    strength: opts.bloom ?? (high ? 0.9 : 0.65),
    radius: opts.bloomRadius ?? 0.32,
    threshold: opts.bloomThreshold ?? 0.38,
  })
  const director = createDirector(camera)
  const inner = createInner(renderer, U)

  // HUD beží celý deň: po strate GPU kontextu (spánok, reset ovládača) three.js nahrá
  // geometrie a textúry znova sám, predpočítanú oblohu treba vyrenderovať znova.
  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault())
  canvas.addEventListener('webglcontextrestored', () => env.rebake())

  const ramps = {
    think: new Ramp(0.8, 1.3),
    speak: new Ramp(0.35, 1.1),
    listen: new Ramp(0.3, 0.9),
  }

  // ── rozloženie ──
  let view = { w: 1, h: 1, dpr: 1, zone: null, cx: 0, cy: 0, zw: 1, zh: 1, pxPerUnit: 100, dist: 12 }
  let ready = false
  let ratio = 1
  let ratioCap = opts.dprCap ?? (capture ? 2 : high ? 2 : 1.25)
  const tmp = new THREE.Vector3()
  const tmp2 = new THREE.Vector3()
  const homeEl = opts.cameraEl ?? -0.035

  function applySize() {
    ratio = Math.min(view.dpr, ratioCap)
    renderer.setPixelRatio(ratio)
    renderer.setSize(view.w, view.h, false)
    post.setSize(view.w, view.h, ratio, view.zone)
    inner.setSize(view.w, view.h, view.zone)
    U.uPR.value = ratio
  }

  function layout(w, h, dpr, zone) {
    if (!(w > 2 && h > 2) || !zone || zone.right - zone.left < 10 || zone.bottom - zone.top < 10) return false
    const zw = zone.right - zone.left
    const zh = zone.bottom - zone.top
    const cx = (zone.left + zone.right) / 2
    const cy = (zone.top + zone.bottom) / 2
    const radiusPx = Math.max(60, Math.min(zh * 0.43, zw * 0.36))
    const pxPerUnit = radiusPx / R.layout
    const dist = h / 2 / (pxPerUnit * TAN)
    // Orbs grow and shrink with the free zone (about 640 × 620 px on a 14" MacBook, where they were drawn).
    // At a fixed size a narrower zone packed them on top of each other.
    const nodePx = NODE_PX * Math.min(1.1, Math.max(0.6, Math.min(zw / 640, zh / 620)))
    view = { w, h, dpr, zone, cx, cy, zw, zh, pxPerUnit, dist, nodePx }
    applySize()

    camera.aspect = w / h
    camera.setViewOffset(w, h, w / 2 - cx, h / 2 - cy, w, h)
    camera.updateProjectionMatrix()
    U.uScale.value = 24 * (pxPerUnit / 150) * (dist / 9.5)
    director.setHome(dist, homeEl)

    // Uzly: pozícia vo voľnej ploche z pevnej domácej kamery, hĺbka roztiahnutá pre paralaxu.
    camera.position.set(0, Math.sin(homeEl) * dist, Math.cos(homeEl) * dist)
    camera.up.set(0, 1, 0)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()
    // The home camera is kept apart, so orbs can be placed any time, wherever the live camera happens to fly.
    homeCam.copy(camera)
    homeCam.updateMatrixWorld()
    homeCam.updateProjectionMatrix()
    for (const n of nodes.items) place(n)
    fish.layout(nodes.items)
    ready = true
    return true
  }

  const homeCam = new THREE.PerspectiveCamera(FOV, 1, 0.05, 1400)

  /** Puts one orb where its current u, v, z and size say (free zone coordinates seen from the home camera). */
  function place(n) {
    const { w, h, zone, cx, cy, zw, zh, pxPerUnit } = view
    if (!zone) return
    const cur = (n.cur ??= { u: num(n.u), v: num(n.v), z: num(n.z), size: num(n.size, 1) })
    const sx = cx + cur.u * (zw / 2)
    const sy = cy - cur.v * (zh / 2)
    tmp.set((sx / w) * 2 - 1, -(sy / h) * 2 + 1, 0.5).unproject(homeCam)
    const dir = tmp.sub(homeCam.position).normalize()
    const zPlane = cur.z * DEPTH_SPREAD
    const t = (zPlane - homeCam.position.z) / dir.z
    n.pos.copy(homeCam.position).addScaledVector(dir, t)
    // Veľkosť planéty podľa významu (hlavné väčšie, mesiace menšie).
    n.scale = ((view.nodePx ?? NODE_PX) / pxPerUnit) * cur.size
    n.holder.position.copy(n.pos)
    n.holder.scale.setScalar(n.scale)
    // Spojnica: krivka od uzla k okraju jadra, mierne do boku.
    const toCore = n.pos.clone().normalize()
    const c = toCore.clone().multiplyScalar(R.shell * 0.75)
    const side = new THREE.Vector3(-toCore.y, toCore.x, 0).multiplyScalar((n.index % 2 ? 1 : -1) * n.pos.length() * 0.16)
    const b = n.pos.clone().add(c).multiplyScalar(0.5).add(side)
    flows.setLink(n.index, n.pos, b, c)
    const focusPx = clamp(0.36 * Math.min(zh, zw * 1.1), 150, 380)
    const focusDist = h / 2 / ((focusPx / (n.scale * 1.05)) * TAN)
    director.setFocusPose(n.id, n.pos, focusDist)
    // Strana štítka: ak by sa štítok (~70 px) nad uzlom nezmestil do zóny, ide pod uzol a naopak.
    tmp.copy(n.pos).project(homeCam)
    const py = ((1 - tmp.y) / 2) * h
    const pr = n.scale * 1.08 * (h / 2 / (TAN * Math.max(0.1, homeCam.position.distanceTo(n.pos))))
    const want = n.side === 'below' ? 'below' : 'above'
    // A full ring shows compact labels (name and number), so less room is enough.
    const labelPx = nodes.items.length > 9 ? LABEL_PX * 0.62 : LABEL_PX
    n.autoSide = n.side === 'left' || n.side === 'right' ? n.side : want === 'above' && py - pr - labelPx < zone.top ? 'below' : want === 'below' && py + pr + labelPx > zone.bottom ? 'above' : want
  }

  // ── živá sada orbov ──
  const MOVE_S = 1.25
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)
  let moving = false

  /**
   * The orbs the world should show from now on. New ones grow in, missing ones fade away and the
   * rest glide to their new places, all while the world keeps running.
   * defs: [{ id, shape?, color?, u, v, z, size, side }]
   */
  function setNodes(defs) {
    const T = lastT ?? 0
    const want = new Map((defs ?? []).map((d) => [d.id, d]))
    for (const n of nodes.items) if (!want.has(n.id) && !n.gone) nodes.remove(n.id)
    for (const d of want.values()) {
      const old = nodes.items.find((x) => x.id === d.id)
      const target = { u: num(d.u), v: num(d.v), z: num(d.z), size: num(d.size, 1) }
      if (!old || old.gone) {
        const n = nodes.add(d)
        if (!n) continue
        n.cur = { ...target }
        Object.assign(n, target, { side: d.side })
        n.move = null
        if (ready) place(n)
        continue
      }
      old.side = d.side
      const c = old.cur
      if (Math.abs(c.u - target.u) + Math.abs(c.v - target.v) + Math.abs(c.z - target.z) + Math.abs(c.size - target.size) < 1e-4) continue
      Object.assign(old, target)
      old.move = { from: { ...c }, t0: T }
      moving = true
    }
    if (ready) fish.layout(nodes.items)
  }

  function stepMoves(T) {
    let any = false
    for (const n of nodes.items) {
      if (!n.move) continue
      const k = ease(clamp((T - n.move.t0) / MOVE_S))
      const a = n.move.from
      n.cur = { u: a.u + (n.u - a.u) * k, v: a.v + (n.v - a.v) * k, z: a.z + (n.z - a.z) * k, size: a.size + (n.size - a.size) * k }
      place(n)
      if (k >= 1) n.move = null
      else any = true
    }
    if (!any) {
      moving = false
      fish.layout(nodes.items)
    }
  }

  // ── výkon: v živom behu sa pri pomalých snímkach zníži rozlíšenie (nikdy v capture) ──
  const perf = { last: 0, acc: 0, n: 0, fps: 0, warm: 0 }
  function trackPerf() {
    if (capture) return
    const now = performance.now()
    const dt = now - perf.last
    perf.last = now
    if (!(dt > 0) || dt > 120) return
    perf.warm += dt
    perf.acc += dt
    perf.n++
    if (perf.n < 90) return
    const avg = perf.acc / perf.n
    perf.fps = 1000 / avg
    perf.acc = 0
    perf.n = 0
    // Pod ~51 fps najprv na DPR 1,5 (rozdiel na Retine skoro nevidno), pri ťažkom zaseknutí 1,25.
    if (opts.dprCap || perf.warm < 3000 || view.dpr <= 1) return
    const cur = Math.min(ratioCap, view.dpr)
    const next = avg > 26 && cur <= 1.5 ? 1.25 : avg > 19.5 && cur > 1.5 ? 1.5 : cur
    if (next < cur) {
      ratioCap = next
      applySize()
    }
  }

  let hoverId = null
  let lastT = null
  let listenSm = 0
  const focusWeights = {}
  let dirInfo = { node: null, k: 0, phase: 'home' }

  /**
   * Jedna snímka. f: { voice, pulse, boot, ignite, igniteT, shockT, wave, flares, cue,
   *                    voiceState, listen, focus, toolNodes, film, working }
   */
  function frame(T, f = {}) {
    if (!ready) return
    trackPerf()
    const dt = lastT === null || T < lastT ? 0 : T - lastT
    lastT = T
    const voice = clamp(num(f.voice))
    const pulse = clamp(num(f.pulse))
    const boot = clamp(num(f.boot, 1))
    const vs = f.voiceState ?? (f.cue ? 'speaking' : 'idle')
    const think = ramps.think.set(T, vs === 'thinking' ? 1 : vs === 'transcribing' ? 0.55 : f.working ? 0.3 : 0).value(T)
    const speak = ramps.speak.set(T, vs === 'speaking' ? 1 : 0).value(T)
    const listenEnv = ramps.listen.set(T, vs === 'listening' ? 1 : vs === 'wake' ? 0.55 : vs === 'transcribing' ? 0.3 : 0).value(T)
    // Hlasitosť mikrofónu: rýchly nábeh, pomalší dozvuk (len živý vstup, v capture je to funkcia rámcov).
    listenSm = dt > 0 ? follow(listenSm, clamp(num(f.listen)), dt, num(f.listen) > listenSm ? 0.04 : 0.16) : clamp(num(f.listen))
    const listen = listenSm

    U.uTime.value = T
    U.uVoice.value = voice
    U.uPulse.value = pulse
    U.uBoot.value = boot
    U.uThink.value = think
    U.uThinkPhase.value = ramps.think.integral(T)
    U.uSpeak.value = speak
    U.uListen.value = listenEnv * (0.35 + 0.65 * listen)

    // Ponor do planéty: kamera letí k uzlu až do atmosféry, svetlo zaplaví obraz a za ním je vnútro.
    const inside = stepInner(T)
    if (inside) {
      inner.update(T)
      post.render()
      return
    }
    const focus = inn.node && inn.phase !== 'off' ? { node: inn.node, since: inn.since, hold: Infinity, wide: inn.phase === 'out' ? 1 : DIVE_WIDE } : f.focus ?? null
    dirInfo = director.update(T, inn.phase === 'out' ? f.focus ?? null : focus, (id) => nodes.items.some((n) => n.id === id))
    for (const key of Object.keys(focusWeights)) delete focusWeights[key]
    if (dirInfo.node) focusWeights[dirInfo.node] = dirInfo.k

    const tools = toolSet(f.toolNodes)
    const flares = f.flares ?? {}
    if (moving) stepMoves(T)
    nodes.update({ T, boot, flares, tools, focusWeights, hover: capture ? null : hoverId })
    let toolSum = 0
    for (const n of nodes.items) {
      flows.setOn(n.index, n.vis)
      const fl = flares[n.id]
      flows.update(n.index, { flare: clamp(num(fl?.f), 0, 1.4), phase: num(fl?.phase, T * 0.075), tool: n.state.tool, boot })
      toolSum += n.state.tool
    }

    heart.update({
      T,
      voice,
      pulse: clamp(pulse + 0.12 * Math.min(1, toolSum)),
      boot,
      ignite: num(f.ignite),
      igniteT: num(f.igniteT, -1),
      shockT: num(f.shockT, -1),
      wave: f.wave ?? null,
      listen,
      listenEnv,
      think,
      thinkPhase: U.uThinkPhase.value,
      speak,
      spin: 0.6 * ramps.speak.integral(T),
    })
    space.update({ T, boot })
    fish.update({ T })
    env.update(camera)
    post.render()
  }

  // ── projekcia, výber, ovládanie ──
  const proj = []
  /** x, y = stred objektu uzla (CSS px), r = jeho polomer na obrazovke, štítok si UI odsadí o r. */
  function project() {
    proj.length = 0
    const homePx = view.pxPerUnit
    const hidden = inn.phase === 'in' || inn.phase === 'leaving'
    for (const n of nodes.items) {
      if (!ready || hidden) {
        proj.push({ id: n.id, x: -9999, y: -9999, cx: -9999, cy: -9999, r: 0, side: n.autoSide ?? n.side ?? 'above', alpha: 0, visible: false, scale: 1, focus: 0, depth: 0 })
        continue
      }
      tmp.copy(n.pos).project(camera)
      const x = ((tmp.x + 1) / 2) * view.w
      const y = ((1 - tmp.y) / 2) * view.h
      tmp2.copy(n.pos).applyMatrix4(camera.matrixWorldInverse)
      const depth = -tmp2.z
      const pxAt = depth > 0.01 ? view.h / 2 / (TAN * depth) : 0
      const r = n.scale * 1.08 * pxAt
      const visible = n.vis > 0.5 && depth > 0.05 && x > -r && x < view.w + r && y > -r && y < view.h + r
      // Štítok mizne, keď objekt odíde z obrazovky (napríklad pri prelete k inému uzlu).
      const edge = Math.min(x, view.w - x, y, view.h - y)
      const alpha = visible ? clamp((edge + r * 0.2) / 60) : 0
      proj.push({ id: n.id, x, y, cx: x, cy: y, r, side: n.autoSide ?? n.side ?? 'above', alpha, visible, scale: homePx > 0 ? pxAt / homePx : 1, focus: focusWeights[n.id] ?? 0, depth })
    }
    return proj
  }

  function pick(x, y) {
    if (!ready || inn.phase !== 'off') return null
    const list = project()
    let best = null
    let bestDepth = Infinity
    for (const p of list) {
      if (!p.visible) continue
      const d = Math.hypot(x - p.cx, y - p.cy)
      if (d <= Math.max(p.r * 1.15, 24) && p.depth < bestDepth) {
        best = p.id
        bestDepth = p.depth
      }
    }
    return best
  }

  function setPointer(x, y) {
    if (x === null || x === undefined || !ready) {
      director.setPointer(0, 0)
      hoverId = null
      return
    }
    if (inn.phase === 'in') {
      inner.highlight(inner.pick(x, y), 'hover')
      hoverId = null
      return
    }
    director.setPointer((x - view.cx) / (view.w / 2), -(y - view.cy) / (view.h / 2))
    hoverId = pick(x, y)
  }

  function drag(dx, dy) {
    if (inn.phase === 'in') return inner.look(num(dx), num(dy))
    // Počas ponoru a návratu kamera patrí prechodu.
    if (inn.phase !== 'off') return
    director.drag(-num(dx) * 0.0028, num(dy) * 0.0022)
  }

  /** Koliesko a pinch: vo vnútri let dopredu a dozadu, vonku zoom autopilota. */
  function zoom(delta) {
    if (inn.phase === 'in') return inner.push(clamp(-num(delta) * 0.35, -40, 40))
    if (inn.phase !== 'off') return
    director.zoom(clamp(num(delta) * 0.0012, -0.25, 0.25))
  }

  function info() {
    return { focus: dirInfo.node, focusK: dirInfo.k, phase: dirInfo.phase, hover: hoverId, dpr: ratio, fps: perf.fps, inner: inn.phase }
  }

  if (opts.debug) window.__hudDebug = { scene, renderer, camera, post, env, space, heart, nodes, flows, fish, director, U }

  // ── vnútro planéty ──
  const DIVE_WIDE = 0.16
  const DIVE_SWAP = 1.75 // s od začiatku ponoru, keď je obraz celý v svetle
  const LEAVE_SWAP = 0.45
  const inn = { phase: 'off', node: null, since: null, t0: null, color: '#9fe8ff', data: null, built: false }
  const innState = { phase: 'off', node: null, open: 0 }
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a))
    return t * t * (3 - 2 * t)
  }

  /** Posunie fázy ponoru. Vracia true, keď sa má renderovať vnútro. */
  function stepInner(T) {
    if (inn.phase === 'off') {
      post.setFlash(0)
      innState.open = 0
      return false
    }
    if (inn.since === null) inn.since = T
    if (inn.t0 === null) inn.t0 = T
    const d = T - inn.t0
    if (inn.phase === 'diving') {
      post.setFlash(smooth(DIVE_SWAP - 0.6, DIVE_SWAP, d), inn.color)
      if (d >= DIVE_SWAP) {
        inn.phase = 'in'
        inn.t0 = T
        if (inn.data && !inn.built) buildInner()
        else if (inn.built) inner.startPose(true)
        post.setView(inner.scene, inner.camera, true)
        return true
      }
      return false
    }
    if (inn.phase === 'in') {
      post.setFlash(1 - smooth(0, 0.8, d), inn.color)
      inner.uOpen.value = smooth(0.1, 1.0, d)
      innState.open = inner.uOpen.value
      return true
    }
    if (inn.phase === 'leaving') {
      post.setFlash(smooth(0, LEAVE_SWAP, d), inn.color)
      inner.uOpen.value = 1 - smooth(0, LEAVE_SWAP, d)
      if (d >= LEAVE_SWAP) {
        inn.phase = 'out'
        inn.t0 = T
        post.setView(null, null, false)
        inner.clear()
        inn.built = false
        inn.data = null
        return false
      }
      return true
    }
    // out: svetlo zhasne, kamera od planéty odletí domov (director, focus null).
    post.setFlash(1 - smooth(0, 0.7, d), inn.color)
    innState.open = 0
    if (d > 0.7) {
      inn.phase = 'off'
      inn.node = null
    }
    return false
  }

  function buildInner() {
    inner.build(inn.data)
    inner.startPose(true)
    inn.built = true
  }

  const innerApi = {
    /** Ponor do uzla. color = farba atmosféry (svetlo pri prechode). */
    enter(node, color) {
      if (!nodes.items.some((n) => n.id === node && !n.gone)) return false
      if ((inn.phase === 'in' || inn.phase === 'diving') && inn.node === node) return true
      if (inn.phase === 'in' || inn.phase === 'leaving') {
        post.setView(null, null, false)
        inner.clear()
      }
      Object.assign(inn, { phase: 'diving', node, since: null, t0: null, color: color ?? '#9fe8ff', data: null, built: false })
      inner.uOpen.value = 0
      return true
    },
    setData(data) {
      if (inn.phase === 'off' || inn.phase === 'out' || inn.phase === 'leaving') return
      inn.data = data
      if (data?.color) inn.color = data.color
      if (inn.phase === 'in') buildInner()
    },
    exit() {
      if (inn.phase === 'diving') {
        inn.phase = 'out'
        inn.t0 = null
      } else if (inn.phase === 'in') {
        inn.phase = 'leaving'
        inn.t0 = null
      }
    },
    state() {
      innState.phase = inn.phase
      innState.node = inn.node
      return innState
    },
    active: () => inn.phase === 'in' || inn.phase === 'leaving',
    pick: (x, y) => (inn.phase === 'in' ? inner.pick(x, y) : -1),
    item: inner.item,
    highlight: inner.highlight,
    labels: (max) => (inn.phase === 'in' ? inner.labels(max) : []),
    rowLabels: (max) => (inn.phase === 'in' ? inner.rowLabels(max) : []),
    groupLabels: () => (inn.phase === 'in' ? inner.groupLabels() : []),
    flyToGroup: inner.flyToGroup,
    flyHome: inner.flyHome,
    setMarks: inner.setMarks,
    setDim: inner.setDim,
    projectPoint: inner.projectPoint,
    groups: () => (inn.phase === 'in' ? inner.groups() : []),
    sway: inner.sway,
    /** The free zone between the panes in CSS px, as the world was last laid out. */
    zone: () => view.zone,
    screenOf: inner.screenOf,
    flyTo: inner.flyTo,
    look: inner.look,
    push: inner.push,
    keys: inner.keys,
    world: inner.world,
  }

  return { layout, frame, project, pick, setPointer, drag, zoom, info, setNodes, inner: innerApi }
}
