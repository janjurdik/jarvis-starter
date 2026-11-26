import { TMP } from './setup.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { Limiter, RemoteAuth, clientIp, deviceName, hashPassword, isPage, openPath, readCookie, safeNext, verifyPassword } from '../hud/server/remote.mjs'
import { isConnected, parseError, parseQuickUrl, releaseAsset } from '../hud/server/tunnel.mjs'

const FAST = { N: 1024, r: 8, p: 1, keylen: 64 }
const PASSWORD = 'Kocur-na-strome-42'

function makeAuth(name, now = () => Date.now()) {
  const dir = join(TMP, `remote-${name}`)
  mkdirSync(dir, { recursive: true })
  return new RemoteAuth({ file: join(dir, 'remote.json'), tokenFile: join(dir, 'tunnel-token'), now, scryptParams: FAST })
}

/** A request as the auth module sees it: headers and the socket's address. */
const fakeReq = (headers = {}, ip = '127.0.0.1') => ({ headers, socket: { remoteAddress: ip } })
function fakeRes() {
  const headers = {}
  return { headers, headersSent: false, setHeader: (k, v) => (headers[k.toLowerCase()] = v) }
}
const tokenOf = (cookie) => /jarvis_session=([^;]+)/.exec(cookie)[1]

test('password: scrypt with a salt, right and wrong password, no account', async () => {
  const a = await hashPassword(PASSWORD, FAST)
  const b = await hashPassword(PASSWORD, FAST)
  assert.equal(a.algo, 'scrypt')
  assert.notEqual(a.salt, b.salt)
  assert.notEqual(a.hash, b.hash)
  assert.ok(!JSON.stringify(a).includes(PASSWORD))
  assert.equal(await verifyPassword(PASSWORD, a), true)
  assert.equal(await verifyPassword('Kocur-na-strome-43', a), false)
  assert.equal(await verifyPassword(PASSWORD, null), false)
})

test('credentials: checks, hash on disk only, a new password logs every device out', async () => {
  const auth = makeAuth('creds')
  await assert.rejects(auth.setCredentials({ email: 'nie-je-email' }), /E-mail/)
  await assert.rejects(auth.setCredentials({ email: 'ja@example.com', password: 'kratke', password2: 'kratke' }), /aspoň 10/)
  await assert.rejects(auth.setCredentials({ email: 'ja@example.com', password: PASSWORD, password2: 'iné heslo 12345' }), /nezhodujú/)
  await assert.rejects(auth.setCredentials({ email: 'ja@example.com', password: 'aaaaaaaaaaaa', password2: 'aaaaaaaaaaaa' }), /uhádnuť/)
  await assert.rejects(auth.setEnabled(true), /e-mail a heslo/)
  await auth.setCredentials({ email: ' Ja@Example.com ', password: PASSWORD, password2: PASSWORD })
  assert.equal(auth.summary().email, 'ja@example.com')
  assert.equal(auth.summary().hasPassword, true)
  const disk = (await import('node:fs')).readFileSync(auth.file, 'utf8')
  assert.ok(!disk.includes(PASSWORD))
  if (process.platform !== 'win32') assert.equal(statSync(auth.file).mode & 0o777, 0o600)
  await auth.setEnabled(true)
  const r = await auth.login({ email: 'ja@example.com', password: PASSWORD, ip: '1.1.1.1', agent: 'iPhone Safari/604' })
  assert.equal(r.ok, true)
  assert.equal(auth.summary().devices.length, 1)
  await auth.setCredentials({ password: 'Nove-heslo-pre-mobil', password2: 'Nove-heslo-pre-mobil' })
  assert.equal(auth.summary().devices.length, 0)
  assert.ok(!JSON.stringify(auth.summary()).includes('hash'))
})

