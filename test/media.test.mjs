/**
 * Videos and the alarm sound: the parts that need no network (hud/server/media.mjs, video.mjs,
 * alarm-sound.mjs). What may be handed to yt-dlp, how times and subtitles are read, what the
 * brain gets from a transcript and which sound the alarm falls back to.
 *
 *   node --test test/*.test.mjs
 */
import { TMP } from './setup.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const { MediaError, checkUrl, mediaId, pickSubtitle, toSegments } = await import('../hud/server/media.mjs')
const { parseTime, stamp, transcriptText, listVideos } = await import('../hud/server/video.mjs')
const { resolveSound, soundSeconds, writeSoundSetting } = await import('../hud/server/alarm-sound.mjs')

const DATA = process.env.JARVIS_DATA_DIR
const CONFIG = process.env.JARVIS_CONFIG

test('only a public http(s) address ever reaches yt-dlp', () => {
  assert.equal(checkUrl(' https://www.youtube.com/watch?v=abc '), 'https://www.youtube.com/watch?v=abc')
  assert.equal(checkUrl('http://example.com/v/1'), 'http://example.com/v/1')
  const refused = [
    '', '-x', '--exec=rm -rf ~', 'file:///etc/passwd', 'ftp://example.com/a.mp4', 'javascript:alert(1)', 'youtube.com/watch?v=abc',
    'http://localhost/x', 'http://127.0.0.1:4545/api/status', 'http://2130706433/', 'http://[::1]/', 'https://192.168.1.10/a', 'https://10.0.0.5/a',
    'https://router.local/a', 'https://intranet/a', 'https://user:secret@example.com/a', 'https://exa mple.com/a', `https://example.com/${'a'.repeat(3000)}`,
  ]
  for (const url of refused) {
    assert.throws(() => checkUrl(url), (err) => err instanceof MediaError && err.code === 'url', `accepted: ${url.slice(0, 60)}`)
  }
})

test('an id is safe as a folder name', () => {
  assert.equal(mediaId('Youtube', 'l482T0yNkeo'), 'youtube-l482T0yNkeo')
  assert.equal(mediaId('Some/Site', '../../etc/passwd'), 'somesite-etcpasswd')
  assert.equal(mediaId('', ''), null)
})

test('times as people and links write them', () => {
  assert.equal(parseTime(754), 754)
  assert.equal(parseTime('754'), 754)
  assert.equal(parseTime('12:34'), 754)
  assert.equal(parseTime('1:02:05'), 3725)
  assert.equal(parseTime('12m34s'), 754)
  assert.equal(parseTime('1h2m5s'), 3725)
  assert.equal(parseTime('90s'), 90)
  assert.equal(parseTime('+30', 100), 130)
  assert.equal(parseTime('-10', 100), 90)
  assert.equal(parseTime('soon'), null)
  assert.equal(parseTime(''), null)
  assert.equal(parseTime('1:2:3:4'), null)
  assert.equal(stamp(754), '12:34')
  assert.equal(stamp(3725), '1:02:05')
  assert.equal(stamp(-5), '0:00')
})

test('subtitles: written by people before automatic, the user\'s language first', () => {
  const info = (subtitles, autoCaptions, language = 'en') => ({ subtitles, autoCaptions, language })
  assert.deepEqual(pickSubtitle(info({ en: ['vtt'], cs: ['vtt'], sk: ['vtt'] }, { en: ['vtt'] }), ['sk', 'cs']), { lang: 'sk', auto: false })
  assert.deepEqual(pickSubtitle(info({ en: ['vtt'], cs: ['vtt'] }, {}), ['sk', 'cs']), { lang: 'cs', auto: false })
  assert.deepEqual(pickSubtitle(info({ de: ['vtt'], 'en-GB': ['vtt'] }, {}), ['sk', 'cs']), { lang: 'en-GB', auto: false })
  assert.deepEqual(pickSubtitle(info({ ja: ['vtt'] }, { en: ['vtt'] }, 'ja'), ['sk']), { lang: 'ja', auto: false })
  // no written subtitles: the automatic track in the language that is spoken, not a machine translation
  assert.deepEqual(pickSubtitle(info({}, { sk: ['vtt'], en: ['vtt'], 'en-orig': ['vtt'] }), ['sk']), { lang: 'en-orig', auto: true })
  assert.deepEqual(pickSubtitle(info({}, { de: ['vtt'], sk: ['vtt'] }, 'de'), ['sk']), { lang: 'de', auto: true })
  assert.equal(pickSubtitle(info({}, {}), ['sk']), null)
})

test('cues become readable lines whose times never overlap', () => {
  const cues = [
    { start: 0, end: 2.5, text: 'Prvá veta' },
    { start: 2, end: 4, text: 'pokračuje ďalej.' },
    { start: 4, end: 6, text: 'Druhá veta začína' },
    { start: 6, end: 30, text: 'a tu je dlhá pauza' },
    { start: 40, end: 42, text: 'Po pauze.' },
    { start: 42, end: 0, text: 'Bez konca' },
  ]
  const lines = toSegments(cues)
  assert.equal(lines[0].text, 'Prvá veta pokračuje ďalej.')
  assert.equal(lines[0].start, 0)
  assert.equal(lines[0].end, 4)
  assert.ok(lines.some((l) => l.text === 'Po pauze.'))
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].start >= lines[i - 1].end - 0.001, 'lines overlap')
  for (const l of lines) assert.ok(l.end > l.start && l.text.length <= 200)
  assert.deepEqual(toSegments([]), [])
})

