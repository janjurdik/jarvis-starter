/**
 * The activity log: what a sample stores (and what it must never store), reading files that were
 * damaged, and turning a day of samples into minutes, sessions and breaks.
 *
 *   node --test test/*.test.mjs
 */
import { TMP } from './setup.mjs'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const A = await import('../hud/server/activity.mjs')
const R = await import('../hud/server/activity-report.mjs')

const CFG = { enabled: true, titles: false, retentionDays: 90, idleMinutes: 5, ignore: [...A.DEFAULT_IGNORE, 'Secret Diary'], ownIgnore: ['Secret Diary'] }
const INDEX = [
  { name: 'Stardew Valley', launcher: 'steam', path: '/Users/x/Library/Application Support/Steam/steamapps/common/Stardew Valley' },
  { name: 'Fortnite', launcher: 'epic', path: 'D:\\Epic Games\\Fortnite', exe: ['FortniteClient-Win64-Shipping.exe'] },
  { name: 'Minecraft', launcher: 'prism', path: '/Users/x/Library/Application Support/PrismLauncher/instances/Vanilla' },
  { name: 'Chess Pro', launcher: 'standalone', path: '/Applications/Chess Pro.app' },
]
const at = (day, hhmm) => {
  const [y, m, d] = day.split('-').map(Number)
  const [h, min, s = 0] = hhmm.split(':').map(Number)
  return Math.floor(new Date(y, m - 1, d, h, min, s).getTime() / 1000)
}
/** Minute samples from `from` for `count` minutes. */
const run = (day, from, count, fields, step = 60) => Array.from({ length: count }, (_, i) => ({ t: at(day, from) + i * step, o: 60, src: 'hud', d: step, st: 'active', idle: 3, ...fields }))

test('activityConfig: safe defaults and defensive parsing', () => {
  const on = A.activityConfig({ configured: true })
  assert.equal(on.enabled, true)
  assert.equal(on.titles, false)
  assert.equal(on.retentionDays, 90)
  assert.equal(on.idleMinutes, 5)
  assert.ok(on.ignore.includes('1Password'))
  // nothing is recorded before the first setup
  assert.deepEqual([A.activityConfig({ configured: false }).enabled, A.activityConfig({ configured: false }).reason], [false, 'setup'])
  assert.equal(A.activityConfig({ configured: true, activity: { enabled: false } }).reason, 'config')
  // garbage in the config never breaks the sampler
  for (const bad of [null, 'yes', 7, [], { enabled: 'no', titles: 'true', retentionDays: -5, ignore: 'x', idleMinutes: 'abc' }, { ignore: [1, null, '', '  Banka  ', {}] }]) {
    const c = A.activityConfig({ configured: true, activity: bad })
    assert.equal(c.enabled, true)
    assert.equal(c.titles, false)
    assert.equal(c.retentionDays, 90)
    assert.equal(c.idleMinutes, 5)
  }
  assert.deepEqual(A.activityConfig({ configured: true, activity: { ignore: [1, null, '', '  Banka  ', {}] } }).ownIgnore, ['Banka'])
  assert.equal(A.activityConfig({ configured: true, activity: { retentionDays: 999999 } }).retentionDays, 3650)
  process.env.JARVIS_ACTIVITY = '0'
  assert.equal(A.activityConfig({ configured: true }).reason, 'env')
  delete process.env.JARVIS_ACTIVITY
})

test('isIgnored: by name, by bundle id, with a version or helper suffix', () => {
  assert.equal(A.isIgnored(CFG.ignore, '1Password'), true)
  assert.equal(A.isIgnored(CFG.ignore, '1Password 7'), true)
  assert.equal(A.isIgnored(CFG.ignore, 'Anything', 'com.bitwarden.desktop'), false)
  assert.equal(A.isIgnored(CFG.ignore, 'Anything', 'com.8bit.bitwarden'), true)
  assert.equal(A.isIgnored(CFG.ignore, 'Kľúčenka'), true)
  assert.equal(A.isIgnored(CFG.ignore, 'KLUCENKA'), true)
  assert.equal(A.isIgnored(CFG.ignore, 'secret diary.exe'), true)
  assert.equal(A.isIgnored(CFG.ignore, 'Google Chrome', 'com.google.Chrome'), false)
  assert.equal(A.isIgnored(CFG.ignore, null, null), false)
})

