import { TMP } from './setup.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  MAX_ERRORS,
  STORE_FILE,
  addWatch,
  applyResult,
  backoff,
  checkDecision,
  checkModel,
  checkPrompt,
  editWatch,
  everyText,
  guessEvery,
  guessOnce,
  guessUrgent,
  listWatches,
  nextCheckAt,
  parseResult,
  parseUntil,
  planTick,
  pruneEnded,
  readStore,
  removeWatch,
  runCheck,
  setStatus,
  syncOrb,
  topic,
  watchesOrb,
} from '../hud/server/watches.mjs'
import { orbContent } from '../hud/server/orbs.mjs'
import { allowedTools } from '../hud/server/brain.mjs'
import { PROVIDERS } from '../hud/server/provider.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const at = (s) => new Date(s)
const NOON = at('2026-11-26T12:00:00')
const cfg = { quiet: '22:30-07:00' }
const watch = (over = {}) => ({
  id: 's1',
  what: 'keď zlacnie let pod 80 €',
  check: 'kiwi.com, najnižšia cena',
  every: 60,
  between: null,
  until: null,
  once: true,
  notify: 'voice',
  urgent: false,
  model: null,
  status: 'active',
  createdAt: '2026-11-26T08:00:00.000Z',
  updatedAt: '2026-11-26T08:00:00.000Z',
  endedAt: null,
  endReason: null,
  state: { observation: null, lastCheckAt: null, lastResult: null, lastHit: null, lastHitAt: null, link: null, errors: 0, lastError: null, checks: 0, hits: 0, runningSince: null, runningPid: null },
  ...over,
})

test('watches: storage keeps watches across reads, ids count up, writes are atomic JSON', () => {
  const a = addWatch({ what: 'keď mi odpíše Peter', check: 'Gmail: maily od Petra novšie ako začiatok stráže' }, NOON)
  const b = addWatch({ what: 'keď zlacnie let Viedeň Londýn pod 80 €', check: 'kiwi.com', every: 90, until: '+7d', call: true }, NOON)
  assert.equal(a.id, 's1')
  assert.equal(b.id, 's2')
  assert.equal(a.every, 15, 'a reply is checked every 15 minutes')
  assert.equal(b.every, 90)
  assert.equal(b.notify, 'call')
  assert.equal(b.until, new Date(NOON.getTime() + 7 * 86_400_000).toISOString())
  const store = JSON.parse(readFileSync(STORE_FILE, 'utf8'))
  assert.equal(store.seq, 2)
  assert.deepEqual(store.watches.map((w) => w.id), ['s1', 's2'])
  const paused = setStatus('s1', 'pause', NOON)
  assert.equal(paused.status, 'paused')
  assert.equal(setStatus('s1', 'resume', NOON).status, 'active')
  const edited = editWatch('s2', { every: 3, between: '8:00-22:00', once: false }, NOON)
  assert.equal(edited.every, 5, 'never more often than every 5 minutes')
  assert.equal(edited.between, '08:00-22:00')
  assert.equal(edited.once, false)
  removeWatch('s1')
  assert.deepEqual(listWatches().map((w) => w.id), ['s2'])
  assert.throws(() => removeWatch('s1'), /neexistuje/)
  assert.throws(() => addWatch({ what: 'x' }), /plán kontroly/)
  assert.throws(() => addWatch({ what: 'x', check: 'y', until: '2020-01-01' }, NOON), /minulosti/)
  assert.throws(() => editWatch('s2', { between: '25:00' }), /08:00-22:00/)
  // A broken file is an empty store, not a crash.
  writeFileSync(STORE_FILE, '{ broken')
  assert.deepEqual(readStore(), { seq: 0, watches: [] })
  removeStore()
})

function removeStore() {
  writeFileSync(STORE_FILE, JSON.stringify({ seq: 0, watches: [] }))
}

