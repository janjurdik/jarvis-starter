/**
 * Stráže („daj mi vedieť, keď…"): conditions the user names in one sentence, which Jarvis checks
 * on his own in the background and speaks up about only when they are really met.
 *
 * A watch is data, not a routine: it lives in data/watches.json, so a new one needs neither an
 * edit of config/jarvis.json nor a new system schedule. The pulse (scripts/pulse.mjs, every few
 * minutes from the system scheduler) and the HUD server (every minute) call `kickWatches()`, which
 * starts `node scripts/watch.mjs tick` in the background when a watch is due. The tick runs the
 * checks, one cheap agent run each (the light model of the provider, docs/MODELY.md), at most
 * two at once.
 *
 *   data/watches.json   { seq, watches: [watch] }, written atomically under a small lock
 *
 *   watch = { id, what, check, every, between, until, once, notify, urgent, model,
 *             status: active | paused | done | expired, createdAt, updatedAt, endedAt, endReason,
 *             state: { observation, lastCheckAt, lastResult, lastHit, lastHitAt, link, errors,
 *                      lastError, checks, hits, runningSince, runningPid } }
 *
 * A check ends with one strict line: `HIT: <sentence for the user>`, `NO: <what it saw now>` or
 * `ERROR: <why it could not check>`. Anything else counts as an error, never as a hit, so a
 * confused run cannot raise a false alarm. docs/STRAZE.md describes it for people.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inWindow, quietNow } from './alarm.mjs'
import { getConfig } from './config.mjs'
import { changeOrbs, customOrb } from './orbs.mjs'
import { DATA_DIR, DOW_LONG, REPO, clean, isoDay } from './util.mjs'

export const STORE_FILE = join(DATA_DIR, 'watches.json')
export const WATCH_DIR = join(DATA_DIR, 'watches')
const LOCK_DIR = join(DATA_DIR, 'watches.lock')
const TICK_LOCK = join(WATCH_DIR, 'tick.lock')

/** Checks running at once, and at most this many in one tick (a Mac waking up after a night does not fire them all). */
export const MAX_PARALLEL = 2
export const MAX_PER_TICK = 8
/** Failed checks in a row after which the watch pauses and Jarvis says so once. */
export const MAX_ERRORS = 3
/** A check that has been "running" longer than this died with its process. */
export const RUN_STALE_MS = 15 * 60_000
export const CHECK_TIMEOUT_MS = 6 * 60_000
export const MIN_EVERY = 5
export const MAX_EVERY = 7 * 1440
/** Finished watches stay visible this long, then they leave the file. */
const KEEP_ENDED_MS = 30 * 86_400_000
export const ORB_ID = 'straze'

export const STATUSES = ['active', 'paused', 'done', 'expired']
export const NOTIFY = ['voice', 'call', 'quiet']

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

// ── storage ───────────────────────────────────────────────────────────────

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** A lock between the processes that write the file (the tick, the CLI from a voice tool). */
function withLock(fn) {
  mkdirSync(DATA_DIR, { recursive: true })
  const t0 = Date.now()
  for (;;) {
    try {
      mkdirSync(LOCK_DIR)
      break
    } catch {
      try {
        if (Date.now() - statSync(LOCK_DIR).mtimeMs > 15_000) rmSync(LOCK_DIR, { recursive: true, force: true })
      } catch {
        // the lock disappeared meanwhile
      }
      if (Date.now() - t0 > 5000) throw fail('Stráže sa práve zapisujú, skús to o chvíľu.', 503)
      sleepSync(40)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true })
  }
}

export function readStore() {
  try {
    const raw = JSON.parse(readFileSync(STORE_FILE, 'utf8'))
    const watches = (Array.isArray(raw?.watches) ? raw.watches : []).filter((w) => w && typeof w.id === 'string' && typeof w.what === 'string')
    return { seq: Number.isFinite(raw?.seq) ? raw.seq : 0, watches }
  } catch {
    return { seq: 0, watches: [] }
  }
}