test('buildRecord: what is stored and what never is', () => {
  const now = Date.parse('2026-11-17T10:00:00Z')
  const base = { app: 'Google Chrome', id: 'com.google.Chrome', path: '/Applications/Google Chrome.app', exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', pid: 1, idle: 4, locked: false, media: false, title: 'My bank account - Chrome' }
  const rec = A.buildRecord(base, CFG, { now, index: INDEX })
  assert.deepEqual(rec, { t: Math.round(now / 1000), o: 60, src: 'hud', d: 60, st: 'active', idle: 4, app: 'Google Chrome', id: 'com.google.Chrome' })
  // no path, no pid, and no title unless the user turned titles on
  assert.equal(JSON.stringify(rec).includes('bank'), false)
  assert.equal(A.buildRecord(base, { ...CFG, titles: true }, { now, index: INDEX }).title, 'My bank account - Chrome')

  // an app from the ignore list leaves no name, id or title, even with titles on
  const priv = A.buildRecord({ ...base, app: '1Password 7', id: 'com.agilebits.onepassword7', title: 'Vault' }, { ...CFG, titles: true }, { now, index: INDEX })
  assert.deepEqual(priv, { t: rec.t, o: 60, src: 'hud', d: 60, st: 'active', idle: 4, priv: 1 })

  // locked: nothing about the app
  assert.deepEqual(A.buildRecord({ ...base, locked: true, idle: 900 }, CFG, { now, index: INDEX }), { t: rec.t, o: 60, src: 'hud', d: 60, st: 'locked', idle: 900 })
  // no input for longer than the limit: away, the app in front is not stored
  assert.deepEqual(A.buildRecord({ ...base, idle: 301 }, CFG, { now, index: INDEX }), { t: rec.t, o: 60, src: 'hud', d: 60, st: 'idle', idle: 301 })
  // ...unless a film or a call keeps the display awake
  assert.equal(A.buildRecord({ ...base, idle: 1500, media: true }, CFG, { now, index: INDEX }).st, 'passive')
  assert.equal(A.buildRecord({ ...base, idle: 5 * 3600, media: true }, CFG, { now, index: INDEX }).st, 'idle')
  // the pulse marks its samples and how long they stand for
  const pulse = A.buildRecord(base, CFG, { now, index: INDEX, source: 'pulse', every: 300 })
  assert.deepEqual([pulse.src, pulse.d], ['pulse', 300])
  assert.equal(A.buildRecord(base, CFG, { now, index: INDEX, every: 99999 }).d, 1800)
  // control characters and very long names cannot break the one-line format
  const odd = A.buildRecord({ ...base, app: `Evil\n"App"\u0000${'x'.repeat(500)}` }, CFG, { now, index: INDEX })
  assert.equal(JSON.stringify(odd).split('\n').length, 1)
  assert.ok(odd.app.length <= 80)
})

test('holdsDisplayAwake: a film or a call counts, a keep-awake tool does not', () => {
  const head = 'Assertion status system-wide:\n   PreventUserIdleDisplaySleep    1\n   PreventUserIdleSystemSleep     1\nListed by owning process:\n'
  const chrome = '   pid 20598(Google Chrome): [0x0000ac7900059d14] 00:00:03 NoDisplaySleepAssertion named: "Video Wake Lock"\n'
  const powerd = '   pid 360(powerd): [0x00009d7800019c6b] 01:04:05 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on"\n'
  const electron = '   pid 878(Claude): [0x0000002700018183] 25:27:29 NoIdleSleepAssertion named: "Electron"\n'
  const caffeinate = '   pid 999(caffeinate): [0x1] 00:10:00 PreventUserIdleDisplaySleep named: "caffeinate command-line tool"\n'
  assert.equal(A.holdsDisplayAwake(head + chrome + powerd + electron), true)
  assert.equal(A.holdsDisplayAwake(head + powerd + electron), false)
  assert.equal(A.holdsDisplayAwake(head + caffeinate + powerd), false)
  assert.equal(A.holdsDisplayAwake(head + caffeinate + chrome), true)
  // no per-process list at all: fall back to the summary line
  assert.equal(A.holdsDisplayAwake('   PreventUserIdleDisplaySleep    1\n'), true)
  assert.equal(A.holdsDisplayAwake('   PreventUserIdleDisplaySleep    0\n'), false)
  assert.equal(A.holdsDisplayAwake(''), false)
  assert.equal(A.holdsDisplayAwake(null), false)
})

test('matchGame: by folder, by executable, by name, Minecraft only through its own signal', () => {
  const g = (p) => A.matchGame(p, INDEX)
  assert.equal(g({ app: 'StardewValley', path: null, exe: '/Users/x/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS/StardewValley' }), 'Stardew Valley')
  assert.equal(g({ app: 'Unreal', path: 'd:\\epic games\\fortnite\\FortniteGame\\Binaries\\Win64', exe: 'd:\\epic games\\fortnite\\FortniteGame\\Binaries\\Win64\\x.exe' }), 'Fortnite')
  assert.equal(g({ app: 'Whatever', exe: 'C:\\Other\\FortniteClient-Win64-Shipping.exe' }), 'Fortnite')
  assert.equal(g({ app: 'Chess Pro', path: '/Applications/Chess Pro.app' }), 'Chess Pro')
  assert.equal(g({ app: 'VALORANT-Win64-Shipping', id: 'VALORANT-Win64-Shipping' }), 'VALORANT')
  assert.equal(g({ app: 'League of Legends' }), 'League of Legends')
  assert.equal(g({ app: 'java', exe: '/usr/bin/java' }), null)
  assert.equal(g({ app: 'java', exe: '/usr/bin/java', minecraft: true }), 'Minecraft')
  assert.equal(g({ app: 'Google Chrome', path: '/Applications/Google Chrome.app' }), null)
  assert.equal(g({ app: 'Steamy', path: '/Users/x/Library/Application Support/Steam/steamapps/common/Stardew Valley Extra' }), null)
  assert.equal(g(null), null)
  // a game keeps the user present without keyboard input (a controller)
  const rec = A.buildRecord({ app: 'StardewValley', exe: '/Users/x/Library/Application Support/Steam/steamapps/common/Stardew Valley/x', idle: 900, locked: false }, CFG, { index: INDEX })
  assert.deepEqual([rec.st, rec.game], ['passive', 'Stardew Valley'])
})

test('appendRecord and readRecords: one file per day, 0600, duplicates skipped, damaged lines survived', () => {
  const day = '2026-11-10'
  const t0 = at(day, '09:00')
  assert.equal(A.appendRecord({ t: t0, o: 60, src: 'hud', d: 60, st: 'active', idle: 1, app: 'Code' }), true)
  // the same moment again (scheduler fired twice)
  assert.equal(A.appendRecord({ t: t0 + 5, o: 60, src: 'hud', d: 60, st: 'active', idle: 1, app: 'Code' }), false)
  // the pulse stays out while the HUD is sampling
  assert.equal(A.appendRecord({ t: t0 + 60, o: 60, src: 'pulse', d: 300, st: 'active', idle: 1, app: 'Code' }), false)
  assert.equal(A.appendRecord({ t: t0 + 60, o: 60, src: 'hud', d: 60, st: 'active', idle: 1, app: 'Code' }), true)
  // HUD gone for a while: now the pulse writes
  assert.equal(A.appendRecord({ t: t0 + 400, o: 60, src: 'pulse', d: 300, st: 'active', idle: 1, app: 'Safari' }), true)
  const file = A.dayFile(day)
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(A.ACTIVITY_DIR).mode & 0o777, 0o700)
  }
  // damage: garbage, a cut-off line glued to a good one, a wrong type, a duplicate, an empty line
  appendFileSync(file, 'not json at all\n{"t":17630,"o":60,"src":"hu{"t":' + (t0 + 700) + ',"o":60,"src":"pulse","d":300,"st":"idle","idle":400}\n[1,2,3]\n{"t":"soon"}\n\n' + JSON.stringify({ t: t0, o: 60, src: 'hud', d: 60, st: 'active', idle: 1, app: 'Code' }) + '\n{"t":' + (t0 + 900))
  const recs = A.readRecords(day)
  assert.deepEqual(recs.map((r) => r.t - t0), [0, 60, 400, 700])
  // the last complete line wins, here the repeated first record
  assert.equal(A.lastRecord(file).t, t0)
  assert.deepEqual(A.readRecords('1999-01-01'), [])
  assert.equal(A.lastRecord(join(TMP, 'nope.jsonl')), null)
})

