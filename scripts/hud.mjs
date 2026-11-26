#!/usr/bin/env node
/**
 * Starts the Jarvis HUD and opens its window.
 *
 *   npm run hud               start the server (if it is not running) and open Jarvis where he lives
 *   npm run hud -- --server   only the server, no window
 *   npm run hud -- --stop     stop the server
 *   npm run hud -- --restart  stop and start again (after changing .env). Waits for running background
 *                             jobs: the server then restarts itself when they are done (--now does not wait)
 *   npm run hud -- --status   is it running?
 *   npm run hud -- --reload   the open window of Jarvis loads itself again (it also does so on its own
 *                             when something in hud/public changes and after a restart of the server)
 *   npm run hud -- --info     installation summary from the running server (JSON)
 *   npm run hud -- --apps     open the HUD and fly to the Tvoje appky orb (the app picker), optionally
 *                             at one app: node scripts/hud.mjs --apps instagram
 *   npm run hud -- --browser  open Jarvis once in a window of the browser (Chrome, Edge), wherever he lives
 *   npm run hud -- --no-prepare   do not wait for the voice (see below)
 *
 * Before the window opens for the first time the voice is prepared (`scripts/voice.mjs prepare`):
 * the local Whisper model for speech recognition and the voice's packages. The wait is limited
 * (JARVIS_PREPARE_WAIT_S, 15 minutes by default): after that the HUD opens anyway, the download
 * carries on in the background and Jarvis listens through the browser until it is done.
 *
 * Where: the place the user chose (`surface` in config/jarvis.json, or in data/setup.json as asked
 * during setup; hud/server/surface.mjs).
 *   desktop  macOS only, the default there: the Jarvis app as the desktop under the windows.
 *   app      his own window like any other program. On a Mac the same Jarvis app in a window of
 *            its own (~/Applications/Jarvis.app, one app for both, it moves between them by itself).
 *            The app is built on first use and again after an update of its code (hud/desktop/build.sh,
 *            needs the Xcode command line tools). Without them, and on Linux, the window is a window
 *            without tabs in the user's own Chrome, Edge or Brave (never a second instance of it),
 *            without any of them a plain tab. Windows: Edge in app mode and a Jarvis icon on the
 *            desktop and in the Start menu (scripts/launcher.mjs).
 *   browser  a plain page in the user's own browser. Nothing opens at login, the server just runs.
 *
 *   --front  what the Jarvis icon runs: open the window, or bring the open one forward
 *   --move   what Settings run after a change of the place: open the new one (the others then close)
 *   --login  what the start at login runs: like a plain start, except that a `browser` Jarvis opens no page
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { DATA_DIR, HUD_URL, IS_MAC, IS_WIN, LOG_DIR, PORT, REPO, WIN_POWERSHELL, findBin, has, hudAlive, parseArgs, postHud, sh, winSys } from './lib.mjs'
import { prepareNeeded, prepareRunning, readProgress } from '../hud/server/stt-plan.mjs'
import { MAC_CHROMIUM, OLD_MAC_IDS, appProfile, appWindowLaunch, appWindowPids, macAppPath, macAppPids, macAppState, ownBrowserRunning, resolveSurface } from '../hud/server/surface.mjs'
import { ensureLauncher } from './launcher.mjs'

const { flags } = parseArgs()
const PID_FILE = join(DATA_DIR, 'hud.pid')
const MAC_APP = macAppPath()

/** Where Jarvis lives: { surface: desktop | app | browser, raw: what was chosen }. */
function place() {
  return resolveSurface({ configFile: process.env.JARVIS_CONFIG || join(REPO, 'config', 'jarvis.json'), dataDir: DATA_DIR })
}

