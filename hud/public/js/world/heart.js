// Srdce sveta: galaxia z v1 (častice v naklonenej rovine, guľa častíc, žiara jadra,
// tri ciferníky s textom po obvode, oblúk a vlna hlasu, orbity so satelitmi).
// Nové: prstenec počúvania (vlna od mikrofónu), dátové víry pri premýšľaní
// a svetelné vlny pri reči. Všetko sa počíta z času T a obálok stavu.

import * as THREE from 'three'
import { SNOISE, SOFT_POINT_FRAG } from './glsl.js'
import { clamp } from './util.js'

export const COLOR = {
  ice: new THREE.Color('#d9fbff'),
  white: new THREE.Color('#eafbff'),
  cyan: new THREE.Color('#5fe6ff'),
  teal: new THREE.Color('#22c8d6'),
  azure: new THREE.Color('#2f8cff'),
  deep: new THREE.Color('#1a4f8a'),
  amber: new THREE.Color('#ffb25c'),
  ember: new THREE.Color('#f0623c'),
  red: new THREE.Color('#ff5a4e'),
}

/** Polomery v jednotkách scény. */
export const R = { shell: 0.8, voice: 1.12, listen: 1.27, dialA: 1.42, accent: 1.535, dialB: 1.7, dialC: 2.02, layout: 2.12 }

const pointMaterial = (vertexShader, uniforms) =>
  new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader: SOFT_POINT_FRAG,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    transparent: true,
  })

// ── galaxia ─────────────────────────────────────────────────────────────

function galaxyGeometry(count, rand) {
  const orbit = new Float32Array(count * 4)
  const color = new Float32Array(count * 3)
  const size = new Float32Array(count)
  const c = new THREE.Color()
  const arms = 3
  for (let i = 0; i < count; i++) {
    const r = 1.22 + Math.pow(rand(), 1.45) * 2.55
    let theta = (i % arms) * ((Math.PI * 2) / arms) + Math.log(r) * 2.3 + (rand() - 0.5) * (0.5 + r * 0.16) * 1.6
    if (rand() < 0.38) theta = rand() * Math.PI * 2
    const y = (rand() - 0.5) * (0.06 + r * 0.05) * Math.pow(rand(), 1.5)
    orbit.set([r, theta, y, rand()], i * 4)
    const band = r > 2.3 && r < 3.0
    const roll = rand()
    if (band && roll < 0.2) c.copy(COLOR.amber).lerp(COLOR.ember, rand() * 0.45)
    else if (r < 1.5) c.copy(COLOR.ice).lerp(COLOR.cyan, 0.4 + rand() * 0.6)
    else if (r < 2.3) c.copy(COLOR.cyan).lerp(COLOR.teal, rand() * 0.6).lerp(COLOR.azure, rand() * 0.35)
    else c.copy(COLOR.azure).lerp(COLOR.cyan, rand() * 0.45).lerp(COLOR.deep, rand() * 0.3)
    const dim = 0.16 + Math.pow(rand(), 1.6) * 0.62
    color.set([c.r * dim, c.g * dim, c.b * dim], i * 3)
    size[i] = 0.6 + Math.pow(rand(), 7) * (r > 2.6 ? 2.2 : 3.2) + (band && roll < 0.2 ? 0.5 : 0)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  g.setAttribute('aOrbit', new THREE.BufferAttribute(orbit, 4))
  g.setAttribute('aColor', new THREE.BufferAttribute(color, 3))
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10)
  return g
}

const GALAXY_VERT = /* glsl */ `
uniform float uTime; uniform float uVoice; uniform float uPulse; uniform float uBoot; uniform float uPR; uniform float uScale;
uniform float uThinkPhase; uniform float uListen; uniform float uSpin;
attribute vec4 aOrbit; attribute vec3 aColor; attribute float aSize;
varying vec3 vColor; varying float vAlpha;
void main(){
  float r = aOrbit.x;
  float w = 0.035 + 0.24 / (1.0 + r * r * 0.8);
  float th = aOrbit.y + (uTime + uThinkPhase * 1.6 + uSpin) * w;
  float inner = exp(-(r - 1.2) * 0.9);
  float breathe = 1.0 + (0.05 * uVoice + 0.04 * uPulse) * inner - 0.03 * uListen * inner;
  float rr = r * breathe * mix(0.55, 1.0, uBoot);
  vec3 p = vec3(cos(th) * rr, aOrbit.z, sin(th) * rr);
  p.y += sin(th * 3.0 + uTime * 0.35 + aOrbit.w * 6.2831) * 0.018 * r;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float shimmer = 0.78 + 0.22 * sin(uTime * (0.5 + aOrbit.w * 1.3) + aOrbit.w * 40.0);
  gl_PointSize = min(aSize * uScale * uPR * (1.0 + 0.3 * uVoice * exp(-(r - 1.2))) / -mv.z, 14.0 * uPR);
  vColor = aColor * (0.9 + 0.42 * uVoice * exp(-(r - 1.2) * 0.8) + 0.4 * uPulse * exp(-(r - 1.2) * 0.6) + 0.25 * uListen * inner);
  vAlpha = shimmer * uBoot;
}`

