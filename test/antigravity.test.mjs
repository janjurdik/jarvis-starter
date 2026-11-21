/**
 * Google Antigravity as the agent Jarvis runs on (hud/server/antigravity.mjs, the runner for
 * background jobs and the voice brain), against a small fake ACP agent in test/fixtures/acp.
 * Nothing here talks to Google and no real Antigravity is needed.
 *
 *   node --test test/*.test.mjs
 */
import { TMP } from './setup.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const WIN = process.platform === 'win32'

// The fake agent is started the way the real CLI is: a command called `agy` that takes `acp`.
const AGY = join(TMP, 'agy')
if (!WIN) {
  writeFileSync(AGY, `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, 'fixtures', 'acp', 'fake-agent.mjs')}" "$@"\n`)
  chmodSync(AGY, 0o755)
}
process.env.JARVIS_ANTIGRAVITY_BIN = AGY
process.env.JARVIS_AI = 'antigravity'
delete process.env.JARVIS_ANTIGRAVITY_HOME
delete process.env.JARVIS_ANTIGRAVITY_MODEL
delete process.env.JARVIS_ANTIGRAVITY_EFFORT

const { accessNote, antigravityEnv, antigravityInstall, antigravityStatus, jarvisMcpServers, toolOf } = await import('../hud/server/antigravity.mjs')
const { PROVIDERS, aiProvider, cleanEnv } = await import('../hud/server/provider.mjs')

test('a tool call of the agent gets the name the rest of Jarvis knows', () => {
  assert.deepEqual(toolOf({ toolCallId: 'a', title: 'memory_search_notes', kind: 'other', rawInput: { arguments: { query: 'čaj' }, query: 'čaj' }, _meta: { mcp: { server: 'memory', tool: 'search_notes' }, is_mcp_tool_call: true } }), { id: 'a', name: 'mcp__memory__search_notes', input: { query: 'čaj' } })
  assert.deepEqual(toolOf({ toolCallId: 'b', title: 'ls -la', kind: 'execute', rawInput: { CommandLine: 'ls -la', Cwd: '/tmp' } }), { id: 'b', name: 'Bash', input: { command: 'ls -la' } })
  assert.deepEqual(toolOf({ toolCallId: 'c', title: 'Running view_file', kind: 'read', rawInput: { AbsolutePath: '/tmp/a.txt' } }), { id: 'c', name: 'Read', input: { file_path: '/tmp/a.txt' } })
  assert.deepEqual(toolOf({ toolCallId: 'd', title: 'Running edit_file', kind: 'edit', rawInput: { file_path: '/tmp/b.txt' } }), { id: 'd', name: 'Edit', input: { file_path: '/tmp/b.txt' } })
  assert.deepEqual(toolOf({ toolCallId: 'e', title: 'Running search_web', kind: 'search', rawInput: { query: 'počasie' } }), { id: 'e', name: 'WebSearch', input: { query: 'počasie' } })
  assert.deepEqual(toolOf({ toolCallId: 'f', title: 'Running read_url_content', kind: 'fetch', rawInput: { url: 'https://example.com' } }), { id: 'f', name: 'WebFetch', input: { url: 'https://example.com' } })
  assert.equal(toolOf({ toolCallId: 'g', title: 'Running start_subagent', rawInput: {} }).name, 'start_subagent')
})

test('the provider entry reads the lines of the runner', () => {
  const p = PROVIDERS.antigravity
  assert.equal(aiProvider().id, 'antigravity')
  assert.deepEqual(p.parse('{"type":"init","sessionId":"s1","model":"m"}'), [{ type: 'init', sessionId: 's1', apiKey: null }])
  assert.deepEqual(p.parse('{"type":"tool","name":"Bash","input":{"command":"ls"}}'), [{ type: 'tool', name: 'Bash', input: { command: 'ls' } }])
  assert.deepEqual(p.parse('{"type":"text","text":"ahoj"}'), [{ type: 'text', text: 'ahoj' }])
  assert.deepEqual(p.parse('{"type":"result","ok":true,"text":"hotovo","error":null,"turns":2,"ms":10}'), [{ type: 'result', ok: true, text: 'hotovo', error: null, turns: 2, ms: 10 }])
  assert.equal(p.parse('{"type":"result","ok":false,"error":"zle"}')[0].error, 'zle')
  assert.deepEqual(p.parse('not json'), [])
  assert.deepEqual(p.parse('{"type":"other"}'), [])
  // a run is started through the script of Jarvis, with the standing instructions as a file
  const args = p.args({ contextFile: '/tmp/ctx.md', model: 'm-strong', effort: 'low', sessionId: 's1', cwd: '/tmp/work' })
  assert.match(args[0], /antigravity-run\.mjs$/)
  assert.deepEqual(args.slice(1), ['--cwd', '/tmp/work', '--context', '/tmp/ctx.md', '--model', 'm-strong', '--effort', 'low', '--session', 's1'])
  assert.equal(p.exe(), process.execPath)
  assert.ok(p.tiers.light && p.tiers.heavy)
})

