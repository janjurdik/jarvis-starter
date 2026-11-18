// Vlastná holografická sada ikon HUD: 24 px mriežka, ťah 1,75 px, jemná duotone výplň (~15 %)
// a jedna plná „svetelná" časť, ktorá žiari. Farba ide z CSS (currentColor), žiara cez CSS.
// Každá ikona je ručne kreslená, uzly zodpovedajú objektom 3D sveta (bubliny, rámčeky,
// časová špirála, mesiac s prstencom, mriežka dní, ozubené prstence, kocky, kompas).

/** Ozubené koleso ako jedna cesta: n zubov, koreň r0, špička r1, podiel zuba duty. */
function gear(cx, cy, r0, r1, n, duty = 0.42) {
  const pts = []
  const step = (Math.PI * 2) / n
  for (let i = 0; i < n; i++) {
    const a = i * step - Math.PI / 2
    const half = (step * duty) / 2
    const slope = step * 0.07
    pts.push([a - half - slope, r0], [a - half + slope, r1], [a + half - slope, r1], [a + half + slope, r0])
  }
  const f = (v) => Math.round(v * 100) / 100
  return `M${pts.map(([a, r]) => `${f(cx + Math.cos(a) * r)} ${f(cy + Math.sin(a) * r)}`).join('L')}Z`
}

/** Pravidelný mnohouholník (emblémy). */
function polygon(cx, cy, r, n, rot = 0) {
  const f = (v) => Math.round(v * 100) / 100
  return `M${Array.from({ length: n }, (_, i) => {
    const a = rot + (i / n) * Math.PI * 2
    return `${f(cx + Math.cos(a) * r)} ${f(cy + Math.sin(a) * r)}`
  }).join('L')}Z`
}

const CLOUD = 'M7.2 18.5h9.6a3.9 3.9 0 0 0 .7-7.7 5.6 5.6 0 0 0-10.7-.8 4.3 4.3 0 0 0 .4 8.5Z'
const CLOUD_HI = 'M7.4 15.2h9.2a3.4 3.4 0 0 0 .6-6.7 4.9 4.9 0 0 0-9.4-.7 3.7 3.7 0 0 0-.4 7.4Z'

/**
 * d: duotone výplň (15 %), s: ťahy, l: svetelná časť (plná výplň so žiarou).
 * Všetko v súradniciach 0 až 24.
 */