function writeStore(store) {
  mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(store, null, 1)}\n`, { mode: 0o600 })
  renameSync(tmp, STORE_FILE)
}

/** Read, change and write the store in one locked step. `fn(store)` returns what the caller gets back. */
export function mutate(fn) {
  return withLock(() => {
    const store = readStore()
    const out = fn(store)
    writeStore(store)
    return out
  })
}

export const listWatches = () => readStore().watches

export function findWatch(store, id) {
  const key = String(id ?? '').trim().toLowerCase()
  const w = store.watches.find((x) => x.id === key)
  if (!w) throw fail(`Stráž ${key || '(bez id)'} neexistuje. Zoznam ukáže: node scripts/watch.mjs list`, 404)
  return w
}

// ── reading the user's sentence ───────────────────────────────────────────

/** A sensible interval by the nature of the thing (minutes). The brain usually names it itself. */
export function guessEvery(sentence) {
  const s = String(sentence ?? '').toLowerCase()
  if (/odp[ií][sš]|nap[ií][sš]e|ozve|odpove|príde mail|pride mail|nov[ýy] mail|správ[aui]|sprav[aui]|zavol[aá]/.test(s)) return 15
  if (/bitcoin|btc|ethereum|\beth\b|kryptom|akci[ea]|akcií|kurz|burz/.test(s)) return 30
  if (/bal[ií]k|z[aá]sielk|doru[cč]|kuri[eé]r|packeta|z[aá]sielkovň/.test(s)) return 120
  if (/str[aá]nk|zmen[ií] sa|zmeni sa|zmena na/.test(s)) return 180
  return 60
}

/** One hit and done („keď zlacnie"), or every new match („vždy keď pribudne"). */
export function guessOnce(sentence) {
  return !/v[žz]dy,? ke[dď]|zaka[žz]d[ýy]m|ka[žz]d[ýy] (nov|raz)|ka[žz]d[éu] nov|priebe[žz]ne|v[žz]dy ked|zakaždým/i.test(String(sentence ?? ''))
}

/** Worth checking even at night: the user said so, or the sentence starts with „!" like an urgent reminder. */
export function guessUrgent(sentence) {
  return /^\s*!|aj v noci|aj ke[dď] sp[ií]m|okam[žz]ite|s[uú]rne|urgent/i.test(String(sentence ?? ''))
}

/**
 * When a watch ends: an ISO time, a day (end of that day), „YYYY-MM-DD HH:MM", or a span from
 * now („+7d", „+12h", „+30m"). Returns an ISO string, null for nothing, throws on nonsense.
 */
export function parseUntil(value, now = new Date()) {
  const v = String(value ?? '').trim()
  if (!v || /^(nie|none|null|nikdy|-)$/i.test(v)) return null
  const rel = /^\+?(\d{1,4})\s*(m|min|h|d|t|w)$/i.exec(v)
  if (rel) {
    const n = Number(rel[1])
    const unit = { m: 60_000, min: 60_000, h: 3600_000, d: 86_400_000, t: 7 * 86_400_000, w: 7 * 86_400_000 }[rel[2].toLowerCase()]
    return new Date(now.getTime() + n * unit).toISOString()
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 23, 59, 0).toISOString()
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(v)
  if (local) return new Date(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]), Number(local[5])).toISOString()
  const t = Date.parse(v)
  if (Number.isFinite(t)) return new Date(t).toISOString()
  throw fail(`Neviem, kedy má stráž skončiť: „${v}". Použi dátum 2026-12-31, „2026-12-31 18:00" alebo +7d, +12h.`)
}

const BETWEEN = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/
function parseBetween(value) {
  const v = String(value ?? '').trim()
  if (!v || /^(nie|none|null|-)$/i.test(v)) return null
  const m = BETWEEN.exec(v)
  if (!m || Number(m[1]) > 23 || Number(m[3]) > 24 || Number(m[2]) > 59 || Number(m[4]) > 59) throw fail(`Okno kontrol má tvar 08:00-22:00, dostal som „${v}".`)
  const p = (h, mm) => `${String(Number(h)).padStart(2, '0')}:${mm}`
  return `${p(m[1], m[2])}-${p(m[3], m[4])}`
}

function parseEvery(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n <= 0) throw fail('Ako často kontrolovať: počet minút, napríklad 60.')
  return Math.min(MAX_EVERY, Math.max(MIN_EVERY, n))
}

// ── create and change ─────────────────────────────────────────────────────

