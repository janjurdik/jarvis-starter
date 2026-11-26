import { TMP } from './setup.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { _test, buildPayload, countTurn, notesBucket, offReason, sendPing } from '../hud/server/telemetry.mjs'

const ON = { PATH: process.env.PATH }
const DATA = join(TMP, 'data')

test('statistics are off in settings, .env, DO_NOT_TRACK and tests', () => {
  assert.equal(offReason(ON, { telemetry: true }), null)
  assert.equal(offReason(ON, { telemetry: false }), 'settings')
  assert.equal(offReason({ JARVIS_TELEMETRY: '0' }, {}), 'env')
  assert.equal(offReason({ DO_NOT_TRACK: '1' }, {}), 'do-not-track')
  assert.equal(offReason({ JARVIS_SECONDARY: '1' }, {}), 'test')
  assert.equal(offReason({ JARVIS_MOCK: '1' }, {}), 'test')
  // the test runner itself never sends
  assert.equal(offReason(), 'test')
})

test('the payload holds counts and choices only, never text', () => {
  _test.reset()
  countTurn('text', ON)
  countTurn('voice', ON)
  countTurn('text', ON)
  mkdirSync(join(DATA, 'brain'), { recursive: true })
  writeFileSync(join(DATA, 'watches.json'), JSON.stringify({ watches: [{ what: 'Tajná vec Petra', status: 'active', state: { lastHitAt: new Date().toISOString(), lastHit: 'Peter Novák odpísal' } }, { what: 'x', status: 'paused', state: {} }] }))
  writeFileSync(join(DATA, 'brain', 'jobs.json'), JSON.stringify({ seq: 2, jobs: [{ title: 'Napíš mail Jane', createdAt: new Date().toISOString() }] }))
  writeFileSync(join(DATA, 'apps.json'), JSON.stringify({ picked: ['gmail', 'spotify'], own: ['Moja appka'] }))
  const p = buildPayload({ ctx: { ai: 'claude', surface: 'app', lang: 'sk', stt: 'whisper', tts: 'edge', setup: 'done', notes: 73, orbs: 2, mobile: true, wake: false, calls: false } })
  assert.match(p.id, /^[0-9a-f]{32}$/)
  assert.deepEqual(p.counts, { text: 2, voice: 1, jobs: 1, recordings: 0, screen: 0, watchHits: 1 })
  assert.deepEqual(p.state, { watches: 1, routines: 0, orbs: 2, apps: 3 })
  assert.equal(p.notes, '50-199')
  assert.equal(p.flags.mobile, true)
  const text = JSON.stringify(p)
  for (const secret of ['Tajná', 'Peter', 'Jane', 'Moja appka', 'gmail', 'Test']) assert.ok(!text.includes(secret), `${secret} leaked`)
})

test('notes are sent only as a band', () => {
  assert.deepEqual([0, 1, 9, 10, 49, 50, 199, 200, 5000].map(notesBucket), ['0', '1-9', '1-9', '10-49', '10-49', '50-199', '50-199', '200+', '200+'])
})

test('a ping goes out once a day, takes off what it sent, and nothing when off', async () => {
  _test.reset()
  countTurn('text', ON)
  const sent = []
  const fetchImpl = async (url, opts) => (sent.push({ url, body: JSON.parse(opts.body) }), { ok: true, status: 200 })
  assert.deepEqual(await sendPing({ fetchImpl, env: { DO_NOT_TRACK: '1' } }), { ok: false, skipped: 'do-not-track' })
  assert.equal(sent.length, 0)
  assert.equal((await sendPing({ fetchImpl, env: ON })).ok, true)
  assert.equal(sent.length, 1)
  assert.match(sent[0].url, /\/v1\/ping$/)
  assert.equal(sent[0].body.counts.text, 1)
  const saved = JSON.parse(readFileSync(join(DATA, 'telemetry.json'), 'utf8'))
  assert.equal(saved.counts.text, 0)
  assert.ok(saved.lastSent)
  assert.deepEqual(await sendPing({ fetchImpl, env: ON }), { ok: false, skipped: 'recent' })
  assert.equal(sent.length, 1)
})

test('a failed ping keeps the counts for the next one', async () => {
  _test.reset()
  writeFileSync(join(DATA, 'telemetry.json'), JSON.stringify({ id: 'a'.repeat(32), lastSent: null, counts: { text: 4, voice: 0 } }))
  _test.reset()
  const r = await sendPing({ fetchImpl: async () => { throw new Error('offline') }, env: ON })
  assert.equal(r.ok, false)
  assert.equal(_test.read().counts.text, 4)
  assert.equal(_test.read().id, 'a'.repeat(32))
})

test('the brain may turn statistics off, never back on', async () => {
  const before = readFileSync(process.env.JARVIS_CONFIG, 'utf8')
  const { brainSettings } = await import('../hud/server/settings.mjs')
  const on = await brainSettings({ set: { telemetry: true } })
  assert.equal(on.ok, false)
  assert.match(on.error, /len používateľ/)
  assert.equal(JSON.parse(readFileSync(process.env.JARVIS_CONFIG, 'utf8')).telemetry, undefined, 'nothing was written')
  const off = await brainSettings({ set: { telemetry: false } })
  assert.equal(off.ok, true)
  assert.equal(JSON.parse(readFileSync(process.env.JARVIS_CONFIG, 'utf8')).telemetry, false)
  writeFileSync(process.env.JARVIS_CONFIG, before)
})
