/**
 * What Jarvis recommends adding next. He does not wait to be asked: from what the computer scan
 * found, from what is half connected and from what he noticed himself (in the mail, in the
 * calendar, in a routine), he keeps a short list of things worth having and offers them, one at a
 * time, on the desktop and in conversation.
 *
 *   GET  /api/suggest                    { ok, items: [{ id, kind, title, why, say }] }
 *   POST /api/suggest { dismiss: id }    the user does not want this one
 *   POST /api/suggest { add: { title, why, say } }   an idea from Jarvis himself (his tool `suggest`,
 *                                        or `node scripts/suggest.mjs add` from a routine)
 *
 * Kept in data/suggestions.json ({ own: [...], dismissed: [...] }). Nothing here does anything by
 * itself: a suggestion is a sentence the user can say yes to.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_BY_ID } from '../public/apps/catalog.js'
import { getApps } from './apps.mjs'
import { getConfig } from './config.mjs'
import { orbContent } from './orbs.mjs'
import { getSetup } from './setup.mjs'
import { DATA_DIR, clean, writeFileAtomic } from './util.mjs'

const FILE = join(DATA_DIR, 'suggestions.json')
const MAX_OWN = 12

function read() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'))
    return { own: Array.isArray(raw?.own) ? raw.own : [], dismissed: Array.isArray(raw?.dismissed) ? raw.dismissed.map(String) : [] }
  } catch {
    return { own: [], dismissed: [] }
  }
}

const idOf = (text) =>
  String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)

/** How an app gets into Jarvis, in the words of an offer. */
const HOW_SAY = { connector: 'Pripojím ho naživo cez konektor.', export: 'Stačí kópia vašich dát, prevediem vás tým.', auto: 'Nájdem si ho v počítači sám.', garmin: 'Prihlásite sa raz a mám spánok aj tréningy naživo.', file: 'Stačí mi pretiahnuť súbor.', ask: 'Cestu k nemu vymyslím sám.', beeper: 'Pripojím ho naživo.' }

/** Everything worth offering right now, the most useful first. */
export function suggestions() {
  const { own, dismissed } = read()
  const gone = new Set(dismissed)
  const out = []
  const add = (item) => {
    if (!gone.has(item.id) && !out.some((x) => x.id === item.id)) out.push(item)
  }
  // 1. What Jarvis noticed himself comes first: it is about this person, not about a catalog.
  for (const o of own) add({ id: o.id, kind: 'idea', title: o.title, why: o.why ?? null, say: o.say ?? `${o.title}.` })
  if (getSetup().done) {
    const apps = getApps()
    const picked = new Set(apps.picked)
    const connected = new Set(apps.connected)
    // 2. Chosen, but still waiting to be connected: the mail and the calendar first, they feed everything else.
    const mailFirst = [...apps.picked].sort((a, b) => (APP_BY_ID.get(a)?.group === 'mail' ? 0 : 1) - (APP_BY_ID.get(b)?.group === 'mail' ? 0 : 1))
    for (const id of mailFirst) {
      const app = APP_BY_ID.get(id)
      if (!app || app.how !== 'connector' || connected.has(id)) continue
      add({ id: `connect-${id}`, kind: 'app', app: id, title: `Pripojiť ${app.name}`, why: app.gives, say: `Pripoj mi ${app.name}.` })
    }
    // 3. Found on this computer and not in Jarvis yet.
    for (const id of apps.detected) {
      const app = APP_BY_ID.get(id)
      if (!app || picked.has(id)) continue
      add({ id: `add-${id}`, kind: 'app', app: id, title: `Pridať ${app.name}`, why: `Našiel som ho vo vašom počítači. ${HOW_SAY[app.how] ?? ''}`.trim(), say: `Používam aj ${app.name}, pridaj si ho.` })
    }
    // 4. The base that is still switched off.
    const cfg = getConfig()
    if (!cfg.alarm?.enabled) add({ id: 'base-alarm', kind: 'base', title: 'Ranný budík', why: 'Zobudím vás skladbou a poviem, čo vás čaká.', say: 'Nastav mi budík.' })
    if (connected.has('gmail') && !cfg.routines.some((r) => r.id === 'straz-posty' && r.enabled) && !orbContent('posta')) add({ id: 'base-mailwatch', kind: 'base', title: 'Stráž pošty', why: 'Každú hodinu pretriedim poštu a ozvem sa len pri dôležitom.', say: 'Zapni stráž pošty.' })
  }
  return out.slice(0, 8)
}

/** One idea from Jarvis himself. The same title twice is one idea. */
export async function addSuggestion(body = {}) {
  const title = clean(body.title, 60)
  if (!title) throw Object.assign(new Error('chýba title'), { status: 400 })
  const state = read()
  const item = { id: `idea-${idOf(title)}`, title, why: clean(body.why, 160) || null, say: clean(body.say, 200) || null, at: new Date().toISOString() }
  const own = [item, ...state.own.filter((o) => o.id !== item.id)].slice(0, MAX_OWN)
  await writeFileAtomic(FILE, `${JSON.stringify({ own, dismissed: state.dismissed.filter((d) => d !== item.id) }, null, 2)}\n`, 0o600)
  return item
}

/** The user does not want it (or it is done): it never comes back. */
export async function dismissSuggestion(id) {
  const key = clean(String(id ?? ''), 80)
  if (!key) throw Object.assign(new Error('chýba id'), { status: 400 })
  const state = read()
  await writeFileAtomic(FILE, `${JSON.stringify({ own: state.own.filter((o) => o.id !== key), dismissed: [...new Set([...state.dismissed, key])].slice(-200) }, null, 2)}\n`, 0o600)
  return suggestions()
}

/** One line for the brain's context: what he may offer when the moment is right. */
export function suggestContextNote() {
  const items = suggestions().slice(0, 3)
  if (!items.length) return ''
  return `[čo môžeš sám ponúknuť, keď sa to hodí, najviac jednu vec za rozhovor a nikdy uprostred inej práce: ${items.map((i) => `${i.title}${i.why ? ` (${i.why})` : ''}`).join('; ')}]`
}