/** What the running server says about itself (GET /api/health), or null. */
async function health() {
  try {
    const res = await fetch(`${HUD_URL}/api/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/** How many windows of one kind (desktop, app, browser) are connected to the server. */
const windowsOf = async (kind) => Number((await health())?.windows?.[kind]) || 0

const processList = async () => (await sh('/bin/ps', ['-axo', 'pid=,command='], { timeout: 8000 })).out

/** Builds and installs the Jarvis app (hud/desktop/build.sh). False when this Mac cannot build it or the build failed. */
async function buildMacApp() {
  if (!findBin('swiftc')) {
    console.log('Appku Jarvis si tento Mac postaví sám. Chýbajú mu na to nástroje pre vývojárov od Apple.')
    console.log('  Nainštaluje ich príkaz: xcode-select --install (okno potvrď, trvá pár minút), potom znova: node scripts/hud.mjs')
    return false
  }
  console.log('Staviam appku Jarvis (raz, asi minútu)…')
  const r = await sh('/bin/sh', [join(REPO, 'hud', 'desktop', 'build.sh')], { timeout: 6 * 60_000, env: { ...process.env, PORT: String(PORT) } })
  for (const line of String(r.out ?? '').split('\n')) if (line.startsWith('do koša: ')) console.log(`  Starú appku som dal do koša: ${line.slice(9)}`)
  if (r.code !== 0 || macAppState({ app: MAC_APP, repo: REPO, port: PORT }).state !== 'ready') {
    console.log(`Appku Jarvis sa nepodarilo postaviť. ${String(r.out ?? '').trim().split('\n').slice(-2).join(' ')}`.trim())
    return false
  }
  return true
}

/** The Jarvis app on this Mac, built or brought up to date when needed. True when there is one to open. */
async function ensureMacApp() {
  const s = macAppState({ app: MAC_APP, repo: REPO, port: PORT })
  if (s.state === 'ready') return true
  // Something else called Jarvis (not the icon of an older version, which the build replaces) stays untouched.
  if (s.state === 'foreign' && s.id !== OLD_MAC_IDS.launcher) {
    console.log(`V ${MAC_APP} je iná appka s menom Jarvis (${s.id ?? 'neznáma'}). Nechávam ju tak.`)
    return false
  }
  if (s.state === 'stale') console.log(`Appku Jarvis staviam znova (${s.why}).`)
  // An older build that cannot be replaced right now still beats a browser window.
  return (await buildMacApp()) || s.state === 'stale'
}

/**
 * Opens the Jarvis app in its place. A running app follows the server to the desktop or into its
 * window by itself: `open` only brings it forward (the reopen event shows the window, or lifts the
 * desktop above the windows), so it is sent when somebody wants to see Jarvis now.
 */
async function openMacApp(surface) {
  const running = macAppPids(await processList(), MAC_APP).length > 0
  if (running && (flags.has('move') || (surface === 'desktop' && !flags.has('front') && !flags.has('apps')))) return 'running'
  spawn('/usr/bin/open', running ? [MAC_APP] : [MAC_APP, '--args', '--surface', surface], { detached: true, stdio: 'ignore' }).unref()
  return running ? 'running' : 'started'
}

/** A Chromium browser for the app window: { bin, name, running }, the one already running first. Null without any. */
async function chromiumBrowser() {
  const own = process.env.JARVIS_BROWSER && has(process.env.JARVIS_BROWSER) ? process.env.JARVIS_BROWSER : null
  if (IS_WIN) {
    const bin =
      own ??
      [
        join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ].find((p) => p && has(p))
    return bin ? { bin, name: /msedge/i.test(bin) ? 'Edge' : 'Chrome', running: false } : null
  }
  const found = own
    ? [own]
    : IS_MAC
      ? MAC_CHROMIUM.flatMap((name) => ['/Applications', join(homedir(), 'Applications')].map((dir) => join(dir, `${name}.app`, 'Contents', 'MacOS', name))).filter(has)
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'].map((b) => findBin(b)).filter(Boolean)
  if (!found.length) return null
  const ps = await processList()
  const bin = found.find((b) => ownBrowserRunning(ps, b)) ?? found[0]
  return { bin, name: basename(bin), running: ownBrowserRunning(ps, bin) }
}

/** Opens the page in whatever opens http links on this computer. */
function openDefault(url) {
  if (IS_MAC) spawn('/usr/bin/open', [url], { detached: true, stdio: 'ignore' }).unref()
  else if (IS_WIN) spawn(winSys('rundll32.exe'), ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref()
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
}

/** The app window in a browser: { text, kept } (kept: the place that is open now, for /api/surface/keep). */
async function openBrowserWindow(url) {
  const b = await chromiumBrowser()
  if (!b) {
    // No Chromium browser: a plain tab of the default browser (Safari, Firefox) still is Jarvis.
    openDefault(url)
    return { text: 'Jarvisa ako kartu v predvolenom prehliadači (okno bez kariet vie otvoriť len Chrome, Edge alebo Brave)', kept: 'browser' }
  }
  const { cmd, args } = appWindowLaunch({ bin: b.bin, url, profile: appProfile(DATA_DIR), running: b.running })
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref()
  return { text: IS_WIN ? 'samostatné okno Jarvisa na celú obrazovku' : `samostatné okno Jarvisa v prehliadači ${b.name}`, kept: 'app' }
}

/** Is an app window of Jarvis open in a browser right now? */
const browserWindowOpen = async () => (IS_WIN ? appWindowPids(DATA_DIR).length > 0 : (await windowsOf('app')) > 0)

/** Best effort: the app window in a browser that is already open comes forward. */
async function bringForward() {
  if (IS_WIN) {
    spawn(WIN_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', "(New-Object -ComObject WScript.Shell).AppActivate('Jarvis') | Out-Null"], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return
  }
  const b = IS_MAC ? await chromiumBrowser() : null
  if (!b) return
  // The window is the user's own browser: the one with Jarvis's address goes on top, then the browser comes forward.
  const name = b.name.replace(/"/g, '')
  const script = [
    `tell application "${name}"`,
    '  repeat with w in windows',
    '    try',
    `      if (URL of active tab of w) starts with "http://localhost:${PORT}" then set index of w to 1`,
    '    end try',
    '  end repeat',
    '  activate',
    'end tell',
  ]
  await sh('/usr/bin/osascript', script.flatMap((line) => ['-e', line]), { timeout: 5000 })
}

/**
 * Opens Jarvis where he lives: { text, kept, already }. `kept` is the place that is open now
 * (it can differ from the chosen one: no app could be built), `already` when it was open before.
 */
async function openWindow() {
  const url = `http://localhost:${PORT}/`
  if (flags.has('browser')) return { ...(await openBrowserWindow(url)), once: true }
  const { surface, raw } = place()
  if (surface === 'browser') {
    openDefault(url)
    return { text: `stránku v prehliadači (${url})`, kept: 'browser' }
  }
  if (IS_MAC && (await ensureMacApp())) {
    const how = await openMacApp(surface)
    return { text: surface === 'desktop' ? 'appku Jarvis na ploche' : 'appku Jarvis vo vlastnom okne', kept: surface, already: how === 'running' }
  }
  if (IS_MAC && surface === 'desktop') console.log('Kým si appku Jarvis nepostavím, bývam vo vlastnom okne prehliadača.')
  // The icon: on a Mac without the app a small Jarvis.app that opens this window (one app in
  // Applications all the same), on Windows the shortcuts. A Windows Jarvis from before this choice
  // existed (`web`) keeps his window as it was, without an icon.
  let icon = ''
  if (IS_MAC || (IS_WIN && raw === 'app')) {
    const l = await ensureLauncher()
    if (l.ok) icon = IS_MAC ? ', ikona Jarvis je v Launchpade a v priečinku Aplikácie' : ', ikona Jarvis je na pracovnej ploche a v ponuke Štart'
    else console.log(`Ikonu Jarvis sa nepodarilo vytvoriť. ${l.error ?? ''}`.trim())
  }
  // Somebody clicked the icon while Jarvis is open: the same window comes forward, a second one would talk over the first.
  if (flags.has('front') && (await browserWindowOpen())) {
    await bringForward()
    return { text: 'okno Jarvisa, ktoré už je otvorené', kept: 'app', already: true }
  }
  const r = await openBrowserWindow(url)
  return { ...r, text: `${r.text}${icon}` }
}

async function startServer() {
  if (await hudAlive()) return true
  mkdirSync(LOG_DIR, { recursive: true })
  const log = openSync(join(LOG_DIR, 'hud-server.log'), 'a')
  const child = spawn(process.execPath, [join(REPO, 'hud', 'server.mjs')], { cwd: REPO, detached: true, stdio: ['ignore', log, log], windowsHide: true, env: { ...process.env, PORT: String(PORT) } })
  child.unref()
  writeFileSync(PID_FILE, String(child.pid))
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (await hudAlive()) return true
  }
  return false
}

if (flags.has('reload')) {
  const ok = await postHud('/api/reload', {})
  console.log(ok ? 'Okno Jarvisa sa načíta znova.' : 'HUD nebeží. Spusti ho: node scripts/hud.mjs')
  process.exit(ok ? 0 : 1)
}

if (flags.has('status')) {
  const alive = await hudAlive()
  console.log(alive ? `HUD beží: http://localhost:${PORT}` : 'HUD nebeží.')
  process.exit(alive ? 0 : 1)
}

if (flags.has('info')) {
  try {
    const res = await fetch(`${HUD_URL}/api/setup`, { signal: AbortSignal.timeout(3000) })
    console.log(JSON.stringify(await res.json(), null, 2))
    process.exit(0)
  } catch {
    console.log('HUD nebeží. Spusti ho: node scripts/hud.mjs')
    process.exit(1)
  }
}

async function stopServer() {
  if (!(await hudAlive())) return false
  await postHud('/api/quit', {})
  for (let i = 0; i < 20 && (await hudAlive()); i++) await new Promise((r) => setTimeout(r, 250))
  if (await hudAlive()) {
    // An older server without /api/quit: fall back to the process this script started.
    try {
      const pid = Number(readFileSync(PID_FILE, 'utf8'))
      // A stale pid file may point at some other program by now: only a process that is this server gets stopped.
      if (!IS_WIN && !/hud[\\/]server\.mjs/.test((await sh('/bin/ps', ['-p', String(pid), '-o', 'command='])).out)) return false
      process.kill(pid)
    } catch {
      return false
    }
  }
  rmSync(PID_FILE, { force: true })
  return true
}

if (flags.has('stop')) {
  console.log((await stopServer()) ? 'HUD server zastavený.' : 'HUD server nebežal.')
  process.exit(0)
}
if (flags.has('restart')) {
  // A restart ends the jobs in the background. While one runs, the server restarts itself after it
  // (also when the job itself asked for the restart: it would otherwise end halfway). `--now` does not wait.
  if (!flags.has('now') && (await hudAlive())) {
    let answer = null
    try {
      const res = await fetch(`${HUD_URL}/api/restart`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) })
      answer = res.ok ? await res.json() : null
    } catch {
      answer = null
    }
    if (answer?.deferred) {
      console.log(`Na pozadí ešte beží úloha (${answer.jobs}). HUD sa reštartuje sám, hneď ako dobehne. Ihneď: node scripts/hud.mjs --restart --now`)
      process.exit(0)
    }
  }
  await stopServer()
  await new Promise((r) => setTimeout(r, 600))
}

