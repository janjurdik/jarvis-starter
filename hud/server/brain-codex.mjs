/**
 * Jarvis's voice brain on the Codex CLI (a ChatGPT subscription), for people who do not have
 * Claude. The same persona, the same MCP tools (memory, computer, jarvis-hud), the same interface
 * as the Claude brain in brain.mjs, so the rest of the HUD does not care which one is running.
 *
 * Codex has no long-lived streaming mode: every turn is one `codex exec --json` run that resumes
 * the thread of the conversation. Answers therefore arrive message by message, not token by
 * token, and the first sound comes a few seconds later than on Claude.
 *
 * The persona is the AGENTS.md of the folder the brain runs in (data/brain/codex). The token for
 * the HUD goes to the MCP server through a file, never through the process arguments.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { MEMORY_DIR } from './memory/index.mjs'
import { buildPersona, contextLine } from './persona.mjs'
import { PROVIDERS, cleanEnv } from './provider.mjs'
import { BRAIN_DIR, DATA_DIR, ROOT, errMsg, log, spawnBin, writeFileAtomic } from './util.mjs'

const MODEL = process.env.JARVIS_CODEX_MODEL || ''
const EFFORT = process.env.JARVIS_CODEX_EFFORT || 'low'
const TURN_TIMEOUT_MS = Number(process.env.JARVIS_TURN_TIMEOUT_MS || 150_000)
const MAX_TURNS_PER_SESSION = Number(process.env.JARVIS_MAX_TURNS || 30)
const HOME_DIR = join(BRAIN_DIR, 'codex')
const TOKEN_FILE = join(BRAIN_DIR, 'brain-token')

/** A TOML value for `-c key=value` (strings and tables of strings; JSON escapes are valid TOML). */
const toml = (v) => (Array.isArray(v) ? `[${v.map(toml).join(',')}]` : typeof v === 'object' ? `{${Object.entries(v).map(([k, x]) => `${k}=${toml(x)}`).join(',')}}` : JSON.stringify(String(v)))

export class CodexBrain {
  constructor({ hudUrl, token, onStatus = () => {} }) {
    this.hudUrl = hudUrl
    this.token = token
    this.onStatus = onStatus
    /** Truthy while the brain can take a turn (the HUD checks `proc` before it restarts a brain). */
    this.proc = null
    this.child = null
    this.job = null
    this.state = 'off'
    this.thread = null
    this.turns = 0
    this.startMs = null
    this.lastError = null
    this.model = MODEL || 'codex'
    this.mcpArgs = []
  }

  status() {
    return { state: this.state, model: this.model, effort: EFFORT, pid: this.child?.pid ?? null, startMs: this.startMs, turns: this.turns, lastError: this.lastError, mcp: [], limit: null }
  }

  setState(state) {
    if (this.state === state) return
    this.state = state
    this.onStatus()
  }

  async start(reason = 'štart') {
    if (this.proc) return
    const exe = PROVIDERS.codex.bin()
    if (!exe) {
      this.lastError = 'Codex CLI sa nenašiel. Nainštaluj ho (npm i -g @openai/codex), prihlás sa cez ChatGPT (codex login) a reštartuj HUD.'
      this.setState('error')
      return
    }
    this.setState('starting')
    await mkdir(HOME_DIR, { recursive: true })
    await writeFileAtomic(join(HOME_DIR, 'AGENTS.md'), buildPersona(), 0o600)
    await writeFileAtomic(TOKEN_FILE, `${this.token}\n`, 0o600)
    // Only what the MCP servers need, not the whole environment of the HUD.
    const base = cleanEnv()
    const env = { HUD_URL: this.hudUrl, HUD_BRAIN_TOKEN_FILE: TOKEN_FILE, JARVIS_MEMORY_DIR: MEMORY_DIR, JARVIS_DATA_DIR: DATA_DIR }
    for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP', 'LANG', 'JARVIS_CONFIG', 'PORT', 'HUD_PORT']) if (base[key]) env[key] = base[key]
    const server = (file) => ({ command: process.execPath, args: [join(ROOT, 'server/mcp', file)], env })
    this.mcpArgs = Object.entries({ memory: server('memory.mjs'), computer: server('computer.mjs'), 'jarvis-hud': server('jarvis-hud.mjs') }).flatMap(([name, s]) => ['-c', `mcp_servers.${name}.command=${toml(s.command)}`, '-c', `mcp_servers.${name}.args=${toml(s.args)}`, '-c', `mcp_servers.${name}.env=${toml(s.env)}`])
    this.proc = { pid: null }
    this.thread = null
    this.turns = 0
    this.lastError = null
    log('brain', `${reason}: Codex${MODEL ? `, model ${MODEL}` : ''}, effort ${EFFORT}`)
    this.setState('ready')
  }

