/**
 * Background jobs: a full Claude Code run (files, web, the user's connectors, skills) started by
 * Jarvis. The fast voice brain stays lean and only hands work over through the tools
 * agent_task / agent_reply / agent_stop.
 *
 *   claude -p --output-format stream-json --verbose <permission args> --append-system-prompt-file …
 *   cwd = the Jarvis folder (its AGENTS.md and memory), the task goes in over stdin.
 *
 * At most 3 at once, the rest wait. State in data/brain/jobs.json, a raw log per job in
 * data/jobs/<id>.jsonl and a readable feed in data/jobs/<id>.feed.jsonl (both 0600). The feed
 * is what the HUD shows when the user opens a job: the assignment, every step with its time,
 * what the agent said along the way and how it ended. Anything that would go out to other
 * people ends with a `NEEDS_OK: …` line and waits for the user's approval; a job that needs a piece
 * of information ends with `OTÁZKA: …`. Either way Jarvis himself asks the user (server.mjs).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { CLAUDE_BIN as CLAUDE, MEMORY_EXTERNAL } from './agent.mjs'
import { STRANGERS_NOTE, aiProvider, spawnAgent } from './provider.mjs'
import { MEMORY_DIR } from './memory/index.mjs'
import { BRAIN_DIR, clean, DATA_DIR, errMsg, log, REPO, spawnBin, winSys, writeFileAtomic } from './util.mjs'
import { speakable } from './tts.mjs'
import { addressRule } from './persona.mjs'
import { routeJob } from './routing.mjs'
import { MEDIA_KINDS, MEDIA_MAX, findMediaPaths, stripMediaPaths, trimText } from './shown-media.mjs'

const CWD = process.env.JARVIS_JOB_CWD || REPO
const MAX_PARALLEL = 3
const STATE_FILE = join(BRAIN_DIR, 'jobs.json')
const LOG_DIR = join(DATA_DIR, 'jobs')
const CONTEXT_FILE = join(BRAIN_DIR, 'job-context.md')
const FEED_MAX = 400
/** Pace of a mock job's steps (UI tests slow it down to have time to look inside and stop it). */
const MOCK_STEP_MS = Number(process.env.JARVIS_MOCK_STEP_MS || 900)
const feedFile = (id) => join(LOG_DIR, `${id}.feed.jsonl`)

const contextPrompt = (film) =>
  [
    'Túto úlohu ti zadal používateľ cez Jarvis HUD (hlasom alebo textom; pri hlase môže mať prepis chyby, domysli rozumný význam).',
    'Pracuješ samostatne až do konca, používateľ pri tom nesedí. Nepýtaj sa na veci, ktoré vieš zistiť alebo rozhodnúť sám.',
    STRANGERS_NOTE,
    `Si Jarvis: pamäť používateľa je v priečinku ${MEMORY_EXTERNAL ? MEMORY_DIR : 'memory/'} (pozri AGENTS.md). Čo sa o ňom dozvieš nové a trvalé, zapíš tam.`,
    'Keď treba niečo poslať alebo zverejniť za používateľa (mail, správa, príspevok, objednávka), priprav presné znenie, napíš komu a kam, a odpoveď ukonči samostatným riadkom `NEEDS_OK: <čo a komu, jednou vetou>`. Odošli až po schválení.',
    'Keď bez používateľa nevieš pokračovať (chýba informácia, ktorú nezistíš sám), ukonči samostatným riadkom `OTÁZKA: <jedna krátka otázka, ideálne s tvojím najlepším tipom>`. Jarvis sa ho na ňu spýta sám a jeho odpoveď ti pošle.',
    `Si Jarvisove ruky: všetko, čo sa používateľovi povie (riadok HLAS, otázka, súhlas), hovorí Jarvis v prvej osobe („nenašiel som", „mám pripravené"), nikdy „úloha" ani „agent". ${addressRule()}`,
    'Tvoja úplne posledná správa má presne tento tvar. Najprv výsledok: najviac päť krátkych riadkov obyčajného textu, čo je hotové a kde. Žiadny markdown: žiadne hviezdičky, mriežky, tabuľky, odrážky, kód ani emoji. Dlhý výstup (rešerš, zoznam, návrh textu) ulož do súboru a napíš len, kde je. Potom samostatný posledný riadok `HLAS: …` s jednou až dvoma krátkymi vetami, ktoré Jarvis povie nahlas (zdvorilo, vecne, pokojne so suchým humorom).',
    'Keď je výsledkom web (nasadený alebo bežiaci lokálne), fotka, video alebo zvuk, napíš do výsledku jeho celú adresu (https://… alebo http://localhost:…) alebo plnú cestu k súboru. Jarvis ho po dokončení ukáže na ploche, takže cestu nevysvetľuj.',
    film ? 'Režim natáčania: v poslednej správe ani v riadkoch NEEDS_OK a OTÁZKA nespomínaj mená ľudí ani firiem.' : '',
  ]
    .filter(Boolean)
    .join('\n')

