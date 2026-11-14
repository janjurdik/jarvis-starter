// Slovenské formátovanie čísel, dátumov a dĺžok. Medzera v tisícoch je nezlomiteľná (sk-SK).

const numberFormat = new Intl.NumberFormat('sk-SK')

export const nf = (n) => numberFormat.format(Math.round(n))

export const DAYS = ['nedeľa', 'pondelok', 'utorok', 'streda', 'štvrtok', 'piatok', 'sobota']
export const DAYS_SHORT = ['ne', 'po', 'ut', 'st', 'št', 'pi', 'so']
const MONTHS_GEN = ['januára', 'februára', 'marca', 'apríla', 'mája', 'júna', 'júla', 'augusta', 'septembra', 'októbra', 'novembra', 'decembra']

export const pad2 = (n) => String(n).padStart(2, '0')

/** „21:40:05" */
export const hms = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
/** „21:40" */
export const hm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
/** „9. 11." */
export const dayMonth = (d) => `${d.getDate()}. ${d.getMonth() + 1}.`
/** „po 9. 11." */
export const shortDate = (d) => `${DAYS_SHORT[d.getDay()]} ${dayMonth(d)}`
/** „pondelok 9. novembra" */
export const longDate = (d) => `${DAYS[d.getDay()]} ${d.getDate()}. ${MONTHS_GEN[d.getMonth()]}`

/** 438 → „7 h 18 min" */
export function duration(min) {
  const m = Math.max(0, Math.round(min))
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (!h) return `${rest} min`
  return rest ? `${h} h ${rest} min` : `${h} h`
}

/** Za koľko to bude: „o 50 min", „o 1 h 20 min", „teraz". */
export function until(minutes) {
  if (minutes < 1) return 'teraz'
  return `o ${duration(minutes)}`
}

/** „2026-11-09" → Date o polnoci miestneho času. */
export function parseDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '')
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

export const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** „07:00" → minúty od polnoci, inak null („každých 5 min", „Ne 19:00"). */
export function clockMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value ?? '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** Slovenské tvary: 1 položka, 2 až 4 položky, 5 a viac položiek. */
export const plural = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many)

/** HTML escape pre text z dát (snapshot, chat, udalosti). */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
export const smooth = (x) => {
  const t = clamp(x)
  return t * t * (3 - 2 * t)
}
/** Výstup ako spring s tlmením ~200: rýchly nábeh, mäkké dosadnutie, bez prekmitu. */
export const easeOut = (x) => 1 - Math.pow(1 - clamp(x), 4)

/**
 * Kedy zaznie ktoré slovo repliky: dĺžka slova + pauza za interpunkciou, rozložené
 * na dĺžku repliky (titulok aj rozhovor v scéne svietia slovo po slove rovnako).
 */
export function wordTimes(text, t0, t1) {
  const parts = String(text).split(/\s+/).filter(Boolean)
  const weights = parts.map((w) => w.replace(/[^\p{L}\p{N}]/gu, '').length + 1.6 + (/[,;:]$/.test(w) ? 3 : 0) + (/[.?!…]$/.test(w) ? 5 : 0))
  const total = weights.reduce((a, b) => a + b, 0) || 1
  const speech = Math.max(0.4, t1 - t0 - 0.18)
  let acc = 0
  return parts.map((w, i) => {
    const start = t0 + (acc / total) * speech
    acc += weights[i]
    return { w, start }
  })
}

/** Deterministický PRNG (mulberry32), aby každé načítanie a každý render snímky vyzeral rovnako. */
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

export function hash(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}
