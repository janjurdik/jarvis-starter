// Uzly pamäte ako 3D holografické objekty. Každý je procedurálny (žiadne modely),
// v lokálnych jednotkách s polomerom ~1 a predkom otočeným k domácej kamere (+Z).
//   Správy    roj bublín          Fotky     stoh rámčekov
//   Udalosti  časová špirála      Spánok    mesiac s prstencom
//   Kalendár  mriežka dní         Rutiny    ozubené prstence
//   Projekty  kryštálová mriežka  Questy    kompas s gimbalom

import * as THREE from 'three'
import { FOG, SNOISE } from './glsl.js'
import { COLOR, glowTexture, ringTexture } from './heart.js'
import { ADDITIVE, circlePoints, holoLine, holoSurface, loopSegments, nodeUniforms, polySegments, segmentsGeometry } from './holo.js'
import { Ramp, clamp } from './util.js'

const TAU = Math.PI * 2

function instanced(base, count, attrs) {
  const g = new THREE.InstancedBufferGeometry()
  g.index = base.index
  for (const key of Object.keys(base.attributes)) g.setAttribute(key, base.attributes[key])
  for (const [name, [array, size]] of Object.entries(attrs)) g.setAttribute(name, new THREE.InstancedBufferAttribute(array, size))
  g.instanceCount = count
  return g
}

const nodeShader = (NU, extra, vertexShader, fragmentShader, side = THREE.DoubleSide) =>
  new THREE.ShaderMaterial({ uniforms: { ...NU, ...extra }, vertexShader, fragmentShader, side, ...ADDITIVE })

const COMMON_UNIFORMS = /* glsl */ `
uniform float uTime; uniform float uBoot; uniform vec3 uColor; uniform vec3 uHot; uniform float uHeat; uniform float uGain;
uniform float uScan; uniform float uScanAmt; uniform float uSeed; uniform float uPhase; uniform float uAct;
`

const lines = (NU, segments, opacity = 1, tint = 0) => {
  const l = new THREE.LineSegments(segmentsGeometry(segments), holoLine(NU, opacity, tint))
  l.frustumCulled = false
  return l
}

const points = (NU, count, vertexShader, attrs, extra = {}) => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  for (const [name, [array, size]] of Object.entries(attrs)) g.setAttribute(name, new THREE.BufferAttribute(array, size))
  const p = new THREE.Points(g, nodeShader(NU, extra, vertexShader, POINT_FRAG))
  p.frustumCulled = false
  return p
}

const POINT_FRAG = /* glsl */ `
uniform float uBoot; uniform float uGain;
varying vec3 vColor; varying float vAlpha;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float a = exp(-dot(c, c) * 18.0);
  if (a * vAlpha < 0.004) discard;
  gl_FragColor = vec4(vColor * a * vAlpha * uGain * uBoot, 1.0);
}`

// ── Správy: roj bublín ──────────────────────────────────────────────────

const BUBBLE_VERT = /* glsl */ `
${COMMON_UNIFORMS}
${FOG}
attribute vec4 aSeed; attribute float aSize; attribute float aKind;
varying vec2 vUv; varying float vA; varying float vKind; varying float vFog; varying float vSeed;
void main(){
  float r = mix(0.34, 1.0, aSeed.x) * (1.0 + 0.2 * uAct);
  float inc = (aSeed.y - 0.5) * 2.4;
  float node = aSeed.z * 6.2831;
  float th = aSeed.w * 6.2831 + uPhase * (0.22 + 0.5 * (1.0 - aSeed.x));
  vec3 p = vec3(cos(th) * r, 0.0, sin(th) * r);
  float ci = cos(inc), si = sin(inc);
  p = vec3(p.x, p.y * ci - p.z * si, p.y * si + p.z * ci);
  float cn = cos(node), sn = sin(node);
  p = vec3(p.x * cn + p.z * sn, p.y, -p.x * sn + p.z * cn);
  p.y += sin(uTime * 0.8 + aSeed.w * 20.0) * 0.05;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec4 mc = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float sc = length(modelViewMatrix[0].xyz);
  float grow = 1.0 + 0.25 * uAct;
  mv.xy += position.xy * vec2(1.5, 1.0) * aSize * sc * grow;
  gl_Position = projectionMatrix * mv;
  vUv = uv;
  vKind = aKind;
  vSeed = aSeed.w;
  vA = 0.42 + 0.58 * smoothstep(-0.9, 0.9, (mv.z - mc.z) / sc);
  vFog = fogFade(-mv.z);
}`

const BUBBLE_FRAG = /* glsl */ `
${COMMON_UNIFORMS}
varying vec2 vUv; varying float vA; varying float vKind; varying float vFog; varying float vSeed;
float sdRoundBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float sdTri(vec2 p, vec2 p0, vec2 p1, vec2 p2){
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
  vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)), vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))), vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}
void main(){
  vec2 p = (vUv - 0.5) * vec2(1.5, 1.0);
  float side = mod(vKind, 2.0) < 0.5 ? -1.0 : 1.0;
  float d = sdRoundBox(p - vec2(0.0, 0.07), vec2(0.66, 0.32), 0.2);
  d = min(d, sdTri(p, vec2(0.18 * side, -0.2), vec2(0.44 * side, -0.2), vec2(0.52 * side, -0.44)));
  float w = fwidth(d);
  float edge = 1.0 - smoothstep(0.0, w * 1.4 + 0.004, abs(d) - 0.026);
  float inside = 1.0 - smoothstep(-w, w, d);
  float body = 0.0;
  if (vKind > 1.5) {
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      float on = 0.45 + 0.55 * max(0.0, sin(uTime * 5.0 - fk * 1.1 + vSeed * 9.0));
      body += (1.0 - smoothstep(0.05, 0.075, length(p - vec2(-0.22 + 0.22 * fk, 0.07)))) * on;
    }
  } else {
    float l1 = (1.0 - smoothstep(0.018, 0.03, abs(p.y - 0.15))) * step(abs(p.x + 0.04), 0.4);
    float l2 = (1.0 - smoothstep(0.018, 0.03, abs(p.y + 0.0))) * step(abs(p.x + 0.16), 0.28 + 0.08 * fract(vSeed * 7.0));
    body = (l1 + l2) * 0.55;
  }
  vec3 c = mix(uColor, uHot, uHeat);
  float a = (edge * 0.85 + inside * (0.07 + 0.05 * uAct) + body * inside * 0.8) * vA;
  gl_FragColor = vec4(c * a * uGain * vFog * uBoot, 1.0);
}`

function buildBubbles({ NU, rand, high }) {
  const group = new THREE.Group()
  const N = high ? 26 : 16
  const seed = new Float32Array(N * 4)
  const size = new Float32Array(N)
  const kind = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    seed.set([rand(), rand(), rand(), rand()], i * 4)
    size[i] = 0.17 + Math.pow(rand(), 2) * 0.2
    kind[i] = (rand() < 0.5 ? 0 : 1) + (rand() < 0.22 ? 2 : 0)
  }
  const mesh = new THREE.Mesh(instanced(new THREE.PlaneGeometry(1, 1), N, { aSeed: [seed, 4], aSize: [size, 1], aKind: [kind, 1] }), nodeShader(NU, {}, BUBBLE_VERT, BUBBLE_FRAG))
  mesh.frustumCulled = false
  group.add(mesh)
  // Dve dráhy roja ako jemné elipsy.
  const orbitA = lines(NU, loopSegments(circlePoints(1.02, 96, 0, 'xz'), 0.22))
  orbitA.rotation.set(0.42, 0, 0.3)
  const orbitB = lines(NU, loopSegments(circlePoints(0.7, 80, 0, 'xz'), 0.16))
  orbitB.rotation.set(-0.5, 0, -0.4)
  group.add(orbitA, orbitB)
  return {
    group,
    update(T, s) {
      orbitA.rotation.y = s.phase * 0.12
      orbitB.rotation.y = -s.phase * 0.17
    },
  }
}

