/**
 * Shared helpers for the command line scripts (doctor, hud, routine, schedule, autostart).
 * Loads .env first, then reuses the same building blocks as the HUD server.
 */
import '../hud/server/env.mjs'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { inWindow, quietNow } from '../hud/server/alarm.mjs'
import { DATA_DIR, IS_MAC, IS_WIN, REPO, WIN_POWERSHELL, findBin, spawnBin, winSys } from '../hud/server/util.mjs'

export { DATA_DIR, IS_MAC, IS_WIN, REPO, WIN_POWERSHELL, findBin, inWindow, quietNow, spawnBin, winSys }

export const PORT = Number(process.env.PORT ?? process.env.HUD_PORT ?? 4545)
export const HUD_URL = `http://127.0.0.1:${PORT}`
export const LOG_DIR = join(DATA_DIR, 'logs')
/** Label prefix of everything Jarvis registers in the system (launchd agents, scheduled tasks). */
export const LABEL = 'com.jarvis-starter'
export const TASK_FOLDER = 'Jarvis'

export const has = (path) => existsSync(path)

/** Runs a command and returns { code, out }. Never throws. */
export function sh(bin, args = [], { timeout = 20_000, cwd = REPO, input = null, env = null } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, out: out.trim() })
    }
    let child
    try {
      child = spawnBin(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) })
    } catch (err) {
      return resolve({ code: 1, out: String(err?.message ?? err) })
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(124)
    }, timeout)
    child.stdout.on('data', (d) => (out = `${out}${d}`.slice(-200_000)))
    child.stderr.on('data', (d) => (out = `${out}${d}`.slice(-200_000)))
    child.on('error', (err) => {
      out = `${out}${err.message}`
      finish(1)
    })
    child.on('exit', (code) => finish(code ?? 1))
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

export async function hudAlive() {
  try {
    const res = await fetch(`${HUD_URL}/api/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * How many HUD windows listen right now: -1 when the server does not run, 0 when it runs without
 * a window (then nobody would hear it speak), otherwise the number of open windows.
 */
export async function hudListeners() {
  try {
    const res = await fetch(`${HUD_URL}/api/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return -1
    const body = await res.json().catch(() => ({}))
    return Number.isFinite(body.clients) ? body.clients : 1
  } catch {
    return -1
  }
}

export async function postHud(path, body) {
  try {
    const res = await fetch(`${HUD_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
    return res.ok
  } catch {
    return false
  }
}

/** Flags like --dry-run and --json, plus positional arguments. */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2)))
  const rest = argv.filter((a) => !a.startsWith('--'))
  return { flags, rest }
}

/**
 * Rings the user's mobile in the background (scripts/call.mjs) and returns at once. The caller
 * (pulse, routine) must not wait for a phone call to finish.
 */
export function callOut(text, source) {
  const say = String(text ?? '').replace(/\s+/g, ' ').replace(/^-+/, '').trim()
  if (!say) return
  spawn(process.execPath, [join(REPO, 'scripts', 'call.mjs'), say, `--source=${source}`], { cwd: REPO, detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

/** A system notification (macOS notification centre, Windows toast). Never throws. */
export async function notify(heading, text) {
  // Tests and throwaway instances (JARVIS_NO_NOTIFY=1) must not pop notifications on the machine that runs them.
  if (process.env.JARVIS_NO_NOTIFY === '1') return
  const env = { ...process.env, J_TITLE: String(heading).slice(0, 80), J_TEXT: String(text).replace(/\s+/g, ' ').slice(0, 220) }
  if (IS_MAC) {
    // Text goes in as arguments: `system attribute` reads the environment as MacRoman and breaks diacritics.
    const script = ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run']
    await new Promise((resolve) => spawn('/usr/bin/osascript', [...script, env.J_TITLE, env.J_TEXT], { stdio: 'ignore' }).on('exit', resolve).on('error', resolve))
  } else if (IS_WIN) {
    const ps = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      "$x = $t.GetElementsByTagName('text')",
      '$x.Item(0).AppendChild($t.CreateTextNode($env:J_TITLE)) | Out-Null',
      '$x.Item(1).AppendChild($t.CreateTextNode($env:J_TEXT)) | Out-Null',
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($t))",
    ].join('; ')
    await new Promise((resolve) => spawn(WIN_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', ps], { env, stdio: 'ignore', windowsHide: true }).on('exit', resolve).on('error', resolve))
  }
}
