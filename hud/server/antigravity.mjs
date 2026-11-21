/**
 * Google Antigravity as the agent Jarvis runs on (a Google account, Gemini models).
 *
 * Antigravity is driven through ACP, the Agent Client Protocol: JSON-RPC over stdin and stdout,
 * one line per message. The same protocol serves the voice brain (brain-antigravity.mjs, one warm
 * process with a session that streams the answer) and full runs for background jobs and routines
 * (antigravity-run.mjs, one process per run). ACP is used for both because it is the one way that
 * takes the three MCP servers of Jarvis per session, without writing into the user's own
 * Antigravity settings, and because it accepts the persona as a real system prompt.
 *
 * Where the agent is looked for, in this order:
 *   1. JARVIS_ANTIGRAVITY_BIN  a path to `agy` or to an ACP server binary
 *   2. `agy`                   the Antigravity CLI, started as `agy acp`
 *   3. `agy_acp_server`        the standalone ACP server other apps install (T3 Code keeps it
 *                              under ~/.t3/tools/antigravity-acp)
 *
 * The login is Antigravity's own: it keeps the Google sign-in in its home (~/.gemini) or in the
 * system keychain. Jarvis never reads, copies or stores it. He only asks the agent to open a
 * session and, when that is refused, tells the user to sign in (scripts/antigravity.mjs login
 * starts the agent's own browser sign-in).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { HOME, IS_WIN, ROOT, errMsg, findBin, spawnBin } from './util.mjs'

const SERVER_NAME = IS_WIN ? 'agy_acp_server.exe' : 'agy_acp_server.par'
const HARNESS_NAME = IS_WIN ? 'localharness_external.exe' : 'localharness_external'
/** The line the agent prints when it wants the user to sign in to Google in a browser. */
const AUTH_LINK = /Open the following link to authenticate[^:]*:\s*(\S+)/i
/** Keys that would switch the agent from the user's Google account to a pay-per-use API key. */
const API_KEYS = new Set(['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI'])

export const NOT_INSTALLED = 'Antigravity sa nenašiel. Nainštaluj Antigravity CLI (antigravity.google), spusti agy, prihlás sa účtom Google a reštartuj Jarvisa.'
export const NOT_LOGGED_IN = 'Antigravity nie je prihlásený. Spusti: node scripts/antigravity.mjs login (v prehliadači sa prihlás účtom Google).'
/** How the Antigravity CLI is installed, for the setup and the doctor. */
export const INSTALL_HINT = IS_WIN ? 'PowerShell: irm https://antigravity.google/cli/install.ps1 | iex, potom spusti: agy (a prihlás sa účtom Google)' : 'Terminál: curl -fsSL https://antigravity.google/cli/install.sh | bash, potom spusti: agy (a prihlás sa účtom Google)'

// ── where the agent is ─────────────────────────────────────────────────────

/** A standalone ACP server binary. Its harness sits next to it and has to be named in the environment. */
function serverInstall(exe, source) {
  const harness = join(dirname(exe), HARNESS_NAME)
  return { exe, args: process.platform === 'linux' ? ['--uid='] : [], env: existsSync(harness) ? { ANTIGRAVITY_HARNESS_PATH: harness } : {}, source }
}

const t3Home = () => process.env.T3CODE_HOME || join(HOME, '.t3')

/** The ACP server T3 Code downloaded: tools/antigravity-acp/<platform>-<arch>/versions/<release>/. */
function t3Server() {
  const root = join(t3Home(), 'tools', 'antigravity-acp')
  let platforms = []
  try {
    platforms = readdirSync(root).filter((n) => n.startsWith(`${process.platform}-`))
  } catch {
    return null
  }
  // The folder of this processor first, another one of the same system (Rosetta, x64 on ARM Windows) after it.
  platforms.sort((a, b) => Number(b === `${process.platform}-${process.arch}`) - Number(a === `${process.platform}-${process.arch}`))
  for (const platform of platforms) {
    const versions = join(root, platform, 'versions')
    let active = null
    try {
      active = JSON.parse(readFileSync(join(root, platform, 'active.json'), 'utf8')).releaseId ?? null
    } catch {
      active = null
    }
    let ids = []
    try {
      ids = readdirSync(versions)
    } catch {
      ids = []
    }
    const age = (id) => {
      try {
        return statSync(join(versions, id)).mtimeMs
      } catch {
        return 0
      }
    }
    // The release the app marked as active, otherwise the newest one that is complete.
    ids.sort((a, b) => Number(b === active) - Number(a === active) || age(b) - age(a))
    for (const id of ids) {
      const exe = join(versions, id, SERVER_NAME)
      if (existsSync(exe)) return exe
    }
  }
  return null
}

