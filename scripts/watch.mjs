#!/usr/bin/env node
/**
 * Stráže from the command line: „daj mi vedieť, keď…" as data in data/watches.json, checked in
 * the background by a cheap agent run and announced only when the condition is really met
 * (hud/server/watches.mjs, docs/STRAZE.md).
 *
 *   node scripts/watch.mjs add "<veta>" --check "<plán>" [--every 60] [--until 2026-12-31|+7d] [--between 08:00-22:00]
 *                              [--once|--repeat] [--call|--quiet] [--urgent] [--model haiku] [--no-check] [--json]
 *   node scripts/watch.mjs list [--all] [--json]
 *   node scripts/watch.mjs pause|resume|remove <id> [--json]
 *   node scripts/watch.mjs edit <id> [--what "…"] [--check "…"] [--every N] [--until …] [--between …] [--once|--repeat] [--call|--voice|--quiet] [--urgent|--not-urgent]
 *   node scripts/watch.mjs run <id> [--silent] [--mock] [--json]   one check now (for testing; announces a hit)
 *   node scripts/watch.mjs due [--json]                            what is due now and why
 *   node scripts/watch.mjs tick [--silent] [--mock]                the background run (the pulse and the HUD start it)
 *
 * --silent: a hit still shows its card in the HUD, but nothing is said aloud, no notification, no call.
 */
// .env first: the modules below read JARVIS_MEMORY_DIR and JARVIS_DATA_DIR when they load.
import '../hud/server/env.mjs'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig } from '../hud/server/config.mjs'
import { callReady } from '../hud/server/call.mjs'
import {
  MAX_ERRORS,
  MAX_PARALLEL,
  MAX_PER_TICK,
  addWatch,
  checkDecision,
  describe,
  editWatch,
  everyText,
  expireWatches,
  kickWatches,
  listWatches,
  mutate,
  planTick,
  pruneEnded,
  releaseTickLock,
  removeWatch,
  runCheck,
  setStatus,
  syncOrb,
  takeTickLock,
  topic,
  whenText,
} from '../hud/server/watches.mjs'
import { LOG_DIR, callOut, hudListeners, notify, postHud, quietNow } from './lib.mjs'

const VALUE_FLAGS = new Set(['check', 'every', 'until', 'between', 'model', 'what'])
const argv = process.argv.slice(2)
const flags = new Set()
const opts = {}
const rest = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) {
    rest.push(a)
    continue
  }
  const eq = a.indexOf('=')
  const name = eq > 0 ? a.slice(2, eq) : a.slice(2)
  if (VALUE_FLAGS.has(name)) opts[name] = eq > 0 ? a.slice(eq + 1) : argv[++i]
  else flags.add(name)
}
const [cmd = 'list', ...args] = rest
const asJson = flags.has('json')
const silent = flags.has('silent')
const mock = flags.has('mock')

mkdirSync(LOG_DIR, { recursive: true })
const log = (msg) => {
  appendFileSync(join(LOG_DIR, 'watch.log'), `${new Date().toISOString()} ${msg}\n`)
  if (process.stdout.isTTY && !asJson && cmd === 'tick') console.log(msg)
}

/** An open HUD redraws the orb Stráže at once; without one it shows on the next start. */
async function refreshOrb({ create = false } = {}) {
  if (syncOrb({ create })) await postHud('/api/orbs', { action: 'reload', id: 'straze' })
}

function out(summary, data = {}) {
  if (asJson) console.log(JSON.stringify({ ok: true, summary, ...data }, null, 2))
  else console.log(summary)
}

const title = (w) => {
  const t = topic(w.what)
  return `Stráž: ${t.length > 50 ? `${t.slice(0, 49)}…` : t}`
}

/**
 * Says what a check found, through the same path as routines: a card and a LOG line in the HUD,
 * Jarvis's voice (or the speakers when no window is open), a system notification, and a phone
 * call when the watch asks for one and calls are set up. Quiet hours hold the voice and the call,
 * unless the watch is urgent.
 */