// ── Fotky: stoh rámčekov ────────────────────────────────────────────────

const PHOTO_VERT = /* glsl */ `
${COMMON_UNIFORMS}
${FOG}
uniform float uCount;
attribute float aIdx;
varying vec2 vUv; varying float vIdx; varying float vFog;
void main(){
  float c = aIdx - (uCount - 1.0) * 0.5;
  float fan = 0.075 + 0.035 * sin(uPhase * 0.55) + 0.12 * uAct;
  float ang = c * fan;
  vec3 p = vec3(position.xy * vec2(1.3, 0.98), 0.0);
  p.y += 0.62;
  p.xy = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * p.xy;
  p.y -= 0.62;
  p.z += c * (0.12 + 0.07 * uAct);
  p.x += c * 0.035;
  float yaw = c * 0.045 * (1.0 + uAct);
  p.xz = mat2(cos(yaw), sin(yaw), -sin(yaw), cos(yaw)) * p.xz;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vUv = uv;
  vIdx = aIdx;
  vFog = fogFade(-mv.z);
}`

const PHOTO_FRAG = /* glsl */ `
${COMMON_UNIFORMS}
uniform float uCount;
varying vec2 vUv; varying float vIdx; varying float vFog;
float sdRoundBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float band(float d, float w){ float fw = fwidth(d); return 1.0 - smoothstep(0.0, fw * 1.4 + 0.002, abs(d) - w); }
void main(){
  vec2 p = (vUv - 0.5) * vec2(1.3, 0.98);
  float front = vIdx / max(1.0, uCount - 1.0);
  float outer = sdRoundBox(p, vec2(0.62, 0.46), 0.05);
  float inner = sdRoundBox(p - vec2(0.0, 0.035), vec2(0.54, 0.34), 0.02);
  float frame = band(outer, 0.012) + band(inner, 0.006) * 0.7;
  // Obrázok: hory, slnko, horizont. Len na predných rámčekoch je zreteľný.
  vec2 q = p - vec2(0.0, 0.035);
  float m1 = -0.2 + 0.36 * max(0.0, 1.0 - abs(q.x + 0.17) / 0.34);
  float m2 = -0.2 + 0.22 * max(0.0, 1.0 - abs(q.x - 0.22) / 0.27);
  float ridge = max(m1, m2);
  float img = band(q.y - ridge, 0.006) * step(inner, 0.0);
  img += (1.0 - smoothstep(-0.02, 0.0, q.y - ridge)) * step(inner, 0.0) * 0.12;
  img += band(length(q - vec2(0.27, 0.17)) - 0.075, 0.006);
  img += (1.0 - smoothstep(0.065, 0.075, length(q - vec2(0.27, 0.17)))) * 0.18;
  float scan = 0.85 + 0.15 * sin(q.y * 140.0 - uTime * 3.0);
  float fill = step(outer, 0.0) * 0.035;
  vec3 c = mix(uColor, uHot, uHeat);
  float a = (frame * (0.3 + 0.5 * front) + img * front * front * scan * 0.7 + fill) * (0.3 + 0.7 * front);
  gl_FragColor = vec4(c * a * uGain * vFog * uBoot, 1.0);
}`

function buildPhotos({ NU, high }) {
  const group = new THREE.Group()
  const N = high ? 6 : 4
  const idx = new Float32Array(N)
  for (let i = 0; i < N; i++) idx[i] = i
  const mesh = new THREE.Mesh(instanced(new THREE.PlaneGeometry(1, 1), N, { aIdx: [idx, 1] }), nodeShader(NU, { uCount: { value: N } }, PHOTO_VERT, PHOTO_FRAG))
  mesh.frustumCulled = false
  mesh.position.y = 0.05
  group.add(mesh)
  return { group, update() {} }
}

// ── Udalosti: časová špirála ────────────────────────────────────────────

const helix = (s) => {
  const a = s * 3.25 * TAU
  const r = 0.24 + 0.7 * s
  return [Math.cos(a) * r, -0.92 + 1.84 * s, Math.sin(a) * r]
}

const SPIRAL_POINT_VERT = /* glsl */ `
${COMMON_UNIFORMS}
${FOG}
uniform float uPR; uniform float uScale; uniform vec3 uNow;
attribute vec3 aP;
varying vec3 vColor; varying float vAlpha;
vec3 helix(float s){ float a = s * 3.25 * 6.2831853; float r = 0.24 + 0.7 * s; return vec3(cos(a) * r, -0.92 + 1.84 * s, sin(a) * r); }
void main(){
  bool flow = aP.z > 0.5;
  float s = flow ? fract(aP.x + uPhase * 0.035) : aP.x;
  vec3 p = helix(s);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float sc = length(modelViewMatrix[0].xyz);
  float size = flow ? (0.03 + 0.025 * aP.y) : (0.065 + 0.04 * aP.y);
  gl_PointSize = min(size * sc * uScale * uPR * 26.0 / -mv.z, 26.0 * uPR);
  vColor = mix(uColor, uHot, flow ? uHeat : max(uHeat, step(0.97, s)));
  vColor *= flow ? 1.6 : 1.1 + 0.7 * s;
  vAlpha = flow ? sin(3.14159 * s) * (0.6 + 0.6 * uAct) : (0.35 + 0.65 * s);
  vAlpha *= fogFade(-mv.z);
}`

function buildSpiral({ NU, U, rand, high }) {
  const group = new THREE.Group()
  const segs = []
  const steps = 420
  for (let i = 0; i < steps; i++) {
    const s0 = i / steps
    const s1 = (i + 1) / steps
    segs.push([helix(s0), helix(s1), 0.4 + 0.6 * s0, 0.4 + 0.6 * s1])
  }
  // Rysky po obvode a zvislá os s mierkou.
  for (let i = 0; i <= 52; i++) {
    const s = i / 52
    const p = helix(s)
    const len = i % 4 === 0 ? 0.1 : 0.05
    const k = 1 + len / Math.hypot(p[0], p[2])
    segs.push([p, [p[0] * k, p[1], p[2] * k], 0.25 + 0.6 * s])
  }
  // Plášť kužeľa: šesť jemných poludníkov dáva špirále objem.
  for (let m = 0; m < 6; m++) {
    const a = (m / 6) * TAU + 0.3
    segs.push([[Math.cos(a) * 0.24, -0.92, Math.sin(a) * 0.24], [Math.cos(a) * 0.94, 0.92, Math.sin(a) * 0.94], 0.06, 0.2])
  }
  segs.push(...loopSegments(circlePoints(0.94, 72, 0.92, 'xz'), 0.22))
  segs.push([[0, -1.0, 0], [0, 1.02, 0], 0.22])
  for (let i = 0; i <= 10; i++) {
    const y = -0.92 + (1.84 * i) / 10
    segs.push([[-0.04, y, 0], [0.04, y, 0], 0.3])
  }
  segs.push(...loopSegments(circlePoints(0.3, 48, -0.98, 'xz'), 0.3))
  const helixLines = lines(NU, segs, 1.35)
  group.add(helixLines)

  const events = high ? 18 : 12
  const flow = high ? 96 : 44
  const count = events + flow
  const aP = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const isFlow = i >= events
    aP.set([isFlow ? rand() : Math.min(1, 0.06 + rand() * 0.9 + (i === 0 ? 1 : 0)), rand(), isFlow ? 1 : 0], i * 3)
  }
  const dots = points(NU, count, SPIRAL_POINT_VERT, { aP: [aP, 3] }, { uPR: U.uPR, uScale: U.uScale, uNow: { value: new THREE.Vector3() } })
  group.add(dots)
  return {
    group,
    update(T, s) {
      group.rotation.y = s.phase * 0.12
    },
  }
}

