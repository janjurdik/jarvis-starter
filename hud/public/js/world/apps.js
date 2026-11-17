// Planéta „Tvoje appky": ikony appiek, ktoré si používateľ vybral na stránke /apps/, plávajú ako
// sklenené bubliny okolo jemného jadra. Pri hoveri sa rozvlnia ako tekutina (vlna ide od ikony
// k ikone), pri focuse sa roztiahnu. Kým nič nevybral, plávajú tu matne najčastejšie appky
// ako pozvánka.
//
// Ikony sa menia za behu: setWorldApps(ids) z main.js (načítanie a SSE `apps`).

import * as THREE from 'three'
import { APP_BY_ID } from '../../apps/catalog.js'
import { appColor, appShape, isDark } from '../../apps/glyph.js'
import { FOG } from './glsl.js'

const TAU = Math.PI * 2
const MAX = 18
const INVITE = ['instagram', 'whatsapp', 'gmail', 'googlecalendar', 'spotify', 'chatgpt']
const TEX = 160

let live = null
let pending = null

/** Zmení ikony na planéte. Volá sa pred aj po postavení sveta. */
export function setWorldApps(ids) {
  pending = Array.isArray(ids) ? ids.filter((id) => APP_BY_ID.has(id)) : []
  live?.set(pending)
}

