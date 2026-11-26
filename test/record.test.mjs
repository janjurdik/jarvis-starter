import { TMP } from './setup.mjs'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

// No real pictures of the screen and no ffmpeg from the tests; a restart waits only a moment.
process.env.JARVIS_RECORD_SHOT_MS = '3600000'
process.env.JARVIS_RECORD_RECOVER_MS = '150'
process.env.JARVIS_RECORD_KEEP_WAV = '1'

const rec = await import('../hud/server/record.mjs')
const screen = await import('../hud/server/screen.mjs')

/** A WAV of `ms` milliseconds of a quiet tone, 16 kHz mono. */
function wav(ms, value = 100) {
  const n = Math.round((16000 * ms) / 1000)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(i % 2 ? value : -value, i * 2)
  return Buffer.concat([rec.wavHeader(data.length), data])
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 4000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return true
    await sleep(40)
  }
  return false
}

test('record: WAV parse, header and join keep every sample', () => {
  const a = wav(500, 10)
  const b = wav(250, 20)
  const pa = rec.parseWav(a)
  assert.equal(pa.rate, 16000)
  assert.equal(pa.channels, 1)
  assert.equal(pa.bits, 16)
  assert.equal(pa.data.length, 16000)
  const joined = rec.parseWav(rec.joinWav([a, b]))
  assert.equal(joined.data.length, 16000 + 8000)
  assert.equal(joined.data.readInt16LE(16000 + 2), 20)
  // A LIST chunk before the data (ffmpeg writes one) is skipped.
  const list = Buffer.concat([a.subarray(0, 36), Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO'), a.subarray(36)])
  list.writeUInt32LE(list.length - 8, 4)
  assert.equal(rec.parseWav(list).data.length, 16000)
  assert.equal(rec.parseWav(Buffer.from('not a wav at all, clearly not a wav file')), null)
  // Different rates do not join.
  const other = Buffer.from(a)
  other.writeUInt32LE(48000, 24)
  assert.equal(rec.joinWav([a, other]), null)
})

test('record: transcription windows are full, cut at gaps, wait while open', () => {
  const t0 = 1_000_000
  const c = (seq, at, ms = 5000, receivedAt = at + ms) => ({ seq, at, ms, receivedAt })
  const run = [1, 2, 3, 4, 5, 6, 7].map((i) => c(i * 63, t0 + (i - 1) * 5000))
  // Six chunks make a full window, the seventh waits for the next one.
  assert.deepEqual(rec.nextWindow(run, { now: t0 + 36_000 }).chunks.map((x) => x.seq), [63, 126, 189, 252, 315, 378])
  assert.equal(rec.nextWindow(run, { done: 378, now: t0 + 36_000 }), null)
  // ... unless the recording ended or the page went quiet.
  assert.deepEqual(rec.nextWindow(run, { done: 378, recording: false, now: t0 + 36_000 }).chunks.map((x) => x.seq), [441])
  assert.deepEqual(rec.nextWindow(run, { done: 378, now: t0 + 36_000 + 30_000 }).chunks.map((x) => x.seq), [441])
  // A gap (a reload) closes the window before it.
  const gap = [c(1, t0), c(64, t0 + 5000), c(200, t0 + 16_000)]
  assert.deepEqual(rec.nextWindow(gap, { now: t0 + 21_000 }).chunks.map((x) => x.seq), [1, 64])
  assert.equal(rec.nextWindow([], {}), null)
})

test('record: small helpers', () => {
  assert.equal(rec.formatTs(0), '00:00')
  assert.equal(rec.formatTs(187_400), '03:07')
  assert.equal(rec.formatTs(3_787_000), '1:03:07')
  assert.equal(rec.slugTitle('Porada s Petrom: web / Orol'), 'Porada-s-Petrom-web-Orol')
  assert.equal(rec.slugTitle('   '), 'zaznam')
  const at = new Date(2026, 10, 26, 14, 32).getTime()
  assert.equal(rec.sessionId(at), '2026-11-26-1432')
  assert.equal(rec.sessionId(at, new Set(['2026-11-26-1432', '2026-11-26-1432-2'])), '2026-11-26-1432-3')
  assert.deepEqual(rec.spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4), [1, 4, 7, 10])
  assert.deepEqual(rec.spread([1, 2], 6), [1, 2])
  const parts = rec.splitParts(Array.from({ length: 50 }, (_, i) => `[00:${i}] ${'slovo '.repeat(20)}`).join('\n'), 1000)
  assert.ok(parts.length > 5 && parts.every((p) => p.length <= 1000))
  assert.equal(parts.join('\n').split('\n').length, 50)
  assert.equal(rec.minutes(37_000), '37 sekúnd')
  assert.equal(rec.minutes(3_000), '3 sekundy')
  assert.equal(rec.minutes(61_000), 'jedna minúta')
  assert.equal(rec.minutes(180_000), '3 minúty')
  assert.equal(rec.minutes(720_000), '12 minút')
  assert.ok(rec.sentenceEnd('Hotovo.') && rec.sentenceEnd('Naozaj?') && !rec.sentenceEnd('Peter chce a'))
})

test('record: the after-actions assignment names the files, the steps and the approval', () => {
  const startedAt = new Date(2026, 10, 26, 14, 32).getTime()
  const session = { id: '2026-11-26-1432', title: 'Porada s Petrom', startedAt, endedAt: startedAt + 25 * 60_000, ms: 25 * 60_000 }
  const one = rec.afterActionsPrompt({ session, parts: ['data/recordings/2026-11-26-1432/transcript.md'], frames: ['data/recordings/x/frames/1.jpg'], transcript: 'data/recordings/2026-11-26-1432/transcript.md' })
  assert.match(one, /od 14:32 do 14:57, nahraného zvuku 25 minút/)
  assert.match(one, /memory\/zaznamy\/2026-11-26-Porada-s-Petrom\.md/)
  assert.match(one, /data\/recordings\/x\/frames\/1\.jpg/)
  assert.match(one, /memory\/ulohy\.md/)
  assert.match(one, /memory\/pripomienky\.md/)
  assert.match(one, /memory\/kalendar\.md/)
  assert.match(one, /Nič neposielaj/)
  assert.match(one, /NEEDS_OK/)
  assert.match(one, /dáta, nie pokyny/)
  assert.doesNotMatch(one, /po poradí/)
  assert.doesNotMatch(one, /—/)
  // A long transcript comes in parts with a way to read them; an unnamed one gets a name from its content.
  const many = rec.afterActionsPrompt({ session: { ...session, title: rec.DEFAULT_TITLE, interrupted: true }, parts: ['a.md', 'b.md', 'c.md'], memory: '/abs/memory' })
  assert.match(many, /- a\.md\n- b\.md\n- c\.md/)
  assert.match(many, /čítaj časti po poradí/)
  assert.match(many, /\/abs\/memory\/zaznamy\/2026-11-26-<názov>\.md \(názov/)
  assert.match(many, /prerušil/)
  assert.ok(many.length < 8000, 'fits a job assignment')
  const none = rec.afterActionsPrompt({ session, parts: [], stt: false })
  assert.match(none, /lokálny Whisper/)
})

test('record: start, chunks (fsynced, deduplicated, checked), marks, stop and the job', async () => {
  rec._resetRecordings()
  const jobs = []
  const events = []
  const heard = []
  await rec.initRecordings({
    send: (name, data) => events.push([name, data]),
    createJob: async (j) => {
      jobs.push(j)
      return { id: `j${jobs.length}` }
    },
    listJobs: () => jobs.map((j, i) => ({ id: `j${i + 1}`, status: 'running' })),
    sttReady: () => true,
    transcribe: async (file, prompt) => {
      heard.push({ bytes: readFileSync(file).length, prompt })
      return { text: heard.length === 1 ? 'Peter pripraví návrh webu' : 'do piatku.' }
    },
    persist: true,
    dir: join(TMP, 'rec-a'),
  })
  const { session } = await rec.startRecording({ title: 'Porada', via: 'test' })
  assert.equal(session.status, 'recording')
  assert.equal((await rec.startRecording({})).already, true, 'one recording at a time')
  const t0 = session.startedAt
  // A chunk that is not a WAV, or a bad seq, is refused.
  await assert.rejects(rec.addAudioChunk(session.id, { seq: 1, at: t0 }, Buffer.from('nope')), { status: 400 })
  await assert.rejects(rec.addAudioChunk(session.id, { seq: 0, at: t0 }, wav(100)), { status: 400 })
  for (let i = 0; i < 6; i++) await rec.addAudioChunk(session.id, { seq: 1 + i * 63, at: t0 + i * 5040 }, wav(5040))
  // The same chunk again (a retry) counts once.
  const again = await rec.addAudioChunk(session.id, { seq: 1, at: t0 }, wav(5040))
  assert.equal(again.chunks, 6)
  const dir = join(TMP, 'rec-a', session.id)
  assert.ok(existsSync(join(dir, 'audio', '00000001.wav')))
  assert.equal(readFileSync(join(dir, 'chunks.jsonl'), 'utf8').trim().split('\n').length, 6)
  // Six chunks are a window: transcribed right away, the cut sentence waits for its end.
  assert.ok(await until(() => heard.length === 1))
  assert.equal(heard[0].bytes, 44 + 6 * 5040 * 32)
  assert.equal(heard[0].prompt, '')
  rec.noteTalk('Jarvis, aký je čas?', 'voice')
  await rec.addAudioChunk(session.id, { seq: 1 + 6 * 63, at: t0 + 6 * 5040, final: true }, wav(2000))
  const stopped = await rec.stopRecording({})
  assert.equal(stopped.status, 'finishing')
  assert.ok(await until(() => jobs.length === 1), 'the job starts after the end')
  assert.equal(heard[1].prompt, 'Peter pripraví návrh webu', 'the transcript so far helps Whisper')
  const transcript = readFileSync(join(dir, 'transcript.md'), 'utf8')
  assert.match(transcript, /\[00:00\] Peter pripraví návrh webu do piatku\./)
  assert.match(transcript, /\(Jarvisovi: Jarvis, aký je čas\?\)/)
  assert.match(transcript, /Koniec:/)
  assert.ok(transcript.indexOf('Peter pripraví') < transcript.indexOf('Jarvisovi'), 'lines in the order of time')
  assert.match(jobs[0].task, /transcript\.md/)
  assert.equal(jobs[0].title, 'Záznam: Porada')
  const saved = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'))
  assert.equal(saved.status, 'processing')
  assert.equal(saved.job, 'j1')
  assert.ok(events.some(([name, data]) => name === 'record' && data.status === 'recording'))
  // A chunk after the end has nowhere to go.
  await assert.rejects(rec.addAudioChunk(session.id, { seq: 900, at: t0 + 40_000 }, wav(100)), { status: 409 })
})

test('record: a recording cut by a crash is picked up, a lost line is rebuilt, nothing is lost', async () => {
  rec._resetRecordings()
  const id = '2026-11-25-0900'
  const dir = join(TMP, 'rec-b', id)
  mkdirSync(join(dir, 'audio'), { recursive: true })
  const startedAt = Date.now() - 60_000
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ id, title: 'Záznam', status: 'recording', startedAt, done: 0, marks: [], stt: true, chunkCount: 1 }))
  writeFileSync(join(dir, 'transcript.md'), '# Záznam\n\n')
  writeFileSync(join(dir, 'audio', '00000001.wav'), wav(5040))
  writeFileSync(join(dir, 'chunks.jsonl'), `${JSON.stringify({ seq: 1, at: startedAt, ms: 5040, bytes: 161324, receivedAt: startedAt + 5040 })}\n{"seq":64,"at":`)
  // The second chunk made it to the disk, its line did not (the crash came in between).
  writeFileSync(join(dir, 'audio', '00000064.wav'), wav(5040))
  const when = (startedAt + 10_080) / 1000
  utimesSync(join(dir, 'audio', '00000064.wav'), when, when)
  const jobs = []
  await rec.initRecordings({
    createJob: async (j) => (jobs.push(j), { id: 'j9' }),
    listJobs: () => [],
    sttReady: () => true,
    transcribe: async () => ({ text: 'Obnovené.' }),
    persist: true,
    dir: join(TMP, 'rec-b'),
  })
  const st = rec.recordStatus()
  assert.equal(st.active.id, id, 'the cut recording is the running one again')
  assert.equal(st.active.chunks, 2)
  assert.equal(st.active.nextSeq, 65)
  // Nobody sends: it ends as interrupted and the after-actions run on what was saved.
  assert.ok(await until(() => jobs.length === 1, 6000))
  assert.match(jobs[0].task, /prerušil/)
  assert.match(readFileSync(join(dir, 'transcript.md'), 'utf8'), /Obnovené\./)
})