// ── Spánok: mesiac s prstencom ──────────────────────────────────────────

const MOON_VERT = /* glsl */ `
${FOG}
varying vec3 vN; varying vec3 vV; varying vec3 vObjN; varying float vFog;
void main(){
  vObjN = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
  vFog = fogFade(-mv.z);
}`

const MOON_FRAG = /* glsl */ `
${COMMON_UNIFORMS}
uniform vec3 uLight;
varying vec3 vN; varying vec3 vV; varying vec3 vObjN; varying float vFog;
${SNOISE}
float grid(float x){ float w = fwidth(x); return 1.0 - smoothstep(0.0, w * 1.3, abs(fract(x - 0.5) - 0.5)); }
void main(){
  vec3 n = normalize(vN);
  vec3 on = normalize(vObjN);
  float fres = pow(1.0 - abs(dot(n, normalize(vV))), 2.6);
  float ndl = dot(n, normalize(uLight));
  float lit = smoothstep(-0.04, 0.45, ndl);
  float term = 1.0 - smoothstep(0.0, 0.09, abs(ndl + 0.02));
  float cr = snoise(on * 3.2) * 0.6 + snoise(on * 7.5) * 0.3 + snoise(on * 16.0) * 0.15;
  float craters = smoothstep(0.1, 0.55, cr);
  float rimC = (1.0 - smoothstep(0.0, 0.06, abs(cr - 0.35))) * 0.6;
  float lat = asin(clamp(on.y, -1.0, 1.0)) / 3.14159 * 9.0;
  float lon = atan(on.z, on.x) / 6.28318 * 18.0;
  float g = max(grid(lat), grid(lon)) * (1.0 - smoothstep(0.75, 0.98, abs(on.y)));
  float scan = smoothstep(0.16, 0.0, abs(on.y * 0.62 - uScan)) * uScanAmt;
  vec3 c = mix(uColor, uHot, uHeat * 0.8);
  float k = 0.01 + lit * (0.24 - 0.11 * craters + rimC * 0.12) + fres * (0.1 + 0.5 * lit) + g * (0.016 + 0.06 * lit) + term * 0.16 + scan * 0.3;
  gl_FragColor = vec4(c * k * uGain * vFog * uBoot, 1.0);
}`

const RING_VERT = /* glsl */ `
${COMMON_UNIFORMS}
${FOG}
uniform float uPR; uniform float uScale; uniform float uMoonR;
attribute vec4 aR;
varying vec3 vColor; varying float vAlpha;
void main(){
  float r = mix(0.86, 1.2, aR.x);
  float th = aR.y * 6.2831 + uPhase * 0.35 / pow(r, 1.5) + uTime * 0.02;
  vec3 p = vec3(cos(th) * r, (aR.z - 0.5) * 0.02, sin(th) * r);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec4 mc = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
  float sc = length(modelViewMatrix[0].xyz);
  // Zákryt: časť prstenca za mesiacom je skrytá.
  float behind = step(mv.z, mc.z) * (1.0 - smoothstep(uMoonR * sc * 0.92, uMoonR * sc * 1.02, length(mv.xy - mc.xy)));
  gl_PointSize = min((0.6 + 1.4 * aR.w) * sc * uScale * uPR * 3.4 / -mv.z, 9.0 * uPR);
  float band = 0.55 + 0.45 * sin(r * 60.0);
  vColor = mix(uColor, uHot, uHeat) * (0.55 + 0.6 * aR.w) * band;
  vAlpha = (1.0 - behind * 0.9) * fogFade(-mv.z) * (0.7 + 0.5 * uAct);
}`

function buildMoon({ NU, U, rand, high }) {
  const group = new THREE.Group()
  const moonR = 0.6
  const moon = new THREE.Mesh(
    new THREE.IcosahedronGeometry(moonR, high ? 6 : 4),
    new THREE.ShaderMaterial({ uniforms: { ...NU, uLight: { value: new THREE.Vector3(0.82, 0.3, 0.28).normalize() } }, vertexShader: MOON_VERT, fragmentShader: MOON_FRAG, side: THREE.FrontSide, ...ADDITIVE }),
  )
  moon.frustumCulled = false
  group.add(moon)
  const ring = new THREE.Group()
  ring.rotation.set(0.34, 0.0, 0.32)
  const N = high ? 1400 : 600
  const aR = new Float32Array(N * 4)
  for (let i = 0; i < N; i++) aR.set([Math.pow(rand(), 0.8), rand(), rand(), Math.pow(rand(), 3)], i * 4)
  const dust = points(NU, N, RING_VERT, { aR: [aR, 4] }, { uPR: U.uPR, uScale: U.uScale, uMoonR: { value: moonR } })
  ring.add(dust)
  ring.add(lines(NU, loopSegments(circlePoints(0.84, 128, 0, 'xz'), 0.32)))
  ring.add(lines(NU, loopSegments(circlePoints(1.23, 160, 0, 'xz'), 0.2)))
  group.add(ring)
  // Tri drobné hviezdy pri mesiaci.
  const starSegs = []
  for (const [x, y, s] of [[-0.78, 0.66, 0.07], [0.82, 0.78, 0.05], [-0.95, -0.12, 0.045]]) {
    starSegs.push([[x - s, y, 0], [x + s, y, 0], 0.7], [[x, y - s, 0], [x, y + s, 0], 0.7])
  }
  const stars = lines(NU, starSegs, 0.8)
  group.add(stars)
  return {
    group,
    update(T, s) {
      moon.rotation.y = s.phase * 0.05
      ring.rotation.y = s.phase * 0.02
      stars.material.uniforms.uOpacity.value = 0.55 + 0.45 * Math.sin(T * 1.7)
    },
  }
}

// ── Kalendár: mriežka dní ───────────────────────────────────────────────

const CAL_VERT = /* glsl */ `
${COMMON_UNIFORMS}
${FOG}
attribute vec4 aTile;
varying vec2 vUv; varying vec3 vLocal; varying float vToday; varying float vBusy; varying float vFog; varying float vTop; varying float vOut;
void main(){
  float col = aTile.x, row = aTile.y;
  float outside = step(aTile.z, -0.5);
  float busy = max(aTile.z, 0.0);
  float wave = smoothstep(0.75, 1.0, sin(col * 0.9 - row * 0.5 - uPhase * 0.8) * 0.5 + 0.5) * (1.0 - outside);
  float h = 0.025 + busy * (0.06 + 0.2 * uAct) + wave * 0.08;
  vec3 p = position * vec3(0.205, 0.205, h);
  p.z += h * 0.5;
  p.x += (col - 3.0) * 0.26;
  p.y += (1.6 - row) * 0.26 - 0.14;
  p.z -= p.x * p.x * 0.14;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vUv = uv;
  vLocal = position;
  vToday = aTile.w;
  vBusy = busy + wave * 0.5;
  vOut = outside;
  vTop = step(0.5, normal.z);
  vFog = fogFade(-mv.z);
}`

const CAL_FRAG = /* glsl */ `
${COMMON_UNIFORMS}
varying vec2 vUv; varying vec3 vLocal; varying float vToday; varying float vBusy; varying float vFog; varying float vTop; varying float vOut;
void main(){
  vec2 e2 = min(vUv, 1.0 - vUv);
  float e = min(e2.x, e2.y);
  float fw = fwidth(e);
  float edge = 1.0 - smoothstep(0.0, fw * 1.5 + 0.01, e - 0.02);
  vec3 c = mix(uColor, uHot, max(uHeat, vToday));
  float a = edge * (0.45 + 0.55 * vTop) + vTop * (0.05 + 0.12 * vBusy) + (1.0 - vTop) * 0.025;
  a *= (0.7 + 0.6 * vToday) * (1.0 - 0.72 * vOut);
  gl_FragColor = vec4(c * a * uGain * vFog * uBoot, 1.0);
}`