async function deliver(w, event, { reason = '' } = {}) {
  const cfg = getConfig()
  const hush = quietNow(cfg, new Date()) && !w.urgent
  const listeners = await hudListeners()
  let head
  let text
  let say
  if (event === 'hit') {
    head = title(w)
    text = [w.state.lastHit, w.state.link].filter(Boolean).join('\n')
    say = w.state.lastHit
  } else if (event === 'paused') {
    const a = cfg.assistant?.gender === 'female' ? 'a' : ''
    head = `Stráž pozastavená: ${topic(w.what).slice(0, 40)}`
    text = `${MAX_ERRORS}-krát po sebe sa to nepodarilo overiť (${w.state.lastError ?? 'neznámy dôvod'}). Stráž stojí, kým sa neupraví alebo neobnoví.`
    say = `Stráž „${topic(w.what).replace(/[.!?]+$/, '')}" som pozastavil${a}, ${MAX_ERRORS}-krát po sebe sa mi ju nepodarilo overiť. ${w.state.lastError ? `Dôvod: ${w.state.lastError.replace(/[.!?]+$/, '')}.` : ''} ${cfg.formal === false ? 'Povedz' : 'Povedzte'}, či ju mám upraviť.`.replace(/\s+/g, ' ').trim()
  } else {
    head = `Stráž skončila: ${topic(w.what).slice(0, 40)}`
    text = reason || `Do ${whenText(w.until)} sa to nestalo, stráž skončila.`
    say = ''
  }
  const quietCard = silent || hush || listeners === 0 || w.notify === 'quiet' || event === 'expired' || !say
  if (listeners >= 0) await postHud('/api/announce', { title: head, text, say, node: 'rutiny', icon: 'eye', silent: quietCard, log: `${head}${event === 'hit' ? ' · splnené' : ''}` })
  if (silent) return log(`${w.id} ${event} ohlásené potichu (--silent)`)
  await notify(`Jarvis: ${head}`, say || text)
  if (!hush && listeners <= 0 && say && w.notify !== 'quiet') {
    const { localVoiceOn, speakLocal } = await import('../hud/server/speak.mjs')
    if (localVoiceOn()) await speakLocal(say)
  }
  if (event === 'hit' && w.notify === 'call' && !hush && callReady()) {
    callOut(say, 'straz')
    log(`${w.id} volám na mobil`)
  }
  log(`${w.id} ${event} ohlásené${hush ? ' (ticho)' : ''}`)
}

async function checkOne(id) {
  const r = await runCheck(id, { mock })
  if (!r.watch) return r
  log(`${r.watch.id} ${r.result.kind} za ${Math.round(r.ms / 1000)} s: ${r.result.text}`)
  if (r.event) await deliver(r.watch, r.event)
  return r
}

/** The background run: due checks two at a time, the most overdue first, at most MAX_PER_TICK. */
async function tick() {
  if (!takeTickLock()) return out('Stráže sa už kontrolujú.', { busy: true })
  process.on('exit', releaseTickLock)
  let done = 0
  const ran = new Set()
  try {
    const expired = expireWatches(planTick(listWatches()).expire.map((w) => w.id))
    for (const w of expired) await deliver(w, 'expired')
    mutate((store) => pruneEnded(store))
    const running = new Set()
    const next = () => planTick(listWatches().filter((w) => !ran.has(w.id))).check[0] ?? null
    await new Promise((resolve) => {
      const pump = () => {
        while (running.size < MAX_PARALLEL && done + running.size < MAX_PER_TICK) {
          const w = next()
          if (!w) break
          ran.add(w.id)
          const p = checkOne(w.id)
            .catch((err) => log(`${w.id} chyba: ${err.message}`))
            .finally(() => {
              running.delete(p)
              done++
              refreshOrb().finally(pump)
            })
          running.add(p)
        }
        if (!running.size) resolve()
      }
      pump()
    })
    if (expired.length) await refreshOrb()
  } finally {
    releaseTickLock()
  }
  out(done ? `Skontrolované stráže: ${done}.` : 'Teraz nie je čo kontrolovať.', { checked: done })
}

const watchPatch = () => {
  const p = {}
  for (const k of ['what', 'check', 'every', 'until', 'between', 'model']) if (opts[k] !== undefined) p[k] = opts[k]
  if (flags.has('once')) p.once = true
  if (flags.has('repeat')) p.once = false
  if (flags.has('call')) p.notify = 'call'
  if (flags.has('quiet')) p.notify = 'quiet'
  if (flags.has('voice')) p.notify = 'voice'
  if (flags.has('urgent')) p.urgent = true
  if (flags.has('not-urgent')) p.urgent = false
  return p
}