test('prune removes only days older than the retention, purge removes what it is told', () => {
  const today = '2026-11-17'
  mkdirSync(A.ACTIVITY_DIR, { recursive: true })
  for (const day of ['2026-01-01', '2026-08-18', '2026-08-20', '2026-11-16']) writeFileSync(A.dayFile(day), '{"t":1,"src":"hud"}\n')
  writeFileSync(join(A.ACTIVITY_DIR, 'notes.txt'), 'not mine')
  const removed = A.prune({ ...CFG, retentionDays: 90 }, new Date(2026, 10, 17, 12))
  assert.equal(removed, 2)
  assert.equal(existsSync(A.dayFile('2026-01-01')), false)
  assert.equal(existsSync(A.dayFile('2026-08-18')), false)
  assert.equal(existsSync(A.dayFile('2026-08-20')), true)
  assert.equal(existsSync(join(A.ACTIVITY_DIR, 'notes.txt')), true)
  // once a day is enough
  writeFileSync(A.dayFile('2025-01-01'), '{"t":1}\n')
  assert.equal(A.prune({ ...CFG, retentionDays: 90 }, new Date(2026, 10, 17, 13)), 0)
  assert.deepEqual(A.purge({ day: '2026-08-20' }), ['2026-08-20'])
  assert.deepEqual(A.purge({ before: '2026-01-01' }), ['2025-01-01'])
  assert.ok(A.purge({ all: true }).includes('2026-11-16'))
  assert.deepEqual(A.activityDays(), [])
  assert.equal(existsSync(join(A.ACTIVITY_DIR, 'notes.txt')), true)
  assert.equal(today.length, 10)
})