function buildCalendar({ NU, rand, today }) {
  const group = new THREE.Group()
  const N = 35
  const tile = new Float32Array(N * 4)
  // Skutočný mesiac: pondelok prvý, 5 týždňov okolo dneška, dni mimo mesiaca stlmené.
  const d = today instanceof Date && !Number.isNaN(today.getTime()) ? today : new Date(2026, 10, 9)
  const first = new Date(d.getFullYear(), d.getMonth(), 1)
  const offset = (first.getDay() + 6) % 7
  const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  const todayCell = offset + d.getDate() - 1
  const startRow = Math.min(Math.floor(todayCell / 7), Math.max(0, Math.ceil((offset + days) / 7) - 5))
  for (let i = 0; i < N; i++) {
    const col = i % 7
    const row = Math.floor(i / 7)
    const day = (startRow + row) * 7 + col - offset + 1
    const inMonth = day >= 1 && day <= days
    const isToday = inMonth && day === d.getDate()
    const weekend = col >= 5
    const busy = !inMonth ? -1 : isToday ? 0.9 : weekend ? rand() * 0.25 : Math.pow(rand(), 1.4)
    tile.set([col, row, busy, isToday ? 1 : 0], i * 4)
  }
  const mesh = new THREE.Mesh(instanced(new THREE.BoxGeometry(1, 1, 1), N, { aTile: [tile, 4] }), nodeShader(NU, {}, CAL_VERT, CAL_FRAG))
  mesh.frustumCulled = false
  group.add(mesh)
  // Hlavička s krúžkami väzby a dni v týždni ako krátke čiarky.
  const segs = []
  const top = 0.66
  segs.push(...loopSegments([[-0.95, top, 0], [0.95, top, 0], [0.95, top + 0.2, 0], [-0.95, top + 0.2, 0]], 0.55))
  for (const x of [-0.55, 0.55]) segs.push(...loopSegments(circlePoints(0.07, 24, 0, 'xy').map(([a, b, c]) => [a + x, b + top + 0.24, c]), 0.75))
  for (let c = 0; c < 7; c++) segs.push([[(c - 3) * 0.26 - 0.05, top - 0.08, 0], [(c - 3) * 0.26 + 0.05, top - 0.08, 0], c >= 5 ? 0.35 : 0.6])
  segs.push(...loopSegments([[-0.97, -1.06, 0], [0.97, -1.06, 0], [0.97, top + 0.2, 0], [-0.97, top + 0.2, 0]], 0.16))
  group.add(lines(NU, segs))
  return { group, update() {} }
}

// ── Rutiny: ozubené prstence ────────────────────────────────────────────

function gearOutline(teeth, r, depth) {
  const pts = []
  const step = TAU / teeth
  const rb = r - depth * 0.5
  const rt = r + depth * 0.5
  const polar = (rad, a) => [Math.cos(a) * rad, Math.sin(a) * rad, 0]
  for (let i = 0; i < teeth; i++) {
    const a0 = i * step
    pts.push(polar(rb, a0), polar(rb, a0 + step * 0.16), polar(rt, a0 + step * 0.31), polar(rt, a0 + step * 0.63), polar(rb, a0 + step * 0.78))
  }
  return pts
}

function gear(NU, teeth, r, depth, spokes) {
  const g = new THREE.Group()
  const outline = gearOutline(teeth, r, depth)
  const segs = loopSegments(outline, 1)
  // Hrúbka kolesa: zadný obrys a spojnice na hranách zubov, aby bolo koleso 3D.
  const back = outline.map(([x, y]) => [x, y, -0.07])
  segs.push(...loopSegments(back, 0.4))
  for (let i = 0; i < outline.length; i++) if (i % 5 === 2 || i % 5 === 3) segs.push([outline[i], back[i], 0.5])
  segs.push(...loopSegments(circlePoints(r * 0.64, 64, 0, 'xy'), 0.55))
  segs.push(...loopSegments(circlePoints(r * 0.2, 32, -0.07, 'xy'), 0.45))
  segs.push(...loopSegments(circlePoints(r * 0.2, 32, 0, 'xy'), 0.8))
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * TAU
    segs.push([[Math.cos(a) * r * 0.2, Math.sin(a) * r * 0.2, 0], [Math.cos(a) * r * 0.64, Math.sin(a) * r * 0.64, 0], 0.5])
  }
  g.add(lines(NU, segs))
  const shape = new THREE.Shape(gearOutline(teeth, r, depth).map(([x, y]) => new THREE.Vector2(x, y)))
  shape.holes.push(new THREE.Path(circlePoints(r * 0.64, 48, 0, 'xy').map(([x, y]) => new THREE.Vector2(x, y)).reverse()))
  const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), holoSurface(NU, { fill: 0.035, rim: 0.0, lines: 0.0 }))
  fill.frustumCulled = false
  g.add(fill)
  return g
}

function buildGears({ NU }) {
  const group = new THREE.Group()
  const spec = [
    { teeth: 18, r: 0.55, depth: 0.1, spokes: 6, x: -0.24, y: 0.08, z: 0 },
    { teeth: 11, r: 0.336, depth: 0.1, spokes: 5, angle: -0.62, z: 0.07 },
    { teeth: 8, r: 0.244, depth: 0.1, spokes: 4, angle: 0.95, z: -0.07 },
  ]
  const g0 = spec[0]
  const gears = spec.map((sp, i) => {
    const g = gear(NU, sp.teeth, sp.r, sp.depth, sp.spokes)
    if (i === 0) {
      g.position.set(sp.x, sp.y, sp.z)
      sp.offset = 0
    } else {
      // Zuby do medzier: zub veľkého kolesa na spojnici, medzera malého oproti nemu.
      const dist = g0.r + sp.r
      g.position.set(g0.x + Math.cos(sp.angle) * dist, g0.y + Math.sin(sp.angle) * dist, sp.z)
      const step0 = TAU / g0.teeth
      const step = TAU / sp.teeth
      sp.base0 = sp.angle - 0.47 * step0
      sp.offset = sp.angle + Math.PI - 0.97 * step
    }
    group.add(g)
    return g
  })
  // Obiehajúci bod: rutina, ktorá práve beží.
  const runner = lines(NU, loopSegments(circlePoints(0.92, 140, 0, 'xy'), 0.14))
  group.add(runner)
  return {
    group,
    update(T, s) {
      const a = s.phase * 0.32
      gears[0].rotation.z = a
      for (let i = 1; i < gears.length; i++) {
        const sp = spec[i]
        gears[i].rotation.z = sp.offset - (a - sp.base0) * (g0.teeth / sp.teeth)
      }
    },
  }
}

// ── Projekty: kryštálová mriežka kociek ─────────────────────────────────

const LATTICE_VERT = /* glsl */ `
${COMMON_UNIFORMS}
${FOG}
attribute vec3 aCenter; attribute float aAlpha;
varying float vA; varying vec3 vObj; varying float vFog; varying float vPulse;
void main(){
  float sp = 0.44 * (1.0 + 0.05 * sin(uPhase * 0.7) + 0.16 * uAct);
  float pulse = smoothstep(0.65, 1.0, sin(dot(aCenter, vec3(0.9, 0.6, 0.4)) * 1.6 - uPhase * 1.4) * 0.5 + 0.5);
  vec3 p = aCenter * sp + position * (1.0 + 0.18 * pulse);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vObj = p;
  vA = aAlpha;
  vPulse = pulse;
  vFog = fogFade(-mv.z);
}`

const LATTICE_FRAG = /* glsl */ `
${COMMON_UNIFORMS}
uniform float uOpacity; uniform float uTint;
varying float vA; varying vec3 vObj; varying float vFog; varying float vPulse;
void main(){
  float scan = smoothstep(0.16, 0.0, abs(vObj.y - uScan)) * uScanAmt;
  vec3 c = mix(uColor, uHot, clamp(uHeat + uTint, 0.0, 1.0));
  float a = vA * uOpacity * (0.75 + 0.9 * vPulse) * (1.0 + 1.5 * scan);
  gl_FragColor = vec4(c * a * uGain * vFog * uBoot, 1.0);
}`