/** A new watch from the user's sentence and the brain's check plan. Returns the stored watch. */
export function addWatch(input = {}, now = new Date()) {
  const what = clean(input.what, 300)
  const check = String(input.check ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 2000)
  if (!what) throw fail('Chýba, čo mám strážiť (veta používateľa).')
  if (!check) throw fail('Chýba plán kontroly (--check): kde a ako to overiť a kedy je podmienka splnená.')
  const until = parseUntil(input.until, now)
  if (until && Date.parse(until) <= now.getTime()) throw fail('Koniec stráže je už v minulosti.')
  const notify = NOTIFY.includes(input.notify) ? input.notify : input.call === true ? 'call' : input.quiet === true ? 'quiet' : 'voice'
  return mutate((store) => {
    const w = {
      id: `s${++store.seq}`,
      what,
      check,
      every: input.every === undefined || input.every === null || input.every === '' ? guessEvery(what) : parseEvery(input.every),
      between: parseBetween(input.between),
      until,
      once: typeof input.once === 'boolean' ? input.once : guessOnce(what),
      notify,
      urgent: typeof input.urgent === 'boolean' ? input.urgent : guessUrgent(what),
      model: clean(input.model, 40) || null,
      status: 'active',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      endedAt: null,
      endReason: null,
      state: { observation: null, lastCheckAt: null, lastResult: null, lastHit: null, lastHitAt: null, link: null, errors: 0, lastError: null, checks: 0, hits: 0, runningSince: null, runningPid: null },
    }
    store.watches.push(w)
    return w
  })
}

/** Changes what the user asked to change. Returns the stored watch. */
export function editWatch(id, patch = {}, now = new Date()) {
  return mutate((store) => {
    const w = findWatch(store, id)
    if (patch.what !== undefined) {
      const what = clean(patch.what, 300)
      if (!what) throw fail('Veta stráže nesmie byť prázdna.')
      w.what = what
    }
    if (patch.check !== undefined) {
      const check = String(patch.check ?? '').trim().slice(0, 2000)
      if (!check) throw fail('Plán kontroly nesmie byť prázdny.')
      // A new plan means a new baseline: the old observation belongs to the old way of checking.
      if (check !== w.check) w.state.observation = null
      w.check = check
    }
    if (patch.every !== undefined) w.every = parseEvery(patch.every)
    if (patch.between !== undefined) w.between = parseBetween(patch.between)
    if (patch.until !== undefined) {
      w.until = parseUntil(patch.until, now)
      if (w.until && Date.parse(w.until) <= now.getTime()) throw fail('Koniec stráže je už v minulosti.')
      if (w.status === 'expired' && (!w.until || Date.parse(w.until) > now.getTime())) reopen(w)
    }
    if (typeof patch.once === 'boolean') w.once = patch.once
    if (NOTIFY.includes(patch.notify)) w.notify = patch.notify
    if (typeof patch.urgent === 'boolean') w.urgent = patch.urgent
    if (patch.model !== undefined) w.model = clean(patch.model, 40) || null
    w.updatedAt = now.toISOString()
    return w
  })
}

function reopen(w) {
  w.status = 'active'
  w.endedAt = null
  w.endReason = null
  w.state.errors = 0
  w.state.lastError = null
}

export function setStatus(id, action, now = new Date()) {
  return mutate((store) => {
    const w = findWatch(store, id)
    if (action === 'pause') {
      if (w.status === 'active') {
        w.status = 'paused'
        w.endReason = 'user'
      }
    } else if (action === 'resume') {
      if (w.status === 'expired' && w.until && Date.parse(w.until) <= now.getTime()) w.until = null
      reopen(w)
    } else throw fail(`Neznáma akcia ${action}.`)
    w.updatedAt = now.toISOString()
    return w
  })
}

export function removeWatch(id) {
  return mutate((store) => {
    const w = findWatch(store, id)
    store.watches = store.watches.filter((x) => x.id !== w.id)
    return w
  })
}

// ── when to check ─────────────────────────────────────────────────────────

/** Failed checks slow a watch down: twice, four times, at most eight times its interval. */
export const backoff = (errors) => (errors > 0 ? Math.min(2 ** errors, 8) : 1)

/** When the next check is due. A watch that was never checked is due at once. */
export function nextCheckAt(w) {
  const last = Date.parse(w.state?.lastCheckAt ?? '')
  if (!Number.isFinite(last)) return new Date(Date.parse(w.createdAt) || 0)
  return new Date(last + w.every * 60_000 * backoff(w.state?.errors ?? 0))
}

export function isRunning(w, now = new Date()) {
  const since = Date.parse(w.state?.runningSince ?? '')
  return Number.isFinite(since) && now.getTime() - since < RUN_STALE_MS
}