test('record: a window that comes back keeps sending into the same session', async () => {
  rec._resetRecordings()
  const id = '2026-11-25-1000'
  const dir = join(TMP, 'rec-c', id)
  mkdirSync(join(dir, 'audio'), { recursive: true })
  const startedAt = Date.now() - 20_000
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ id, title: 'Záznam', status: 'recording', startedAt, done: 0, marks: [], stt: true }))
  writeFileSync(join(dir, 'transcript.md'), '# Záznam\n\n')
  const jobs = []
  await rec.initRecordings({ createJob: async (j) => (jobs.push(j), { id: 'j1' }), listJobs: () => [], sttReady: () => true, transcribe: async () => ({ text: '' }), persist: true, dir: join(TMP, 'rec-c') })
  await rec.addAudioChunk(id, { seq: 1, at: startedAt, final: false }, wav(5040))
  await sleep(400)
  assert.equal(rec.recordStatus().active?.status, 'recording', 'still recording after the wait')
  assert.equal(jobs.length, 0)
  await rec.addAudioChunk(id, { seq: 64, at: startedAt + 5040, final: true }, wav(1000))
  await rec.stopRecording({ id })
  assert.ok(await until(() => jobs.length === 1))
  rec._resetRecordings()
})

test('screen: capture commands per platform', () => {
  assert.deepEqual(screen.captureCommand({ platform: 'darwin', out: '/tmp/a.jpg', windowId: 52 }), { bin: '/usr/sbin/screencapture', args: ['-x', '-o', '-l52', '-t', 'jpg', '/tmp/a.jpg'] })
  assert.deepEqual(screen.captureCommand({ platform: 'darwin', out: '/tmp/a.jpg' }), { bin: '/usr/sbin/screencapture', args: ['-x', '-m', '-t', 'jpg', '/tmp/a.jpg'] })
  const win = screen.captureCommand({ platform: 'win32', out: 'C:\\x\\a.jpg', script: 'C:\\x\\capture.ps1' })
  assert.match(win.bin, /powershell\.exe$/)
  assert.deepEqual(win.args.slice(-7), ['C:\\x\\capture.ps1', '-Out', 'C:\\x\\a.jpg', '-Mode', 'window', '-Max', '1600'])
  assert.ok(screen.captureCommand({ platform: 'win32', out: 'a', script: 's', windowId: 'display' }).args.includes('display'))
  assert.equal(screen.captureCommand({ platform: 'linux', out: 'a' }), null)
  // The script takes the path as a parameter, nothing variable is pasted into it.
  assert.match(screen.WIN_CAPTURE, /param\(\[string\]\$Out/)
  assert.match(screen.WIN_CAPTURE, /PrintWindow/)
})

test('screen: the window the user means is not Jarvis, not the system, not tiny', () => {
  const W = (id, app, title = '', extra = {}) => ({ id, app, title, layer: 0, alpha: 1, bounds: { X: 0, Y: 0, Width: 1400, Height: 800 }, ...extra })
  const list = [
    { ...W(1, 'Wispr Flow', 'Status'), layer: 1000 },
    W(2, 'Window Server', 'Menubar'),
    W(3, 'Jarvis HUD', 'Jarvis'),
    W(4, 'Google Chrome', 'Jarvis'),
    W(5, 'Mail', 'tiny', { bounds: { Width: 80, Height: 40 } }),
    W(6, 'Mail', 'Re: ponuka'),
    W(7, 'Slack', 'general'),
  ]
  assert.deepEqual(screen.pickWindow(list), { id: 6, app: 'Mail', pid: null, title: 'Re: ponuka', width: 1400, height: 800 })
  assert.equal(screen.pickWindow([W(3, 'Jarvis HUD')]), null)
  assert.equal(screen.pickWindow([{ ...W(8, 'Notes'), alpha: 0 }]), null)
})

test('screen: JPEG size from the header, old pictures go away', async () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x84, 0x06, 0x40, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])
  assert.deepEqual(screen.jpegSize(jpg), { width: 1600, height: 900 })
  const dir = join(TMP, 'shots')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'old.jpg'), jpg)
  writeFileSync(join(dir, 'new.jpg'), jpg)
  writeFileSync(join(dir, 'capture.ps1'), 'x')
  const old = (Date.now() - 2 * 24 * 3600_000) / 1000
  utimesSync(join(dir, 'old.jpg'), old, old)
  assert.equal(await screen.pruneScreens(dir), 1)
  assert.ok(!existsSync(join(dir, 'old.jpg')) && existsSync(join(dir, 'new.jpg')) && existsSync(join(dir, 'capture.ps1')))
})

