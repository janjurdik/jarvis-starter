/**
 * Minimálny MCP server cez stdio (JSON-RPC 2.0, riadok = správa), bez závislostí.
 * Stačí na to, čo Claude Code CLI potrebuje: initialize, tools/list, tools/call, ping.
 * Logovať len na stderr, stdout patrí protokolu.
 */
import { createInterface } from 'node:readline'

/**
 * tools: [{ name, description, inputSchema, handler(args) → string | object | { text, isError } }]
 */
export function serveMcp({ name, version = '1.0.0', instructions, tools }) {
  const byName = new Map(tools.map((t) => [t.name, t]))
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

  async function call(id, params) {
    const tool = byName.get(params?.name)
    if (!tool) return fail(id, -32602, `neznámy nástroj ${params?.name}`)
    try {
      const out = await tool.handler(params?.arguments ?? {})
      // Ready-made MCP content (text and images, e.g. a picture of the screen): passed on as it is.
      if (out && typeof out === 'object' && Array.isArray(out.content)) return reply(id, { content: out.content, ...(out.isError ? { isError: true } : {}) })
      if (out && typeof out === 'object' && 'text' in out && Object.keys(out).every((k) => k === 'text' || k === 'isError')) {
        return reply(id, { content: [{ type: 'text', text: String(out.text) }], isError: Boolean(out.isError) })
      }
      const text = typeof out === 'string' ? out : JSON.stringify(out, null, 1)
      return reply(id, { content: [{ type: 'text', text }] })
    } catch (err) {
      return reply(id, { content: [{ type: 'text', text: `Chyba: ${err instanceof Error ? err.message : String(err)}` }], isError: true })
    }
  }

  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object' || msg.id === undefined || msg.id === null) return
    const { id, method, params } = msg
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name, version },
        ...(instructions ? { instructions } : {}),
      })
    }
    if (method === 'ping') return reply(id, {})
    if (method === 'tools/list') {
      return reply(id, {
        tools: tools.map(({ name: n, description, inputSchema, annotations }) => ({ name: n, description, inputSchema, ...(annotations ? { annotations } : {}) })),
      })
    }
    if (method === 'tools/call') return void call(id, params)
    if (method === 'resources/list') return reply(id, { resources: [] })
    if (method === 'prompts/list') return reply(id, { prompts: [] })
    return fail(id, -32601, `metóda ${method} nie je podporovaná`)
  })
  rl.on('close', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
}

export const READ_ONLY = { readOnlyHint: true, openWorldHint: false }