/** The Antigravity profile T3 Code keeps for itself (the one that holds a sign-in), or null. */
function t3Profile() {
  const root = join(t3Home(), 'userdata', 'providers', 'antigravity')
  try {
    for (const id of readdirSync(root)) if (existsSync(join(root, id, 'antigravity-acp', 'acp_token.json'))) return join(root, id)
  } catch {
    // T3 Code is not here
  }
  return null
}

let found
/**
 * How Antigravity is started on this computer: { exe, args, env, source } or null when it is not
 * installed. `source` is `cli` (the Antigravity CLI), `t3` (the server T3 Code installed) or
 * `custom` (JARVIS_ANTIGRAVITY_BIN).
 */
export function antigravityInstall() {
  if (found !== undefined) return found
  const override = process.env.JARVIS_ANTIGRAVITY_BIN
  if (override && existsSync(override)) {
    found = /^agy_acp_server/i.test(basename(override)) ? serverInstall(override, 'custom') : { exe: override, args: ['acp'], env: {}, source: 'custom' }
    return found
  }
  const agy = findBin('agy', { extraDirs: IS_WIN ? [join(process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local'), 'agy', 'bin')] : [] })
  if (agy) {
    found = { exe: agy, args: ['acp'], env: {}, source: 'cli' }
    return found
  }
  const server = t3Server()
  found = server ? serverInstall(server, 't3') : null
  return found
}

/**
 * Environment of the agent process, on top of `base` (provider.mjs `cleanEnv()`).
 * Without `browser` a missing sign-in never opens a browser window: background runs and checks
 * must not pop one up, they report "not signed in" instead (antigravity-browser.mjs).
 */
export function antigravityEnv(base, { install = antigravityInstall(), browser = false } = {}) {
  const env = {}
  for (const [key, value] of Object.entries(base)) if (!API_KEYS.has(key.toUpperCase())) env[key] = value
  Object.assign(env, install?.env ?? {})
  env.PYTHONUNBUFFERED = '1'
  // Another profile folder than ~/.gemini (advanced), `t3` for the one T3 Code signed in to.
  // A profile that keeps its sign-in in a file says so itself.
  const asked = process.env.JARVIS_ANTIGRAVITY_HOME
  const home = asked === 't3' ? t3Profile() : asked
  if (home) {
    env.GEMINI_HOME = home
    if (existsSync(join(home, 'antigravity-acp', 'acp_token.json'))) env.AGY_ACP_FORCE_FILE_STORAGE = '1'
  }
  if (!browser) {
    // The stand-in browser swallows the agent's own sign-in page and passes every other address on.
    // BROWSER is a list of commands separated by the path delimiter: a path that contains it cannot be written there.
    const slash = (p) => (IS_WIN ? p.replaceAll('\\', '/') : p)
    const command = [slash(process.execPath), slash(join(ROOT, 'server', 'antigravity-browser.mjs')), '%s']
    if (!command.some((part) => part.includes(delimiter) || part.includes("'"))) env.BROWSER = command.map((part) => `'${part}'`).join(' ')
  }
  return env
}

// ── the protocol ───────────────────────────────────────────────────────────

export class AcpError extends Error {
  constructor(message, { code = null, auth = false } = {}) {
    super(message)
    this.name = 'AcpError'
    this.code = code
    /** True when the agent refused because nobody is signed in. */
    this.auth = auth
  }
}

const authText = (error) => `${error?.message ?? ''} ${typeof error?.data === 'string' ? error.data : error?.data?.message ?? ''} ${error?.data?.reason ?? ''}`

/**
 * One Antigravity process and the JSON-RPC conversation with it.
 *
 *   onUpdate(params)   every `session/update` notification ({ sessionId, update })
 *   onExit(error)      the process is gone (it ended, crashed or could not start)
 *   onAuthLink(url)    only with `login`: the address of the Google sign-in the agent opened
 *
 * Permission requests are answered with yes straight away: Jarvis works with everything the user
 * can, the same as on Claude and Codex. What goes out to other people waits for the user's yes in
 * the task itself, not here.
 */
export class AcpClient {
  constructor({ env, cwd, login = false, onUpdate = () => {}, onExit = () => {}, onAuthLink = () => {} }) {
    this.env = env
    this.cwd = cwd
    this.login = login
    this.onUpdate = onUpdate
    this.onExit = onExit
    this.onAuthLink = onAuthLink
    this.child = null
    this.pending = new Map()
    this.seq = 0
    this.tail = ''
    this.info = null
    this.down = null
  }

  get pid() {
    return this.child?.pid ?? null
  }

  get alive() {
    return Boolean(this.child)
  }

  /** What the agent said about itself in `initialize`. */
  get capabilities() {
    return this.info?.agentCapabilities ?? {}
  }

  /** Starts the process and shakes hands. Rejects when the agent is missing or does not answer. */
  async start() {
    const install = antigravityInstall()
    if (!install) throw new AcpError(NOT_INSTALLED)
    const child = spawnBin(install.exe, install.args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.stdin.on('error', () => {})
    createInterface({ input: child.stdout }).on('line', (line) => this.#line(line))
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (!this.#authLink(line)) this.tail = `${this.tail}\n${line}`.slice(-800)
    })
    child.on('error', (err) => this.#gone(child, new AcpError(`Antigravity sa nepodarilo spustiť: ${errMsg(err)}`)))
    child.on('exit', (code, signal) => this.#gone(child, new AcpError(`Antigravity skončil (${signal ?? code}). ${this.tail.trim().split('\n').pop() ?? ''}`.trim())))
    this.info = await this.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'jarvis', title: 'Jarvis', version: '1' } }, { timeoutMs: 60_000 })
    return this.info
  }

  request(method, params = {}, { timeoutMs = 0 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.child) return reject(this.down ?? new AcpError('Antigravity nebeží.'))
      const id = ++this.seq
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id)
            reject(new AcpError(`Antigravity neodpovedal včas (${method}).`))
          }, timeoutMs)
        : null
      this.pending.set(id, { resolve, reject, timer })
      this.#write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method, params = {}) {
    this.#write({ jsonrpc: '2.0', method, params })
  }

  /**
   * Ends the process. Closing its input lets it finish its own cleanup, the kill is for the case
   * it does not. The promise settles when the process is gone.
   */
  close() {
    const child = this.child
    if (!child) return Promise.resolve()
    this.#gone(child, new AcpError('Antigravity bol zastavený.'), { silent: true })
    return new Promise((resolve) => {
      const soft = setTimeout(() => child.kill(), 1500)
      const hard = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 4000)
      child.once('exit', () => {
        clearTimeout(soft)
        clearTimeout(hard)
        resolve()
      })
      child.stdin.end()
    })
  }

  #write(message) {
    try {
      this.child?.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      // the process is gone: its exit handler rejects what was waiting
    }
  }

  #gone(child, error, { silent = false } = {}) {
    if (this.child !== child) return
    this.child = null
    this.down = error
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    this.pending.clear()
    if (!silent) this.onExit(error)
  }

  /** A sign-in link means nobody is signed in. Outside of the login command that ends the run at once. */
  #authLink(line) {
    const m = AUTH_LINK.exec(line)
    if (!m) return false
    if (this.login) this.onAuthLink(m[1])
    else {
      const child = this.child
      if (child) {
        this.#gone(child, new AcpError(NOT_LOGGED_IN, { code: -32000, auth: true }))
        child.kill()
      }
    }
    return true
  }

  #line(line) {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      this.#authLink(line)
      return
    }
    if (!m || typeof m !== 'object') return
    if (m.id !== undefined && m.method === undefined) {
      const waiting = this.pending.get(m.id)
      if (!waiting) return
      this.pending.delete(m.id)
      clearTimeout(waiting.timer)
      if (m.error) {
        const auth = m.error.code === -32000 && /auth|onboard|sign.?in|log.?in|credential/i.test(authText(m.error))
        waiting.reject(new AcpError(auth ? NOT_LOGGED_IN : String(m.error.data?.message ?? m.error.message ?? 'Antigravity vrátil chybu').slice(0, 400), { code: m.error.code ?? null, auth }))
      } else waiting.resolve(m.result ?? {})
      return
    }
    if (m.method === 'session/update') {
      try {
        this.onUpdate(m.params ?? {})
      } catch {
        // a handler error must not break the protocol
      }
      return
    }
    if (m.id === undefined) return
    if (m.method === 'session/request_permission') {
      const options = Array.isArray(m.params?.options) ? m.params.options : []
      // Once is enough: "always" would write a standing rule into the user's own Antigravity settings.
      const pick = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always') ?? options[0]
      this.#write({ jsonrpc: '2.0', id: m.id, result: { outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' } } })
      return
    }
    // Files and terminals are the agent's own business (no client capabilities were offered).
    this.#write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } })
  }
}

