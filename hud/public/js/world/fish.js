// Rybky v štýle Frutiger Aero: sklené klauny (oranžové s bielymi pásmi lemovanými
// čiernou), ktoré pomaly krúžia po zakrivených dráhach medzi uzlami. Jedna geometria,
// jeden InstancedMesh, jeden draw call. Pohyb aj vlnenie chvosta sú funkcia času T,
// takže capture po snímkach dá rovnaký obraz ako živý beh. Klikanie neovplyvňujú:
// pick() v core.js ide cez projekciu uzlov, nie cez raycast scény.

import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { COLOR } from './heart.js'

// Časti geometrie (atribút aPart): 0 telo, 1 chvost, 2 chrbtová a análna plutva, 3 prsné plutvy.
// aEdge 0..1 = od koreňa plutvy k jej okraju (tmavý lem).

function piece(positions, normals, part, edges) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Array(positions.length / 3).fill(part), 1))
  g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edges, 1))
  return g
}

/** Telo: sploštený elipsoid s hlavou na +x a zúženým chvostovým stopkom. */
function bodyGeometry(seg) {
  const g = new THREE.SphereGeometry(0.5, seg, Math.round(seg * 0.65))
  g.rotateZ(-Math.PI / 2)
  const p = g.attributes.position
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const rear = Math.max(0, -x / 0.5)
    const taper = 1 - 0.5 * Math.pow(rear, 1.6)
    // Klaun je vysoký a z boku plochý, hlava zaoblená a mierne tupá.
    p.setY(i, p.getY(i) * 0.9 * taper)
    p.setZ(i, p.getZ(i) * 0.62 * taper)
    p.setX(i, x > 0 ? x * 0.92 : x)
  }
  g.computeVertexNormals()
  g.deleteAttribute('uv')
  const n = p.count
  return piece(Array.from(p.array), Array.from(g.attributes.normal.array), 0, new Array(n).fill(0)).setIndex(g.index)
}

/** Vejár: trojuholníky z koreňa k oblúku bodov (plochá plutva v rovine xy). */
function fan(root, arc, part) {
  const pos = []
  const nor = []
  const edge = []
  for (let i = 0; i < arc.length - 1; i++) {
    pos.push(...root, ...arc[i], ...arc[i + 1])
    nor.push(0, 0, 1, 0, 0, 1, 0, 0, 1)
    edge.push(0, 1, 1)
  }
  return piece(pos, nor, part, edge)
}

function finGeometries() {
  // Chvost: zaoblený vejár s jemným zárezom v strede.
  const tail = []
  for (let i = 0; i <= 10; i++) {
    const a = -1 + (2 * i) / 10
    const notch = 0.05 * (1 - Math.abs(a))
    tail.push([-0.74 + notch - 0.06 * a * a, a * 0.27, 0])
  }
  // Chrbtová plutva: nízky oblúk pozdĺž chrbta, koreň sleduje telo.
  const dorsal = []
  for (let i = 0; i <= 8; i++) {
    const t = i / 8
    const x = 0.2 - t * 0.6
    dorsal.push([x, 0.27 + 0.1 * Math.sin(Math.PI * t) * (1 - 0.3 * t), 0])
  }
  const anal = []
  for (let i = 0; i <= 5; i++) {
    const t = i / 5
    anal.push([-0.1 - t * 0.26, -0.22 - 0.08 * Math.sin(Math.PI * t), 0])
  }
  const pect = []
  for (let i = 0; i <= 5; i++) {
    const a = (i / 5) * Math.PI * 0.9 + Math.PI * 0.55
    pect.push([0.14 + Math.cos(a) * 0.17, -0.05 + Math.sin(a) * 0.1, 0])
  }
  const left = fan([0.16, -0.04, 0], pect.map(([x, y]) => [x, y, 0.15]), 3)
  const right = fan([0.16, -0.04, 0], pect.map(([x, y]) => [x, y, -0.15]), 3)
  return [
    fan([-0.44, 0, 0], tail, 1),
    fan([-0.06, 0.2, 0], dorsal, 2),
    fan([-0.2, -0.13, 0], anal, 2),
    left,
    right,
  ].map((g) => {
    // Neindexované kúsky sa s indexovaným telom zlúčia len s vlastným indexom.
    const n = g.attributes.position.count
    return g.setIndex(Array.from({ length: n }, (_, i) => i))
  })
}

