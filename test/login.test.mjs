/**
 * The login card (hud/server/login.mjs), the Garmin worker's stdin login and open_terminal.
 * Garmin is never contacted: a stand-in library (test/fixtures/garmin-login) answers instead, and
 * a stand-in `uv` starts the worker with the system Python. No terminal window is ever opened.
 */
import { TMP } from './setup.mjs'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { TERMINAL_ACTIONS, psEncode, shQuote, terminalLaunch } from '../hud/server/terminal.mjs'

const REPO = join(import.meta.dirname, '..')
const WORKER = join(REPO, 'hud', 'server', 'garmin', 'garmin_worker.py')
const FAKE_LIB = join(REPO, 'test', 'fixtures', 'garmin-login')
const PASSWORD = 'Spravne-heslo-1'
const WRONG = 'Zle-heslo-Xq7-nikde'
const CODE = '123456'
const BAD_CODE = '654321'

const python = (() => {
  for (const bin of ['python3', 'python']) {
    const r = spawnSync(bin, ['-c', 'import sys; print(sys.version_info >= (3, 10))'], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim() === 'True') return bin
  }
  return null
})()
const NO_PY = python ? false : 'needs Python 3.10 or newer'
const POSIX = process.platform === 'win32' ? 'the stand-in uv is a shell script' : NO_PY

/** The worker's stdin login with the stand-in library: lines in, events out. */
function worker(lines, folder) {
  mkdirSync(folder, { recursive: true })
  const r = spawnSync(python, [WORKER, 'login', '--stdin', '--tokens', folder], { input: lines.map((l) => `${JSON.stringify(l)}\n`).join(''), encoding: 'utf8', env: { ...process.env, PYTHONPATH: FAKE_LIB }, timeout: 30_000 })
  const events = r.stdout.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l))
  return { code: r.status, events, out: r.stdout + r.stderr }
}

// ── the worker ──────────────────────────────────────────────────────────

test('worker stdin login: connected without a code, tokens saved, nothing secret printed', { skip: NO_PY }, () => {
  const dir = join(TMP, 'w-ok')
  const r = worker([{ email: 'ok@example.com', password: PASSWORD }], dir)
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(r.events.map((e) => e.event), ['connected'])
  assert.equal(r.events[0].name, 'Test Bežec')
  assert.ok(existsSync(join(dir, 'garmin_tokens.json')))
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'garmin_tokens.json')).mode & 0o777, 0o600)
  assert.doesNotMatch(r.out, new RegExp(PASSWORD))
  assert.doesNotMatch(r.out, /ok@example\.com/)
})

test('worker stdin login: a one-time code, a wrong one is retried, the right one connects', { skip: NO_PY }, () => {
  const dir = join(TMP, 'w-mfa')
  const r = worker([{ email: 'mfa@example.com', password: PASSWORD }, { code: BAD_CODE }, { code: ` ${CODE} ` }], dir)
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(r.events.map((e) => e.event), ['needs_code', 'error', 'connected'])
  assert.equal(r.events[1].error, 'wrong_code')
  assert.equal(r.events[1].retry, true)
  assert.ok(existsSync(join(dir, 'garmin_tokens.json')))
  for (const secret of [PASSWORD, BAD_CODE, CODE, 'secret-cookie', 'mfa@example.com']) assert.ok(!r.out.includes(secret), `printed ${secret}`)
})

test('worker stdin login: three wrong codes end it', { skip: NO_PY }, () => {
  const r = worker([{ email: 'mfa@example.com', password: PASSWORD }, { code: '1' }, { code: '2' }, { code: '3' }, { code: CODE }], join(TMP, 'w-3codes'))
  assert.equal(r.code, 4)
  assert.deepEqual(r.events.map((e) => e.error ?? e.event), ['needs_code', 'wrong_code', 'wrong_code', 'wrong_code'])
  assert.equal(r.events.at(-1).retry, undefined)
  assert.equal(existsSync(join(TMP, 'w-3codes', 'garmin_tokens.json')), false)
})