// ── sessions ───────────────────────────────────────────────────────────────

const selectOption = (options, test) => (Array.isArray(options) ? options.find((o) => o?.type === 'select' && test(o)) : null)
const values = (option) => (option?.options ?? []).flatMap((o) => ('value' in o ? [o.value] : (o.options ?? []).map((x) => x.value)))

/**
 * Opens a session ready for work: full access, the three MCP servers, the standing instructions
 * as a system prompt, the model and the thinking level.
 *
 *   resume         id of an earlier session to continue (a job that got its answer)
 *   systemPrompt   standing instructions. When the agent cannot take them as a system prompt, they
 *                  come back as `lead` and the caller puts them in front of the first message.
 *
 *   extraDirs      more folders the file tools may work in, for agents that take them
 *
 * Returns { sessionId, model, effort, lead, tier }.
 */
export async function openSession(client, { cwd, mcpServers = [], systemPrompt = '', model = '', effort = '', resume = null, extraDirs = [] }) {
  const canAppend = client.capabilities?._meta?.antigravity?.systemPrompt?.append === true
  const dirs = client.capabilities?.sessionCapabilities?.additionalDirectories ? extraDirs.filter((d) => d && d !== cwd) : []
  const params = { cwd, mcpServers, ...(dirs.length ? { additionalDirectories: dirs } : {}), ...(systemPrompt && canAppend ? { _meta: { antigravity: { systemPrompt: { append: systemPrompt } } } } : {}) }
  const open = async () => {
    if (resume) {
      const method = client.capabilities?.sessionCapabilities?.resume ? 'session/resume' : client.capabilities?.loadSession ? 'session/load' : null
      if (method) {
        try {
          return { ...(await client.request(method, { ...params, sessionId: resume }, { timeoutMs: 90_000 })), sessionId: resume }
        } catch (err) {
          if (err?.auth) throw err
          // The agent no longer knows that conversation: a new one carries on.
        }
      }
    }
    return client.request('session/new', params, { timeoutMs: 90_000 })
  }
  let session
  try {
    // Opening a session now and then fails with a passing internal error of the agent: one more try.
    session = await open().catch(async (err) => {
      if (err?.auth || !client.alive) throw err
      await new Promise((r) => setTimeout(r, 800))
      return open()
    })
  } catch (err) {
    if (!err?.auth) throw err
    // A fresh profile has no sign-in method chosen yet. With a stored sign-in this passes silently,
    // without one the agent asks for a browser and the run ends as "not signed in".
    const methods = (client.info?.authMethods ?? []).map((m) => m.id)
    await client.request('authenticate', { methodId: methods.includes('oauth-personal') ? 'oauth-personal' : methods[0] ?? 'oauth-personal' }, { timeoutMs: 60_000 })
    session = await open()
  }
  const sessionId = session.sessionId
  let options = session.configOptions ?? []
  const set = async (configId, value) => {
    const res = await client.request('session/set_config_option', { sessionId, configId, value }, { timeoutMs: 30_000 })
    if (Array.isArray(res?.configOptions)) options = res.configOptions
  }
  // Full access, like --dangerously-skip-permissions elsewhere. Should it fail, every request is still answered with yes.
  const modeOption = selectOption(options, (o) => o.category === 'mode' || o.id === 'mode')
  try {
    if ((session.modes?.availableModes ?? []).some((m) => m.id === 'yolo')) await client.request('session/set_mode', { sessionId, modeId: 'yolo' }, { timeoutMs: 30_000 })
    else if (values(modeOption).includes('yolo')) await set(modeOption.id, 'yolo')
  } catch {
    // stays in the default mode
  }
  // A model or level this account does not have is skipped, the run goes on with the agent's own choice.
  const modelOption = () => selectOption(options, (o) => o.category === 'model' || o.id === 'model')
  if (model && values(modelOption()).includes(model)) await set(modelOption().id, model).catch(() => {})
  const levelOption = () => selectOption(options, (o) => o.category === 'thought_level' || o.id === 'thinking_level')
  if (effort && values(levelOption()).includes(effort)) await set(levelOption().id, effort).catch(() => {})
  return {
    sessionId,
    model: String(modelOption()?.currentValue ?? session.models?.currentModelId ?? ''),
    effort: String(levelOption()?.currentValue ?? ''),
    lead: systemPrompt && !canAppend ? systemPrompt : '',
    tier: session._meta?.antigravity?.tier?.name ?? null,
  }
}