test('watches: the sentence picks the interval, one-shot or repeating, and urgency', () => {
  assert.equal(guessEvery('daj mi vedieť, keď mi odpíše Peter'), 15)
  assert.equal(guessEvery('upozorni ma, keď bitcoin padne pod 60 000'), 30)
  assert.equal(guessEvery('keď pribudne byt v Brne do 15 000 Kč na Sreality'), 60)
  assert.equal(guessEvery('keď príde balík'), 120)
  assert.equal(guessEvery('keď sa zmení táto stránka'), 180)
  assert.equal(guessOnce('keď zlacnie let'), true)
  assert.equal(guessOnce('vždy, keď pribudne nový byt'), false)
  assert.equal(guessUrgent('keď padne server, aj v noci'), true)
  assert.equal(guessUrgent('keď zlacnie let'), false)
  assert.equal(everyText(15), 'každých 15 minút')
  assert.equal(everyText(60), 'každú hodinu')
  assert.equal(everyText(120), 'každé 2 hodiny')
  assert.equal(everyText(300), 'každých 5 hodín')
  assert.equal(everyText(1440), 'raz denne')
  assert.equal(topic('daj mi vedieť, keď zlacnie let pod 80 €'), 'Keď zlacnie let pod 80 €')
  assert.equal(topic('Upozorni ma, keď mi odpíše Peter'), 'Keď mi odpíše Peter')
})

test('watches: until in every accepted shape', () => {
  const now = at('2026-11-26T12:00:00')
  assert.equal(parseUntil('', now), null)
  assert.equal(parseUntil('nie', now), null)
  assert.equal(parseUntil('+12h', now), new Date(now.getTime() + 12 * 3600_000).toISOString())
  assert.equal(parseUntil('2026-12-31', now), new Date(2026, 11, 31, 23, 59).toISOString())
  assert.equal(parseUntil('2026-12-31 18:00', now), new Date(2026, 11, 31, 18, 0).toISOString())
  assert.throws(() => parseUntil('budúci týždeň', now), /Neviem/)
})

test('watches: due decisions (new, waiting, between, quiet, until, running, paused)', () => {
  assert.equal(checkDecision(watch(), NOON, cfg).due, true, 'never checked: due at once')
  const checked = watch({ state: { ...watch().state, lastCheckAt: '2026-11-26T10:30:00.000Z' } })
  // 10:30 UTC is 11:30 in Bratislava: the next check is at 12:30.
  const wait = checkDecision(checked, NOON, cfg)
  assert.equal(wait.due, false)
  assert.equal(wait.why, 'wait')
  assert.equal(checkDecision(checked, at('2026-11-26T12:31:00'), cfg).due, true)
  assert.equal(checkDecision(watch({ between: '14:00-18:00' }), NOON, cfg).why, 'between')
  assert.equal(checkDecision(watch({ between: '08:00-18:00' }), NOON, cfg).due, true)
  const night = at('2026-11-26T23:30:00')
  assert.equal(checkDecision(watch(), night, cfg).why, 'quiet')
  assert.equal(checkDecision(watch({ urgent: true }), night, cfg).due, true, 'an urgent watch is checked in quiet hours')
  const ended = checkDecision(watch({ until: '2026-11-26T10:00:00.000Z' }), NOON, cfg)
  assert.equal(ended.expire, true)
  assert.equal(ended.due, false)
  const running = watch({ state: { ...watch().state, runningSince: new Date(NOON.getTime() - 60_000).toISOString() } })
  assert.equal(checkDecision(running, NOON, cfg).why, 'running')
  const stale = watch({ state: { ...watch().state, runningSince: new Date(NOON.getTime() - 20 * 60_000).toISOString() } })
  assert.equal(checkDecision(stale, NOON, cfg).due, true, 'a check whose process died does not block the watch forever')
  assert.equal(checkDecision(watch({ status: 'paused' }), NOON, cfg).why, 'status')
})

test('watches: backoff after errors, catch-up after sleep without a storm', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(backoff), [1, 2, 4, 8, 8, 8])
  const failed = watch({ state: { ...watch().state, lastCheckAt: '2026-11-26T09:00:00.000Z', errors: 2 } })
  assert.equal(nextCheckAt(failed).toISOString(), '2026-11-26T13:00:00.000Z', 'two errors: four times the interval')
  // The laptop slept two days: twelve watches, each due many times over.
  const many = Array.from({ length: 12 }, (_, i) => watch({ id: `s${i + 1}`, every: 15, state: { ...watch().state, lastCheckAt: new Date(NOON.getTime() - (48 * 60 + i) * 60_000).toISOString() } }))
  const plan = planTick(many, NOON, cfg, 8)
  assert.equal(plan.check.length, 8, 'at most eight checks in one tick')
  assert.equal(plan.check[0].id, 's12', 'the most overdue first')
  assert.equal(new Set(plan.check.map((w) => w.id)).size, 8, 'each watch once, however long it slept')
  const withEnded = planTick([...many.slice(0, 2), watch({ id: 's99', until: '2026-11-25T00:00:00.000Z' })], NOON, cfg)
  assert.deepEqual(withEnded.expire.map((w) => w.id), ['s99'])
})

