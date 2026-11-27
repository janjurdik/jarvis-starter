/**
 * The alarm on the screen: the offered songs (hud/server/alarm-sound.mjs), the alarm card in the
 * conversation (alarm-card.mjs), the ringing state the screen stops (alarm.mjs) and the alarm
 * script that listens for that stop (scripts/alarm.mjs). No song is downloaded, no sound is
 * played and nothing is registered in the system scheduler.
 */
import { TMP } from './setup.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { join } from 'node:path'
import { after, test } from 'node:test'

const REPO = join(import.meta.dirname, '..')
const DATA = process.env.JARVIS_DATA_DIR
const CONFIG = process.env.JARVIS_CONFIG
const ALARM_DIR = join(DATA, 'alarm')
process.env.JARVIS_AUDIO = 'off'
// The card tells the brain what was chosen (a hidden turn, the stand-in brain here): it must not start a voice.
process.env.JARVIS_TTS = 'off'

const { SONGS, resolveSound, songList, songOf, songPreview, soundSummary } = await import('../hud/server/alarm-sound.mjs')
const { endRinging, ringStopped, ringingNow, startRinging, stopRinging } = await import('../hud/server/alarm.mjs')
const { alarmCard, alarmCardStep, brainAlarmCard, readTime, setAlarmCardRunners } = await import('../hud/server/alarm-card.mjs')
const { findCard } = await import('../hud/server/chat.mjs')

// The voice helper the stand-in brain may have started keeps the process alive: it ends with the tests.
after(async () => (await import('../hud/server/tts.mjs')).stopTts())

const config = (alarm) => writeFileSync(CONFIG, JSON.stringify({ name: 'Test', address: 'pane', formal: true, ...(alarm ? { alarm } : {}) }))
const song = (name) => writeFileSync(join(ALARM_DIR, name), Buffer.alloc(4000, 1))
const clearSounds = () => {
  rmSync(ALARM_DIR, { recursive: true, force: true })
  mkdirSync(ALARM_DIR, { recursive: true })
}

test('two songs are offered, the first one is the default it always was', () => {
  assert.deepEqual(SONGS.map((s) => [s.id, s.title, s.file]), [['highway', 'Highway to Hell', 'sound-default.mp3'], ['stay', 'Should I Stay or Should I Go', 'sound-stay.mp3']])
  for (const s of SONGS) assert.match(s.url, /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/)
  assert.equal(songOf('default'), SONGS[0])
  assert.equal(songOf('Stay'), SONGS[1])
  assert.equal(songOf('should i stay or should i go'), SONGS[1])
  assert.equal(songOf('builtin'), null)
  assert.equal(songOf(''), null)
})

test('the chosen song rings, and a song that is not on the disk falls back instead of silence', () => {
  clearSounds()
  config({ time: '06:30', days: 'daily', enabled: true, sound: 'stay' })
  // nothing downloaded yet: the chime
  assert.equal(resolveSound().kind, 'builtin')
  assert.deepEqual(songList().map((s) => [s.id, s.ready, s.selected]), [['highway', false, false], ['stay', false, false]])
  assert.equal(songPreview('stay'), null)
  // only the default song is there: it rings instead of the chosen one
  song('sound-default.mp3')
  assert.equal(resolveSound().kind, 'default')
  assert.equal(resolveSound().song, 'highway')
  // the chosen one arrives
  song('sound-stay.mp3')
  const now = resolveSound()
  assert.deepEqual([now.kind, now.song, now.title, now.play], ['song', 'stay', 'Should I Stay or Should I Go', join(ALARM_DIR, 'sound-stay.mp3')])
  assert.match(soundSummary(now), /pesnička Should I Stay or Should I Go, hrá 45 sekúnd/)
  assert.deepEqual(songList().map((s) => [s.id, s.ready, s.selected]), [['highway', true, false], ['stay', true, true]])
  // its prepared clip is what really plays, also for the short listen in the card
  song('ring-sound-stay-45s.mp3')
  assert.equal(resolveSound().play, join(ALARM_DIR, 'ring-sound-stay-45s.mp3'))
  assert.equal(songPreview('stay').play, join(ALARM_DIR, 'ring-sound-stay-45s.mp3'))
  assert.equal(songPreview('nothing'), null)
  // "highway" by its own id is the default song, a custom file still wins when it is chosen
  config({ time: '06:30', sound: 'highway' })
  assert.equal(resolveSound().song, 'highway')
  song('sound-custom.mp3')
  config({ time: '06:30', sound: 'sound-custom.mp3' })
  assert.equal(resolveSound().kind, 'custom')
  assert.deepEqual(songList().map((s) => s.selected), [false, false])
})