/**
 * What every session is told about where it works. The agent's file tools stop at the session
 * folder; Jarvis works with the whole computer, so the rest goes through the shell.
 */
export const accessNote = (cwd) =>
  `Pracovný priečinok je ${cwd}. Príkazy v shelli spúšťaj v ňom, pokiaľ úloha nehovorí inak. Používateľ ti dal prístup k celému počítaču: keď nástroj na súbory odmietne cestu mimo pracovného priečinka, je to len technické obmedzenie nástroja, nie zákaz, a to isté spravíš cez shell.`

/**
 * The MCP servers of Jarvis in the shape ACP wants them.
 *   hud          { url, tokenFile } of the running HUD, or null (then there is no jarvis-hud server)
 *   memoryCards  true lets the memory server show cards in the HUD (the voice brain); background
 *                runs read the memory quietly
 * The HUD token travels as a path to a file only this user can read: the agent keeps the
 * configuration of a session on disk, the token itself must not end up there.
 */
export function jarvisMcpServers({ hud = null, memoryCards = false, memoryDir, dataDir, base = process.env }) {
  const common = { JARVIS_MEMORY_DIR: memoryDir, JARVIS_DATA_DIR: dataDir }
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP', 'LANG', 'JARVIS_CONFIG', 'PORT', 'HUD_PORT']) if (base[key]) common[key] = base[key]
  const hudEnv = hud ? { HUD_URL: hud.url, HUD_BRAIN_TOKEN_FILE: hud.tokenFile } : {}
  const server = (name, file, env) => ({ name, command: process.execPath, args: [join(ROOT, 'server', 'mcp', file)], env: Object.entries(env).map(([k, v]) => ({ name: k, value: String(v) })) })
  return [
    server('memory', 'memory.mjs', { ...common, ...(memoryCards ? hudEnv : {}) }),
    server('computer', 'computer.mjs', common),
    ...(hud ? [server('jarvis-hud', 'jarvis-hud.mjs', { ...common, ...hudEnv })] : []),
  ]
}