test('sessions: cookie flags, lookup, 30 days sliding, logout, turning off closes all', async () => {
  let clock = Date.parse('2026-11-01T10:00:00Z')
  const auth = makeAuth('sessions', () => clock)
  await auth.setCredentials({ email: 'ja@example.com', password: PASSWORD, password2: PASSWORD })
  await auth.setEnabled(true)
  const bad = await auth.login({ email: 'ja@example.com', password: 'zle heslo 1234', ip: '2.2.2.2' })
  assert.deepEqual([bad.ok, bad.status], [false, 401])
  const wrongMail = await auth.login({ email: 'iny@example.com', password: PASSWORD, ip: '2.2.2.3' })
  assert.equal(wrongMail.error, bad.error)
  const r = await auth.login({ email: 'JA@example.com', password: PASSWORD, ip: '2.2.2.2', agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1' })
  assert.equal(r.ok, true)
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) assert.ok(r.cookie.includes(flag), flag)
  const token = tokenOf(r.cookie)
  assert.equal(token.length, 43)
  // Only the hash of the token is stored.
  assert.ok(!(await import('node:fs')).readFileSync(auth.file, 'utf8').includes(token))
  const req = fakeReq({ cookie: `other=1; jarvis_session=${token}` })
  assert.equal(auth.sessionFor(req)?.device, 'iPhone, Safari')
  assert.equal(auth.sessionFor(fakeReq({ cookie: `jarvis_session=${'x'.repeat(43)}` })), null)
  assert.equal(auth.sessionFor(fakeReq({})), null)
  // Used again after 20 days: still valid, and the cookie is renewed for another 30.
  clock += 20 * 86_400_000
  const res = fakeRes()
  assert.ok(auth.sessionFor(req, res))
  assert.match(res.headers['set-cookie'] ?? '', /Max-Age=2592000/)
  clock += 25 * 86_400_000
  assert.ok(auth.sessionFor(req), 'sliding: 25 days after the last use it still holds')
  clock += 31 * 86_400_000
  assert.equal(auth.sessionFor(req), null, '31 days unused: gone')
  const again = await auth.login({ email: 'ja@example.com', password: PASSWORD, ip: '2.2.2.2' })
  const req2 = fakeReq({ cookie: `jarvis_session=${tokenOf(again.cookie)}` })
  await auth.logout(req2)
  assert.equal(auth.sessionFor(req2), null)
  const third = await auth.login({ email: 'ja@example.com', password: PASSWORD, ip: '2.2.2.2' })
  const req3 = fakeReq({ cookie: `jarvis_session=${tokenOf(third.cookie)}` })
  await auth.setEnabled(false)
  assert.equal(auth.sessionFor(req3), null)
  await auth.setEnabled(true)
  assert.equal(auth.sessionFor(req3), null, 'turning it off logged the device out for good')
  assert.equal((await auth.login({ email: 'ja@example.com', password: PASSWORD })).ok, true)
  await auth.setEnabled(false)
  assert.equal((await auth.login({ email: 'ja@example.com', password: PASSWORD })).status, 403)
})

test('limiter: five tries, then a doubling wait per address, and a lock for everybody', () => {
  const l = new Limiter({ free: 5, base: 30_000, globalMax: 12, globalLock: 600_000 })
  let t = 1_000_000
  for (let i = 0; i < 5; i++) {
    assert.equal(l.check('9.9.9.9', t).ok, true)
    l.fail('9.9.9.9', t)
  }
  assert.deepEqual(l.check('9.9.9.9', t), { ok: false, retryAfter: 30 })
  t += 31_000
  assert.equal(l.check('9.9.9.9', t).ok, true)
  l.fail('9.9.9.9', t)
  assert.equal(l.check('9.9.9.9', t).retryAfter, 60)
  assert.equal(l.check('8.8.8.8', t).ok, true, 'another address is not punished')
  l.success('9.9.9.9')
  assert.equal(l.check('9.9.9.9', t).ok, true)
  // Many addresses together: the login closes for everybody.
  for (let i = 0; i < 12; i++) l.fail(`10.0.0.${i}`, t)
  const g = l.check('8.8.8.8', t)
  assert.equal(g.ok, false)
  assert.equal(g.global, true)
  assert.equal(g.retryAfter, 600)
  // One check at a time per address.
  const busy = new Limiter()
  busy.begin('7.7.7.7')
  assert.equal(busy.check('7.7.7.7', t).busy, true)
  busy.end('7.7.7.7')
  assert.equal(busy.check('7.7.7.7', t).ok, true)
})

test('login answers 429 while an address waits, also for the right password', async () => {
  const auth = makeAuth('brute')
  await auth.setCredentials({ email: 'ja@example.com', password: PASSWORD, password2: PASSWORD })
  await auth.setEnabled(true)
  for (let i = 0; i < 5; i++) assert.equal((await auth.login({ email: 'ja@example.com', password: `zle-heslo-${i}x`, ip: '6.6.6.6' })).status, 401)
  const locked = await auth.login({ email: 'ja@example.com', password: PASSWORD, ip: '6.6.6.6' })
  assert.equal(locked.status, 429)
  assert.ok(locked.retryAfter > 0)
  assert.equal((await auth.login({ email: 'ja@example.com', password: PASSWORD, ip: '5.5.5.5' })).ok, true)
})

test('gate helpers: open paths, pages, next, client address, device names', () => {
  assert.equal(openPath('GET', '/m/login.html'), true)
  assert.equal(openPath('GET', '/m/manifest.json'), true)
  assert.equal(openPath('GET', '/m/app.js'), false)
  assert.equal(openPath('GET', '/api/status'), false)
  assert.equal(openPath('POST', '/api/remote/login'), true)
  assert.equal(openPath('POST', '/api/remote/settings'), false)
  assert.equal(isPage('/'), true)
  assert.equal(isPage('/m/'), true)
  assert.equal(isPage('/guide/index.html'), true)
  assert.equal(isPage('/api/chat/history'), false)
  assert.equal(isPage('/js/main.js'), false)
  assert.equal(safeNext('/m/?x=1'), '/m/?x=1')
  assert.equal(safeNext('//evil.example'), '/')
  assert.equal(safeNext('/\\evil.example'), '/')
  assert.equal(safeNext('https://evil.example'), '/')
  assert.equal(clientIp(fakeReq({ 'cf-connecting-ip': '203.0.113.7' })), '203.0.113.7')
  assert.equal(clientIp(fakeReq({ 'cf-connecting-ip': '203.0.113.7' }, '192.168.1.20')), '192.168.1.20', 'only a request from this computer may name another address')
  assert.equal(readCookie(fakeReq({ cookie: 'a=1; jarvis_session=abc' })), 'abc')
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36'), 'Android, Chrome')
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/141.0 Mobile/15E148 Safari/604.1'), 'iPhone, Chrome')
})

test('tunnel token and hostname: checked, stored apart, never in the summary', async () => {
  const auth = makeAuth('named')
  await assert.rejects(auth.setTunnel({ hostname: 'nie je adresa' }), /tvar/)
  await assert.rejects(auth.setTunnel({ token: 'kratky' }), /Token/)
  const token = `eyJhIjoi${'x'.repeat(150)}`
  await auth.setTunnel({ mode: 'named', hostname: 'https://Jarvis.Example.com/', token: `cloudflared tunnel run --token ${token}` })
  assert.equal(auth.tunnelConfig().hostname, 'jarvis.example.com')
  assert.equal(auth.tunnelConfig().token, token)
  const summary = JSON.stringify(auth.summary())
  assert.ok(!summary.includes(token))
  assert.equal(auth.summary().hasToken, true)
  assert.ok(!(await import('node:fs')).readFileSync(auth.file, 'utf8').includes(token))
})

test('cloudflared output: quick address, connection, errors without secrets', () => {
  const box = '2026-11-26T11:53:02Z INF |  https://bargain-cover-logistics-juice.trycloudflare.com                                  |'
  assert.equal(parseQuickUrl(box), 'https://bargain-cover-logistics-juice.trycloudflare.com')
  assert.equal(parseQuickUrl('2026-11-26T11:53:02Z INF Requesting new quick Tunnel on trycloudflare.com...'), null)
  assert.equal(parseQuickUrl('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp'), null)
  assert.equal(isConnected('2026-11-26T11:53:04Z INF Registered tunnel connection connIndex=0 connection=e4ec98e0 event=0 ip=198.41.200.13 location=ams19 protocol=quic'), true)
  assert.equal(isConnected('2026-11-26T11:53:04Z INF Starting tunnel tunnelID=abc'), false)
  assert.equal(parseError('2026-11-26T11:53:04Z INF Starting metrics server'), null)
  const err = parseError(`2026-11-26T11:53:04Z ERR Provided Tunnel token is not valid. token=${'A'.repeat(120)}`)
  assert.match(err, /^Provided Tunnel token is not valid/)
  assert.ok(!err.includes('A'.repeat(60)))
  assert.equal(releaseAsset('darwin', 'arm64').name, 'cloudflared-darwin-arm64.tgz')
  assert.equal(releaseAsset('win32', 'x64').name, 'cloudflared-windows-amd64.exe')
  assert.equal(releaseAsset('linux', 'arm64').name, 'cloudflared-linux-arm64')
})

// ── the real server: localhost without a password, everything from outside only with a login ──

function freePort() {
  return new Promise((done) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => done(port))
    })
  })
}

