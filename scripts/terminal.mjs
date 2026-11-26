#!/usr/bin/env node
/**
 * Opens a real terminal window with one known Jarvis command already running in the Jarvis folder,
 * for the rare thing that truly needs one (a CLI login that hops to the browser). The user is never
 * asked to open a terminal or to type a command: Jarvis (or the setup chat) runs this instead.
 *
 *   node scripts/terminal.mjs                  the known actions
 *   node scripts/terminal.mjs claude_login     Claude (also codex_login, antigravity_login, garmin_login, doctor, apple_tools)
 *   node scripts/terminal.mjs claude_login --dry-run   print what would run, open nothing
 *
 * Only actions from the fixed list in hud/server/terminal.mjs can run, never a command from outside.
 */
import { TERMINAL_ACTIONS, openTerminal, terminalLaunch } from '../hud/server/terminal.mjs'

const argv = process.argv.slice(2)
const action = argv.find((a) => !a.startsWith('--'))
const json = argv.includes('--json')

if (!action) {
  const list = Object.entries(TERMINAL_ACTIONS).map(([id, a]) => ({ id, title: a.title }))
  console.log(json ? JSON.stringify({ ok: true, actions: list }, null, 2) : list.map((a) => `${a.id.padEnd(18)} ${a.title}`).join('\n'))
  process.exit(0)
}
if (argv.includes('--dry-run')) {
  const plan = terminalLaunch(action)
  console.log(JSON.stringify(plan, null, 2))
  process.exit(plan.ok ? 0 : 1)
}
const r = await openTerminal(action)
if (json) console.log(JSON.stringify(r, null, 2))
else console.log(r.ok ? `Okno je otvorené. Povedz mu: ${r.say}` : `Okno sa neotvorilo: ${r.error}`)
process.exit(r.ok ? 0 : 1)
