import { TMP } from './setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const { findMediaPaths, stripMediaPaths, trimText, registerMedia, registerPaths, mediaFile, mediaItem } = await import('../hud/server/shown-media.mjs')
const { normalizeCard } = await import('../hud/server/cards.mjs')
const { findArtifacts } = await import('../hud/server/jobs.mjs')
const { allowedTools } = await import('../hud/server/brain.mjs')

// Media of the tests: a home folder with a space and diacritics, files of every kind.
const HOME = join(TMP, 'home', 'Ján Jurdik')
const REEL_DIR = join(HOME, 'Jarvis', 'data', 'reel')
mkdirSync(REEL_DIR, { recursive: true })
const REEL = join(REEL_DIR, 'jarvis-reel.mp4')
const PHOTO = join(HOME, 'Fotky', 'more ráno.JPG')
const SONG = join(HOME, 'Hudba', 'pieseň.mp3')
mkdirSync(join(HOME, 'Fotky'), { recursive: true })
mkdirSync(join(HOME, 'Hudba'), { recursive: true })
const VIDEO_BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251))
writeFileSync(REEL, VIDEO_BYTES)
writeFileSync(PHOTO, Buffer.from('jpeg'))
writeFileSync(SONG, Buffer.from('mp3'))
writeFileSync(join(HOME, 'tajne.txt'), 'nie')

test('finds media paths with spaces and diacritics, in quotes, backticks and file:// addresses', () => {
  const text = `Video je hotové: ${REEL} Má 1080x1920, 21 sekúnd.\nFotka: "${PHOTO}", pieseň \`${SONG}\` a ešte file://${encodeURI(REEL)}.`
  const found = findMediaPaths(text)
  assert.deepEqual(
    found.map((f) => [f.kind, f.name]),
    [
      ['video', 'jarvis-reel.mp4'],
      ['image', 'more ráno.JPG'],
      ['audio', 'pieseň.mp3'],
    ],
    'the file:// address is the same reel, so it is not listed twice',
  )
  assert.equal(found[0].file, REEL)
})

test('resolves ~ paths against the home folder', () => {
  const home = process.env.HOME
  process.env.HOME = HOME
  process.env.USERPROFILE = HOME
  try {
    const found = findMediaPaths('Reel je v ~/Jarvis/data/reel/jarvis-reel.mp4, pozrite si ho.')
    assert.equal(found.length, 1)
    assert.equal(found[0].file, REEL)
  } finally {
    process.env.HOME = home
  }
})

test('skips files that do not exist, other kinds, and a "/" earlier in the sentence', () => {
  const text = `Pomer 1080/1920 a potom /neexistuje/x.mp4, ${join(HOME, 'tajne.txt')} a ${join(HOME, 'nie je.png')}. Uložené do /tmp a ${REEL}.`
  const found = findMediaPaths(text)
  assert.deepEqual(found.map((f) => f.file), [REEL])
})

test('caps the number of media', () => {
  const dir = join(TMP, 'many')
  mkdirSync(dir, { recursive: true })
  const names = Array.from({ length: 30 }, (_, i) => join(dir, `f${i}.png`))
  for (const n of names) writeFileSync(n, 'x')
  assert.equal(findMediaPaths(names.join(' ')).length, 24)
  assert.equal(findMediaPaths(names.join(' '), { max: 3 }).length, 3)
  const arts = findArtifacts(`https://example.com hotovo ${names.join(', ')}`)
  assert.equal(arts.filter((a) => a.kind === 'web').length, 1)
  assert.equal(arts.filter((a) => a.kind === 'image').length, 24)
})

test('strips shown paths from the text and keeps its meaning', () => {
  const text = `Video je hotové: ${REEL} Má 1080x1920, 21 sekúnd.`
  assert.equal(stripMediaPaths(text, findMediaPaths(text)), 'Video je hotové. Má 1080x1920, 21 sekúnd.')
  const saved = `Fotku som uložil do "${PHOTO}".`
  assert.equal(stripMediaPaths(saved, findMediaPaths(saved)), 'Fotku som uložil.')
  const list = `Hotovo: ${PHOTO}, ${SONG} a ${REEL}.`
  assert.equal(stripMediaPaths(list, findMediaPaths(list)), 'Hotovo.')
  assert.equal(stripMediaPaths('Nič tu nie je /a/b.mp4.', []), 'Nič tu nie je /a/b.mp4.')
  const voice = `Hotovo (mock): "${REEL}", "${PHOTO}".\nHLAS: Mám to hotové. Poznámka: Ján.`
  assert.equal(stripMediaPaths(voice, findMediaPaths(voice)), 'Hotovo (mock).\nHLAS: Mám to hotové. Poznámka: Ján.', 'other colons stay')
  const paren = `Reel (${REEL}) je hotový.`
  assert.equal(stripMediaPaths(paren, findMediaPaths(paren)), 'Reel je hotový.')
})

