// The mark of one app as SVG: the brand glyph from brands.js, a small drawing for apps without one
// (Apple's own apps, generic things like "Banka"), or one or two letters.

import { BRANDS } from './brands.js'

/** Filled 24x24 drawings, kept simple so they read at 20 px. */
const GLYPHS = {
  calendar: 'M6 3.5h2v2h8v-2h2v2h1.5A1.5 1.5 0 0 1 21 7v12.5A1.5 1.5 0 0 1 19.5 21h-15A1.5 1.5 0 0 1 3 19.5V7a1.5 1.5 0 0 1 1.5-1.5H6zM5 10v9h14v-9zm2 2h3v3H7z',
  note: 'M5.5 3h13A1.5 1.5 0 0 1 20 4.5V15l-6 6H5.5A1.5 1.5 0 0 1 4 19.5v-15A1.5 1.5 0 0 1 5.5 3M7 7v1.6h10V7zm0 4v1.6h10V11zm0 4v1.6h5V15zm7 4.4V16h3.4z',
  check: 'M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19m4.3 5.8-5.6 5.9-2.9-2.9-1.4 1.4 4.3 4.3 7-7.3z',
  person: 'M12 3a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9m0 10.5c4.6 0 8 2.3 8 5.3V21H4v-2.2c0-3 3.4-5.3 8-5.3',
  flower: 'M12 2.5c1.5 0 2.5 1.6 2.5 3.6 0 .5-.1 1-.2 1.4.4-.3.8-.6 1.3-.8 1.8-.8 3.7-.4 4.2 1s-.6 3-2.5 3.6c-.4.2-.9.3-1.4.3.5.1.9.3 1.4.6 1.8.9 2.7 2.6 2 4s-2.6 1.6-4.4.7c-.4-.2-.8-.5-1.2-.9.1.5.2 1 .2 1.5 0 2-1 3.5-2.5 3.5s-2.5-1.6-2.5-3.6c0-.5.1-1 .2-1.4-.4.4-.8.7-1.2.9-1.8.9-3.7.6-4.4-.7s.2-3.1 2-4c.5-.3.9-.5 1.4-.6-.5 0-1-.1-1.4-.3-1.9-.7-3-2.3-2.5-3.6s2.4-1.8 4.2-1c.5.2.9.5 1.3.8-.1-.4-.2-.9-.2-1.4 0-2 1-3.6 2.5-3.6m0 7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5',
  knot: 'M12 2 14.2 8.6 21 9.3l-5.2 4.5 1.6 6.7L12 17l-5.4 3.5 1.6-6.7L3 9.3l6.8-.7z',
  heart: 'M12 20.5s-8.5-5-8.5-11A4.5 4.5 0 0 1 12 6.6a4.5 4.5 0 0 1 8.5 2.9c0 6-8.5 11-8.5 11',
  school: 'M12 3 1.5 8.5 12 14l8.5-4.5V16H22V8.5zM5.5 12.3V16c0 1.9 2.9 3.5 6.5 3.5s6.5-1.6 6.5-3.5v-3.7L12 15.7z',
  dumbbell: 'M3 9h2V7.5A1.5 1.5 0 0 1 6.5 6h1A1.5 1.5 0 0 1 9 7.5V11h6V7.5A1.5 1.5 0 0 1 16.5 6h1A1.5 1.5 0 0 1 19 7.5V9h2v6h-2v1.5a1.5 1.5 0 0 1-1.5 1.5h-1a1.5 1.5 0 0 1-1.5-1.5V13H9v3.5A1.5 1.5 0 0 1 7.5 18h-1A1.5 1.5 0 0 1 5 16.5V15H3z',
  book: 'M4 4.5C6.5 3.5 9.5 3.6 11.2 5v15c-1.7-1.2-4.6-1.3-7.2-.4zm16 0v15.1c-2.6-.9-5.5-.8-7.2.4V5c1.7-1.4 4.7-1.5 7.2-.5',
  cube: 'M12 2.5 20.5 7v10L12 21.5 3.5 17V7zm0 2.3L6.2 7.8 12 10.9l5.8-3.1zm-6.5 4.8v6.3l5.5 3v-6.3zm13 0-5.5 3v6.3l5.5-3z',
  doc: 'M6 2.5h8L19.5 8v12A1.5 1.5 0 0 1 18 21.5H6A1.5 1.5 0 0 1 4.5 20V4A1.5 1.5 0 0 1 6 2.5m7 1.6V9h4.9zM7.5 12v1.6h9V12zm0 4v1.6h6V16z',
  bank: 'M12 2.5 21.5 7.5V9.5h-19V7.5zM4.5 11h2.6v6.5H4.5zm4.8 0h2.6v6.5H9.3zm4.8 0h2.6v6.5h-2.6zm4.8 0h0.8v6.5h-.8zM2.5 19h19v2.5h-19z',
}

/** The colour of the app: brand colour, or its own for apps without a brand entry. */
export function appColor(app) {
  return BRANDS[app?.icon]?.hex ?? app?.color ?? '#7FF3FF'
}

/** True when the brand colour is too dark to read on Jarvis's near-black background (X, Threads, GitHub…). */
export function isDark(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16)
  if (!Number.isFinite(n)) return false
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 60
}

/** SVG markup of the app's mark, filled with currentColor so CSS decides the colour. */
export function appSvg(app, cls = 'app-mark') {
  const brand = BRANDS[app?.icon]
  const d = brand?.path ?? GLYPHS[app?.glyph]
  if (d) return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`
  const text = String(app?.mono ?? app?.name?.[0] ?? '?').slice(0, 2)
  const size = text.length > 1 ? 11 : 14
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><text x="12" y="12" dy=".36em" text-anchor="middle" font-family="Inter Tight, system-ui, sans-serif" font-weight="700" font-size="${size}" fill="currentColor">${text.replace(/[<&>]/g, '')}</text></svg>`
}

/** The raw drawing for a canvas (Path2D): { d } for a glyph, { text } for letters. */
export function appShape(app) {
  const d = BRANDS[app?.icon]?.path ?? GLYPHS[app?.glyph]
  return d ? { d } : { text: String(app?.mono ?? app?.name?.[0] ?? '?').slice(0, 2) }
}