/**
 * The voice before the window: starts `voice.mjs prepare` when there is something to prepare (or
 * joins one that already runs), shows its progress and waits for it, but never forever.
 */
async function ensureVoice() {
  if (process.env.JARVIS_PREPARE === '0' || flags.has('no-prepare') || !prepareNeeded()) return
  const startedAt = Date.now()
  if (!prepareRunning()) {
    mkdirSync(LOG_DIR, { recursive: true })
    const log = openSync(join(LOG_DIR, 'voice-prepare.log'), 'a')
    spawn(process.execPath, [join(REPO, 'scripts', 'voice.mjs'), 'prepare', '--progress'], { cwd: REPO, detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref()
  }
  console.log('Pripravujem hlas Jarvisa. Pri prvom spustení sa sťahuje model na rozpoznávanie reči, môže to trvať pár minút.')
  const waitS = Number(process.env.JARVIS_PREPARE_WAIT_S ?? 900)
  const until = startedAt + (Number.isFinite(waitS) && waitS >= 0 ? waitS : 900) * 1000
  let last = ''
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500))
    const p = readProgress()
    const fresh = p && Number(p.at) >= startedAt - 1000
    if (fresh && p.step) {
      // A download reports every percent: here one line per ten is enough.
      const key = p.state === 'downloading' && p.pct != null ? `${p.step}|${Math.floor(p.pct / 10)}` : `${p.step}|${p.state}|${p.text}`
      if (key !== last) console.log(`  ${p.text}${p.state === 'downloading' && p.pct != null ? ` (${p.pct} %)` : ''}`)
      last = key
    }
    if (fresh && p.done) {
      const stt = p.result?.stt
      console.log(stt?.status === 'ready' ? `Hlas je pripravený, Jarvis počúva lokálnym Whisperom (${stt.model}).` : `Jarvis bude počúvať cez prehliadač. ${stt?.reason ?? ''}`.trim())
      return
    }
    // The preparation ended without a result (killed, crashed): do not wait for nothing.
    if (Date.now() - startedAt > 8000 && !prepareRunning()) break
  }
  console.log(prepareRunning() ? 'Príprava hlasu ešte beží na pozadí. Jarvis zatiaľ počúva cez prehliadač a prepne sa sám.' : `Hlas sa nepodarilo pripraviť, Jarvis zatiaľ počúva cez prehliadač. Podrobnosti: ${join(LOG_DIR, 'voice-prepare.log')}`)
}