function shellGeometry(count, rand) {
  const dir = new Float32Array(count * 3)
  const params = new Float32Array(count * 4)
  const color = new Float32Array(count * 3)
  const c = new THREE.Color()
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2
    const rad = Math.sqrt(1 - y * y)
    const th = golden * i + rand() * 0.4
    dir.set([Math.cos(th) * rad, y, Math.sin(th) * rad], i * 3)
    const inner = rand() < 0.14
    const radius = inner ? 0.18 + rand() * 0.52 : R.shell * (0.9 + rand() * 0.16)
    params.set([radius, rand(), 0.55 + Math.pow(rand(), 6) * 2.2, inner ? 1 : 0], i * 4)
    c.copy(COLOR.ice).lerp(COLOR.cyan, 0.35 + rand() * 0.65)
    if (rand() < 0.04) c.copy(COLOR.amber)
    const dim = inner ? 0.22 + rand() * 0.3 : 0.32 + Math.pow(rand(), 1.3) * 0.62
    color.set([c.r * dim, c.g * dim, c.b * dim], i * 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  g.setAttribute('aDir', new THREE.BufferAttribute(dir, 3))
  g.setAttribute('aParams', new THREE.BufferAttribute(params, 4))
  g.setAttribute('aColor', new THREE.BufferAttribute(color, 3))
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3)
  return g
}

const SHELL_VERT = /* glsl */ `
uniform float uTime; uniform float uVoice; uniform float uPulse; uniform float uBoot; uniform float uPR; uniform float uScale;
uniform float uListen; uniform float uThink; uniform float uThinkPhase;
attribute vec3 aDir; attribute vec4 aParams; attribute vec3 aColor;
varying vec3 vColor; varying float vAlpha;
${SNOISE}
void main(){
  vec3 d = normalize(aDir);
  float a = uTime * 0.07 + uThinkPhase * 0.5;
  float ca = cos(a), sa = sin(a);
  d = vec3(ca * d.x + sa * d.z, d.y, -sa * d.x + ca * d.z);
  float n = snoise(d * 1.6 + vec3(0.0, uTime * 0.11, uTime * 0.07));
  float n2 = snoise(d * 4.2 - vec3(uTime * 0.2, 0.0, uTime * 0.13));
  float amp = 0.07 + 0.30 * uVoice + 0.12 * uPulse + 0.16 * uListen + 0.05 * uThink;
  float r = aParams.x * (1.0 + n * amp + n2 * amp * 0.35) * mix(0.35, 1.0, uBoot) * (1.0 + 0.08 * uVoice - 0.06 * uListen);
  vec3 p = d * r;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(aParams.z * uScale * uPR * (1.0 + 0.25 * uVoice) / -mv.z, 12.0 * uPR);
  float facing = 0.55 + 0.45 * smoothstep(-0.2, 0.9, d.z);
  vColor = aColor * (1.0 + 0.7 * uVoice + 0.45 * uPulse + 0.25 * n + 0.35 * uListen) * facing;
  vAlpha = uBoot * (aParams.w > 0.5 ? 0.6 : 0.9);
}`

// ── dátové víry (premýšľanie) ───────────────────────────────────────────

