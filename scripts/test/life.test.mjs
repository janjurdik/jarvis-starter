import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'jarvis-life-'))
process.env.JARVIS_DATA_DIR = join(dir, 'data')
process.env.JARVIS_MEMORY_DIR = join(dir, 'memory')
process.env.JARVIS_CONFIG = join(dir, 'jarvis.json')

const { easter, lifeNote, occasions, startLife, wishNow } = await import('../../hud/server/life.mjs')
const ids = (date, cfg) => occasions(new Date(date), { name: '', ...cfg }).map((o) => o.id)

test('easter falls on the known Sundays', () => {
  assert.equal(easter(2026).toDateString(), new Date(2026, 3, 5).toDateString())
  assert.equal(easter(2027).toDateString(), new Date(2027, 2, 28).toDateString())
  assert.equal(easter(2030).toDateString(), new Date(2030, 3, 21).toDateString())
})

test('fixed days of the year', () => {
  assert.deepEqual(ids('2027-01-01T00:00:30'), ['novy-rok'])
  assert.deepEqual(ids('2026-12-24T09:00:00'), ['vianoce'])
  assert.deepEqual(ids('2026-04-05T10:00:00'), ['velka-noc'])
  assert.deepEqual(ids('2026-11-18T10:00:00'), [])
})

test('the birthday of the user, with and without the year', () => {
  assert.deepEqual(ids('2027-06-04T08:00:00', { birthday: '2007-06-04' }), ['narodeniny'])
  assert.match(occasions(new Date('2027-06-04T08:00:00'), { name: '', birthday: '2007-06-04' })[0].what, /20 rokov/)
  assert.deepEqual(ids('2027-06-04T08:00:00', { birthday: '06-04' }), ['narodeniny'])
  assert.deepEqual(ids('2027-06-05T08:00:00', { birthday: '06-04' }), [])
})

test('the name day of the user', () => {
  assert.deepEqual(ids('2026-06-24T08:00:00', { name: 'Ján Novák' }), ['meniny'])
  assert.deepEqual(ids('2026-06-24T08:00:00', { name: 'Peter' }), [])
})

test('a wish is said once, when somebody is there to hear it', async () => {
  const heard = []
  let present = false
  let night = false
  startLife({ canSpeak: () => present, brainReady: () => false, say: (text) => heard.push(text), toast: () => {}, notify: () => {}, quiet: () => night })
  const newYear = new Date('2027-01-01T00:00:30')
  await wishNow(newYear)
  assert.deepEqual(heard, [], 'nobody at the desktop: it waits')
  present = true
  await wishNow(newYear)
  assert.equal(heard.length, 1)
  assert.match(heard[0], /nový rok/i)
  await wishNow(newYear)
  assert.equal(heard.length, 1, 'never twice on the same day')
  assert.equal(lifeNote(newYear).includes('Nový rok'), false, 'and not again in the conversation')
})

test('a wish nobody heard opens the first conversation of the day', async () => {
  const christmas = new Date('2026-12-24T09:00:00')
  const first = lifeNote(christmas)
  assert.match(first, /Štedrý deň/)
  assert.equal(lifeNote(christmas).includes('Štedrý deň'), false)
})