test('ringing: the screen can stop it once, a leftover of a crash does not ring for ever', () => {
  const at = new Date('2026-11-28T06:30:00')
  assert.equal(ringingNow(at), null)
  const ring = startRinging({ seconds: 45, time: '06:30', greeting: 'Dobré ráno, pane', sound: 'Highway to Hell', formal: true }, at)
  assert.match(ring.id, /^ring-/)
  assert.deepEqual([ring.seconds, ring.time, ring.greeting, ring.sound, ring.formal, ring.test], [45, '06:30', 'Dobré ráno, pane', 'Highway to Hell', true, false])
  assert.equal(ringingNow(new Date(at.getTime() + 20_000)).id, ring.id)
  assert.equal(ringStopped(ring.id), false)
  // another ring's id stops nothing
  assert.equal(stopRinging('ring-other', new Date(at.getTime() + 21_000)), null)
  assert.equal(ringStopped(ring.id), false)
  const stopped = stopRinging(ring.id, new Date(at.getTime() + 22_000))
  assert.equal(stopped.id, ring.id)
  assert.equal(ringStopped(ring.id), true)
  // stopped: nothing rings any more, a second stop is nothing
  assert.equal(ringingNow(new Date(at.getTime() + 23_000)), null)
  assert.equal(stopRinging(null, new Date(at.getTime() + 23_000)), null)
  endRinging(ring.id)
  assert.equal(ringStopped(ring.id), false)
  // a ring whose script died is over a moment after its sound would have ended
  const dead = startRinging({ seconds: 45 }, at)
  assert.equal(ringingNow(new Date(at.getTime() + 59_000)).id, dead.id)
  assert.equal(ringingNow(new Date(at.getTime() + 61_000)), null)
  // ending another ring leaves this one alone
  endRinging('ring-other')
  assert.equal(existsSync(join(ALARM_DIR, 'ringing.json')), true)
  endRinging(dead.id)
  assert.equal(existsSync(join(ALARM_DIR, 'ringing.json')), false)
})

test('alarm card: the shape, what is preselected and how a time is read', () => {
  clearSounds()
  config(null)
  assert.equal(readTime('6:30'), '06:30')
  assert.equal(readTime('06.05'), '06:05')
  assert.equal(readTime('24:00'), null)
  assert.equal(readTime('šesť'), null)
  const fresh = alarmCard()
  assert.deepEqual([fresh.kind, fresh.state, fresh.time, fresh.days, fresh.daysText, fresh.song, fresh.own], ['alarm', 'form', '07:00', 'daily', 'každý deň', 'highway', null])
  assert.deepEqual(fresh.songs, [{ id: 'highway', title: 'Highway to Hell', artist: 'AC/DC', ready: false }, { id: 'stay', title: 'Should I Stay or Should I Go', artist: 'The Clash', ready: false }])
  assert.match(fresh.ask, /vás mám zobudiť/)
  // what the brain already heard is filled in, nonsense is not
  const told = alarmCard({ time: '6:15', days: 'weekdays' })
  assert.deepEqual([told.time, told.days, told.daysText], ['06:15', 'weekdays', 'v pracovné dni'])
  assert.deepEqual([alarmCard({ time: 'ráno', days: 'niekedy' }).time, alarmCard({ time: 'ráno', days: 'niekedy' }).days], ['07:00', 'daily'])
  // the alarm that exists and the song that rings now
  song('sound-default.mp3')
  song('sound-stay.mp3')
  config({ time: '05:50', days: 'weekend', enabled: true, sound: 'stay' })
  const set = alarmCard()
  assert.deepEqual([set.time, set.days, set.song], ['05:50', 'weekend', 'stay'])
  assert.deepEqual(set.songs.map((s) => s.ready), [true, true])
  // his own sound is left alone until he clicks one of the offered songs; informal address
  song('sound-custom.mp3')
  writeFileSync(CONFIG, JSON.stringify({ name: 'Test', formal: false, alarm: { time: '05:50', sound: 'sound-custom.mp3' } }))
  const own = alarmCard()
  assert.deepEqual([own.song, own.own], [null, 'sound-custom.mp3'])
  assert.match(own.ask, /ťa mám zobudiť/)
  assert.match(own.note, /tvoj zvuk sound-custom\.mp3/)
})