function vortexGeometry(count, rand) {
  const params = new Float32Array(count * 4)
  const color = new Float32Array(count * 3)
  const c = new THREE.Color()
  for (let i = 0; i < count; i++) {
    // Rameno víru: hlavný vír v rovine galaxie má štyri ramená, šikmé víry po tri.
    const plane = i % 5 < 3 ? 0 : i % 5 === 3 ? 1 : 2
    const arms = plane === 0 ? 4 : 3
    const arm = Math.floor(rand() * arms)
    params.set([rand(), (arm / arms) * Math.PI * 2 + (rand() - 0.5) * 0.32, plane, rand()], i * 4)
    c.copy(COLOR.ice).lerp(COLOR.cyan, rand())
    if (rand() < 0.1) c.copy(COLOR.amber)
    const dim = 0.35 + rand() * 0.65
    color.set([c.r * dim, c.g * dim, c.b * dim], i * 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  g.setAttribute('aP', new THREE.BufferAttribute(params, 4))
  g.setAttribute('aColor', new THREE.BufferAttribute(color, 3))
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5)
  return g
}

const VORTEX_VERT = /* glsl */ `
uniform float uTime; uniform float uThink; uniform float uThinkPhase; uniform float uPR; uniform float uScale; uniform float uBoot;
attribute vec4 aP; attribute vec3 aColor;
varying vec3 vColor; varying float vAlpha;
void main(){
  float life = fract(aP.x + uTime * (0.07 + 0.05 * aP.w));
  float plane = aP.z;
  float r = mix(plane < 0.5 ? 3.2 : 2.3, 0.6, pow(life, 0.8));
  float dir = plane > 1.5 ? -1.0 : 1.0;
  // Logaritmická špirála, ktorá sa otáča ako celok: ramená si držia tvar a tečú dnu.
  float th = aP.y + dir * (2.3 * log(r) + uThinkPhase * 1.5 + uTime * 0.1);
  vec3 p = vec3(cos(th) * r, sin(th * 2.0 + aP.y * 3.0) * 0.05 * r, sin(th) * r);
  if (plane > 0.5 && plane < 1.5) p = vec3(p.x, p.z * 0.94 + p.y, -p.z * 0.34);
  if (plane > 1.5) p = vec3(p.x * 0.5 + p.z * 0.1, p.z * 0.86, p.x * 0.86);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float fade = sin(3.14159 * life);
  gl_PointSize = min((1.1 + 1.8 * aP.w) * uScale * uPR * (0.6 + 0.6 * life) / -mv.z, 10.0 * uPR);
  vColor = aColor * (0.6 + 1.3 * life);
  vAlpha = fade * uThink * uBoot * (plane < 0.5 ? 0.9 : 0.6);
}`

// ── textúry ─────────────────────────────────────────────────────────────

function canvasTexture(size, draw) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  draw(ctx, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

export function glowTexture(stops) {
  return canvasTexture(256, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
    for (const [at, alpha] of stops) g.addColorStop(at, `rgba(255,255,255,${alpha})`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, s, s)
  })
}

export function ringTexture(width, dashed, size = 256) {
  return canvasTexture(size, (ctx, s) => {
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'
    ctx.lineWidth = width
    if (dashed) ctx.setLineDash([10, 9])
    ctx.beginPath()
    ctx.arc(s / 2, s / 2, s / 2 - width - 2, 0, Math.PI * 2)
    ctx.stroke()
  })
}

/** Mäkký prstenec (vlna svetla): gaussovský profil okolo polomeru. */
function softRingTexture(size = 512) {
  return canvasTexture(size, (ctx, s) => {
    const img = ctx.createImageData(s, s)
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const dx = (x + 0.5) / s - 0.5
        const dy = (y + 0.5) / s - 0.5
        const r = Math.sqrt(dx * dx + dy * dy) * 2
        const a = Math.exp(-Math.pow((r - 0.9) / 0.018, 2)) + 0.22 * Math.exp(-Math.pow((r - 0.87) / 0.055, 2))
        const i = (y * s + x) * 4
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255
        img.data[i + 3] = Math.round(clamp(a) * 255)
      }
    }
    ctx.putImageData(img, 0, 0)
  })
}

function streakTexture() {
  return canvasTexture(512, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.25, 'rgba(255,255,255,0.35)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, s, s)
  })
}

