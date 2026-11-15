/**
 * How full Claude Code runs are started on Jarvis's behalf (background jobs from the HUD and
 * scheduled routines). One place decides what such a run may do without asking:
 *
 *   JARVIS_AGENT_MODE=safe   (default) files in the Jarvis folder, web search, the user's
 *                            connectors (mail, calendar, …) and Jarvis's own scripts in scripts/.
 *                            Any other shell command is refused.
 *   JARVIS_AGENT_MODE=full   everything Claude Code can do, including any shell command.
 *
 * Connector names are not known in advance, so in safe mode a small PreToolUse hook
 * (allow-connectors.mjs) lets MCP tools through, passed with --settings.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { MEMORY_DIR } from './memory/index.mjs'
import { BRAIN_DIR, HOME, REPO, ROOT, findBin, withPath } from './util.mjs'

export const CLAUDE_BIN = findBin('claude', { override: process.env.JARVIS_CLAUDE_BIN })
export const AGENT_MODE = (process.env.JARVIS_AGENT_MODE || 'safe').toLowerCase() === 'full' ? 'full' : 'safe'

const SAFE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent', 'Skill']
/** Jarvis's own scripts are part of the safe set: importing an export, searching messages or updating must work without full mode. */
const SAFE_SCRIPTS = ['doctor', 'scan', 'import', 'pulse', 'routine', 'schedule', 'update', 'hud', 'call'].map((n) => `Bash(node scripts/${n}.mjs:*)`)
const SETTINGS_FILE = join(BRAIN_DIR, 'agent-settings.json')

/** Environment for Claude child processes: the parent's, minus anything that would switch Claude to an API key. */
export function cleanEnv() {
  const env = withPath(process.env, [dirname(process.execPath), join(HOME, '.local', 'bin')])
  for (const key of Object.keys(env)) {
    if (key === 'ANTHROPIC_API_KEY' || key === 'ANTHROPIC_AUTH_TOKEN' || key === 'ANTHROPIC_BASE_URL' || key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key]
  }
  env.DISABLE_AUTOUPDATER = '1'
  return env
}

/** True when the memory folder lives outside the Jarvis folder (JARVIS_MEMORY_DIR, e.g. an Obsidian vault). */
export const MEMORY_EXTERNAL = !(MEMORY_DIR + sep).startsWith(REPO + sep)
/** A headless run works in the Jarvis folder: an external memory folder has to be added explicitly. */
const dirArgs = () => (MEMORY_EXTERNAL ? ['--add-dir', MEMORY_DIR] : [])

/** CLI arguments that set the permission level of a headless run. */
export function permissionArgs() {
  if (AGENT_MODE === 'full') return ['--permission-mode', 'bypassPermissions', ...dirArgs()]
  // Forward slashes: the hook runs through a shell, where backslashes in Windows paths are fragile.
  const fwd = (p) => p.replace(/\\/g, '/')
  const hook = `"${fwd(process.execPath)}" "${fwd(join(ROOT, 'server', 'allow-connectors.mjs'))}"`
  mkdirSync(BRAIN_DIR, { recursive: true })
  writeFileSync(SETTINGS_FILE, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'mcp__.*', hooks: [{ type: 'command', command: hook }] }] } }, null, 2), { mode: 0o600 })
  return ['--permission-mode', 'dontAsk', '--allowedTools', [...SAFE_TOOLS, ...SAFE_SCRIPTS, 'Bash(npm install)', 'Bash(npm.cmd install)'].join(','), '--settings', SETTINGS_FILE, ...dirArgs()]
}

/**
 * Optional model override for agent runs (without it Claude Code uses the user's default model),
 * plus any extra CLI arguments from JARVIS_CLAUDE_ARGS (space separated, for advanced setups).
 */
export function modelArgs() {
  const model = process.env.JARVIS_JOB_MODEL
  const extra = (process.env.JARVIS_CLAUDE_ARGS ?? '').split(/\s+/).filter(Boolean)
  return [...(model ? ['--model', model] : []), ...extra]
}