async function startServer(env) {
  const port = await freePort()
  const child = spawn(process.execPath, ['hud/server.mjs'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, ...env, PORT: String(port), JARVIS_SECONDARY: '1', JARVIS_MOCK: '1', JARVIS_BRAIN_AUTOSTART: '0', JARVIS_NO_WATCH: '1', JARVIS_STT: 'browser' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { base, port, child, log: () => out }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  child.kill()
  throw new Error(`server did not start:\n${out}`)
}

/** One HTTP request with any headers; the answer reads like a fetch Response (status, headers.get, json). */
function raw(port, method, path, headers = {}, body = null) {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = ''
      res.on('data', (d) => (data += d))
      res.on('end', () => {
        const h = res.headers
        done({ status: res.statusCode, headers: { get: (k) => (Array.isArray(h[k.toLowerCase()]) ? h[k.toLowerCase()].join(', ') : h[k.toLowerCase()] ?? null) }, json: async () => JSON.parse(data) })
      })
    })
    req.on('error', fail)
    if (body) req.write(body)
    req.end()
  })
}

/** A request the way one comes through the tunnel: from 127.0.0.1, with Cloudflare's headers. */
const remote = (extra = {}) => ({ 'cf-connecting-ip': '198.51.100.20', 'x-forwarded-proto': 'https', ...extra })