/**
 * A tool call of the agent under the names the rest of Jarvis knows (Bash, Read, mcp__memory__…).
 * Takes a `tool_call` or `tool_call_update` and returns { id, name, input }.
 */
export function toolOf(update) {
  const raw = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput : {}
  const id = String(update.toolCallId ?? '')
  const mcp = update._meta?.mcp
  if (mcp?.server && mcp?.tool) return { id, name: `mcp__${mcp.server}__${mcp.tool}`, input: raw.arguments && typeof raw.arguments === 'object' ? raw.arguments : raw }
  const title = String(update.title ?? '').replace(/^Run(?:ning)?\s+/, '').replace(/\?$/, '')
  const file = raw.AbsolutePath ?? raw.absolute_path ?? raw.file_path ?? raw.TargetFile ?? raw.path ?? update.locations?.[0]?.path ?? ''
  switch (update.kind) {
    case 'execute':
      return { id, name: 'Bash', input: { command: raw.CommandLine ?? raw.command_line ?? raw.commandLine ?? raw.command ?? title } }
    case 'read':
      return { id, name: 'Read', input: { file_path: file } }
    case 'edit':
    case 'delete':
    case 'move':
      return { id, name: 'Edit', input: { file_path: file } }
    case 'fetch':
      return { id, name: 'WebFetch', input: { url: raw.url ?? raw.Url ?? '' } }
    case 'search':
      return /web/i.test(title) ? { id, name: 'WebSearch', input: { query: raw.query ?? raw.Query ?? '' } } : { id, name: 'Grep', input: { pattern: raw.query ?? raw.Query ?? raw.pattern ?? '' } }
    default:
      return { id, name: title || 'nástroj', input: raw }
  }
}