let opts = { send: () => {}, sendHud: () => {}, announce: () => {}, isFilm: () => false }
const jobs = new Map()
let seq = 0
let saveTimer = null

export function initJobs(o) {
  opts = { ...opts, ...o }
}

const pub = (j) => ({
  id: j.id,
  title: j.title,
  status: j.status,
  step: j.step,
  steps: j.steps.slice(-6),
  startedAt: j.startedAt,
  endedAt: j.endedAt,
  summary: j.summary,
  say: j.say ?? null,
  needsOk: j.needsOk,
  wait: j.status === 'needs_ok' ? (j.wait ?? 'approval') : null,
  cost: j.cost,
  // How hard the job is and what it runs on („ľahká úloha · Haiku"), see routing.mjs.
  weight: j.weight ?? null,
  route: j.route ?? null,
  mock: j.mock || undefined,
  artifacts: j.artifacts?.length ? j.artifacts.map(({ kind, url, name }, i) => ({ kind, name, url: MEDIA_KINDS.has(kind) ? `/api/jobs/${j.id}/file/${i}` : url })) : undefined,
})

/**
 * Web addresses and local media (photos, videos, audio) a finished job names in its result. The
 * desktop shows a web as a glass card and every photo or video as its own floating card; the chat
 * card shows thumbnails. Only files that exist are kept, and only these exact files can be fetched
 * back (GET /api/jobs/<id>/file/<n>).
 */
export function findArtifacts(text) {
  const out = []
  const seen = new Set()
  for (const m of String(text ?? '').matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, '')
    if (seen.has(url) || out.length >= 4) continue
    seen.add(url)
    out.push({ kind: 'web', url, name: url.replace(/^https?:\/\//, '').replace(/\/$/, '') })
  }
  for (const f of findMediaPaths(text, { base: REPO, max: MEDIA_MAX })) out.push({ kind: f.kind, file: f.file, name: f.name, raw: f.raw })
  return out
}

/** Absolute path of a job's photo, video or audio for GET /api/jobs/<id>/file/<n>, or null. */
export function jobFile(id, index) {
  const a = jobs.get(id)?.artifacts?.[Number(index)]
  return a && MEDIA_KINDS.has(a.kind) && a.file && existsSync(a.file) ? a.file : null
}

/** The media of a job as the page gets them (no paths): [{ kind, name, url }]. */
export const jobMedia = (job) => (job?.artifacts ?? []).filter((a) => MEDIA_KINDS.has(a.kind))

export const listJobs = () => [...jobs.values()].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).slice(0, 30).map(pub)
export const runningCount = () => [...jobs.values()].filter((j) => j.status === 'running').length

function emit(j) {
  opts.send('job', pub(j))
  scheduleSave()
}

function scheduleSave() {
  if (opts.persist === false) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const all = [...jobs.values()].slice(-60).map(({ proc, timer, feed, ...rest }) => rest)
    writeFileAtomic(STATE_FILE, JSON.stringify({ seq, jobs: all }, null, 1), 0o600).catch((err) => log('jobs', errMsg(err)))
  }, 300)
}

export async function loadJobs() {
  try {
    const data = JSON.parse(await readFile(STATE_FILE, 'utf8'))
    seq = data.seq ?? 0
    for (const j of data.jobs ?? []) {
      // Proces po reštarte servera nežije: úloha sa dá dokončiť cez agent_reply (resume session).
      if (j.status === 'running' || j.status === 'queued') {
        j.status = 'stopped'
        j.step = 'Prerušené reštartom HUD'
        j.endedAt = j.endedAt ?? new Date().toISOString()
      }
      // Jobs saved before questions and approvals were told apart.
      if (j.status === 'needs_ok' && !j.wait) j.wait = waitOf(`NEEDS_OK: ${j.needsOk ?? ''}`)?.kind ?? 'approval'
      jobs.set(j.id, j)
    }
  } catch {
    // prvý štart
  }
}