test('worker stdin login: wrong password and rate limit are clean answers without the error text', { skip: NO_PY }, () => {
  const wrong = worker([{ email: 'someone@example.com', password: WRONG }], join(TMP, 'w-wrong'))
  assert.equal(wrong.code, 4)
  assert.deepEqual(wrong.events, [{ event: 'error', error: 'wrong_credentials', message: wrong.events[0].message }])
  // The stand-in library puts the password into its error: none of it may come out.
  assert.ok(!wrong.out.includes(WRONG))
  assert.match(wrong.out, /wrong_credentials \(GarminConnectAuthenticationError\)/)
  const limit = worker([{ email: 'limit@example.com', password: WRONG }], join(TMP, 'w-limit'))
  assert.equal(limit.events[0].error, 'rate_limited')
  assert.ok(!limit.out.includes(WRONG))
})

test('worker stdin login: bad input never reaches the library', { skip: NO_PY }, () => {
  assert.equal(worker([{ email: '', password: 'x' }], join(TMP, 'w-bad1')).events[0].error, 'usage')
  assert.equal(worker([{ email: 'a@b.c' }], join(TMP, 'w-bad2')).events[0].error, 'usage')
  const notJson = spawnSync(python, [WORKER, 'login', '--stdin', '--tokens', join(TMP, 'w-bad3')], { input: 'heslo123\n', encoding: 'utf8', env: { ...process.env, PYTHONPATH: FAKE_LIB } })
  assert.match(notJson.stdout, /"usage"/)
  assert.ok(!notJson.stdout.includes('heslo123'))
  // Nothing on stdin and stdin closed: an answer, not a hang.
  const empty = spawnSync(python, [WORKER, 'login', '--stdin', '--tokens', join(TMP, 'w-bad4')], { input: '', encoding: 'utf8', env: { ...process.env, PYTHONPATH: FAKE_LIB }, timeout: 20_000 })
  assert.match(empty.stdout, /"error"/)
})

test('worker: the interactive login still refuses without a terminal and names the card', { skip: NO_PY }, () => {
  const r = spawnSync(python, [WORKER, 'login', '--tokens', join(TMP, 'w-tty')], { input: 'a@b.c\nheslo\n', encoding: 'utf8', env: { ...process.env, PYTHONPATH: FAKE_LIB } })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /kart/i)
})

// ── the server ──────────────────────────────────────────────────────────

/** A stand-in for uv: drops `run --quiet --python 3.12` and starts the worker with the system Python and the stand-in library. */
function fakeUv(dir) {
  const file = join(dir, 'uv')
  writeFileSync(file, `#!/bin/sh\nshift 4\nPYTHONPATH=${shQuote(FAKE_LIB)} exec ${python} "$@"\n`)
  chmodSync(file, 0o755)
  return file
}

function freePort() {
  return new Promise((done) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => done(port))
    })
  })
}

async function startServer(dir, extra = {}) {
  for (const d of ['data', 'memory']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, 'jarvis.json'), JSON.stringify({ name: 'Test' }))
  const port = await freePort()
  const child = spawn(process.execPath, ['hud/server.mjs'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), JARVIS_SECONDARY: '1', JARVIS_MOCK: '1', JARVIS_BRAIN_AUTOSTART: '0', JARVIS_NO_WATCH: '1', JARVIS_STT: 'browser', JARVIS_LOCAL_VOICE: '0', JARVIS_NO_MOVE: '1', JARVIS_TELEMETRY: '0', JARVIS_DATA_DIR: join(dir, 'data'), JARVIS_MEMORY_DIR: join(dir, 'memory'), JARVIS_CONFIG: join(dir, 'jarvis.json'), ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 150; i++) {
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

function raw(port, method, path, headers = {}, body = null) {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = ''
      res.on('data', (d) => (data += d))
      res.on('end', () => done({ status: res.statusCode, text: data, json: () => JSON.parse(data) }))
    })
    req.on('error', fail)
    if (body) req.write(body)
    req.end()
  })
}

/** Everything the event stream sends, as one string. */
function listen(port) {
  let text = ''
  const req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { accept: 'text/event-stream' } }, (res) => res.on('data', (d) => (text += d)))
  req.on('error', () => {})
  req.end()
  return { text: () => text, close: () => req.destroy() }
}

const filesUnder = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]))