test('the agent gets no API key and opens no browser on its own', () => {
  const env = antigravityEnv({ PATH: '/bin', GEMINI_API_KEY: 'x', GOOGLE_API_KEY: 'y', KEEP: '1' })
  assert.equal(env.GEMINI_API_KEY, undefined)
  assert.equal(env.GOOGLE_API_KEY, undefined)
  assert.equal(env.KEEP, '1')
  assert.match(env.BROWSER, /antigravity-browser\.mjs' '%s'$/)
  // the sign-in itself is the one run that may open one
  assert.equal(antigravityEnv({ PATH: '/bin' }, { browser: true }).BROWSER, undefined)
})

test('another profile: a folder of its own, or the one T3 Code signed in to', () => {
  const profile = join(TMP, 't3', 'userdata', 'providers', 'antigravity', 'abc')
  mkdirSync(join(profile, 'antigravity-acp'), { recursive: true })
  process.env.T3CODE_HOME = join(TMP, 't3')
  try {
    process.env.JARVIS_ANTIGRAVITY_HOME = 't3'
    // T3 Code has not signed in yet: nothing to use, the agent keeps its own home
    assert.equal(antigravityEnv({}).GEMINI_HOME, undefined)
    writeFileSync(join(profile, 'antigravity-acp', 'acp_token.json'), '{}')
    const env = antigravityEnv({})
    assert.equal(env.GEMINI_HOME, profile)
    assert.equal(env.AGY_ACP_FORCE_FILE_STORAGE, '1')
    process.env.JARVIS_ANTIGRAVITY_HOME = join(TMP, 'own-profile')
    assert.equal(antigravityEnv({}).GEMINI_HOME, join(TMP, 'own-profile'))
    assert.equal(antigravityEnv({}).AGY_ACP_FORCE_FILE_STORAGE, undefined)
  } finally {
    delete process.env.JARVIS_ANTIGRAVITY_HOME
    delete process.env.T3CODE_HOME
  }
})

test('the MCP servers carry the HUD token as a file, never as a value', () => {
  const quiet = jarvisMcpServers({ memoryDir: '/m', dataDir: '/d', base: {} })
  assert.deepEqual(quiet.map((s) => s.name), ['memory', 'computer'])
  const all = jarvisMcpServers({ hud: { url: 'http://127.0.0.1:4545', tokenFile: '/d/brain/brain-token' }, memoryCards: true, memoryDir: '/m', dataDir: '/d', base: {} })
  assert.deepEqual(all.map((s) => s.name), ['memory', 'computer', 'jarvis-hud'])
  const hud = Object.fromEntries(all[2].env.map((e) => [e.name, e.value]))
  assert.equal(hud.HUD_BRAIN_TOKEN_FILE, '/d/brain/brain-token')
  assert.equal(hud.HUD_BRAIN_TOKEN, undefined)
  assert.equal(hud.JARVIS_MEMORY_DIR, '/m')
  assert.match(all[2].args[0], /jarvis-hud\.mjs$/)
  assert.match(accessNote('/tmp/work'), /\/tmp\/work/)
})

/** Runs the job runner with a task on stdin and returns its events, read the way jobs.mjs reads them. */
function runJob(task, { args = [], env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO, 'hud', 'server', 'antigravity-run.mjs'), '--cwd', TMP, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, events: out.split('\n').filter(Boolean).flatMap((line) => PROVIDERS.antigravity.parse(line)) }))
    child.stdin.end(task)
  })
}

test('a background run: full access, the model, the steps and the result', { skip: WIN }, async () => {
  const ctx = join(TMP, 'ctx.md')
  const log = join(TMP, 'requests.jsonl')
  writeFileSync(ctx, 'Pracuješ samostatne.')
  const { code, events } = await runJob('Aký čaj mám rád?', { args: ['--context', ctx, '--model', 'm-strong', '--effort', 'low'], env: { FAKE_LOG: log } })
  assert.equal(code, 0)
  assert.deepEqual(events[0], { type: 'init', sessionId: 's1', apiKey: null })
  assert.deepEqual(events[1], { type: 'text', text: 'Pozriem pamäť.' })
  assert.deepEqual(events[2], { type: 'tool', name: 'mcp__memory__search_notes', input: { query: 'čaj' } })
  const result = events.at(-1)
  assert.equal(result.type, 'result')
  assert.equal(result.ok, true)
  // the permission question was answered with yes, the model and the level were set, the mode is full access, the context went in as a system prompt
  assert.equal(result.text, 'Máte rád zelený čaj. [m-strong/low/yolo/system]')
  const sent = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const opened = sent.find((m) => m.method === 'session/new')
  assert.deepEqual(opened.params.mcpServers.map((s) => s.name), ['memory', 'computer'])
  assert.match(opened.params._meta.antigravity.systemPrompt.append, /Pracuješ samostatne\./)
  // once, not always: no standing rule is written into the user's own settings
  assert.equal(sent.find((m) => m.id >= 900 && m.result)?.result.outcome.optionId, 'allow')
})

