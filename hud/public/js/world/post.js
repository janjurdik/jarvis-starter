// Postprocessing: render → bloom (UnrealBloomPass v polovičnom rozlíšení) → finálny
// prechod s jemnou chromatickou aberáciou na okrajoch, vinetou a prevodom do sRGB.
// Film grain je v CSS nad canvasom.

import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'

const FinalShader = {
  name: 'JarvisFinal',
  uniforms: {
    tDiffuse: { value: null },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uAspect: { value: new THREE.Vector2(1.6, 1) },
    uCA: { value: 0.0055 },
    uVig: { value: 0.32 },
    uLift: { value: 0 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color('#9fe8ff') },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform vec2 uCenter; uniform vec2 uAspect; uniform float uCA; uniform float uVig; uniform float uLift; uniform float uFlash; uniform vec3 uFlashColor;
    varying vec2 vUv;
    void main(){
      vec2 d = (vUv - uCenter) * uAspect;
      float r2 = dot(d, d);
      vec2 off = (vUv - uCenter) * uCA * r2;
      vec3 c;
      c.r = texture2D(tDiffuse, vUv + off).r;
      c.g = texture2D(tDiffuse, vUv).g;
      c.b = texture2D(tDiffuse, vUv - off * 1.15).b;
      c *= 1.0 - uVig * smoothstep(0.25, 1.35, r2);
      c += uLift;
      // Ponor cez atmosféru planéty: svetlo v jej farbe zaplaví obraz od stredu von.
      float fl = uFlash * uFlash;
      c = mix(c, uFlashColor * (1.25 - 0.5 * r2), clamp(fl * (1.2 - 0.35 * r2), 0.0, 1.0));
      gl_FragColor = linearToOutputTexel(vec4(c, 1.0));
    }`,
}

export function createPost(renderer, scene, camera, { strength, radius, threshold }) {
  const composer = new EffectComposer(renderer)
  const pass = new RenderPass(scene, camera)
  composer.addPass(pass)
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), strength, radius, threshold)
  composer.addPass(bloom)
  const final = new ShaderPass(FinalShader)
  composer.addPass(final)

  function setSize(w, h, ratio, zone) {
    composer.setPixelRatio(ratio)
    composer.setSize(w, h)
    const cx = zone ? (zone.left + zone.right) / 2 / w : 0.5
    const cy = zone ? 1 - (zone.top + zone.bottom) / 2 / h : 0.5
    final.uniforms.uCenter.value.set(cx, cy)
    final.uniforms.uAspect.value.set(w / Math.max(1, h), 1)
  }

  const base = { scene, camera, strength, threshold }
  /** Prepne, čo sa renderuje (hlavný svet alebo vnútro planéty). Vnútro má jemnejší bloom, nech fotky ostanú ostré. */
  function setView(s, c, inner = false) {
    pass.scene = s ?? base.scene
    pass.camera = c ?? base.camera
    bloom.strength = inner ? base.strength * 0.45 : base.strength
    bloom.threshold = inner ? Math.max(0.86, base.threshold) : base.threshold
  }
  function setFlash(k, color) {
    final.uniforms.uFlash.value = k
    if (color) final.uniforms.uFlashColor.value.set(color)
  }

  return { composer, bloom, final, setSize, setView, setFlash, render: () => composer.render() }
}