/**
 * Whether one watch should be checked now. { due, why, expire?, at?, overdue? }
 * why: status, until, running, between, quiet, wait. Quiet hours hold every watch except an urgent one.
 */
export function checkDecision(w, now = new Date(), cfg = getConfig()) {
  if (w.status !== 'active') return { due: false, why: 'status' }
  if (w.until && now.getTime() >= Date.parse(w.until)) return { due: false, why: 'until', expire: true }
  if (isRunning(w, now)) return { due: false, why: 'running' }
  if (w.between && !inWindow(w.between, now)) return { due: false, why: 'between' }
  if (!w.urgent && quietNow(cfg, now)) return { due: false, why: 'quiet' }
  const at = nextCheckAt(w)
  if (now.getTime() < at.getTime()) return { due: false, why: 'wait', at }
  return { due: true, why: 'due', overdue: now.getTime() - at.getTime() }
}

/**
 * What a tick should do now: the watches to check (most overdue first, at most `limit`) and the
 * ones whose time ran out. However long the computer slept, each watch is checked once.
 */
export function planTick(watches, now = new Date(), cfg = getConfig(), limit = MAX_PER_TICK) {
  const due = []
  const expire = []
  for (const w of watches) {
    const d = checkDecision(w, now, cfg)
    if (d.expire) expire.push(w)
    else if (d.due) due.push({ w, overdue: d.overdue })
  }
  due.sort((a, b) => b.overdue - a.overdue)
  return { check: due.slice(0, limit).map((x) => x.w), expire }
}

// ── the check's answer ────────────────────────────────────────────────────

const RESULT_LINE = /^(HIT|NO|NIE|ERROR|CHYBA):\s*(.*)$/i

/**
 * The verdict of one check from the last line of its answer: { kind: hit | no | error, text, link }.
 * Only the very last line counts, so a „HIT" mentioned along the way is never taken for a hit.
 */
export function parseResult(raw) {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[*_`>\s]+|[*_`\s]+$/g, ''))
    .filter(Boolean)
  const link = lines.map((l) => /^(?:ODKAZ|LINK):\s*(https?:\/\/\S+)/i.exec(l)?.[1]).filter(Boolean).pop() ?? null
  const m = RESULT_LINE.exec(lines.at(-1) ?? '')
  if (!m) return { kind: 'error', text: 'Odpoveď kontroly nekončila riadkom HIT ani NO.', link: null }
  const kind = { hit: 'hit', no: 'no', nie: 'no', error: 'error', chyba: 'error' }[m[1].toLowerCase()]
  const text = clean(m[2], 400)
  if (kind === 'hit' && !text) return { kind: 'error', text: 'Zhoda bez vety pre používateľa.', link: null }
  return { kind, text: text || (kind === 'no' ? 'bez zmeny' : 'neznámy dôvod'), link: kind === 'hit' ? link : null }
}

const same = (a, b) => clean(a, 400).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === clean(b, 400).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * Applies the verdict of one check to the watch (in place). Returns the event to announce:
 * hit (say it), paused (failed too often, say it once), or null (nothing to say).
 * A repeating watch that reports the very same hit again stays quiet.
 */
export function applyResult(w, result, now = new Date()) {
  const st = w.state
  st.lastCheckAt = now.toISOString()
  st.checks = (st.checks ?? 0) + 1
  st.runningSince = null
  st.runningPid = null
  w.updatedAt = now.toISOString()
  if (result.kind === 'error') {
    st.errors = (st.errors ?? 0) + 1
    st.lastError = clean(result.text, 300)
    st.lastResult = 'error'
    if (st.errors >= MAX_ERRORS && w.status === 'active') {
      w.status = 'paused'
      w.endReason = 'errors'
      return 'paused'
    }
    return null
  }
  st.errors = 0
  st.lastError = null
  if (result.kind === 'hit' && !(w.once === false && st.lastHit && same(st.lastHit, result.text))) {
    st.lastResult = 'hit'
    st.lastHit = result.text
    st.lastHitAt = now.toISOString()
    st.observation = result.text
    st.link = result.link ?? null
    st.hits = (st.hits ?? 0) + 1
    if (w.once !== false) {
      w.status = 'done'
      w.endedAt = now.toISOString()
      w.endReason = 'hit'
    }
    return 'hit'
  }
  st.lastResult = 'no'
  st.observation = result.text
  return null
}