const CUBE_FACE_VERT = /* glsl */ `
${COMMON_UNIFORMS}
${FOG}
attribute vec4 aCube;
varying vec3 vN; varying vec3 vV; varying float vFog; varying float vWarm; varying float vPulse;
void main(){
  vec3 center = aCube.xyz;
  float sp = 0.44 * (1.0 + 0.05 * sin(uPhase * 0.7) + 0.16 * uAct);
  float pulse = smoothstep(0.65, 1.0, sin(dot(center, vec3(0.9, 0.6, 0.4)) * 1.6 - uPhase * 1.4) * 0.5 + 0.5);
  vec3 p = center * sp + position * (1.0 + 0.18 * pulse);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  vWarm = aCube.w;
  vPulse = pulse;
  vFog = fogFade(-mv.z);
}`

const CUBE_FACE_FRAG = /* glsl */ `
${COMMON_UNIFORMS}
varying vec3 vN; varying vec3 vV; varying float vFog; varying float vWarm; varying float vPulse;
void main(){
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.6);
  vec3 c = mix(uColor, uHot, max(uHeat, vWarm));
  float a = (0.07 + 0.22 * fres) * (0.8 + 0.8 * vPulse) * (1.0 + 0.6 * vWarm);
  gl_FragColor = vec4(c * a * uGain * vFog * uBoot, 1.0);
}`

function buildLattice({ NU, rand }) {
  const group = new THREE.Group()
  const e = 0.105
  const corners = []
  for (const x of [-e, e]) for (const y of [-e, e]) for (const z of [-e, e]) corners.push([x, y, z])
  const edges = []
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
    const d = corners[i].reduce((n, v, k) => n + (v !== corners[j][k] ? 1 : 0), 0)
    if (d === 1) edges.push([i, j])
  }
  const pos = []
  const center = []
  const alpha = []
  const push = (c, p, a) => {
    center.push(...c)
    pos.push(...p)
    alpha.push(a)
  }
  const cells = []
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) cells.push([x, y, z])
  for (const c of cells) {
    for (const [i, j] of edges) {
      push(c, corners[i], 0.62)
      push(c, corners[j], 0.62)
    }
    for (const dir of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      const n = [c[0] + dir[0], c[1] + dir[1], c[2] + dir[2]]
      if (n.some((v) => Math.abs(v) > 1)) continue
      push(c, dir.map((v) => v * e), 0.22)
      push(n, dir.map((v) => -v * e), 0.22)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('aCenter', new THREE.BufferAttribute(new Float32Array(center), 3))
  g.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(alpha), 1))
  const wire = new THREE.LineSegments(g, nodeShader(NU, { uOpacity: { value: 1 }, uTint: { value: 0 } }, LATTICE_VERT, LATTICE_FRAG))
  wire.frustumCulled = false
  // Svietiace kocky: aktívne projekty, jedna jantárová (ten, na ktorom sa práve robí).
  const lit = cells.filter(() => rand() < 0.3)
  if (!lit.length) lit.push([0, 0, 0])
  const cube = new Float32Array(lit.length * 4)
  lit.forEach((c, i) => cube.set([...c, i === 0 ? 1 : 0], i * 4))
  const faces = new THREE.Mesh(instanced(new THREE.BoxGeometry(e * 2, e * 2, e * 2), lit.length, { aCube: [cube, 4] }), nodeShader(NU, {}, CUBE_FACE_VERT, CUBE_FACE_FRAG))
  faces.frustumCulled = false
  // Kryštál sa točí okolo telesovej uhlopriečky: obrys je vždy šesťuholník, nikdy sa nezarovná do stĺpcov.
  const diag = new THREE.Group()
  diag.add(wire, faces)
  diag.quaternion.setFromUnitVectors(new THREE.Vector3(1, 1, 1).normalize(), new THREE.Vector3(0, 1, 0))
  const spin = new THREE.Group()
  spin.add(diag)
  const tilt = new THREE.Group()
  tilt.rotation.set(0.32, 0, -0.14)
  tilt.add(spin)
  group.add(tilt)
  return {
    group,
    update(T, s) {
      spin.rotation.y = s.phase * 0.17
      tilt.rotation.x = 0.32 + 0.08 * Math.sin(s.phase * 0.09)
    },
  }
}

// ── Questy: kompas s gimbalom ───────────────────────────────────────────

function buildCompass({ NU }) {
  const group = new THREE.Group()
  const face = new THREE.Group()
  face.rotation.x = -0.32
  group.add(face)
  const segs = []
  segs.push(...loopSegments(circlePoints(0.92, 144, 0, 'xy'), 0.9))
  segs.push(...loopSegments(circlePoints(0.7, 120, 0, 'xy'), 0.45))
  for (let d = 0; d < 360; d += 5) {
    const a = (d * Math.PI) / 180
    const major = d % 45 === 0
    const r0 = 0.92
    const r1 = major ? 0.8 : 0.86
    segs.push([[Math.cos(a) * r0, Math.sin(a) * r0, 0], [Math.cos(a) * r1, Math.sin(a) * r1, 0], major ? 0.95 : 0.45])
  }
  // Ružica: osemcípa hviezda.
  const rose = []
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU + Math.PI / 2
    const r = i % 2 === 0 ? (i % 4 === 0 ? 0.62 : 0.4) : 0.13
    rose.push([Math.cos(a) * r, Math.sin(a) * r, 0])
  }
  segs.push(...loopSegments(rose, 0.4))
  face.add(lines(NU, segs))
  // Písmeno N nad stupnicou (jantárové).
  const nx = 0
  const ny = 1.06
  const n = [[nx - 0.05, ny - 0.07, 0], [nx - 0.05, ny + 0.07, 0], [nx + 0.05, ny - 0.07, 0], [nx + 0.05, ny + 0.07, 0]]
  face.add(lines(NU, polySegments(n, 1), 1, 1))
  // Ihla: kosoštvorec, severná polovica jantárová.
  const needle = new THREE.Group()
  const north = new THREE.Shape([new THREE.Vector2(0, 0.66), new THREE.Vector2(0.075, 0), new THREE.Vector2(-0.075, 0)])
  const south = new THREE.Shape([new THREE.Vector2(0, -0.66), new THREE.Vector2(-0.075, 0), new THREE.Vector2(0.075, 0)])
  const nMesh = new THREE.Mesh(new THREE.ShapeGeometry(north), holoSurface(NU, { fill: 0.32, rim: 0, lines: 0, tint: 1 }))
  const sMesh = new THREE.Mesh(new THREE.ShapeGeometry(south), holoSurface(NU, { fill: 0.14, rim: 0, lines: 0 }))
  nMesh.frustumCulled = sMesh.frustumCulled = false
  needle.add(nMesh, sMesh)
  needle.add(lines(NU, loopSegments([[0, 0.66, 0], [0.075, 0, 0], [0, -0.66, 0], [-0.075, 0, 0]], 1)))
  needle.add(lines(NU, loopSegments(circlePoints(0.05, 20, 0.001, 'xy'), 1), 1, 0.4))
  needle.position.z = 0.02
  face.add(needle)
  // Gimbal: dva kolmé prstence, ktoré sa pomaly otáčajú.
  const gimbalA = lines(NU, loopSegments(circlePoints(1.03, 120, 0, 'yz'), 0.38))
  const gimbalB = lines(NU, loopSegments(circlePoints(1.08, 120, 0, 'xz'), 0.28))
  const gimbal = new THREE.Group()
  gimbal.add(gimbalA, gimbalB)
  face.add(gimbal)
  return {
    group,
    update(T, s) {
      const hunt = 0.42 * Math.sin(T * 0.47) * (0.55 + 0.45 * Math.sin(T * 0.173)) + 0.12 * Math.sin(T * 1.9) * s.act
      needle.rotation.z = -0.35 + hunt
      gimbalA.rotation.y = s.phase * 0.21
      gimbalB.rotation.x = s.phase * 0.15
    },
  }
}