// ── is it installed and signed in ──────────────────────────────────────────

/**
 * Asks the agent itself whether it can work: starts it and opens an empty session. Never opens a
 * browser. Returns { installed, source, loggedIn, needsLogin, version, tier, model, error }.
 */
export async function antigravityStatus({ env, cwd }) {
  const install = antigravityInstall()
  const base = { installed: Boolean(install), source: install?.source ?? null, loggedIn: false, needsLogin: false, version: null, tier: null, model: null, error: null }
  if (!install) return { ...base, error: NOT_INSTALLED }
  const client = new AcpClient({ env: antigravityEnv(env, { install }), cwd })
  try {
    const info = await client.start()
    base.version = info?.agentInfo?.version ?? null
    const session = await openSession(client, { cwd })
    return { ...base, loggedIn: true, tier: session.tier, model: session.model }
  } catch (err) {
    return { ...base, needsLogin: Boolean(err?.auth), error: err?.auth ? NOT_LOGGED_IN : errMsg(err) }
  } finally {
    await client.close()
  }
}

/**
 * The agent's own Google sign-in: it opens the browser, the user signs in there, the agent keeps
 * the result. Jarvis only waits. `onLink` gets the address in case the browser did not open.
 */
export async function antigravityLogin({ env, cwd, onLink = () => {}, timeoutMs = 5 * 60_000 }) {
  const install = antigravityInstall()
  if (!install) throw new AcpError(NOT_INSTALLED)
  const client = new AcpClient({ env: antigravityEnv(env, { install, browser: true }), cwd, login: true, onAuthLink: onLink })
  try {
    const info = await client.start()
    const methods = (info?.authMethods ?? []).map((m) => m.id)
    const res = await client.request('authenticate', { methodId: methods.includes('oauth-personal') ? 'oauth-personal' : methods[0] ?? 'oauth-personal' }, { timeoutMs })
    return { tier: res?._meta?.antigravity?.tier?.name ?? null }
  } catch (err) {
    // The agent gave up on the browser: the window was closed, or something else answered on its one-time local address.
    if (err?.auth) throw new AcpError('Prihlásenie v prehliadači sa nedokončilo.', { code: err.code, auth: true })
    throw err
  } finally {
    await client.close()
  }
}
