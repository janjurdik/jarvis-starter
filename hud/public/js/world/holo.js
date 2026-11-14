// Holografické materiály uzlov: svietiace čiary, priesvitné plochy s fresnelovým
// okrajom a skenovacím pásom. Každý uzol má vlastné inštancie (vlastné teplo, jas).

import * as THREE from 'three'
import { FOG } from './glsl.js'

const additive = { blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true }

/** Uniformy jedného uzla, zdieľané všetkými jeho materiálmi. */
export function nodeUniforms(U, color, hot, seed) {
  return {
    uTime: U.uTime,
    uBoot: U.uBoot,
    uFogNear: U.uFogNear,
    uFogFar: U.uFogFar,
    uColor: { value: color.clone() },
    uHot: { value: hot.clone() },
    uHeat: { value: 0 },
    uGain: { value: 1 },
    uScan: { value: -9 },
    uScanAmt: { value: 0 },
    uSeed: { value: seed },
    uPhase: { value: 0 },
    uAct: { value: 0 },
  }
}

const LINE_VERT = /* glsl */ `
${FOG}
attribute float aAlpha;
varying float vA; varying vec3 vObj; varying float vFog;
void main(){
  vObj = position;
  vA = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vFog = fogFade(-mv.z);
}`

const LINE_FRAG = /* glsl */ `
uniform float uTime; uniform float uBoot; uniform vec3 uColor; uniform vec3 uHot; uniform float uHeat; uniform float uGain;
uniform float uScan; uniform float uScanAmt; uniform float uSeed; uniform float uOpacity; uniform float uTint;
varying float vA; varying vec3 vObj; varying float vFog;
void main(){
  float scan = smoothstep(0.16, 0.0, abs(vObj.y - uScan)) * uScanAmt;
  float flick = 0.93 + 0.07 * sin(uTime * 21.0 + uSeed * 7.0) * sin(uTime * 6.3 + uSeed * 3.0);
  vec3 c = mix(uColor, uHot, clamp(uHeat + uTint, 0.0, 1.0));
  c = c * (1.0 + 1.6 * scan) + vec3(0.5, 0.7, 0.75) * scan * 0.4;
  gl_FragColor = vec4(c * vA * uOpacity * uGain * flick * vFog * uBoot, 1.0);
}`

/** Čiary uzla. Geometria musí mať atribút aAlpha (pozri lineGeometry). */
export function holoLine(NU, opacity = 1, tint = 0) {
  return new THREE.ShaderMaterial({
    uniforms: { ...NU, uOpacity: { value: opacity }, uTint: { value: tint } },
    vertexShader: LINE_VERT,
    fragmentShader: LINE_FRAG,
    ...additive,
  })
}

/** LineSegments geometria zo zoznamu úsečiek [[x,y,z],[x,y,z], alpha?]. */
export function segmentsGeometry(segments) {
  const pos = new Float32Array(segments.length * 6)
  const alpha = new Float32Array(segments.length * 2)
  segments.forEach(([a, b, al = 1, al2 = al], i) => {
    pos.set(a, i * 6)
    pos.set(b, i * 6 + 3)
    alpha[i * 2] = al
    alpha[i * 2 + 1] = al2
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1))
  return g
}

/** Uzavretá krivka ako úsečky (bez LineLoop, aby šla do jedného LineSegments). */
export function loopSegments(points, alpha = 1) {
  const out = []
  for (let i = 0; i < points.length; i++) out.push([points[i], points[(i + 1) % points.length], alpha])
  return out
}

export function circlePoints(radius, n, y = 0, plane = 'xz', from = 0, to = Math.PI * 2, closed = true) {
  const pts = []
  const count = closed ? n : n + 1
  for (let i = 0; i < count; i++) {
    const a = from + ((to - from) * i) / n
    const c = Math.cos(a) * radius
    const s = Math.sin(a) * radius
    pts.push(plane === 'xz' ? [c, y, s] : plane === 'xy' ? [c, s, y] : [y, c, s])
  }
  return pts
}

export function polySegments(points, alpha = 1) {
  const out = []
  for (let i = 0; i < points.length - 1; i++) out.push([points[i], points[i + 1], alpha])
  return out
}

const SURF_VERT = /* glsl */ `
${FOG}
varying vec3 vN; varying vec3 vV; varying vec3 vObj; varying float vFog;
void main(){
  vObj = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
  vFog = fogFade(-mv.z);
}`

const SURF_FRAG = /* glsl */ `
uniform float uTime; uniform float uBoot; uniform vec3 uColor; uniform vec3 uHot; uniform float uHeat; uniform float uGain;
uniform float uScan; uniform float uScanAmt; uniform float uSeed; uniform float uFill; uniform float uRim; uniform float uLines; uniform float uTint;
varying vec3 vN; varying vec3 vV; varying vec3 vObj; varying float vFog;
void main(){
  vec3 n = normalize(vN);
  float fres = pow(1.0 - abs(dot(n, normalize(vV))), 2.2);
  float lines = smoothstep(0.55, 1.0, sin(vObj.y * 90.0 - uTime * 2.5) * 0.5 + 0.5);
  float scan = smoothstep(0.16, 0.0, abs(vObj.y - uScan)) * uScanAmt;
  vec3 c = mix(uColor, uHot, clamp(uHeat + uTint, 0.0, 1.0));
  float k = uFill + uRim * fres + uLines * lines * (0.3 + fres) + scan * 0.35;
  gl_FragColor = vec4(c * k * uGain * vFog * uBoot, 1.0);
}`

export function holoSurface(NU, { fill = 0.05, rim = 0.5, lines = 0.08, tint = 0, side = THREE.DoubleSide } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...NU, uFill: { value: fill }, uRim: { value: rim }, uLines: { value: lines }, uTint: { value: tint } },
    vertexShader: SURF_VERT,
    fragmentShader: SURF_FRAG,
    side,
    ...additive,
  })
}

export const ADDITIVE = additive