test('the transcript for the brain: whole, a window, a query, and a size limit', async () => {
  const id = 'youtube-AAAAAAAAAAA'
  const dir = join(DATA, 'video', id)
  mkdirSync(dir, { recursive: true })
  const segments = Array.from({ length: 120 }, (_, i) => ({ start: i * 10, end: i * 10 + 9, text: i === 42 ? 'Tu sa hovorí o cenách bytov v Žiline.' : `Riadok číslo ${i} o ničom dôležitom.` }))
  writeFileSync(join(dir, 'transcript.json'), JSON.stringify(segments))
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', title: 'Test', duration: 1200, chapters: [], state: 'ready', file: 'video.mp4', thumb: null, transcript: { state: 'ready', source: 'subtitles', lang: 'sk', lines: 120, words: 600 }, openedAt: '2026-11-17T10:00:00.000Z' }))
  // a folder with a name that is not an id is never read as a video
  mkdirSync(join(DATA, 'video', 'not an id!'), { recursive: true })

  assert.deepEqual((await listVideos()).map((v) => v.id), [id])
  const listed = (await listVideos())[0]
  assert.equal(listed.fileUrl, `/api/video/${id}/file`)
  assert.equal(listed.file, undefined, 'a local file name left the server')

  const all = await transcriptText(id, { max: 30_000 })
  assert.equal(all.total, 120)
  assert.equal(all.lines, 120)
  assert.ok(all.text.startsWith('[0:00] Riadok číslo 0'))
  assert.equal(all.truncated, false)

  const win = await transcriptText(id, { from: '1:00', to: '2:00' })
  assert.equal(win.lines, 6)
  assert.ok(win.text.startsWith('[1:00]'))

  // without diacritics, with one line of context around the hit, the hit is marked
  const hit = await transcriptText(id, { query: 'ceny ziline'.replace('ceny', 'cenach') })
  assert.equal(hit.matches, 1)
  assert.equal(hit.lines, 3)
  assert.match(hit.text, /\[7:00\] \* Tu sa hovorí o cenách/)

  const none = await transcriptText(id, { query: 'neexistuje' })
  assert.equal(none.matches, 0)
  assert.equal(none.text, '')

  const short = await transcriptText(id, { max: 500 })
  assert.equal(short.truncated, true)
  assert.ok(short.text.length <= 500)
  assert.match(short.note, /from="\d+:\d\d"/)

  await assert.rejects(() => transcriptText('../../etc', {}), (err) => err.status === 404)
  await assert.rejects(() => transcriptText('youtube-BBBBBBBBBBB', {}), (err) => err.status === 404)
})

test('the alarm never ends up without a sound, and choosing one keeps the rest of the config', () => {
  const alarmDir = join(DATA, 'alarm')
  rmSync(alarmDir, { recursive: true, force: true })
  mkdirSync(alarmDir, { recursive: true })
  writeFileSync(CONFIG, JSON.stringify({ name: 'Test', city: 'Poprad', alarm: { time: '06:30', days: 'weekdays', enabled: true }, routines: [{ id: 'ranny-brief' }] }))

  // nothing downloaded, nothing chosen: the built-in chime
  assert.equal(resolveSound().kind, 'builtin')
  assert.equal(resolveSound().play, null)
  assert.equal(soundSeconds(), 45)

  // the song from setup is on the disk: it is the default without anything in the config
  writeFileSync(join(alarmDir, 'sound-default.mp3'), Buffer.alloc(4000, 1))
  assert.equal(resolveSound().kind, 'default')
  assert.equal(resolveSound().play, join(alarmDir, 'sound-default.mp3'))

  writeSoundSetting('builtin')
  assert.equal(resolveSound().kind, 'builtin')
  const afterBuiltin = JSON.parse(readFileSync(CONFIG, 'utf8'))
  assert.deepEqual(afterBuiltin.alarm, { time: '06:30', days: 'weekdays', enabled: true, sound: 'builtin' })
  assert.equal(afterBuiltin.city, 'Poprad')
  assert.equal(afterBuiltin.routines.length, 1)

  // the user's own file
  writeFileSync(join(alarmDir, 'sound-custom.mp3'), Buffer.alloc(4000, 1))
  writeSoundSetting('sound-custom.mp3')
  assert.equal(resolveSound().kind, 'custom')
  // a prepared clip is what plays, once it exists
  writeFileSync(join(alarmDir, 'ring-sound-custom-45s.mp3'), Buffer.alloc(4000, 1))
  assert.equal(resolveSound().play, join(alarmDir, 'ring-sound-custom-45s.mp3'))
  assert.equal(resolveSound().prepared, true)

  // the chosen file disappears: the default song, and without it the chime
  rmSync(join(alarmDir, 'sound-custom.mp3'))
  assert.equal(resolveSound().kind, 'default')
  rmSync(join(alarmDir, 'sound-default.mp3'))
  assert.equal(resolveSound().kind, 'builtin')

  // a name that points out of data/alarm is not a sound
  writeFileSync(join(alarmDir, 'sound-default.mp3'), Buffer.alloc(4000, 1))
  writeSoundSetting('../../../etc/passwd')
  assert.equal(resolveSound().kind, 'default')
  writeSoundSetting(null)
  assert.equal(JSON.parse(readFileSync(CONFIG, 'utf8')).alarm.sound, undefined)

  // the length is taken from the config and kept inside sane bounds
  writeFileSync(CONFIG, JSON.stringify({ alarm: { soundSeconds: 9999 } }))
  assert.equal(soundSeconds(), 300)
  assert.ok(TMP.length > 0)
})
