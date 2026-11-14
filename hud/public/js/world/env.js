// Prostredie sveta v jednom celoobrazovkovom prechode: nebo s hmlovinami (predpočítané
// raz pri štarte), holografická podlaha s mriežkou do hmly a objemové svetlo jadra.
// Pre každý pixel sa spočíta lúč z kamery, priesečník s podlahou a rozptyl svetla
// jadra v hmle ako uzavretý integrál, takže to stojí jeden lacný prechod.

import * as THREE from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { SNOISE } from './glsl.js'

/** Okno oblohy, ktoré kamera reálne vidí (smer −Z ± 72°, od horizontu po 58° hore). */
const NEB_WIN = new THREE.Vector4(-Math.PI / 2 - 1.26, 2.52, -0.1, 1.12)

const BAKE_FRAG = /* glsl */ `
precision highp float;
uniform vec4 uWin;
varying vec2 vUv;
${SNOISE}
float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 6; i++){ s += a * snoise(p); p = p * 2.03 + vec3(13.1, 7.7, 3.3); a *= 0.5; } return s; }
float ridged(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++){ float n = 1.0 - abs(snoise(p)); s += a * n * n; p = p * 2.07 + vec3(3.7, 1.3, 9.1); a *= 0.5; } return s; }
void main(){
  float lon = uWin.x + vUv.x * uWin.y;
  float lat = uWin.z + vUv.y * uWin.w;
  vec3 d = vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
  vec3 q = d * 1.9;
  vec3 w = vec3(fbm(q + vec3(1.7, 9.2, 0.0)), fbm(q + vec3(8.3, 2.8, 4.1)), fbm(q + vec3(3.3, 5.1, 7.7)));
  float n = fbm(q * 1.25 + w * 1.25);
  float dens = smoothstep(-0.1, 0.8, n);
  // Oblaky len v niekoľkých oblastiach, nie rovnomerná tapeta.
  float mask = smoothstep(-0.12, 0.55, fbm(d * 0.85 + vec3(5.0, 1.0, 2.0)));
  float fil = ridged(q * 2.4 + w * 0.7);
  float lanes = smoothstep(0.25, 0.75, fbm(q * 3.3 - w * 0.9 + 2.0));
  float hue = smoothstep(-0.45, 0.45, fbm(q * 0.8 + 11.0));
  vec3 azure = vec3(0.0016, 0.0055, 0.019);
  vec3 teal = vec3(0.0018, 0.0125, 0.0145);
  vec3 ember = vec3(0.020, 0.0065, 0.0018);
  vec3 col = mix(azure, teal, hue) * dens * mask * 1.7;
  col += vec3(0.008, 0.034, 0.040) * pow(fil, 3.2) * dens * mask;
  // Teplé vlákna nízko nad horizontom, jediný jantárový tón oblohy.
  float warm = smoothstep(0.62, 0.98, ridged(q * 1.6 + vec3(4.0))) * smoothstep(0.42, 0.02, lat) * smoothstep(-0.2, 0.5, fbm(d * 1.3 + 21.0));
  col += ember * warm * warm * 0.35;
  col *= 1.0 - lanes * 0.55;
  // Slabý pás hviezdneho prachu po šikmej hlavnej kružnici.
  vec3 bandN = normalize(vec3(0.32, 0.88, 0.36));
  float band = exp(-pow(dot(d, bandN) / 0.2, 2.0));
  col += vec3(0.0022, 0.0055, 0.0085) * band * (0.55 + 0.9 * max(0.0, fbm(d * 7.0)));
  gl_FragColor = vec4(col, 1.0);
}`

const ENV_VERT = /* glsl */ `
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
varying vec3 vRay;
void main(){
  vec4 v = uInvProj * vec4(position.xy, 1.0, 1.0);
  vRay = mat3(uCamWorld) * (v.xyz / v.w);
  gl_Position = vec4(position.xy, 0.9999, 1.0);
}`

const ENV_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uNebula;
uniform vec4 uNebWin;
uniform float uNebGain;
uniform float uTime;
uniform float uBoot;
uniform float uVoice;
uniform float uPulse;
uniform float uSpeak;
uniform float uListen;
uniform float uThink;
uniform float uThinkPhase;
uniform float uFloorY;
uniform float uFloorGain;
uniform float uHaloGain;
uniform vec3 uCore;
uniform vec3 uCam;
uniform vec3 uCyan;
uniform vec3 uAzure;
uniform vec3 uIce;
uniform vec3 uHaze;
uniform vec3 uZenith;
varying vec3 vRay;
${SNOISE}

vec3 rotAxis(vec3 v, vec3 k, float a){
  float c = cos(a), s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}

float gridLine(vec2 coord, float px){
  vec2 w = max(fwidth(coord), vec2(1e-5));
  vec2 l = abs(fract(coord - 0.5) - 0.5) / (w * px);
  float line = 1.0 - min(min(l.x, l.y), 1.0);
  // Keď je bunka menšia ako pár pixelov, mriežka sa stratí (žiadny moiré).
  return line * (1.0 - smoothstep(0.08, 0.32, max(w.x, w.y)));
}