test('a background run that got an answer continues the same conversation', { skip: WIN }, async () => {
  const log = join(TMP, 'resume.jsonl')
  const { events } = await runJob('Pokračuj.', { args: ['--session', 'abc'], env: { FAKE_LOG: log } })
  assert.equal(events[0].sessionId, 'abc')
  assert.equal(events.at(-1).ok, true)
  const sent = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.ok(sent.some((m) => m.method === 'session/resume' && m.params.sessionId === 'abc'))
  assert.ok(!sent.some((m) => m.method === 'session/new'))
})

test('nobody signed in: the run ends at once and says what to do', { skip: WIN }, async () => {
  const { code, events } = await runJob('Čokoľvek.', { env: { FAKE_AUTH: 'missing' } })
  assert.equal(code, 1)
  assert.equal(events.length, 1)
  assert.equal(events[0].ok, false)
  assert.match(events[0].error, /nie je prihlásený/)
  assert.match(events[0].error, /antigravity\.mjs login/)
})

test('the status check sees the agent, its version and the plan', { skip: WIN }, async () => {
  assert.equal(antigravityInstall().source, 'custom')
  const cwd = join(TMP, 'status')
  mkdirSync(cwd, { recursive: true })
  const s = await antigravityStatus({ env: cleanEnv(), cwd })
  assert.deepEqual({ installed: s.installed, loggedIn: s.loggedIn, version: s.version, tier: s.tier, model: s.model }, { installed: true, loggedIn: true, version: '0.0.1', tier: 'Test tier', model: 'm-fast' })
})

test('the voice brain: streams the answer, shows the tool, can be interrupted', { skip: WIN }, async () => {
  const { AntigravityBrain } = await import('../hud/server/brain-antigravity.mjs')
  let changes = 0
  const brain = new AntigravityBrain({ hudUrl: 'http://127.0.0.1:1', token: 'test-token', onStatus: () => changes++ })
  const sink = () => {
    const seen = []
    return { seen, delta: (t) => seen.push(['delta', t]), tool: (t) => seen.push(['tool', t.name, t.status]), blockBreak: () => seen.push(['break']), done: (m) => seen.push(['done', m.model]), error: (e) => seen.push(['error', e]) }
  }
  try {
    await brain.start('test')
    assert.equal(brain.status().state, 'ready')
    assert.equal(brain.status().model, 'm-fast')
    assert.ok(brain.proc)

    const first = sink()
    await brain.run({ text: 'Aký čaj mám rád?', via: 'text', film: false }, first)
    assert.deepEqual(first.seen, [
      ['delta', 'Pozriem pamäť.'],
      ['tool', 'mcp__memory__search_notes', 'run'],
      ['tool', 'mcp__memory__search_notes', 'ok'],
      ['break'],
      ['delta', 'Máte rád zelený čaj. '],
      ['delta', '[m-fast/low/yolo/system]'],
      ['done', 'm-fast'],
    ])
    assert.equal(brain.status().turns, 1)

    // Esc in the middle of an answer: nothing more is said and the brain is ready for the next message
    const second = sink()
    const running = brain.run({ text: 'Hovor dlho.', via: 'text', film: false }, second)
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(brain.status().state, 'busy')
    brain.interrupt()
    await running
    assert.deepEqual(second.seen, [])
    assert.equal(brain.status().state, 'ready')

    // a new message while the previous one is still being answered ends it first
    const third = sink()
    const fourth = sink()
    const slow = brain.run({ text: 'Hovor dlho.', via: 'text', film: false }, third)
    await new Promise((r) => setTimeout(r, 100))
    await brain.run({ text: 'A teraz krátko.', via: 'text', film: false }, fourth)
    await slow
    assert.deepEqual(third.seen, [])
    assert.equal(fourth.seen.at(-1)[0], 'done')
    assert.ok(changes > 0)
  } finally {
    brain.stop()
  }
  assert.equal(brain.status().state, 'off')
})