  /** One turn. The promise settles when Codex finished, failed or was interrupted. */
  async run(ctx, sink) {
    if (!this.proc) await this.start('prvá správa')
    if (!this.proc) {
      sink.error(this.lastError ?? 'Mozog nebeží.')
      return
    }
    // One conversation at a time: a new message ends the one still being answered.
    if (this.job) this.interrupt()
    return new Promise((resolve) => {
      const job = { sink, resolve, interrupted: false, hadText: false, done: false, t0: Date.now() }
      this.job = job
      this.setState('busy')
      const text = `${contextLine({ via: ctx.via, film: ctx.film })}${ctx.extra ? `\n${ctx.extra}` : ''}\n${ctx.text}`
      const args = [
        'exec',
        ...(this.thread ? ['resume'] : []),
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '-c', `model_reasoning_effort=${toml(EFFORT)}`,
        ...(MODEL ? ['-m', MODEL] : []),
        ...this.mcpArgs,
        ...(this.thread ? [this.thread] : []),
        '-',
      ]
      let child
      try {
        child = spawnBin(PROVIDERS.codex.bin(), args, { cwd: HOME_DIR, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (err) {
        this.job = null
        this.setState('ready')
        sink.error(errMsg(err))
        return resolve()
      }
      this.child = child
      child.stdin.on('error', () => {})
      child.stdin.end(text)
      const end = (fn) => {
        if (job.done) return
        job.done = true
        clearTimeout(job.timer)
        if (this.job === job) this.job = null
        if (this.child === child) this.child = null
        if (!job.interrupted) fn()
        this.setState(this.proc ? 'ready' : 'off')
        resolve()
      }
      job.timer = setTimeout(() => {
        end(() => sink.error('Mozog neodpovedal včas. Skúste to prosím znova.'))
        child.kill()
      }, TURN_TIMEOUT_MS)
      let err = ''
      let usage = null
      createInterface({ input: child.stdout }).on('line', (line) => {
        let m
        try {
          m = JSON.parse(line)
        } catch {
          return
        }
        if (job.interrupted) return
        if (m.type === 'thread.started') this.thread = m.thread_id ?? this.thread
        else if (m.type === 'item.started' || m.type === 'item.completed') {
          const it = m.item ?? {}
          const done = m.type === 'item.completed'
          if (it.type === 'agent_message' && done && it.text?.trim()) {
            if (job.hadText) sink.blockBreak()
            job.hadText = true
            sink.delta(it.text)
          } else if (it.type === 'mcp_tool_call') sink.tool({ id: it.id, name: `mcp__${it.server}__${it.tool}`, input: done ? null : it.arguments ?? null, status: done ? (it.error || it.status === 'failed' ? 'error' : 'ok') : 'run' })
          else if (it.type === 'command_execution') sink.tool({ id: it.id, name: 'Bash', input: done ? null : { command: it.command ?? '' }, status: done ? (it.exit_code ? 'error' : 'ok') : 'run' })
          else if (it.type === 'web_search') sink.tool({ id: it.id, name: 'WebSearch', input: done ? null : { query: it.query ?? '' }, status: done ? 'ok' : 'run' })
        } else if (m.type === 'turn.completed') {
          usage = m.usage ?? {}
          this.turns++
          end(() => sink.done({ usage: { input: usage.input_tokens ?? 0, cacheRead: usage.cached_input_tokens ?? 0, cacheWrite: 0, output: usage.output_tokens ?? 0 }, costUsd: null, apiMs: null, durationMs: Date.now() - job.t0, numTurns: 1, model: this.model }))
          // A long conversation gets slower with every turn: after a while a fresh thread.
          if (this.turns >= MAX_TURNS_PER_SESSION) {
            this.thread = null
            this.turns = 0
          }
        } else if (m.type === 'turn.failed' || m.type === 'error') {
          const text = m.error?.message ?? m.message ?? 'Codex skončil chybou'
          this.lastError = text
          end(() => (/login|auth|401/i.test(text) ? sink.error('ChatGPT nie je prihlásený.', { fix: 'codex_login' }) : sink.error(text)))
        }
      })
      child.stderr.on('data', (d) => (err = `${err}${d}`.slice(-600)))
      child.on('error', (e) => end(() => sink.error(errMsg(e))))
      child.on('exit', (code, signal) => {
        // A thread Codex no longer knows (history cleared) would fail every turn: start a new one next time.
        if (!usage && !job.interrupted) this.thread = null
        end(() => sink.error(`Codex skončil (${signal ?? code}). ${err.trim().split('\n').pop() ?? ''}`.trim()))
      })
    })
  }

  /** Ends the running turn (Esc, a new message). */
  interrupt() {
    const job = this.job
    if (!job) return
    job.interrupted = true
    this.child?.kill()
  }

  /** A fresh conversation: the persona is written again (it changes with the config and the memory). */
  async restart(reason = 'reštart') {
    this.interrupt()
    this.proc = null
    this.thread = null
    await this.start(reason)
  }

  stop() {
    this.interrupt()
    this.proc = null
    this.setState('off')
  }
}