// ── feed: what the user sees when they open a job ───────────────────────

/**
 * One line of a job's feed. kind: task (the assignment), reply (a follow-up from the user),
 * step (a tool the agent used), say (what the agent wrote between steps), state (start, end).
 * `safe` is the wording for filming mode; entries without it are hidden there.
 */
function addFeed(j, kind, text, safe = null) {
  const body = String(text ?? '').trim().slice(0, 2400)
  if (!body) return
  const entry = { t: Date.now(), kind, text: body }
  if (safe !== null) entry.safe = safe
  j.feed ??= []
  j.feed.push(entry)
  if (j.feed.length > FEED_MAX) j.feed.shift()
  appendFile(feedFile(j.id), JSON.stringify(entry) + '\n', { mode: 0o600 }).catch(() => {})
  const shown = feedPub(entry, opts.isFilm())
  if (shown) opts.send('job-feed', { id: j.id, entry: shown })
}

/** Markdown reduced to plain lines: the feed shows text, not markup. Links and file paths stay as they are. */
const plain = (text) =>
  String(text ?? '')
    .replace(/```\w*\n?/g, '')
    .replace(/(\*\*|__)(?=\S)(.+?)\1/g, '$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

function feedPub(e, film) {
  if (!film) return { t: e.t, kind: e.kind, text: e.text }
  return e.safe ? { t: e.t, kind: e.kind, text: e.safe } : null
}

/** The feed of a job from before the last restart lives only in its file. Jobs older than the feed fall back to their step list. */
async function ensureFeed(j) {
  if (j.feed) return j.feed
  const feed = []
  try {
    for (const line of (await readFile(feedFile(j.id), 'utf8')).split('\n').slice(-FEED_MAX - 1)) {
      if (!line) continue
      try {
        const e = JSON.parse(line)
        if (e && typeof e.text === 'string') feed.push(e)
      } catch {
        // a half-written last line
      }
    }
  } catch {
    for (const text of j.steps ?? []) feed.push({ t: null, kind: 'step', text, safe: text })
  }
  j.feed ??= feed
  return j.feed
}

/** Everything about one job for the detail view in the HUD. */
export async function jobDetail(id) {
  const j = jobs.get(id)
  if (!j) throw Object.assign(new Error(`úloha ${id} neexistuje`), { status: 404 })
  const film = opts.isFilm()
  const feed = await ensureFeed(j)
  const active = j.status === 'running' || j.status === 'queued'
  return {
    ...pub(j),
    createdAt: j.createdAt,
    task: film ? null : j.task,
    film,
    canReply: !active && Boolean(j.mock || j.sessionId),
    feed: feed.map((e) => feedPub(e, film)).filter(Boolean),
  }
}

// ── čitateľný krok ──────────────────────────────────────────────────────

const short = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** What Jarvis is doing in the user's Chrome, in words. */
const BROWSER_STEP = { navigate: 'Otváram stránku', computer: 'Klikám v prehliadači', browser_batch: 'Klikám v prehliadači', form_input: 'Vypĺňam formulár', read_page: 'Čítam stránku', get_page_text: 'Čítam stránku', find: 'Hľadám na stránke', tabs_create_mcp: 'Otváram novú kartu', tabs_context_mcp: 'Pozerám karty', tabs_close_mcp: 'Zatváram kartu', file_upload: 'Nahrávam súbor' }

export function stepLabel(name, input = {}, film = false) {
  const file = input.file_path || input.path || input.notebook_path
  const base = file ? basename(String(file)) : ''
  switch (name) {
    case 'Bash':
      return film ? 'Pracujem v termináli' : short(`Bash: ${input.command ?? ''}`, 80)
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return film ? 'Upravujem súbor' : short(`Upravujem ${base}`, 80)
    case 'Write':
      return film ? 'Píšem súbor' : short(`Píšem ${base}`, 80)
    case 'Read':
      return film ? 'Čítam súbor' : short(`Čítam ${base}`, 80)
    case 'Grep':
    case 'Glob':
      return 'Hľadám v kóde'
    case 'WebSearch':
      return film ? 'Hľadám na webe' : short(`Hľadám: ${input.query ?? ''}`, 80)
    case 'WebFetch':
      return 'Čítam web'
    case 'Task':
    case 'Agent':
      return film ? 'Pomocný agent' : short(`Pomocný agent: ${input.description ?? ''}`, 80)
    case 'TodoWrite':
      return 'Plánujem kroky'
    case 'Skill':
      return short(`Skill ${input.skill ?? ''}`, 80)
    default:
      if (name.startsWith('mcp__claude-in-chrome__')) return BROWSER_STEP[name.split('__')[2]] ?? 'Pracujem v prehliadači'
      if (name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__')
        return film ? 'Používam nástroj' : short(`${server.replace(/^claude\.ai /, '')}: ${tool}`, 80)
      }
      return short(name, 80)
  }
}

// ── beh ─────────────────────────────────────────────────────────────────

function pump() {
  for (const j of [...jobs.values()].filter((x) => x.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (runningCount() >= MAX_PARALLEL) return
    run(j)
  }
}

function addStep(j, label, safe = label) {
  if (!label) return
  addFeed(j, 'step', label, safe)
  if (label === j.step) return
  j.step = label
  j.steps.push(label)
  if (j.steps.length > 30) j.steps.shift()
  emit(j)
}

/** The line that stops a job until the user answers: `OTÁZKA:` for a missing piece, `NEEDS_OK:` for something going out. */
const WAIT_LINE = /^\s*(?:NEEDS_OK|OTÁZKA|OTAZKA|QUESTION):.*$/gim
/** An outgoing action: sending, publishing, ordering. A question without one of these is a question even after NEEDS_OK. */
const OUTGOING = /po(?:sl|šl)|odo(?:sl|šl)|zverejn|publik|objedn|zaplat|schv[aá]l|mail|spr[aá]v|pr[ií]spev|koment|odpove[dď] (?:pre|komu)/i

/** What the job waits for, from the end of its result. */
export function waitOf(summary) {
  const text = String(summary ?? '')
  const ask = /^\s*(?:OTÁZKA|OTAZKA|QUESTION):\s*(.+)$/im.exec(text)
  if (ask) return { kind: 'question', text: ask[1].trim() }
  const ok = /^\s*NEEDS_OK:\s*(.+)$/m.exec(text)
  if (!ok) return null
  const said = ok[1].trim()
  // Older instructions sent questions through NEEDS_OK as well; a plain question is not an approval.
  return { kind: /\?\s*$/.test(said) && !OUTGOING.test(said) ? 'question' : 'approval', text: said }
}

/**
 * The nudge for the voice brain when a job needs the user (a hidden turn, see server.mjs): Jarvis
 * asks himself, in his own words and with the address from the settings. The job is his hands.
 */
export function waitNudge(job) {
  const done = job.summary ? ` Čo zatiaľ zistila: ${short(job.summary, 300)}` : ''
  const ask =
    job.wait === 'question'
      ? `Tvoja úloha na pozadí ${job.id} („${job.title}") potrebuje od používateľa informáciu: ${job.needsOk}${done} Spýtaj sa ho na to sám, ako keby si na tom pracoval ty, jednou až dvoma krátkymi vetami, s tvojím najlepším tipom, keď ho máš.`
      : `Tvoja úloha na pozadí ${job.id} („${job.title}") pripravila niečo, čo ide von, a potrebuje súhlas: ${job.needsOk}${done} Povedz mu sám, čo máš pripravené a pre koho, a spýtaj sa, či to môžeš poslať.`
  return `[systém: ${ask} Nehovor „úloha" ani „agent", je to tvoja práca. Jeho odpoveď potom pošli cez agent_reply (id ${job.id}). Teraz žiadny nástroj nevolaj.]`
}

/** The first few sentences of a text, for reading aloud when a job gave no spoken line. */
function firstSentences(text, count, max) {
  const out = []
  for (const part of String(text ?? '').split(/(?<=[.!?…])\s+/)) {
    if (out.length >= count || `${out.join(' ')} ${part}`.length > max) break
    out.push(part)
  }
  return out.join(' ').trim() || String(text ?? '').slice(0, max).trim()
}

function finish(j, status, { summary = null, error = null } = {}) {
  if (j.status !== 'running' && j.status !== 'queued') return
  j.proc = null
  j.stopping = false
  j.status = status
  j.endedAt = new Date().toISOString()
  if (summary !== null) {
    j.artifacts = findArtifacts(summary)
    const wait = waitOf(summary)
    if (wait && status === 'done') {
      j.status = 'needs_ok'
      j.wait = wait.kind
      j.needsOk = clean(wait.text, 400)
    } else {
      j.needsOk = null
      j.wait = null
    }
    // The paths of photos and videos shown on the screen are not repeated in the text: the cards show them.
    const body = stripMediaPaths(summary.replace(WAIT_LINE, ''), j.artifacts.filter((a) => MEDIA_KINDS.has(a.kind)))
    // What Jarvis says aloud is the `HLAS:` line. When the model forgot it, the first two plain sentences are read instead of the whole report.
    const voice = speakable(/^\s*HLAS:\s*(.+)$/im.exec(body)?.[1] ?? '')
    const text = speakable(body.replace(/^\s*HLAS:.*$/gim, ''))
    j.summary = trimText(clean(text, 4000), 600) || trimText(clean(voice, 4000), 600) || null
    j.say = clean(voice, 300) || firstSentences(text, 2, 240) || null
  }
  if (error) {
    j.summary = clean(error, 400)
    j.say = null
  }
  j.step = j.status === 'done' ? 'Hotovo' : j.status === 'needs_ok' ? (j.wait === 'question' ? 'Pýtam sa' : 'Čakám na súhlas') : j.status === 'stopped' ? 'Zastavené' : 'Chyba'
  const tail = j.status === 'needs_ok' ? j.needsOk : j.status === 'stopped' ? null : j.summary
  addFeed(j, 'state', tail ? `${j.step}: ${tail}` : j.step, j.step)
  j.reported = false
  emit(j)
  log('jobs', `${j.id} ${j.status} · ${j.cost.turns} krokov · ${Math.round(j.cost.ms / 1000)} s`)
  if (status !== 'stopped') opts.announce(pub(j), { silent: j.silent })
  pump()
}

function run(j) {
  j.status = 'running'
  j.startedAt = j.startedAt ?? new Date().toISOString()
  j.endedAt = null
  j.runT0 = Date.now()
  const reply = j.replyText ?? null
  j.replyText = null
  j.step = reply ? 'Pokračujem' : 'Začínam'
  j.steps.push(j.step)
  addFeed(j, reply ? 'reply' : 'task', reply ?? j.task)
  addFeed(j, 'state', j.step, j.step)
  emit(j)
  if (j.mock) return runMock(j, reply ?? '')
  if (!aiProvider().bin()) return finish(j, 'error', { error: `${aiProvider().product} CLI sa nenašiel` })
  mkdirSync(BRAIN_DIR, { recursive: true })
  startProcess(j).catch((err) => finish(j, 'error', { error: errMsg(err) }))
}

async function startProcess(j) {
  if (j.stopping) return finish(j, 'stopped')
  if (j.status !== 'running') return
  const prompt = j.resume ?? j.task
  const sessionId = j.sessionId && j.resume ? j.sessionId : null
  j.resume = null
  let proc
  let provider
  try {
    // The task goes in over stdin and the context through a file: no quoting problems on Windows.
    writeFileSync(CONTEXT_FILE, contextPrompt(j.film), { mode: 0o600 })
    ;({ proc, provider } = await spawnAgent({ prompt, contextFile: CONTEXT_FILE, sessionId, cwd: CWD, ...(j.model ? { model: j.model } : {}), ...(j.effort ? { effort: j.effort } : {}) }))
  } catch (err) {
    return finish(j, 'error', { error: errMsg(err) })
  }
  j.proc = proc
  const logFile = join(LOG_DIR, `${j.id}.jsonl`)
  let lastText = ''
  let said = ''
  let resultSeen = false
  createInterface({ input: proc.stdout }).on('line', (line) => {
    appendFile(logFile, line + '\n', { mode: 0o600 }).catch(() => {})
    for (const ev of provider.parse(line)) {
      if (ev.type === 'init') {
        j.sessionId = ev.sessionId ?? j.sessionId
        if (ev.apiKey) log('jobs', `POZOR: ${j.id} apiKeySource=${ev.apiKey}`)
        scheduleSave()
      } else if (ev.type === 'tool') {
        // Text followed by a tool call is commentary along the way. The last text of a run is its result and is shown as such.
        if (said) addFeed(j, 'say', plain(said))
        said = ''
        j.cost.turns = (j.cost.turns ?? 0) + (provider.id === 'claude' ? 0 : 1)
        addStep(j, stepLabel(ev.name, ev.input ?? {}, opts.isFilm()), stepLabel(ev.name, ev.input ?? {}, true))
        // Working in the user's browser: the desktop shows a frame, so it is plain who is clicking.
        if (ev.name.startsWith('mcp__claude-in-chrome__')) opts.control?.({ on: true, label: BROWSER_STEP[ev.name.split('__')[2]] ?? 'Pracujem v prehliadači' })
      } else if (ev.type === 'text') {
        lastText = ev.text
        said = ev.text
      } else if (ev.type === 'result' && !resultSeen) {
        resultSeen = true
        j.cost = { turns: (j.cost.turns ?? 0) + (provider.id === 'claude' ? ev.turns ?? 0 : 0), ms: (j.cost.ms ?? 0) + (ev.ms ?? Date.now() - j.runT0) }
        if (ev.ok) finish(j, 'done', { summary: ev.text || lastText })
        else finish(j, 'error', { error: ev.error || 'úloha skončila chybou' })
      }
    }
  })
  let stderr = ''
  createInterface({ input: proc.stderr }).on('line', (line) => {
    stderr = `${stderr}\n${line}`.slice(-1000)
  })
  proc.on('exit', (code, signal) => {
    if (j.proc !== proc) return
    if (j.stopping) return finish(j, 'stopped')
    if (!resultSeen) finish(j, 'error', { error: `${provider.product} skončil (${signal ?? code}) ${stderr.trim().split('\n').pop() ?? ''}` })
  })
  proc.on('error', (err) => finish(j, 'error', { error: errMsg(err) }))
}

function runMock(j, said = '') {
  const steps = ['Čítam AGENTS.md', 'Hľadám: podklady', 'Čítam web', 'Píšem zhrnutie.md']
  let i = 0
  const tick = () => {
    if (j.status !== 'running') return
    if (i < steps.length) {
      if (i === 2) addFeed(j, 'say', 'Podklady mám, ešte si overím dva zdroje a spíšem to.')
      addStep(j, steps[i])
      i++
      j.timer = setTimeout(tick, MOCK_STEP_MS)
      return
    }
    j.cost = { turns: steps.length, ms: Date.now() - j.runT0 }
    // A reply (an answer or an approval) finishes the mock job; the assignment decides what it waits for first.
    // Media named in the assignment come back in the result, the way a real job reports what it made.
    const made = findMediaPaths(j.task)
    const mockEnd = said
      ? `Hotovo podľa odpovede: ${said.slice(0, 80)} (mock).`
      : made.length
      ? `Hotovo (mock): ${made.map((f) => `"${f.raw}"`).join(', ')}.\nHLAS: Mám to hotové, ukazujem na obrazovke.`
      : /otázk|otazk/i.test(j.task)
      ? 'Účet som v správach nenašiel (mock).\nOTÁZKA: Ako sa ten účet volá presne?'
      : /needs_ok|súhlas/i.test(j.task)
        ? 'Pripravil som znenie správy (mock).\nNEEDS_OK: poslať skúšobnú správu'
        : 'Mock úloha je hotová, nič sa reálne nezmenilo.'
    finish(j, 'done', { summary: mockEnd })
  }
  j.proc = { kill: () => clearTimeout(j.timer) }
  j.timer = setTimeout(tick, 600)
}

// ── verejné API ─────────────────────────────────────────────────────────

/** Nová úloha. Vráti verejný stav ({ id, status, … }). */
export async function createJob({ task, title, weight = null, mock = false, silent = false }) {
  const text = String(task ?? '').trim().slice(0, 8000)
  if (!text) throw Object.assign(new Error('chýba task'), { status: 400 })
  const route = routeJob({ task: text, weight })
  await mkdir(LOG_DIR, { recursive: true, mode: 0o700 })
  const isMock = mock || /^mock:/i.test(text) || process.env.JARVIS_MOCK === '1'
  const id = `j${++seq}`
  const j = {
    id,
    title: clean(title, 60) || clean(text.replace(/^mock:\s*/i, ''), 48),
    task: text.replace(/^mock:\s*/i, ''),
    status: 'queued',
    step: 'Vo fronte',
    steps: [],
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    summary: null,
    say: null,
    needsOk: null,
    cost: { turns: 0, ms: 0 },
    sessionId: null,
    weight: route.weight,
    model: route.model,
    effort: route.effort,
    route: route.label,
    mock: isMock,
    silent,
    film: opts.isFilm(),
    reported: true,
  }
  jobs.set(id, j)
  log('jobs', `${id} nová úloha${isMock ? ' (mock)' : ''}: ${route.label}`)
  emit(j)
  pump()
  return pub(j)
}

/** Pokračovanie (doplnenie, schválenie NEEDS_OK) cez --resume tej istej session. */
export function replyJob(id, text) {
  const j = jobs.get(id)
  if (!j) throw Object.assign(new Error(`úloha ${id} neexistuje`), { status: 404 })
  const msg = String(text ?? '').trim().slice(0, 4000)
  if (!msg) throw Object.assign(new Error('chýba text'), { status: 400 })
  if (j.status === 'running' || j.status === 'queued') throw Object.assign(new Error('úloha ešte beží, počkaj na jej koniec alebo ju zastav'), { status: 409 })
  if (!j.mock && !j.sessionId) throw Object.assign(new Error('úloha nemá session, nedá sa v nej pokračovať'), { status: 409 })
  j.resume = j.mock ? null : msg
  j.replyText = msg
  j.status = 'queued'
  j.step = 'Vo fronte'
  j.needsOk = null
  j.wait = null
  j.film = opts.isFilm()
  log('jobs', `${id} pokračuje`)
  emit(j)
  pump()
  return pub(j)
}

export function stopJob(id) {
  const j = jobs.get(id)
  if (!j) throw Object.assign(new Error(`úloha ${id} neexistuje`), { status: 404 })
  if (j.status === 'queued') {
    finish(j, 'stopped')
    return pub(j)
  }
  if (j.status !== 'running') return pub(j)
  j.stopping = true
  if (j.mock) {
    j.proc?.kill()
    finish(j, 'stopped')
  } else {
    killTree(j.proc)
    setTimeout(() => j.stopping && j.proc?.kill?.('SIGKILL'), 5000)
  }
  return pub(j)
}

/**
 * Ends a job's process together with what it started. On Windows the CLI runs behind a shell
 * shim, so a plain kill would end only the shim and leave the agent working.
 */
function killTree(proc) {
  if (!proc?.pid) return
  if (process.platform === 'win32') {
    try {
      spawn(winSys('taskkill.exe'), ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => proc.kill())
      return
    } catch {
      // falls through to a plain kill
    }
  }
  proc.kill('SIGTERM')
}

/** Krátky stav úloh do kontextu ďalšej správy rýchlemu mozgu (dokončené len raz). */
export function jobsContextNote() {
  const parts = []
  for (const j of jobs.values()) {
    if (j.status === 'running' || j.status === 'queued') parts.push(`${j.id} „${j.title}" ${j.status === 'running' ? `beží (${j.step})` : 'čaká vo fronte'}`)
    // A job that waits for the user stays in the context until he answers: his next words may be the answer.
    else if (j.status === 'needs_ok') {
      const first = !j.reported
      j.reported = true
      const tail = j.wait === 'question' ? `čaká na odpoveď na otázku: ${short(j.needsOk, 200)}` : `čaká na súhlas: ${short(j.needsOk, 200)}`
      parts.push(`${j.id} „${j.title}" ${tail}${first && j.summary ? `, ${short(j.summary, 200)}` : ''}`)
    } else if (!j.reported) {
      j.reported = true
      parts.push(`${j.id} „${j.title}" ${j.status}${j.summary ? `, ${short(j.summary, 200)}` : ''}`)
    }
  }
  if (parts.length) scheduleSave()
  return parts.length ? `[úlohy na pozadí: ${parts.join(' | ')}]` : ''
}

export function stopAllJobs() {
  for (const j of jobs.values()) if (j.status === 'running') (j.mock ? j.proc?.kill?.() : killTree(j.proc))
}