try {
  if (cmd === 'add') {
    const what = args.join(' ').trim()
    const w = addWatch({ ...watchPatch(), what })
    log(`${w.id} nová stráž: ${w.what} (${everyText(w.every)})`)
    await refreshOrb({ create: true })
    // The first check runs right away in the background: it proves the plan works and takes the baseline.
    const d = checkDecision(w)
    if (!flags.has('no-check')) kickWatches()
    const first = flags.has('no-check') ? '' : d.due ? ' Prvá kontrola beží hneď.' : d.why === 'quiet' ? ' Prvá kontrola po tichých hodinách.' : d.why === 'between' ? ` Prvá kontrola v čase ${w.between}.` : ''
    out(
      `Stráž ${w.id}: „${w.what}", kontrolujem ${everyText(w.every)}${w.between ? ` (len ${w.between})` : ''}${w.until ? `, najdlhšie do ${whenText(w.until)}` : ''}. ${w.once ? 'Ozvem sa raz, keď to nastane.' : 'Ozvem sa pri každej novej zhode.'}${w.notify === 'call' ? ' Aj zavolám.' : ''}${first}`,
      { watch: w, firstCheck: !flags.has('no-check') && d.due },
    )
  } else if (cmd === 'list') {
    const all = listWatches()
    const shown = flags.has('all') ? all : all.filter((w) => w.status === 'active' || w.status === 'paused' || Date.now() - Date.parse(w.endedAt ?? w.updatedAt) < 7 * 86_400_000)
    if (asJson) console.log(JSON.stringify({ ok: true, watches: shown }, null, 2))
    else console.log(shown.length ? shown.map((w) => `  ${describe(w)}`).join('\n') : 'Žiadne stráže. Pridanie: node scripts/watch.mjs add "<veta>" --check "<plán>"')
  } else if (cmd === 'pause' || cmd === 'resume') {
    const w = setStatus(args[0], cmd)
    log(`${w.id} ${cmd}`)
    await refreshOrb()
    if (cmd === 'resume') kickWatches()
    out(cmd === 'pause' ? `Stráž ${w.id} „${w.what}" stojí.` : `Stráž ${w.id} „${w.what}" znova stráži, ${everyText(w.every)}.`, { watch: w })
  } else if (cmd === 'remove') {
    const w = removeWatch(args[0])
    log(`${w.id} zrušená`)
    await refreshOrb()
    out(`Stráž ${w.id} „${w.what}" je zrušená.`, { watch: w })
  } else if (cmd === 'edit') {
    const patch = watchPatch()
    if (!Object.keys(patch).length) throw new Error('Čo zmeniť: --what, --check, --every, --until, --between, --once/--repeat, --call/--voice/--quiet, --urgent/--not-urgent.')
    const w = editWatch(args[0], patch)
    log(`${w.id} upravená: ${Object.keys(patch).join(', ')}`)
    await refreshOrb()
    kickWatches()
    out(`Stráž ${w.id} je upravená: ${describe(w)}`, { watch: w })
  } else if (cmd === 'run') {
    const r = await checkOne(args[0])
    await refreshOrb()
    if (!r.watch) out('Stráž medzitým zmizla.', { result: r.result })
    else out(`${r.result.kind === 'hit' ? 'Zhoda' : r.result.kind === 'no' ? 'Nič nové' : 'Chyba'}: ${r.result.text} (${Math.round(r.ms / 1000)} s)`, { result: r.result, event: r.event, watch: r.watch, ms: r.ms })
  } else if (cmd === 'due') {
    const cfg = getConfig()
    const rows = listWatches().map((w) => ({ id: w.id, what: w.what, ...checkDecision(w, new Date(), cfg) }))
    if (asJson) console.log(JSON.stringify({ ok: true, watches: rows }, null, 2))
    else console.log(rows.length ? rows.map((r) => `  ${r.id} ${r.due ? 'na rade' : r.why}${r.at ? ` (o ${whenText(r.at.toISOString())})` : ''} · ${r.what}`).join('\n') : 'Žiadne stráže.')
  } else if (cmd === 'tick') {
    await tick()
  } else {
    throw new Error(`Neznámy príkaz ${cmd}. Poznám add, list, pause, resume, remove, edit, run, due, tick.`)
  }
  process.exit(0)
} catch (err) {
  if (asJson) console.log(JSON.stringify({ ok: false, error: err.message }))
  else console.error(err.message)
  process.exit(1)
}