// ── náhradný uzol ───────────────────────────────────────────────────────

function buildOrb({ NU }) {
  const group = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 2), holoSurface(NU, { fill: 0.03, rim: 0.6, lines: 0.1 }))
  mesh.frustumCulled = false
  group.add(mesh)
  group.add(lines(NU, loopSegments(circlePoints(0.85, 96, 0, 'xz'), 0.5)))
  return {
    group,
    update(T, s) {
      mesh.rotation.y = s.phase * 0.1
    },
  }
}

// ── ďalšie planéty (menšie mesiace aj veľké Ľudia) ─────────────────────

function boxSegs(w, h, d, [cx, cy, cz] = [0, 0, 0], alpha = 1) {
  const x = w / 2, y = h / 2, z = d / 2
  const c = [[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]].map(([a, b, e]) => [a + cx, b + cy, e + cz])
  return [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]].map(([i, j]) => [c[i], c[j], alpha])
}
const shift = (pts, [dx, dy, dz]) => pts.map(([x, y, z]) => [x + dx, y + dy, z + dz])

/** Ľudia: sieť siluet (hlava a ramená), v strede väčšia postava, prepojené svetlom. */
function buildPeople({ NU }) {
  const group = new THREE.Group()
  const segs = []
  const figure = (x, y, z, k, a = 1) => {
    segs.push(...loopSegments(shift(circlePoints(0.13 * k, 24, 0, 'xy'), [x, y + 0.14 * k, z]), a))
    segs.push(...polySegments(shift(circlePoints(0.22 * k, 16, 0, 'xy', Math.PI * 0.05, Math.PI * 0.95, false), [x, y - 0.17 * k, z]), a))
  }
  const ring = []
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + 0.3
    const p = [Math.cos(a) * 0.78, Math.sin(a) * 0.62, Math.sin(a * 2) * 0.25]
    ring.push(p)
    figure(...p, 0.75, 0.75)
  }
  figure(0, 0, 0.1, 1.35, 1)
  for (let i = 0; i < ring.length; i++) {
    segs.push([ring[i], [0, 0, 0.1], 0.14, 0.32])
    segs.push([ring[i], ring[(i + 2) % ring.length], 0.1])
  }
  const net = lines(NU, segs)
  group.add(net)
  return { group, update(T, s) { group.rotation.y = 0.25 * Math.sin(s.phase * 0.09); group.rotation.z = s.phase * 0.02 } }
}

/** Škola: maturitná čiapka nad knihou. */
function buildSchool({ NU }) {
  const group = new THREE.Group()
  const segs = loopSegments([[0, 0.25, -0.75], [0.75, 0.25, 0], [0, 0.25, 0.75], [-0.75, 0.25, 0]], 1)
  segs.push(...loopSegments(circlePoints(0.38, 32, -0.05, 'xz'), 0.7), ...loopSegments(circlePoints(0.38, 32, 0.2, 'xz'), 0.5))
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU
    segs.push([[Math.cos(a) * 0.38, -0.05, Math.sin(a) * 0.38], [Math.cos(a) * 0.38, 0.2, Math.sin(a) * 0.38], 0.35])
  }
  segs.push([[0, 0.25, 0], [0.55, 0.05, 0.1], 0.9], [[0.55, 0.05, 0.1], [0.55, -0.35, 0.1], 0.9])
  segs.push(...boxSegs(1.1, 0.18, 0.75, [0, -0.62, 0], 0.6))
  group.add(lines(NU, segs), lines(NU, [[[0.55, -0.35, 0.1], [0.55, -0.48, 0.1], 1]], 1, 1))
  return { group, update(T, s) { group.rotation.y = s.phase * 0.08 } }
}

/** Knihy: stoh štyroch kníh, každá trochu pootočená. */
function buildBooks({ NU }) {
  const group = new THREE.Group()
  const dims = [[1.3, 0.24, 0.9], [1.15, 0.2, 0.82], [1.25, 0.28, 0.86], [1.0, 0.18, 0.74]]
  let y = -0.62
  dims.forEach(([w, h, d], i) => {
    const b = lines(NU, [...boxSegs(w, h, d, [0, 0, 0], 0.85), [[-w / 2 + 0.06, -h / 2, d / 2], [-w / 2 + 0.06, h / 2, d / 2], 0.6]], 1, i === 2 ? 0.8 : 0)
    b.position.y = y + h / 2
    b.rotation.y = (i - 1.5) * 0.18
    y += h + 0.02
    group.add(b)
  })
  return { group, update(T, s) { group.rotation.y = 0.35 * Math.sin(s.phase * 0.1) } }
}

/** Filmy: cievka filmu s otvormi a pásom, ktorý z nej odvíja. */
function buildFilm({ NU }) {
  const group = new THREE.Group()
  const reel = new THREE.Group()
  const segs = loopSegments(circlePoints(0.72, 72, 0, 'xy'), 1)
  segs.push(...loopSegments(circlePoints(0.12, 20, 0, 'xy'), 0.9))
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU
    segs.push(...loopSegments(shift(circlePoints(0.16, 20, 0, 'xy'), [Math.cos(a) * 0.4, Math.sin(a) * 0.4, 0]), 0.7))
  }
  reel.add(lines(NU, segs))
  group.add(reel)
  const strip = []
  for (let k = 0; k < 10; k++) {
    const x = 0.62 + k * 0.13
    const yy = -0.72 - k * 0.025
    strip.push([[x, yy, 0], [x + 0.13, yy - 0.025, 0], 0.7], [[x, yy - 0.22, 0], [x + 0.13, yy - 0.245, 0], 0.7], [[x + 0.03, yy - 0.06, 0], [x + 0.03, yy - 0.16, 0], 0.4])
  }
  group.add(lines(NU, strip, 1, 0.6))
  group.position.x = -0.25
  return { group, update(T, s) { reel.rotation.z = -s.phase * 0.5 } }
}

/** Miesta: drôtený glóbus a špendlík nad ním. */
function buildPlaces({ NU }) {
  const group = new THREE.Group()
  const globe = new THREE.Group()
  const segs = []
  for (let i = -2; i <= 2; i++) segs.push(...loopSegments(circlePoints(Math.cos((i / 3) * (Math.PI / 2)) * 0.6, 48, Math.sin((i / 3) * (Math.PI / 2)) * 0.6, 'xz'), i === 0 ? 0.8 : 0.4))
  for (let m = 0; m < 6; m++) {
    const g = new THREE.Group()
    g.add(lines(NU, loopSegments(circlePoints(0.6, 48, 0, 'xy'), 0.35)))
    g.rotation.y = (m / 6) * Math.PI
    globe.add(g)
  }
  globe.add(lines(NU, segs))
  globe.position.y = -0.25
  const pin = []
  const tear = []
  for (let i = 0; i <= 24; i++) {
    const a = Math.PI * 1.25 + (i / 24) * Math.PI * 1.5
    tear.push([Math.cos(a) * 0.2, 0.62 + Math.sin(a) * 0.2, 0.3])
  }
  pin.push(...polySegments(tear, 1), [tear[0], [0, 0.28, 0.3], 1], [tear[tear.length - 1], [0, 0.28, 0.3], 1], ...loopSegments(shift(circlePoints(0.07, 16, 0, 'xy'), [0, 0.62, 0.3]), 1))
  group.add(globe, lines(NU, pin, 1, 1))
  return { group, update(T, s) { globe.rotation.y = s.phase * 0.2 } }
}