const FISH_VERT = /* glsl */ `
uniform float uTime;
attribute float aPart; attribute float aEdge; attribute vec2 aSwim;
varying vec3 vLocal; varying vec3 vN; varying vec3 vView; varying float vPart; varying float vEdge;
void main(){
  vec3 p = position;
  float ph = uTime * aSwim.x + aSwim.y;
  // Vlnenie: telo sa jemne prehne, chvost kmitá najviac, prsné plutvy pádlujú.
  float tailW = smoothstep(0.15, -0.75, p.x);
  p.z += sin(ph - p.x * 3.2) * (0.012 + 0.11 * tailW * tailW);
  if (aPart > 2.5) p.z += sin(ph * 1.3 + 1.2) * 0.05 * aEdge * sign(position.z);
  vec4 world = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vec4 mv = viewMatrix * world;
  gl_Position = projectionMatrix * mv;
  vN = normalize(mat3(viewMatrix) * mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vView = -mv.xyz;
  vLocal = position;
  vPart = aPart;
  vEdge = aEdge;
}`

const FISH_FRAG = /* glsl */ `
uniform vec3 uOrange; uniform vec3 uDeep; uniform vec3 uWhite; uniform vec3 uRim; uniform float uBoot;
varying vec3 vLocal; varying vec3 vN; varying vec3 vView; varying float vPart; varying float vEdge;
// Biely pás s čiernym lemom okolo stredu c, polšírka w. Vracia (biela, čierna).
vec2 band(float x, float c, float w){
  float d = abs(x - c);
  return vec2(1.0 - smoothstep(w - 0.012, w, d), smoothstep(w - 0.004, w + 0.004, d) * (1.0 - smoothstep(w + 0.022, w + 0.034, d)));
}
void main(){
  bool body = vPart < 0.5;
  if (body && !gl_FrontFacing) discard;
  vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 v = normalize(vView);
  float ndv = clamp(dot(n, v), 0.0, 1.0);

  vec3 col; float alpha;
  if (body) {
    // Pásy sú mierne zahnuté dopredu, ako u skutočného klauna.
    float x = vLocal.x + 0.09 * vLocal.y * vLocal.y * 4.0;
    vec2 b1 = band(x, 0.26, 0.055);
    vec2 b2 = band(x, -0.02, 0.07);
    vec2 b3 = band(x, -0.36, 0.04);
    float white = max(b1.x, max(b2.x, b3.x));
    float black = max(b1.y, max(b2.y, b3.y));
    // Brucho svetlejšie, chrbát sýtejší.
    col = mix(uOrange, uDeep, smoothstep(-0.1, 0.3, vLocal.y) * 0.45);
    col = mix(col, uWhite, white);
    col = mix(col, vec3(0.01), black * 0.92);
    // Oko: čierna zrenička s bielym odleskom.
    vec2 e = vec2(vLocal.x - 0.33, vLocal.y - 0.06);
    float eye = 1.0 - smoothstep(0.034, 0.042, length(e));
    float glint = 1.0 - smoothstep(0.008, 0.014, length(e - vec2(0.01, 0.014)));
    col = mix(col, vec3(0.005), eye);
    col = mix(col, vec3(1.0), glint * eye);
    alpha = 0.8;
  } else {
    // Plutvy: priesvitnejšie, oranžové s čiernym a bielym lemom na okraji.
    col = mix(uOrange, uDeep, 0.25);
    float rim = smoothstep(0.72, 0.86, vEdge);
    col = mix(col, vec3(0.01), rim * 0.9);
    col = mix(col, uWhite, smoothstep(0.9, 0.98, vEdge) * 0.8);
    alpha = 0.5 + 0.3 * rim;
  }

  // Sklo: fresnel okraj, veľký mäkký lesk zhora a ostrý odlesk svetla.
  float fres = pow(1.0 - ndv, 2.6);
  vec3 L = normalize(vec3(-0.35, 0.85, 0.45));
  vec3 h = normalize(L + v);
  float spec = pow(max(dot(n, h), 0.0), 60.0);
  float sheen = smoothstep(0.35, 0.85, n.y) * smoothstep(0.0, 0.5, ndv) * (body ? 1.0 : 0.4);
  // Jas drží telo pod prahom bloomu (0,38), žiaria len odlesky a okraj.
  col *= 0.26 + 0.2 * max(dot(n, L), 0.0) + 0.1 * ndv;
  col += uRim * fres * 0.22;
  col += vec3(1.0) * (sheen * 0.12 + spec * 0.55);
  alpha = clamp(alpha + fres * 0.2 + spec * 0.4 + sheen * 0.08, 0.0, 1.0) * uBoot;
  gl_FragColor = vec4(col, alpha);
}`

/**
 * Dráhy: vodorovné elipsy okolo jadra (zboku aj spredu, cez hĺbku sveta) na rôznych
 * výškach nad a pod jadrom, s jemným vlnením hore-dole. Rybka tak pláva prevažne
 * vodorovne a nikdy nejde zvislo, ani cez stred jadra. Hodnoty sú v násobkoch
 * rozmerov prstenca uzlov.
 */