test('server: login card end to end, local only, no secret in the stream, the log, the history or any file', { skip: POSIX }, async (t) => {
  const dir = join(TMP, 'srv')
  mkdirSync(dir, { recursive: true })
  const s = await startServer(dir, { UV_BIN: fakeUv(dir) })
  t.after(() => s.child.kill())
  const sse = listen(s.port)
  t.after(() => sse.close())
  await new Promise((r) => setTimeout(r, 300))
  const post = (path, body, headers = {}) => raw(s.port, 'POST', path, { 'content-type': 'application/json', origin: s.base, ...headers }, JSON.stringify(body))

  // The card, as the voice tool asks for it (the same function behind /api/brain/hud action login).
  const shown = await post('/api/login/card', { service: 'garmin' })
  assert.equal(shown.status, 200)
  const card = shown.json().card
  assert.match(card, /^login-[0-9a-f]{12}$/)
  assert.equal((await post('/api/login/card', { service: 'nieco' })).status, 400)

  // Not from the phone, the network or a foreign page: the same request is refused before it is read.
  // (401 and 421 come from the gate in front of every route, 403 from the login route itself.)
  const creds = { card, step: 'credentials', values: { email: 'someone@example.com', password: WRONG } }
  const refused = (r) => assert.ok([401, 403, 421].includes(r.status), `answered ${r.status}`)
  refused(await post('/api/login', creds, { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-proto': 'https' }))
  refused(await post('/api/login', creds, { origin: 'https://evil.example' }))
  refused(await post('/api/login', creds, { host: 'evil.example' }))
  refused(await post('/api/login', creds, { 'x-forwarded-for': '10.0.0.2' }))
  refused(await post('/api/terminal', { action: 'claude_login' }, { 'cf-connecting-ip': '198.51.100.7' }))
  // With the real HUD token a network request passes the gate (every other POST lets it in), and the login route still says no.
  const hudToken = readFileSync(join(dir, 'data', 'brain', 'token'), 'utf8').trim()
  assert.ok(![401, 403].includes((await post('/api/settings', {}, { 'x-forwarded-for': '10.0.0.2', 'x-hud-token': hudToken })).status), 'the token passes the gate')
  assert.equal((await post('/api/login', creds, { 'x-forwarded-for': '10.0.0.2', 'x-hud-token': hudToken })).status, 403)
  assert.equal((await post('/api/login/card', { service: 'garmin' }, { 'x-forwarded-for': '10.0.0.2', 'x-hud-token': hudToken })).status, 403)
  assert.equal((await post('/api/terminal', { action: 'doctor' }, { 'x-forwarded-for': '10.0.0.2', 'x-hud-token': hudToken })).status, 403)
  assert.equal((await post('/api/login', { card: 'login-000000000000', step: 'cancel' })).status, 404)

  // Wrong password: the form stays, with a message.
  const wrong = await post('/api/login', creds)
  assert.equal(wrong.status, 200, wrong.text)
  assert.equal(wrong.json().card.state, 'form')
  assert.match(wrong.json().card.message, /neprijal/)
  // A second card for the code path.
  const card2 = (await post('/api/login/card', { service: 'garmin' })).json().card
  const code = await post('/api/login', { card: card2, step: 'credentials', values: { email: 'mfa@example.com', password: PASSWORD } })
  assert.equal(code.json().card.state, 'code')
  const bad = await post('/api/login', { card: card2, step: 'code', code: BAD_CODE })
  assert.equal(bad.json().card.state, 'code')
  assert.match(bad.json().card.message, /nesedí/)
  const done = await post('/api/login', { card: card2, step: 'code', code: CODE })
  assert.equal(done.json().card.state, 'done', done.text)
  assert.match(done.json().card.message, /Garmin je pripojený \(Test Bežec\)/)
  assert.ok(existsSync(join(dir, 'data', 'garmin', 'garmin_tokens.json')))
  // A finished card takes nothing more.
  assert.equal((await post('/api/login', { card: card2, step: 'credentials', values: { email: 'x@y.z', password: 'x' } })).status, 410)
  // The card is not a form the brain can fake through hud_card.
  const shape = done.json().card
  assert.deepEqual(Object.keys(shape).sort(), ['accent', 'code', 'fields', 'icon', 'id', 'kind', 'message', 'node', 'service', 'state', 'submit', 'text', 'title'])

  await new Promise((r) => setTimeout(r, 900))
  const stream = sse.text()
  assert.match(stream, /"phase":"card-update"/)
  assert.match(stream, /"kind":"login"/)
  // The brain heard the outcome (a hidden turn in mock mode), never a value.
  const history = readFileSync(join(dir, 'data', 'brain', 'chat-history.json'), 'utf8')
  const secrets = [PASSWORD, WRONG, CODE, BAD_CODE, 'someone@example.com', 'mfa@example.com', 'secret-cookie']
  for (const secret of secrets) {
    assert.ok(!stream.includes(secret), `the event stream carries ${secret}`)
    assert.ok(!s.log().includes(secret), `the server log carries ${secret}`)
    assert.ok(!history.includes(secret), `the history carries ${secret}`)
  }
  // No file under data/ or memory/ holds a value: only the stand-in library's tokens are written.
  for (const file of [...filesUnder(join(dir, 'data')), ...filesUnder(join(dir, 'memory'))]) {
    const text = readFileSync(file, 'latin1')
    for (const secret of secrets) assert.ok(!text.includes(secret), `${file} carries ${secret}`)
  }
})

test('server: three wrong passwords and the card waits instead of asking the service again', { skip: POSIX }, async (t) => {
  const dir = join(TMP, 'srv-limit')
  mkdirSync(dir, { recursive: true })
  const s = await startServer(dir, { UV_BIN: fakeUv(dir) })
  t.after(() => s.child.kill())
  const post = (path, body) => raw(s.port, 'POST', path, { 'content-type': 'application/json' }, JSON.stringify(body))
  const card = (await post('/api/login/card', { service: 'garmin' })).json().card
  for (let i = 0; i < 3; i++) assert.match((await post('/api/login', { card, step: 'credentials', values: { email: 'nobody@example.com', password: WRONG } })).json().card.message, /neprijal/)
  const fourth = await post('/api/login', { card, step: 'credentials', values: { email: 'ok@example.com', password: PASSWORD } })
  assert.match(fourth.json().card.message, /trikrát/)
  assert.equal(existsSync(join(dir, 'data', 'garmin', 'garmin_tokens.json')), false)
  // Bad values are answered by the card itself.
  assert.match((await post('/api/login', { card, step: 'credentials', values: { email: 'nie-je-email', password: 'x' } })).json().card.message, /e-mail/)
  assert.equal((await post('/api/login', { card, step: 'cancel' })).json().card.state, 'closed')
})

// ── the brain's tool ────────────────────────────────────────────────────

test('ask_login: the MCP tool asks the HUD for the card and tells the brain what to say', async (t) => {
  const seen = []
  const hud = createHttpServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      seen.push({ path: req.url, token: req.headers['x-brain-token'], body: JSON.parse(body) })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, card: 'login-abc', text: 'Karta na prihlásenie je na obrazovke.' }))
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
  call({ id: 3, method: 'tools/call', params: { name: 'ask_login', arguments: { service: 'garmin' } } })
  for (let i = 0; i < 100 && !out.includes('"id":3'); i++) await new Promise((r) => setTimeout(r, 50))
  const lines = out.trim().split('\n').map((l) => JSON.parse(l))
  const tool = lines.find((l) => l.id === 2).result.tools.find((x) => x.name === 'ask_login')
  assert.deepEqual(tool.inputSchema.properties.service.enum, ['garmin'])
  assert.match(tool.description, /nikdy nevidíš/)
  assert.equal(lines.find((l) => l.id === 3).result.content[0].text, 'Karta na prihlásenie je na obrazovke.')
  assert.deepEqual(seen, [{ path: '/api/brain/hud', token: 'test-token', body: { action: 'login', service: 'garmin' } }])
})