/** Hudba: platňa s drážkami, ramienko a ekvalizér. */
function buildMusic({ NU }) {
  const group = new THREE.Group()
  const disc = new THREE.Group()
  const segs = []
  for (let i = 0; i < 6; i++) segs.push(...loopSegments(circlePoints(0.72 - i * 0.08, 64, 0, 'xy'), i === 0 ? 1 : 0.32))
  segs.push(...loopSegments(circlePoints(0.18, 24, 0, 'xy'), 0.9))
  disc.add(lines(NU, segs), lines(NU, [[[0.05, 0.08, 0.01], [0.1, 0.02, 0.01], 1]], 1, 1))
  disc.rotation.x = -0.5
  const arm = lines(NU, [[[0.8, 0.7, 0.1], [0.55, -0.05, 0.25], 0.9], [[0.55, -0.05, 0.25], [0.38, -0.18, 0.28], 0.9]])
  const eq = new THREE.Group()
  const bars = []
  for (let i = 0; i < 9; i++) {
    const b = lines(NU, [[[0, 0, 0], [0, 1, 0], 1]], 0.9, i % 4 === 0 ? 1 : 0)
    b.position.set(-0.6 + i * 0.15, -0.95, 0.2)
    eq.add(b)
    bars.push(b)
  }
  group.add(disc, arm, eq)
  return {
    group,
    update(T, s) {
      disc.rotation.z = -s.phase * 0.9
      bars.forEach((b, i) => b.scale.setY(0.08 + 0.22 * (0.5 + 0.5 * Math.sin(T * (2.2 + i * 0.37) + i))))
    },
  }
}

/** Šatník: vešiak s tričkom. */
function buildWardrobe({ NU }) {
  const group = new THREE.Group()
  const hook = []
  for (let i = 0; i <= 14; i++) {
    const a = Math.PI * 0.9 - (i / 14) * Math.PI * 1.3
    hook.push([Math.cos(a) * 0.1, 0.85 + Math.sin(a) * 0.1, 0])
  }
  const segs = [...polySegments(hook, 1), [[0, 0.75, 0], [-0.7, 0.4, 0], 1], [[0, 0.75, 0], [0.7, 0.4, 0], 1], [[-0.7, 0.4, 0], [0.7, 0.4, 0], 0.8]]
  const shirt = [[-0.25, 0.42], [-0.62, 0.3], [-0.78, 0.0], [-0.52, -0.08], [-0.45, 0.08], [-0.45, -0.8], [0.45, -0.8], [0.45, 0.08], [0.52, -0.08], [0.78, 0.0], [0.62, 0.3], [0.25, 0.42]].map(([x, y]) => [x, y, 0.02])
  const neck = []
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI + (i / 10) * Math.PI
    neck.push([Math.cos(a) * 0.25, 0.42 + Math.sin(a) * 0.12, 0.02])
  }
  segs.push(...polySegments(shirt, 0.9), ...polySegments(neck, 0.9))
  group.add(lines(NU, segs))
  const fill = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(shirt.map(([x, y]) => new THREE.Vector2(x, y)))), holoSurface(NU, { fill: 0.05, rim: 0, lines: 0.12 }))
  fill.frustumCulled = false
  group.add(fill)
  return { group, update(T, s) { group.rotation.z = 0.06 * Math.sin(T * 0.8); group.rotation.y = 0.3 * Math.sin(s.phase * 0.07) } }
}

/** Insights a zdroje: žiarovka s lúčmi (nápad) a symbol prehrávania. */
function buildInsight({ NU }) {
  const group = new THREE.Group()
  const bulb = []
  for (let i = 0; i <= 40; i++) {
    const a = -Math.PI * 0.25 + (i / 40) * Math.PI * 1.5
    bulb.push([Math.cos(a) * 0.42, 0.2 + Math.sin(a) * 0.42, 0])
  }
  const segs = [...polySegments(bulb, 1), [bulb[0], [0.2, -0.4, 0], 1], [bulb[bulb.length - 1], [-0.2, -0.4, 0], 1]]
  for (const y of [-0.45, -0.55, -0.65]) segs.push([[-0.2, y, 0], [0.2, y, 0], 0.8])
  segs.push(...polySegments([[-0.12, 0.0, 0], [-0.06, 0.25, 0], [0, 0.05, 0], [0.06, 0.25, 0], [0.12, 0.0, 0]], 1))
  const rays = []
  for (let i = 0; i < 7; i++) {
    const a = Math.PI * 0.05 + (i / 6) * Math.PI * 0.9
    rays.push([[Math.cos(a) * 0.55, 0.2 + Math.sin(a) * 0.55, 0], [Math.cos(a) * 0.75, 0.2 + Math.sin(a) * 0.75, 0], 0.8])
  }
  const glow = lines(NU, rays, 1, 1)
  group.add(lines(NU, segs), glow)
  return { group, update(T, s) { glow.material.uniforms.uOpacity.value = 0.5 + 0.5 * Math.sin(T * 1.6); group.rotation.y = 0.3 * Math.sin(s.phase * 0.08) } }
}

/** Minecraft: blok trávy s mriežkou a pár malých kociek okolo. */
function buildVoxel({ NU }) {
  const group = new THREE.Group()
  const cube = new THREE.Group()
  const segs = boxSegs(0.9, 0.9, 0.9, [0, 0, 0], 1)
  for (let i = 1; i < 4; i++) {
    const t = -0.45 + (i * 0.9) / 4
    segs.push([[t, 0.45, -0.45], [t, 0.45, 0.45], 0.35], [[-0.45, 0.45, t], [0.45, 0.45, t], 0.35])
  }
  segs.push(...polySegments([[-0.45, 0.25, 0.451], [-0.3, 0.18, 0.451], [-0.15, 0.27, 0.451], [0.05, 0.16, 0.451], [0.25, 0.26, 0.451], [0.45, 0.2, 0.451]], 0.7))
  cube.add(lines(NU, segs))
  const top = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), holoSurface(NU, { fill: 0.12, rim: 0, lines: 0, tint: 0 }))
  top.rotation.x = -Math.PI / 2
  top.position.y = 0.45
  top.frustumCulled = false
  cube.add(top)
  cube.rotation.set(0.5, 0.6, 0)
  const bits = []
  for (const [x, y, z, k] of [[0.85, 0.55, 0.2, 0.2], [-0.85, -0.4, 0.1, 0.16], [0.6, -0.75, -0.2, 0.13]]) {
    const b = lines(NU, boxSegs(k, k, k, [0, 0, 0], 0.8), 1, x > 0.7 ? 0.8 : 0)
    b.position.set(x, y, z)
    group.add(b)
    bits.push(b)
  }
  group.add(cube)
  return { group, update(T, s) { cube.rotation.y = 0.6 + s.phase * 0.18; bits.forEach((b, i) => (b.position.y += Math.sin(T * 1.2 + i * 2) * 0.0015)) } }
}

/** Úlohy: zoznam so zaškrtávacími políčkami, dve hotové. */
function buildTodo({ NU }) {
  const group = new THREE.Group()
  const segs = loopSegments([[-0.7, 0.85, 0], [0.7, 0.85, 0], [0.7, -0.85, 0], [-0.7, -0.85, 0]], 0.8)
  segs.push(...loopSegments([[-0.22, 0.95, 0], [0.22, 0.95, 0], [0.22, 0.78, 0], [-0.22, 0.78, 0]], 1))
  const checks = []
  for (let i = 0; i < 4; i++) {
    const y = 0.48 - i * 0.38
    segs.push(...loopSegments([[-0.5, y + 0.1, 0], [-0.3, y + 0.1, 0], [-0.3, y - 0.1, 0], [-0.5, y - 0.1, 0]], 0.9))
    segs.push([[-0.15, y, 0], [0.5 - (i % 2) * 0.15, y, 0], i < 2 ? 0.35 : 0.75])
    if (i < 2) checks.push(...polySegments([[-0.48, y, 0.01], [-0.41, y - 0.07, 0.01], [-0.27, y + 0.14, 0.01]], 1))
  }
  group.add(lines(NU, segs), lines(NU, checks, 1, 1))
  return { group, update(T, s) { group.rotation.y = 0.3 * Math.sin(s.phase * 0.09) } }
}