test('trims at a sentence or a word, never in the middle of a word', () => {
  assert.equal(trimText('Krátke.', 50), 'Krátke.')
  assert.equal(trimText('Prvá veta je tu. Druhá veta je oveľa dlhšia a už sa nezmestí.', 40), 'Prvá veta je tu.')
  const cut = trimText('Jedna veľmi dlhá veta bez konca ktorá pokračuje stále ďalej a ďalej', 40)
  assert.ok(cut.endsWith('…') && cut.length <= 41, cut)
  assert.ok('Jedna veľmi dlhá veta bez konca ktorá pokračuje'.startsWith(cut.slice(0, -1)), 'ends after a whole word')
})

test('the registry allows only registered media files, by an opaque id', () => {
  const e = registerMedia(REEL)
  assert.match(e.id, /^m[0-9a-f]{16}$/)
  assert.equal(registerMedia(REEL).id, e.id, 'the same file keeps its id')
  assert.equal(mediaFile(e.id), REEL)
  assert.deepEqual(mediaItem(e), { id: e.id, kind: 'video', name: 'jarvis-reel.mp4', url: `/api/media/${e.id}` })
  assert.equal(registerMedia(join(HOME, 'tajne.txt')), null, 'not a media file')
  assert.equal(registerMedia(join(HOME, 'nie.mp4')), null, 'not there')
  assert.equal(mediaFile('m0000000000000000'), null)
  assert.equal(mediaFile('../../etc/passwd'), null)
  const old = registerMedia(SONG, { ttlMs: -1 })
  assert.equal(mediaFile(old.id), null, 'expired')
  const { items, skipped } = registerPaths([REEL, PHOTO, join(HOME, 'tajne.txt'), 'neexistuje.mov'])
  assert.deepEqual(items.map((i) => i.kind), ['video', 'image'])
  assert.deepEqual(skipped, ['tajne.txt', 'neexistuje.mov'])
})

test('cards carry media only from the server\'s own addresses', () => {
  const r = normalizeCard(
    {
      kind: 'text',
      title: 'Reel',
      text: 'Video je hotové.',
      media: [
        { kind: 'video', url: '/api/jobs/j3/file/0', name: 'reel.mp4' },
        { kind: 'image', url: '/api/media/m0123456789abcdef', name: 'a.png' },
        { kind: 'image', url: 'https://evil.example/x.png' },
        { kind: 'image', url: '/api/attachment?path=../../x' },
        { kind: 'script', url: '/api/media/m0123456789abcdef' },
      ],
    },
    'c1',
  )
  assert.equal(r.ok, true)
  assert.deepEqual(r.card.media.map((m) => m.url), ['/api/jobs/j3/file/0', '/api/media/m0123456789abcdef'])
  const only = normalizeCard({ kind: 'media', title: '2 súbory', media: [{ kind: 'image', url: '/api/media/m0123456789abcdef' }] }, 'c2')
  assert.equal(only.ok, true)
  assert.equal(normalizeCard({ kind: 'media', title: 'x', media: [{ kind: 'image', url: '/etc/passwd' }] }, 'c3').ok, false)
})

test('show_media is allowed to the voice brain', () => {
  assert.ok(allowedTools().includes('mcp__jarvis-hud__show_media'))
})

test('the show_media tool sends the paths to the HUD and answers without them', async () => {
  const got = []
  const hud = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      got.push({ path: req.url, token: req.headers['x-brain-token'], body: JSON.parse(body) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, shown: [{ kind: 'video', name: 'jarvis-reel.mp4' }, { kind: 'image', name: 'a.png' }], skipped: [] }))
    })
  })
  await new Promise((r) => hud.listen(0, '127.0.0.1', r))
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'hud', 'server', 'mcp', 'jarvis-hud.mjs')], {
    env: { ...process.env, HUD_URL: `http://127.0.0.1:${hud.address().port}`, HUD_BRAIN_TOKEN: 'tok' },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const replies = new Map()
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const m = JSON.parse(line)
      replies.get(m.id)?.(m)
    } catch {
      // not ours
    }
  })
  const rpc = (id, method, params = {}) =>
    new Promise((done) => {
      replies.set(id, done)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  try {
    await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    const list = await rpc(2, 'tools/list')
    const tool = list.result.tools.find((t) => t.name === 'show_media')
    assert.ok(tool, 'listed')
    assert.deepEqual(tool.inputSchema.required, ['paths'])
    const call = await rpc(3, 'tools/call', { name: 'show_media', arguments: { paths: [REEL, PHOTO], title: 'Reel' } })
    assert.equal(got.length, 1)
    assert.equal(got[0].path, '/api/brain/hud')
    assert.equal(got[0].token, 'tok')
    assert.deepEqual(got[0].body, { action: 'media', paths: [REEL, PHOTO], title: 'Reel' })
    const text = call.result.content.map((c) => c.text).join(' ')
    assert.match(text, /1 video, 1 fotky/)
    assert.ok(!text.includes(HOME), 'no path in the answer')
  } finally {
    child.kill()
    hud.close()
  }
})

