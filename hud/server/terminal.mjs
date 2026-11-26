/**
 * open_terminal: the rare thing that truly needs an interactive terminal (a CLI login that hops to
 * the browser) is opened by Jarvis himself, in a real terminal window, with the command already
 * running in the Jarvis folder. The user is never asked to open a terminal or to type a command.
 *
 * Only actions from the fixed list below can run. The brain names an action, never a command, so
 * nothing it read (a mail, a web page) can smuggle a command in. The only variable part is the
 * Jarvis folder, which is quoted for each platform:
 *
 *   macOS    osascript tells Terminal to `do script` the line. The line is passed to the AppleScript
 *            as an argument (`on run argv`), so it is never spliced into AppleScript source; the
 *            folder is single-quoted for the shell ('\'' for a quote inside).
 *   Windows  a new PowerShell window (`-NoExit`, its own console because it is detached) with the
 *            script as -EncodedCommand (UTF-16LE base64): no quoting by cmd or PowerShell at all.
 *            The folder is the working directory of the process, not part of the script.
 *   Linux    x-terminal-emulator, gnome-terminal, konsole or xterm, whichever exists, with the
 *            folder as the working directory and `sh -c` running the fixed line.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from './util.mjs'

/**
 * The known actions: what runs (per platform), what the window is for and the one sentence Jarvis
 * says about what the user will see there.
 */
export const TERMINAL_ACTIONS = {
  claude_login: {
    title: 'Prihlásenie do Claude',
    run: { posix: 'claude auth login', win: 'claude auth login' },
    say: 'Otvoril som okno s prihlásením do Claude. Otvorí sa aj prehliadač, tam kliknite Povoliť, a potom okno pokojne zavrite.',
  },
  codex_login: {
    title: 'Prihlásenie do ChatGPT',
    run: { posix: 'codex login', win: 'codex login' },
    say: 'Otvoril som okno s prihlásením do ChatGPT. V prehliadači sa prihláste účtom s predplatným a potom okno zavrite.',
  },
  antigravity_login: {
    title: 'Prihlásenie do Antigravity',
    run: { posix: 'node scripts/antigravity.mjs login', win: 'node scripts/antigravity.mjs login' },
    say: 'Otvoril som okno s prihlásením do Antigravity. V prehliadači sa prihláste účtom Google a potom okno zavrite.',
  },
  garmin_login: {
    title: 'Prihlásenie do Garminu v termináli',
    run: { posix: 'node scripts/garmin.mjs login', win: 'node scripts/garmin.mjs login' },
    say: 'Otvoril som okno s prihlásením do Garminu. Napíšte tam e-mail, heslo a stlačte Enter, heslo sa pri písaní nezobrazuje.',
  },
  doctor: {
    title: 'Kontrola počítača',
    run: { posix: 'node scripts/doctor.mjs', win: 'node scripts/doctor.mjs' },
    say: 'Otvoril som okno s kontrolou počítača. Nič tam písať netreba, len si prečítajte, čo svieti.',
  },
  apple_tools: {
    title: 'Nástroje pre vývojárov od Apple',
    run: { posix: 'xcode-select --install', win: null },
    platforms: ['darwin'],
    say: 'Otvoril som inštaláciu nástrojov od Apple. V okne, ktoré vyskočí, kliknite Inštalovať a počkajte, kým dobehne.',
  },
}

/** A folder for a POSIX shell: single quotes, a quote inside becomes '\''. */
export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** PowerShell's -EncodedCommand: the script as UTF-16LE in base64. */
export const psEncode = (script) => Buffer.from(String(script), 'utf16le').toString('base64')

const LINUX_TERMINALS = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm']

function findLinuxTerminal(exists) {
  for (const name of LINUX_TERMINALS) for (const dir of ['/usr/bin', '/usr/local/bin', '/bin']) if (exists(join(dir, name))) return join(dir, name)
  return null
}

/**
 * How to open the window, without opening it: { ok, bin, args, options, action } or { ok: false, error }.
 * Pure apart from looking for a Linux terminal, so tests can check every platform.
 */
export function terminalLaunch(action, { platform = process.platform, repo = REPO, env = process.env, exists = existsSync } = {}) {
  const a = Object.hasOwn(TERMINAL_ACTIONS, String(action)) ? TERMINAL_ACTIONS[action] : null
  if (!a) return { ok: false, error: `neznáma akcia ${JSON.stringify(action)}, povolené: ${Object.keys(TERMINAL_ACTIONS).join(', ')}` }
  if (a.platforms && !a.platforms.includes(platform)) return { ok: false, error: `${a.title} na tomto systéme netreba` }
  const title = a.title
  if (platform === 'darwin') {
    const line = `cd ${shQuote(repo)} && clear && ${a.run.posix}`
    const script = ['on run argv', 'tell application "Terminal"', 'activate', 'do script (item 1 of argv)', 'end tell', 'end run']
    return { ok: true, action, title, bin: '/usr/bin/osascript', args: [...script.flatMap((l) => ['-e', l]), '--', line], options: { stdio: 'ignore' } }
  }
  if (platform === 'win32') {
    const sys32 = `${env.SystemRoot || 'C:\\Windows'}\\System32`
    const ps = `$Host.UI.RawUI.WindowTitle = '${title.replace(/'/g, "''")}'; ${a.run.win}`
    return {
      ok: true,
      action,
      title,
      bin: `${sys32}\\WindowsPowerShell\\v1.0\\powershell.exe`,
      args: ['-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', psEncode(ps)],
      // detached: a console program gets its own new console window; windowsHide false so it shows.
      options: { cwd: repo, detached: true, stdio: 'ignore', windowsHide: false },
    }
  }
  const term = findLinuxTerminal(exists)
  if (!term) return { ok: false, error: 'v tomto počítači som nenašiel program terminálu' }
  const shLine = `${a.run.posix}; exec "\${SHELL:-sh}"`
  const args = /gnome-terminal$/.test(term) ? ['--', 'sh', '-c', shLine] : ['-e', 'sh', '-c', shLine]
  return { ok: true, action, title, bin: term, args, options: { cwd: repo, detached: true, stdio: 'ignore' } }
}

/** Opens the window. Resolves { ok, say } or { ok: false, error }. */
export function openTerminal(action, opts = {}) {
  const plan = terminalLaunch(action, opts)
  if (!plan.ok) return Promise.resolve(plan)
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(plan.bin, plan.args, plan.options)
    } catch (err) {
      return resolve({ ok: false, error: err.message })
    }
    child.on('error', (err) => resolve({ ok: false, error: err.message }))
    if (plan.options.detached) {
      child.unref()
      setTimeout(() => resolve({ ok: true, say: TERMINAL_ACTIONS[action].say, title: plan.title }), 300)
      return
    }
    child.on('exit', (code) => resolve(code === 0 ? { ok: true, say: TERMINAL_ACTIONS[action].say, title: plan.title } : { ok: false, error: `okno sa neotvorilo (kód ${code}); macOS sa možno pýta na povolenie ovládať Terminál` }))
  })
}