/** Drops watches that ended more than a month ago. Returns how many went. */
export function pruneEnded(store, now = new Date()) {
  const before = store.watches.length
  store.watches = store.watches.filter((w) => w.status === 'active' || w.status === 'paused' || !w.endedAt || now.getTime() - Date.parse(w.endedAt) < KEEP_ENDED_MS)
  return before - store.watches.length
}

// ── the check run ─────────────────────────────────────────────────────────

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const stamp = (iso) => {
  const d = new Date(iso)
  return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()} ${hhmm(d)}`
}

/** The standing instructions of a check run (the appended system prompt). */
export function checkContext({ now = new Date(), cfg = getConfig(), addressRule = '', strangers = '', memoryNote = '' } = {}) {
  return [
    `Dnes je ${DOW_LONG[now.getDay()]} ${now.getDate()}. ${now.getMonth() + 1}. ${now.getFullYear()}, ${hhmm(now)}.`,
    'Bežíš ako Jarvisova stráž na pozadí, bez používateľa pri počítači. Nepýtaj sa, rozhoduj sám. Sprav len to, čo treba na jedno overenie, rýchlo a bez odbočiek.',
    cfg.name ? `Používateľ sa volá ${cfg.name}${cfg.city ? `, býva v meste ${cfg.city}` : ''}.` : '',
    addressRule,
    memoryNote,
    'Len čítaš a overuješ. Nič neposielaj, neodpisuj, nekupuj, neprihlasuj sa nikam nový, nemeň súbory, pamäť ani nastavenia.',
    strangers,
    'Tvoja posledná správa končí presne jedným riadkom HIT:, NO: alebo ERROR: podľa zadania. Nad ním smú byť najviac tri krátke riadky poznámok, žiadny markdown.',
  ]
    .filter(Boolean)
    .join('\n')
}

/** The task of one check run: the user's sentence, the plan and what the last check saw. */
export function checkPrompt(w, now = new Date()) {
  const st = w.state ?? {}
  const first = !st.lastCheckAt
  return [
    `Používateľ ti povedal: „${w.what}"`,
    `Ako to overiť: ${w.check}`,
    `Stráž beží od ${stamp(w.createdAt)}.`,
    first ? 'Toto je prvá kontrola, predchádzajúci stav nepoznáš.' : `Minulá kontrola (${stamp(st.lastCheckAt)}) videla: ${st.observation ?? 'nič zapísané'}`,
    st.lastHit ? `Posledná ohlásená zhoda (${stamp(st.lastHitAt)}): ${st.lastHit}` : '',
    w.once === false ? 'Stráž sa opakuje: ozvi sa pri každej novej zhode, nie pri tej istej ako minule.' : 'Stráž sa ozve raz, keď podmienka platí, a potom skončí.',
    '',
    'Pravidlá:',
    '1. Over to teraz zo skutočného zdroja (stránka, konektor, prehliadač, vyhľadávanie). Nič neodhaduj ani nevymýšľaj.',
    '2. HIT len vtedy, keď je podmienka naozaj a preukázateľne splnená práve teraz: konkrétne číslo, dátum, odosielateľ alebo text, ktorý si videl. Pri pochybnosti, neúplných dátach alebo keď sa zdroj nenačítal to nie je HIT.',
    '3. Pri strážach typu „keď sa zmení", „keď príde", „keď odpíše", „keď pribudne" počítaj len to, čo je nové od začiatku stráže a od minulej kontroly. Na prvej kontrole takej stráže len zapíš východiskový stav (NO), pokiaľ to nové nie je zjavne až po začiatku stráže.',
    '4. Keď zdroj nejde (chyba stránky, chýba prihlásenie, konektor nie je pripojený), odpovedz ERROR s dôvodom. Neskúšaj donekonečna.',
    '',
    'Keď máš odkaz na zdroj zhody, daj ho na samostatný riadok pred posledný: `ODKAZ: https://…`',
    'Posledný riadok je presne jeden z týchto:',
    'HIT: <jedna až dve vety, ktoré Jarvis povie používateľovi: čo sa stalo, s konkrétnym číslom alebo menom a kde, prirodzene ako komorník>',
    'NO: <čo si teraz videl, stručne a s číslami (cena, posledná správa a jej čas, počet inzerátov, stav zásielky), aby sa to nabudúce dalo porovnať; do 300 znakov>',
    'ERROR: <prečo sa to nedalo overiť>',
  ]
    .filter((l) => l !== null && l !== undefined && l !== false)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