if (!flags.has('server') && !flags.has('restart')) await ensureVoice()

const ok = await startServer()
if (!ok) {
  console.error(`HUD server sa nespustil. Pozri ${join(LOG_DIR, 'hud-server.log')}`)
  process.exit(1)
}
/** Number of HUD windows connected to the server (0 when none is open yet). */
async function clients() {
  try {
    const res = await fetch(`${HUD_URL}/api/health`, { signal: AbortSignal.timeout(2000) })
    return (await res.json()).clients ?? 0
  } catch {
    return 0
  }
}

if (flags.has('server') || flags.has('restart')) {
  console.log(`HUD server beží: ${HUD_URL}`)
} else if (flags.has('apps')) {
  // The picker lives in the 3D world: open a window when none is connected, wait for it, then fly to the orb.
  const app = (parseArgs().rest[0] ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '')
  let opened = null
  if (!(await clients())) opened = await openWindow()
  for (let i = 0; i < 40 && !(await clients()); i++) await new Promise((r) => setTimeout(r, 500))
  // A fresh window builds its world first, the camera flight looks right only after that.
  if (opened) await new Promise((r) => setTimeout(r, 2500))
  const ok = await postHud('/api/apps/open', { app: app || null })
  console.log(ok ? `Jarvis ukazuje Tvoje appky${opened ? ` (${opened.text})` : ''}: http://localhost:${PORT}/#appky` : `HUD sa neozval. Otvor http://localhost:${PORT}/#appky`)
} else if (flags.has('login') && place().surface === 'browser') {
  // A Jarvis who lives in a browser page opens nothing on his own: the page is there when the user wants it.
  console.log(`HUD server beží, stránka je na http://localhost:${PORT}.`)
} else {
  const opened = await openWindow()
  console.log(`HUD beží na http://localhost:${PORT}, otváram ${opened.text}.`)
  // Jarvis lives in one place: once the new window is there (fifteen seconds at most, the Mac app
  // may be moving between the desktop and its window), every other place closes. A window opened
  // once with --browser is an extra one and closes nothing.
  if (!opened.once) {
    for (let i = 0; !opened.already && i < 30 && (await windowsOf(opened.kept)) < 1; i++) await new Promise((r) => setTimeout(r, 500))
    await postHud('/api/surface/keep', { keep: opened.kept })
  }
}

// Jarvis has to be there after every restart of the computer: the first manual start turns on the
// start at login, unless the user turned it off on purpose (npm run autostart -- remove).
if (!flags.has('server') && (IS_MAC || IS_WIN) && !process.env.JARVIS_NO_AUTOSTART) {
  await new Promise((done) => {
    const p = spawn(process.execPath, [join(REPO, 'scripts', 'autostart.mjs'), 'ensure'], { cwd: REPO, stdio: 'inherit', windowsHide: true })
    p.on('exit', done)
    p.on('error', done)
  })
}
