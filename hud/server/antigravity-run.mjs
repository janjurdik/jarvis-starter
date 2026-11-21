#!/usr/bin/env node
/**
 * One full Antigravity run for a background job or a routine. provider.mjs starts this script the
 * way it starts `claude -p` or `codex exec`: the task comes in over stdin, the progress goes out
 * as one JSON object per line.
 *
 *   node hud/server/antigravity-run.mjs [--cwd <dir>] [--context <file>] [--model <id>] [--effort <level>] [--session <id>]
 *
 *   { "type": "init", "sessionId": "…" }             the conversation, a later reply continues it (and the model it runs on)
 *   { "type": "tool", "name": "Bash", "input": {} }  one step of the work
 *   { "type": "text", "text": "…" }                  what the agent said between the steps
 *   { "type": "result", "ok": true, "text": "…" }    the end: the last message, or `error`
 *
 * The agent works with full access, the same as the other two. What goes out to other people
 * waits for the user's yes in the task itself.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { AcpClient, accessNote, antigravityEnv, jarvisMcpServers, openSession, toolOf } from './antigravity.mjs'
import { MEMORY_DIR } from './memory/index.mjs'
import { cleanEnv } from './provider.mjs'
import { BRAIN_DIR, DATA_DIR, HOME, REPO, errMsg } from './util.mjs'

const argv = process.argv.slice(2)
const opt = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : ''
}
const cwd = resolve(opt('cwd') || REPO)
const t0 = Date.now()

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)

function readStdin() {
  return new Promise((done) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => (data += d))
    process.stdin.on('end', () => done(data))
    process.stdin.on('error', () => done(data))
  })
}

let text = ''
let last = ''
let steps = 0
let live = false
let ended = false
const seen = new Set()

/** What the agent said since the last step, as one message. */
function flush() {
  const said = text.trim()
  text = ''
  if (!said) return
  last = said
  emit({ type: 'text', text: said })
}

async function end(ok, error = null) {
  if (ended) return
  ended = true
  flush()
  emit({ type: 'result', ok, text: ok ? last : '', error: ok ? null : String(error || 'Antigravity skončil chybou').slice(0, 400), turns: steps, ms: Date.now() - t0 })
  await client.close()
  process.exit(ok ? 0 : 1)
}

const client = new AcpClient({
  env: antigravityEnv(cleanEnv()),
  cwd,
  onUpdate({ update }) {
    // A resumed conversation may replay its history first: only what follows the new task counts.
    if (!live || !update) return
    if (update.sessionUpdate === 'agent_message_chunk') {
      if (update.content?.type === 'text') text += update.content.text ?? ''
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const id = String(update.toolCallId ?? '')
      if (!id || seen.has(id) || (!update.title && !update.kind)) return
      seen.add(id)
      flush()
      steps++
      const tool = toolOf(update)
      emit({ type: 'tool', name: tool.name, input: tool.input })
    }
  },
  onExit: (err) => end(false, errMsg(err)),
})

// A stopped job: end the agent with it.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    ended = true
    await client.close()
    process.exit(143)
  })
}

try {
  const prompt = (await readStdin()).trim()
  if (!prompt) throw new Error('chýba zadanie úlohy')
  let context = ''
  try {
    context = opt('context') ? readFileSync(opt('context'), 'utf8').trim() : ''
  } catch {
    context = ''
  }
  await client.start()
  // The HUD tools only when a HUD wrote down its token: a routine may run while the desktop is off.
  const tokenFile = join(BRAIN_DIR, 'brain-token')
  const hud = existsSync(tokenFile) ? { url: `http://127.0.0.1:${process.env.PORT ?? process.env.HUD_PORT ?? 4545}`, tokenFile } : null
  const memoryOutside = !(MEMORY_DIR + sep).startsWith(cwd + sep)
  // Claude and Codex load the rules of the folder on their own. Antigravity over ACP does not always, so it is pointed at them.
  const rules = existsSync(join(cwd, 'AGENTS.md')) ? 'V pracovnom priečinku je súbor AGENTS.md s pravidlami, podľa ktorých tu pracuješ. Ak ho ešte nemáš v kontexte, prečítaj si ho skôr, než začneš.' : ''
  const session = await openSession(client, {
    cwd,
    mcpServers: jarvisMcpServers({ hud, memoryDir: MEMORY_DIR, dataDir: DATA_DIR, base: cleanEnv() }),
    systemPrompt: [accessNote(cwd), rules, context].filter(Boolean).join('\n\n'),
    model: opt('model'),
    effort: opt('effort'),
    resume: opt('session') || null,
    extraDirs: [HOME, ...(memoryOutside ? [MEMORY_DIR] : [])],
  })
  emit({ type: 'init', sessionId: session.sessionId, model: session.model })
  live = true
  const task = session.lead ? `Stále pokyny k tejto úlohe:\n${session.lead}\n\nÚloha:\n${prompt}` : prompt
  const res = await client.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: task }] })
  flush()
  if (res.stopReason === 'cancelled') await end(false, 'úloha bola zastavená')
  else if (res.stopReason === 'refusal') await end(false, last || 'Model úlohu odmietol.')
  else if (!last) await end(false, `Antigravity skončil bez odpovede (${res.stopReason ?? 'neznámy dôvod'}).`)
  else await end(true)
} catch (err) {
  await end(false, errMsg(err))
}
