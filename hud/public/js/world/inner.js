// Vnútorný svet planéty: všetky položky uzla ako hviezdokopa v priestore. Dôležité sú
// bližšie pri strede a väčšie, zvyšok sa rozplýva do diaľky. Položky s obrázkom sú
// holografické karty (portréty okrúhle), ostatné žiariace body. Prepojenia sú vlákna svetla.
//
// Výkon: jeden Points prechod (žiara všetkých položiek) a jeden instancovaný prechod
// kariet s obrázkom z atlasu (malé náhľady 64 px, blízke položky dostanú 256 px do druhého
// atlasu). Obrázky sa do atlasu kopírujú na GPU (copyTextureToTexture), nič sa neprekresľuje celé.
// Krajina tela (Fyzický stav) je instancovaný stĺpcový graf dní.

import * as THREE from 'three'

const SMALL = 64
const NEAR = 256
const ATLAS = 2048
const SMALL_COLS = ATLAS / SMALL // 32 → 1024 malých náhľadov
const NEAR_COLS = ATLAS / NEAR // 8 → 64 veľkých
const PALETTE = ['#7ff3ff', '#ffb25c', '#b49aff', '#8cff8c', '#ff8ab8', '#ffd59a', '#5fb8ff', '#ff7a6e', '#c8f0ff', '#9affc8', '#ffa0f0', '#f0ff8a']

const hash = (s) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
const rnd = (seed) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))

const GLOW_VERT = /* glsl */ `
uniform float uPR; uniform float uProj; uniform float uTime; uniform float uOpen; uniform float uCardGlow;
attribute vec3 aColor; attribute vec4 aInfo; // x: veľkosť, y: význam, z: má obrázok, w: zvýraznenie
varying vec3 vColor; varying float vAlpha; varying float vCore;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(0.1, -mv.z);
  float px = aInfo.x * uProj / dist;
  // Karta s obrázkom: zblízka žiara len okolo nej, zďaleka jej miesto drží bod.
  float card = aInfo.z * smoothstep(9.0, 18.0, px);
  float size = mix(max(px * 0.9, 2.2 + 3.5 * aInfo.y), px * 1.9, card);
  // aInfo.w: 1 zvýraznená (vybraná, označená), 0.6 pod kurzorom, 0 bežná, záporná = stlmená (mimo hľadania).
  float hot = max(aInfo.w, 0.0);
  float dim = step(aInfo.w, -0.5);
  gl_PointSize = min(size * uPR, 220.0 * uPR) * (1.0 + hot * 0.8);
  float fog = exp(-pow(dist / 520.0, 2.0));
  float tw = 0.85 + 0.15 * sin(uTime * (0.7 + aInfo.y) + position.x);
  vColor = aColor * (0.35 + 0.9 * aInfo.y + hot * 1.2);
  vAlpha = mix(1.0, uCardGlow, card) * fog * tw * uOpen * mix(1.0, 0.12, dim);
  vCore = card;
}`

const GLOW_FRAG = /* glsl */ `
varying vec3 vColor; varying float vAlpha; varying float vCore;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  float a = exp(-d * mix(5.0, 2.6, vCore));
  // Pri karte s obrázkom len svätožiara okolo nej, samotná fotka ostane čistá.
  a *= mix(1.0, smoothstep(0.5, 0.62, sqrt(d)), vCore);
  if (a * vAlpha < 0.004) discard;
  gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
}`

const CARD_VERT = /* glsl */ `
uniform float uProj; uniform float uOpen; uniform float uGhost;
attribute vec3 aPos; attribute vec4 aInfo; attribute vec4 aTile; attribute vec3 aColor; attribute float aRound;
varying vec2 vUv; varying vec4 vTile; varying vec3 vColor; varying float vRound; varying float vFade; varying float vHot;
void main(){
  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
  float dist = max(0.1, -mv.z);
  float px = aInfo.x * uProj / dist;
  float show = aInfo.z * step(9.0, px) * step(0.0, aTile.x);
  float hot = max(aInfo.w, 0.0);
  // Stlmené položky takmer zhasnú, v atlase (uGhost) sú nevybrané o niečo tmavšie než vybrané.
  vFade = smoothstep(9.0, 18.0, px) * exp(-pow(dist / 520.0, 2.0)) * uOpen * mix(1.0, 0.14, step(aInfo.w, -0.5)) * mix(1.0 - 0.42 * uGhost, 1.0, min(1.0, hot * 1.7));
  mv.xy += position.xy * aInfo.x * (1.0 + hot * 0.12) * show;
  gl_Position = show > 0.5 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
  vUv = position.xy + 0.5;
  vTile = aTile;
  vColor = aColor;
  vRound = aRound;
  vHot = hot;
}`

const CARD_FRAG = /* glsl */ `
uniform sampler2D uSmall; uniform sampler2D uNear;
varying vec2 vUv; varying vec4 vTile; varying vec3 vColor; varying float vRound; varying float vFade; varying float vHot;
float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main(){
  vec2 p = vUv - 0.5;
  float d = vRound > 0.5 ? length(p) - 0.5 : sdRound(p, vec2(0.5), 0.1);
  if (d > 0.0) discard;
  vec2 uv = vTile.xy + vUv * vTile.zw;
  vec3 img = vTile.x >= 10.0 ? texture2D(uNear, uv - vec2(10.0, 0.0)).rgb : texture2D(uSmall, uv).rgb;
  float edge = smoothstep(-0.045, -0.008, d);
  // Hologram: jemné riadky, svietiaci okraj vo farbe skupiny.
  float scan = 0.94 + 0.06 * sin(vUv.y * 180.0);
  vec3 c = img * scan * (0.82 + 0.2 * vHot) + vColor * edge * (0.7 + vHot * 1.4);
  gl_FragColor = vec4(c * vFade, 1.0);
}`

const LINK_VERT = /* glsl */ `
attribute float aHot;
varying float vHot; varying float vFog;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vHot = aHot;
  vFog = exp(-pow(-mv.z / 420.0, 2.0));
}`

const LINK_FRAG = /* glsl */ `
uniform vec3 uColor; uniform vec3 uHotColor; uniform float uOpen;
varying float vHot; varying float vFog;
void main(){
  gl_FragColor = vec4(mix(uColor * 0.035, uHotColor * 0.9, vHot) * vFog * uOpen, 1.0);
}`

