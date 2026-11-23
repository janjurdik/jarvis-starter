/**
 * Simple model routing for the work Jarvis does on his own (background jobs).
 *
 * A job has a weight: `light` (look something up, check the mail, summarise), `normal`, or `heavy`
 * (create, write, program, analyse). The weight picks the model: the fast one for light work, the
 * strongest one for heavy work. Jarvis names the weight himself when he starts a job (the
 * `weight` argument of his `agent_task` tool) and says it aloud; a job started from the command
 * line gets a guess from its wording.
 *
 *   config/jarvis.json   "routing": "auto" (default) | "heavy" (always the strongest) | "light" (always the fastest)
 *   .env                 JARVIS_JOB_MODEL=<model> switches routing off: every job runs on that model
 *
 * What a tier means on each agent is written in its entry in provider.mjs (`tiers` for models,
 * `efforts` for the reasoning effort, where the agent has one model and a dial).
 */
import { getConfig } from './config.mjs'
import { aiProvider } from './provider.mjs'

export const WEIGHTS = ['light', 'normal', 'heavy']
export const MODES = ['auto', 'heavy', 'light']

// Wording that gives a job away. Heavy wins over light: „pozri maily a napíš odpovede" is writing.
const HEAVY = /(vytvor|vyrob|naprogramuj|doprogramuj|postav|navrhni|nap[ií][sš]|prep[ií][sš]|refaktor|analyzuj|porovnaj|napl[aá]nuj|vymysli|vypracuj|re[sš]er[sš]|strat[eé]gi|prezent[aá]ci|dokument|report|skript|k[oó]d|appk|aplik[aá]ci|web|oprav|uprac|pretrie[dď]|vytvoř|naprogramuj|napiš|navrhni)/i
const LIGHT = /(pozri|skontroluj|zisti|over|ko[ľl]ko|kedy|zhr[nň]|pre[cč][ií]taj|n[aá]jdi|vyh[ľl]adaj|otvor|pripome[nň]|po[cč]asie|kalend[aá]r|mail|po[sš]t[auy]|zkontroluj|podívej|shr[nň])/i

/** The mode the user chose (Settings → Mozog), or „auto". */
export function routingMode() {
  const mode = String(getConfig().routing ?? 'auto').toLowerCase()
  return MODES.includes(mode) ? mode : 'auto'
}

/** A weight from the wording of a task, for jobs that did not get one from Jarvis. */
export function guessWeight(task) {
  const text = String(task ?? '')
  if (HEAVY.test(text) || text.length > 600) return 'heavy'
  if (LIGHT.test(text) && text.length < 240) return 'light'
  return 'normal'
}

/**
 * The weight, the model and the reasoning effort of one job.
 * `model` is an explicit model (a routine's own): it wins and no routing happens.
 * Returns { weight, model, effort, label } where label is the small note the user sees next to the job:
 * the model only („Haiku"). How hard the job is stays inside, nobody has to hear it.
 */
export function routeJob({ task, weight = null, model = null } = {}) {
  const provider = aiProvider()
  const fixed = model || process.env.JARVIS_JOB_MODEL || null
  const w = WEIGHTS.includes(weight) ? weight : guessWeight(task)
  if (fixed) return { weight: w, model: fixed, effort: null, label: nice(fixed) }
  const mode = routingMode()
  const tier = mode === 'auto' ? w : mode
  const picked = provider.tiers?.[tier] ?? null
  const effort = provider.efforts?.[tier] ?? null
  const what = picked ? nice(picked) : effort ? `${provider.name}, ${{ low: 'rýchlo', medium: 'bežne', high: 'dôkladne', xhigh: 'veľmi dôkladne' }[effort] ?? effort}` : provider.name
  return { weight: w, model: picked, effort, label: what }
}

/** A model id as a name a person reads: „haiku" → „Haiku", „gemini-4-neon" → „Gemini 4 Neon". */
function nice(id) {
  return String(id)
    .split(/[-_]/)
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(' ')
}

/** For Settings: the mode, whether .env holds it, and what each tier means on the current agent. */
export function routingInfo() {
  const provider = aiProvider()
  const locked = Boolean(String(process.env.JARVIS_JOB_MODEL ?? '').trim())
  const name = (tier) => (provider.tiers?.[tier] ? nice(provider.tiers[tier]) : null)
  return { mode: routingMode(), locked, fixed: locked ? nice(process.env.JARVIS_JOB_MODEL) : null, light: name('light'), normal: name('normal'), heavy: name('heavy'), models: Boolean(provider.tiers) }
}
