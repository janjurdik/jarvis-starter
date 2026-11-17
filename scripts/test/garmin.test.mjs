/**
 * The Garmin source without a Garmin account: node --test scripts/test/*.test.mjs
 * The worker answers from test/fixtures/garmin/connect.json instead of Garmin. Everything happens
 * in a throwaway folder, the real memory and data are never touched. The tests that run the worker
 * need `uv` (it starts the worker with the pinned library versions) and are skipped without it.
 * They build on each other, in the order they are written.
 */
import assert from 'node:assert/strict'
import { test as nodeTest } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const FIXTURE_FILE = join(REPO, 'test', 'fixtures', 'garmin', 'connect.json')
const BOX = mkdtempSync(join(tmpdir(), 'jarvis-garmin-'))
const DATA = join(BOX, 'data')
const MEM = join(BOX, 'memory')
const DAYS = join(MEM, 'dennik')
mkdirSync(DAYS, { recursive: true })
process.env.JARVIS_DATA_DIR = DATA
process.env.JARVIS_MEMORY_DIR = MEM
process.env.JARVIS_CONFIG = join(BOX, 'jarvis.json')

const { autoPlan, mergeDayNote, garminConnected, readState, uvReady } = await import('../../hud/server/garmin/index.mjs')
const { dayStats, getIndex, logDay } = await import('../../hud/server/memory/index.mjs')