test('the brain may use both new tools, and the persona forbids sending the user to a terminal', async () => {
  const { allowedTools } = await import('../hud/server/brain.mjs')
  assert.ok(allowedTools().includes('mcp__jarvis-hud__ask_login'))
  assert.ok(allowedTools().includes('mcp__computer__open_terminal'))
  const { buildPersona } = await import('../hud/server/persona.mjs')
  const p = buildPersona()
  assert.match(p, /Nikdy ho neposielaš do terminálu/)
  assert.match(p, /ask_login so service garmin/)
  assert.doesNotMatch(p, /jedným príkazom v termináli/)
})

test('login card: the shape, and the form values are checked before anything starts', async () => {
  const { loginCard, readValues } = await import('../hud/server/login.mjs')
  const c = loginCard('garmin', 'login-x')
  assert.equal(c.kind, 'login')
  assert.equal(c.state, 'form')
  assert.equal(c.text, 'Heslo ide rovno do Garminu, ja ho nevidím ani neukladám.')
  assert.deepEqual(c.fields.map((f) => [f.name, f.type]), [['email', 'email'], ['password', 'password']])
  assert.equal(loginCard('nieco'), null)
  assert.deepEqual(readValues({ email: ' a@b.sk ', password: 'p' }), { email: 'a@b.sk', password: 'p' })
  assert.ok(readValues({ email: 'a@b.sk' }).error)
  assert.ok(readValues({ email: 'ab.sk', password: 'p' }).error)
  assert.ok(readValues({ email: 'a@b.sk', password: 'x'.repeat(2000) }).error)
  assert.ok(readValues(null).error)
})

