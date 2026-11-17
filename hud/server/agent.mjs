/**
 * How full Claude Code runs are started on Jarvis's behalf (background jobs from the HUD and
 * scheduled routines). Jarvis works with everything the user's own Claude Code can do: files
 * anywhere on the computer, any shell command, the web and every connector. Nothing asks for
 * permission, because nobody sits at these runs to answer.
 *
 * What still holds is in the task itself, not in a permission list: anything that would go out
 * to other people (a mail, a message, an order) is prepared and waits for the user's yes.
 */
import { sep } from 'node:path'
import { MEMORY_DIR } from './memory/index.mjs'
import { aiProvider, cleanEnv } from './provider.mjs'
import { REPO } from './util.mjs'

/** The CLI of the agent Jarvis runs on (Claude Code or Codex, see provider.mjs). Kept under its old name for the callers. */
export const CLAUDE_BIN = aiProvider().bin()

export { cleanEnv }

/** True when the memory folder lives outside the Jarvis folder (JARVIS_MEMORY_DIR, e.g. an Obsidian vault). */
export const MEMORY_EXTERNAL = !(MEMORY_DIR + sep).startsWith(REPO + sep)
/** A headless run works in the Jarvis folder: an external memory folder has to be added explicitly. */
const dirArgs = () => (MEMORY_EXTERNAL ? ['--add-dir', MEMORY_DIR] : [])

/** CLI arguments of a headless run: full access, no questions. */
export function permissionArgs() {
  return ['--permission-mode', 'bypassPermissions', ...dirArgs()]
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