float ringLine(float coord, float px){
  float w = max(fwidth(coord), 1e-5);
  float l = abs(fract(coord - 0.5) - 0.5) / (w * px);
  return (1.0 - min(l, 1.0)) * (1.0 - smoothstep(0.08, 0.32, w));
}

void main(){
  vec3 rd = normalize(vRay);
  vec3 ro = uCam;

  // ── obloha ──
  float lon = atan(rd.z, rd.x);
  float lat = asin(clamp(rd.y, -1.0, 1.0));
  vec2 nuv = vec2((lon - uNebWin.x) / uNebWin.y, (lat - uNebWin.z) / uNebWin.w);
  float inWin = smoothstep(0.0, 0.08, nuv.x) * smoothstep(1.0, 0.92, nuv.x) * smoothstep(1.0, 0.85, nuv.y);
  vec3 sky = mix(uZenith, uHaze, exp(-max(rd.y, 0.0) * 7.0));
  // Žiara horizontu je jasnejšia v smere jadra.
  vec3 toCore = normalize(uCore - ro);
  float coreSide = pow(max(dot(normalize(rd.xz + 1e-5), normalize(toCore.xz + 1e-5)), 0.0), 3.0);
  float band = exp(-abs(rd.y) * 70.0);
  sky += uCyan * (0.0085 * band + 0.0024 * exp(-abs(rd.y) * 14.0)) * (0.35 + 0.65 * coreSide);
  // Farba hmly podlahy: horizont bez hmlovín (inak by sa spodok textúry natiahol do šmúh).
  vec3 horizon = uHaze + uCyan * 0.0109 * (0.35 + 0.65 * coreSide);
  sky += texture2D(uNebula, clamp(nuv, 0.0, 1.0)).rgb * inWin * smoothstep(0.0, 0.03, rd.y) * uNebGain;

  // ── podlaha (počíta sa pre všetky pixely, aby derivácie boli platné aj pri horizonte) ──
  float denom = min(rd.y, -1e-4);
  float tF = (uFloorY - ro.y) / denom;
  bool hit = rd.y < -1e-4;
  vec3 p = ro + rd * tF;
  vec2 xz = p.xz - uCore.xz;
  float r = length(xz);
  float ang = atan(xz.y, xz.x);

  float minor = gridLine(xz / 2.5, 1.1);
  float major = gridLine(xz / 12.5, 1.5);
  float rings = ringLine(r / 6.25, 1.3);
  float spokes = ringLine(ang / 6.2831853 * 48.0, 1.1) * smoothstep(110.0, 20.0, r);
  float near = smoothstep(150.0, 30.0, r);

  // Dátové pulzy po hlavných čiarach smerom k jadru.
  vec2 cell = floor(xz / 12.5 + 0.5);
  float laneX = gridLine(vec2(xz.x / 12.5, 0.5), 1.8);
  float laneZ = gridLine(vec2(0.5, xz.y / 12.5), 1.8);
  float px = fract(xz.y / 60.0 * sign(xz.y) + uTime * 0.07 + fract(sin(cell.x * 12.9898) * 43758.5453));
  float pz = fract(xz.x / 60.0 * sign(xz.x) + uTime * 0.06 + fract(sin(cell.y * 78.233) * 43758.5453));
  float pulses = laneX * smoothstep(0.9, 1.0, px) + laneZ * smoothstep(0.9, 1.0, pz);

  // Radar: pomalý lúč, ktorý obieha okolo pätky jadra.
  float sweepA = fract((ang / 6.2831853) - uTime * 0.035);
  float sweep = pow(1.0 - sweepA, 9.0) * smoothstep(140.0, 10.0, r);

  // Vlny hlasu po podlahe: Jarvis hovorí (von), používateľ hovorí (dnu).
  float speakW = pow(0.5 + 0.5 * sin(r * 0.42 - uTime * 3.4), 10.0) * uSpeak * (0.35 + uVoice) * exp(-r * 0.012);
  float listenW = pow(0.5 + 0.5 * sin(r * 0.55 + uTime * 2.6), 12.0) * uListen * exp(-r * 0.016);

  float h0 = max(1.0, uCore.y - uFloorY);
  float pool = 1.0 / (1.0 + pow(r / (h0 * 1.8), 2.0));
  float lit = 0.22 + 1.6 * pool;
  float energy0 = 1.0 + 0.6 * uVoice + 0.4 * uPulse + 0.3 * uThink;

  // Lesklá podlaha: rozmazaný odraz jadra ako zvislý pruh pod ním.
  vec3 rr = vec3(rd.x, -rd.y, rd.z);
  vec3 toC = normalize(uCore - p);
  float spec = pow(max(dot(rr, toC), 0.0), 18.0) * 0.55 + pow(max(dot(rr, toC), 0.0), 220.0);

  vec3 fl = uHaze * 0.3;
  fl += uCyan * (minor * 0.009 + major * 0.026) * lit * energy0;
  fl += uCyan * rings * 0.016 * near * lit + uCyan * spokes * 0.007 * lit;
  fl += uIce * pulses * 0.05 * near * lit;
  fl += uCyan * sweep * (0.002 + 0.02 * (minor + major + rings)) * lit;
  fl += uAzure * pool * 0.006 * energy0;
  fl += mix(uAzure, uCyan, 0.5) * spec * 0.05 * energy0;
  fl += uCyan * speakW * (0.012 + 0.09 * (major + rings));
  fl += uIce * listenW * (0.01 + 0.08 * (major + rings));
  fl *= uFloorGain;
  // Hmla: podlaha sa stráca do žiary horizontu.
  float fogF = exp(-max(tF - 18.0, 0.0) * 0.014);
  fl = mix(horizon, fl, fogF * smoothstep(0.0, 0.015, -rd.y));

  vec3 col = hit ? fl : sky;

  // ── objemové svetlo jadra ──
  float tMax = hit ? tF : 900.0;
  vec3 oc = uCore - ro;
  float b = dot(oc, rd);
  float h2 = max(dot(oc, oc) - b * b, 1e-4);
  float h = sqrt(h2);
  float I = (atan((tMax - b) / h) + atan(b / h)) / h;
  vec3 axis = normalize(oc);
  vec3 perp = (ro + rd * b - uCore) / h;
  float twist = uThink * 1.6 / (0.6 + h * 0.5) + uThinkPhase * 0.55 + uTime * 0.012;
  vec3 pr = rotAxis(perp, axis, twist);
  float n1 = snoise(pr * 2.6 + vec3(0.0, uTime * 0.04, 0.0));
  float n2 = snoise(pr * 6.5 - vec3(uTime * 0.03, 0.0, uTime * 0.02));
  float shafts = clamp(0.5 + 0.6 * n1 + 0.3 * n2, 0.0, 1.8);
  float energy = 1.0 + 0.9 * uVoice + 0.5 * uPulse + 0.35 * uThink;
  float reach = smoothstep(0.25, 1.6, h);
  vec3 vol = uAzure * I * 0.0042 * energy * exp(-h * 0.09);
  vol += mix(uCyan, uAzure, 0.4) * I * 0.016 * shafts * shafts * reach * energy * exp(-h * 0.13);
  // Svetelné vlny z jadra pri reči, dnu idúce kruhy pri počúvaní.
  float sw = pow(0.5 + 0.5 * sin(h * 3.3 - uTime * 5.0), 16.0) * reach * exp(-h * 0.42);
  vol += uCyan * I * sw * 0.028 * uSpeak * (0.12 + 1.1 * uVoice);
  float lw = pow(0.5 + 0.5 * sin(h * 3.6 + uTime * 3.2), 16.0) * reach * exp(-h * 0.55);
  vol += uIce * I * lw * 0.026 * uListen;
  col += vol * uHaloGain * uBoot;

  gl_FragColor = vec4(col, 1.0);
}`

export function createEnvironment(renderer, U, { high }) {
  // Obloha sa predpočíta raz: hmloviny sú statické voči svetu, pohyb dáva kamera.
  const bakeW = high ? 2048 : 1024
  const bake = new THREE.WebGLRenderTarget(bakeW, bakeW / 2, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  })
  const bakeMat = new THREE.ShaderMaterial({
    uniforms: { uWin: { value: NEB_WIN } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: BAKE_FRAG,
    depthTest: false,
    depthWrite: false,
  })
  const quad = new FullScreenQuad(bakeMat)
  function bakeSky() {
    const prevTarget = renderer.getRenderTarget()
    renderer.setRenderTarget(bake)
    quad.render(renderer)
    renderer.setRenderTarget(prevTarget)
  }
  bakeSky()

  const uniforms = {
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uNebula: { value: bake.texture },
    uNebWin: { value: NEB_WIN },
    uNebGain: { value: 4.2 },
    uTime: U.uTime,
    uBoot: U.uBoot,
    uVoice: U.uVoice,
    uPulse: U.uPulse,
    uSpeak: U.uSpeak,
    uListen: U.uListen,
    uThink: U.uThink,
    uThinkPhase: U.uThinkPhase,
    uFloorY: U.uFloorY,
    uFloorGain: { value: 1 },
    uHaloGain: { value: 1 },
    uCore: { value: new THREE.Vector3() },
    uCam: { value: new THREE.Vector3() },
    uCyan: { value: new THREE.Color('#5fe6ff') },
    uAzure: { value: new THREE.Color('#2f8cff') },
    uIce: { value: new THREE.Color('#d9fbff') },
    uHaze: { value: new THREE.Color(0.0019, 0.0043, 0.0064) },
    uZenith: { value: new THREE.Color(0.0008, 0.0014, 0.0021) },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: ENV_VERT,
    fragmentShader: ENV_FRAG,
    depthTest: false,
    depthWrite: false,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  mesh.frustumCulled = false
  mesh.renderOrder = -1000

  function update(camera) {
    uniforms.uInvProj.value.copy(camera.projectionMatrixInverse)
    uniforms.uCamWorld.value.copy(camera.matrixWorld)
    uniforms.uCam.value.setFromMatrixPosition(camera.matrixWorld)
  }

  return { mesh, uniforms, update, texture: bake.texture, rebake: bakeSky }
}