/** Text po oblúku. Písmená smerujú hlavou von, číta sa v smere hodinových ručičiek. */
function arcText(ctx, text, cx, cy, radius, start, px, tracking, limit = Infinity) {
  ctx.save()
  ctx.font = `500 ${px}px "JetBrains Mono", ui-monospace, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  let a = start
  for (const ch of text) {
    const w = ctx.measureText(ch).width + tracking
    const da = w / radius
    if (a + da > limit) break
    a += da / 2
    ctx.save()
    ctx.translate(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius)
    ctx.rotate(a + Math.PI / 2)
    ctx.fillText(ch, 0, 0)
    ctx.restore()
    a += da / 2
  }
  ctx.restore()
  return a
}

function dialA(size, span) {
  return canvasTexture(size, (ctx, s) => {
    const k = s / span
    const c = s / 2
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.lineCap = 'round'
    ctx.lineWidth = 2
    for (let q = 0; q < 4; q++) {
      ctx.beginPath()
      ctx.arc(c, c, R.dialA * k, q * (Math.PI / 2) + 0.06, (q + 1) * (Math.PI / 2) - 0.06)
      ctx.stroke()
    }
    for (let d = 0; d < 360; d += 2) {
      const a = (d * Math.PI) / 180
      if (d % 90 < 4 || d % 90 > 86) continue
      const major = d % 10 === 0
      const r0 = (R.dialA + 0.025) * k
      const r1 = (R.dialA + (major ? 0.085 : 0.045)) * k
      ctx.lineWidth = major ? 2.2 : 1.4
      ctx.globalAlpha = major ? 0.95 : 0.55
      ctx.beginPath()
      ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0)
      ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1)
      ctx.stroke()
    }
  })
}

function dialB(size, span, text) {
  return canvasTexture(size, (ctx, s) => {
    const k = s / span
    const c = s / 2
    ctx.fillStyle = 'rgba(255,255,255,0.92)'
    arcText(ctx, text, c, c, (R.dialB - 0.005) * k, -Math.PI / 2 + 0.25, 0.072 * k, 0.018 * k, -Math.PI / 2 + 0.25 + Math.PI * 1.45)
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 2.4
    ctx.lineCap = 'butt'
    const arcs = [
      [Math.PI * 1.02 + 0.3, Math.PI * 1.36 + 0.25],
      [Math.PI * 1.42 + 0.25, Math.PI * 1.5 + 0.25],
    ]
    for (const [from, to] of arcs) {
      ctx.beginPath()
      ctx.arc(c, c, (R.dialB + 0.075) * k, from, to)
      ctx.stroke()
    }
    ctx.lineWidth = 1.2
    ctx.globalAlpha = 0.5
    ctx.beginPath()
    ctx.arc(c, c, (R.dialB - 0.075) * k, 0, Math.PI * 2)
    ctx.stroke()
  })
}

function dialC(size, span) {
  return canvasTexture(size, (ctx, s) => {
    const k = s / span
    const c = s / 2
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    for (let d = 0; d < 360; d += 2) {
      const a = ((d - 90) * Math.PI) / 180
      const major = d % 30 === 0
      const mid = d % 10 === 0
      const r0 = R.dialC * k
      const r1 = (R.dialC + (major ? 0.07 : mid ? 0.045 : 0.025)) * k
      ctx.lineWidth = major ? 2.2 : 1.2
      ctx.globalAlpha = major ? 0.9 : mid ? 0.55 : 0.32
      ctx.beginPath()
      ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0)
      ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1)
      ctx.stroke()
      if (major) {
        ctx.globalAlpha = 0.75
        arcText(ctx, String(d).padStart(3, '0'), c, c, (R.dialC + 0.135) * k, a - 0.055, 0.058 * k, 0.01 * k)
      }
    }
    ctx.globalAlpha = 0.9
    for (let q = 0; q < 4; q++) {
      const a = q * (Math.PI / 2) - Math.PI / 2
      const r = (R.dialC - 0.03) * k
      ctx.save()
      ctx.translate(c + Math.cos(a) * r, c + Math.sin(a) * r)
      ctx.rotate(a + Math.PI / 2)
      ctx.beginPath()
      ctx.moveTo(-0.022 * k, 0)
      ctx.lineTo(0.022 * k, 0)
      ctx.lineTo(0, 0.04 * k)
      ctx.closePath()
      ctx.fill()
      ctx.restore()
    }
  })
}

function dialMesh(texture, span, color, opacity) {
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  })
  return new THREE.Mesh(new THREE.PlaneGeometry(span, span), mat)
}

function accentArc() {
  const geo = new THREE.RingGeometry(R.accent - 0.012, R.accent + 0.012, 256, 1)
  const mat = new THREE.ShaderMaterial({
    uniforms: { uStart: { value: 0 }, uLen: { value: 0.05 }, uColor: { value: COLOR.amber.clone() }, uGain: { value: 1 } },
    vertexShader: /* glsl */ `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uStart; uniform float uLen; uniform vec3 uColor; uniform float uGain; varying vec2 vP;
      void main(){
        float a = fract(atan(vP.y, vP.x) / 6.28318 - uStart);
        float on = smoothstep(0.0, 0.01, a) * smoothstep(uLen, uLen - 0.012, a);
        if (on < 0.01) discard;
        gl_FragColor = vec4(uColor * on * uGain, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    transparent: true,
  })
  return new THREE.Mesh(geo, mat)
}

