/**
 * Jarvis's brain: the Claude Code CLI on the user's own Claude subscription (apiKeySource: none).
 *
 * One long-lived process `claude -p --input-format stream-json --output-format stream-json`,
 * messages go in over stdin and the answer streams back token by token. A cold start of the CLI
 * with MCP servers takes a few seconds, so the process is kept warm and restarted when it dies.
 * Isolated from the user's own Claude Code setup (CLAUDE.md, skills, plugins, hooks):
 * --setting-sources project, --disable-slash-commands, --strict-mcp-config, a clean cwd in
 * data/brain/ and its own system prompt. --bare is not used (it turns off the subscription login).
 */
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { cleanEnv } from './agent.mjs'
import { MEMORY_DIR } from './memory/index.mjs'
import { WARMUP_TEXT, buildPersona, contextLine } from './persona.mjs'
import { BRAIN_DIR, DATA_DIR, REPO, ROOT, errMsg, findBin, log, spawnBin, writeFileAtomic } from './util.mjs'

export const CLAUDE = findBin('claude', { override: process.env.JARVIS_CLAUDE_BIN })
export const MODEL = process.env.JARVIS_MODEL || 'sonnet'
export const EFFORT = process.env.JARVIS_EFFORT || 'low'
const TURN_TIMEOUT_MS = Number(process.env.JARVIS_TURN_TIMEOUT_MS || 150_000)
const MAX_TURNS_PER_SESSION = Number(process.env.JARVIS_MAX_TURNS || 30)
const MCP_FILE = join(BRAIN_DIR, 'mcp.json')
const PERSONA_FILE = join(BRAIN_DIR, 'persona.md')

const MEMORY_TOOLS = ['calendar_list', 'get_health', 'garmin_sync', 'view_todo', 'list_goals', 'upcoming_celebrations', 'memory_stats', 'read_note', 'search_notes', 'remember', 'add_todo', 'complete_todo', 'add_event', 'log_day', 'write_note', 'remind', 'search_messages', 'read_thread', 'activity_today', 'activity_set']

/**
 * Permission rule for the built-in Read tool on one folder. Claude Code writes absolute paths in
 * rules with a double slash (`Read(//Users/…/**)`), Windows drives as `//c/…`. A path with
 * brackets cannot be written into a rule, so null means "no rule possible".
 */
export function readRule(dir) {
  const abs = resolve(dir).replace(/\\/g, '/')
  if (/[()]/.test(abs)) return null
  const win = /^([A-Za-z]):\/(.*)$/.exec(abs)
  return `Read(/${win ? `/${win[1].toLowerCase()}/${win[2]}` : abs}/**)`
}

/**
 * The voice brain runs without permission questions, like every other part of Jarvis. It stays
 * fast by having few built-in tools (--tools): the web and Read for any file on the computer.
 * Real work (shell, editing, connectors) goes to a background job through agent_task.
 */
export function allowedTools() {
  return [
    ...MEMORY_TOOLS.map((t) => `mcp__memory__${t}`),
    'mcp__computer__open_app',
    'mcp__computer__open_url',
    'mcp__computer__media',
    'mcp__computer__volume',
    'mcp__computer__screen_look',
    'mcp__jarvis-hud__hud_focus',
    'mcp__jarvis-hud__hud_card',
    'mcp__jarvis-hud__hud_log',
    'mcp__jarvis-hud__weather',
    'mcp__jarvis-hud__call_user',
    'mcp__jarvis-hud__agent_task',
    'mcp__jarvis-hud__agent_jobs',
    'mcp__jarvis-hud__agent_reply',
    'mcp__jarvis-hud__agent_stop',
    'mcp__jarvis-hud__set_alarm',
    'mcp__jarvis-hud__hud_orb',
    'mcp__jarvis-hud__suggest',
    'mcp__jarvis-hud__setup_note',
    'mcp__jarvis-hud__settings',
    'mcp__jarvis-hud__set_alarm_sound',
    'mcp__jarvis-hud__video_open',
    'mcp__jarvis-hud__video_seek',
    'mcp__jarvis-hud__video_transcript',
    'mcp__jarvis-hud__video_info',
    'mcp__jarvis-hud__video_control',
    'mcp__jarvis-hud__video_close',
    'mcp__jarvis-hud__record_start',
    'mcp__jarvis-hud__record_stop',
    'mcp__jarvis-hud__record_status',
    'WebSearch',
    'WebFetch',
    'Read',
  ]
}

