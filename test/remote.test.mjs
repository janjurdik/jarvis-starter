import { TMP } from './setup.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEVICE_COOKIE, Limiter, RemoteAuth, addressKey, clientIp, deviceName, hashPassword, isPage, openPath, passwordProblem, placeHint, readCookie, safeNext, sessionToken, verifyPassword } from '../hud/server/remote.mjs'
import { CLOUDFLARED_SHA256, CLOUDFLARED_VERSION, QUICK_CONFIG, isConnected, parseError, parseQuickUrl, releaseAsset, releaseUrl, verifyAsset } from '../hud/server/tunnel.mjs'

const FAST = { N: 1024, r: 8, p: 1, keylen: 64 }
const PASSWORD = 'Kocur-na-strome-42'

function makeAuth(name, now = () => Date.now(), extra = {}) {
  const dir = join(TMP, `remote-${name}`)
  mkdirSync(dir, { recursive: true })
  return new RemoteAuth({ file: join(dir, 'remote.json'), tokenFile: join(dir, 'tunnel-token'), now, scryptParams: FAST, ...extra })
}

/** A request as the auth module sees it: headers and the socket's address. */
const fakeReq = (headers = {}, ip = '127.0.0.1') => ({ headers, socket: { remoteAddress: ip } })
function fakeRes() {
  const headers = {}
  return { headers, headersSent: false, setHeader: (k, v) => (headers[k.toLowerCase()] = v) }
}
const tokenOf = (cookie) => /jarvis_session=([^;]+)/.exec(cookie)[1]
const deviceOf = (cookie) => /__Host-jarvis_device=([^;]+)/.exec(cookie)[1]

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
  await assert.rejects(auth.setCredentials({ email: 'ja@example.com', password: 'kratke', password2: 'kratke' }), /aspoň 12/)
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
  // A phone of 1.10.0 (cookie without the __Host- prefix) moves to the new name and the old one is cleared.
  assert.match(String(res.headers['set-cookie'] ?? ''), /__Host-jarvis_session=[^;]+; Path=\/; Max-Age=2592000/)
  assert.match(String(res.headers['set-cookie'] ?? ''), /(^|,)jarvis_session=; Path=\/; Max-Age=0/)
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