test('watches: result line parsing is strict', () => {
  assert.deepEqual(parseResult('Pozrel som kiwi.\nODKAZ: https://kiwi.com/x\nHIT: Let do Londýna stojí 74 €.'), { kind: 'hit', text: 'Let do Londýna stojí 74 €.', link: 'https://kiwi.com/x' })
  assert.deepEqual(parseResult('NO: najnižšia cena 92 €'), { kind: 'no', text: 'najnižšia cena 92 €', link: null })
  assert.equal(parseResult('**HIT: Peter odpísal o 14:02.**').kind, 'hit', 'markdown around the line is tolerated')
  assert.equal(parseResult('NIE: bez zmeny').kind, 'no')
  assert.equal(parseResult('ERROR: stránka nejde').kind, 'error')
  // Only the last line counts: a hit mentioned earlier is not a hit.
  assert.equal(parseResult('HIT: možno\nAle nie som si istý.').kind, 'error')
  assert.equal(parseResult('HIT: lacné\nNO: 92 €').kind, 'no')
  assert.equal(parseResult('').kind, 'error')
  assert.equal(parseResult('HIT:').kind, 'error', 'a hit without a sentence is not a hit')
  assert.equal(parseResult('Ok, hotovo.').kind, 'error')
})

test('watches: applying results (one-shot hit, repeat, same hit twice, errors pause)', () => {
  const once = watch()
  assert.equal(applyResult(once, { kind: 'no', text: '92 €' }, NOON), null)
  assert.equal(once.state.observation, '92 €')
  assert.equal(once.state.checks, 1)
  assert.equal(applyResult(once, { kind: 'hit', text: 'Stojí 74 €.', link: 'https://x' }, NOON), 'hit')
  assert.equal(once.status, 'done')
  assert.equal(once.endReason, 'hit')
  assert.equal(once.state.link, 'https://x')
  const repeat = watch({ once: false })
  assert.equal(applyResult(repeat, { kind: 'hit', text: 'Nový byt: Brno, 14 500 Kč.' }, NOON), 'hit')
  assert.equal(repeat.status, 'active', 'a repeating watch goes on after a hit')
  assert.equal(applyResult(repeat, { kind: 'hit', text: 'Nový byt: Brno, 14 500 Kč' }, NOON), null, 'the same hit again stays quiet')
  assert.equal(applyResult(repeat, { kind: 'hit', text: 'Nový byt: Brno, 13 900 Kč.' }, NOON), 'hit')
  assert.equal(repeat.state.hits, 2)
  const broken = watch()
  for (let i = 1; i < MAX_ERRORS; i++) assert.equal(applyResult(broken, { kind: 'error', text: 'stránka nejde' }, NOON), null)
  assert.equal(broken.state.errors, MAX_ERRORS - 1)
  assert.equal(applyResult(broken, { kind: 'error', text: 'stránka nejde' }, NOON), 'paused')
  assert.equal(broken.status, 'paused')
  assert.equal(broken.endReason, 'errors')
  const healed = watch({ state: { ...watch().state, errors: 2 } })
  applyResult(healed, { kind: 'no', text: 'ok' }, NOON)
  assert.equal(healed.state.errors, 0, 'a good check resets the errors')
})

test('watches: finished watches leave after a month', () => {
  const store = { seq: 3, watches: [watch({ id: 's1' }), watch({ id: 's2', status: 'done', endedAt: '2026-10-01T00:00:00.000Z' }), watch({ id: 's3', status: 'expired', endedAt: '2026-11-20T00:00:00.000Z' })] }
  assert.equal(pruneEnded(store, NOON), 1)
  assert.deepEqual(store.watches.map((w) => w.id), ['s1', 's3'])
})

