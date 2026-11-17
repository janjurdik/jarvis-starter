// The orbs of the 3D world: which exist right now and where each one sits.
//
// The world starts small and grows with the user. A few orbs are the base everyone has (apps,
// mail, calendar, tasks, routines, people, notes). The others appear when there is something in
// them (a first goal, a first night of sleep, a folder of books) and Jarvis can add his own on
// request (`node scripts/orb.mjs add …`, tool hud_orb): data/orbs.json, GET /api/orbs, SSE `orbs`.
//
//   activeOrbs({ counts, state })  → the orbs to show, in ring order
//   layoutOrbs(list)               → the same list with u, v, z, size and label side

/** Big planets on the outer ring, clockwise from the top. `base` orbs are always there. */
const PLANETS = [
  { id: 'appky', base: true, size: 1.25 },
  { id: 'posta', base: true, size: 1.0 },
  { id: 'kalendar', base: true, size: 0.95 },
  { id: 'ulohy', base: true, size: 0.95 },
  { id: 'rutiny', base: true, size: 0.85 },
  { id: 'questy', size: 0.95 },
  { id: 'spanok', size: 1.05 },
  { id: 'ludia', base: true, size: 1.15 },
  { id: 'udalosti', size: 0.9 },
  { id: 'fotky', base: true, size: 1.05 },
  { id: 'projekty', size: 1.1 },
  { id: 'spravy', size: 0.95 },
]

/** Small moons closer to the core: a folder of that name in the memory brings one in. */
const MOONS = [
  { id: 'skola', icon: 'school' },
  { id: 'knihy', icon: 'book' },
  { id: 'filmy', icon: 'film' },
  { id: 'hudba', icon: 'music' },
  { id: 'miesta', icon: 'place' },
  { id: 'zdroje', icon: 'sparkle' },
  { id: 'content', icon: 'app' },
  { id: 'hry', icon: 'app', shape: 'minecraft' },
]

export const BUILTIN_IDS = new Set([...PLANETS, ...MOONS].map((o) => o.id))
const MAX_PLANETS = 14
const MAX_MOONS = 8

/**
 * @param {{ counts: Record<string, number>, state: { hidden?: string[], pinned?: string[], custom?: object[] } }} input
 * counts: how many things each orb holds (0 hides an orb that is not part of the base)
 */
export function activeOrbs({ counts = {}, state = {} }) {
  const hidden = new Set(state.hidden ?? [])
  const pinned = new Set(state.pinned ?? [])
  const shown = (o) => o.id === 'appky' || (!hidden.has(o.id) && (o.base || pinned.has(o.id) || (counts[o.id] ?? 0) > 0))
  const custom = (state.custom ?? []).filter((c) => c && typeof c.id === 'string' && !BUILTIN_IDS.has(c.id) && !hidden.has(c.id))
  const planets = PLANETS.filter(shown).map((o) => ({ ...o }))
  // Jarvis's own orbs join the ring just before the memory side (people, notes).
  const at = Math.max(1, planets.findIndex((o) => o.id === 'ludia'))
  planets.splice(at, 0, ...custom.filter((c) => c.kind !== 'moon').map((c) => ({ id: c.id, size: 1, custom: true, label: c.label, icon: c.icon, color: c.color, shape: c.shape })))
  const moons = [
    ...MOONS.filter(shown).map((o) => ({ ...o })),
    ...custom.filter((c) => c.kind === 'moon').map((c) => ({ id: c.id, custom: true, label: c.label, icon: c.icon, color: c.color, shape: c.shape })),
  ]
  return [...planets.slice(0, MAX_PLANETS), ...moons.slice(0, MAX_MOONS).map((m) => ({ ...m, minor: true }))]
}

const frac = (x) => x - Math.floor(x)

/** Places the planets evenly on the ring (the first one on top) and the moons on two inner arcs. */
export function layoutOrbs(list) {
  const planets = list.filter((o) => !o.minor)
  const moons = list.filter((o) => o.minor)
  const n = planets.length
  // Few orbs: each one may be a little bigger, the world should not look empty.
  const grow = n <= 6 ? 1.16 : n <= 8 ? 1.08 : n >= 12 ? 0.9 : 1
  const out = planets.map((o, i) => {
    const a = (i / n) * Math.PI * 2
    const u = Math.sin(a) * 0.9
    const v = Math.cos(a) * 0.86
    return {
      ...o,
      u,
      v,
      z: (i % 2 ? -1 : 1) * (0.26 + 0.34 * frac(i * 0.618 + 0.2)),
      size: (o.size ?? 1) * grow,
      // Where the label goes so it never lands on a neighbour: at the poles it faces the core
      // (under the top orb, above the bottom ones), on the flanks it sits beside the orb toward
      // the core, and in between it points outward, where the ring leaves room for it.
      side: Math.abs(u) < 0.32 ? (v > 0 ? 'below' : 'above') : Math.abs(v) < 0.4 ? (u < 0 ? 'right' : 'left') : v > 0 ? 'above' : 'below',
    }
  })
  // Moons sit left and right of the core: the top and the bottom of the middle stay free for
  // the labels of the polar planets.
  moons.forEach((o, i) => {
    const right = i % 2 === 0
    const row = Math.floor(i / 2)
    const rows = Math.ceil(moons.length / 2)
    const t = rows === 1 ? 0 : (row / (rows - 1)) * 2 - 1
    const a = t * 0.62
    const u = (right ? 1 : -1) * Math.cos(a) * 0.5
    const v = Math.sin(a) * 0.46 + (right ? 0.05 : -0.05)
    out.push({ ...o, u, v, z: -1.15 - (i % 3) * 0.2, size: 0.8, side: v >= -0.05 ? 'above' : 'below' })
  })
  return out
}