const FIXTURE = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8'))
const fixtureFile = (change = (f) => f) => {
  const file = join(BOX, `fixture-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(file, JSON.stringify(change(structuredClone(FIXTURE))))
  return file
}
const cli = (args, { input } = {}) => {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'garmin.mjs'), ...args], { cwd: REPO, env: process.env, encoding: 'utf8', input: input ?? '', timeout: 240_000 })
  return { code: r.status, out: `${r.stdout}${r.stderr}`, json: () => JSON.parse(r.stdout) }
}
const sync = (file = FIXTURE_FILE, days = 3) => cli(['sync', '--days', String(days), '--today', '2026-11-17', '--fixture', file, '--json'])
const note = (day) => readFileSync(join(DAYS, `${day}.md`), 'utf8')
const snapshot = () => Object.fromEntries(readdirSync(DAYS).map((f) => [f, `${statSync(join(DAYS, f)).mtimeMs}|${readFileSync(join(DAYS, f), 'utf8')}`]))
/** Local HH:MM of a UTC instant, the way the worker converts sleep times. */
const localClock = (iso) => new Date(iso).toLocaleTimeString('sv-SE').slice(0, 5)

/** Tests that start the worker through uv. */
const test = (name, fn) => nodeTest(name, { skip: uvReady() ? false : 'uv is not installed' }, fn)
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }))

await test('status without a login says not connected and prints the one line to type', () => {
  const r = cli(['status', '--json'])
  const s = r.json()
  assert.equal(r.code, 0)
  assert.equal(s.connected, false)
  assert.match(s.login.mac, /node scripts\/garmin\.mjs login$/)
  assert.match(s.login.windows, /node scripts\/garmin\.mjs login$/)
  assert.equal(garminConnected(), false)
})

await test('login refuses without a terminal instead of waiting for a password', () => {
  const r = cli(['login'], { input: 'someone@example.com\nnot-a-real-password\n' })
  assert.equal(r.code, 2)
  assert.match(r.out, /len v termináli/)
  assert.doesNotMatch(r.out, /not-a-real-password/)
  assert.equal(garminConnected(), false)
})

await test('sync without a login does not contact Garmin', () => {
  const r = cli(['sync', '--days', '2', '--json'])
  assert.equal(r.code, 1)
  assert.equal(r.json().error, 'not_connected')
})

await test('fixture sync writes the notes and keeps the user\'s text and fields', () => {
  writeFileSync(join(DAYS, '2026-11-16.md'), '---\nspanok: 6.5\nnalada: 4\n---\n- Ráno som bol u zubára.\n\n## Zhrnutie dňa\n\nPokojný deň, večer [[Jana Nováková]].\n')
  writeFileSync(join(DAYS, '2026-11-15.md'), '- Dlhá prechádzka so psom.\n')
  const r = sync()
  assert.equal(r.code, 0, r.out)
  const res = r.json()
  assert.deepEqual(res.created, ['2026-11-17'])
  assert.deepEqual(res.changed.sort(), ['2026-11-15', '2026-11-16'])
  assert.deepEqual(res.kept, [{ day: '2026-11-16', fields: ['spanok'] }])
  assert.equal(res.lastNightKnown, true)

  const d17 = note('2026-11-17')
  for (const line of ['spanok: 7:12', 'spanok_zdroj: garmin', 'spanok_skore: 82', 'spanok_fazy: hlboky 1:25, lahky 3:50, rem 1:40, bdely 0:17', 'hrv: 62', 'tep_pokoj: 48', 'bateria: 88', 'bateria_rano: 85', 'kroky: 2140', 'stres: 24', 'pripravenost: 74']) assert.ok(d17.includes(`\n${line}\n`), `2026-11-17 is missing "${line}"`)
  assert.ok(d17.includes(`\nzaspal: ${localClock('2026-11-16T22:41:00Z')}\n`))
  assert.ok(d17.includes(`\nvstal: ${localClock('2026-11-17T05:53:00Z')}\n`))

  const d16 = note('2026-11-16')
  assert.ok(d16.startsWith('---\nspanok: 6.5\nnalada: 4\n'), 'the user\'s own sleep and mood stay first and untouched')
  assert.ok(!d16.includes('spanok_zdroj'), 'a sleep the user typed is not marked as Garmin')
  assert.ok(d16.includes('- Ráno som bol u zubára.\n\n## Zhrnutie dňa\n\nPokojný deň, večer [[Jana Nováková]].\n'), 'the user\'s text is intact')
  assert.ok(d16.includes('\n## Tréning\n\n- 07:10 Sila, 52 min, tep 112, 310 kcal\n- 17:42 Beh: Večerný beh, 45 min, 8,2 km, tep 148, 520 kcal\n'))
  assert.ok(d16.includes('\nspanok_skore: 64\n') && d16.includes('\nkroky: 9412\n'))

  // An older watch: no sleep, HRV, body battery or readiness for this day.
  assert.equal(note('2026-11-15'), '---\ntep_pokoj: 52\nkroky: 6030\n---\n- Dlhá prechádzka so psom.\n')
})

await test('files are private: folder 0700, cache and state 0600, no token file from a fixture', () => {
  if (process.platform === 'win32') return
  assert.equal(statSync(join(DATA, 'garmin')).mode & 0o777, 0o700)
  for (const f of ['days.json', 'state.json']) assert.equal(statSync(join(DATA, 'garmin', f)).mode & 0o777, 0o600, f)
  assert.deepEqual(readdirSync(join(DATA, 'garmin')).sort(), ['days.json', 'state.json'])
})

await test('running it again changes nothing', () => {
  const before = snapshot()
  const res = sync().json()
  assert.deepEqual(res.changed, [])
  assert.deepEqual(res.created, [])
  assert.deepEqual(snapshot(), before)
})

await test('the HUD reads the new fields (dayStats)', async () => {
  const d = dayStats(await getIndex({ force: true })).find((x) => x.day === '2026-11-17')
  assert.deepEqual({ sleepMin: d.sleepMin, score: d.score, hrv: d.hrv, rhr: d.rhr, bb: d.bb, bbWake: d.bbWake, steps: d.steps, stress: d.stress, readiness: d.readiness, sleepSource: d.sleepSource }, { sleepMin: 432, score: 82, hrv: 62, rhr: 48, bb: 88, bbWake: 85, steps: 2140, stress: 24, readiness: 74, sleepSource: 'garmin' })
})

await test('a value that came from Garmin is updated when Garmin corrects it', () => {
  const res = sync(fixtureFile((f) => ((f.sleep['2026-11-17'].dailySleepDTO.sleepTimeSeconds = 26_400), (f.summary['2026-11-17'].totalSteps = 5200), f))).json()
  assert.deepEqual(res.changed, ['2026-11-17'])
  assert.ok(note('2026-11-17').includes('\nspanok: 7:20\nspanok_zdroj: garmin\n'))
  assert.ok(note('2026-11-17').includes('\nkroky: 5200\n'))
})

await test('a sleep the user says (log_day) is never replaced afterwards', async () => {
  await logDay({ day: '2026-11-17', sleepHours: 6, text: 'Zle som spal, budil ma pes.' })
  assert.ok(!note('2026-11-17').includes('spanok_zdroj'), 'log_day drops the Garmin marker')
  const res = sync().json()
  assert.deepEqual(res.kept, [{ day: '2026-11-16', fields: ['spanok'] }, { day: '2026-11-17', fields: ['spanok'] }])
  const d17 = note('2026-11-17')
  assert.ok(d17.includes('\nspanok: 6\n') && !d17.includes('spanok_zdroj') && d17.includes('- Zle som spal, budil ma pes.'))
  assert.ok(d17.includes('\nkroky: 2140\n'), 'fields the sync still owns keep following Garmin')
  const again = snapshot()
  sync()
  assert.deepEqual(snapshot(), again)
})

await test('a sleep the user edits by hand in the note is kept too, and the marker goes away', () => {
  writeFileSync(join(DAYS, '2026-11-14.md'), '')
  const five = fixtureFile((f) => ((f.sleep['2026-11-14'] = { dailySleepDTO: { sleepTimeSeconds: 28_800, sleepScores: { overall: { value: 90 } } } }), f))
  sync(five, 4)
  assert.ok(note('2026-11-14').includes('spanok: 8:00\nspanok_zdroj: garmin\n'))
  writeFileSync(join(DAYS, '2026-11-14.md'), note('2026-11-14').replace('spanok: 8:00', 'spanok: 7'))
  const res = sync(five, 4).json()
  assert.ok(res.kept.some((k) => k.day === '2026-11-14' && k.fields.includes('spanok')))
  assert.ok(note('2026-11-14').includes('spanok: 7\n') && !note('2026-11-14').includes('spanok_zdroj'))
})

await test('workouts: the user\'s edit of a line stays, a workout deleted in Garmin disappears', () => {
  const file = join(DAYS, '2026-11-16.md')
  writeFileSync(file, note('2026-11-16').replace('- 17:42 Beh: Večerný beh, 45 min, 8,2 km, tep 148, 520 kcal', '- 17:42 Beh s Janou okolo jazera, bolo to super'))
  const res = sync(fixtureFile((f) => ((f.activities = f.activities.filter((a) => a.activityId !== 900001)), f))).json()
  assert.deepEqual(res.changed, ['2026-11-16'])
  const d16 = note('2026-11-16')
  assert.ok(d16.includes('- 17:42 Beh s Janou okolo jazera, bolo to super'))
  assert.ok(!d16.includes('07:10 Sila'))
  assert.equal(d16.match(/17:42/g).length, 1)
})

await test('a failed workout list leaves the workout lines alone', () => {
  const before = note('2026-11-16')
  const res = sync(fixtureFile((f) => ((f.fail = { activities: 'notfound' }), f))).json()
  assert.equal(res.ok, true)
  assert.equal(note('2026-11-16'), before)
})

await test('rate limit: a short one is waited out, a lasting one stops the sync and sets a pause', () => {
  assert.equal(sync(fixtureFile((f) => ((f.fail = { 'sleep:2026-11-17': 'rate' }), f))).json().ok, true)
  const before = snapshot()
  const r = sync(fixtureFile((f) => ((f.fail = { summary: 'ratehard' }), f)))
  assert.equal(r.code, 1)
  assert.equal(r.json().error, 'rate_limited')
  assert.deepEqual(snapshot(), before)
  const state = readState()
  assert.equal(state.lastError.code, 'rate_limited')
  assert.ok(new Date(state.cooldownUntil) > new Date())
  assert.equal(autoPlan({ cfg: {}, now: new Date(), state, cache: { days: {} } }), null, 'no background sync during the pause')
})

await test('an expired login is reported as "log in again"', () => {
  const r = sync(fixtureFile((f) => ((f.fail = { summary: 'auth' }), f)))
  assert.equal(r.json().error, 'needs_login')
  assert.match(r.json().login.mac, /garmin\.mjs login/)
  const state = readState()
  assert.equal(autoPlan({ cfg: {}, now: new Date(), state: { ...state, cooldownUntil: null }, cache: { days: {} }, tokenSavedAt: 0 }), null, 'not retried until the user logs in again')
  assert.ok(autoPlan({ cfg: {}, now: new Date(Date.now() + 4 * 3600_000), state: { ...state, cooldownUntil: null }, cache: { days: {} }, tokenSavedAt: Date.now() + 1000 }), 'retried after a new login')
})

await test('--fixture is refused outside a sandbox', () => {
  const env = { ...process.env }
  delete env.JARVIS_MEMORY_DIR
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'garmin.mjs'), 'sync', '--fixture', FIXTURE_FILE, '--json'], { cwd: REPO, env, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(JSON.parse(r.stdout).message, /JARVIS_MEMORY_DIR/)
})

await nodeTest('mergeDayNote: Windows line ends, a note without a header, the "spánok" spelling', () => {
  const day = { day: '2026-11-17', sleep: { minutes: 432, score: 82 }, steps: 9000, activities: [] }
  const crlf = mergeDayNote('---\r\nnalada: 3\r\n---\r\n- Text.\r\n', day)
  assert.equal(crlf.text, '---\r\nnalada: 3\r\nspanok: 7:12\r\nspanok_zdroj: garmin\r\nspanok_skore: 82\r\nkroky: 9000\r\n---\r\n- Text.\r\n')
  const bare = mergeDayNote('# Utorok\n\nText bez hlavičky.\n', day)
  assert.equal(bare.text, '---\nspanok: 7:12\nspanok_zdroj: garmin\nspanok_skore: 82\nkroky: 9000\n---\n# Utorok\n\nText bez hlavičky.\n')
  const own = mergeDayNote('---\nspánok: 7,5\n---\n', day)
  assert.ok(own.text.startsWith('---\nspánok: 7,5\nspanok_skore: 82\n') && !own.text.includes('spanok:') && own.kept.includes('spanok'))
  const same = mergeDayNote(bare.text, day, bare.written)
  assert.equal(same.text, bare.text)
  assert.deepEqual(same.changed, [])
})

await nodeTest('autoPlan: every 3 hours, and every 20 minutes in the morning until the night arrives', () => {
  const at = (h, m = 0) => new Date(2026, 10, 17, h, m)
  const ago = (now, min) => new Date(now - min * 60_000).toISOString()
  const worn = { days: { '2026-11-16': { sleep: { minutes: 400 } } } }
  const cfg = { alarm: { enabled: true, time: '06:30', prepare: 20 } }
  assert.deepEqual(autoPlan({ cfg, now: at(15), state: {}, cache: worn }), { days: 2, reason: 'interval' })
  assert.equal(autoPlan({ cfg, now: at(15), state: { lastAttempt: ago(at(15), 100) }, cache: { days: { ...worn.days, '2026-11-17': { sleep: { minutes: 432 } } } } }), null)
  assert.deepEqual(autoPlan({ cfg, now: at(18), state: { lastAttempt: ago(at(18), 181) }, cache: worn }), { days: 2, reason: 'interval' })
  // 05:58 = alarm 06:30 minus 20 minutes of preparation minus 12: fresh data before the brief is written
  assert.equal(autoPlan({ cfg, now: at(5, 50), state: { lastAttempt: ago(at(5, 50), 60) }, cache: worn }), null)
  assert.deepEqual(autoPlan({ cfg, now: at(5, 58), state: { lastAttempt: ago(at(5, 58), 60) }, cache: worn }), { days: 2, reason: 'rano' })
  assert.deepEqual(autoPlan({ cfg, now: at(7, 0), state: { lastAttempt: ago(at(7), 21), lastOk: ago(at(7), 21) }, cache: worn }), { days: 1, reason: 'rano' })
  assert.equal(autoPlan({ cfg, now: at(7, 0), state: { lastAttempt: ago(at(7), 10) }, cache: worn }), null)
  assert.equal(autoPlan({ cfg, now: at(7, 0), state: { lastAttempt: ago(at(7), 60) }, cache: { days: {} } }), null, 'no morning chase for someone who does not sleep with the watch')
  assert.equal(autoPlan({ cfg: { garmin: { auto: false } }, now: at(15), state: {}, cache: worn }), null)
})