test('watches: the check prompt carries the plan and the last observation, the model is the light tier', () => {
  const w = watch({ state: { ...watch().state, lastCheckAt: '2026-11-26T10:00:00.000Z', observation: 'najnižšia cena 92 €' } })
  const p = checkPrompt(w, NOON)
  assert.match(p, /keď zlacnie let pod 80 €/)
  assert.match(p, /kiwi\.com, najnižšia cena/)
  assert.match(p, /najnižšia cena 92 €/)
  assert.match(p, /^HIT: /m)
  assert.match(checkPrompt(watch(), NOON), /prvá kontrola/)
  const prev = process.env.JARVIS_JOB_MODEL
  delete process.env.JARVIS_JOB_MODEL
  assert.deepEqual(checkModel(watch(), PROVIDERS.claude), { model: 'haiku', effort: null })
  assert.deepEqual(checkModel(watch(), PROVIDERS.codex), { model: null, effort: 'low' })
  assert.deepEqual(checkModel(watch({ model: 'sonnet' }), PROVIDERS.claude), { model: 'sonnet', effort: null })
  if (prev !== undefined) process.env.JARVIS_JOB_MODEL = prev
})

test('watches: a mock check runs end to end and the orb follows', async () => {
  removeStore()
  const hit = addWatch({ what: 'skúšobná stráž', check: 'mock:hit' }, new Date())
  const no = addWatch({ what: 'druhá skúšobná', check: 'nič', once: false }, new Date())
  const r1 = await runCheck(hit.id, { mock: true })
  assert.equal(r1.event, 'hit')
  assert.equal(r1.watch.status, 'done')
  const r2 = await runCheck(no.id, { mock: true })
  assert.equal(r2.event, null)
  assert.equal(r2.watch.state.lastResult, 'no')
  assert.equal(syncOrb({ create: true }), true)
  const orb = orbContent('straze')
  assert.equal(orb.value, '1')
  const list = orb.panel.find((c) => c.type === 'list')
  assert.deepEqual(list.items.map((i) => i.value), ['stráži', 'splnená'])
  assert.equal(list.items[0].say, `Pozastav stráž ${no.id}.`)
  assert.equal(orb.items.length, 2)
  assert.match(orb.items.find((i) => i.t === 'Skúšobná stráž').text, /Posledná zhoda/)
  assert.equal(orb.items.find((i) => i.t === 'Skúšobná stráž').act, 'Zrušiť stráž', 'the detail button says what it does')
  // Without watches the orb panel still says how to start one.
  assert.ok(watchesOrb([], new Date()).panel.some((c) => c.type === 'text'))
})

test('watches: the command line adds, lists and removes (and never needs the HUD)', () => {
  removeStore()
  const env = { ...process.env, PORT: '4699' }
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [join(REPO, 'scripts', 'watch.mjs'), ...args, '--json'], { env, encoding: 'utf8' }))
  const added = run('add', 'keď príde balík', '--check', 'mock:hit', '--every', '120', '--no-check')
  assert.equal(added.ok, true)
  assert.match(added.summary, /každé 2 hodiny/)
  const id = added.watch.id
  assert.equal(run('list').watches.length, 1)
  assert.equal(run('pause', id).watch.status, 'paused')
  assert.equal(run('edit', id, '--every', '30').watch.every, 30)
  const ran = run('run', id, '--mock', '--silent')
  assert.equal(ran.result.kind, 'hit')
  assert.equal(run('remove', id).ok, true)
  assert.equal(run('list').watches.length, 0)
  assert.ok(existsSync(join(TMP, 'data', 'logs', 'watch.log')))
})

test('watches: the voice tool is wired (server tool, allowed for the brain, chip label)', async () => {
  assert.ok(allowedTools().includes('mcp__jarvis-hud__watch'))
  const src = readFileSync(join(REPO, 'hud', 'server', 'mcp', 'jarvis-hud.mjs'), 'utf8')
  assert.match(src, /name: 'watch'/)
  assert.match(src, /enum: \['add', 'list', 'pause', 'resume', 'remove', 'edit', 'run'\]/)
  const { toolMeta } = await import('../hud/server/tools-meta.mjs')
  assert.equal(toolMeta('mcp__jarvis-hud__watch').label, 'Nastavujem stráž')
  const persona = readFileSync(join(REPO, 'hud', 'server', 'persona.mjs'), 'utf8')
  assert.match(persona, /watch \(jarvis-hud\): stráže/)
})