test('alarm card: he clicks a song and confirms, the alarm and the song are set once', async (t) => {
  clearSounds()
  config(null)
  const calls = []
  t.after(
    setAlarmCardRunners({
      alarm: async (args) => (calls.push(['alarm', ...args]), { ok: true, registered: true, alarm: { time: args[1] }, summary: 'Budík: 06:45 v pracovné dni.' }),
      sound: async (id) => (calls.push(['sound', id]), { ok: true, kind: 'song' }),
    }),
  )
  const shown = brainAlarmCard({ time: '6:45', days: 'weekdays' })
  assert.equal(shown.ok, true)
  assert.match(shown.text, /klikom vyberie skladbu/)
  const id = shown.card
  assert.equal(findCard(id).card.kind, 'alarm')

  // a short listen of a song that is not downloaded says so and changes nothing
  const listen = await alarmCardStep({ card: id, step: 'preview', song: 'stay' })
  assert.equal(listen.body.playing, null)
  assert.match(listen.body.error, /ešte nemám stiahnutú/)
  // on the disk it "plays" (muted in tests), the same song again stops it
  song('sound-stay.mp3')
  assert.deepEqual([(await alarmCardStep({ card: id, step: 'preview', song: 'stay' })).body.playing, (await alarmCardStep({ card: id, step: 'preview', song: 'stay' })).body.playing], ['stay', null])

  // a bad time or an unknown song never reaches the script
  assert.match((await alarmCardStep({ card: id, step: 'set', time: '25:00', song: 'stay' })).body.card.message, /06:30/)
  assert.match((await alarmCardStep({ card: id, step: 'set', time: '06:45', song: 'smoke-on-the-water' })).body.card.message, /Vyberte skladbu/)
  assert.match((await alarmCardStep({ card: id, step: 'set', time: '06:45', song: null })).body.card.message, /Vyberte skladbu/)
  assert.equal((await alarmCardStep({ card: id, step: 'nieco' })).status, 400)
  assert.deepEqual(calls, [])

  const done = await alarmCardStep({ card: id, step: 'set', time: '6:45', song: 'stay' })
  assert.equal(done.changed, true)
  assert.deepEqual([done.body.card.state, done.body.card.time, done.body.card.song, done.body.card.accent], ['done', '06:45', 'stay', 'ice'])
  assert.equal(done.body.card.message, 'Budík je nastavený na 06:45, v pracovné dni. Zobudí vás Should I Stay or Should I Go.')
  // the song first, then the time with the days the brain passed
  assert.deepEqual(calls, [['sound', 'stay'], ['alarm', 'set', '06:45', '--days', 'weekdays']])
  // a closed card takes nothing more
  assert.equal((await alarmCardStep({ card: id, step: 'set', time: '07:00', song: 'highway' })).status, 410)
  assert.equal((await alarmCardStep({ card: 'alarm-nothing', step: 'set' })).status, 404)
  assert.equal(calls.length, 2)
})

test('alarm card: a song that cannot be downloaded does not cost him the alarm, cancel changes nothing', async (t) => {
  clearSounds()
  song('sound-default.mp3')
  config(null)
  const calls = []
  t.after(
    setAlarmCardRunners({
      alarm: async (args) => (calls.push(args.join(' ')), { ok: false, registered: false, problem: '✗ launchd', alarm: { time: args[1] }, summary: 'Budík: 07:10 každý deň.' }),
      sound: async () => {
        throw new Error('Video sa nepodarilo stiahnuť.')
      },
    }),
  )
  const id = brainAlarmCard({ time: '07:10' }).card
  const done = await alarmCardStep({ card: id, step: 'set', time: '07:10', song: 'stay' })
  assert.deepEqual([done.body.card.state, done.body.card.accent], ['done', 'amber'])
  assert.match(done.body.card.message, /^Budík je nastavený na 07:10, každý deň\. Skladbu Should I Stay or Should I Go sa nepodarilo stiahnuť, zatiaľ zvoní .+\. Do systému sa ho zatiaľ nepodarilo zapísať\.$/)
  assert.deepEqual(calls, ['set 07:10 --days daily'])

  const other = brainAlarmCard({}).card
  const closed = await alarmCardStep({ card: other, step: 'cancel' })
  assert.deepEqual([closed.body.card.state, closed.body.card.message], ['closed', 'Budík ostáva, ako bol.'])
  assert.equal(calls.length, 1)
})

