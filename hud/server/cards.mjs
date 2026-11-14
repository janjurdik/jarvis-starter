/**
 * Karta od Jarvisa (nástroj hud_card a mock): overenie a orezanie podľa kontraktu v docs/API.md.
 */
import { ICONS, NODES } from './tools-meta.mjs'
import { clean } from './util.mjs'

const KINDS = new Set(['stat', 'list', 'chart', 'text'])
const ACCENTS = new Set(['ice', 'amber', 'red'])

const str = (v, max) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : clean(v, max)) || null

export function normalizeCard(input, id) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'karta musí byť objekt' }
  const src = input.card && typeof input.card === 'object' ? input.card : input
  const kind = String(src.kind ?? '').toLowerCase()
  if (!KINDS.has(kind)) return { ok: false, error: `kind musí byť stat, list, chart alebo text (dostal som ${JSON.stringify(src.kind)})` }
  const title = clean(src.title, 60)
  if (!title) return { ok: false, error: 'chýba title' }
  const icon = ICONS.includes(src.icon) ? src.icon : null
  const node = NODES.includes(src.node) ? src.node : null
  const card = {
    id,
    kind,
    title,
    icon,
    node,
    value: str(src.value, 24),
    unit: str(src.unit, 12),
    caption: str(src.caption, 80),
    accent: ACCENTS.has(src.accent) ? src.accent : 'ice',
    items: [],
    series: [],
    text: kind === 'text' ? clean(src.text, 400) || null : null,
  }
  if (Array.isArray(src.items)) {
    card.items = src.items
      .slice(0, 8)
      .filter((it) => it && typeof it === 'object')
      .map((it) => ({ label: str(it.label, 48) ?? '', value: str(it.value, 24), sub: str(it.sub, 48) }))
      .filter((it) => it.label || it.value)
  }
  if (Array.isArray(src.series)) {
    card.series = src.series
      .slice(0, 14)
      .filter((it) => it && typeof it === 'object' && Number.isFinite(Number(it.value)))
      .map((it) => ({ label: str(it.label, 12) ?? '', value: Number(it.value) }))
  }
  if (kind === 'list' && !card.items.length) return { ok: false, error: 'list karta potrebuje items' }
  if (kind === 'chart' && card.series.length < 2) return { ok: false, error: 'chart karta potrebuje aspoň 2 hodnoty v series' }
  if (kind === 'stat' && !card.value) return { ok: false, error: 'stat karta potrebuje value' }
  if (kind === 'text' && !card.text) return { ok: false, error: 'text karta potrebuje text' }
  return { ok: true, card }
}
