// Vesmír okolo jadra: hviezdna obloha s jasnými hviezdami, prach v hĺbke
// a dátové prúdy (oblúky častíc, ktoré pomaly tečú svetom).

import * as THREE from 'three'
import { FOG, HASH, SOFT_POINT_FRAG } from './glsl.js'
import { COLOR } from './heart.js'

const additive = { blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true }

// ── hviezdy ─────────────────────────────────────────────────────────────

const STAR_VERT = /* glsl */ `
uniform float uTime; uniform float uPR; uniform float uBoot;
attribute vec3 aColor; attribute vec2 aStar;
varying vec3 vColor; varying float vAlpha;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vec3 dir = normalize(position);
  float tw = 0.72 + 0.28 * sin(uTime * (0.4 + aStar.y * 2.2) + aStar.y * 61.0);
  gl_PointSize = aStar.x * uPR;
  vColor = aColor;
  vAlpha = tw * smoothstep(0.0, 0.07, dir.y) * (0.4 + 0.6 * uBoot);
}`

const STAR_FRAG = /* glsl */ `
varying vec3 vColor; varying float vAlpha;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  float a = exp(-d * 6.0);
  if (a * vAlpha < 0.004) discard;
  gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
}`

function starGeometry(count, rand) {
  const pos = new Float32Array(count * 3)
  const color = new Float32Array(count * 3)
  const star = new Float32Array(count * 2)
  const c = new THREE.Color()
  let i = 0
  while (i < count) {
    // Len pred kamerou a nad horizontom (kamera sa nikdy neotočí dozadu).
    const z = rand() * 2 - 1
    const t = rand() * Math.PI * 2
    const r = Math.sqrt(1 - z * z)
    const d = new THREE.Vector3(Math.cos(t) * r, z, Math.sin(t) * r)
    if (d.y < 0.005 || d.z > 0.5) continue
    // Hustejšie pri horizonte a v páse Mliečnej dráhy.
    const band = Math.exp(-Math.pow(d.dot(new THREE.Vector3(0.32, 0.88, 0.36).normalize()) / 0.22, 2))
    if (rand() > 0.35 + 0.65 * band + 0.3 * (1 - d.y)) continue
    pos.set([d.x * 480, d.y * 480, d.z * 480], i * 3)
    const roll = rand()
    if (roll < 0.07) c.copy(COLOR.amber).lerp(COLOR.white, 0.35)
    else if (roll < 0.5) c.copy(COLOR.white)
    else c.copy(COLOR.ice).lerp(COLOR.cyan, rand() * 0.6)
    const b = 0.08 + Math.pow(rand(), 3.2) * 0.9
    color.set([c.r * b, c.g * b, c.b * b], i * 3)
    star.set([1.1 + Math.pow(rand(), 6) * 3.4, rand()], i * 2)
    i++
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aColor', new THREE.BufferAttribute(color, 3))
  g.setAttribute('aStar', new THREE.BufferAttribute(star, 2))
  return g
}

function flareTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const ctx = canvas.getContext('2d')
  const s = 256
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.06, 'rgba(255,255,255,0.55)')
  g.addColorStop(0.2, 'rgba(255,255,255,0.08)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, s, s)
  // Difrakčné lúče: tenké a dlhé vodorovne, kratšie zvisle.
  ctx.globalCompositeOperation = 'lighter'
  for (const [w, h, a] of [[s, 3, 0.55], [3, s * 0.7, 0.4]]) {
    const lg = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, Math.max(w, h) / 2)
    lg.addColorStop(0, `rgba(255,255,255,${a})`)
    lg.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = lg
    ctx.fillRect(s / 2 - w / 2, s / 2 - h / 2, w, h)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

// ── prach ───────────────────────────────────────────────────────────────

const DUST_VERT = /* glsl */ `
uniform float uTime; uniform float uPR; uniform float uScale; uniform float uBoot;
${FOG}
attribute vec3 aColor; attribute float aSize;
varying vec3 vColor; varying float vAlpha;
void main(){
  vec3 p = position;
  p.x += sin(uTime * 0.05 + position.z * 0.2) * 0.6;
  p.y += sin(uTime * 0.07 + position.x * 0.3) * 0.4;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  gl_PointSize = min(aSize * uScale * uPR * 2.2 / max(dist, 0.5), 6.0 * uPR);
  vColor = aColor;
  vAlpha = (0.8 + 0.2 * sin(uTime * 0.4 + position.x)) * fogFade(dist) * smoothstep(1.5, 5.0, dist) * uBoot;
}`

function dustGeometry(count, rand, floorY) {
  const pos = new Float32Array(count * 3)
  const color = new Float32Array(count * 3)
  const size = new Float32Array(count)
  const c = new THREE.Color()
  let i = 0
  while (i < count) {
    const x = (rand() * 2 - 1) * 70
    const y = floorY + 0.6 + rand() * 30
    const z = 10 - rand() * 110
    // Nie cez galaxiu: tam by prach len špinil jadro.
    if (x * x + y * y + z * z < 30) continue
    pos.set([x, y, z], i * 3)
    c.copy(COLOR.azure).lerp(COLOR.cyan, rand())
    if (rand() < 0.05) c.copy(COLOR.amber)
    const dim = 0.1 + rand() * 0.28
    color.set([c.r * dim, c.g * dim, c.b * dim], i * 3)
    size[i] = 0.7 + Math.pow(rand(), 3) * 2.4
    i++
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aColor', new THREE.BufferAttribute(color, 3))
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
  return g
}

// ── dátové prúdy ────────────────────────────────────────────────────────
// Rieky dát: vlákna svetla, ktoré tečú z diaľky (od horizontu a z oblohy) do jadra.
// Orbitálny prstenec: plochá elipsa častíc okolo galaxie, viditeľná zadná polovica.

const RIVERS = 7
const RIVER_VERT = /* glsl */ `
uniform float uTime; uniform float uPR; uniform float uScale; uniform float uBoot; uniform float uVoice; uniform float uThink; uniform float uThinkPhase;
uniform vec3 uP0[${RIVERS}]; uniform vec3 uP1[${RIVERS}]; uniform vec3 uP2[${RIVERS}]; uniform vec2 uRate[${RIVERS}];
uniform vec3 uCold; uniform vec3 uWarm;
${FOG}
${HASH}
attribute float aRiver; attribute vec4 aR;
varying vec3 vColor; varying float vAlpha;
void main(){
  int i = int(aRiver + 0.5);
  float s = fract(aR.x + uTime * uRate[i].x + uThinkPhase * uRate[i].x * 2.5);
  vec3 a = mix(uP0[i], uP1[i], s);
  vec3 b = mix(uP1[i], uP2[i], s);
  vec3 p = mix(a, b, s);
  vec3 tng = normalize(b - a + 1e-5);
  vec3 n1 = normalize(cross(tng, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
  vec3 n2 = cross(tng, n1);
  float spread = mix(uRate[i].y, 0.05, s * s);
  float ang = aR.y * 6.2831 + s * 9.0;
  p += (n1 * cos(ang) + n2 * sin(ang)) * spread * aR.z;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  float lead = hash11(floor(aR.x * 37.0) + aRiver * 11.0);
  float warm = step(0.9, lead);
  gl_PointSize = min((1.0 + 2.2 * aR.w) * uScale * uPR * (1.6 + 1.6 * (1.0 - s)) / max(dist, 0.5), 7.0 * uPR);
  vColor = mix(uCold, uWarm, warm) * (0.7 + 1.1 * s * s) * (1.0 + 0.8 * uThink);
  float ends = smoothstep(0.0, 0.08, s) * smoothstep(1.0, 0.9, s);
  vAlpha = ends * fogFade(dist) * smoothstep(1.0, 4.0, dist) * (0.7 + 0.3 * uVoice) * uBoot;
}`

function riverGeometry(per, rand) {
  const count = per * RIVERS
  const river = new Float32Array(count)
  const r = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    river[i] = Math.floor(i / per)
    // Častice v balíkoch: balík letí spolu ako jeden kus dát.
    const packet = Math.floor(rand() * 22) / 22
    const spread = rand() < 0.75 ? (rand() - 0.5) * 0.01 : rand()
    r.set([(packet + spread + 1) % 1, rand(), Math.sqrt(rand()), Math.pow(rand(), 3)], i * 4)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  g.setAttribute('aRiver', new THREE.BufferAttribute(river, 1))
  g.setAttribute('aR', new THREE.BufferAttribute(r, 4))
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 300)
  return g
}

const RING_VERT = /* glsl */ `
uniform float uTime; uniform float uPR; uniform float uScale; uniform float uBoot; uniform float uVoice; uniform float uThinkPhase;
uniform mat3 uBasis; uniform float uRadius;
uniform vec3 uCold; uniform vec3 uWarm;
${HASH}
attribute vec4 aR;
varying vec3 vColor; varying float vAlpha;
void main(){
  float th = aR.x * 6.2831 + uTime * 0.018 + uThinkPhase * 0.08;
  float rad = uRadius + (aR.y - 0.5) * 0.22 + (aR.z - 0.5) * 0.05;
  vec3 p = uBasis * vec3(cos(th) * rad, (aR.z - 0.5) * 0.06, sin(th) * rad);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  gl_PointSize = min((0.7 + 1.4 * aR.w) * uScale * uPR / max(dist, 0.5), 6.0 * uPR);
  float warm = step(0.93, hash11(floor(aR.x * 90.0)));
  vColor = mix(uCold, uWarm, warm) * (0.5 + 0.7 * aR.w);
  float back = 1.0 - smoothstep(-1.0, 3.5, p.z);
  float dash = 0.35 + 0.65 * step(0.42, fract(aR.x * 90.0));
  vAlpha = back * dash * (0.75 + 0.25 * uVoice) * uBoot;
}`

const basis = (rx, ry, rz, order = 'XYZ') => new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, order)))