/** Sklenená bublina s glyfom appky na plátne (bez siete, všetko lokálne). */
function iconTexture(app) {
  const c = document.createElement('canvas')
  c.width = c.height = TEX
  const g = c.getContext('2d')
  const hex = appColor(app)
  const dark = isDark(hex)
  const tint = dark ? '#cfe3e8' : hex
  const r = TEX / 2
  // telo bubliny: farba značky smerom k okraju, svetlý odlesk hore vľavo
  const body = g.createRadialGradient(r * 0.78, r * 0.7, r * 0.1, r, r, r * 0.98)
  body.addColorStop(0, 'rgba(255,255,255,0.20)')
  body.addColorStop(0.55, `${tint}33`)
  body.addColorStop(0.9, `${tint}66`)
  body.addColorStop(1, `${tint}00`)
  g.fillStyle = body
  g.beginPath()
  g.arc(r, r, r * 0.96, 0, TAU)
  g.fill()
  g.lineWidth = 2.2
  g.strokeStyle = `${tint}aa`
  g.beginPath()
  g.arc(r, r, r * 0.86, 0, TAU)
  g.stroke()
  const shine = g.createRadialGradient(r * 0.62, r * 0.5, 0, r * 0.62, r * 0.5, r * 0.5)
  shine.addColorStop(0, 'rgba(255,255,255,0.55)')
  shine.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = shine
  g.beginPath()
  g.ellipse(r * 0.66, r * 0.5, r * 0.42, r * 0.26, -0.5, 0, TAU)
  g.fill()
  // glyf
  const shape = appShape(app)
  const s = TEX * 0.42
  g.save()
  g.shadowColor = tint
  g.shadowBlur = 16
  g.fillStyle = dark ? '#f2fbff' : '#ffffff'
  if (shape.d) {
    g.translate(r - s / 2, r - s / 2)
    g.scale(s / 24, s / 24)
    g.fill(new Path2D(shape.d))
  } else {
    g.font = `700 ${shape.text.length > 1 ? s * 0.62 : s * 0.82}px "Inter Tight", system-ui, sans-serif`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(shape.text, r, r + 2)
  }
  g.restore()
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

const VERT = /* glsl */ `
${FOG}
uniform float uTime; uniform float uWobble; uniform float uSeed;
varying vec2 vUv; varying float vFog;
void main(){
  vUv = uv;
  vec3 p = position;
  // tekutina: povrch sa vlní dvoma vlnami, okraj viac ako stred
  float r = length(uv - 0.5) * 2.0;
  float w = sin(uv.x * 9.0 + uTime * 4.2 + uSeed) * cos(uv.y * 8.0 - uTime * 3.6 + uSeed * 1.7);
  p.z += uWobble * 0.09 * w * (0.4 + r);
  p.xy *= 1.0 + uWobble * 0.06 * sin(uTime * 6.0 + uSeed + r * 5.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vFog = fogFade(-mv.z);
}`

const FRAG = /* glsl */ `
uniform sampler2D map; uniform float uTime; uniform float uWobble; uniform float uSeed; uniform float uAlpha; uniform float uBoot;
varying vec2 vUv; varying float vFog;
void main(){
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  float r = length(d) * 2.0;
  // lom svetla ako v kvapke: obraz sa za vlnou posúva a jemne zväčšuje v strede
  uv += uWobble * 0.035 * vec2(sin(vUv.y * 13.0 + uTime * 5.0 + uSeed), cos(vUv.x * 11.0 + uTime * 4.4 + uSeed));
  uv = 0.5 + (uv - 0.5) * (1.0 - uWobble * 0.06 * (1.0 - r));
  vec4 c = texture2D(map, uv);
  float edge = smoothstep(1.0, 0.86, r);
  float a = c.a * edge * uAlpha * uBoot * (0.35 + 0.65 * vFog);
  if (a < 0.004) discard;
  gl_FragColor = vec4(c.rgb, a);
}`

export function buildApps({ NU, U }) {
  const group = new THREE.Group()
  const holder = new THREE.Group()
  group.add(holder)
  const plane = new THREE.PlaneGeometry(1, 1, 16, 16)

  // jadro: malá žiariaca kvapka, ku ktorej ikony patria
  const coreMat = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uBoot: U.uBoot, uGain: NU.uGain },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uTime; uniform float uBoot; uniform float uGain; varying vec2 vUv;
      void main(){ vec2 d = vUv - 0.5; float r = length(d) * 2.0;
        float ring = smoothstep(0.08, 0.0, abs(r - 0.55 - 0.03 * sin(uTime * 1.3 + atan(d.y, d.x) * 3.0)));
        float core = exp(-r * r * 9.0);
        float a = (0.55 * core + 0.35 * ring) * uBoot * (0.6 + uGain);
        if (a < 0.004) discard; gl_FragColor = vec4(vec3(0.5, 0.95, 1.0) * a, 1.0); }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const core = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), coreMat)
  core.frustumCulled = false
  group.add(core)

  let icons = []
  let invite = true

  function clear() {
    for (const i of icons) {
      holder.remove(i.mesh)
      i.mesh.material.uniforms.map.value.dispose()
      i.mesh.material.dispose()
    }
    icons = []
  }

  function set(ids) {
    clear()
    invite = !ids.length
    const list = (invite ? INVITE : ids).slice(0, MAX).map((id) => APP_BY_ID.get(id)).filter(Boolean)
    const n = list.length
    icons = list.map((app, i) => {
      const seed = i * 2.399 + 0.7
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          map: { value: iconTexture(app) },
          uTime: U.uTime,
          uBoot: U.uBoot,
          uFogNear: U.uFogNear,
          uFogFar: U.uFogFar,
          uWobble: { value: 0 },
          uSeed: { value: seed },
          uAlpha: { value: invite ? 0.38 : 1 },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
      })
      const mesh = new THREE.Mesh(plane, mat)
      mesh.frustumCulled = false
      holder.add(mesh)
      // Fibonacciho guľa: ikony sa rozložia rovnomerne aj pri 3 aj pri 18 kusoch.
      const y = n === 1 ? 0 : 1 - (2 * (i + 0.5)) / n
      const ring = Math.sqrt(1 - y * y)
      const a = i * 2.39996
      return { app, mesh, seed, base: new THREE.Vector3(Math.cos(a) * ring, y * 0.78, Math.sin(a) * ring), born: -1 }
    })
  }

  const tmp = new THREE.Vector3()
  live = { set }
  set(pending ?? [])

  return {
    group,
    update(T, s) {
      const open = 0.92 + 0.22 * s.focus + 0.08 * s.hover
      holder.rotation.y = T * 0.07 + s.phase * 0.02
      core.scale.setScalar(0.85 + 0.1 * Math.sin(T * 1.1) + 0.25 * s.hover)
      const count = icons.length || 1
      const size = (count > 10 ? 0.34 : 0.42) * (1 + 0.12 * s.focus)
      for (const [i, ic] of icons.entries()) {
        // The pop-in runs on the wall clock: world time T can jump while the HUD boots.
        const wall = performance.now() / 1000
        if (ic.born < 0) ic.born = wall + i * 0.08
        const grow = Math.min(1, Math.max(0, (wall - ic.born) / 0.6))
        const pop = 1 - Math.pow(1 - grow, 3)
        tmp.copy(ic.base).multiplyScalar(open)
        tmp.y += 0.05 * Math.sin(T * 0.8 + ic.seed)
        ic.mesh.position.copy(tmp)
        // ikona sa vždy pozerá ku kamere (proti rotácii držiaka), takže glyf je čitateľný
        ic.mesh.rotation.y = -holder.rotation.y
        // hover: vlna ide od ikony k ikone, focus drží ikony jemne živé
        const wave = 0.5 + 0.5 * Math.sin(T * 3.2 - i * 0.9)
        const wobble = s.hover * (0.55 + 0.45 * wave) + 0.18 * s.focus
        ic.mesh.material.uniforms.uWobble.value += (wobble - ic.mesh.material.uniforms.uWobble.value) * 0.12
        ic.mesh.scale.setScalar(size * pop * (1 + 0.08 * s.hover * wave))
        ic.mesh.material.uniforms.uAlpha.value = (invite ? 0.32 + 0.3 * s.hover : 0.92 + 0.08 * s.act) * pop
      }
    },
  }
}