const additive = { blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {{ uTime: {value:number}, uPR: {value:number} }} U
 */
export function createInner(renderer, U) {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#020507')
  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 3000)
  const uProj = { value: 800 }
  const uOpen = { value: 0 }

  // Hviezdne pozadie vnútorného sveta (vzdialená guľa, farba podľa planéty).
  const bgN = 2400
  const bgPos = new Float32Array(bgN * 3)
  const bgCol = new Float32Array(bgN * 3)
  const bgInfo = new Float32Array(bgN * 4)
  const r0 = rnd(77)
  for (let i = 0; i < bgN; i++) {
    const z = r0() * 2 - 1
    const t = r0() * Math.PI * 2
    const rr = Math.sqrt(1 - z * z)
    const R = 900 + r0() * 400
    bgPos.set([Math.cos(t) * rr * R, z * R, Math.sin(t) * rr * R], i * 3)
    const b = 0.15 + Math.pow(r0(), 3) * 0.6
    bgCol.set([b, b, b], i * 3)
    bgInfo.set([1.6 + r0() * 2.5, 0.2, 0, 0], i * 4)
  }
  const bgGeo = new THREE.BufferGeometry()
  bgGeo.setAttribute('position', new THREE.BufferAttribute(bgPos, 3))
  bgGeo.setAttribute('aColor', new THREE.BufferAttribute(bgCol, 3))
  bgGeo.setAttribute('aInfo', new THREE.BufferAttribute(bgInfo, 4))
  const bgUniforms = { uPR: U.uPR, uProj: { value: 900 }, uTime: U.uTime, uOpen, uCardGlow: { value: 0 } }
  const bg = new THREE.Points(bgGeo, new THREE.ShaderMaterial({ uniforms: bgUniforms, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, ...additive }))
  bg.frustumCulled = false
  scene.add(bg)

  // Atlasy náhľadov: prázdne textúry na GPU, obrázky sa do nich kopírujú po bunkách.
  const makeAtlas = () => {
    const t = new THREE.DataTexture(new Uint8Array(ATLAS * ATLAS * 4), ATLAS, ATLAS)
    t.colorSpace = THREE.SRGBColorSpace
    t.minFilter = THREE.LinearFilter
    t.magFilter = THREE.LinearFilter
    t.generateMipmaps = false
    t.needsUpdate = true
    return t
  }
  const smallAtlas = makeAtlas()
  const nearAtlas = makeAtlas()

  let yearCenters = []
  let landAnchors = []
  let world = null // { items, pos: Float32Array, glow, cards, links, bars, center, radius }
  const root = new THREE.Group()
  scene.add(root)

  // ── rozloženie ──
  /**
   * One orderly constellation: concentric rings that face the camera, evenly spaced. The most
   * important item sits in the middle, the next ones on the first ring and so on outward; within
   * a ring the items of one group stay next to each other. Every ring lies a little deeper than
   * the one before it, so the whole thing is a shallow bowl and still reads as space when turned.
   */
  function layoutCluster(items, groups) {
    const keys = [...new Set([...groups.map((g) => g.key), ...items.map((i) => i.g)])]
    const order = items.map((it, i) => i).sort((a, b) => (items[b].imp ?? 0) - (items[a].imp ?? 0) || String(items[a].t).localeCompare(String(items[b].t)))
    const STEP = 12.5 // distance between rings and between neighbours on a ring
    const pos = new Array(items.length)
    let at = 0
    for (let ring = 0; at < order.length; ring++) {
      const cap = ring === 0 ? 1 : Math.floor((2 * Math.PI * ring * STEP) / STEP)
      const slice = order.slice(at, at + cap)
      at += slice.length
      // One group next to the other around the ring, each group keeping the order of importance.
      slice.sort((a, b) => keys.indexOf(items[a].g) - keys.indexOf(items[b].g) || (items[b].imp ?? 0) - (items[a].imp ?? 0))
      const r = ring * STEP
      // A ring that is not full is still spread over the whole circle; odd rings start half a step on.
      const turn = (ring % 2 ? Math.PI / Math.max(1, slice.length) : 0) - Math.PI / 2
      slice.forEach((i, k) => {
        const a = turn + (k / slice.length) * Math.PI * 2
        pos[i] = new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r * 0.78, -ring * 3.2)
      })
    }
    return pos
  }

  /**
   * Časová os: každý rok je vlastná galaxia (disk fotiek otočený ku kamere, mesiace od stredu
   * von), roky idú za sebou do hĺbky po jemnej špirále. Najnovší rok je najbližšie.
   */
  function layoutYears(items) {
    const years = [...new Set(items.map((i) => Math.floor(i.y ?? 0)))].sort((a, b) => b - a)
    const golden = Math.PI * (3 - Math.sqrt(5))
    const centers = new Map()
    const byYear = new Map(years.map((y) => [y, []]))
    items.forEach((it, i) => byYear.get(Math.floor(it.y ?? 0)).push(i))
    let z = 0
    years.forEach((y, k) => {
      const n = byYear.get(y).length
      const R = 5 + Math.sqrt(n) * 1.9
      if (k) z -= R + 26
      centers.set(y, { c: new THREE.Vector3(Math.sin(k * 0.85) * 18, Math.cos(k * 0.6) * 7 - 3, z), R })
      z -= R
    })
    const pos = new Array(items.length)
    for (const [y, list] of byYear) {
      const { c, R } = centers.get(y)
      // Mesiace od stredu von, v rámci mesiaca podľa id (stabilne).
      list.sort((a, b) => (items[a].y ?? 0) - (items[b].y ?? 0) || hash(items[a].id) - hash(items[b].id))
      list.forEach((i, k) => {
        const r = R * Math.sqrt((k + 0.5) / list.length)
        const a = k * golden
        const j = rnd(hash(items[i].id))
        // Dôležitejšie položky vystúpia o kúsok ku kamere.
        pos[i] = new THREE.Vector3(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r * 0.82, c.z + (j() - 0.5) * 3 + (items[i].imp ?? 0) * 6)
      })
    }
    yearCenters = years.map((y) => ({ key: String(y), ...centers.get(y) }))
    return pos
  }

  /**
   * Atlas: every group is a tidy honeycomb of round cards, the groups stand in rows as one star
   * map facing the camera, slightly bowed and layered in depth. Made for things the user picks
   * from (Tvoje appky): everything is visible at once and nothing hides behind anything.
   * The rows are packed for the free zone of this very window, so the map is as big as it can be
   * on a tall zone and on a wide one. `fixed` items (the core) keep the position they bring in `p`,
   * a group with `slot: [w, h]` and no items keeps an empty cell of that size (the banner).
   */
  const HIVE = { size: 5.6, step: 6.9, gapX: 9, gapY: 4, label: 6.4 }
  function layoutAtlas(items, groups, insets) {
    const byGroup = new Map(groups.map((g) => [g.key, []]))
    items.forEach((it, i) => byGroup.get(it.g)?.push(i))
    // Every group as a box: its honeycomb cells (the most used apps first, in the middle) and its size.
    const boxes = groups
      .map((g) => {
        const list = byGroup.get(g.key)
        if (!list.length) return g.slot ? { key: g.key, slot: true, w: g.slot[0], h: g.slot[1], list, cells: [] } : null
        // A compact honeycomb: rows of a few discs, every other row shifted by half a step.
        // The most used apps (the order of the catalog) come first, on the top row.
        const n = list.length
        const cols = n <= 3 ? n : n <= 6 ? Math.ceil(Math.sqrt(n)) : Math.max(3, Math.round(Math.sqrt(n * 1.2)))
        const rows = Math.ceil(n / cols)
        const pts = list.map((_, k) => {
          const r = Math.floor(k / cols)
          const inRow = r === rows - 1 ? n - r * cols : cols
          const c = k - r * cols
          // A short last row sits in the middle; a full odd row is shifted to interlock with its neighbours.
          const shift = inRow < cols ? (cols - inRow) / 2 : r % 2 ? 0.5 : 0
          return [HIVE.step * (c + shift), -HIVE.step * 0.87 * r]
        })
        const xs = pts.map((p) => p[0])
        const ys = pts.map((p) => p[1])
        const mx = (Math.min(...xs) + Math.max(...xs)) / 2
        const my = (Math.min(...ys) + Math.max(...ys)) / 2
        return { key: g.key, list, cells: pts.map(([x, y]) => [x - mx, y - my]), w: Math.max(...xs) - Math.min(...xs) + HIVE.size, h: Math.max(...ys) - Math.min(...ys) + HIVE.size + HIVE.label }
      })
      .filter(Boolean)
    // Rows: for every possible number of rows the groups are cut into rows of even width, and the
    // cut that shows the map biggest in this zone wins.
    const zone = view.zone
    const zw = Math.max(200, (zone ? zone.right - zone.left : view.w) - 56)
    const zh = Math.max(120, (zone ? zone.bottom - zone.top : view.h) - (insets?.top ?? ATLAS_TOP) - (insets?.bottom ?? ATLAS_BOTTOM))
    const total = boxes.reduce((a, bx) => a + bx.w + HIVE.gapX, 0)
    let best = null
    for (let n = 1; n <= boxes.length; n++) {
      const rows = [[]]
      let w = 0
      for (const bx of boxes) {
        const row = rows.at(-1)
        // A row closes once it is as wide as an even share (and rows are still left to fill).
        if (row.length && rows.length < n && w + (bx.w + HIVE.gapX) / 2 > total / n) {
          rows.push([bx])
          w = bx.w + HIVE.gapX
        } else {
          row.push(bx)
          w += bx.w + HIVE.gapX
        }
      }
      const W = Math.max(...rows.map((r) => r.reduce((a, bx) => a + bx.w, 0) + HIVE.gapX * (r.length - 1)))
      const H = rows.reduce((a, r) => a + Math.max(...r.map((bx) => bx.h)), 0) + HIVE.gapY * (rows.length - 1)
      const scale = Math.min(zw / W, zh / H)
      if (!best || scale > best.scale) best = { rows, W, H, scale }
    }
    const pos = new Array(items.length)
    const bow = (x, y) => (x * x + y * y) / 1100
    yearCenters = []
    let y = best.H / 2
    best.rows.forEach((row, ri) => {
      const rh = Math.max(...row.map((bx) => bx.h))
      const rw = row.reduce((a, bx) => a + bx.w, 0) + HIVE.gapX * (row.length - 1)
      let x = -rw / 2
      row.forEach((bx, ci) => {
        const cx = x + bx.w / 2
        // Honeycombs hang from the top of their row, under their title.
        const cy = bx.slot ? y - rh / 2 : y - HIVE.label - (bx.h - HIVE.label) / 2
        const z = bow(cx, cy) + ((ci + ri) % 2 ? -4 : 3)
        bx.list.forEach((i, k) => {
          const j = rnd(hash(items[i].id))
          pos[i] = new THREE.Vector3(cx + bx.cells[k][0], cy + bx.cells[k][1], z + (j() - 0.5) * 2)
        })
        yearCenters.push({ key: bx.key, c: new THREE.Vector3(cx, cy, z + (bx.slot ? 3 : 0)), R: Math.max(bx.w, bx.h - HIVE.label) / 2, w: bx.w, h: bx.h, top: y - HIVE.label + 1.4, slot: bx.slot === true })
        x += bx.w + HIVE.gapX
      })
      y -= rh + HIVE.gapY
    })
    items.forEach((it, i) => {
      if (pos[i]) return
      // Fixed items sit relative to the map: p = [x in half-widths, y in half-heights, z].
      const p = it.p ?? [0, -1.12, 12]
      pos[i] = new THREE.Vector3((p[0] * best.W) / 2, (p[1] * best.H) / 2, p[2] ?? 0)
    })
    atlasBox = { w: best.W, h: best.H }
    return pos
  }
  /** Room the header takes above the map and the tray below it, in CSS px. */
  const ATLAS_TOP = 178
  const ATLAS_BOTTOM = 152
  let atlasBox = null

  /**
   * Board: every group is a column of rows facing the camera, like a tidy list. Made for things
   * that have an order (tasks by term, the calendar by day): the first item is on top, nothing
   * overlaps and every row keeps room for its name right of its dot. A long column continues
   * beside itself, and the columns wrap into bands so the board is as big as the free zone allows.
   */
  const BOARD = { col: 52, row: 7.2, head: 10, gapX: 7, gapY: 10, rows: 10, dot: 2.3 }
  let boardCol = BOARD.col
  function layoutBoard(items, groups, insets) {
    const byGroup = new Map(groups.map((g) => [g.key, []]))
    items.forEach((it, i) => {
      if (!byGroup.has(it.g)) byGroup.set(it.g, [])
      byGroup.get(it.g).push(i)
    })
    const cols = [...byGroup]
      .filter(([, list]) => list.length)
      .map(([key, list]) => {
        const sub = Math.ceil(list.length / BOARD.rows)
        return { key, list, w: sub * BOARD.col, h: BOARD.head + Math.min(list.length, BOARD.rows) * BOARD.row }
      })
    const pos = new Array(items.length)
    yearCenters = []
    if (!cols.length) {
      atlasBox = { w: BOARD.col * 2 + BOARD.gapX, h: BOARD.row * 8, content: 0 }
      return pos
    }
    const zone = view.zone
    const zw = Math.max(200, (zone ? zone.right - zone.left : view.w) - 56)
    const zh = Math.max(120, (zone ? zone.bottom - zone.top : view.h) - (insets?.top ?? ATLAS_TOP) - (insets?.bottom ?? ATLAS_BOTTOM))
    const total = cols.reduce((a, c) => a + c.w + BOARD.gapX, 0)
    let best = null
    for (let n = 1; n <= Math.min(3, cols.length); n++) {
      const bands = [[]]
      let w = 0
      for (const c of cols) {
        const band = bands.at(-1)
        if (band.length && bands.length < n && w + (c.w + BOARD.gapX) / 2 > total / n) {
          bands.push([c])
          w = c.w + BOARD.gapX
        } else {
          band.push(c)
          w += c.w + BOARD.gapX
        }
      }
      const W = Math.max(...bands.map((b) => b.reduce((a, c) => a + c.w, 0) + BOARD.gapX * (b.length - 1)))
      const H = bands.reduce((a, b) => a + Math.max(...b.map((c) => c.h)), 0) + BOARD.gapY * (bands.length - 1)
      const scale = Math.min(zw / W, zh / H)
      if (!best || scale > best.scale + 0.01) best = { bands, W, H, scale }
    }
    // When the height decides the size, the columns spread over the spare width: more room for names.
    const wide = Math.max(1, Math.min(1.9, zw / best.scale / Math.max(best.W, BOARD.col * 2 + BOARD.gapX)))
    boardCol = BOARD.col * wide
    let y = best.H / 2
    for (const band of best.bands) {
      const bh = Math.max(...band.map((c) => c.h))
      let x = (-best.W * wide) / 2
      for (const c of band) {
        c.w *= wide
        c.list.forEach((i, k) => {
          const sub = Math.floor(k / BOARD.rows)
          const r = k % BOARD.rows
          pos[i] = new THREE.Vector3(x + sub * boardCol + BOARD.dot, y - BOARD.head - r * BOARD.row - BOARD.row / 2, 0)
        })
        yearCenters.push({ key: c.key, c: new THREE.Vector3(x + c.w / 2, y - c.h / 2, 0), R: Math.max(c.w, c.h) / 2, head: new THREE.Vector3(x, y - BOARD.head * 0.42, 0) })
        x += c.w + BOARD.gapX * wide
      }
      y -= bh + BOARD.gapY
    }
    // A board of a few short columns is not blown up to fill the window: its rows keep a readable size.
    atlasBox = { w: Math.max(best.W, BOARD.col * 2 + BOARD.gapX) * wide, h: Math.max(best.H, BOARD.row * 8), content: best.H }
    return pos
  }

  // ── krajina tela ──
  const METRICS = [
    { key: 'sleep', label: 'Spánok', color: '#7fb8ff', norm: (v) => clamp((v ?? 0) / 600) },
    { key: 'hrv', label: 'HRV', color: '#7ff3ff', norm: (v) => clamp((v ?? 0) / 140) },
    { key: 'rhr', label: 'Tep v kľude', color: '#ff8a7a', norm: (v) => clamp(((v ?? 40) - 38) / 40) },
    { key: 'bb', label: 'Body battery', color: '#9affc8', norm: (v) => clamp((v ?? 0) / 100) },
    { key: 'steps', label: 'Kroky', color: '#ffb25c', norm: (v) => clamp((v ?? 0) / 20000) },
  ]
  function buildLandscape(items) {
    const days = items.filter((i) => i.k === 'day').sort((a, b) => a.day.localeCompare(b.day))
    const dayIndex = new Map(days.map((d, i) => [d.day, i]))
    const count = days.length * METRICS.length
    const geo = new THREE.BoxGeometry(1, 1, 1)
    geo.translate(0, 0.5, 0)
    // Pevné stĺpce (nie aditívne), inak sa rady za sebou zlejú do bieleho svetla.
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff })
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count))
    const m = new THREE.Matrix4()
    const col = new THREE.Color()
    const W = 0.55
    const x0 = -(days.length * W) / 2
    let k = 0
    METRICS.forEach((met, r) => {
      const base = new THREE.Color(met.color)
      days.forEach((d, i) => {
        const v = met.norm(d.m?.[met.key])
        const h = 0.2 + v * 12
        m.makeScale(W * 0.82, h, 3.2)
        m.setPosition(x0 + i * W, -20, -r * 9)
        mesh.setMatrixAt(k, m)
        col.copy(base).multiplyScalar(0.14 + 0.62 * v)
        mesh.setColorAt(k, col)
        k++
      })
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.frustumCulled = false
    const pos = items.map((it) => {
      const i = dayIndex.get(it.day) ?? 0
      if (it.k === 'day') return new THREE.Vector3(x0 + i * W, -20 + 0.2 + METRICS[0].norm(it.m?.sleep) * 12 + 1.5, 3.5)
      const r = rnd(hash(it.id))
      return new THREE.Vector3(x0 + i * W, 2 + (it.k === 'gym' ? 6 : 0) + r() * 4, -18 + (r() - 0.5) * 14)
    })
    // Popisky krajiny: rady metrík na pravom konci (dnes), roky na prednej hrane.
    landAnchors = METRICS.map((met, r) => ({ key: met.label, c: new THREE.Vector3(x0 + days.length * W + 4, -20 + 1, -r * 9), R: 0 }))
    days.forEach((d, i) => {
      if (d.day.endsWith('-01-01')) landAnchors.push({ key: d.day.slice(0, 4), c: new THREE.Vector3(x0 + i * W, -20 - 3, 5), R: 0 })
    })
    return { mesh, pos, width: days.length * W, end: new THREE.Vector3(x0 + days.length * W, -20, -18) }
  }

  // ── výstavba sveta ──
  const loader = { failed: new Map(), pending: null, smallFree: [], smallOf: new Map(), busy: 0, gen: 0, nearFree: [], nearOf: new Map() }

  function build(data) {
    clear()
    const items = data.items ?? []
    const groups = data.groups ?? []
    const groupIndex = new Map([...new Set([...groups.map((g) => g.key), ...items.map((i) => i.g)])].map((k, i) => [k, i]))
    let pos
    let landscape = null
    yearCenters = []
    landAnchors = []
    if (data.layout === 'landscape') {
      landscape = buildLandscape(items)
      pos = landscape.pos
      root.add(landscape.mesh)
    } else pos = data.layout === 'years' ? layoutYears(items) : data.layout === 'atlas' ? layoutAtlas(items, groups, data.insets) : data.layout === 'board' ? layoutBoard(items, groups, data.insets) : layoutCluster(items, groups)

    const n = items.length
    const P = new Float32Array(n * 3)
    const C = new Float32Array(n * 3)
    const I = new Float32Array(n * 4)
    const tile = new Float32Array(n * 4).fill(-1)
    const round = new Float32Array(n)
    const col = new THREE.Color()
    const accent = new THREE.Color(data.color ?? '#7ff3ff')
    items.forEach((it, i) => {
      const p = pos[i]
      P.set([p.x, p.y, p.z], i * 3)
      const imp = clamp(it.imp ?? 0.3)
      if (data.layout === 'landscape') col.set(it.k === 'day' ? '#7fb8ff' : it.k === 'gym' ? '#ffb25c' : '#ff8a7a')
      else if (groupIndex.size <= 1 || data.layout === 'atlas') col.copy(accent)
      else col.set(PALETTE[groupIndex.get(it.g) % PALETTE.length])
      C.set([col.r, col.g, col.b], i * 3)
      const size = data.layout === 'atlas' ? (it.size ?? HIVE.size) : data.layout === 'board' ? BOARD.dot * (0.8 + 0.5 * imp) : data.layout === 'landscape' ? (it.k === 'day' ? 0.35 : 1.6) : data.layout === 'years' ? (it.img ? 2.6 + 3 * imp : 0.9 + 2.5 * imp) : 0.9 + 6.5 * Math.pow(imp, 1.4)
      if (it.color) col.set(it.color)
      I.set([size, imp, it.img ? 1 : 0, 0], i * 4)
      round[i] = it.r ? 1 : 0
    })

    const gGeo = new THREE.BufferGeometry()
    gGeo.setAttribute('position', new THREE.BufferAttribute(P, 3))
    gGeo.setAttribute('aColor', new THREE.BufferAttribute(C, 3))
    gGeo.setAttribute('aInfo', new THREE.BufferAttribute(I, 4))
    const glow = new THREE.Points(gGeo, new THREE.ShaderMaterial({ uniforms: { uPR: U.uPR, uProj, uTime: U.uTime, uOpen, uCardGlow: { value: data.layout === 'years' ? 0.1 : 0.4 } }, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, ...additive }))
    glow.frustumCulled = false

    const quad = new THREE.PlaneGeometry(1, 1)
    const cGeo = new THREE.InstancedBufferGeometry()
    cGeo.index = quad.index
    cGeo.setAttribute('position', quad.attributes.position)
    const posAttr = new THREE.InstancedBufferAttribute(P, 3)
    const infoAttr = new THREE.InstancedBufferAttribute(I, 4)
    const tileAttr = new THREE.InstancedBufferAttribute(tile, 4)
    cGeo.setAttribute('aPos', posAttr)
    cGeo.setAttribute('aInfo', infoAttr)
    cGeo.setAttribute('aTile', tileAttr)
    cGeo.setAttribute('aColor', new THREE.InstancedBufferAttribute(C, 3))
    cGeo.setAttribute('aRound', new THREE.InstancedBufferAttribute(round, 1))
    cGeo.instanceCount = n
    const cards = new THREE.Mesh(
      cGeo,
      new THREE.ShaderMaterial({ uniforms: { uProj, uOpen, uGhost: { value: data.layout === 'atlas' ? 1 : 0 }, uSmall: { value: smallAtlas }, uNear: { value: nearAtlas } }, vertexShader: CARD_VERT, fragmentShader: CARD_FRAG, depthTest: true, depthWrite: true }),
    )
    cards.frustumCulled = false

    // Prepojenia: všetky slabo, prepojenia vybranej položky jasne.
    const idIndex = new Map(items.map((it, i) => [it.id, i]))
    const pairs = []
    items.forEach((it, i) => {
      for (const l of it.links ?? []) {
        const j = idIndex.get(l)
        if (j !== undefined && j !== i) pairs.push([i, j])
      }
    })
    const L = new Float32Array(pairs.length * 6)
    const hot = new Float32Array(pairs.length * 2)
    pairs.forEach(([i, j], k) => L.set([P[i * 3], P[i * 3 + 1], P[i * 3 + 2], P[j * 3], P[j * 3 + 1], P[j * 3 + 2]], k * 6))
    const lGeo = new THREE.BufferGeometry()
    lGeo.setAttribute('position', new THREE.BufferAttribute(L, 3))
    lGeo.setAttribute('aHot', new THREE.BufferAttribute(hot, 1))
    const links = new THREE.LineSegments(lGeo, new THREE.ShaderMaterial({ uniforms: { uColor: { value: accent.clone() }, uHotColor: { value: new THREE.Color('#ffb25c') }, uOpen }, vertexShader: LINK_VERT, fragmentShader: LINK_FRAG, ...additive }))
    links.frustumCulled = false

    root.add(links, glow, cards)
    const box = new THREE.Box3().setFromArray(P)
    const center = box.getCenter(new THREE.Vector3())
    // Polomer kopy: 85. percentil vzdialeností (pár odľahlých bodov nesmie odsunúť kameru).
    const ds = items.map((_, i) => Math.hypot(P[i * 3] - center.x, P[i * 3 + 1] - center.y, P[i * 3 + 2] - center.z)).sort((a, b) => a - b)
    const radius = Math.max(30, ds[Math.floor(ds.length * 0.85)] ?? 30)
    // Mierka pohybu: pri časovej osi podľa veľkosti jedného roka, nie celej osi.
    const scale = yearCenters.length ? Math.max(20, yearCenters.reduce((a, g) => a + g.R, 0) / yearCenters.length) * 2.2 : landscape ? landscape.width / 3 : radius
    const colorAttr = cards.geometry.attributes.aColor
    world = { data, items, P, I, C, C0: C.slice(), tile, round, glow, cards, links, pairs, hot, infoAttr, tileAttr, colorAttr, center, radius, scale: data.layout === 'atlas' || data.layout === 'board' ? 60 : scale, landscape, atlas: data.layout === 'atlas' || data.layout === 'board' ? atlasBox : null, board: data.layout === 'board', idIndex, sel: -1, hover: -1, marks: new Uint8Array(n), dim: null }
    bgUniforms.uProj.value = 900
    queueImages()
    return world
  }

  function clear() {
    loader.gen++
    loader.pending = null
    loader.failed.clear()
    loader.nearOf.clear()
    loader.nearFree = Array.from({ length: NEAR_COLS * NEAR_COLS }, (_, i) => i)
    for (const ch of [...root.children]) {
      root.remove(ch)
      ch.geometry?.dispose()
      ch.material?.dispose()
    }
    world = null
  }

  // ── obrázky do atlasu ──
  const cellCanvas = document.createElement('canvas')
  const cellCtx = cellCanvas.getContext('2d')
  const cellTex = new THREE.CanvasTexture(cellCanvas)
  cellTex.colorSpace = THREE.SRGBColorSpace
  cellTex.generateMipmaps = false
  // Bunku kreslíme už otočenú (DataTexture má počiatok vľavo dole), WebGL ju nesmie otočiť znova.
  cellTex.flipY = false
  cellTex.minFilter = THREE.LinearFilter
  const dst = new THREE.Vector2()

  // Malý atlas má 1024 buniek, položiek s obrázkom môže byť viac (tisíce fotiek): bunky sa
  // prideľujú najbližším položkám a pri lete sa vzdialené uvoľnia pre bližšie.
  const SMALL_SLOTS = SMALL_COLS * SMALL_COLS
  function queueImages() {
    loader.pending = []
    for (let i = 0; i < world.items.length; i++) if (world.items[i].img) loader.pending.push(i)
    loader.smallFree = Array.from({ length: SMALL_SLOTS }, (_, k) => SMALL_SLOTS - 1 - k)
    loader.smallOf = new Map()
    pump()
  }

  const dist2 = (i) => {
    const cp = camera.position
    const k = i * 3
    return (world.P[k] - cp.x) ** 2 + (world.P[k + 1] - cp.y) ** 2 + (world.P[k + 2] - cp.z) ** 2
  }
  // Význam priťahuje bližšie: dôležité položky dostanú obrázok skôr aj z diaľky.
  const want = (i) => dist2(i) / (1 + 3 * (world.items[i].imp ?? 0)) ** 2

  /** Uvoľní bunku najvzdialenejšej načítanej položky, ak je ďalej ako kandidát. */
  function evictFor(score) {
    let worst = -1
    let ws = score * 1.4
    for (const [i] of loader.smallOf) {
      if (loader.nearOf.has(i) || i === world.sel || i === world.hover) continue
      const w = want(i)
      if (w > ws) {
        ws = w
        worst = i
      }
    }
    if (worst < 0) return -1
    const slot = loader.smallOf.get(worst)
    loader.smallOf.delete(worst)
    world.tile[worst * 4] = -1
    world.tileAttr.needsUpdate = true
    loader.pending.push(worst)
    return slot
  }

  function pump() {
    if (!world || !loader.pending) return
    const gen = loader.gen
    while (loader.busy < 6 && loader.pending.length) {
      // Najbližšie ku kamere idú prvé, aby sa zaplnilo to, na čo sa človek práve pozerá.
      let bq = 0
      let bs = Infinity
      for (let q = 0; q < loader.pending.length; q++) {
        const sc = want(loader.pending[q])
        if (sc < bs) {
          bs = sc
          bq = q
        }
      }
      const slot = loader.smallFree.length ? loader.smallFree.pop() : evictFor(bs)
      if (slot < 0) break
      const i = loader.pending[bq]
      loader.pending[bq] = loader.pending[loader.pending.length - 1]
      loader.pending.pop()
      loader.smallOf.set(i, slot)
      loader.busy++
      loadImage(world.items[i].img)
        .then((img) => {
          if (gen !== loader.gen || !world || loader.smallOf.get(i) !== slot) return
          drawCell(img, SMALL, smallAtlas, slot % SMALL_COLS, Math.floor(slot / SMALL_COLS))
          // Riadky v atlase idú zdola (DataTexture), bunka má výšku 1/32.
          world.tile.set([(slot % SMALL_COLS) / SMALL_COLS, Math.floor(slot / SMALL_COLS) / SMALL_COLS, 1 / SMALL_COLS, 1 / SMALL_COLS], i * 4)
          world.tileAttr.needsUpdate = true
        })
        .catch(() => {
          if (gen !== loader.gen || !world) return
          if (loader.smallOf.get(i) === slot) {
            loader.smallOf.delete(i)
            loader.smallFree.push(slot)
          }
          // The server may be busy for a moment: one more try in a few seconds, then the dot stays.
          const tries = (loader.failed.get(i) ?? 0) + 1
          loader.failed.set(i, tries)
          if (tries < 2) return setTimeout(() => gen === loader.gen && world && loader.pending.push(i), 4000)
          world.I[i * 4 + 2] = 0
          world.infoAttr.needsUpdate = true
          world.glow.geometry.attributes.aInfo.needsUpdate = true
        })
        .finally(() => {
          loader.busy--
          if (gen === loader.gen) pump()
        })
    }
  }

  function loadImage(url) {
    return new Promise((ok, fail) => {
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => ok(img)
      img.onerror = fail
      img.src = url
    })
  }

  function drawCell(img, size, atlas, cx, cy) {
    cellCanvas.width = cellCanvas.height = size
    const s = Math.min(img.naturalWidth, img.naturalHeight)
    const sx = (img.naturalWidth - s) / 2
    const sy = (img.naturalHeight - s) / 2.4
    cellCtx.clearRect(0, 0, size, size)
    // Obrázok hore nohami: DataTexture má počiatok vľavo dole.
    cellCtx.save()
    cellCtx.translate(0, size)
    cellCtx.scale(1, -1)
    cellCtx.drawImage(img, sx, Math.max(0, sy), s, s, 0, 0, size, size)
    cellCtx.restore()
    cellTex.image = cellCanvas
    cellTex.needsUpdate = true
    dst.set(cx * size, cy * size)
    renderer.copyTextureToTexture(cellTex, atlas, null, dst)
  }

  /** Blízke položky dostanú väčší náhľad (LOD), vzdialené ho uvoľnia. */
  let lodAt = 0
  function updateLod(now) {
    if (!world || now - lodAt < 0.6) return
    lodAt = now
    pump()
    const camPos = camera.position
    const near = []
    for (let i = 0; i < world.items.length; i++) {
      if (!world.items[i].img || world.tile[i * 4] < 0) continue
      const dx = world.P[i * 3] - camPos.x
      const dy = world.P[i * 3 + 1] - camPos.y
      const dz = world.P[i * 3 + 2] - camPos.z
      const px = (world.I[i * 4] * uProj.value) / Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (px > 70) near.push({ i, px })
    }
    near.sort((a, b) => b.px - a.px)
    const want = new Set(near.slice(0, NEAR_COLS * NEAR_COLS - 4).map((x) => x.i))
    for (const [i, slot] of loader.nearOf) {
      if (want.has(i)) continue
      loader.nearOf.delete(i)
      loader.nearFree.push(slot)
      const small = world.items[i].__small
      if (small) world.tile.set(small, i * 4)
    }
    const gen = loader.gen
    for (const i of want) {
      if (loader.nearOf.has(i) || !loader.nearFree.length) continue
      const slot = loader.nearFree.pop()
      loader.nearOf.set(i, slot)
      const src = world.items[i].img
      const url = src.replace(/w=\d+/, 'w=320')
      loadImage(url)
        .then((img) => {
          if (gen !== loader.gen || !world || loader.nearOf.get(i) !== slot) return
          drawCell(img, NEAR, nearAtlas, slot % NEAR_COLS, Math.floor(slot / NEAR_COLS))
          world.items[i].__small = Array.from(world.tile.slice(i * 4, i * 4 + 4))
          world.tile.set([10 + (slot % NEAR_COLS) / NEAR_COLS, Math.floor(slot / NEAR_COLS) / NEAR_COLS, 1 / NEAR_COLS, 1 / NEAR_COLS], i * 4)
          world.tileAttr.needsUpdate = true
        })
        .catch(() => {})
    }
    world.tileAttr.needsUpdate = true
  }

  // ── pohyb: let so zotrvačnosťou ──
  const nav = { yaw: 0, pitch: 0, tYaw: 0, tPitch: 0, vel: new THREE.Vector3(), keys: new Set(), fly: null, sx: 0, sy: 0, swayX: 0, swayY: 0 }
  const fwd = new THREE.Vector3()
  const right = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)

  function startPose(intro = true) {
    if (!world) return
    const c = world.center.clone()
    const dist = world.landscape ? Math.max(60, world.landscape.width * 0.55) : world.radius * 1.3
    const start = new THREE.Vector3(c.x, c.y + dist * 0.18, c.z + dist)
    if (world.landscape) {
      // Krajina tela: pri dnešku, pohľad späť do minulosti (vľavo do hĺbky).
      const e = world.landscape.end
      start.set(e.x - 5, e.y + 92, e.z + 92)
      c.set(e.x - 115, e.y - 6, e.z)
    }
    if (yearCenters.length) {
      // Pred najnovším rokom, pohľad do hĺbky času.
      const y0 = yearCenters[0]
      const back = Math.max(40, y0.R * 2.3)
      start.set(y0.c.x + 6, y0.c.y + 4, y0.c.z + back)
      c.copy(y0.c).add(new THREE.Vector3(0, 0, -back * 0.6))
    }
    if (world.atlas) {
      // The whole wall fits the free zone, under the header and above the tray.
      const z = view.zone
      const zw = z ? z.right - z.left : view.w
      const zh = z ? z.bottom - z.top : view.h
      const top = world.data.insets?.top ?? ATLAS_TOP
      const bottom = world.data.insets?.bottom ?? ATLAS_BOTTOM
      const fitW = ((world.atlas.w / 2) * uProj.value) / Math.max(60, zw / 2 - 28)
      const fitH = ((world.atlas.h / 2) * uProj.value) / Math.max(60, (zh - top - bottom) / 2)
      const d = Math.max(fitW, fitH, 60)
      // The usable part of the zone sits a little lower than its middle: lift the camera's aim to match.
      let lift = (((top - bottom) / 2) * d) / uProj.value
      // A board hangs from the top of its zone like a page; a short one does not float in the middle.
      if (world.board) lift -= (Math.max(0, zh - top - bottom - (world.atlas.content * uProj.value) / d) / 2) * (d / uProj.value) * 0.9
      start.set(0, lift, d)
      c.set(0, lift, 0)
      world.home = { pos: start.clone(), dist: d }
    }
    const look = c.clone().sub(start).normalize()
    nav.tYaw = nav.yaw = Math.atan2(look.x, -look.z)
    nav.tPitch = nav.pitch = Math.asin(clamp(look.y, -1, 1))
    nav.vel.set(0, 0, 0)
    camera.position.copy(intro ? start.clone().addScaledVector(look, -dist * 1.8) : start)
    nav.fly = intro ? { from: camera.position.clone(), to: start, t0: null, dur: 1.6, yaw: nav.yaw, pitch: nav.pitch } : null
  }

  function look(dx, dy) {
    // A board is a page, not a space: it stays where it was fitted, whatever the mouse or a hand does.
    if (world?.board) return
    nav.tYaw += dx * 0.0032
    nav.tPitch = clamp(nav.tPitch - dy * 0.0026, -1.45, 1.45)
    nav.fly = null
  }

  function speedScale() {
    return world ? Math.max(0.3, world.scale / 90) : 1
  }

  function push(amount) {
    if (world?.board) return
    camera.getWorldDirection(fwd)
    nav.vel.addScaledVector(fwd, amount * speedScale())
    nav.fly = null
  }

  function flyTo(i) {
    if (!world || i < 0 || world.board) return
    const target = new THREE.Vector3(world.P[i * 3], world.P[i * 3 + 1], world.P[i * 3 + 2])
    const size = world.I[i * 4]
    const dir = target.clone().sub(camera.position).normalize()
    const to = target.clone().addScaledVector(dir, -Math.max(6, size * 5))
    nav.vel.set(0, 0, 0)
    nav.fly = { from: camera.position.clone(), to, t0: null, dur: 1.2, yaw: Math.atan2(dir.x, -dir.z), pitch: Math.asin(clamp(dir.y, -1, 1)), yaw0: nav.yaw, pitch0: nav.pitch }
  }

  let lastT = null
  function update(T) {
    const dt = lastT === null ? 0.016 : clamp(T - lastT, 0, 0.1)
    lastT = T
    if (nav.fly) {
      if (nav.fly.t0 === null) nav.fly.t0 = T
      const k = easeInOut(clamp((T - nav.fly.t0) / nav.fly.dur))
      camera.position.lerpVectors(nav.fly.from, nav.fly.to, k)
      if (nav.fly.yaw0 !== undefined) {
        let d = nav.fly.yaw - nav.fly.yaw0
        d = Math.atan2(Math.sin(d), Math.cos(d))
        nav.tYaw = nav.yaw = nav.fly.yaw0 + d * k
        nav.tPitch = nav.pitch = nav.fly.pitch0 + (nav.fly.pitch - nav.fly.pitch0) * k
      }
      if (k >= 1) nav.fly = null
    } else {
      // Klávesy: W/S dopredu a dozadu, A/D do strán, Q/E dole a hore. (Tabuľa sa nehýbe.)
      if (world?.board) nav.keys.clear()
      camera.getWorldDirection(fwd)
      right.crossVectors(fwd, up).normalize()
      const acc = 70 * speedScale() * dt
      const k = nav.keys
      if (k.has('KeyW') || k.has('ArrowUp')) nav.vel.addScaledVector(fwd, acc)
      if (k.has('KeyS') || k.has('ArrowDown')) nav.vel.addScaledVector(fwd, -acc)
      if (k.has('KeyA') || k.has('ArrowLeft')) nav.vel.addScaledVector(right, -acc)
      if (k.has('KeyD') || k.has('ArrowRight')) nav.vel.addScaledVector(right, acc)
      if (k.has('KeyE')) nav.vel.addScaledVector(up, acc)
      if (k.has('KeyQ')) nav.vel.addScaledVector(up, -acc)
      camera.position.addScaledVector(nav.vel, dt)
      nav.vel.multiplyScalar(Math.exp(-dt * 2.6))
      nav.yaw += (nav.tYaw - nav.yaw) * (1 - Math.exp(-dt * 9))
      nav.pitch += (nav.tPitch - nav.pitch) * (1 - Math.exp(-dt * 9))
    }
    // Sway: the camera leans a little after the pointer, so the layers of the world slide over each other.
    nav.sx += ((nav.swayX ?? 0) - nav.sx) * (1 - Math.exp(-dt * 4))
    nav.sy += ((nav.swayY ?? 0) - nav.sy) * (1 - Math.exp(-dt * 4))
    const yaw = nav.yaw + nav.sx
    const pitch = clamp(nav.pitch + nav.sy, -1.5, 1.5)
    const cp = Math.cos(pitch)
    fwd.set(Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp)
    camera.up.set(0, 1, 0)
    camera.lookAt(camera.position.clone().add(fwd))
    camera.updateMatrixWorld()
    updateLod(T)
  }

  // ── výber ──
  const v = new THREE.Vector3()
  let view = { w: 1, h: 1, zone: null }
  function setSize(w, h, zone) {
    const was = view.zone
    view = { w, h, zone }
    camera.aspect = w / h
    // Stred vnútra je stred voľnej plochy medzi panelmi, ako v hlavnom svete.
    if (zone) camera.setViewOffset(w, h, w / 2 - (zone.left + zone.right) / 2, h / 2 - (zone.top + zone.bottom) / 2, w, h)
    camera.updateProjectionMatrix()
    uProj.value = h / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
    // A board is laid out for the free zone it was given. When the zone changes (a pane folds, the
    // window is resized, the zone only became known after the data), it is laid out and fitted again.
    const moved = (a, b) => !a !== !b || (a && b && (Math.abs(a.left - b.left) > 2 || Math.abs(a.right - b.right) > 2 || Math.abs(a.top - b.top) > 2 || Math.abs(a.bottom - b.bottom) > 2))
    if (world?.board && moved(was, zone)) {
      build(world.data)
      startPose(false)
    }
  }

  /** Projekcia položky i do CSS px (alebo null mimo záberu). */
  function screenOf(i) {
    v.set(world.P[i * 3], world.P[i * 3 + 1], world.P[i * 3 + 2]).applyMatrix4(camera.matrixWorldInverse)
    const depth = -v.z
    if (depth < 0.5) return null
    v.applyMatrix4(camera.projectionMatrix)
    const x = ((v.x + 1) / 2) * view.w
    const y = ((1 - v.y) / 2) * view.h
    if (x < -50 || x > view.w + 50 || y < -50 || y > view.h + 50) return null
    return { x, y, depth, r: Math.max(3, (world.I[i * 4] * uProj.value) / depth / 2) }
  }

  function pick(x, y) {
    if (!world) return -1
    let best = -1
    let bestScore = Infinity
    for (let i = 0; i < world.items.length; i++) {
      const s = screenOf(i)
      if (!s) continue
      const d = Math.hypot(s.x - x, s.y - y)
      if (d > Math.max(10, s.r * 1.1)) continue
      const score = s.depth + d * 0.5
      if (score < bestScore) {
        bestScore = score
        best = i
      }
    }
    return best
  }

  function highlight(i, kind) {
    if (!world) return
    const prev = kind === 'sel' ? world.sel : world.hover
    if (prev === i) return
    if (kind === 'sel') world.sel = i
    else world.hover = i
    paint()
  }

  /** Writes the look of every item from the selection, the hover, the marks and the search. */
  function paint() {
    const w = world
    for (let k = 0; k < w.items.length; k++) {
      const marked = w.marks[k] === 1
      const dim = w.dim && !w.dim[k]
      w.I[k * 4 + 3] = k === w.sel ? 1 : marked ? (k === w.hover ? 1.3 : 1) : k === w.hover ? 0.6 : dim ? -1 : 0
    }
    w.infoAttr.needsUpdate = true
    w.glow.geometry.attributes.aInfo.needsUpdate = true
    const focus = w.sel >= 0 ? w.sel : w.hover
    w.pairs.forEach(([a, b], k) => {
      const h = a === focus || b === focus ? 1 : w.marks[a] && w.marks[b] ? 0.85 : 0
      w.hot[k * 2] = w.hot[k * 2 + 1] = h
    })
    w.links.geometry.attributes.aHot.needsUpdate = true
  }

  const MARK = new THREE.Color('#ffb25c')
  /** Marks items as chosen (a Set of indices): they glow amber and their links light up. */
  function setMarks(set) {
    if (!world) return
    for (let k = 0; k < world.items.length; k++) {
      const on = set.has(k) ? 1 : 0
      if (world.marks[k] === on) continue
      world.marks[k] = on
      if (world.items[k].fixed) continue
      const c = on ? [MARK.r, MARK.g, MARK.b] : world.C0.slice(k * 3, k * 3 + 3)
      world.C.set(c, k * 3)
    }
    world.colorAttr.needsUpdate = true
    world.glow.geometry.attributes.aColor.needsUpdate = true
    paint()
  }

  /** Dims everything outside the given Set of indices (search). null lights everything again. */
  function setDim(set) {
    if (!world) return
    world.dim = set ? Uint8Array.from(world.items, (_, k) => (set.has(k) ? 1 : 0)) : null
    paint()
  }

  /** A point of the inner world in CSS px: { x, y, depth, k } where k = px per world unit there. null behind the camera. */
  function projectPoint(p) {
    v.copy(p).applyMatrix4(camera.matrixWorldInverse)
    const depth = -v.z
    if (depth < 0.5) return null
    v.applyMatrix4(camera.projectionMatrix)
    return { x: ((v.x + 1) / 2) * view.w, y: ((1 - v.y) / 2) * view.h, depth, k: uProj.value / depth }
  }

  /** Back to the pose the world opened with (the whole atlas in view). */
  function flyHome() {
    if (!world?.home) return
    nav.vel.set(0, 0, 0)
    nav.fly = { from: camera.position.clone(), to: world.home.pos.clone(), t0: null, dur: 1.1, yaw: 0, pitch: 0, yaw0: nav.yaw, pitch0: nav.pitch }
  }

  /** Popisky rokov (galaxie časovej osi) v zábere. */
  function groupLabels() {
    const out = []
    for (const g of [...yearCenters, ...landAnchors]) {
      if (g.head) v.copy(g.head).applyMatrix4(camera.matrixWorldInverse)
      else v.copy(g.c).setY(g.c.y + g.R * 0.82 + 3).applyMatrix4(camera.matrixWorldInverse)
      const depth = -v.z
      if (depth < 2) continue
      v.applyMatrix4(camera.projectionMatrix)
      const x = ((v.x + 1) / 2) * view.w
      const y = ((1 - v.y) / 2) * view.h
      const z = view.zone
      if (z && (x < z.left + (g.head ? -4 : 40) || x > z.right - 40 || y < z.top + (g.head ? 60 : 150) || y > z.bottom - (g.head ? 10 : 60))) continue
      out.push({ key: g.key, x, y, depth, left: Boolean(g.head) })
    }
    out.sort((a, b) => a.depth - b.depth)
    const kept = []
    for (const o of out) if (kept.length < 12 && !kept.some((k) => Math.abs(k.x - o.x) < 90 && Math.abs(k.y - o.y) < (o.left ? 14 : 40))) kept.push(o)
    return kept
  }

  function flyToGroup(key) {
    const g = yearCenters.find((x) => x.key === key)
    if (!g || world?.board) return
    const to = g.c.clone().add(new THREE.Vector3(0, 0, world?.atlas ? Math.max(30, g.R * 3.3) : g.R * 2.1))
    const dir = g.c.clone().sub(to).normalize()
    nav.vel.set(0, 0, 0)
    nav.fly = { from: camera.position.clone(), to, t0: null, dur: 1.4, yaw: Math.atan2(dir.x, -dir.z), pitch: Math.asin(clamp(dir.y, -1, 1)), yaw0: nav.yaw, pitch0: nav.pitch }
  }

  /** Popisky: najvýznamnejšie blízke položky v zábere (pre DOM štítky). */
  function labels(max = 14) {
    if (!world) return []
    const out = []
    for (let i = 0; i < world.items.length; i++) {
      const imp = world.items[i].imp ?? 0
      if (imp < 0.25 && i !== world.sel && i !== world.hover) continue
      const s = screenOf(i)
      if (!s) continue
      // Popisky len vo voľnej ploche medzi panelmi a pod hlavičkou.
      const z = view.zone
      if (z && (s.x < z.left + 50 || s.x > z.right - 50 || s.y + s.r < z.top + 150 || s.y + s.r > z.bottom - 60)) continue
      out.push({ i, x: s.x, y: s.y, r: s.r, score: (imp + 0.2) * (s.r + 4) + (i === world.sel ? 1e6 : 0) + (i === world.hover ? 1e5 : 0) })
    }
    out.sort((a, b) => b.score - a.score)
    // Bez prekryvu: popisok sa vynechá, keď by padol na už umiestnený.
    const kept = []
    for (const o of out) {
      if (kept.length >= max) break
      const ly = o.y + o.r + 6
      if (kept.some((k) => Math.abs(k.ly - ly) < 18 && Math.abs(k.x - o.x) < 120)) continue
      o.ly = ly
      kept.push(o)
    }
    return kept.map((o) => ({ ...o, item: world.items[o.i] }))
  }

  /** Board rows: every item in view, with the place and the room for its name right of its dot. */
  function rowLabels(max = 72) {
    if (!world?.board) return []
    const out = []
    const z = view.zone
    for (let i = 0; i < world.items.length && out.length < max; i++) {
      const s = screenOf(i)
      if (!s) continue
      // Every row that is in the free zone keeps its name: a dot without a name says nothing.
      if (z && (s.x < z.left - 4 || s.x > z.right - 30 || s.y < z.top + 60 || s.y > z.bottom - 6)) continue
      out.push({ i, x: s.x + s.r + 9, y: s.y, r: s.r, w: (boardCol * uProj.value) / s.depth - s.r * 2 - 26, row: (BOARD.row * uProj.value) / s.depth, item: world.items[i] })
    }
    return out
  }

  return {
    scene,
    camera,
    uOpen,
    build,
    clear,
    startPose,
    update,
    setSize,
    look,
    push,
    flyTo,
    pick,
    highlight,
    labels,
    rowLabels,
    groupLabels,
    flyToGroup,
    flyHome,
    setMarks,
    setDim,
    projectPoint,
    groups: () => yearCenters,
    sway: (x, y) => ((nav.swayX = x), (nav.swayY = y)),
    screenOf,
    keys: nav.keys,
    item: (i) => world?.items[i] ?? null,
    world: () => world,
  }
}
