// Počasie ako veľká holografická SVG ilustrácia. Animácie sú CSS (triedy wx-*),
// v capture režime ich main.js zastaví a nastaví presne na čas T.

const R1 = (v) => Math.round(v * 100) / 100

/** Obláčik v mriežke 24 (rovnaký tvar ako ikona), škálovaný do ilustrácie. */
const CLOUD = 'M7.2 18.5h9.6a3.9 3.9 0 0 0 .7-7.7 5.6 5.6 0 0 0-10.7-.8 4.3 4.3 0 0 0 .4 8.5Z'

function cloud(x, y, s, cls = '', opacity = 1) {
  return (
    `<g class="${cls}" opacity="${opacity}"><g transform="translate(${x} ${y}) scale(${s})">` +
    `<path class="wx-cloud" d="${CLOUD}" vector-effect="non-scaling-stroke"/>` +
    `<path class="wx-cloud-hi" d="M6.2 11.6a4.6 4.6 0 0 1 6-3.4" vector-effect="non-scaling-stroke"/>` +
    '</g></g>'
  )
}

/** Slnko: jadro, prstenec lúčov a technický ciferník s ryskami. */
function sun(cx, cy, r, { dial = true } = {}) {
  const rays = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2
    const r0 = r * 1.42
    const r1 = r * (i % 2 ? 1.72 : 1.92)
    return `M${R1(cx + Math.cos(a) * r0)} ${R1(cy + Math.sin(a) * r0)}L${R1(cx + Math.cos(a) * r1)} ${R1(cy + Math.sin(a) * r1)}`
  }).join('')
  const ticks = dial
    ? Array.from({ length: 60 }, (_, i) => {
        const a = (i / 60) * Math.PI * 2
        const rr = r * 2.28
        const len = i % 5 === 0 ? r * 0.16 : r * 0.07
        return `M${R1(cx + Math.cos(a) * rr)} ${R1(cy + Math.sin(a) * rr)}L${R1(cx + Math.cos(a) * (rr + len))} ${R1(cy + Math.sin(a) * (rr + len))}`
      }).join('')
    : ''
  return (
    (dial ? `<g class="wx-spin wx-dim"><path class="wx-tick" d="${ticks}"/></g>` : '') +
    `<g class="wx-spin-r"><path class="wx-ray" d="${rays}"/></g>` +
    `<g class="wx-pulse"><circle class="wx-sun-glow" cx="${cx}" cy="${cy}" r="${R1(r * 1.25)}"/>` +
    `<circle class="wx-sun" cx="${cx}" cy="${cy}" r="${r}"/>` +
    `<circle class="wx-sun-hot" cx="${cx}" cy="${cy}" r="${R1(r * 0.42)}"/></g>`
  )
}

function moon(cx, cy, r) {
  // Kosáčik: vonkajší kruh mínus posunutý vnútorný.
  const k = 0.78
  const ox = r * 0.55
  const oy = -r * 0.35
  // Priesečníky dvoch kružníc (stred 0,0 polomer r a stred ox,oy polomer r*k).
  const d = Math.hypot(ox, oy)
  const a = (r * r - (r * k) * (r * k) + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, r * r - a * a))
  const px = (a * ox) / d
  const py = (a * oy) / d
  const x1 = cx + px + (h * oy) / d
  const y1 = cy + py - (h * ox) / d
  const x2 = cx + px - (h * oy) / d
  const y2 = cy + py + (h * ox) / d
  const path = `M${R1(x1)} ${R1(y1)}A${r} ${r} 0 1 0 ${R1(x2)} ${R1(y2)}A${R1(r * k)} ${R1(r * k)} 0 0 1 ${R1(x1)} ${R1(y1)}Z`
  return `<g class="wx-pulse"><path class="wx-moon-glow" d="${path}"/><path class="wx-moon" d="${path}"/></g>`
}

function star(x, y, s, delay) {
  return `<path class="wx-star wx-twinkle" style="animation-delay:${delay}s" d="M${x} ${R1(y - s)}l${R1(s * 0.28)} ${R1(s * 0.72)} ${R1(s * 0.72)} ${R1(s * 0.28)}-${R1(s * 0.72)} ${R1(s * 0.28)}-${R1(s * 0.28)} ${R1(s * 0.72)}-${R1(s * 0.28)}-${R1(s * 0.72)}-${R1(s * 0.72)}-${R1(s * 0.28)} ${R1(s * 0.72)}-${R1(s * 0.28)}Z"/>`
}

function rain(n, x0, x1, y) {
  return Array.from({ length: n }, (_, i) => {
    const x = R1(x0 + ((x1 - x0) * (i + 0.5)) / n)
    const yy = y + (i % 3) * 4
    return `<path class="wx-drop wx-fall" style="animation-delay:-${R1((i * 0.37) % 1.1)}s;animation-duration:${R1(0.95 + (i % 4) * 0.09)}s" d="M${x} ${yy}l-2.6 9"/>`
  }).join('')
}