/** The model of a check: the watch's own, JARVIS_JOB_MODEL, else the provider's light tier. Codex gets the low effort. */
export function checkModel(w, provider) {
  return {
    model: w.model || process.env.JARVIS_JOB_MODEL || provider?.tiers?.light || null,
    effort: provider?.efforts?.light ?? null,
  }
}

/** A deterministic check without any AI (tests, JARVIS_MOCK=1): the plan says `mock:hit`, `mock:error` or nothing (no). */
export function mockAnswer(w) {
  if (/mock:hit/i.test(w.check)) return `Skúšobná kontrola.\nODKAZ: https://example.com/\nHIT: Skúšobná stráž ${w.id} je splnená, všetko funguje.`
  if (/mock:error/i.test(w.check)) return 'ERROR: skúšobná chyba'
  return 'NO: skúšobná kontrola, nič nové'
}

/**
 * Runs one check of a watch with the agent Jarvis is set up with and returns the parsed verdict.
 * Marks the watch as running first, so a second tick or a manual run does not start it twice.
 */
export async function runCheck(id, { mock = false, now = () => new Date() } = {}) {
  const w = mutate((store) => {
    const x = findWatch(store, id)
    if (isRunning(x, now())) throw fail(`Stráž ${x.id} sa práve kontroluje.`, 409)
    x.state.runningSince = now().toISOString()
    x.state.runningPid = process.pid
    return structuredClone(x)
  })
  let result
  const t0 = Date.now()
  try {
    if (mock || process.env.JARVIS_MOCK === '1') result = parseResult(mockAnswer(w))
    else {
      const [{ aiProvider, runAgent, STRANGERS_NOTE }, { addressRule }, { MEMORY_DIR }, { MEMORY_EXTERNAL }] = await Promise.all([import('./provider.mjs'), import('./persona.mjs'), import('./memory/index.mjs'), import('./agent.mjs')])
      const provider = aiProvider()
      const { model, effort } = checkModel(w, provider)
      mkdirSync(WATCH_DIR, { recursive: true, mode: 0o700 })
      const contextFile = join(WATCH_DIR, `${w.id}.context.md`)
      const cfg = getConfig()
      writeFileSync(
        contextFile,
        checkContext({ now: now(), cfg, addressRule: addressRule(cfg), strangers: STRANGERS_NOTE, memoryNote: MEMORY_EXTERNAL ? `Pamäť používateľa je v priečinku ${MEMORY_DIR}.` : 'Pamäť používateľa je v priečinku memory/.' }),
        { mode: 0o600 },
      )
      const answer = await runAgent({ prompt: checkPrompt(w, now()), contextFile, model, effort, cwd: REPO, timeoutMs: CHECK_TIMEOUT_MS })
      result = parseResult(answer)
    }
  } catch (err) {
    result = { kind: 'error', text: clean(err instanceof Error ? err.message : String(err), 300) || 'beh zlyhal', link: null }
  }
  const ms = Date.now() - t0
  const out = mutate((store) => {
    const x = store.watches.find((y) => y.id === w.id)
    // Removed while it was being checked: nothing to store, nothing to say.
    if (!x) return { watch: null, event: null }
    const event = applyResult(x, result, now())
    return { watch: structuredClone(x), event }
  })
  return { ...out, result, ms }
}

/** Marks the watches whose time ran out. Returns them (for one quiet line to the user). */
export function expireWatches(ids, now = new Date()) {
  if (!ids.length) return []
  return mutate((store) => {
    const out = []
    for (const w of store.watches) {
      if (!ids.includes(w.id) || w.status !== 'active') continue
      w.status = 'expired'
      w.endedAt = now.toISOString()
      w.endReason = 'until'
      w.updatedAt = now.toISOString()
      out.push(structuredClone(w))
    }
    pruneEnded(store, now)
    return out
  })
}

// ── the background driver ─────────────────────────────────────────────────

