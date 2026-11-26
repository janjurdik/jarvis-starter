/**
 * Jarvis's voice brain on Google Antigravity (a Google account, Gemini models), for people who
 * work in Antigravity instead of Claude or Codex. The same persona, the same MCP tools (memory,
 * computer, jarvis-hud), the same interface as the Claude brain in brain.mjs, so the rest of the
 * HUD does not care which one is running.
 *
 * Antigravity is spoken to over ACP (antigravity.mjs): one process stays warm with one session,
 * a message is one `session/prompt` and the answer streams back piece by piece, so the voice
 * starts as early as on Claude. Esc and a new message end the turn with `session/cancel`.
 *
 * The persona goes in as the system prompt of the session. The token for the HUD goes to the MCP
 * servers through a file, never through the session itself (the agent keeps that on disk).
 */
import { mkdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { AcpClient, NOT_INSTALLED, NOT_LOGGED_IN, accessNote, antigravityEnv, antigravityInstall, jarvisMcpServers, openSession, toolOf } from './antigravity.mjs'
import { MEMORY_DIR } from './memory/index.mjs'
import { buildPersona, contextLine } from './persona.mjs'
import { cleanEnv } from './provider.mjs'
import { BRAIN_DIR, DATA_DIR, HOME, errMsg, log, writeFileAtomic } from './util.mjs'

const MODEL = process.env.JARVIS_ANTIGRAVITY_MODEL || ''
const EFFORT = process.env.JARVIS_ANTIGRAVITY_EFFORT || 'low'
const TURN_TIMEOUT_MS = Number(process.env.JARVIS_TURN_TIMEOUT_MS || 150_000)
const MAX_TURNS_PER_SESSION = Number(process.env.JARVIS_MAX_TURNS || 30)
const HOME_DIR = join(BRAIN_DIR, 'antigravity')
const TOKEN_FILE = join(BRAIN_DIR, 'brain-token')

export class AntigravityBrain {
  constructor({ hudUrl, token, onStatus = () => {} }) {
    this.hudUrl = hudUrl
    this.token = token
    this.onStatus = onStatus
    /** Truthy while the brain can take a turn (the HUD checks `proc` before it restarts a brain). */
    this.proc = null
    this.client = null
    this.session = null
    this.lead = ''
    this.job = null
    this.state = 'off'
    this.turns = 0
    this.startMs = null
    this.lastError = null
    this.model = MODEL || 'gemini'
    this.effort = EFFORT
    this.starting = null
    this.opening = null
    this.tools = new Map()
  }

  status() {
    return { state: this.state, model: this.model, effort: this.effort, pid: this.client?.pid ?? null, startMs: this.startMs, turns: this.turns, lastError: this.lastError, mcp: [], limit: null }
  }

  setState(state) {
    if (this.state === state) return
    this.state = state
    this.onStatus()
  }

  start(reason = 'štart') {
    if (this.proc) return Promise.resolve()
    // Two callers at once (the server start and the first message) share one start.
    this.starting ??= this.#start(reason).finally(() => (this.starting = null))
    return this.starting
  }

  async #start(reason) {
    if (!antigravityInstall()) {
      this.lastError = NOT_INSTALLED
      this.setState('error')
      return
    }
    this.setState('starting')
    const t0 = Date.now()
    await mkdir(HOME_DIR, { recursive: true })
    await writeFileAtomic(TOKEN_FILE, `${this.token}\n`, 0o600)
    const client = new AcpClient({
      env: antigravityEnv(cleanEnv()),
      cwd: HOME_DIR,
      onUpdate: (params) => this.#update(client, params),
      onExit: (err) => this.#exit(client, err),
    })
    try {
      await client.start()
      this.client = client
      await this.#open()
    } catch (err) {
      await client.close()
      if (this.client === client) this.client = null
      this.lastError = err?.auth ? NOT_LOGGED_IN : errMsg(err)
      log('brain', `${reason}: Antigravity nenaštartoval: ${this.lastError}`)
      this.setState('error')
      return
    }
    this.proc = { pid: client.pid }
    this.startMs = Date.now() - t0
    this.lastError = null
    log('brain', `${reason}: Antigravity, model ${this.model}${this.effort ? `, premýšľanie ${this.effort}` : ''}, ${this.startMs} ms`)
    this.setState('ready')
  }

  /** A fresh conversation in the running process: the persona as it is right now, the three MCP servers, full access. */
  #open() {
    const client = this.client
    // Two callers at once (the end of a long conversation and the next message) share one opening.
    if (this.opening?.client === client) return this.opening.promise
    const promise = this.#session(client).finally(() => {
      if (this.opening?.promise === promise) this.opening = null
    })
    this.opening = { client, promise }
    return promise
  }

  async #session(client) {
    const memoryOutside = !(MEMORY_DIR + sep).startsWith(HOME_DIR + sep)
    const session = await openSession(client, {
      cwd: HOME_DIR,
      mcpServers: jarvisMcpServers({ hud: { url: this.hudUrl, tokenFile: TOKEN_FILE }, memoryCards: true, memoryDir: MEMORY_DIR, dataDir: DATA_DIR, base: cleanEnv() }),
      systemPrompt: `${buildPersona()}\n\n${accessNote(HOME_DIR)}`,
      model: MODEL,
      effort: EFFORT,
      extraDirs: [HOME, ...(memoryOutside ? [MEMORY_DIR] : [])],
    })
    // The process was replaced while this one was opening: its conversation is of no use.
    if (this.client !== client) throw new Error('Antigravity sa medzitým reštartoval.')
    this.session = session.sessionId
    this.lead = session.lead
    this.model = session.model || this.model
    this.effort = session.effort || ''
    this.turns = 0
    this.tools.clear()
  }

  #exit(client, err) {
    if (this.client !== client) return
    this.client = null
    this.session = null
    this.proc = null
    this.lastError = errMsg(err)
    log('brain', `Antigravity skončil: ${this.lastError}`)
    const job = this.job
    if (job && !job.done) job.end(() => (err?.auth ? job.sink.error('Antigravity nie je prihlásený.', { fix: 'antigravity_login' }) : job.sink.error('Mozog skončil, pri ďalšej správe ho spustím znova.')))
    // Not signed in is something only the user can fix: it stays on screen. Anything else starts again with the next message.
    this.setState(err?.auth ? 'error' : 'off')
  }

  #update(client, { sessionId, update }) {
    const job = this.job
    if (this.client !== client || !job || job.done || job.interrupted || sessionId !== job.session || !update) return
    if (update.sessionUpdate === 'agent_message_chunk') {
      const text = update.content?.type === 'text' ? update.content.text ?? '' : ''
      if (!text) return
      // Text that follows a tool call is a new block: the voice ends the sentence before it.
      if (job.afterTool && job.hadText) job.sink.blockBreak()
      job.afterTool = false
      job.hadText = true
      job.sink.delta(text)
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const id = String(update.toolCallId ?? '')
      if (!id) return
      const ended = update.status === 'completed' || update.status === 'failed'
      if (!this.tools.has(id)) {
        if (!update.title && !update.kind) return
        const tool = toolOf(update)
        this.tools.set(id, tool.name)
        job.afterTool = true
        job.sink.tool({ id, name: tool.name, input: tool.input, status: 'run' })
      }
      if (ended) job.sink.tool({ id, name: this.tools.get(id), input: null, status: update.status === 'failed' ? 'error' : 'ok' })
    }
  }

  /** One turn. The promise settles when the agent finished, failed or was interrupted. */
  async run(ctx, sink) {
    // One conversation at a time: a new message ends the one still being answered and waits for it to let go.
    if (this.job) {
      const previous = this.job
      this.interrupt()
      let timer
      await Promise.race([previous.settled, new Promise((r) => (timer = setTimeout(r, 5000)))])
      clearTimeout(timer)
      if (!previous.done) await this.restart('predošlá odpoveď sa nezastavila')
    }
    if (!this.proc) await this.start('prvá správa')
    if (this.proc && !this.session) {
      try {
        await this.#open()
      } catch (err) {
        this.lastError = errMsg(err)
        this.#drop()
      }
    }
    if (!this.proc || !this.session) {
      if (this.lastError === NOT_LOGGED_IN) sink.error('Antigravity nie je prihlásený.', { fix: 'antigravity_login' })
      else sink.error(this.lastError ?? 'Mozog nebeží.')
      return
    }
    const client = this.client
    const session = this.session
    let release
    const job = { sink, session, interrupted: false, hadText: false, afterTool: false, done: false, t0: Date.now(), settled: new Promise((r) => (release = r)) }
    job.end = (fn) => {
      if (job.done) return
      job.done = true
      clearTimeout(job.timer)
      if (this.job === job) this.job = null
      if (!job.interrupted) fn()
      if (this.state === 'busy') this.setState(this.proc ? 'ready' : 'off')
      release()
    }
    this.job = job
    this.setState('busy')
    job.timer = setTimeout(() => {
      job.end(() => sink.error('Mozog neodpovedal včas. Skúste to prosím znova.'))
      client.notify('session/cancel', { sessionId: session })
    }, TURN_TIMEOUT_MS)
    const said = `${contextLine({ via: ctx.via, film: ctx.film })}${ctx.extra ? `\n${ctx.extra}` : ''}\n${ctx.text}`
    // An agent that takes no system prompt gets the persona in front of the first message of the conversation.
    const text = this.lead ? `Stále pokyny:\n${this.lead}\n\n${said}` : said
    this.lead = ''
    try {
      const res = await client.request('session/prompt', { sessionId: session, prompt: [{ type: 'text', text }] })
      this.turns++
      if (res.stopReason === 'refusal' && !job.hadText) job.end(() => sink.error('Model na toto odmietol odpovedať.'))
      else job.end(() => sink.done({ usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, costUsd: null, apiMs: null, durationMs: Date.now() - job.t0, numTurns: 1, model: this.model }))
      // A long conversation gets slower with every turn: after a while a fresh one, opened before the next message comes.
      if (this.turns >= MAX_TURNS_PER_SESSION && this.client === client && !this.job) {
        this.session = null
        this.#open().catch((err) => log('brain', `nová konverzácia: ${errMsg(err)}`))
      }
    } catch (err) {
      this.lastError = err?.auth ? NOT_LOGGED_IN : errMsg(err)
      job.end(() => (err?.auth ? sink.error('Antigravity nie je prihlásený.', { fix: 'antigravity_login' }) : sink.error(this.lastError)))
    }
    return job.settled
  }

  /** Ends the running turn (Esc, a new message). */
  interrupt() {
    const job = this.job
    if (!job || job.interrupted) return
    job.interrupted = true
    this.client?.notify('session/cancel', { sessionId: job.session })
  }

  #drop() {
    const client = this.client
    this.client = null
    this.session = null
    this.proc = null
    const job = this.job
    if (job && !job.done) {
      job.interrupted = true
      job.end(() => {})
    }
    return client ? client.close() : Promise.resolve()
  }

  /** A fresh conversation: the persona is built again (it changes with the config and the memory). */
  async restart(reason = 'reštart') {
    await this.#drop()
    await this.start(reason)
  }

  stop() {
    this.#drop()
    this.setState('off')
  }
}