// ── the server: a finished job's media, the allowlist, Range, MIME, remote reads ──

async function freePort() {
  return new Promise((done) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => done(port))
    })
  })
}

function raw(port, path, headers = {}) {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', fail)
    req.end()
  })
}

test('a finished job shows its media: thumbnails in the card, only its own files, Range and MIME', async (t) => {
  const port = await freePort()
  const data = join(TMP, 'srv')
  const child = spawn(process.execPath, ['hud/server.mjs'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), JARVIS_DATA_DIR: join(data, 'data'), JARVIS_MEMORY_DIR: join(data, 'memory'), JARVIS_SECONDARY: '1', JARVIS_MOCK: '1', JARVIS_MOCK_STEP_MS: '30', JARVIS_BRAIN_AUTOSTART: '0', JARVIS_NO_WATCH: '1', JARVIS_STT: 'browser', JARVIS_LOCAL_VOICE: '0', JARVIS_TELEMETRY: '0', JARVIS_NO_MOVE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  t.after(() => child.kill())
  const base = `http://127.0.0.1:${port}`
  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    try {
      up = (await fetch(`${base}/api/health`)).ok
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  assert.ok(up, out)

  const res = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: `Sprav reel "${REEL}" a fotku "${PHOTO}"`, title: 'Reel', mock: true, silent: true }) })
  const { job } = await res.json()
  let done = null
  for (let i = 0; i < 200 && !done; i++) {
    const list = await (await fetch(`${base}/api/jobs`)).json()
    done = list.find((j) => j.id === job.id && j.status === 'done') ?? null
    if (!done) await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(done, 'the mock job finished')
  assert.deepEqual(done.artifacts.map((a) => [a.kind, a.name, a.url]), [
    ['video', 'jarvis-reel.mp4', `/api/jobs/${job.id}/file/0`],
    ['image', 'more ráno.JPG', `/api/jobs/${job.id}/file/1`],
  ])
  assert.ok(!JSON.stringify(done).includes(HOME), 'no local path reaches the page')
  assert.ok(!done.summary.endsWith('…'))

  // The chat card of the result: thumbnails instead of paths.
  let card = null
  for (let i = 0; i < 60 && !card; i++) {
    const history = await (await fetch(`${base}/api/chat/history`)).json()
    card = (Array.isArray(history) ? history : history.items ?? history.turns ?? []).flatMap((h) => h.cards ?? []).find((c) => c.media?.length) ?? null
    if (!card) await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(card, 'a card with media')
  assert.deepEqual(card.media.map((m) => m.kind), ['video', 'image'])
  assert.ok(!card.text.includes(HOME) && !card.text.endsWith('…'), card.text)

  const video = await raw(port, `/api/jobs/${job.id}/file/0`, { range: 'bytes=100-199' })
  assert.equal(video.status, 206)
  assert.equal(video.headers['content-type'], 'video/mp4')
  assert.equal(video.headers['content-range'], `bytes 100-199/${VIDEO_BYTES.length}`)
  assert.deepEqual(video.body, VIDEO_BYTES.subarray(100, 200))
  const photo = await raw(port, `/api/jobs/${job.id}/file/1`)
  assert.equal(photo.status, 200)
  assert.equal(photo.headers['content-type'], 'image/jpeg')

  assert.equal((await raw(port, `/api/jobs/${job.id}/file/5`)).status, 404, 'not one of its files')
  assert.equal((await raw(port, `/api/jobs/${job.id}/file/..%2F..%2Fetc%2Fpasswd`)).status, 404)
  assert.equal((await raw(port, '/api/media/m0123456789abcdef')).status, 404)
  assert.equal((await raw(port, '/api/media/..%2F..%2Fetc%2Fpasswd')).status, 404)
  // From outside without the phone's login nothing is served.
  const outside = { 'cf-connecting-ip': '198.51.100.20', 'x-forwarded-proto': 'https' }
  assert.notEqual((await raw(port, `/api/jobs/${job.id}/file/0`, outside)).status, 206)
  assert.notEqual((await raw(port, `/api/jobs/${job.id}/file/0`, outside)).status, 200)
})
