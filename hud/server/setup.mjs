/**
 * Where the first setup stands. Setup is a conversation with Jarvis on the desktop, not a form:
 * Jarvis leads it, does the work himself and notes here what is done, so it survives a restart
 * and can be picked up any time ("pokračujme v nastavení").
 *
 *   data/setup.json   { done, hotove: [step], caka: [text], ciel, ai, startedAt, finishedAt }
 *
 * The steps are a checklist of the base every Jarvis has (mail, tasks, calendar, memory, voice,
 * alarm). Everything else is added later, on request, and is not part of setup.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_FILE } from './config.mjs'
import { FILES, MEMORY_DIR } from './memory/index.mjs'
import { DATA_DIR, clean, writeFileAtomic } from './util.mjs'

export const SETUP_FILE = join(DATA_DIR, 'setup.json')

/** The base, in the order Jarvis walks through it. `say` is what the step means, for the brain. */
export const STEPS = [
  { id: 'sken', say: 'prezrieť si počítač a zapísať do pamäte, kto používateľ je (úloha na pozadí)' },
  { id: 'oslovenie', say: 'meno, oslovenie (pane, pani), tykanie alebo vykanie, mesto' },
  { id: 'ciel', say: 'jedna otázka: čo má Jarvis robiť za neho ako prvé' },
  { id: 'appky', say: 'otvoriť orb Tvoje appky, nech ukáže, čo používa' },
  { id: 'posta', say: 'pripojiť poštu' },
  { id: 'kalendar', say: 'pripojiť kalendár' },
  { id: 'ulohy', say: 'kde vedie úlohy, prvé úlohy do pamäte' },
  { id: 'budik', say: 'kedy vstáva a čo chce ráno počuť, skúška budíka' },
  { id: 'samostatnost', say: 'zapnúť rutiny a pulz v systéme, nech sa Jarvis ozýva sám' },
  { id: 'prva-vec', say: 'postaviť prvú vec podľa jeho cieľa (orb, rutina, stráž)' },
]
const IDS = new Set(STEPS.map((s) => s.id))

function read() {
  try {
    const raw = JSON.parse(readFileSync(SETUP_FILE, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

export function getSetup() {
  const raw = read()
  // Older versions kept a step number and free text: whatever is there, the new shape wins.
  const hotove = [...new Set((Array.isArray(raw.hotove) ? raw.hotove : []).filter((s) => IDS.has(s)))]
  const caka = (Array.isArray(raw.caka) ? raw.caka : []).map((t) => clean(t, 160)).filter(Boolean).slice(0, 12)
  // Someone who set Jarvis up with an older version (a config and a profile exist, no `done` yet) is not walked through it again.
  const legacy = raw.done === undefined && existsSync(CONFIG_FILE) && existsSync(join(MEMORY_DIR, FILES.me))
  const done = raw.done === true || raw.hotovo === true || legacy
  const next = done ? null : STEPS.find((s) => !hotove.includes(s.id)) ?? null
  return { done, hotove, caka, ciel: clean(raw.ciel, 400) || null, ai: typeof raw.ai === 'string' ? raw.ai : null, startedAt: raw.startedAt ?? null, finishedAt: raw.finishedAt ?? null, next: next?.id ?? null, exists: Object.keys(raw).length > 0 }
}

/**
 * One note from Jarvis: steps done, things waiting for the user, the goal, or the end of setup.
 * body: { done?: [step], undo?: [step], waiting?: [text], resolved?: [text], goal?: text, finished?: boolean }
 */
export async function noteSetup(body = {}) {
  const raw = read()
  const cur = getSetup()
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x))
  const hotove = new Set(cur.hotove)
  for (const s of list(body.done)) if (IDS.has(s)) hotove.add(s)
  for (const s of list(body.undo)) hotove.delete(s)
  let caka = cur.caka
  const gone = list(body.resolved).map((t) => t.toLowerCase())
  if (gone.length) caka = caka.filter((t) => !gone.some((g) => t.toLowerCase().includes(g) || g.includes(t.toLowerCase())))
  for (const t of list(body.waiting)) {
    const text = clean(t, 160)
    if (text && !caka.includes(text)) caka.push(text)
  }
  const finished = body.finished === true || (body.finished !== false && cur.done)
  const next = {
    ...raw,
    done: finished,
    hotove: STEPS.map((s) => s.id).filter((s) => hotove.has(s)),
    caka: caka.slice(0, 12),
    ciel: body.goal !== undefined ? clean(body.goal, 400) || null : cur.ciel,
    startedAt: raw.startedAt ?? new Date().toISOString(),
    ...(finished && !raw.finishedAt ? { finishedAt: new Date().toISOString() } : {}),
  }
  await writeFileAtomic(SETUP_FILE, `${JSON.stringify(next, null, 2)}\n`, 0o600)
  return getSetup()
}

/** One line for the brain's context on every turn while setup is not finished. */
export function setupContextNote() {
  const s = getSetup()
  if (s.done) return ''
  const left = STEPS.filter((x) => !s.hotove.includes(x.id)).map((x) => x.id)
  return `[nastavenie: ${s.hotove.length ? `hotové ${s.hotove.join(', ')}` : 'ešte nič nie je hotové'} · ostáva ${left.join(', ') || 'už len ukončiť'}${s.ciel ? ` · chce: ${s.ciel}` : ''}${s.caka.length ? ` · čaká na neho: ${s.caka.join('; ')}` : ''}]`
}
