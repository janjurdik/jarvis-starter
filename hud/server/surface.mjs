/**
 * Where Jarvis lives on this computer. Three places, the user picks one during setup and can change it
 * in Settings:
 *
 *   desktop  macOS only: the "Jarvis HUD" app, Jarvis as the desktop under all windows
 *   app      his own window like any other program, opened with a Jarvis icon
 *            (~/Applications/Jarvis.app, on Windows a shortcut on the desktop and in the Start menu)
 *   browser  a plain page in the user's own browser, opened when he wants it
 *
 * `web` is what 1.8.0 called the window and still means it, so nobody's Jarvis moves on an update.
 * The choice is `surface` in config/jarvis.json (Settings) or, before Jarvis is set up, in data/setup.json.
 *
 * Jarvis lives in one place at a time. A change in Settings moves him at once: scripts/hud.mjs opens
 * the new place and then asks the server to keep only that one (POST /api/surface/keep). The desktop
 * app ends itself over its bridge, the app window is a browser of its own and is ended here, a plain
 * browser tab is told that it can be closed.
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SURFACES = ['desktop', 'app', 'browser']

/** One of SURFACES, or null for anything else. */
export function normalizeSurface(value) {
  const v = String(value ?? '').trim().toLowerCase()
  if (v === 'web' || v === 'window') return 'app'
  if (v === 'page' || v === 'tab') return 'browser'
  return SURFACES.includes(v) ? v : null
}

/** What this computer can offer. The desktop needs the macOS app. */
export const surfacesFor = (platform = process.platform) => (platform === 'darwin' ? SURFACES : SURFACES.filter((s) => s !== 'desktop'))

const readKey = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).surface ?? null
  } catch {
    return null
  }
}

/**
 * { surface, raw }: the place that applies and the value it came from (null when nothing was chosen).
 * The config wins over what setup wrote down. Without a choice: the desktop on a Mac, a window elsewhere.
 */
export function resolveSurface({ configFile, dataDir, config = undefined, platform = process.platform } = {}) {
  const fallback = platform === 'darwin' ? 'desktop' : 'app'
  const values = [config === undefined ? (configFile ? readKey(configFile) : null) : config, dataDir ? readKey(join(dataDir, 'setup.json')) : null]
  for (const raw of values) {
    const s = normalizeSurface(raw)
    if (!s) continue
    return { surface: surfacesFor(platform).includes(s) ? s : fallback, raw: String(raw).toLowerCase() }
  }
  return { surface: fallback, raw: null }
}

/** The folder of the browser profile the app window runs with. Its path in a command line is how the window is found. */
export const appProfile = (dataDir) => join(dataDir, 'browser-profile')

/** Process ids of the app window: the main process of the browser that runs with our own profile. */
export function appWindowPids(dataDir, platform = process.platform) {
  const profile = appProfile(dataDir)
  try {
    if (platform === 'win32') {
      const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--user-data-dir=${profile.replace(/'/g, "''")}') -and $_.CommandLine.Contains('--app=') -and -not $_.CommandLine.Contains('--type=') } | ForEach-Object { $_.ProcessId }`
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
      return String(r.stdout ?? '').split(/\s+/).map(Number).filter(Boolean)
    }
    // It has the profile and the app address on its command line, its helper processes also have a --type.
    const r = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 8000, maxBuffer: 8 * 1024 * 1024 })
    return String(r.stdout ?? '')
      .split('\n')
      .filter((line) => line.includes(`--user-data-dir=${profile}`) && line.includes('--app=') && !line.includes('--type='))
      .map((line) => Number(line.trim().split(/\s+/)[0]))
      .filter((pid) => pid && pid !== process.pid)
  } catch {
    return []
  }
}

/** Ends the app window. Returns how many processes were asked to end. */
export function closeAppWindow(dataDir, platform = process.platform) {
  let n = 0
  for (const pid of appWindowPids(dataDir, platform)) {
    try {
      process.kill(pid, 'SIGTERM')
      n++
    } catch {
      // gone already
    }
  }
  return n
}

/**
 * Jarvis moves: the launcher opens the place that is in the config now and closes the others.
 * Detached, the HUD server does not wait for a window (or for the desktop app to be built).
 */
export function startMove({ env = process.env } = {}) {
  if (env.JARVIS_NO_MOVE === '1') return false
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'hud.mjs')
  spawn(process.execPath, [script, '--move'], { cwd: dirname(dirname(script)), detached: true, stdio: 'ignore', windowsHide: true, env }).unref()
  return true
}
