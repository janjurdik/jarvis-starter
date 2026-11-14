// Kamera režisér: pokojný drift okolo jadra, parallax od myši, prelet k uzlu pri
// f.focus a návrat. Póza = cieľ + sférický posun (azimut, elevácia, vzdialenosť, náklon).
// Prechody sa počítajú z časov (since, uvoľnenie), takže capture po snímkach dá
// rovnaký obraz ako živý beh. Myš (drag, zoom) sa po chvíli nečinnosti vráti na autopilota.

import * as THREE from 'three'
import { angleDelta, clamp, easeInOut, follow, mix } from './util.js'

export const FLY_IN = 2.1
export const FLY_OUT = 2.3
export const HOLD = 12

const pose = () => ({ tx: 0, ty: 0, tz: 0, az: 0, el: 0, dist: 10, roll: 0 })

function copyPose(out, p) {
  out.tx = p.tx
  out.ty = p.ty
  out.tz = p.tz
  out.az = p.az
  out.el = p.el
  out.dist = p.dist
  out.roll = p.roll
  return out
}

/** Prelet: cieľ lineárne, uhly najkratšou cestou, vzdialenosť v log mierke, oblúk hore a von (žeriav). */
function blend(out, a, b, k, arc = 0, swoop = 0) {
  out.tx = mix(a.tx, b.tx, k)
  out.ty = mix(a.ty, b.ty, k)
  out.tz = mix(a.tz, b.tz, k)
  out.az = a.az + angleDelta(a.az, b.az) * k
  out.el = mix(a.el, b.el, k) + arc * Math.sin(Math.PI * k)
  out.dist = Math.exp(mix(Math.log(a.dist), Math.log(b.dist), k)) * (1 + swoop * Math.sin(Math.PI * k))
  out.roll = mix(a.roll, b.roll, k)
  return out
}

