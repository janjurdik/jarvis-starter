/**
 * Where Jarvis lives on this computer. Three places, the user picks one during setup and can change it
 * in Settings:
 *
 *   desktop  macOS only: Jarvis as the desktop under all windows
 *   app      his own window like any other program, opened with a Jarvis icon
 *   browser  a plain page in the user's own browser, opened when he wants it
 *
 * On a Mac the first two are one app, ~/Applications/Jarvis.app (hud/desktop/main.swift), which
 * switches between them on its own: it asks the server where Jarvis lives (GET /api/health, field
 * `surface`). Without that app (no developer tools to build it) and on Linux the app window is a
 * window without tabs in the user's own Chromium browser and profile, and without a Chromium
 * browser a plain tab. Windows: Microsoft Edge in app mode with a profile of its own (data/browser-profile)
 * and a Jarvis shortcut on the desktop and in the Start menu.
 *
 * `web` is what 1.8.0 called the window and still means it, so nobody's Jarvis moves on an update.
 * The choice is `surface` in config/jarvis.json (Settings) or, before Jarvis is set up, in data/setup.json.
 *
 * Jarvis lives in one place at a time. A change in Settings moves him at once: scripts/hud.mjs opens
 * the new place and then asks the server to keep only that one (POST /api/surface/keep). The Mac app
 * follows the server by itself, an app window in a browser closes itself, the Edge window on Windows
 * is ended here, a plain browser tab is told that it can be closed.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
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

// ── the Mac app ──────────────────────────────────────────────────────────────

/** Bundle ids: the app of today, and the two apps of 1.9.7 and older it replaces (hud/desktop/install.sh). */
export const MAC_APP_ID = 'com.jarvis-starter.app'
export const OLD_MAC_IDS = { desktop: 'com.jarvis-starter.hud', launcher: 'com.jarvis-starter.window' }

/** Where the Jarvis app is on a Mac. JARVIS_APP_DIR puts it into another folder (tests, a second installation). */
export const macAppPath = (env = process.env) => join(env.JARVIS_APP_DIR || join(homedir(), 'Applications'), 'Jarvis.app')

/** The program inside the app, the way it shows up in the list of processes. */
export const macAppExe = (app) => join(app, 'Contents', 'MacOS', 'Jarvis')

/** What the app is built from (hud/desktop/build.sh writes the same into it as JarvisSource). */
export function macAppSource(repo) {
  const dir = join(repo, 'hud', 'desktop')
  try {
    return createHash('sha256').update(Buffer.concat([readFileSync(join(dir, 'main.swift')), readFileSync(join(dir, 'Info.plist'))])).digest('hex')
  } catch {
    return null
  }
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** The string values of an XML Info.plist ({ CFBundleIdentifier: …, JarvisRepo: … }), null when there is none. */
export function parsePlistStrings(text) {
  if (typeof text !== 'string' || !text.includes('<plist')) return null
  const out = {}
  for (const m of text.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) out[m[1]] = unxml(m[2])
  return out
}

/**
 * Is the app at `app` the current build for this folder?
 *   missing  nothing there
 *   foreign  something else with the same name (the icon of 1.9.7 counts too: the build replaces it)
 *   stale    an older build, or one made for another folder, port or Node: built again
 *   ready
 */
export function macAppState({ app, repo, port, exists = existsSync }) {
  let info = null
  try {
    info = parsePlistStrings(readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8'))
  } catch {
    return { state: 'missing' }
  }
  if (!info) return { state: 'foreign', id: null }
  if (info.CFBundleIdentifier !== MAC_APP_ID) return { state: 'foreign', id: info.CFBundleIdentifier ?? null }
  const why =
    info.JarvisSource !== macAppSource(repo) ? 'iný kód appky' : info.JarvisRepo !== repo ? 'iný priečinok' : String(info.JarvisPort) !== String(port) ? 'iný port' : !exists(info.JarvisNode) ? 'Node sa presťahoval' : null
  return why ? { state: 'stale', why, info } : { state: 'ready', info }
}

/** Process ids of the Jarvis app that runs from `app` (from the output of `ps -axo pid=,command=`). */
export function macAppPids(psOut, app) {
  const exe = macAppExe(app)
  return String(psOut ?? '')
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((m) => m && (m[2] === exe || m[2].startsWith(`${exe} `)))
    .map((m) => Number(m[1]))
}

// ── the app window in a browser ──────────────────────────────────────────────

/** Chromium browsers on a Mac that open a window without tabs (--app), in the order they are preferred. */
export const MAC_CHROMIUM = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Vivaldi']

/**
 * Is the user's own browser running (its main process, with his own profile)? A helper process has
 * a --type, a separate instance (the Jarvis window of 1.9.7 and older) its own --user-data-dir.
 */
export function ownBrowserRunning(psOut, bin) {
  return String(psOut ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\s+/, ''))
    .some((cmd) => (cmd === bin || cmd.startsWith(`${bin} `)) && !cmd.includes('--type=') && !cmd.includes('--user-data-dir='))
}

/**
 * How the app window is opened with a Chromium browser: { cmd, args }.
 *   win32   Edge (or Chrome) with a profile of its own, full screen. Windows has no LaunchServices that
 *           could send the user's own clicks to it, and the profile keeps the microphone permission.
 *   darwin  the user's own browser and profile, never a second instance: macOS would send his clicks
 *           on the Chrome icon to that instance, which knows none of his accounts. Not running: started
 *           through the system (open -a), then the browser answers for the camera and the microphone
 *           itself, not Node. Running: its program with --app hands the window over to it and ends.
 *   linux   the program with --app, which also hands over to a running browser.
 */
export function appWindowLaunch({ platform = process.platform, bin, url, profile = null, running = false }) {
  const app = `--app=${url}${url.includes('?') ? '&' : '?'}surface=app`
  if (platform === 'win32') return { cmd: bin, args: [app, '--start-fullscreen', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'] }
  const bundle = platform === 'darwin' ? /^(.+\.app)\/Contents\/MacOS\//.exec(bin)?.[1] : null
  if (bundle && !running) return { cmd: '/usr/bin/open', args: ['-a', bundle, '--args', app] }
  return { cmd: bin, args: [app] }
}

/** Only Windows runs the app window with a profile of its own. */
export const usesAppProfile = (platform = process.platform) => platform === 'win32'

/** The folder of the browser profile the app window runs with on Windows. Its path in a command line is how the window is found. */
export const appProfile = (dataDir) => join(dataDir, 'browser-profile')

/**
 * Process ids of an app window with our own profile: on Windows the Edge window of today, on a Mac
 * the Chrome window of 1.9.7 and older (a second Chrome that took over the user's own Chrome clicks).
 */
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

/**
 * Should the window with our own profile end when Jarvis keeps `keep`? On Windows when he moved
 * elsewhere; on a Mac always, it is a leftover of 1.9.7 and older.
 */
export const closesProfileWindow = (keep, platform = process.platform) => keep !== 'app' || !usesAppProfile(platform)

/** Ends the app window with our own profile. Returns how many processes were asked to end. */
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
 * Detached, the HUD server does not wait for a window (or for the Mac app to be built).
 */
export function startMove({ env = process.env } = {}) {
  if (env.JARVIS_NO_MOVE === '1') return false
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'hud.mjs')
  spawn(process.execPath, [script, '--move'], { cwd: dirname(dirname(script)), detached: true, stdio: 'ignore', windowsHide: true, env }).unref()
  return true
}