function tickAlive() {
  try {
    const { pid, at } = JSON.parse(readFileSync(TICK_LOCK, 'utf8'))
    if (Date.now() - Date.parse(at) > 30 * 60_000) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Takes the tick lock. false when another tick is already running. */
export function takeTickLock() {
  if (tickAlive()) return false
  mkdirSync(WATCH_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(TICK_LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  return true
}

export function releaseTickLock() {
  try {
    if (JSON.parse(readFileSync(TICK_LOCK, 'utf8')).pid === process.pid) rmSync(TICK_LOCK, { force: true })
  } catch {
    // no lock
  }
}

/**
 * Starts `scripts/watch.mjs tick` in the background when a watch is due or ran out of time.
 * Reads one small file, never calls the AI itself, returns at once and never throws.
 * Called by the pulse and, while the HUD runs, by the server every minute.
 */
export function kickWatches({ now = new Date(), force = false } = {}) {
  try {
    const { watches } = readStore()
    if (!watches.length || tickAlive()) return false
    const plan = planTick(watches, now)
    if (!force && !plan.check.length && !plan.expire.length) return false
    spawn(process.execPath, [join(REPO, 'scripts', 'watch.mjs'), 'tick'], { cwd: REPO, detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return true
  } catch {
    return false
  }
}

// ── words and the orb ─────────────────────────────────────────────────────

/** „každú hodinu", „každých 15 minút", „raz denne". */
export function everyText(min) {
  const n = Number(min)
  const few = (k) => k >= 2 && k <= 4
  if (n % 1440 === 0) {
    const d = n / 1440
    return d === 1 ? 'raz denne' : few(d) ? `každé ${d} dni` : `každých ${d} dní`
  }
  if (n % 60 === 0) {
    const h = n / 60
    return h === 1 ? 'každú hodinu' : few(h) ? `každé ${h} hodiny` : `každých ${h} hodín`
  }
  return n === 1 ? 'každú minútu' : few(n) ? `každé ${n} minúty` : `každých ${n} minút`
}

/** „dnes 14:05", „včera 9:10", „24. 11. 14:05". */
export function whenText(iso, now = new Date()) {
  if (!iso) return 'ešte nie'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'ešte nie'
  const t = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (isoDay(d) === isoDay(now)) return `dnes ${t}`
  if (isoDay(d) === isoDay(yesterday)) return `včera ${t}`
  return `${d.getDate()}. ${d.getMonth() + 1}. ${t}`
}

/** The sentence without its lead-in: „daj mi vedieť, keď zlacnie let…" → „Keď zlacnie let…". */
export function topic(what) {
  const t = clean(what, 300)
    .replace(/^(pros[ií]m,?\s*)?(daj mi vedie[tť]|upozorni ma|sleduj( mi)?|povedz mi|ozvi sa|str[aá][zž] mi),?\s*/i, '')
  return t ? t[0].toUpperCase() + t.slice(1) : clean(what, 300)
}

export function statusText(w) {
  if (w.status === 'active') return 'stráži'
  if (w.status === 'paused') return w.endReason === 'errors' ? 'nejde overiť' : 'pozastavená'
  if (w.status === 'done') return 'splnená'
  return 'vypršala'
}

/** One line about a watch for people (the CLI, the voice tool). */
export function describe(w, now = new Date()) {
  const st = w.state ?? {}
  const parts = [`${w.id} „${w.what}"`, statusText(w), everyText(w.every)]
  if (w.between) parts.push(`len ${w.between}`)
  if (w.until) parts.push(`do ${whenText(w.until, now)}`)
  parts.push(`naposledy ${whenText(st.lastCheckAt, now)}`)
  if (st.lastHit) parts.push(`zhoda ${whenText(st.lastHitAt, now)}: ${st.lastHit}`)
  else if (st.observation) parts.push(`videl: ${clean(st.observation, 160)}`)
  if (st.lastError) parts.push(`chyba: ${clean(st.lastError, 120)}`)
  return parts.join(' · ')
}

const ACCENT = { active: 'ice', paused: 'amber', done: 'green', expired: undefined }
const short = (s, n) => {
  const t = clean(s, 400)
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** What the orb Stráže shows: the number of active watches, a list with a button per row and a point per watch. */
export function watchesOrb(watches, now = new Date()) {
  const order = { active: 0, paused: 1, done: 2, expired: 3 }
  const recent = watches.filter((w) => w.status === 'active' || w.status === 'paused' || now.getTime() - Date.parse(w.endedAt ?? w.updatedAt) < 7 * 86_400_000)
  const shown = [...recent].sort((a, b) => order[a.status] - order[b.status] || String(b.updatedAt).localeCompare(String(a.updatedAt)))
  const active = watches.filter((w) => w.status === 'active').length
  const broken = watches.filter((w) => w.status === 'paused' && w.endReason === 'errors').length
  const hitsToday = watches.filter((w) => w.state?.lastHitAt && isoDay(new Date(w.state.lastHitAt)) === isoDay(now)).length
  const action = (w) => (w.status === 'active' ? `Pozastav stráž ${w.id}.` : w.status === 'paused' ? `Obnov stráž ${w.id}.` : `Zruš stráž ${w.id}.`)
  const sub = (w) => {
    const st = w.state ?? {}
    const seen = st.lastHit && w.status === 'done' ? st.lastHit : st.lastError && w.status === 'paused' ? st.lastError : st.observation
    return [everyText(w.every), `naposledy ${whenText(st.lastCheckAt, now)}`, seen ? short(seen, 60) : null].filter(Boolean).join(' · ')
  }
  return {
    value: String(active),
    sub: active === 1 ? 'stráž beží' : active >= 2 && active <= 4 ? 'stráže bežia' : 'stráží beží',
    ...(broken ? { alert: true } : {}),
    panel: [
      { type: 'stat', label: 'Strážim', value: String(active), unit: active === 1 ? 'vec' : active >= 2 && active <= 4 ? 'veci' : 'vecí', caption: hitsToday ? `dnes splnené: ${hitsToday}` : 'ozvem sa, len keď to nastane', accent: broken ? 'amber' : 'ice' },
      ...(shown.length
        ? [{ type: 'list', title: 'Stráže', items: shown.slice(0, 12).map((w) => ({ label: short(topic(w.what), 80), sub: short(sub(w), 100), value: statusText(w), accent: ACCENT[w.status], say: action(w) })) }]
        : [{ type: 'text', text: 'Žiadna stráž. Povedzte napríklad: daj mi vedieť, keď zlacnie let do Londýna pod 80 eur.' }]),
      { type: 'actions', items: [{ label: 'Nová stráž', say: 'Chcem novú stráž.' }, { label: 'Ako sú na tom', say: 'Aké stráže mám a ako sú na tom?' }] },
    ],
    groups: [
      { key: 'stráži', label: 'Stráži' },
      { key: 'pozastavená', label: 'Pozastavené' },
      { key: 'skončená', label: 'Skončené' },
    ],
    items: shown.map((w) => {
      const st = w.state ?? {}
      return {
        id: w.id,
        t: short(topic(w.what), 80),
        s: `${statusText(w)} · ${everyText(w.every)}`,
        g: w.status === 'active' ? 'stráži' : w.status === 'paused' ? 'pozastavená' : 'skončená',
        imp: w.status === 'active' ? 0.8 : w.status === 'paused' ? 0.5 : 0.2,
        at: whenText(st.lastCheckAt, now),
        text: [
          `Ako overujem: ${w.check}`,
          `Ako často: ${everyText(w.every)}${w.between ? `, len ${w.between}` : ''}${w.until ? `, do ${whenText(w.until, now)}` : ''}. ${w.once === false ? 'Ozvem sa pri každej novej zhode.' : 'Ozvem sa raz a skončím.'}`,
          st.lastHit ? `Posledná zhoda (${whenText(st.lastHitAt, now)}): ${st.lastHit}${st.link ? ` ${st.link}` : ''}` : '',
          st.observation && st.observation !== st.lastHit ? `Naposledy som videl: ${st.observation}` : '',
          st.lastError ? `Chyba: ${st.lastError}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        say: w.status === 'paused' ? `Obnov stráž ${w.id}.` : `Zruš stráž ${w.id}.`,
        act: w.status === 'paused' ? 'Obnoviť stráž' : 'Zrušiť stráž',
      }
    }),
  }
}

/**
 * Writes the orb Stráže from the current watches. `create` adds the orb when it is missing (a new
 * watch); otherwise an orb the user removed stays removed. Never throws.
 */
export function syncOrb({ create = false, now = new Date() } = {}) {
  try {
    const watches = listWatches()
    if (!customOrb(ORB_ID)) {
      if (!create || !watches.length) return false
      changeOrbs({ action: 'add', id: ORB_ID, label: 'Stráže', icon: 'eye', color: '#ffd27f', shape: 'orb' })
    }
    changeOrbs({ action: 'content', id: ORB_ID, content: watchesOrb(watches, now) })
    return true
  } catch {
    return false
  }
}