// ── open_terminal ───────────────────────────────────────────────────────

const NASTY = `/Users/o'neil "x" $(rm -rf ~) \`id\`; echo/Jarvis`

test('open_terminal: only known actions, never a command from outside', () => {
  for (const bad of ['rm -rf /', 'claude_login; rm -rf /', '__proto__', 'constructor', '', null]) assert.equal(terminalLaunch(bad, { platform: 'darwin', repo: '/x' }).ok, false, String(bad))
  assert.equal(terminalLaunch('apple_tools', { platform: 'win32', repo: 'C:\\J' }).ok, false)
  assert.ok(Object.values(TERMINAL_ACTIONS).every((a) => a.say && !/[`$;|&<>]/.test(a.run.posix)))
})

test('open_terminal on macOS: the line is an argument of the AppleScript, the folder single-quoted', () => {
  const plan = terminalLaunch('claude_login', { platform: 'darwin', repo: NASTY })
  assert.equal(plan.bin, '/usr/bin/osascript')
  const line = plan.args.at(-1)
  assert.equal(plan.args.at(-2), '--')
  assert.equal(line, `cd ${shQuote(NASTY)} && clear && claude auth login`)
  // The AppleScript source is fixed: nothing from the folder or the action is spliced into it.
  assert.deepEqual(plan.args.slice(0, -2).filter((a) => a !== '-e'), ['on run argv', 'tell application "Terminal"', 'activate', 'do script (item 1 of argv)', 'end tell', 'end run'])
  // A POSIX shell reads the quoted folder back as exactly the original string.
  if (process.platform !== 'win32') {
    const echoed = spawnSync('/bin/sh', ['-c', `printf %s ${shQuote(NASTY)}`], { encoding: 'utf8' })
    assert.equal(echoed.stdout, NASTY)
  }
})

test('open_terminal on Windows: a new PowerShell window, the script encoded, the folder as the working directory', () => {
  const plan = terminalLaunch('codex_login', { platform: 'win32', repo: 'C:\\Users\\Ján O\'Neil\\Jarvis', env: { SystemRoot: 'C:\\Windows' } })
  assert.equal(plan.bin, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.deepEqual(plan.args.slice(0, 5), ['-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
  const script = Buffer.from(plan.args[5], 'base64').toString('utf16le')
  assert.equal(script, `$Host.UI.RawUI.WindowTitle = 'Prihlásenie do ChatGPT'; codex login`)
  assert.equal(plan.args[5], psEncode(script))
  assert.equal(plan.options.cwd, 'C:\\Users\\Ján O\'Neil\\Jarvis')
  assert.equal(plan.options.detached, true)
  assert.equal(plan.options.windowsHide, false)
})

test('open_terminal on Linux: the terminal that exists, the folder as the working directory', () => {
  const plan = terminalLaunch('doctor', { platform: 'linux', repo: NASTY, exists: (p) => p === '/usr/bin/gnome-terminal' })
  assert.equal(plan.bin, '/usr/bin/gnome-terminal')
  assert.deepEqual(plan.args.slice(0, 3), ['--', 'sh', '-c'])
  assert.match(plan.args[3], /^node scripts\/doctor\.mjs; exec/)
  assert.ok(!plan.args.join(' ').includes(NASTY))
  assert.equal(plan.options.cwd, NASTY)
  assert.equal(terminalLaunch('doctor', { platform: 'linux', repo: '/x', exists: () => false }).ok, false)
  const xterm = terminalLaunch('doctor', { platform: 'linux', repo: '/x', exists: (p) => p === '/usr/bin/xterm' })
  assert.deepEqual(xterm.args.slice(0, 3), ['-e', 'sh', '-c'])
})