test('setActivityEnabled writes only the activity block and keeps the rest of the config', () => {
  assert.deepEqual(A.setActivityEnabled(false), { ok: true, enabled: false })
  const raw = JSON.parse(readFileSync(process.env.JARVIS_CONFIG, 'utf8'))
  assert.deepEqual(raw, { name: 'Test', activity: { ignore: ['Secret Diary'], enabled: false } })
  assert.equal(A.activityConfig().reason, 'config')
  assert.deepEqual(A.setActivityEnabled(true), { ok: true, enabled: true })
  assert.equal(A.activityConfig().enabled, true)
})

test('categoryOf: known apps, process names, games, unknown', () => {
  const c = (app, id, game) => R.categoryOf({ app, id, game })
  assert.equal(c('Visual Studio Code', 'com.microsoft.VSCode'), 'dev')
  assert.equal(c('Code', 'Code'), 'dev')
  assert.equal(c('Terminal', 'com.apple.Terminal'), 'dev')
  assert.equal(c('Google Chrome', 'com.google.Chrome'), 'browsing')
  assert.equal(c('msedge', 'msedge'), 'browsing')
  assert.equal(c('Discord', 'com.hnc.Discord'), 'communication')
  assert.equal(c('Microsoft Teams (work or school)', 'ms-teams'), 'communication')
  assert.equal(c('Spotify', 'com.spotify.client'), 'media')
  assert.equal(c('Adobe Photoshop 2025', 'com.adobe.Photoshop'), 'creative')
  assert.equal(c('Microsoft Word', 'WINWORD'), 'work')
  assert.equal(c('Obsidian', 'md.obsidian'), 'work')
  assert.equal(c('Finder', 'com.apple.finder'), 'system')
  assert.equal(c('VALORANT-Win64-Shipping', 'VALORANT-Win64-Shipping', 'VALORANT'), 'games')
  assert.equal(c('Steam', 'com.valvesoftware.steam'), 'games')
  assert.equal(c('Totally Unknown Thing', 'org.example.unknown'), 'other')
  assert.equal(c('', ''), 'other')
})