function snow(n, x0, x1, y) {
  return Array.from({ length: n }, (_, i) => {
    const x = R1(x0 + ((x1 - x0) * (i + 0.5)) / n)
    const yy = y + (i % 2) * 6
    const s = 2.2 + (i % 3) * 0.5
    return `<g class="wx-snow" style="animation-delay:-${R1((i * 0.83) % 4)}s;animation-duration:${R1(3.6 + (i % 3) * 0.6)}s"><path class="wx-flake" d="M${x} ${R1(yy - s)}v${R1(s * 2)}M${R1(x - s * 0.87)} ${R1(yy - s / 2)}l${R1(s * 1.73)} ${s}M${R1(x - s * 0.87)} ${R1(yy + s / 2)}l${R1(s * 1.73)}-${s}"/></g>`
  }).join('')
}

const SCENES = {
  sun: () => sun(60, 60, 19),
  partly: () => `<g class="wx-drift-r">${sun(74, 42, 15, { dial: false })}</g>${cloud(4, 30, 3.9, 'wx-drift')}`,
  cloudy: () => `${cloud(40, 10, 2.9, 'wx-drift-r', 0.5)}${cloud(2, 28, 4.1, 'wx-drift')}`,
  rain: () => `${cloud(6, 4, 4.4, 'wx-drift')}<g class="wx-rain">${rain(7, 30, 92, 88)}</g>`,
  snow: () => `${cloud(6, 4, 4.4, 'wx-drift')}<g>${snow(6, 30, 92, 92)}</g>`,
  storm: () =>
    `<path class="wx-bolt wx-flash" d="M66 76 54 94h9l-3 16 14-21h-9l4-13Z"/>${cloud(6, 2, 4.4, 'wx-drift')}<g class="wx-rain">${rain(5, 28, 96, 88)}</g>`,
  fog: () =>
    `${cloud(14, 2, 3.6, 'wx-drift-r', 0.55)}<g class="wx-fog"><path class="wx-drift" d="M18 72h62M40 84h64"/><path class="wx-drift-r" d="M14 96h70M34 108h50"/></g>`,
  night: () => `${moon(58, 58, 30)}${star(98, 26, 5.5, -0.4)}${star(22, 28, 4, -1.6)}${star(104, 82, 3.4, -2.3)}${star(20, 92, 3, -0.9)}`,
  'night-cloud': () => `${moon(70, 44, 23)}${star(22, 22, 3.8, -1.2)}${star(106, 16, 3, -2)}${cloud(0, 34, 4, 'wx-drift')}`,
}

/** Druh počasia z WMO kódu (Open-Meteo) alebo zo slovenského textu. */
const ICON_KIND = { sun: 'sun', moon: 'night', partly: 'partly', 'partly-night': 'night-cloud', cloud: 'cloudy', fog: 'fog', drizzle: 'rain', rain: 'rain', snow: 'snow', storm: 'storm' }

export function weatherKind(w = {}, date = new Date()) {
  if (ICON_KIND[w.icon]) return ICON_KIND[w.icon]
  const night = isNight(w, date)
  const code = Number.isFinite(w.code) ? w.code : Number.isFinite(w.weatherCode) ? w.weatherCode : null
  if (code !== null) {
    if (code === 0) return night ? 'night' : 'sun'
    if (code <= 2) return night ? 'night-cloud' : 'partly'
    if (code === 3) return 'cloudy'
    if (code === 45 || code === 48) return 'fog'
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain'
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow'
    if (code >= 95) return 'storm'
  }
  const t = String(w.text ?? '').toLowerCase()
  if (/búrk|burk/.test(t)) return 'storm'
  if (/sneh|snež|snez/.test(t)) return 'snow'
  if (/dážď|dazd|prehán|prehan|mrhol|prší|prsi/.test(t)) return 'rain'
  if (/hmla|hmlis|opar/.test(t)) return 'fog'
  if (/zamrač|zamrac|zatiahn/.test(t)) return 'cloudy'
  if (/polojasn|oblač|oblac/.test(t)) return night ? 'night-cloud' : 'partly'
  if (/jasn|slneč|slnec/.test(t)) return night ? 'night' : 'sun'
  return night ? 'night' : 'cloudy'
}

/**
 * Noc: podľa isDay zo servera, inak približný východ a západ slnka pre Brno
 * (dĺžka dňa podľa dňa v roku, poludnie podľa letného času).
 */
export function isNight(w = {}, date = new Date()) {
  if (w.isDay === true || w.isDay === 1) return false
  if (w.isDay === false || w.isDay === 0) return true
  const start = new Date(date.getFullYear(), 0, 1)
  const doy = (date - start) / 86_400_000
  const half = 6.15 + 2.0 * Math.cos((2 * Math.PI * (doy - 172)) / 365)
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset()
  const dst = date.getTimezoneOffset() < jan ? 1 : 0
  const noon = 11.9 + dst
  const h = date.getHours() + date.getMinutes() / 60
  return h < noon - half || h > noon + half
}

/** Celá ilustrácia ako SVG string. */
export function weatherArt(kind, cls = '') {
  const scene = SCENES[kind] ?? SCENES.cloudy
  return `<svg class="wx wx-${kind}${cls ? ` ${cls}` : ''}" viewBox="0 0 120 120" aria-hidden="true">${scene()}</svg>`
}

export const WEATHER_KINDS = Object.keys(SCENES)