/** Content: kamera s objektívom a svietiacou bodkou nahrávania. */
function buildCamera({ NU }) {
  const group = new THREE.Group()
  const segs = boxSegs(1.1, 0.7, 0.5, [-0.1, 0, 0], 0.9)
  segs.push(...loopSegments(shift(circlePoints(0.26, 32, 0, 'xy'), [-0.1, 0, 0.26]), 1), ...loopSegments(shift(circlePoints(0.16, 24, 0, 'xy'), [-0.1, 0, 0.3]), 0.7))
  segs.push(...loopSegments([[0.45, 0.2, 0], [0.8, 0.38, 0], [0.8, -0.38, 0], [0.45, -0.2, 0]], 0.8))
  const rec = lines(NU, loopSegments(shift(circlePoints(0.06, 16, 0, 'xy'), [0.3, 0.25, 0.26]), 1), 1, 1)
  group.add(lines(NU, segs), rec)
  return { group, update(T, s) { rec.material.uniforms.uOpacity.value = Math.sin(T * 3) > 0 ? 1 : 0.25; group.rotation.y = -0.3 + 0.25 * Math.sin(s.phase * 0.08) } }
}

/** Fyzický stav: mesiac spánku s prstencom a srdcový rytmus okolo. */
function buildBody(ctx) {
  const moon = buildMoon(ctx)
  const N = 220
  const ecg = []
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU
    const ph = (i % 44) / 44
    const spike = ph > 0.42 && ph < 0.5 ? Math.sin(((ph - 0.42) / 0.08) * Math.PI) * 0.22 : ph > 0.5 && ph < 0.55 ? -0.08 : 0
    const r = 1.05 + spike
    ecg.push([Math.cos(a) * r, Math.sin(a) * r, 0])
  }
  const pulse = lines(ctx.NU, loopSegments(ecg, 0.85), 1, 1)
  moon.group.add(pulse)
  return {
    group: moon.group,
    update(T, s) {
      moon.update(T, s)
      pulse.rotation.z = -T * 0.35
      pulse.material.uniforms.uOpacity.value = 0.55 + 0.45 * Math.pow(Math.max(0, Math.sin(T * 7.2)), 8)
    },
  }
}

const BUILDERS = {
  spravy: buildBubbles,
  fotky: buildPhotos,
  udalosti: buildSpiral,
  spanok: buildBody,
  ludia: buildPeople,
  skola: buildSchool,
  knihy: buildBooks,
  filmy: buildFilm,
  miesta: buildPlaces,
  hudba: buildMusic,
  satnik: buildWardrobe,
  zdroje: buildInsight,
  minecraft: buildVoxel,
  ulohy: buildTodo,
  content: buildCamera,
  kalendar: buildCalendar,
  rutiny: buildGears,
  projekty: buildLattice,
  questy: buildCompass,
}

// ── správca uzlov ───────────────────────────────────────────────────────

/** Hĺbkový rozptyl uzlov: z z NODE_LAYOUT (±0,55) sa roztiahne na ±2 jednotky. */
export const DEPTH_SPREAD = 3.4

export function createNodes(U, { high, rand, nodes, today }) {
  const root = new THREE.Group()
  root.name = 'nodes'
  const glow = glowTexture([[0, 1], [0.2, 0.7], [0.5, 0.12], [1, 0]])
  const reticleTex = ringTexture(5, true)
  const items = nodes.slice(0, 24).map((n, index) => {
    const NU = nodeUniforms(U, COLOR.cyan, COLOR.amber, index * 1.37 + 0.4)
    const build = BUILDERS[n.id] ?? buildOrb
    const obj = build({ NU, U, rand, high, today })
    const holder = new THREE.Group()
    const pose = new THREE.Group()
    pose.add(obj.group)
    holder.add(pose)
    const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: COLOR.cyan.clone(), transparent: true, ...ADDITIVE }))
    dot.scale.setScalar(0.5)
    const reticle = new THREE.Sprite(new THREE.SpriteMaterial({ map: reticleTex, color: COLOR.cyan.clone(), transparent: true, opacity: 0.2, ...ADDITIVE }))
    reticle.scale.setScalar(2.9)
    holder.add(dot, reticle)
    root.add(holder)
    return {
      ...n,
      index,
      NU,
      obj,
      holder,
      pose,
      dot,
      reticle,
      pos: new THREE.Vector3(),
      scale: 0.4,
      ramps: { tool: new Ramp(0.6, 1.4), hover: new Ramp(0.18, 0.5) },
      state: { act: 0, phase: 0, tool: 0, focus: 0, hover: 0, flare: 0 },
    }
  })

  /**
   * s: { T, boot, flares, tools: Set|Object, focusWeights: {id: k}, hover: id|null }
   */
  function update(s) {
    const T = s.T
    for (const n of items) {
      const f = clamp(s.flares?.[n.id]?.f ?? 0, 0, 1.4)
      const toolOn = s.tools.has(n.id) ? 1 : 0
      const tool = n.ramps.tool.set(T, toolOn).value(T)
      const hover = n.ramps.hover.set(T, s.hover === n.id ? 1 : 0).value(T)
      const focus = s.focusWeights[n.id] ?? 0
      const act = clamp(0.4 * f + tool + 0.45 * focus + 0.3 * hover)
      // Fáza animácie: stály chod + zrýchlenie počas práce nástroja (integrál, bez skokov).
      const phase = T + n.index * 7.3 + 2.4 * n.ramps.tool.integral(T)
      const st = n.state
      st.act = act
      st.phase = phase
      st.tool = tool
      st.focus = focus
      st.hover = hover
      st.flare = f
      const NU = n.NU
      NU.uHeat.value = clamp(f * 0.9) * 0.85
      NU.uGain.value = (0.42 + 0.22 * tool + 0.2 * hover + 0.42 * focus + 0.16 * clamp(f)) * s.boot
      NU.uPhase.value = phase
      NU.uAct.value = act
      // Sken: svetelný pás prechádza objektom zdola hore, kým na ňom Jarvis pracuje.
      NU.uScan.value = -1.25 + 2.5 * ((T * 0.55 + n.index * 0.13) % 1)
      NU.uScanAmt.value = clamp(tool * 1.2 + 0.35 * hover)
      n.obj.update(T, st)
      n.pose.rotation.y = 0.28 * Math.sin(T * 0.11 + n.index * 1.9) + 0.08 * Math.sin(T * 0.29 + n.index)
      n.pose.rotation.x = 0.06 * Math.sin(T * 0.13 + n.index * 2.7)
      const breathe = 0.5 + 0.5 * Math.sin(T * 0.9 + n.index * 1.7)
      n.dot.scale.setScalar(0.38 + 0.05 * breathe + 0.09 * f + 0.07 * tool)
      n.dot.material.color.copy(COLOR.cyan).lerp(COLOR.amber, clamp(f * 0.9))
      n.dot.material.opacity = (0.42 + 0.18 * act) * s.boot * (1 - 0.85 * focus)
      n.reticle.scale.setScalar(2.75 + 0.1 * breathe + 0.5 * f + 0.25 * hover)
      n.reticle.material.opacity = (0.1 + 0.25 * f + 0.3 * hover + 0.15 * tool) * s.boot * (1 - focus)
      n.reticle.material.color.copy(COLOR.cyan).lerp(COLOR.amber, clamp(f * 0.9))
      n.reticle.material.rotation = T * 0.25 + n.index
    }
  }

  return { root, items, update }
}