test('aggregate: minutes per app, categories, sessions with a short detour, games', () => {
  const day = '2026-11-12'
  const recs = [
    ...run(day, '09:00', 60, { app: 'Code', id: 'com.microsoft.VSCode' }),
    ...run(day, '10:00', 1, { app: 'Slack', id: 'com.tinyspeck.slackmacgap' }),
    ...run(day, '10:01', 29, { app: 'Code', id: 'com.microsoft.VSCode' }),
    ...run(day, '10:30', 30, { app: 'Google Chrome', id: 'com.google.Chrome' }),
    ...run(day, '20:00', 90, { app: 'VALORANT-Win64-Shipping', game: 'VALORANT' }),
  ]
  const r = R.aggregate(recs, { day, cfg: CFG, now: Date.parse('2026-11-13T12:00:00') })
  assert.equal(r.samples, 210)
  assert.deepEqual(r.totals, { activeMin: 210, passiveMin: 0, idleMin: 0, lockedMin: 0, privateMin: 0, estimatedMin: 0, noDataMin: 540 })
  assert.deepEqual(r.apps.map((a) => [a.app, a.category, a.minutes]), [['VALORANT', 'games', 90], ['Code', 'dev', 89], ['Google Chrome', 'browsing', 30], ['Slack', 'communication', 1]])
  assert.deepEqual(r.categories.map((c) => [c.category, c.minutes]), [['games', 90], ['dev', 89], ['browsing', 30], ['communication', 1]])
  assert.deepEqual(r.games, [{ game: 'VALORANT', minutes: 90 }])
  // the one-minute look at Slack does not split the coding session
  assert.deepEqual(r.sessions.map((s) => [s.from, s.to, s.app, s.minutes]), [['09:00', '10:30', 'Code', 89], ['10:30', '11:00', 'Google Chrome', 30], ['20:00', '21:30', 'VALORANT', 90]])
  assert.deepEqual([r.first, r.last], ['09:00', '21:30'])
  assert.deepEqual(r.gaps, [{ from: '11:00', to: '20:00', minutes: 540, kind: 'no-data' }])
  assert.match(R.summaryText({ ...r, notes: [] }), /VALORANT 1 h 30 min/)
})

test('aggregate: idle is cut back to the last input, locked and private time are kept apart', () => {
  const day = '2026-11-12'
  const t = at(day, '14:00')
  const recs = [
    ...run(day, '14:00', 10, { app: 'Pages' }),
    // input stopped at 14:10:00; the samples up to 14:14 still looked active (idle below five minutes)
    ...[1, 2, 3, 4, 5].map((i) => ({ t: t + 600 + (i - 1) * 60, o: 60, src: 'hud', d: 60, st: 'active', idle: (i - 1) * 60, app: 'Pages' })),
    ...[0, 1, 2, 3, 4].map((i) => ({ t: t + 900 + i * 60, o: 60, src: 'hud', d: 60, st: 'idle', idle: 300 + i * 60 })),
    ...run(day, '14:20', 10, { st: 'locked', idle: 900 }).map(({ app, ...r }) => r),
    ...run(day, '14:30', 5, { priv: 1 }),
    ...run(day, '14:35', 5, { app: 'Secret Diary' }),
    ...run(day, '14:40', 20, { app: 'Netflix', st: 'passive', idle: 1200 }),
  ]
  const r = R.aggregate(recs, { day, cfg: CFG, now: Date.parse('2026-11-13T12:00:00') })
  // 10 minutes of Pages, not 15: the last five were already without input
  assert.equal(r.apps.find((a) => a.app === 'Pages').minutes, 10)
  assert.equal(r.totals.idleMin, 10)
  assert.equal(r.totals.lockedMin, 10)
  assert.equal(r.totals.passiveMin, 20)
  // both the stored "priv" samples and the app added to the ignore list later count as private
  assert.equal(r.totals.privateMin, 10)
  assert.equal(r.totals.activeMin, 20)
  assert.equal(JSON.stringify(r).includes('Secret Diary'), false)
  assert.deepEqual(r.apps.map((a) => a.app), ['Netflix', 'Pages'])
  assert.equal(r.apps[0].passiveMin, 20)
  assert.deepEqual(r.gaps.map((g) => [g.from, g.to, g.kind]), [['14:10', '14:20', 'idle'], ['14:20', '14:30', 'locked']])
})

