// Toky dát z uzlov do jadra. Základný tok (z v1) je jemný a rozžiari sa pri udalosti
// na uzle. Keď Jarvis na uzle pracuje (f.toolNodes), z uzla do jadra tečie hustý prúd
// častíc stočený do špirály okolo krivky.

import * as THREE from 'three'
import { SOFT_POINT_FRAG } from './glsl.js'
import { COLOR } from './heart.js'

export const MAX_LINKS = 24

const FLOW_VERT = /* glsl */ `
uniform vec3 uA[${MAX_LINKS}]; uniform vec3 uB[${MAX_LINKS}]; uniform vec3 uC[${MAX_LINKS}];
uniform float uFlare[${MAX_LINKS}]; uniform float uPhase[${MAX_LINKS}]; uniform float uOn[${MAX_LINKS}]; uniform float uTool[${MAX_LINKS}];
uniform float uPR; uniform float uScale; uniform float uBoot; uniform float uTime;
uniform vec3 uCold; uniform vec3 uWarm; uniform vec3 uIce;
attribute float aLink; attribute float aOff; attribute float aSize; attribute vec3 aSpin;
varying vec3 vColor; varying float vAlpha;
void main(){
  int i = int(aLink + 0.5);
  bool tool = aSpin.z > 0.5;
  float tl = uTool[i];
  float s = tool ? fract(aOff + uTime * (0.32 + 0.1 * aSpin.y)) : fract(uPhase[i] + aOff);
  vec3 a = mix(uA[i], uB[i], s);
  vec3 b = mix(uB[i], uC[i], s);
  vec3 p = mix(a, b, s);
  if (tool) {
    vec3 tng = normalize(b - a + 1e-5);
    vec3 n1 = normalize(cross(tng, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
    vec3 n2 = cross(tng, n1);
    float ang = aSpin.x * 6.2831 + s * 16.0 - uTime * 2.6;
    float rad = (0.03 + 0.07 * aSpin.y) * sin(3.14159 * s) * (0.55 + 0.45 * tl);
    p += (n1 * cos(ang) + n2 * sin(ang)) * rad;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float f = uFlare[i];
  if (tool) {
    gl_PointSize = min(aSize * uScale * uPR * (0.7 + 0.8 * s) * 1.15 / -mv.z, 12.0 * uPR);
    vColor = mix(uIce, uCold, 0.35 + 0.4 * aSpin.y) * (1.1 + 1.6 * s);
    vAlpha = sin(3.14159 * s) * (0.45 + 0.55 * s) * tl * uOn[i] * uBoot;
  } else {
    gl_PointSize = min(aSize * uScale * uPR * (0.6 + 0.7 * s) * (1.0 + 0.9 * f) / -mv.z, 12.0 * uPR);
    vColor = mix(uCold, uWarm, clamp(f * 0.8, 0.0, 1.0)) * (0.8 + 1.8 * f);
    vAlpha = sin(3.14159 * s) * (0.3 + 0.7 * s) * (0.55 + 1.4 * f) * uOn[i] * uBoot;
  }
}`

function flowGeometry(base, tool, rand) {
  const per = base + tool
  const count = per * MAX_LINKS
  const link = new Float32Array(count)
  const off = new Float32Array(count)
  const size = new Float32Array(count)
  const spin = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const k = i % per
    const isTool = k >= base
    link[i] = Math.floor(i / per)
    off[i] = isTool ? rand() : k / base + rand() * 0.02
    size[i] = isTool ? 0.7 + Math.pow(rand(), 2) * 1.8 : 0.9 + rand() * 1.4
    spin.set([rand(), rand(), isTool ? 1 : 0], i * 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  g.setAttribute('aLink', new THREE.BufferAttribute(link, 1))
  g.setAttribute('aOff', new THREE.BufferAttribute(off, 1))
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
  g.setAttribute('aSpin', new THREE.BufferAttribute(spin, 3))
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20)
  return g
}

export function createFlows(U, { high, rand }) {
  const uniforms = {
    uA: { value: Array.from({ length: MAX_LINKS }, () => new THREE.Vector3()) },
    uB: { value: Array.from({ length: MAX_LINKS }, () => new THREE.Vector3()) },
    uC: { value: Array.from({ length: MAX_LINKS }, () => new THREE.Vector3()) },
    uFlare: { value: new Array(MAX_LINKS).fill(0) },
    uPhase: { value: new Array(MAX_LINKS).fill(0) },
    uTool: { value: new Array(MAX_LINKS).fill(0) },
    uOn: { value: new Array(MAX_LINKS).fill(0) },
    uPR: U.uPR,
    uScale: U.uScale,
    uBoot: U.uBoot,
    uTime: U.uTime,
    uCold: { value: COLOR.cyan.clone() },
    uWarm: { value: COLOR.amber.clone() },
    uIce: { value: COLOR.ice.clone() },
  }
  const points = new THREE.Points(
    flowGeometry(high ? 26 : 14, high ? 150 : 70, rand),
    new THREE.ShaderMaterial({ uniforms, vertexShader: FLOW_VERT, fragmentShader: SOFT_POINT_FRAG, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true }),
  )
  points.frustumCulled = false

  // Spojnice uzol → jadro: tenké krivky, ktoré pri udalosti a práci zosilnejú.
  const curves = Array.from({ length: MAX_LINKS }, () => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(48 * 3), 3))
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: COLOR.cyan.clone(), transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }))
    line.frustumCulled = false
    return line
  })

  const tmpA = new THREE.Vector3()
  const tmpB = new THREE.Vector3()

  /** a: začiatok (uzol), b: riadiaci bod, c: koniec pri jadre */
  function setLink(i, a, b, c) {
    uniforms.uA.value[i].copy(a)
    uniforms.uB.value[i].copy(b)
    uniforms.uC.value[i].copy(c)
    const line = curves[i]
    if (!line) return
    const arr = line.geometry.attributes.position.array
    for (let k = 0; k < 48; k++) {
      const s = k / 47
      tmpA.lerpVectors(a, b, s)
      tmpB.lerpVectors(b, c, s)
      tmpA.lerp(tmpB, s)
      arr.set([tmpA.x, tmpA.y, tmpA.z], k * 3)
    }
    line.geometry.attributes.position.needsUpdate = true
  }

  function update(i, { flare, phase, tool, boot }) {
    uniforms.uFlare.value[i] = flare
    uniforms.uPhase.value[i] = phase
    uniforms.uTool.value[i] = tool
    const line = curves[i]
    if (!line) return
    line.material.opacity = (0.1 + 0.42 * flare + 0.3 * tool) * boot * uniforms.uOn.value[i]
    line.material.color.copy(COLOR.cyan).lerp(COLOR.amber, Math.min(1, flare * 0.7)).lerp(COLOR.ice, tool * 0.4)
  }

  /** How much a link is there: 0 for a free slot, 1 for a full orb, in between while it appears or leaves. */
  function setOn(i, v) {
    uniforms.uOn.value[i] = v
    if (v <= 0 && curves[i]) curves[i].material.opacity = 0
  }

  return { points, curves, setLink, update, setOn }
}