export function createDirector(camera) {
  const home = { dist: 12, el0: 0.0 }
  const focusPoses = new Map()
  const homeP = pose()
  const current = pose()
  let rec = null
  let lastT = null
  const pointer = { tx: 0, ty: 0, x: 0, y: 0 }
  const user = { az: 0, el: 0, zoom: 0, lastT: -1e9, pAz: 0, pEl: 0, pZoom: 0, touched: false }
  const info = { node: null, k: 0, phase: 'home' }

  function homePose(T, out = homeP) {
    out.tx = 0.05 * Math.sin(T * 0.037)
    out.ty = 0.035 * Math.sin(T * 0.029 + 1.0)
    out.tz = 0
    out.az = 0.075 * Math.sin(T * 0.043) + 0.03 * Math.sin(T * 0.107 + 1.3)
    out.el = home.el0 + 0.045 * Math.sin(T * 0.031 + 0.7)
    out.dist = home.dist * (1 + 0.018 * Math.sin(T * 0.05 + 2.0))
    out.roll = 0.006 * Math.sin(T * 0.041 + 0.3)
    return out
  }

  /** Póza pri uzle: kamera pred uzlom, trochu von zo stredu, aby za ním žiarilo jadro. */
  function setFocusPose(id, nodePos, dist) {
    const out = nodePos.clone().normalize()
    out.y *= 0.35
    const dir = new THREE.Vector3(0, 0.035, 1).addScaledVector(out, 0.5).normalize()
    const target = nodePos.clone().multiplyScalar(0.97)
    focusPoses.set(id, {
      tx: target.x,
      ty: target.y,
      tz: target.z,
      az: Math.atan2(dir.x, dir.z),
      el: Math.asin(clamp(dir.y, -1, 1)),
      dist,
      roll: -0.035 * Math.sign(nodePos.x || 1),
    })
  }

  function setHome(dist, el0) {
    home.dist = dist
    home.el0 = el0
  }

  function poseAt(T, out) {
    if (!rec) return copyPose(out, homePose(T))
    const base = focusPoses.get(rec.node)
    if (!base) return copyPose(out, homePose(T))
    const fp = rec.wide === 1 ? base : { ...base, dist: base.dist * rec.wide }
    if (rec.releasedAt === null || T < rec.releasedAt) {
      const k = easeInOut((T - rec.since) / FLY_IN)
      return blend(out, rec.from, fp, k, 0.06, 0.3)
    }
    const k = easeInOut((T - rec.releasedAt) / FLY_OUT)
    return blend(out, rec.relFrom, homePose(T), k, 0.04, 0.22)
  }

  function focusWeight(T) {
    if (!rec) return 0
    if (rec.releasedAt === null || T < rec.releasedAt) return easeInOut((T - rec.since) / FLY_IN)
    return 1 - easeInOut((T - rec.releasedAt) / FLY_OUT)
  }

  /**
   * f.focus: { node, since } | null. Vracia { node, k }: k je váha preletu 0..1.
   */
  function update(T, focus, valid) {
    const dt = lastT === null ? 0 : T - lastT
    if (lastT !== null && T < lastT - 0.25) rec = null
    lastT = T
    const want = focus && focus.node && valid(focus.node) ? focus : null
    const since = want && Number.isFinite(want.since) ? want.since : null

    const wide = want && Number.isFinite(want.wide) ? want.wide : 1
    if (want && (!rec || rec.node !== want.node || (since !== null && since !== rec.since) || rec.wide !== wide)) {
      poseAt(T, current)
      const start = since ?? T
      const fresh = Math.abs(T - start) < 0.3 || !rec
      rec = {
        node: want.node,
        since: start,
        releasedAt: null,
        from: copyPose(pose(), fresh ? current : homePose(start, pose())),
        relFrom: null,
        hold: want.hold ?? HOLD,
        wide,
      }
      // Ak capture začne uprostred preletu, štart je domovská póza v čase since.
      if (!fresh || T - start > 0.3) copyPose(rec.from, homePose(start, pose()))
    }
    if (rec && rec.releasedAt === null) {
      if (!want) {
        poseAt(T, current)
        rec.releasedAt = T
        rec.relFrom = copyPose(pose(), current)
      } else if (T - rec.since >= rec.hold) {
        rec.releasedAt = rec.since + rec.hold
        const base = focusPoses.get(rec.node)
        rec.relFrom = copyPose(pose(), base ? { ...base, dist: base.dist * rec.wide } : homePose(T))
      }
    }
    if (rec && rec.releasedAt !== null && !want && T - rec.releasedAt > FLY_OUT) rec = null

    const P = poseAt(T, current)
    const k = focusWeight(T)

    // Parallax od myši (len živý beh; v capture sa setPointer nevolá).
    pointer.x = follow(pointer.x, pointer.tx, dt, 0.7)
    pointer.y = follow(pointer.y, pointer.ty, dt, 0.7)
    const par = 1 - 0.65 * k
    P.az += 0.055 * pointer.x * par
    P.el += 0.035 * pointer.y * par

    // Ručné ovládanie: pripočíta sa k autopilotovi, po 3,5 s nečinnosti sa vráti.
    if (user.touched) {
      user.lastT = T
      user.touched = false
    }
    user.az = clamp(user.az + user.pAz, -0.9, 0.9)
    user.el = clamp(user.el + user.pEl, -0.22, 0.5)
    user.zoom = clamp(user.zoom + user.pZoom, -0.55, 0.45)
    user.pAz = user.pEl = user.pZoom = 0
    if (T - user.lastT > 3.5) {
      user.az = follow(user.az, 0, dt, 1.1)
      user.el = follow(user.el, 0, dt, 1.1)
      user.zoom = follow(user.zoom, 0, dt, 1.1)
    }
    P.az += user.az
    P.el = clamp(P.el + user.el, -0.35, 0.75)
    P.dist *= Math.exp(user.zoom)

    const ce = Math.cos(P.el)
    camera.position.set(P.tx + Math.sin(P.az) * ce * P.dist, P.ty + Math.sin(P.el) * P.dist, P.tz + Math.cos(P.az) * ce * P.dist)
    camera.up.set(Math.sin(P.roll), Math.cos(P.roll), 0)
    camera.lookAt(P.tx, P.ty, P.tz)
    camera.updateMatrixWorld()

    info.node = rec ? rec.node : null
    info.k = k
    info.phase = !rec ? 'home' : rec.releasedAt === null || T < rec.releasedAt ? 'focus' : 'return'
    return info
  }

  function setPointer(nx, ny) {
    pointer.tx = clamp(nx, -1.2, 1.2)
    pointer.ty = clamp(ny, -1.2, 1.2)
  }

  function drag(dAz, dEl) {
    user.pAz += dAz
    user.pEl += dEl
    user.touched = true
  }

  function zoom(d) {
    user.pZoom += d
    user.touched = true
  }

  /** Póza pri uzle (aj so širším záberom), na rozloženie dossiera v priestore. */
  const focusPoseOf = (id, wide = 1) => {
    const p = focusPoses.get(id)
    return p ? { ...p, dist: p.dist * wide } : null
  }

  return { update, setHome, setFocusPose, setPointer, drag, zoom, info, homePose, focusPoseOf }
}