test('aggregate: pulse samples fill in when the HUD is off and are marked as estimates', () => {
  const day = '2026-11-12'
  const recs = [
    ...run(day, '08:00', 12, { app: 'Mail', src: 'pulse', d: 300 }, 300),
    // HUD started at 09:00: both write for a while, nothing is counted twice
    ...run(day, '09:00', 30, { app: 'Mail' }),
    ...run(day, '09:02', 6, { app: 'Mail', src: 'pulse', d: 300 }, 300),
    // one lonely pulse sample before the computer went to sleep
    { t: at(day, '12:00'), o: 60, src: 'pulse', d: 300, st: 'active', idle: 2, app: 'Mail' },
  ]
  const r = R.aggregate(recs, { day, cfg: CFG, now: Date.parse('2026-11-13T12:00:00') })
  assert.equal(r.apps[0].minutes, 60 + 30 + 5)
  assert.equal(r.totals.activeMin, 95)
  assert.ok(r.totals.estimatedMin >= 65 && r.totals.estimatedMin <= 72, `estimated ${r.totals.estimatedMin}`)
  assert.equal(r.sessions[0].estimated, true)
  assert.deepEqual(r.sources, { hud: 30, pulse: 19 })
})

test('aggregate: clock changes, out-of-order and future samples, the running minute of today', () => {
  const day = '2026-11-12'
  const good = run(day, '10:00', 10, { app: 'Notes' })
  const shuffled = [...good].reverse()
  // the clock jumped back five minutes and the same stretch was sampled again
  const again = run(day, '10:05', 5, { app: 'Notes' }).map((r) => ({ ...r, t: r.t + 1 }))
  const r = R.aggregate([...shuffled, ...again, { t: at('2026-11-13', '09:00'), src: 'hud', d: 60, st: 'active', app: 'Tomorrow' }, { t: -5 }, null, { t: 'x' }], { day, cfg: CFG, now: Date.parse('2026-11-13T12:00:00') })
  assert.equal(r.apps.length, 1)
  assert.equal(r.apps[0].minutes, 10)
  // "now" in the middle of a sample: the future is not counted
  const live = R.aggregate(run(day, '10:00', 3, { app: 'Notes' }), { day, cfg: CFG, now: (at(day, '10:02') + 20) * 1000 })
  assert.equal(live.to, '10:02')
  assert.equal(Math.round(live.totals.activeMin), 2)
  // an empty day
  const empty = R.aggregate([], { day, cfg: CFG })
  assert.deepEqual([empty.samples, empty.first, empty.apps.length, empty.totals.activeMin], [0, null, 0, 0])
})

test('aggregate: a 25 hour and a 23 hour day (daylight saving) add up', () => {
  for (const [day, hours] of [['2026-10-25', 25], ['2026-03-29', 23]]) {
    const start = Math.floor(new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8)), 0, 0, 0).getTime() / 1000)
    const recs = Array.from({ length: hours * 60 }, (_, i) => ({ t: start + i * 60, o: 60, src: 'hud', d: 60, st: 'active', idle: 1, app: 'Clock' }))
    const r = R.aggregate(recs, { day, cfg: CFG, now: Date.parse('2027-01-01') })
    assert.equal(r.totals.activeMin, hours * 60, day)
    assert.equal(r.apps[0].minutes, hours * 60)
    assert.equal(r.totals.noDataMin, 0)
  }
})