const SWIMMERS = [
  { phase: 0.3, speed: 0.07, rx: 0.86, rz: 0.48, y: 0.62, amp: 0.07, k: 2, size: 1.0 },
  { phase: 2.4, speed: -0.055, rx: 0.95, rz: 0.60, y: -0.7, amp: 0.06, k: 3, size: 0.85 },
  { phase: 4.1, speed: 0.062, rx: 0.78, rz: 0.44, y: 0.86, amp: 0.05, k: 2, size: 0.9 },
  { phase: 1.2, speed: -0.075, rx: 0.9, rz: 0.54, y: -0.52, amp: 0.08, k: 3, size: 0.75 },
  { phase: 5.3, speed: 0.05, rx: 1.0, rz: 0.64, y: 0.4, amp: 0.06, k: 2, size: 1.1 },
  { phase: 3.3, speed: 0.066, rx: 0.82, rz: 0.50, y: -0.88, amp: 0.05, k: 3, size: 0.8 },
  { phase: 0.9, speed: -0.06, rx: 0.92, rz: 0.56, y: 0.74, amp: 0.07, k: 2, size: 0.95 },
]

export function createFish(U, { high, rand }) {
  const count = high ? 7 : 5
  const list = SWIMMERS.slice(0, count)
  const geometry = mergeGeometries([bodyGeometry(high ? 18 : 12), ...finGeometries()])
  const swim = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) swim.set([5.2 + rand() * 2.2, rand() * 6.283], i * 2)
  geometry.setAttribute('aSwim', new THREE.InstancedBufferAttribute(swim, 2))

  const orange = new THREE.Color('#ff6a10')
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: U.uTime,
      uBoot: U.uBoot,
      uOrange: { value: orange },
      uDeep: { value: new THREE.Color('#e2420a') },
      uWhite: { value: COLOR.white.clone() },
      uRim: { value: COLOR.ice.clone().lerp(COLOR.cyan, 0.3) },
    },
    vertexShader: FISH_VERT,
    fragmentShader: FISH_FRAG,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: true,
  })
  const mesh = new THREE.InstancedMesh(geometry, material, count)
  mesh.name = 'fish'
  mesh.frustumCulled = false
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

  // Rozmery prstenca uzlov (polosi elipsy a hĺbka) a veľkosť rybky, nastaví layout().
  const bounds = { x: 3, y: 3, z: 1.9, size: 0.35 }
  const pos = new THREE.Vector3()
  const ahead = new THREE.Vector3()
  const fwd = new THREE.Vector3()
  const side = new THREE.Vector3()
  const up = new THREE.Vector3()
  const m = new THREE.Matrix4()
  const scl = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const WORLD_UP = new THREE.Vector3(0, 1, 0)

  function at(s, th, out) {
    const r = 1 + 0.08 * Math.sin(2 * th + s.phase * 1.7)
    return out.set(
      Math.cos(th) * s.rx * bounds.x * r,
      (s.y + s.amp * Math.sin(s.k * th + s.phase)) * bounds.y,
      Math.sin(th) * s.rz * bounds.z * r,
    )
  }

  /** items = uzly z nodes.js po layoute (pos, scale). */
  function layout(items) {
    if (!items.length) return
    let bx = 0
    let by = 0
    let bz = 0
    let sz = 0
    for (const n of items) {
      bx = Math.max(bx, Math.abs(n.pos.x))
      by = Math.max(by, Math.abs(n.pos.y))
      bz = Math.max(bz, Math.abs(n.pos.z))
      sz += n.scale
    }
    Object.assign(bounds, { x: bx, y: by, z: Math.max(1.2, bz), size: (sz / items.length) * 0.6 })
  }

  function update({ T }) {
    for (let i = 0; i < count; i++) {
      const s = list[i]
      const th = s.phase + T * s.speed
      at(s, th, pos)
      at(s, th + Math.sign(s.speed) * 0.02, ahead)
      fwd.subVectors(ahead, pos).normalize()
      // Jemné pohupovanie hore-dole nezávislé od dráhy.
      pos.y += Math.sin(T * 0.45 + s.phase * 3) * bounds.size * 0.12
      side.crossVectors(WORLD_UP, fwd).normalize()
      up.crossVectors(fwd, side)
      m.makeBasis(fwd, up, side.negate())
      quat.setFromRotationMatrix(m)
      scl.setScalar(bounds.size * s.size)
      m.compose(pos, quat, scl)
      mesh.setMatrixAt(i, m)
    }
    mesh.instanceMatrix.needsUpdate = true
  }

  return { mesh, layout, update }
}
