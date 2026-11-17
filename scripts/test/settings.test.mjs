/**
 * Voices and the settings: which voice is spoken with, what a settings request may contain and
 * how it lands in config/jarvis.json. node --test scripts/test/*.test.mjs
 * Runs against a temporary folder, never the real config or data, and makes no sound.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'jarvis-settings-test-'))
process.env.JARVIS_DATA_DIR = join(dir, 'data')
process.env.JARVIS_MEMORY_DIR = join(dir, 'memory')
process.env.JARVIS_CONFIG = join(dir, 'jarvis.json')
process.env.JARVIS_TTS = 'off'
process.env.JARVIS_STT = 'browser'
delete process.env.JARVIS_LANG
delete process.env.JARVIS_EDGE_VOICE
after(() => rmSync(dir, { recursive: true, force: true }))

const { VOICES, defaultVoiceId, isVoiceId, resolveVoice, voiceList } = await import('../../hud/server/voices.mjs')
const { applySettings, settingsBody, validateSettings } = await import('../../hud/server/settings.mjs')
const { getConfig } = await import('../../hud/server/config.mjs')

const config = () => JSON.parse(readFileSync(process.env.JARVIS_CONFIG, 'utf8'))
const refused = async (body, status = 400) => assert.rejects(() => applySettings(body), (err) => err.status === status)

test('every built-in voice has a valid id, a gender and a language', () => {
  for (const v of VOICES) {
    assert.ok(isVoiceId(v.id), v.id)
    assert.ok(['male', 'female'].includes(v.gender))
    assert.ok(['sk', 'cs', 'multi'].includes(v.lang))
  }
  assert.ok(!isVoiceId('sk-SK-LukasNeural; rm -rf /'))
  assert.ok(!isVoiceId('../../etc/passwd'))
})

test('the voice comes from the config, then .env, then language and gender', () => {
  assert.equal(resolveVoice({}, {}).id, 'sk-SK-LukasNeural')
  assert.equal(resolveVoice({ assistant: { gender: 'female' } }, {}).id, 'sk-SK-ViktoriaNeural')
  assert.equal(resolveVoice({ language: 'cs' }, {}).id, 'cs-CZ-AntoninNeural')
  assert.equal(resolveVoice({ assistant: { gender: 'female' } }, { JARVIS_LANG: 'cs' }).id, 'cs-CZ-VlastaNeural')
  assert.equal(resolveVoice({}, { JARVIS_EDGE_VOICE: 'cs-CZ-VlastaNeural' }).id, 'cs-CZ-VlastaNeural')
  assert.equal(resolveVoice({ voice: { id: 'en-US-AndrewMultilingualNeural' } }, { JARVIS_EDGE_VOICE: 'cs-CZ-VlastaNeural' }).id, 'en-US-AndrewMultilingualNeural')
  assert.equal(resolveVoice({ voice: { id: 'nonsense' } }, {}).id, 'sk-SK-LukasNeural')
  assert.deepEqual(resolveVoice({ voice: { rate: '+10%', pitch: '-5Hz' } }, {}), { id: 'sk-SK-LukasNeural', rate: '+10%', pitch: '-5Hz' })
  assert.equal(defaultVoiceId('cs', 'female'), 'cs-CZ-VlastaNeural')
})

test('a voice set by hand stays in the list', () => {
  const list = voiceList({ voice: { id: 'pl-PL-MarekNeural' } }, {})
  assert.ok(list.some((v) => v.id === 'pl-PL-MarekNeural' && v.lang === 'custom'))
})

test('a request may hold only known settings with sane values', () => {
  const ok = (body) => validateSettings(body, VOICES)
  const bad = (body) => assert.throws(() => ok(body), (err) => err.status === 400, JSON.stringify(body))
  assert.deepEqual(ok({ voice: 'sk-SK-ViktoriaNeural' }), { voice: { id: 'sk-SK-ViktoriaNeural' } })
  assert.deepEqual(ok({ quiet: '23:00-6:30' }), { quiet: '23:00-06:30' })
  assert.deepEqual(ok({ quiet: '' }), { quiet: '' })
  assert.deepEqual(ok({ wake: { on: true } }), { wake: true })
  assert.deepEqual(ok({ user: { address: '' } }), { user: { address: '' } })
  bad({})
  bad([])
  bad({ nonsense: 1 })
  bad({ __proto__: null, constructor: 1 })
  bad({ assistant: { name: '' } })
  bad({ assistant: { name: 'x'.repeat(25) } })
  bad({ assistant: { gender: 'robot' } })
  bad({ assistant: { role: 'admin' } })
  bad({ voice: { id: 'xx-XX-NobodyNeural' } })
  bad({ voice: { rate: 'fast' } })
  bad({ voice: { rate: '+300%' } })
  bad({ voice: { pitch: '+90Hz' } })
  bad({ user: { name: '<script>alert(1)</script>' } })
  bad({ user: { name: 'x'.repeat(61) } })
  bad({ user: { formal: 'yes' } })
  bad({ user: { name: 42 } })
  bad({ quiet: '25:00-07:00' })
  bad({ stt: 'mlx' })
  bad({ language: 'en' })
  bad({ wake: 'on' })
})

test('the first change creates the config from the example and keeps everything else', async () => {
  const res = await applySettings({ assistant: { gender: 'female' } })
  assert.deepEqual(res.changed, ['assistant'])
  assert.equal(res.voice.id, 'sk-SK-ViktoriaNeural')
  const raw = config()
  assert.equal(raw.assistant.gender, 'female')
  assert.ok(Array.isArray(raw.routines) && raw.routines.length > 0)
  assert.ok(raw.pulse)
})

test('keys the settings do not know survive a change', async () => {
  writeFileSync(process.env.JARVIS_CONFIG, JSON.stringify({ ...config(), mojKluc: { a: 1 }, routines: [{ id: 'moja', title: 'Moja', time: '09:00' }] }))
  await applySettings({ user: { name: 'Martin Novák', address: 'šéfe', formal: false, gender: 'male', city: 'Košice' }, quiet: '' })
  const raw = config()
  assert.deepEqual(raw.mojKluc, { a: 1 })
  assert.equal(raw.routines[0].id, 'moja')
  assert.equal(raw.name, 'Martin Novák')
  assert.equal(raw.address, 'šéfe')
  assert.equal(raw.formal, false)
  assert.equal(raw.userGender, 'male')
  assert.equal(raw.quiet, '')
  assert.equal(getConfig().userGender, 'male')
})

test('voice and gender follow each other, the language brings its native voice', async () => {
  let res = await applySettings({ voice: { id: 'en-US-AndrewMultilingualNeural' } })
  assert.equal(res.assistant.gender, 'male')
  assert.equal(res.voice.id, 'en-US-AndrewMultilingualNeural')
  res = await applySettings({ assistant: { gender: 'female' } })
  assert.equal(res.voice.id, 'sk-SK-ViktoriaNeural')
  res = await applySettings({ language: 'cs' })
  assert.equal(res.language, 'cs')
  assert.equal(res.voice.id, 'cs-CZ-VlastaNeural')
  res = await applySettings({ language: 'sk', voice: { id: null, rate: '-10%' } })
  assert.equal(res.voice.id, 'sk-SK-ViktoriaNeural')
  assert.equal(res.voice.rate, '-10%')
  assert.equal(res.voice.source, 'default')
  assert.equal(config().voice.id, undefined)
  // Asking for both at once is taken as it is, even when they do not match.
  res = await applySettings({ assistant: { gender: 'male' }, voice: { id: 'sk-SK-ViktoriaNeural' } })
  assert.equal(res.assistant.gender, 'male')
  assert.equal(res.voice.id, 'sk-SK-ViktoriaNeural')
})

test('a refused request writes nothing', async () => {
  const before = readFileSync(process.env.JARVIS_CONFIG, 'utf8')
  await refused({ voice: { id: 'xx-XX-NobodyNeural' } })
  await refused({ user: { name: 'ok' }, extra: true })
  await refused({ wake: true }, 409)
  assert.equal(readFileSync(process.env.JARVIS_CONFIG, 'utf8'), before)
})

test('a config file that is not valid JSON is never overwritten', async () => {
  const good = readFileSync(process.env.JARVIS_CONFIG, 'utf8')
  writeFileSync(process.env.JARVIS_CONFIG, '{ "name": "Martin", ')
  await refused({ quiet: '22:00-07:00' }, 409)
  assert.equal(readFileSync(process.env.JARVIS_CONFIG, 'utf8'), '{ "name": "Martin", ')
  writeFileSync(process.env.JARVIS_CONFIG, good)
})

test('changes made at the same moment do not lose each other', async () => {
  await Promise.all([applySettings({ user: { city: 'Žilina' } }), applySettings({ assistant: { name: 'Friday' } }), applySettings({ quiet: '21:00-06:00' })])
  const raw = config()
  assert.equal(raw.city, 'Žilina')
  assert.equal(raw.assistant.name, 'Friday')
  assert.equal(raw.quiet, '21:00-06:00')
})

test('the settings body has everything the page needs', () => {
  const body = settingsBody()
  for (const key of ['assistant', 'voice', 'voices', 'user', 'quiet', 'alarm', 'stt', 'wake', 'language']) assert.ok(key in body, key)
  assert.equal(body.stt.engine, 'browser')
  assert.equal(body.stt.locked, true)
  assert.ok(body.voices.length >= 4)
})
