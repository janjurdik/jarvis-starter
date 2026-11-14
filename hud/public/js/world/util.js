// Pomocné funkcie sveta. Žiadny Math.random ani Date.now: všetko je funkcia času T
// a pevného seedu, aby živý beh aj render po snímkach dali rovnaký obraz.

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
export const mix = (a, b, t) => a + (b - a) * t
export const smooth = (x) => {
  const t = clamp(x)
  return t * t * (3 - 2 * t)
}
export const smoother = (x) => {
  const t = clamp(x)
  return t * t * t * (t * (t * 6 - 15) + 10)
}
/** Kamera: mäkký nábeh aj dosadnutie, stred rýchlejší (ako cubic-bezier 0.65, 0, 0.35, 1). */
export const easeInOut = (x) => {
  const t = clamp(x)
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}
export const easeOut = (x) => 1 - Math.pow(1 - clamp(x), 4)

/** Deterministický PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashString(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

/** Najkratší rozdiel uhlov v intervale (-π, π]. */
export const angleDelta = (from, to) => {
  let d = (to - from) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}

// Integrál smoothstep rampy: ∫₀ˣ (3s² − 2s³) ds = x³ − x⁴/2
const smoothIntegral = (x) => x * x * x - (x * x * x * x) / 2

/**
 * Obálka stavu (napríklad „Jarvis premýšľa"). Ciele sa menia v snímkach, hodnota
 * aj jej integrál sú uzavretý vzorec od času poslednej zmeny. Pri capture po
 * snímkach je výsledok rovnaký ako živý, pri skoku dozadu sa obálka resetuje.
 *   value(T)    0..1 s mäkkým nábehom a dozvukom
 *   integral(T) ∫ value dt, na plynulé zrýchlenie rotácií bez skokov
 */
export class Ramp {
  constructor(up = 0.5, down = 0.9, initial = 0) {
    this.up = up
    this.down = down
    this.fresh = true
    this.reset(initial, 0)
  }

  reset(v, T) {
    this.t0 = T
    this.v0 = v
    this.target = v
    this.dur = 0
    this.i0 = 0
    this.tBase = T
  }

  set(T, target) {
    // Bez histórie (prvá snímka alebo skok dozadu) platí ustálený stav: capture jednej
    // snímky ukáže stav tak, ako keby trval už dlho.
    if (this.fresh || T < this.t0 - 1e-6) {
      this.fresh = false
      this.reset(target, T)
      return this
    }
    if (target !== this.target) {
      const v = this.value(T)
      this.i0 = this.integral(T)
      this.v0 = v
      this.t0 = T
      this.target = target
      const span = Math.abs(target - v)
      this.dur = span * (target > v ? this.up : this.down)
    }
    return this
  }

  value(T) {
    if (this.dur <= 0) return this.target
    return this.v0 + (this.target - this.v0) * smooth((T - this.t0) / this.dur)
  }

  integral(T) {
    const dt = Math.max(0, T - this.t0)
    let area = this.v0 * dt
    if (this.dur > 0) {
      const delta = this.target - this.v0
      const x = Math.min(1, dt / this.dur)
      area += delta * this.dur * smoothIntegral(x) + delta * Math.max(0, dt - this.dur)
    } else area += (this.target - this.v0) * dt
    return this.i0 + area
  }
}

/** Exponenciálne vyhladenie po snímkach (len pre živé vstupy ako mikrofón či myš). */
export function follow(current, target, dt, tau) {
  if (!(dt > 0)) return current
  return current + (target - current) * (1 - Math.exp(-dt / Math.max(1e-4, tau)))
}
