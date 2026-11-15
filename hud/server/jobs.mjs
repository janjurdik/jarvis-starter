/**
 * Background jobs: a full Claude Code run (files, web, the user's connectors, skills) started by
 * Jarvis. The fast voice brain stays lean and only hands work over through the tools
 * agent_task / agent_reply / agent_stop.
 *
 *   claude -p --output-format stream-json --verbose <permission args> --append-system-prompt-file …
 *   cwd = the Jarvis folder (its CLAUDE.md and memory), the task goes in over stdin.
 *
 * At most 3 at once, the rest wait. State in data/brain/jobs.json, a log per job in
 * data/jobs/<id>.jsonl (0600). Anything that would go out to other people ends with a
 * `NEEDS_OK: …` line and waits for the user's approval.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { CLAUDE_BIN as CLAUDE, MEMORY_EXTERNAL, cleanEnv, modelArgs, permissionArgs } from './agent.mjs'
import { MEMORY_DIR } from './memory/index.mjs'
import { BRAIN_DIR, DATA_DIR, REPO, clean, errMsg, log, spawnBin, writeFileAtomic } from './util.mjs'
import { speakable } from './tts.mjs'

const CWD = process.env.JARVIS_JOB_CWD || REPO
const MAX_PARALLEL = 3
const STATE_FILE = join(BRAIN_DIR, 'jobs.json')
const LOG_DIR = join(DATA_DIR, 'jobs')
const CONTEXT_FILE = join(BRAIN_DIR, 'job-context.md')

const contextPrompt = (film) =>
  [
    'Túto úlohu ti zadal používateľ cez Jarvis HUD (hlasom alebo textom; pri hlase môže mať prepis chyby, domysli rozumný význam).',
    'Pracuješ samostatne až do konca, používateľ pri tom nesedí. Nepýtaj sa na veci, ktoré vieš zistiť alebo rozhodnúť sám.',
    `Si Jarvis: pamäť používateľa je v priečinku ${MEMORY_EXTERNAL ? MEMORY_DIR : 'memory/'} (pozri CLAUDE.md). Čo sa o ňom dozvieš nové a trvalé, zapíš tam.`,
    'Keď treba niečo poslať alebo zverejniť za používateľa (mail, správa, príspevok, objednávka), priprav presné znenie, napíš komu a kam, a odpoveď ukonči samostatným riadkom `NEEDS_OK: <čo a komu>`. Odošli až po schválení.',
    'Keď bez používateľa nevieš pokračovať (chýba informácia), ukonči riadkom `NEEDS_OK: <otázka>`.',
    'Tvoja úplne posledná správa má presne tento tvar. Najprv výsledok: najviac päť krátkych riadkov obyčajného textu, čo je hotové a kde. Žiadny markdown: žiadne hviezdičky, mriežky, tabuľky, odrážky, kód ani emoji. Dlhý výstup (rešerš, zoznam, návrh textu) ulož do súboru a napíš len, kde je. Potom samostatný posledný riadok `HLAS: …` s jednou až dvoma krátkymi vetami, ktoré Jarvis povie nahlas (zdvorilo, vecne, pokojne so suchým humorom).',
    film ? 'Režim natáčania: v poslednej správe ani v NEEDS_OK nespomínaj mená ľudí ani firiem.' : '',
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
  cost: j.cost,
  mock: j.mock || undefined,
})

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
    const all = [...jobs.values()].slice(-60).map(({ proc, timer, ...rest }) => rest)
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
      jobs.set(j.id, j)
    }
  } catch {
    // prvý štart
  }
}

// ── čitateľný krok ──────────────────────────────────────────────────────

const short = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

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

function addStep(j, label) {
  if (!label || label === j.step) return
  j.step = label
  j.steps.push(label)
  if (j.steps.length > 30) j.steps.shift()
  emit(j)
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
    const m = /^\s*NEEDS_OK:\s*(.+)$/m.exec(summary)
    if (m && status === 'done') {
      j.status = 'needs_ok'
      j.needsOk = clean(m[1], 400)
    } else j.needsOk = null
    const body = summary.replace(/^\s*NEEDS_OK:.*$/m, '')
    // What Jarvis says aloud is the `HLAS:` line. When the model forgot it, the first two plain sentences are read instead of the whole report.
    const voice = speakable(/^\s*HLAS:\s*(.+)$/im.exec(body)?.[1] ?? '')
    const text = speakable(body.replace(/^\s*HLAS:.*$/gim, ''))
    j.summary = clean(text, 600) || clean(voice, 600) || null
    j.say = clean(voice, 300) || firstSentences(text, 2, 240) || null
  }
  if (error) {
    j.summary = clean(error, 400)
    j.say = null
  }
  j.step = j.status === 'done' ? 'Hotovo' : j.status === 'needs_ok' ? 'Čaká na súhlas' : j.status === 'stopped' ? 'Zastavené' : 'Chyba'
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
  j.step = j.resume ? 'Pokračujem' : 'Začínam'
  j.steps.push(j.step)
  emit(j)
  if (j.mock) return runMock(j)
  if (!CLAUDE) return finish(j, 'error', { error: 'Claude Code CLI sa nenašiel' })
  mkdirSync(BRAIN_DIR, { recursive: true })
  startProcess(j).catch((err) => finish(j, 'error', { error: errMsg(err) }))
}

async function startProcess(j) {
  const perms = permissionArgs()
  if (j.stopping) return finish(j, 'stopped')
  if (j.status !== 'running') return
  const prompt = j.resume ?? j.task
  // The task goes in over stdin and the context through a file: no quoting problems on Windows.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', ...modelArgs(), ...perms, '--append-system-prompt-file', CONTEXT_FILE]
  if (j.sessionId && j.resume) args.push('--resume', j.sessionId)
  j.resume = null
  try {
    writeFileSync(CONTEXT_FILE, contextPrompt(j.film), { mode: 0o600 })
  } catch (err) {
    return finish(j, 'error', { error: errMsg(err) })
  }
  const proc = spawnBin(CLAUDE, args, { cwd: CWD, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  proc.stdin.on('error', () => {})
  proc.stdin.end(prompt)
  j.proc = proc
  const logFile = join(LOG_DIR, `${j.id}.jsonl`)
  let lastText = ''
  let resultSeen = false
  createInterface({ input: proc.stdout }).on('line', (line) => {
    appendFile(logFile, line + '\n', { mode: 0o600 }).catch(() => {})
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m.type === 'system' && m.subtype === 'init') {
      j.sessionId = m.session_id ?? j.sessionId
      if (m.apiKeySource && m.apiKeySource !== 'none') log('jobs', `POZOR: ${j.id} apiKeySource=${m.apiKeySource}`)
      scheduleSave()
    } else if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) {
        if (b.type === 'tool_use') addStep(j, stepLabel(b.name, b.input ?? {}, opts.isFilm()))
        else if (b.type === 'text' && b.text?.trim()) lastText = b.text
      }
    } else if (m.type === 'result') {
      resultSeen = true
      j.cost = { turns: (j.cost.turns ?? 0) + (m.num_turns ?? 0), ms: (j.cost.ms ?? 0) + (m.duration_ms ?? Date.now() - j.runT0) }
      if (m.subtype === 'success' && !m.is_error) finish(j, 'done', { summary: m.result || lastText })
      else finish(j, 'error', { error: m.result || (Array.isArray(m.errors) ? m.errors.join('; ') : '') || `úloha skončila chybou (${m.subtype})` })
    }
  })
  let stderr = ''
  createInterface({ input: proc.stderr }).on('line', (line) => {
    stderr = `${stderr}\n${line}`.slice(-1000)
  })
  proc.on('exit', (code, signal) => {
    if (j.proc !== proc) return
    if (j.stopping) return finish(j, 'stopped')
    if (!resultSeen) finish(j, 'error', { error: `claude skončil (${signal ?? code}) ${stderr.trim().split('\n').pop() ?? ''}` })
  })
  proc.on('error', (err) => finish(j, 'error', { error: errMsg(err) }))
}

function runMock(j) {
  const steps = ['Čítam CLAUDE.md', 'Hľadám: podklady', 'Čítam web', 'Píšem zhrnutie.md']
  let i = 0
  const tick = () => {
    if (j.status !== 'running') return
    if (i < steps.length) {
      addStep(j, steps[i])
      i++
      j.timer = setTimeout(tick, 900)
      return
    }
    j.cost = { turns: steps.length, ms: Date.now() - j.runT0 }
    finish(j, 'done', { summary: /needs_ok|súhlas/i.test(j.task) ? 'Pripravil som znenie správy (mock).\nNEEDS_OK: poslať skúšobnú správu' : 'Mock úloha je hotová, nič sa reálne nezmenilo.' })
  }
  j.proc = { kill: () => clearTimeout(j.timer) }
  j.timer = setTimeout(tick, 600)
}

// ── verejné API ─────────────────────────────────────────────────────────

/** Nová úloha. Vráti verejný stav ({ id, status, … }). */
export async function createJob({ task, title, mock = false, silent = false }) {
  const text = String(task ?? '').trim().slice(0, 8000)
  if (!text) throw Object.assign(new Error('chýba task'), { status: 400 })
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
    mock: isMock,
    silent,
    film: opts.isFilm(),
    reported: true,
  }
  jobs.set(id, j)
  log('jobs', `${id} nová úloha${isMock ? ' (mock)' : ''}`)
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
  if (j.mock) j.task = msg
  j.status = 'queued'
  j.step = 'Vo fronte'
  j.needsOk = null
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
    j.proc?.kill('SIGTERM')
    setTimeout(() => j.proc?.kill?.('SIGKILL'), 5000)
  }
  return pub(j)
}

/** Krátky stav úloh do kontextu ďalšej správy rýchlemu mozgu (dokončené len raz). */
export function jobsContextNote() {
  const parts = []
  for (const j of jobs.values()) {
    if (j.status === 'running' || j.status === 'queued') parts.push(`${j.id} „${j.title}" ${j.status === 'running' ? `beží (${j.step})` : 'čaká vo fronte'}`)
    else if (!j.reported) {
      j.reported = true
      const tail = j.status === 'needs_ok' ? `čaká na súhlas: ${short(j.needsOk, 160)}` : j.status
      parts.push(`${j.id} „${j.title}" ${tail}${j.summary ? `, ${short(j.summary, 200)}` : ''}`)
    }
  }
  if (parts.length) scheduleSave()
  return parts.length ? `[úlohy na pozadí: ${parts.join(' | ')}]` : ''
}

export function stopAllJobs() {
  for (const j of jobs.values()) if (j.status === 'running') j.proc?.kill?.('SIGTERM')
}