test('server: localhost stays open, outside needs the login, account endpoints stay local', { skip: process.platform === 'win32' }, async (t) => {
  const dir = join(TMP, 'server-a')
  mkdirSync(join(dir, 'data'), { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'jarvis.json'), JSON.stringify({ name: 'Test' }))
  // A stand-in for cloudflared: says what the real one says and waits.
  const fake = join(dir, 'cloudflared')
  writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "cloudflared version 2026.9.1 (built x)"; exit 0; fi\necho "INF |  https://fake-quick-words.trycloudflare.com  |" >&2\nsleep 0.3\necho "INF Registered tunnel connection connIndex=0 location=test protocol=quic" >&2\nexec sleep 600\n')
  chmodSync(fake, 0o755)
  const s = await startServer({ JARVIS_DATA_DIR: join(dir, 'data'), JARVIS_MEMORY_DIR: join(dir, 'memory'), JARVIS_CONFIG: join(dir, 'jarvis.json'), JARVIS_CLOUDFLARED: fake })
  t.after(() => s.child.kill())
  // node:http, not fetch: fetch does not let a test set the Host header a tunnel sends.
  const get = (path, headers = {}) => raw(s.port, 'GET', path, headers)
  const post = (path, body, headers = {}) => raw(s.port, 'POST', path, { 'content-type': 'application/json', ...headers }, JSON.stringify(body))
  const origin = { origin: s.base }

  // This computer: no password, as always.
  assert.equal((await get('/api/status')).status, 200)
  assert.equal((await post('/api/chat', { text: 'ahoj', mock: true })).status, 202)

  // Outside without a login: the login page and its assets, nothing else.
  assert.equal((await get('/api/status', remote())).status, 401)
  assert.equal((await get('/api/chat/history', remote())).status, 401)
  assert.equal((await post('/api/chat', { text: 'x', mock: true }, remote())).status, 401)
  const page = await get('/', remote())
  assert.equal(page.status, 302)
  assert.match(page.headers.get('location'), /^\/m\/login\.html\?next=%2F$/)
  assert.equal((await get('/m/login.html', remote())).status, 200)
  assert.equal((await get('/m/manifest.json', remote())).status, 200)
  assert.equal((await get('/apple-touch-icon.png', remote())).status, 200)
  assert.equal((await get('/m/app.js', remote())).status, 401)
  assert.equal((await get('/tts/abc.mp3', remote())).status, 401)

  // The password is set from the Settings page only (a browser sends Origin), never from outside.
  assert.equal((await post('/api/remote/settings', { email: 'ja@example.com' })).status, 403)
  const set = await post('/api/remote/settings', { email: 'ja@example.com', password: PASSWORD, password2: PASSWORD }, origin)
  assert.equal(set.status, 200)
  assert.equal((await set.json()).hasPassword, true)
  // Off: no login yet.
  assert.equal((await post('/api/remote/login', { email: 'ja@example.com', password: PASSWORD }, remote())).status, 403)

  // The tunnel host is unknown until the tunnel runs.
  const tunnelHost = { host: 'fake-quick-words.trycloudflare.com' }
  assert.equal((await get('/api/status', remote(tunnelHost))).status, 421)
  const started = await (await post('/api/remote/tunnel', { action: 'start' })).json()
  assert.equal(started.enabled, true)
  let st = started
  for (let i = 0; i < 50 && st.tunnel?.state !== 'running'; i++) {
    await new Promise((r) => setTimeout(r, 100))
    st = await (await get('/api/remote/status')).json()
  }
  assert.equal(st.tunnel.state, 'running')
  assert.equal(st.address, 'https://fake-quick-words.trycloudflare.com/')
  assert.equal((await get('/api/status', remote(tunnelHost))).status, 401, 'known host now, still needs the login')

  // Login from outside.
  const wrong = await post('/api/remote/login', { email: 'ja@example.com', password: 'zle-heslo-123' }, remote(tunnelHost))
  assert.equal(wrong.status, 401)
  const ok = await post('/api/remote/login', { email: 'ja@example.com', password: PASSWORD }, remote({ ...tunnelHost, 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1' }))
  assert.equal(ok.status, 200)
  const cookie = ok.headers.get('set-cookie')
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(cookie.includes(flag), flag)
  const session = { ...tunnelHost, cookie: cookie.split(';')[0] }

  // With the session: what a local page gets.
  assert.equal((await get('/api/status', remote(session))).status, 200)
  assert.equal((await get('/api/chat/history', remote(session))).status, 200)
  assert.equal((await post('/api/chat', { text: 'Čo mám dnes?', mock: true }, remote({ ...session, origin: 'https://fake-quick-words.trycloudflare.com' }))).status, 202)
  assert.equal((await post('/api/chat', { text: 'x', mock: true }, remote({ ...session, origin: 'https://evil.example' }))).status, 403, 'CSRF: a foreign origin is refused')
  const phone = await get('/', remote({ ...session, 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1' }))
  assert.equal(phone.status, 302)
  assert.equal(phone.headers.get('location'), '/m/')
  assert.equal((await get('/?hud=1', remote({ ...session, 'user-agent': 'iPhone Mobile' }))).status, 200)
  assert.equal((await get('/m/', remote(session))).status, 200)
  const css = await get('/m/m.css', remote(session))
  assert.match(css.headers.get('cache-control'), /^private/, 'nothing from the tunnel may be cached by Cloudflare')

  // But never what changes the remote access, nor the internal endpoints.
  const o = { ...session, origin: 'https://fake-quick-words.trycloudflare.com' }
  assert.equal((await post('/api/remote/settings', { password: 'Ine-heslo-12345', password2: 'Ine-heslo-12345' }, remote(o))).status, 403)
  assert.equal((await post('/api/remote/tunnel', { action: 'stop' }, remote(o))).status, 403)
  assert.equal((await post('/api/remote/logout-all', {}, remote(o))).status, 403)
  assert.equal((await post('/api/announce', { text: 'x' }, remote(o))).status, 403)
  assert.equal((await post('/api/event', { text: 'x' }, remote(o))).status, 403)
  assert.equal((await post('/api/restart', {}, remote(o))).status, 403)
  const remoteView = await (await get('/api/remote/status', remote(session))).json()
  assert.deepEqual(Object.keys(remoteView).sort(), ['address', 'enabled', 'local', 'ok'])

  // The event stream over a WebSocket: with the session yes, without it no.
  const { default: WebSocket } = await import('ws')
  const wsOpen = (headers) =>
    new Promise((done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${s.port}/api/events/ws?client=phone`, { headers })
      ws.on('message', (m) => {
        if (String(m).includes('event: you')) {
          ws.close()
          done('stream')
        }
      })
      ws.on('unexpected-response', (_q, r) => done(r.statusCode))
      ws.on('error', () => done('error'))
    })
  assert.equal(await wsOpen(remote(tunnelHost)), 403)
  assert.equal(await wsOpen(remote(session)), 'stream')

  // Logout everywhere from this computer.
  const all = await (await post('/api/remote/logout-all', {})).json()
  assert.equal(all.count, 1)
  assert.equal((await get('/api/status', remote(session))).status, 401)

  // The tunnel stops: its host is unknown again.
  await post('/api/remote/tunnel', { action: 'stop' })
  assert.equal((await get('/api/status', remote(tunnelHost))).status, 421)
})