const lineMat = (color, opacity) =>
  new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false })

// ── zostavenie ──────────────────────────────────────────────────────────

/**
 * @param {object} U zdieľané uniformy sveta
 * @param {{ high: boolean, rand: () => number, ringText: string }} o
 */
export function createHeart(U, { high, rand, ringText }) {
  const root = new THREE.Group()
  root.name = 'heart'

  // Galaxia v naklonenej rovine.
  const galaxyGroup = new THREE.Group()
  galaxyGroup.rotation.set(0.66, 0, 0.16)
  const galaxyUniforms = { uTime: U.uTime, uVoice: U.uVoice, uPulse: U.uPulse, uBoot: U.uBoot, uPR: U.uPR, uScale: U.uScale, uThinkPhase: U.uThinkPhase, uListen: U.uListen, uSpin: { value: 0 } }
  const galaxy = new THREE.Points(galaxyGeometry(high ? 18000 : 7000, rand), pointMaterial(GALAXY_VERT, galaxyUniforms))
  galaxy.frustumCulled = false
  galaxyGroup.add(galaxy)
  const vortex = new THREE.Points(
    vortexGeometry(high ? 3200 : 1400, rand),
    pointMaterial(VORTEX_VERT, { uTime: U.uTime, uThink: U.uThink, uThinkPhase: U.uThinkPhase, uPR: U.uPR, uScale: U.uScale, uBoot: U.uBoot }),
  )
  vortex.frustumCulled = false
  galaxyGroup.add(vortex)
  root.add(galaxyGroup)

  const shell = new THREE.Points(
    shellGeometry(high ? 4200 : 1800, rand),
    pointMaterial(SHELL_VERT, { uTime: U.uTime, uVoice: U.uVoice, uPulse: U.uPulse, uBoot: U.uBoot, uPR: U.uPR, uScale: U.uScale, uListen: U.uListen, uThink: U.uThink, uThinkPhase: U.uThinkPhase }),
  )
  shell.frustumCulled = false
  root.add(shell)

  // Žiara jadra: horúci stred, tyrkysové jadro, azúrové halo, anamorfný záblesk.
  const glow = glowTexture([[0, 1], [0.18, 0.62], [0.45, 0.16], [1, 0]])
  const sprite = (tex, color, opacity) => {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }),
    )
    root.add(s)
    return s
  }
  const halo = sprite(glow, COLOR.azure, 0.08)
  const coreGlow = sprite(glow, COLOR.cyan, 0.4)
  const hot = sprite(glow, COLOR.ice, 0.9)
  const streak = sprite(streakTexture(), COLOR.cyan, 0.32)
  const shock = sprite(ringTexture(2, false, 1024), COLOR.cyan, 0)

  // Ciferníky, oblúk hlasu, vlna hlasu, prstenec počúvania, vlny reči.
  const dials = new THREE.Group()
  dials.rotation.set(0.1, -0.12, 0)
  root.add(dials)
  const span = (R.dialC + 0.32) * 2
  const texSize = high ? 2048 : 1024
  const dA = dialMesh(dialA(texSize, span), span, COLOR.cyan, 0.55)
  const dB = dialMesh(dialB(texSize, span, ringText), span, COLOR.cyan, 0.5)
  const dC = dialMesh(dialC(texSize, span), span, COLOR.cyan, 0.36)
  dials.add(dA, dB, dC)
  const accent = accentArc()
  dials.add(accent)

  const VOICE_POINTS = 256
  const voiceGeo = new THREE.BufferGeometry()
  voiceGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(VOICE_POINTS * 3), 3))
  const voiceMat = lineMat(COLOR.cyan, 0.7)
  const voiceRing = new THREE.LineLoop(voiceGeo, voiceMat)
  voiceRing.frustumCulled = false
  dials.add(voiceRing)

  const LISTEN_POINTS = 320
  const listenGeo = new THREE.BufferGeometry()
  listenGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LISTEN_POINTS * 3), 3))
  const listenMat = lineMat(COLOR.ice, 0)
  const listenRing = new THREE.LineLoop(listenGeo, listenMat)
  listenRing.frustumCulled = false
  dials.add(listenRing)
  const listenGeo2 = new THREE.BufferGeometry()
  listenGeo2.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LISTEN_POINTS * 3), 3))
  const listenMat2 = lineMat(COLOR.cyan, 0)
  const listenRing2 = new THREE.LineLoop(listenGeo2, listenMat2)
  listenRing2.frustumCulled = false
  dials.add(listenRing2)

  const softRing = softRingTexture(high ? 512 : 256)
  const waves = []
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: softRing, color: COLOR.cyan, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide }),
    )
    dials.add(m)
    waves.push(m)
  }

  // Orbity so satelitmi.
  const orbits = []
  for (const [radius, rx, ry, speed] of [[2.55, 1.18, 0.32, 0.05], [3.05, 1.3, -0.42, -0.032]]) {
    const curve = new THREE.EllipseCurve(0, 0, radius, radius, 0, Math.PI * 2)
    const pts = curve.getPoints(220).map((p) => new THREE.Vector3(p.x, p.y, 0))
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color: COLOR.cyan, dashSize: 0.05, gapSize: 0.06, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }),
    )
    line.computeLineDistances()
    const group = new THREE.Group()
    group.rotation.set(rx, ry, 0)
    group.add(line)
    const sat = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: COLOR.ice, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }))
    sat.scale.setScalar(0.12)
    group.add(sat)
    root.add(group)
    orbits.push({ group, sat, radius, speed })
  }

  const voiceArr = voiceGeo.attributes.position.array
  const listenArr = listenGeo.attributes.position.array
  const listenArr2 = listenGeo2.attributes.position.array
  const BANDS = 24
  const bands = new Float32Array(BANDS)
  const smoothBands = new Float32Array(BANDS)

  /**
   * s: { T, voice, pulse, boot, ignite, igniteT, shockT, wave, listen, think, thinkPhase, speak, listenEnv, spin }
   */
  function update(s) {
    const T = s.T
    const v = s.voice
    const b = s.boot
    const ig = s.ignite
    const igniteSpin = 2.4 * (1 - Math.exp(-Math.max(0, s.igniteT) / 0.45)) * (s.igniteT >= 0 ? 1 : 0)
    const tp = s.thinkPhase
    galaxyUniforms.uSpin.value = s.spin
    dA.rotation.z = T * 0.05 + igniteSpin + tp * 0.9
    dB.rotation.z = -T * 0.024 - igniteSpin * 0.6 - tp * 0.5
    dC.rotation.z = T * 0.008 + igniteSpin * 0.25 + tp * 0.22
    const thinkGlow = 0.18 * s.think
    dA.material.opacity = (0.5 + 0.35 * v + 0.3 * ig + thinkGlow + 0.15 * s.listenEnv) * b
    dB.material.opacity = (0.45 + 0.25 * v + 0.3 * ig + thinkGlow) * b
    dC.material.opacity = (0.3 + 0.12 * v + 0.25 * ig + thinkGlow * 0.6) * b
    accent.rotation.z = -T * 0.09 - tp * 0.7
    accent.material.uniforms.uLen.value = 0.03 + 0.15 * v + 0.06 * s.pulse + 0.1 * s.listen
    accent.material.uniforms.uGain.value = (0.55 + 0.5 * v + 0.4 * s.listen) * b

    hot.scale.setScalar((0.34 + 0.16 * v + 0.08 * s.pulse + 0.4 * ig + 0.05 * s.think - 0.04 * s.listenEnv) * b)
    coreGlow.scale.setScalar((1.3 + 0.45 * v + 0.3 * s.pulse + 1.0 * ig + 0.2 * s.think) * b)
    coreGlow.material.opacity = 0.36 + 0.22 * v + 0.2 * ig + 0.1 * s.think
    halo.scale.setScalar(6.2 + 1.6 * v + 2 * ig)
    halo.material.opacity = (0.06 + 0.06 * v + 0.12 * ig) * b
    streak.scale.set((3.0 + 1.6 * v + 2.4 * ig) * b, 0.07 + 0.04 * v, 1)
    streak.material.opacity = (0.16 + 0.22 * v + 0.35 * ig) * b
    const shockAge = s.shockT
    if (shockAge >= 0 && shockAge < 1.6) {
      shock.scale.setScalar(1.6 + shockAge * 5.2)
      shock.material.opacity = 0.42 * Math.pow(1 - shockAge / 1.6, 2)
    } else shock.material.opacity = 0

    // Vlna hlasu po obvode: energia v 24 pásmach, vyhladená a zrkadlená bez švu.
    const wave = s.wave
    const n = wave ? wave.length : 0
    for (let j = 0; j < BANDS; j++) {
      let sum = 0
      if (n) {
        const from = Math.floor((j / BANDS) * n)
        const to = Math.max(from + 1, Math.floor(((j + 1) / BANDS) * n))
        for (let i = from; i < to; i++) sum += Math.abs(wave[i])
        sum /= to - from
      }
      bands[j] = sum
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < BANDS; j++) smoothBands[j] = (bands[Math.max(0, j - 1)] + 2 * bands[j] + bands[Math.min(BANDS - 1, j + 1)]) / 4
      bands.set(smoothBands)
    }
    for (let k = 0; k < VOICE_POINTS; k++) {
      const a = (k / VOICE_POINTS) * Math.PI * 2
      const half = k < VOICE_POINTS / 2 ? k : VOICE_POINTS - 1 - k
      const x = (half / (VOICE_POINTS / 2)) * (BANDS - 1)
      const j = Math.floor(x)
      const energy = bands[j] + (bands[Math.min(BANDS - 1, j + 1)] - bands[j]) * (x - j)
      const idle = 0.006 * Math.sin(a * 6 + T * 0.8) + 0.004 * Math.sin(a * 13 - T * 1.3)
      const r = R.voice + idle + energy * 0.14 * (0.6 + 0.4 * Math.sin(a * 3 + T * 2.1))
      voiceArr[k * 3] = Math.cos(a + Math.PI / 2) * r
      voiceArr[k * 3 + 1] = Math.sin(a + Math.PI / 2) * r
      voiceArr[k * 3 + 2] = 0
    }
    voiceGeo.attributes.position.needsUpdate = true
    voiceMat.opacity = (0.32 + 0.6 * v) * b

    // Prstenec počúvania: hlas používateľa ako postupujúce vlny po obvode (ľadová biela).
    const L = s.listen
    const le = s.listenEnv
    for (let k = 0; k < LISTEN_POINTS; k++) {
      const a = (k / LISTEN_POINTS) * Math.PI * 2
      const w1 = Math.sin(a * 7 - T * 3.1) * 0.6 + Math.sin(a * 13 + T * 4.3) * 0.3 + Math.sin(a * 3 - T * 1.7) * 0.4
      const w2 = Math.sin(a * 9 + T * 2.6 + 1.3) * 0.5 + Math.sin(a * 5 - T * 3.7) * 0.4
      const r1 = R.listen + le * (0.004 + L * 0.075 * w1)
      const r2 = R.listen + 0.018 + le * (0.003 + L * 0.05 * w2)
      listenArr[k * 3] = Math.cos(a) * r1
      listenArr[k * 3 + 1] = Math.sin(a) * r1
      listenArr2[k * 3] = Math.cos(a) * r2
      listenArr2[k * 3 + 1] = Math.sin(a) * r2
    }
    listenGeo.attributes.position.needsUpdate = true
    listenGeo2.attributes.position.needsUpdate = true
    listenMat.opacity = le * (0.35 + 0.65 * Math.min(1, L * 1.6)) * b
    listenMat2.opacity = le * (0.15 + 0.4 * Math.min(1, L * 1.6)) * b

    // Svetelné vlny z jadra, kým Jarvis hovorí.
    for (let i = 0; i < waves.length; i++) {
      const ph = (T * 0.62 + i / waves.length) % 1
      const m = waves[i]
      m.scale.setScalar(R.voice * 0.95 + ph * 3.3)
      m.material.opacity = s.speak * Math.pow(1 - ph, 1.8) * smoothRise(ph) * (0.03 + 0.2 * v) * b
    }

    for (const o of orbits) {
      const a = T * o.speed * 2 + o.radius
      o.sat.position.set(Math.cos(a) * o.radius, Math.sin(a) * o.radius, 0)
    }
  }

  return { root, update, objects: { galaxy, shell, vortex, halo, coreGlow, hot, streak, shock, dials, orbits, waves } }
}

const smoothRise = (x) => clamp(x / 0.08)