test('addresses: IPv4 per address, IPv6 per /64, mapped IPv4 as IPv4', () => {
  assert.equal(addressKey('203.0.113.7'), '203.0.113.7')
  assert.equal(addressKey('::ffff:203.0.113.7'), '203.0.113.7')
  assert.equal(addressKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64')
  assert.equal(addressKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64')
  assert.equal(addressKey('[2001:db8:1:2::9]'), '2001:db8:1:2::/64')
  assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/64')
  assert.notEqual(addressKey('2001:db8:1:3::1'), addressKey('2001:db8:1:2::1'))
})

test('login brakes count a whole IPv6 /64 as one address', async () => {
  const auth = makeAuth('v6')
  await auth.setCredentials({ email: 'ja@example.com', password: PASSWORD, password2: PASSWORD })
  await auth.setEnabled(true)
  // Five wrong tries, each from another address of the same /64.
  for (let i = 1; i <= 5; i++) assert.equal((await auth.login({ email: 'ja@example.com', password: `zle-heslo-${i}x`, ip: `2001:db8:aa:bb::${i.toString(16)}` })).status, 401)
  const next = await auth.login({ email: 'ja@example.com', password: PASSWORD, ip: '2001:db8:aa:bb:ffff::77' })
  assert.equal(next.status, 429, 'a new address in the same /64 is braked too')
  assert.equal((await auth.login({ email: 'ja@example.com', password: PASSWORD, ip: '2001:db8:aa:cc::1' })).ok, true, 'another /64 is not')
})

test('known device: logs in while the login is closed for everybody, survives logout, forgotten by logout-all and a new password', async () => {
  const events = []
  let clock = Date.parse('2026-11-26T12:00:00Z')
  const limiter = new Limiter({ globalMax: 6, onLock: (x) => events.push(['lock', x.ms]) })
  const auth = makeAuth('known', () => clock, { limiter, onEvent: (kind, info) => events.push([kind, info.device ?? null]) })
  await auth.setCredentials({ email: 'ja@example.com', password: PASSWORD, password2: PASSWORD })
  await auth.setEnabled(true)
  assert.deepEqual(events.shift(), ['credentials', null])
  const phone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1'
  const first = await auth.login({ email: 'ja@example.com', password: PASSWORD, ip: '198.51.100.1', agent: phone })
  assert.equal(first.ok, true)
  assert.equal(first.newDevice, true)
  assert.deepEqual(events.shift(), ['device', 'iPhone, Safari'], 'a new device is announced')
  for (const flag of ['__Host-jarvis_device=', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${400 * 86400}`]) assert.ok(first.deviceCookie.includes(flag), flag)
  const dev = deviceOf(first.deviceCookie)
  assert.ok(!(await import('node:fs')).readFileSync(auth.file, 'utf8').includes(dev), 'only the hash of the device token is stored')
  await auth.logout(fakeReq({ cookie: `__Host-jarvis_session=${tokenOf(first.cookie)}` }))
  // Strangers from six addresses close the login for everybody.
  for (let i = 0; i < 6; i++) await auth.login({ email: 'ja@example.com', password: `utok-${i}-heslo`, ip: `203.0.113.${i}` })
  assert.deepEqual(events.shift(), ['lock', 600_000])
  const stranger = await auth.login({ email: 'ja@example.com', password: PASSWORD, ip: '192.0.2.9' })
  assert.equal(stranger.status, 429, 'a new device waits like everybody')
  assert.ok(auth.summary().lock?.until > clock)
  // Even when the shared checks are all busy, the known device has its own slot.
  for (let i = 0; i < 4; i++) limiter.begin(`busy-${i}`)
  const owner = await auth.login({ email: 'ja@example.com', password: PASSWORD, ip: '192.0.2.9', agent: phone, deviceToken: dev })
  assert.equal(owner.ok, true, 'the owner with a known device gets in during the lock')
  assert.equal(owner.newDevice, false)
  assert.equal(deviceOf(owner.deviceCookie), dev, 'the same device cookie, renewed')
  assert.equal(events.length, 0, 'a known device is not announced again')
  for (let i = 0; i < 4; i++) limiter.end(`busy-${i}`)
  // A known device that guesses wrong is braked on its own, and never closes the login for others.
  for (let i = 0; i < 5; i++) await auth.login({ email: 'ja@example.com', password: `zle-${i}-heslo`, ip: '192.0.2.9', deviceToken: dev })
  assert.equal((await auth.login({ email: 'ja@example.com', password: PASSWORD, ip: '192.0.2.9', deviceToken: dev })).status, 429)
  assert.equal(auth.summary().known.length, 1)
  assert.ok(auth.summary().known[0].lastLogin)
  clock += 2 * 3_600_000
  // "Odhlásiť všetky zariadenia" forgets known devices.
  await auth.logoutAll()
  assert.equal(auth.summary().known.length, 0)
  const again = await auth.login({ email: 'ja@example.com', password: PASSWORD, ip: '192.0.2.10', agent: phone, deviceToken: dev })
  assert.equal(again.newDevice, true, 'after logout-all the old device cookie is worth nothing')
  assert.deepEqual(events.shift(), ['device', 'iPhone, Safari'])
  // A new password forgets them too.
  await auth.setCredentials({ password: 'Nove-heslo-pre-mobil', password2: 'Nove-heslo-pre-mobil' })
  assert.deepEqual(events.shift(), ['credentials', null])
  assert.equal(auth.summary().known.length, 0)
})

test('the lock for everybody grows on repeat and is forgotten after a quiet day', () => {
  const locks = []
  const l = new Limiter({ globalMax: 3, globalLock: 600_000, onLock: (x) => locks.push(x.ms) })
  let t = 10_000_000
  const flood = () => {
    for (let i = 0; i < 3; i++) l.fail(`10.1.${locks.length}.${i}`, t)
  }
  flood()
  assert.equal(l.check('1.2.3.4', t).retryAfter, 600)
  t += 601_000
  assert.equal(l.check('1.2.3.4', t).ok, true)
  flood()
  assert.equal(l.check('1.2.3.4', t).retryAfter, 1200)
  t += 1_201_000
  flood()
  assert.equal(l.check('1.2.3.4', t).retryAfter, 2400)
  assert.deepEqual(locks, [600_000, 1_200_000, 2_400_000], 'the owner hears of each lock once')
  assert.equal(l.check('1.2.3.4', t, { known: true }).ok, true, 'a known device passes the lock')
  // A day without a lock: back to 10 minutes.
  t += 2_401_000 + 86_400_000
  flood()
  assert.equal(l.check('1.2.3.4', t).retryAfter, 600)
  // Never longer than the ceiling.
  const seen = []
  const capped = new Limiter({ globalMax: 1, globalLock: 600_000, globalLockMax: 3_600_000, onLock: (x) => seen.push(x.ms) })
  let c = 0
  for (let i = 0; i < 8; i++) {
    capped.fail(`9.9.${i}.1`, c)
    c = capped.globalUntil + 1
  }
  assert.deepEqual(seen, [600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000, 3_600_000, 3_600_000, 3_600_000])
})

test('password policy: 12 characters and three kinds, or 16, never a word with a year', () => {
  assert.match(passwordProblem('Kratke-1'), /aspoň 12/)
  assert.match(passwordProblem('bratislava2024'), /tri z týchto/)
  assert.match(passwordProblem('Bratislava2024'), /rokom na konci/, 'a capital, a word and a year is still a word and a year')
  assert.match(passwordProblem('Bratislava2024!'), /rokom na konci/)
  assert.match(passwordProblem('hesloheslohe'), /tri z týchto/)
  assert.match(passwordProblem('ja@example.com', 'ja@example.com'), /e-mail/)
  assert.match(passwordProblem('aaaaaaaaaaaaaaaaa'), /uhádnuť/)
  assert.equal(passwordProblem('Kocur-na-strome-42'), null)
  assert.equal(passwordProblem('Lietadlo#Kava7'), null)
  assert.equal(passwordProblem('kava lietadlo strom more'), null, 'four words in a row are long enough')
})

test('cloudflared download: a pinned release, SHA-256 for every file Jarvis may fetch, a valid quick config', () => {
  assert.match(CLOUDFLARED_VERSION, /^\d{4}\.\d{1,2}\.\d+$/)
  for (const [os, cpu] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'], ['win32', 'ia32'], ['linux', 'x64'], ['linux', 'arm64'], ['linux', 'arm'], ['linux', 'ia32']]) {
    const a = releaseAsset(os, cpu)
    assert.match(CLOUDFLARED_SHA256[a.name]?.file ?? '', /^[0-9a-f]{64}$/, a.name)
    if (a.tgz) assert.match(CLOUDFLARED_SHA256[a.name].bin, /^[0-9a-f]{64}$/, `${a.name} inner program`)
  }
  assert.equal(releaseUrl('cloudflared-linux-amd64'), `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`)
  assert.throws(() => verifyAsset('cloudflared-linux-amd64', Buffer.from('nie je to cloudflared')), /odtlačok/)
  assert.throws(() => verifyAsset('cloudflared-neznamy', Buffer.from('x')), /nemám overený/)
  // Not empty for cloudflared: one real key besides the comment.
  assert.match(QUICK_CONFIG, /^no-autoupdate: true$/m)
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
  assert.equal(readCookie(fakeReq({ cookie: 'a=1; jarvis_session=abc' }), 'jarvis_session'), 'abc')
  assert.equal(readCookie(fakeReq({ cookie: `__Host-jarvis_session=${'a'.repeat(43)}` })), 'a'.repeat(43))
  assert.deepEqual(sessionToken(fakeReq({ cookie: `jarvis_session=${'b'.repeat(43)}` })), { token: 'b'.repeat(43), legacy: true })
  assert.equal(placeHint(fakeReq({ 'cf-ipcountry': 'sk' })), 'SK')
  assert.equal(placeHint(fakeReq({ 'cf-ipcountry': 'XX' })), '')
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
  const HUD_TOKEN = 'b'.repeat(48)
  const s = await startServer({ JARVIS_DATA_DIR: join(dir, 'data'), JARVIS_MEMORY_DIR: join(dir, 'memory'), JARVIS_CONFIG: join(dir, 'jarvis.json'), JARVIS_CLOUDFLARED: fake, JARVIS_HUD_TOKEN: HUD_TOKEN, JARVIS_ALLOWED_HOSTS: 'jarvis.lan' })
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
  assert.match(cookie, /^__Host-jarvis_session=/, 'the session cookie keeps to this host')
  assert.match(cookie, /__Host-jarvis_device=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict/, 'a known-device cookie comes with the login')

  // The HUD token is for a network opened on purpose, never for the tunnel: there only the login counts.
  const tok = { 'x-hud-token': HUD_TOKEN }
  assert.equal((await get('/api/status', remote({ ...tunnelHost, ...tok }))).status, 401, 'token through the tunnel')
  assert.equal((await get(`/api/status?token=${HUD_TOKEN}`, remote(tunnelHost))).status, 401, '?token= through the tunnel')
  assert.equal((await get('/api/status', { host: tunnelHost.host, ...tok })).status, 401, 'the tunnel host alone marks the tunnel')
  assert.equal((await get('/api/status', { host: 'jarvis.lan', 'cf-ray': '8f00-AMS', ...tok })).status, 401, 'Cloudflare headers alone mark the tunnel')
  assert.equal((await post('/api/chat', { text: 'x', mock: true }, remote({ ...tunnelHost, ...tok, origin: 'https://fake-quick-words.trycloudflare.com' }))).status, 401)
  assert.equal((await get('/api/status', { host: 'jarvis.lan', ...tok })).status, 200, 'on the LAN (HUD_HOST=0.0.0.0) the token still works')
  assert.equal((await get('/api/status', { host: 'jarvis.lan' })).status, 401)
  assert.equal((await get('/api/status', remote({ ...session, ...tok }))).status, 200, 'with the session the token does not matter')

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
  // The token in the address does not open the socket through the tunnel either.
  const tokenWs = await new Promise((done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/api/events/ws?client=phone&token=${HUD_TOKEN}`, { headers: remote(tunnelHost) })
    ws.on('open', () => (ws.close(), done('open')))
    ws.on('unexpected-response', (_q, r) => done(r.statusCode))
    ws.on('error', () => done('error'))
  })
  assert.equal(tokenWs, 403)
  // A socket from outside cannot pose as the desktop or the app (they own the voice and the notifications).
  for (const claim of ['desktop', 'app']) {
    const ws = await new Promise((done, fail) => {
      const w = new WebSocket(`ws://127.0.0.1:${s.port}/api/events/ws?client=${claim}`, { headers: remote(session) })
      w.on('message', (m) => String(m).includes('event: you') && done(w))
      w.on('error', fail)
    })
    const health = await (await get('/api/health')).json()
    assert.equal(health.windows.desktop, 0, `remote ${claim} is not a desktop`)
    assert.equal(health.windows.app, 0, `remote ${claim} is not an app`)
    assert.equal(health.windows.browser, 1)
    ws.close()
    await new Promise((r) => setTimeout(r, 100))
  }
  // Nor tell this computer where Jarvis lives.
  assert.equal((await post('/api/surface/keep', { keep: 'browser' }, remote(o))).status, 403)
  // The top bar knows the door to the phone is open.
  const st2 = await (await get('/api/status')).json()
  assert.deepEqual([st2.remote.on, st2.remote.state, st2.remote.url], [true, 'running', 'https://fake-quick-words.trycloudflare.com'])
  // The Settings page lists the device with its last login.
  const view = await (await get('/api/remote/status')).json()
  assert.equal(view.known.length, 1)
  assert.equal(view.known[0].device, 'iPhone, Safari')
  assert.ok(view.known[0].lastLogin)

  // Logout everywhere from this computer.
  const all = await (await post('/api/remote/logout-all', {})).json()
  assert.equal(all.count, 1)
  assert.equal((await get('/api/status', remote(session))).status, 401)

  // The tunnel stops: its host is unknown again.
  await post('/api/remote/tunnel', { action: 'stop' })
  assert.equal((await get('/api/status', remote(tunnelHost))).status, 421)
})