const ICONS = {
  // ── uzly 3D sveta ──
  spravy: {
    d: '<path d="M5 4h7.5A2.5 2.5 0 0 1 15 6.5V10a2.5 2.5 0 0 1-2.5 2.5H9l-3.2 2.6v-2.6H5A2.5 2.5 0 0 1 2.5 10V6.5A2.5 2.5 0 0 1 5 4Z"/>',
    s: '<path d="M5 4h7.5A2.5 2.5 0 0 1 15 6.5V10a2.5 2.5 0 0 1-2.5 2.5H9l-3.2 2.6v-2.6H5A2.5 2.5 0 0 1 2.5 10V6.5A2.5 2.5 0 0 1 5 4Z"/><path d="M14.6 14.4h4.4a2.4 2.4 0 0 1 2.4 2.4v.6a2.4 2.4 0 0 1-2.4 2.4h-.2v2l-2.6-2h-1.6a2.4 2.4 0 0 1-2.4-2.4v-.6a2.4 2.4 0 0 1 2.4-2.4Z"/><path d="M17.6 10.6h0"/>',
    l: '<circle cx="19.3" cy="6.3" r="2.2"/>',
  },
  fotky: {
    d: '<rect x="3" y="8" width="13.5" height="12" rx="1.6"/>',
    s: '<path d="M7.5 6v-.5A1.5 1.5 0 0 1 9 4h10.5A1.5 1.5 0 0 1 21 5.5v8a1.5 1.5 0 0 1-1.5 1.5H19"/><rect x="3" y="8" width="13.5" height="12" rx="1.6"/><path d="m5.6 17.6 3.1-3.2 2.4 2.4 1.6-1.6 1.6 1.6"/>',
    l: '<circle cx="12.6" cy="11.3" r="1.45"/>',
  },
  udalosti: {
    d: '<circle cx="12.6" cy="12" r="6.4"/>',
    s: '<path d="M12 12a1.5 1.5 0 0 1 3 0 3 3 0 0 1-6 0 4.5 4.5 0 0 1 9 0 6 6 0 0 1-12 0 7.5 7.5 0 0 1 11.25-6.5"/>',
    l: '<circle cx="17.25" cy="5.5" r="1.75"/>',
  },
  spanok: {
    d: '<path d="M13.5 6.7A5.5 5.5 0 1 0 17.3 13.6 4.3 4.3 0 0 1 13.5 6.7Z"/>',
    s: '<path d="M13.5 6.7A5.5 5.5 0 1 0 17.3 13.6 4.3 4.3 0 0 1 13.5 6.7Z"/><path d="M21.66 9.91A10 3 -15 0 1 2.34 15.09 10 3 -15 0 1 6.5 11.28M16.61 8.66A10 3 -15 0 1 21.66 9.91"/>',
    l: '<path d="M19.4 1.9l.62 1.38 1.38.62-1.38.62-.62 1.38-.62-1.38-1.38-.62 1.38-.62Z"/>',
  },
  kalendar: {
    d: '<path d="M5.5 5h13a2 2 0 0 1 2 2v2.5h-17V7a2 2 0 0 1 2-2Z"/>',
    s: '<path d="M5.5 5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM3.5 9.5h17M8 3v3.6M16 3v3.6M7.4 13h0M11 13h0M14.6 13h0M18 13h0M7.4 16.6h0M11 16.6h0"/>',
    l: '<rect x="13.1" y="15.1" width="3" height="3" rx=".7"/>',
  },
  rutiny: {
    d: `<path d="${gear(12, 12, 6.3, 8.4, 9)}"/>`,
    s: `<path d="${gear(12, 12, 6.3, 8.4, 9)}"/><circle cx="12" cy="12" r="3.3"/>`,
    l: '<circle cx="12" cy="12" r="1.35"/>',
  },
  projekty: {
    d: '<path d="m12 2.8 7.8 4.5v9.4L12 21.2l-7.8-4.5V7.3Z"/>',
    s: '<path d="m12 2.8 7.8 4.5v9.4L12 21.2l-7.8-4.5V7.3ZM4.2 7.3l7.8 4.5 7.8-4.5M12 11.8v9.4M8.1 9.55v9.4M15.9 9.55v9.4M4.2 12 12 16.5l7.8-4.5M8.1 5.05l7.8 4.5M15.9 5.05 8.1 9.55"/>',
    l: '<path d="M12 7.3l3.9 2.25L12 11.8 8.1 9.55Z"/>',
  },
  questy: {
    d: '<circle cx="12" cy="12" r="8.6"/>',
    s: '<circle cx="12" cy="12" r="8.6"/><path d="M12 5v1.4M12 17.6V19M5 12h1.4M17.6 12H19M13.2 13.2 7.4 16.6l3.4-5.8"/>',
    l: '<path d="M16.6 7.4 13.2 13.2 10.8 10.8Z"/>',
  },

  // ── hlas, príkazy ──
  mic: {
    d: '<rect x="9" y="3.5" width="6" height="11" rx="3"/>',
    s: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.8 11a6.2 6.2 0 0 0 12.4 0M12 17.2v3.3M9 20.5h6"/>',
    l: '<path d="M10.6 9.4h2.8V11a1.4 1.4 0 0 1-2.8 0Z"/>',
  },
  send: {
    s: '<path d="M19.5 4.5V11a3 3 0 0 1-3 3H7.5"/>',
    l: '<path d="M10.2 9.6 5 14l5.2 4.4Z"/>',
  },
  stop: {
    d: '<rect x="4.5" y="4.5" width="15" height="15" rx="4"/>',
    s: '<rect x="4.5" y="4.5" width="15" height="15" rx="4"/>',
    l: '<rect x="9" y="9" width="6" height="6" rx="1.3"/>',
  },
  wave: {
    s: '<path d="M4 10.5v3M8 8v8M16 6.5v11M20 10v4"/>',
    l: '<rect x="10.75" y="3.5" width="2.5" height="17" rx="1.25"/>',
  },
  speaker: {
    s: '<path d="M15 9a4.2 4.2 0 0 1 0 6M17.9 6.4a7.8 7.8 0 0 1 0 11.2"/>',
    l: '<path d="M4 9.2h3l4.6-3.9v13.4L7 14.8H4a1 1 0 0 1-1-1v-3.6a1 1 0 0 1 1-1Z"/>',
  },
  wake: {
    s: '<path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4"/>',
    l: '<circle cx="12" cy="12" r="2.2"/>',
  },
  keyboard: {
    d: '<rect x="2.5" y="6" width="19" height="12" rx="2.2"/>',
    s: '<rect x="2.5" y="6" width="19" height="12" rx="2.2"/><path d="M6 9.5h0M9 9.5h0M12 9.5h0M15 9.5h0M18 9.5h0M7.5 12.4h0M10.5 12.4h0M13.5 12.4h0M16.5 12.4h0"/>',
    l: '<rect x="8" y="14.4" width="8" height="1.8" rx=".9"/>',
  },
  expand: {
    s: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
    l: '<rect x="9.5" y="9.5" width="5" height="5" rx="1.1"/>',
  },
  target: {
    d: '<circle cx="12" cy="12" r="7"/>',
    s: '<circle cx="12" cy="12" r="7"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>',
    l: '<circle cx="12" cy="12" r="2"/>',
  },

  // ── stav ──
  claude: {
    d: '<circle cx="12" cy="12" r="8.6"/>',
    s: '<circle cx="12" cy="12" r="8.6"/>',
    l: '<path d="M12 5.4c.55 3.5 3 6 6.6 6.6-3.6.55-6.05 3.05-6.6 6.6-.55-3.55-3.05-6.05-6.6-6.6 3.55-.6 6.05-3.1 6.6-6.6Z"/>',
  },
  model: {
    d: '<rect x="6" y="6" width="12" height="12" rx="2.2"/>',
    s: '<rect x="6" y="6" width="12" height="12" rx="2.2"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/>',
    l: '<rect x="9.4" y="9.4" width="5.2" height="5.2" rx="1"/>',
  },
  pamat: {
    d: '<path d="M12 12c-1.8-2.4-3.3-3.8-5.2-3.8a3.8 3.8 0 0 0 0 7.6c1.9 0 3.4-1.4 5.2-3.8Z"/>',
    s: '<path d="M12 12c-1.8-2.4-3.3-3.8-5.2-3.8a3.8 3.8 0 0 0 0 7.6c1.9 0 3.4-1.4 5.2-3.8Zm0 0c1.8 2.4 3.3 3.8 5.2 3.8a3.8 3.8 0 0 0 0-7.6c-1.9 0-3.4 1.4-5.2 3.8Z"/>',
    l: '<circle cx="17.2" cy="12" r="1.6"/>',
  },
  // A webcam: hand control from the camera.
  kamera: {
    d: '<rect x="3" y="5.5" width="18" height="12" rx="3"/>',
    s: '<rect x="3" y="5.5" width="18" height="12" rx="3"/><path d="M8.5 20.5h7M12 17.5v3"/>',
    l: '<circle cx="12" cy="11.5" r="2.6"/>',
  },
  film: {
    d: '<rect x="2.5" y="6.5" width="13" height="11" rx="2.2"/>',
    s: '<rect x="2.5" y="6.5" width="13" height="11" rx="2.2"/><path d="m15.5 10.4 5-2.6v8.4l-5-2.6"/>',
    l: '<circle cx="6.7" cy="10.4" r="1.6"/>',
  },
  eye: {
    d: '<path d="M2.8 12S6.2 6 12 6s9.2 6 9.2 6-3.4 6-9.2 6-9.2-6-9.2-6Z"/>',
    s: '<path d="M2.8 12S6.2 6 12 6s9.2 6 9.2 6-3.4 6-9.2 6-9.2-6-9.2-6Z"/><circle cx="12" cy="12" r="3.4"/>',
    l: '<circle cx="12" cy="12" r="1.55"/>',
  },
  shield: {
    d: '<path d="M12 3 5 5.8v5.6c0 4.4 3 7.6 7 9.1 4-1.5 7-4.7 7-9.1V5.8L12 3Z"/>',
    s: '<path d="M12 3 5 5.8v5.6c0 4.4 3 7.6 7 9.1 4-1.5 7-4.7 7-9.1V5.8L12 3Z"/>',
    l: '<path d="M12 7.3 8.7 8.6v2.9c0 2.1 1.4 3.7 3.3 4.5 1.9-.8 3.3-2.4 3.3-4.5V8.6Z"/>',
  },
  memory: {
    d: '<path d="M9 5.2a3 3 0 0 0-4.6 2.5 3 3 0 0 0 .3 5.4A3 3 0 0 0 9 18.4V5.2Z"/>',
    s: '<path d="M9 5.2a3 3 0 0 0-4.6 2.5 3 3 0 0 0 .3 5.4A3 3 0 0 0 9 18.4V5.2ZM15 5.2a3 3 0 0 1 4.6 2.5 3 3 0 0 1-.3 5.4 3 3 0 0 1-4.3 5.3V5.2ZM9 11h2.2M12.8 9H15M12.8 14H15"/>',
    l: '<circle cx="12" cy="11.4" r="1.3"/>',
  },

  // ── typy udalostí ──
  bolt: {
    d: '<path d="M13.2 2.8 5.6 13.3h5.6l-.8 7.9 7.9-10.6h-5.7Z"/>',
    s: '<path d="M3.8 6.4 5.4 7.4M20.2 17.6l-1.6-1M19.4 4.6l-1.3 1.3"/>',
    l: '<path d="M13.2 2.8 5.6 13.3h5.6l-.8 7.9 7.9-10.6h-5.7Z"/>',
  },
  check: {
    d: '<circle cx="12" cy="12" r="8.6"/>',
    s: '<circle cx="12" cy="12" r="8.6"/>',
    l: '<path d="m7.5 12.3 1.45-1.45 2.25 2.25 4.85-4.85 1.45 1.45-6.3 6.3Z"/>',
  },
  close: {
    d: '<circle cx="12" cy="12" r="8.6"/>',
    s: '<circle cx="12" cy="12" r="8.6"/><path d="m9 9 6 6M15 9l-6 6"/>',
    l: '<path d="m12 10.6 1.4 1.4-1.4 1.4-1.4-1.4Z"/>',
  },
  alarm: {
    d: '<circle cx="12" cy="13" r="6.8"/>',
    s: '<circle cx="12" cy="13" r="6.8"/><path d="M12 9.6V13l2.3 1.6M7.4 19.4 6.1 20.7M16.6 19.4l1.3 1.3"/>',
    l: '<path d="M3.4 8.4a3.6 3.6 0 0 1 4.9-4.9ZM20.6 8.4a3.6 3.6 0 0 0-4.9-4.9Z"/>',
  },
  info: {
    d: '<circle cx="12" cy="12" r="8.6"/>',
    s: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.5"/>',
    l: '<circle cx="12" cy="7.9" r="1.3"/>',
  },
  search: {
    d: '<circle cx="10.5" cy="10.5" r="6.2"/>',
    s: '<circle cx="10.5" cy="10.5" r="6.2"/><path d="M7.4 9.6a3.3 3.3 0 0 1 2.4-2.4"/>',
    l: '<path d="m14.4 16.2 1.8-1.8 4.7 4.7a1.27 1.27 0 0 1-1.8 1.8Z"/>',
  },
  globe: {
    d: '<circle cx="12" cy="12" r="8.6"/>',
    s: '<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2M5.2 7.6h13.6M5.2 16.4h13.6M12 3.4c-2.6 2.4-3.9 5.4-3.9 8.6s1.3 6.2 3.9 8.6c2.6-2.4 3.9-5.4 3.9-8.6S14.6 5.8 12 3.4Z"/>',
    l: '<circle cx="20.3" cy="3.9" r="1.5"/>',
  },
  laptop: {
    d: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5h-17V7A1.5 1.5 0 0 1 5 5.5Z"/>',
    s: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5h-17V7A1.5 1.5 0 0 1 5 5.5ZM3.5 15.5 2 18.5h20l-1.5-3M7 8.8l2.2 1.7L7 12.2"/>',
    l: '<rect x="10.6" y="11.3" width="4.2" height="1.7" rx=".5"/>',
  },
  app: {
    d: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/>',
    s: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><rect x="7" y="7" width="4" height="4" rx=".9"/><rect x="13" y="7" width="4" height="4" rx=".9"/><rect x="7" y="13" width="4" height="4" rx=".9"/>',
    l: '<rect x="13" y="13" width="4" height="4" rx=".9"/>',
  },
  tab: {
    d: '<path d="M4.5 5.5h15a2 2 0 0 1 2 2V10h-19V7.5a2 2 0 0 1 2-2Z"/>',
    s: '<path d="M4.5 5.5h15a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2ZM2.5 10h19"/>',
    l: '<rect x="5" y="7" width="5.4" height="1.6" rx=".8"/>',
  },
  music: {
    s: '<path d="M9.2 17.4V6.6l11-2.4v10.6M9.2 9.9l11-2.4"/>',
    l: '<ellipse cx="6.9" cy="17.6" rx="2.6" ry="2.2"/><ellipse cx="17.9" cy="15" rx="2.6" ry="2.2"/>',
  },
  note: {
    d: '<path d="M6.5 3.5H14l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1.5-1.5Z"/>',
    s: '<path d="M6.5 3.5H14l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1.5-1.5ZM8.5 12.5h7M8.5 16h5"/>',
    l: '<path d="M14 3.5V8h4.5Z"/>',
  },
  person: {
    s: '<path d="M5 20.2a7 7 0 0 1 14 0"/>',
    l: '<circle cx="12" cy="8.4" r="3.6"/>',
  },
  heart: {
    d: '<path d="M12 19.6S4 15 4 9.4a4.1 4.1 0 0 1 8-1.8 4.1 4.1 0 0 1 8 1.8c0 5.6-8 10.2-8 10.2Z"/>',
    s: '<path d="M12 19.6S4 15 4 9.4a4.1 4.1 0 0 1 8-1.8 4.1 4.1 0 0 1 8 1.8c0 5.6-8 10.2-8 10.2Z"/><path d="M7 12.4h2.1l1.3-2.3 2 4.4 1.4-2.1H17"/>',
    l: '<circle cx="17" cy="12.4" r="1.25"/>',
  },
  chart: {
    s: '<path d="M3.5 20.2h17M6.5 16.5v-4M10.5 16.5V9M18.5 16.5v-7"/>',
    l: '<rect x="13.25" y="4.5" width="2.5" height="13.2" rx="1.25"/>',
  },
  gift: {
    d: '<rect x="4.5" y="10.5" width="15" height="9.5" rx="1.4"/>',
    s: '<rect x="4.5" y="10.5" width="15" height="9.5" rx="1.4"/><path d="M3.5 7.6h17v2.9h-17ZM12 7.6V20"/>',
    l: '<path d="M12 7.5c-1.4-3-5.3-3.9-5.3-1.6 0 1.4 2.5 1.7 5.3 1.6Zm0 0c1.4-3 5.3-3.9 5.3-1.6 0 1.4-2.5 1.7-5.3 1.6Z"/>',
  },
  instagram: {
    d: '<rect x="4" y="4" width="16" height="16" rx="4.6"/>',
    s: '<rect x="4" y="4" width="16" height="16" rx="4.6"/><circle cx="12" cy="12" r="3.7"/>',
    l: '<circle cx="16.8" cy="7.2" r="1.15"/>',
  },
  code: {
    d: '<path d="M4.5 4.5h15a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z"/>',
    s: '<path d="M4.5 4.5h15a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2ZM6.8 9.2 9.4 12l-2.6 2.8"/>',
    l: '<rect x="11.4" y="13.4" width="5.2" height="1.9" rx=".55"/>',
  },
  book: {
    d: '<path d="M12 6.5c-1.8-1.3-4.3-2-7.5-2v13c3.2 0 5.7.7 7.5 2Z"/>',
    s: '<path d="M12 6.5c-1.8-1.3-4.3-2-7.5-2v13c3.2 0 5.7.7 7.5 2 1.8-1.3 4.3-2 7.5-2v-13c-3.2 0-5.7.7-7.5 2Zm0 0v13"/>',
    l: '<path d="M15 4.9V10l1.3-1 1.3 1V4.5Z"/>',
  },
  phone: {
    d: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.6"/>',
    s: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.6"/>',
    l: '<rect x="10" y="17.4" width="4" height="1.4" rx=".7"/>',
  },
  route: {
    s: '<circle cx="5.4" cy="17.6" r="1.9"/><path d="M7.3 17.6H14a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h6.6"/>',
    l: '<circle cx="18.8" cy="5.6" r="2.1"/>',
  },
  card: {
    d: '<rect x="3" y="6" width="18" height="12" rx="2.2"/>',
    s: '<rect x="3" y="6" width="18" height="12" rx="2.2"/><path d="M3 10h18"/>',
    l: '<rect x="6" y="12.8" width="4.4" height="2.8" rx=".6"/>',
  },
  coffee: {
    d: '<path d="M5 9.5h11V14a4.5 4.5 0 0 1-4.5 4.5h-2A4.5 4.5 0 0 1 5 14V9.5Z"/>',
    s: '<path d="M5 9.5h11V14a4.5 4.5 0 0 1-4.5 4.5h-2A4.5 4.5 0 0 1 5 14V9.5ZM16 11h1.4a2.3 2.3 0 0 1 0 4.6H16M8.5 3.4c-.8 1 .8 1.8 0 3M12 3.4c-.8 1 .8 1.8 0 3"/>',
    l: '<rect x="5.9" y="9.5" width="9.2" height="1.9" rx=".5"/>',
  },
  power: {
    s: '<path d="M7.2 6.9a7 7 0 1 0 9.6 0"/>',
    l: '<rect x="10.9" y="2.8" width="2.2" height="9.4" rx="1.1"/>',
  },
  todo: {
    s: '<path d="M11 7h9M11 12h9M11 17h6"/><rect x="4" y="10.2" width="3.6" height="3.6" rx=".9"/><rect x="4" y="15.2" width="3.6" height="3.6" rx=".9"/>',
    l: '<rect x="4" y="5.2" width="3.6" height="3.6" rx=".9"/>',
  },
  news: {
    d: '<path d="M4.5 4.5h12v14a2 2 0 0 0 2 2H6a1.5 1.5 0 0 1-1.5-1.5Z"/>',
    s: '<path d="M4.5 4.5h12v14a2 2 0 0 0 2 2H6a1.5 1.5 0 0 1-1.5-1.5ZM16.5 8.5h3v10a2 2 0 0 1-2 2M7.5 13.5h6M7.5 16.8h6"/>',
    l: '<rect x="7.5" y="7.4" width="6" height="3.2" rx=".6"/>',
  },
  cap: {
    d: '<path d="M2.5 9.5 12 5l9.5 4.5L12 14Z"/>',
    s: '<path d="M2.5 9.5 12 5l9.5 4.5L12 14ZM6.5 11.6v4c0 1.4 2.5 2.9 5.5 2.9s5.5-1.5 5.5-2.9v-4M21.5 9.5v4.6"/>',
    l: '<circle cx="21.5" cy="15.6" r="1.3"/>',
  },
  pin: {
    d: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11Z"/>',
    s: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11Z"/>',
    l: '<circle cx="12" cy="10" r="2.4"/>',
  },
  hourglass: {
    s: '<path d="M7 3.5h10M7 20.5h10M8.2 3.5c0 4 3.8 5 3.8 8.5s-3.8 4.5-3.8 8.5M15.8 3.5c0 4-3.8 5-3.8 8.5s3.8 4.5 3.8 8.5"/>',
    l: '<path d="M9.3 19.3c.6-2 2.7-2.7 2.7-4.2 0 1.5 2.1 2.2 2.7 4.2Z"/>',
  },
  loop: {
    s: '<path d="M19.4 12a7.4 7.4 0 0 1-12.6 5.3M4.6 12a7.4 7.4 0 0 1 12.6-5.3"/>',
    l: '<path d="m18.9 3.4.1 4.8-4.8-.1ZM5.1 20.6 5 15.8l4.8.1Z"/>',
  },
  sparkle: {
    s: '<path d="M18.6 3.2v3.2M17 4.8h3.2M5.4 17.6v2.8M4 19h2.8"/>',
    l: '<path d="M11 4.4c.7 4 3.2 6.5 7.2 7.2-4 .7-6.5 3.2-7.2 7.2-.7-4-3.2-6.5-7.2-7.2 4-.7 6.5-3.2 7.2-7.2Z"/>',
  },
  bell: {
    d: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15Z"/>',
    s: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15ZM12 3v2"/>',
    l: '<path d="M9.8 20a2.2 2.2 0 0 0 4.4 0Z"/>',
  },
  flag: {
    d: '<path d="M6 4.5h11.5l-2.4 4 2.4 4H6Z"/>',
    s: '<path d="M6 21V4.5M6 4.5h11.5l-2.4 4 2.4 4H6"/>',
    l: '<circle cx="6" cy="21" r="1.5"/>',
  },

  // ── počasie (malé) ──
  sun: {
    s: '<path d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M5.2 18.8l1.6-1.6M17.2 6.8l1.6-1.6"/>',
    l: '<circle cx="12" cy="12" r="4.3"/>',
  },
  cloud: {
    d: `<path d="${CLOUD}"/>`,
    s: `<path d="${CLOUD}"/>`,
    l: '<rect x="8.2" y="15.6" width="7.6" height="1.5" rx=".75"/>',
  },
  partly: {
    d: `<path d="${CLOUD}"/>`,
    s: `<path d="${CLOUD}"/><path d="M8.6 2.6v1.6M3.2 8h1.6M4.6 4l1.1 1.1M12.6 4l-1.1 1.1"/>`,
    l: '<path d="M5.4 9.6a3.4 3.4 0 0 1 6.2-1.9 6.4 6.4 0 0 0-4.6 2.5 4.9 4.9 0 0 0-1.6-.6Z"/>',
  },
  rain: {
    d: `<path d="${CLOUD_HI}"/>`,
    s: `<path d="${CLOUD_HI}"/><path d="m8.4 18.2-.9 2.4M16.4 18.2l-.9 2.4"/>`,
    l: '<path d="M12.3 17.4c.7 1 1.2 1.8 1.2 2.4a1.2 1.2 0 0 1-2.4 0c0-.6.5-1.4 1.2-2.4Z"/>',
  },
  snow: {
    d: `<path d="${CLOUD_HI}"/>`,
    s: `<path d="${CLOUD_HI}"/><path d="M8 18.5h0M16 18.5h0M10 21h0M14 21h0"/>`,
    l: '<path d="m12 16.9.5 1.1 1.1.5-1.1.5-.5 1.1-.5-1.1-1.1-.5 1.1-.5Z"/>',
  },
  night: {
    d: '<path d="M18.6 14.4A7.4 7.4 0 0 1 9.6 5.4a7.4 7.4 0 1 0 9 9Z"/>',
    s: '<path d="M18.6 14.4A7.4 7.4 0 0 1 9.6 5.4a7.4 7.4 0 1 0 9 9Z"/>',
    l: '<path d="m17.6 3.4.6 1.3 1.3.6-1.3.6-.6 1.3-.6-1.3-1.3-.6 1.3-.6Z"/>',
  },
  storm: {
    d: `<path d="${CLOUD_HI}"/>`,
    s: `<path d="${CLOUD_HI}"/>`,
    l: '<path d="m12.6 15.6-2.6 3.6h2.2l-.6 3.2 3-4.2h-2.2l.9-2.6Z"/>',
  },
  fog: {
    s: '<path d="M4 9h13M7 12.5h13M4 16h11M9 19.5h9"/>',
    l: '<rect x="17.6" y="15.1" width="3.4" height="1.8" rx=".9"/>',
  },
  // ── files and imports (drop.js, people.js) ──
  clip: {
    s: '<path d="m19.6 11.4-7.4 7.4a4.6 4.6 0 0 1-6.5-6.5l7.9-7.9a3.1 3.1 0 0 1 4.4 4.4l-7.8 7.8a1.6 1.6 0 0 1-2.3-2.3l6.9-6.9"/>',
    l: '<circle cx="19.9" cy="17.9" r="1.5"/>',
  },
  upload: {
    d: '<path d="M4.5 14.5h15V18a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2Z"/>',
    s: '<path d="M4.5 13.5V18a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4.5M12 15.4V6.2"/>',
    l: '<path d="M12 3.2 16.4 8H7.6Z"/>',
  },
  folder: {
    d: '<path d="M3.5 8.5h17V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/>',
    s: '<path d="M3.5 17V7a2 2 0 0 1 2-2h3.6l2 2.5h7.4a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/>',
    l: '<rect x="6.6" y="14.3" width="5" height="1.9" rx=".95"/>',
  },
  archive: {
    d: '<path d="M5 9.5h14V18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z"/>',
    s: '<path d="M4.5 4.5h15a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1ZM5 9.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9.5"/>',
    l: '<rect x="9.2" y="12.4" width="5.6" height="2" rx="1"/>',
  },
  people: {
    s: '<path d="M2.8 19.6a6.2 6.2 0 0 1 12.4 0M16.2 13.4a5 5 0 0 1 5 5"/><circle cx="16.4" cy="8.2" r="2.6"/>',
    l: '<circle cx="9" cy="8.6" r="3.4"/>',
  },
  link: {
    s: '<path d="M10.2 13.8a3.7 3.7 0 0 0 5.2 0l3.2-3.2a3.7 3.7 0 0 0-5.2-5.2l-1 1M13.8 10.2a3.7 3.7 0 0 0-5.2 0l-3.2 3.2a3.7 3.7 0 0 0 5.2 5.2l1-1"/>',
    l: '<circle cx="19.6" cy="18.6" r="1.5"/>',
  },
  skip: {
    s: '<path d="m5.5 6.5 5.5 5.5-5.5 5.5M12.5 6.5 18 12l-5.5 5.5"/>',
    l: '<rect x="19.4" y="6" width="1.9" height="12" rx=".95"/>',
  },
  plus: {
    d: '<circle cx="12" cy="12" r="8.6"/>',
    s: '<circle cx="12" cy="12" r="8.6"/>',
    l: '<path d="M11 7.6h2V11h3.4v2H13v3.4h-2V13H7.6v-2H11Z"/>',
  },
  mail: {
    d: '<rect x="3" y="5.5" width="18" height="13" rx="2"/>',
    s: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.6 7.4 8.4 6.2 8.4-6.2"/>',
    l: '<circle cx="19.4" cy="5.6" r="2.1"/>',
  },
  play: {
    d: '<rect x="3" y="5" width="18" height="14" rx="2.2"/>',
    s: '<rect x="3" y="5" width="18" height="14" rx="2.2"/>',
    l: '<path d="M10 8.9v6.2l5.4-3.1Z"/>',
  },
  sliders: {
    s: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/>',
    l: '<circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  },
}

/** Mená z v1 a scenes.json, aby staré udalosti mali ikonu. */
const ALIAS = {
  message: 'spravy',
  photo: 'fotky',
  timeline: 'udalosti',
  moon: 'spanok',
  sleep: 'spanok',
  calendar: 'kalendar',
  routine: 'rutiny',
  gear: 'rutiny',
  project: 'projekty',
  quest: 'questy',
  compass: 'questy',
  brain: 'memory',
  web: 'globe',
  mac: 'laptop',
  window: 'app',
  chrome: 'tab',
  health: 'heart',
  todo_list: 'todo',
  school: 'cap',
  place: 'pin',
  deadline: 'hourglass',
  alert: 'alarm',
  action: 'bolt',
  done: 'check',
  guard: 'shield',
  voice: 'wave',
  listen: 'wake',
  tts: 'speaker',
  volume: 'speaker',
  sound: 'speaker',
  drizzle: 'rain',
  'partly-night': 'night',
  ear: 'wake',
  clear: 'sun',
  cloudy: 'cloud',
  overcast: 'cloud',
}

const resolve = (name) => (ICONS[name] ? name : ALIAS[name] && ICONS[ALIAS[name]] ? ALIAS[name] : null)

export const hasIcon = (name) => Boolean(resolve(name))

export const ICON_NAMES = Object.keys(ICONS)

/** SVG ikony ako string. cls pridá triedy (napr. „ic-lg"). */
export function icon(name, cls = '') {
  const key = resolve(name) ?? 'info'
  const def = ICONS[key]
  return (
    `<svg class="ic ic-${key}${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true">` +
    (def.d ? `<g class="ic-d">${def.d}</g>` : '') +
    (def.s ? `<g class="ic-s">${def.s}</g>` : '') +
    (def.l ? `<g class="ic-l">${def.l}</g>` : '') +
    '</svg>'
  )
}

// ── uzly ──

export const NODE_ICON = {
  spravy: 'spravy',
  fotky: 'fotky',
  udalosti: 'udalosti',
  spanok: 'spanok',
  kalendar: 'kalendar',
  rutiny: 'rutiny',
  projekty: 'projekty',
  questy: 'questy',
  posta: 'mail',
  ulohy: 'todo',
  ludia: 'people',
  appky: 'app',
}

/** Holografický render uzla (public/img/holo), pre karty v rozhovore. */
const HOLO = new Set(['spravy', 'fotky', 'udalosti', 'spanok', 'kalendar', 'rutiny', 'projekty', 'questy'])
export const holoImage = (node) => (HOLO.has(node) ? `/img/holo/${node}.png` : null)

/**
 * Ikona nástroja mozgu, keď ju server nepošle alebo ju sada nepozná.
 * name je MCP názov nástroja (napr. mcp__memory__calendar_list).
 */
export function toolIcon(tool = {}) {
  if (tool.icon && hasIcon(tool.icon)) return resolve(tool.icon)
  if (tool.node && NODE_ICON[tool.node]) return NODE_ICON[tool.node]
  const n = String(tool.name ?? '').toLowerCase()
  const rules = [
    [/calendar|day_plan|schedule/, 'kalendar'],
    [/health|sleep|garmin/, 'spanok'],
    [/semantic|search|query|describe/, 'search'],
    [/message|person|thread/, 'spravy'],
    [/photo/, 'fotky'],
    [/quest/, 'questy'],
    [/todo/, 'todo'],
    [/note|vault/, 'note'],
    [/place|location/, 'pin'],
    [/news/, 'news'],
    [/celebration|nameday/, 'gift'],
    [/weekly_score|score|chart/, 'chart'],
    [/websearch|webfetch|web_|fetch/, 'globe'],
    [/mac_do|mac/, 'laptop'],
    [/music|spotify/, 'music'],
    [/hud_focus|focus/, 'target'],
    [/hud_card|card/, 'sparkle'],
    [/hud_log|log/, 'bolt'],
  ]
  for (const [re, key] of rules) if (re.test(n)) return key
  return 'sparkle'
}

// ── emblémy botov (32 px mriežka) ──

const EMBLEMS = {
  // Jarvis sám (rozhovor, karty).
  jarvis: {
    d: '<circle cx="16" cy="16" r="12.5"/>',
    s: '<path d="M16 3.5a12.5 12.5 0 0 1 12.2 9.7M28.2 18.8A12.5 12.5 0 0 1 18.8 28.2M13.2 28.2A12.5 12.5 0 0 1 3.8 18.8M3.8 13.2A12.5 12.5 0 0 1 13.2 3.8"/><circle cx="16" cy="16" r="7"/>',
    l: '<circle cx="16" cy="16" r="3.3"/>',
  },
}

/** Routine emblem key (one emblem for everything Jarvis runs). */
export function botKey() {
  return 'jarvis'
}

export function emblem(name, cls = '') {
  const def = EMBLEMS[name] ?? EMBLEMS.jarvis
  return (
    `<svg class="em em-${EMBLEMS[name] ? name : 'jarvis'}${cls ? ` ${cls}` : ''}" viewBox="0 0 32 32" aria-hidden="true">` +
    `<g class="ic-d">${def.d}</g><g class="ic-s">${def.s}</g><g class="ic-l">${def.l}</g></svg>`
  )
}

export const EMBLEM_NAMES = Object.keys(EMBLEMS)