test('alarm script: stopped on the screen it goes straight to the brief, left alone the sound plays out', { timeout: 60_000 }, async () => {
  clearSounds()
  config({ time: '06:30', days: 'daily', enabled: true })
  // No HUD on this port: the script must ring all the same.
  const run = (fakeMs) =>
    new Promise((resolve) => {
      const started = Date.now()
      const child = spawn(process.execPath, [join(REPO, 'scripts', 'alarm.mjs'), 'test', '--quick', '--json'], { env: { ...process.env, PORT: '1', JARVIS_AUDIO: 'off', JARVIS_AUDIO_FAKE_MS: String(fakeMs), JARVIS_TTS: 'off', JARVIS_WEATHER: 'off' }, stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.on('exit', (code) => resolve({ code, ms: Date.now() - started, out, json: () => JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) }))
    })
  // left alone
  const alone = await run(300)
  assert.equal(alone.code, 0, alone.out)
  assert.equal(alone.json().stopped, false)
  assert.equal(existsSync(join(ALARM_DIR, 'ringing.json')), false)

  // stopped from the screen (what POST /api/alarm/stop does) long before the sound would end
  const pending = run(45_000)
  let ring = null
  for (let i = 0; i < 300 && !ring; i++) {
    await new Promise((r) => setTimeout(r, 50))
    ring = ringingNow()
  }
  assert.ok(ring, 'the script said it is ringing')
  assert.equal(ring.test, true)
  assert.match(ring.greeting, /^Dobr(é ráno|ý deň|ý večer), pane$/)
  assert.equal(stopRinging(ring.id).id, ring.id)
  const stopped = await pending
  assert.equal(stopped.code, 0, stopped.out)
  assert.equal(stopped.json().stopped, true)
  assert.ok(stopped.ms < 40_000, `the brief started right after the stop (${stopped.ms} ms)`)
  assert.match(stopped.json().text, /pane\. Je /)
  assert.equal(existsSync(join(ALARM_DIR, 'ringing.json')), false)
  assert.match(readFileSync(join(DATA, 'logs', 'alarm.log'), 'utf8'), /zvonenie zastavené na obrazovke, hovorím brief/)
})

test('ask_alarm: the MCP tool asks the HUD for the card, the brain may use it and the persona sends the choice to the card', async (t) => {
  const seen = []
  const hud = createHttpServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      seen.push({ path: req.url, body: JSON.parse(body) })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, card: 'alarm-abc', text: 'Karta budíka je na obrazovke.' }))
    })
  })
  await new Promise((r) => hud.listen(0, '127.0.0.1', r))
  t.after(() => hud.close())
  const child = spawn(process.execPath, [join(REPO, 'hud', 'server', 'mcp', 'jarvis-hud.mjs')], { env: { ...process.env, HUD_URL: `http://127.0.0.1:${hud.address().port}`, HUD_BRAIN_TOKEN: 'test-token' }, stdio: ['pipe', 'pipe', 'ignore'] })
  t.after(() => child.kill())
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  const call = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
  call({ id: 1, method: 'initialize', params: {} })
  call({ id: 2, method: 'tools/list' })
  call({ id: 3, method: 'tools/call', params: { name: 'ask_alarm', arguments: { time: '06:30', days: 'weekdays' } } })
  for (let i = 0; i < 100 && !out.includes('"id":3'); i++) await new Promise((r) => setTimeout(r, 50))
  const lines = out.trim().split('\n').map((l) => JSON.parse(l))
  const tool = lines.find((l) => l.id === 2).result.tools.find((x) => x.name === 'ask_alarm')
  assert.match(tool.description, /Highway to Hell.+Should I Stay or Should I Go/)
  assert.equal(lines.find((l) => l.id === 3).result.content[0].text, 'Karta budíka je na obrazovke.')
  assert.deepEqual(seen, [{ path: '/api/brain/hud', body: { action: 'alarm_card', time: '06:30', days: 'weekdays' } }])

  const { allowedTools } = await import('../hud/server/brain.mjs')
  assert.ok(allowedTools().includes('mcp__jarvis-hud__ask_alarm'))
  const { buildPersona } = await import('../hud/server/persona.mjs')
  const p = buildPersona()
  assert.match(p, /Krok budik: .+zavolaj ask_alarm s tým časom/)
  assert.match(p, /Skladbu za neho nevyberaj/)
  assert.match(p, /tlačidlom: zastaví zvonenie a ranný prehľad zaznie hneď/)
  assert.ok(TMP)
})