/** The one thing that stays closed: the HUD's own access token in data/brain. It is of no use to the user and would open the HUD to another device. */
export function deniedTools() {
  // And the secrets of the installation: Twilio keys, the iCal address.
  const env = resolve(REPO, '.env').replace(/\\/g, '/')
  const win = /^([A-Za-z]):\/(.*)$/.exec(env)
  return [readRule(BRAIN_DIR), /[()]/.test(env) ? null : `Read(/${win ? `/${win[1].toLowerCase()}/${win[2]}` : env})`].filter(Boolean)
}

/** MCP server config for the CLI. File is 0600 in data/brain (never committed), tokens never go to the log. */
async function writeMcpConfig({ hudUrl, token }) {
  const node = process.execPath
  const base = { ...cleanEnv(), HUD_URL: hudUrl, HUD_BRAIN_TOKEN: token, JARVIS_MEMORY_DIR: MEMORY_DIR, JARVIS_DATA_DIR: DATA_DIR }
  const servers = {
    memory: { command: node, args: [join(ROOT, 'server/mcp/memory.mjs')], env: base },
    computer: { command: node, args: [join(ROOT, 'server/mcp/computer.mjs')], env: base },
    'jarvis-hud': { command: node, args: [join(ROOT, 'server/mcp/jarvis-hud.mjs')], env: base },
  }
  await writeFileAtomic(MCP_FILE, JSON.stringify({ mcpServers: servers }, null, 2), 0o600)
}

export class Brain {
  constructor({ hudUrl, token, onStatus = () => {}, warmup = true }) {
    this.hudUrl = hudUrl
    this.token = token
    this.onStatus = onStatus
    this.warmupEnabled = warmup
    this.proc = null
    this.state = 'off'
    this.queue = []
    this.toolNames = new Map()
    this.turns = 0
    this.startedAt = null
    this.startMs = null
    this.lastError = null
    this.rateLimit = null
    this.mcp = []
    this.model = MODEL
    this.restartDelay = 1000
    this.stopping = false
    this.lastWarmupAt = 0
    this.startPromise = null
  }

  status() {
    return {
      state: this.state,
      model: this.model,
      effort: EFFORT,
      pid: this.proc?.pid ?? null,
      startMs: this.startMs,
      turns: this.turns,
      lastError: this.lastError,
      mcp: this.mcp,
      limit: this.rateLimit,
    }
  }

  setState(state) {
    if (this.state === state) return
    this.state = state
    this.onStatus()
  }

  /** Spustí proces (súbežné volania počkajú na ten istý štart). */
  async start(reason = 'štart') {
    if (this.proc) return
    if (!this.startPromise) this.startPromise = this.spawnProcess(reason).finally(() => (this.startPromise = null))
    return this.startPromise
  }

