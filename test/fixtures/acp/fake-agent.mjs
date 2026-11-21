/**
 * A stand-in for Antigravity in the tests: speaks just enough ACP (JSON-RPC over stdin and stdout)
 * for hud/server/antigravity.mjs to hold a whole conversation with it. No network, no model.
 *
 *   FAKE_AUTH=missing   nobody is signed in: opening a session prints the sign-in link and hangs
 *   FAKE_LOG=<file>     every request is appended there, so a test can look at what was sent
 */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.argv[2] !== 'acp') {
  console.error('fake agy: expected the acp command')
  process.exit(2)
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const update = (sessionId, body) => send({ method: 'session/update', params: { sessionId, update: body } })
const options = (model, level, mode) => [
  { id: 'model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'm-fast', name: 'Fast' }, { value: 'm-strong', name: 'Strong' }] },
  { id: 'thinking_level', category: 'thought_level', type: 'select', currentValue: level, options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  { id: 'mode', category: 'mode', type: 'select', currentValue: mode, options: [{ value: 'default', name: 'Default' }, { value: 'yolo', name: 'YOLO' }] },
]
const state = { model: 'm-fast', level: 'high', mode: 'default', system: '' }
const waiting = new Map()
let running = null
let nextId = 900

createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line)
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${line}\n`)
  // an answer to a request of ours (the permission question)
  if (m.method === undefined && waiting.has(m.id)) {
    waiting.get(m.id)(m.result)
    waiting.delete(m.id)
    return
  }
  const { id, method, params } = m
  if (method === 'initialize') {
    return send({ id, result: { protocolVersion: 1, agentInfo: { name: 'fake', version: '0.0.1' }, authMethods: [{ id: 'oauth-personal', name: 'Google' }], agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, _meta: { antigravity: { systemPrompt: { append: true } } } } } })
  }
  if (method === 'session/new' || method === 'session/resume') {
    if (process.env.FAKE_AUTH === 'missing') return process.stderr.write('Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?state=test\n')
    state.system = params._meta?.antigravity?.systemPrompt?.append ?? ''
    const sessionId = params.sessionId ?? 's1'
    return send({ id, result: { ...(method === 'session/new' ? { sessionId } : {}), modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'yolo' }] }, configOptions: options(state.model, state.level, state.mode), _meta: { antigravity: { tier: { name: 'Test tier' } } } } })
  }
  if (method === 'session/set_mode') {
    state.mode = params.modeId
    return send({ id, result: {} })
  }
  if (method === 'session/set_config_option') {
    if (params.configId === 'model') state.model = params.value
    if (params.configId === 'thinking_level') state.level = params.value
    return send({ id, result: { configOptions: options(state.model, state.level, state.mode) } })
  }
  if (method === 'session/cancel') {
    if (running) {
      update(running.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The request was cancelled by the client.' } })
      send({ id: running.id, result: { stopReason: 'cancelled' } })
      running = null
    }
    return
  }
  if (method === 'session/prompt') {
    const text = params.prompt.map((b) => b.text ?? '').join('')
    const sessionId = params.sessionId
    // a long answer that only a cancel ends
    if (text.includes('dlho')) {
      running = { id, sessionId }
      return
    }
    const call = { toolCallId: 't1', title: 'memory_search_notes', kind: 'other', rawInput: { arguments: { query: 'čaj' } }, _meta: { mcp: { server: 'memory', tool: 'search_notes' }, is_mcp_tool_call: true } }
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Pozriem pamäť.' } })
    update(sessionId, { sessionUpdate: 'tool_call', status: 'pending', ...call })
    const answer = await new Promise((resolve) => {
      const ask = nextId++
      waiting.set(ask, resolve)
      send({ id: ask, method: 'session/request_permission', params: { sessionId, toolCall: call, options: [{ optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } })
    })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: answer?.outcome?.optionId === 'allow' ? 'completed' : 'failed' })
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Máte rád zelený čaj. ` } })
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `[${state.model}/${state.level}/${state.mode}/${state.system.includes('Pracovný priečinok') ? 'system' : 'no-system'}]` } })
    return send({ id, result: { stopReason: 'end_turn' } })
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: 'Method not found' } })
})