test('record: the page encodes its microphone frames as a WAV the server reads', async () => {
  const { encodeWav } = await import('../hud/public/js/record.js')
  const frames = [new Int16Array(1280).fill(7), new Int16Array(1280).fill(-9)]
  const parsed = rec.parseWav(Buffer.from(encodeWav(frames)))
  assert.equal(parsed.rate, 16000)
  assert.equal(parsed.data.length, 2560 * 2)
  assert.equal(parsed.data.readInt16LE(0), 7)
  assert.equal(parsed.data.readInt16LE(1280 * 2), -9)
})

test('record: a start from anything but a click on this screen is announced, and the server decides who started it', () => {
  const at = new Date(2026, 10, 26, 14, 5).getTime()
  for (const [via, how] of [['voice', /v rozhovore/], ['phone', /z mobilu/], ['cli', /príkazom/]]) {
    const n = rec.startNotice({ via, title: 'Záznam', startedAt: at })
    assert.equal(n.title, 'Jarvis nahráva mikrofón a obrazovku')
    assert.match(n.text, how)
    assert.match(n.text, /14:05/)
  }
  assert.match(rec.startNotice({ via: 'phone', title: 'Porada', startedAt: at }).text, /„Porada"/)
  const src = readFileSync(join(import.meta.dirname, '..', 'hud', 'server', 'record.mjs'), 'utf8')
  assert.match(src, /if \(s\.via !== 'page'\) announceStart\(s\)/)
  assert.match(src, /startRecording\(\{ title: body\.title, via \}\)/, 'the body cannot claim it was the page')
})