test('dayReport: the signals of the day come from local files and say what they cannot know', async () => {
  const day = '2026-11-11'
  const data = process.env.JARVIS_DATA_DIR
  const memory = process.env.JARVIS_MEMORY_DIR
  // a git project with two commits that day, one the day before and one pull
  const repo = join(TMP, 'code', 'my-web')
  mkdirSync(join(repo, '.git', 'logs'), { recursive: true })
  const line = (hhmm, d, what) => `${'a'.repeat(40)} ${'b'.repeat(40)} Test User <test@example.com> ${at(d, hhmm)} +0100\t${what}\n`
  writeFileSync(join(repo, '.git', 'logs', 'HEAD'), line('09:00', '2026-11-10', 'commit: old work') + line('10:00', day, 'commit: add login form') + line('11:00', day, 'pull: Fast-forward') + line('12:00', day, 'commit (amend): add login form') + line('15:00', day, 'commit: fix typo'))
  mkdirSync(join(data, 'scan'), { recursive: true })
  writeFileSync(join(data, 'scan', 'scan.json'), JSON.stringify({ findings: [{ id: 'code.repos', data: { repos: [{ path: repo }, { path: join(TMP, 'gone') }] } }] }))
  // the conversation with Jarvis, a finished job, a routine result, a fired reminder, an open deadline
  mkdirSync(join(data, 'chat'), { recursive: true })
  writeFileSync(join(data, 'chat', `${day}.jsonl`), [{ at: `${day}T08:00:00.000Z`, user: 'a', jarvis: 'b', tools: ['mcp__memory__complete_todo', 'mcp__memory__view_todo'] }, { at: `${day}T09:00:00.000Z`, user: 'c', jarvis: 'd', tools: [] }].map((x) => JSON.stringify(x)).join('\n') + '\n')
  mkdirSync(join(data, 'brain'), { recursive: true })
  writeFileSync(join(data, 'brain', 'jobs.json'), JSON.stringify({ jobs: [{ id: 'j1', title: 'Ponuka', status: 'done', endedAt: new Date(at(day, '13:00') * 1000).toISOString() }, { id: 'j2', title: 'Mock', status: 'done', mock: true, endedAt: new Date(at(day, '13:00') * 1000).toISOString() }, { id: 'j3', title: 'Old', status: 'done', endedAt: '2026-11-01T10:00:00.000Z' }] }))
  mkdirSync(join(memory, 'schranka'), { recursive: true })
  writeFileSync(join(memory, 'schranka', `${day}-ranny-brief.md`), '# brief')
  writeFileSync(join(memory, 'pripomienky.md'), `# Pripomienky\n\n- [x] ${day} 15:00 Zavolať mame\n- [ ] ${day} 18:00 Nákup\n- [x] 2026-11-01 09:00 Staré\n`)
  writeFileSync(join(memory, 'ulohy.md'), `# Úlohy\n- [ ] Poslať faktúru (do ${day})\n- [x] Hotové\n- [ ] Bez termínu\n`)
  mkdirSync(A.ACTIVITY_DIR, { recursive: true })
  writeFileSync(A.dayFile(day), run(day, '09:00', 30, { app: 'Code' }).map((r) => JSON.stringify(r)).join('\n') + '\n')

  const r = await R.dayReport(day, { signals: 'light', now: Date.parse('2026-11-12T12:00:00') })
  assert.equal(r.ok, true)
  assert.equal(r.apps[0].minutes, 30)
  assert.deepEqual(r.signals.git.repos, [{ repo: 'my-web', commits: 2, subjects: ['add login form', 'fix typo'] }])
  assert.equal(r.signals.git.commits, 2)
  assert.equal(r.signals.files, undefined)
  assert.deepEqual(r.signals.jarvis, { chatTurns: 2, jobs: [{ title: 'Ponuka', status: 'done' }], routines: ['ranny-brief'] })
  assert.equal(r.signals.todos.completedViaJarvis, 1)
  assert.deepEqual(r.signals.todos.remindersFired, ['Zavolať mame'])
  assert.deepEqual(r.signals.todos.openDueByToday, [`Poslať faktúru (do ${day})`])
  assert.match(r.signals.todos.note, /neuchováva dátum dokončenia/)
  assert.match(r.summary, /Code 30 min/)
  assert.match(r.summary, /my-web 2/)

  // a day with no log says so instead of inventing one
  const none = await R.dayReport('2026-11-09', { signals: 'none' })
  assert.equal(none.samples, 0)
  assert.match(none.summary, /žiadna vzorka/)
})