  async spawnProcess(reason) {
    if (this.proc) return
    if (!CLAUDE) {
      this.lastError = 'Claude Code CLI sa nenašiel. Nainštaluj ho a prihlás sa (claude), potom reštartuj HUD.'
      this.setState('error')
      return
    }
    this.stopping = false
    this.setState('starting')
    await mkdir(BRAIN_DIR, { recursive: true })
    await writeMcpConfig({ hudUrl: this.hudUrl, token: this.token })
    await writeFileAtomic(PERSONA_FILE, buildPersona(), 0o600)
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model', MODEL,
      '--effort', EFFORT,
      '--system-prompt-file', PERSONA_FILE,
      '--mcp-config', MCP_FILE,
      '--strict-mcp-config',
      '--tools', 'WebSearch,WebFetch,Read',
      '--allowedTools', allowedTools().join(','),
      ...(deniedTools().length ? ['--disallowedTools', deniedTools().join(',')] : []),
      '--permission-mode', 'bypassPermissions',
      '--setting-sources', 'project',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--no-chrome',
    ]
    if (/opus/.test(MODEL)) args.push('--fallback-model', 'sonnet')
    const t0 = Date.now()
    const proc = spawnBin(CLAUDE, args, { cwd: BRAIN_DIR, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    this.startedAt = t0
    this.turns = 0
    this.queue = []
    this.toolNames.clear()
    log('brain', `${reason}: claude pid ${proc.pid}, model ${MODEL}, effort ${EFFORT}`)
    createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line))
    createInterface({ input: proc.stderr }).on('line', (line) => {
      if (line.trim()) log('brain', `stderr: ${line.slice(0, 300)}`)
    })
    proc.on('error', (err) => {
      this.lastError = errMsg(err)
      log('brain', `spawn zlyhal: ${this.lastError}`)
    })
    proc.on('exit', (code, signal) => this.onExit(proc, code, signal))
    proc.stdin.on('error', () => {})
    if (this.warmupEnabled && Date.now() - this.lastWarmupAt > 30 * 60_000) {
      this.lastWarmupAt = Date.now()
      this.queue.push({ warmup: true, t0 })
      this.write({ type: 'user', message: { role: 'user', content: WARMUP_TEXT } })
    } else {
      // Bez zahriatia: CLI je pripravený prijímať, správy sa bufferujú.
      setTimeout(() => this.proc === proc && this.state === 'starting' && this.setState('ready'), 2500)
    }
  }

  write(obj) {
    if (!this.proc?.stdin.writable) throw new Error('mozog nebeží')
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  onExit(proc, code, signal) {
    if (this.proc !== proc) return
    this.proc = null
    const pending = this.queue
    this.queue = []
    for (const job of pending) {
      clearTimeout(job.timer)
      if (job.sink && !job.interrupted) job.sink.error(`Mozog skončil (${signal ?? code}), reštartujem ho.`)
      job.resolve?.()
    }
    if (this.stopping) {
      this.setState('off')
      return
    }
    this.lastError = `claude skončil (${signal ?? code})`
    log('brain', `${this.lastError}, reštart o ${this.restartDelay} ms`)
    this.setState('error')
    const delay = this.restartDelay
    this.restartDelay = Math.min(30_000, this.restartDelay * 2)
    setTimeout(() => {
      if (!this.proc && !this.stopping) this.start('reštart po páde').catch((err) => log('brain', errMsg(err)))
    }, delay)
  }

  onLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    const job = this.queue[0]
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.model = msg.model ?? this.model
          this.mcp = (msg.mcp_servers ?? []).map((s) => ({ name: s.name, status: s.status }))
          const bad = this.mcp.filter((s) => s.status !== 'connected')
          if (bad.length) log('brain', `MCP nepripojené: ${bad.map((s) => `${s.name}=${s.status}`).join(', ')}`)
          if (msg.apiKeySource && msg.apiKeySource !== 'none') log('brain', `POZOR: apiKeySource=${msg.apiKeySource}, nejde cez predplatné`)
        }
        return
      case 'rate_limit_event': {
        const info = msg.rate_limit_info ?? {}
        this.rateLimit = { status: info.status, type: info.rateLimitType, resetsAt: info.resetsAt ?? null, utilization: info.unifiedWindows?.[info.rateLimitType]?.utilization ?? null }
        return
      }
      case 'control_response':
        return
      case 'stream_event':
        if (job?.sink && !job.interrupted) this.onStream(job, msg.event)
        return
      case 'assistant':
        if (job?.sink && !job.interrupted) {
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'tool_use' || block.type === 'server_tool_use') {
              this.toolNames.set(block.id, block.name)
              job.sink.tool({ id: block.id, name: block.name, input: block.input ?? null, status: 'run' })
            }
          }
        }
        return
      case 'user':
        if (job?.sink && !job.interrupted) {
          const content = Array.isArray(msg.message?.content) ? msg.message.content : []
          for (const block of content) {
            if (block.type !== 'tool_result') continue
            job.sink.tool({ id: block.tool_use_id, name: this.toolNames.get(block.tool_use_id) ?? '', input: null, status: block.is_error ? 'error' : 'ok' })
          }
        }
        return
      case 'result':
        this.onResult(msg)
        return
      default:
    }
  }

  onStream(job, ev) {
    if (!ev) return
    if (ev.type === 'message_start') {
      job.blocks = new Map()
      return
    }
    if (ev.type === 'content_block_start') {
      const b = ev.content_block ?? {}
      job.blocks?.set(ev.index, b.type)
      if (b.type === 'text') {
        if (job.hadText) job.sink.blockBreak()
      } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
        this.toolNames.set(b.id, b.name)
        job.sink.tool({ id: b.id, name: b.name, input: null, status: 'run' })
      }
      return
    }
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      job.hadText = true
      job.sink.delta(ev.delta.text)
    }
  }

  onResult(msg) {
    const job = this.queue.shift()
    if (!job) return
    clearTimeout(job.timer)
    const u = msg.usage ?? {}
    const usage = {
      input: u.input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    }
    const meta = { usage, costUsd: msg.total_cost_usd ?? null, apiMs: msg.duration_api_ms ?? null, durationMs: msg.duration_ms ?? null, numTurns: msg.num_turns ?? null, model: this.model }
    this.restartDelay = 1000
    if (job.warmup) {
      this.startMs = Date.now() - job.t0
      log('brain', `zahriaty za ${this.startMs} ms (api ${meta.apiMs} ms, cache zápis ${usage.cacheWrite}, čítanie ${usage.cacheRead})`)
      if (this.state === 'starting') this.setState('ready')
      return
    }
    this.turns++
    if (!job.interrupted) {
      if (msg.subtype === 'success' && !msg.is_error) job.sink.done(meta)
      else job.sink.error(msg.result || (Array.isArray(msg.errors) ? msg.errors.join('; ') : '') || `mozog skončil chybou (${msg.subtype})`)
    }
    job.resolve()
    if (!this.queue.some((j) => !j.interrupted)) this.setState(this.proc ? 'ready' : 'off')
    // Dlhá konverzácia = pomalší a drahší turn: po N turnoch čerstvá relácia (na pozadí, bez zahriatia).
    if (this.turns >= MAX_TURNS_PER_SESSION && !this.queue.length) this.restart('čerstvá relácia po dlhom rozhovore', { warmup: false })
  }

  /** Spustí turn. Promise sa vyrieši po `result` (alebo po prerušení / páde). */
  async run(ctx, sink) {
    if (!this.proc) await this.start('prvá správa')
    return new Promise((resolve) => {
      const job = { ctx, sink, resolve, interrupted: false, hadText: false, blocks: null, t0: Date.now() }
      job.timer = setTimeout(() => {
        if (this.queue.includes(job) && !job.interrupted) {
          sink.error('Mozog neodpovedal včas. Skúste to prosím znova.')
          this.interruptJob(job)
        }
      }, TURN_TIMEOUT_MS)
      this.queue.push(job)
      this.setState('busy')
      const text = `${contextLine({ via: ctx.via, film: ctx.film })}${ctx.extra ? `\n${ctx.extra}` : ''}\n${ctx.text}`
      try {
        this.write({ type: 'user', message: { role: 'user', content: text } })
      } catch (err) {
        this.queue = this.queue.filter((j) => j !== job)
        clearTimeout(job.timer)
        sink.error(errMsg(err))
        resolve()
      }
    })
  }

  interruptJob(job) {
    job.interrupted = true
    try {
      this.write({ type: 'control_request', request_id: `int-${randomBytes(4).toString('hex')}`, request: { subtype: 'interrupt' } })
    } catch {
      // proces už nebeží
    }
    // Keď CLI na prerušenie nezareaguje, proces sa reštartuje (stav by sa inak zasekol).
    setTimeout(() => {
      if (this.queue.includes(job)) {
        log('brain', 'prerušenie bez odozvy, reštartujem proces')
        this.restart('prerušenie bez odozvy', { warmup: false })
      }
    }, 4000)
  }

  /** Preruší bežiaci turn (Esc, nová správa). */
  interrupt() {
    const job = this.queue.find((j) => !j.interrupted && !j.warmup)
    if (job) this.interruptJob(job)
  }

  async restart(reason = 'reštart', { warmup = true } = {}) {
    const proc = this.proc
    if (proc) {
      this.stopping = true
      await new Promise((resolve) => {
        proc.once('exit', resolve)
        proc.kill('SIGTERM')
        setTimeout(() => proc.kill('SIGKILL'), 3000)
      })
    }
    this.stopping = false
    if (warmup) this.lastWarmupAt = 0
    else this.lastWarmupAt = Date.now()
    await this.start(reason)
  }

  stop() {
    this.stopping = true
    this.proc?.kill('SIGTERM')
  }
}