export function createSpace(U, { high, rand, floorY }) {
  const root = new THREE.Group()
  root.name = 'space'

  const stars = new THREE.Points(
    starGeometry(high ? 6500 : 2600, rand),
    new THREE.ShaderMaterial({ uniforms: { uTime: U.uTime, uPR: U.uPR, uBoot: U.uBoot }, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, ...additive }),
  )
  stars.frustumCulled = false
  root.add(stars)

  // Pár jasných hviezd s difrakčnými lúčmi, rozložených tak, aby neboli za panelmi.
  const flare = flareTexture()
  const bright = []
  for (const [lon, lat, size, warm] of [[-1.18, 0.21, 9, 0], [-2.05, 0.33, 7, 1], [-1.62, 0.44, 6, 0], [-0.86, 0.12, 5.5, 0], [-2.3, 0.11, 6.5, 0], [-1.42, 0.07, 4.5, 1], [-0.62, 0.38, 6, 0]]) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flare, color: (warm ? COLOR.amber : COLOR.ice).clone().multiplyScalar(0.55), transparent: true, opacity: 1, ...additive }))
    s.position.set(Math.cos(lat) * Math.cos(lon) * 470, Math.sin(lat) * 470, Math.cos(lat) * Math.sin(lon) * 470)
    s.scale.setScalar(size)
    root.add(s)
    bright.push(s)
  }

  const dustUniforms = { uTime: U.uTime, uPR: U.uPR, uScale: U.uScale, uBoot: U.uBoot, uFogNear: { value: 20 }, uFogFar: { value: 95 } }
  const dust = new THREE.Points(
    dustGeometry(high ? 2600 : 1000, rand, floorY),
    new THREE.ShaderMaterial({ uniforms: dustUniforms, vertexShader: DUST_VERT, fragmentShader: SOFT_POINT_FRAG, ...additive }),
  )
  dust.frustumCulled = false
  root.add(dust)

  // Rieky dát z diaľky do jadra: štart pri horizonte alebo vysoko na oblohe, koniec na okraji galaxie.
  const starts = [
    [-95, floorY + 0.5, -105, 0.0026, 1.6],
    [-150, 18, -150, 0.0019, 2.2],
    [-48, floorY + 0.5, -140, 0.0023, 1.4],
    [40, floorY + 0.5, -130, 0.0024, 1.4],
    [120, 26, -140, 0.0018, 2.4],
    [96, floorY + 0.5, -96, 0.0027, 1.6],
    [-40, 44, -170, 0.0016, 2.0],
  ]
  const riverUniforms = {
    uTime: U.uTime,
    uPR: U.uPR,
    uScale: U.uScale,
    uBoot: U.uBoot,
    uVoice: U.uVoice,
    uThink: U.uThink,
    uThinkPhase: U.uThinkPhase,
    uP0: { value: [] },
    uP1: { value: [] },
    uP2: { value: [] },
    uRate: { value: [] },
    uCold: { value: COLOR.cyan.clone().lerp(COLOR.azure, 0.3).multiplyScalar(0.6) },
    uWarm: { value: COLOR.amber.clone().multiplyScalar(0.75) },
    uFogNear: { value: 30 },
    uFogFar: { value: 210 },
  }
  for (const [x, y, z, rate, spread] of starts) {
    const p0 = new THREE.Vector3(x, y, z)
    const dir = p0.clone().normalize()
    const p2 = dir.clone().multiplyScalar(3.4).add(new THREE.Vector3(0, -0.2, 0))
    const p1 = p0.clone().multiplyScalar(0.42).add(new THREE.Vector3(0, 10 + Math.abs(x) * 0.06, 0))
    riverUniforms.uP0.value.push(p0)
    riverUniforms.uP1.value.push(p1)
    riverUniforms.uP2.value.push(p2)
    riverUniforms.uRate.value.push(new THREE.Vector2(rate, spread))
  }
  const rivers = new THREE.Points(
    riverGeometry(high ? 420 : 160, rand),
    new THREE.ShaderMaterial({ uniforms: riverUniforms, vertexShader: RIVER_VERT, fragmentShader: SOFT_POINT_FRAG, ...additive }),
  )
  rivers.frustumCulled = false
  root.add(rivers)
  // Tenké vlákna pozdĺž riek: súvislá stopa, po ktorej tečú balíky.
  const threadPos = []
  const threadA = []
  for (let k = 0; k < starts.length; k++) {
    const p0 = riverUniforms.uP0.value[k]
    const p1 = riverUniforms.uP1.value[k]
    const p2 = riverUniforms.uP2.value[k]
    const at = (t) => p0.clone().lerp(p1, t).lerp(p1.clone().lerp(p2, t), t)
    const steps = 90
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps
      const t1 = (i + 1) / steps
      threadPos.push(...at(t0).toArray(), ...at(t1).toArray())
      const fade = (t) => Math.min(1, t / 0.15) * Math.min(1, (1 - t) / 0.12) * (0.35 + 0.65 * t)
      threadA.push(fade(t0), fade(t1))
    }
  }
  const threadGeo = new THREE.BufferGeometry()
  threadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(threadPos), 3))
  threadGeo.setAttribute('aA', new THREE.BufferAttribute(new Float32Array(threadA), 1))
  const threads = new THREE.LineSegments(
    threadGeo,
    new THREE.ShaderMaterial({
      uniforms: { uBoot: U.uBoot, uThink: U.uThink, uColor: { value: COLOR.cyan.clone().lerp(COLOR.azure, 0.4).multiplyScalar(0.16) }, uFogNear: { value: 30 }, uFogFar: { value: 210 } },
      vertexShader: `${FOG}
        attribute float aA; varying float vA;
        void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; vA = aA * fogFade(-mv.z); }`,
      fragmentShader: `uniform vec3 uColor; uniform float uBoot; uniform float uThink; varying float vA;
        void main(){ gl_FragColor = vec4(uColor * vA * uBoot * (1.0 + 0.8 * uThink), 1.0); }`,
      ...additive,
    }),
  )
  threads.frustumCulled = false
  root.add(threads)

  const ringN = high ? 2600 : 1000
  const ringR = new Float32Array(ringN * 4)
  for (let i = 0; i < ringN; i++) ringR.set([rand(), rand(), rand(), Math.pow(rand(), 3)], i * 4)
  const ringGeo = new THREE.BufferGeometry()
  ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ringN * 3), 3))
  ringGeo.setAttribute('aR', new THREE.BufferAttribute(ringR, 4))
  const ring = new THREE.Points(
    ringGeo,
    new THREE.ShaderMaterial({
      uniforms: {
        uTime: U.uTime, uPR: U.uPR, uScale: U.uScale, uBoot: U.uBoot, uVoice: U.uVoice, uThinkPhase: U.uThinkPhase,
        uBasis: { value: basis(0.2, 0, 0.09) }, uRadius: { value: 5.5 },
        uCold: { value: COLOR.cyan.clone().lerp(COLOR.azure, 0.45).multiplyScalar(0.5) },
        uWarm: { value: COLOR.amber.clone().multiplyScalar(0.6) },
      },
      vertexShader: RING_VERT,
      fragmentShader: SOFT_POINT_FRAG,
      ...additive,
    }),
  )
  ring.frustumCulled = false
  root.add(ring)

  function update(s) {
    for (let i = 0; i < bright.length; i++) bright[i].material.opacity = (0.75 + 0.25 * Math.sin(s.T * (0.3 + i * 0.13) + i * 2.1)) * (0.4 + 0.6 * s.boot)
  }

  return { root, update, objects: { stars, dust, rivers, ring, bright } }
}
