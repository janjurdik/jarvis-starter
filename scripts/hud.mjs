#!/usr/bin/env node
/**
 * Starts the Jarvis HUD and opens its window.
 *
 *   npm run hud               start the server (if it is not running) and open the HUD
 *   npm run hud -- --server   only the server, no window (used at login together with the Mac app)
 *   npm run hud -- --stop     stop the server
 *   npm run hud -- --restart  stop and start again (after changing .env)
 *   npm run hud -- --status   is it running?
 *   npm run hud -- --info     installation summary from the running server (JSON)
 *   npm run hud -- --apps     open the HUD and fly to the Tvoje appky orb (the app picker), optionally
 *                             at one app: node scripts/hud.mjs --apps instagram
 *   npm run hud -- --no-prepare   do not wait for the voice (see below)
 *
 * Before the window opens for the first time the voice is prepared (`scripts/voice.mjs prepare`):
 * the local Whisper model for speech recognition and the voice's packages. The wait is limited
 * (JARVIS_PREPARE_WAIT_S, 15 minutes by default): after that the HUD opens anyway, the download
 * carries on in the background and Jarvis listens through the browser until it is done.
 *
 * Window: where the user wants Jarvis (`surface` in config/jarvis.json, or in data/setup.json as asked during setup).
 *   desktop  macOS only, the default there: the "Jarvis HUD" app, Jarvis as the desktop under the
 *            windows. Built on first use (hud/desktop/build.sh, needs the Xcode command line tools).
 *   web      Chrome or Edge in app mode (a clean full-screen window without tabs). F11 or ⌃⌘F
 *            toggles full screen. Also what happens when the app cannot be built.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DATA_DIR, HUD_URL, IS_MAC, IS_WIN, LOG_DIR, PORT, REPO, findBin, has, hudAlive, parseArgs, postHud, sh, winSys } from './lib.mjs'
import { prepareNeeded, prepareRunning, readProgress } from '../hud/server/stt-plan.mjs'

const { flags } = parseArgs()
const PID_FILE = join(DATA_DIR, 'hud.pid')
const MAC_APP = join(homedir(), 'Applications', 'Jarvis HUD.app')

/** Where Jarvis lives: on the desktop (macOS app) or in a browser window. `--browser` forces the window once. */
function surface() {
  if (flags.has('browser') || !IS_MAC) return 'web'
  // The config (Settings on the desktop) wins over what setup wrote down.
  for (const file of [process.env.JARVIS_CONFIG || join(REPO, 'config', 'jarvis.json'), join(DATA_DIR, 'setup.json')]) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')).surface
      if (value === 'web' || value === 'desktop') return value
    } catch {
      // not there yet: the next one, then the default
    }
  }
  return 'desktop'
}

/** Builds and installs the desktop app. False when this Mac cannot build it (no compiler) or the build failed. */
async function buildMacApp() {
  if (!findBin('swiftc')) {
    console.log('Na plochu ma položí malá appka, ktorú si tento Mac postaví sám. Chýbajú mu na to nástroje pre vývojárov od Apple.')
    console.log('  Nainštaluje ich príkaz: xcode-select --install (okno potvrď, trvá pár minút), potom znova: node scripts/hud.mjs')
    return false
  }
  console.log('Staviam appku, ktorá ma položí na plochu (raz, asi minútu)…')
  const r = await sh('/bin/sh', [join(REPO, 'hud', 'desktop', 'build.sh')], { timeout: 6 * 60_000, env: { ...process.env, PORT: String(PORT) } })
  if (r.code !== 0 || !has(MAC_APP)) {
    console.log(`Appku na plochu sa nepodarilo postaviť. ${String(r.out ?? '').trim().split('\n').slice(-2).join(' ')}`.trim())
    return false
  }
  return true
}

function browserBin() {
  if (process.env.JARVIS_BROWSER && has(process.env.JARVIS_BROWSER)) return process.env.JARVIS_BROWSER
  const candidates = IS_MAC
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Arc.app/Contents/MacOS/Arc']
    : IS_WIN
      ? [
          join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]
      : []
  return candidates.find((p) => p && has(p)) ?? findBin('google-chrome') ?? findBin('chromium') ?? null
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

async function openWindow() {
  const url = `http://localhost:${PORT}/`
  if (surface() === 'desktop' && (has(MAC_APP) || (await buildMacApp()))) {
    spawn('/usr/bin/open', [MAC_APP], { detached: true, stdio: 'ignore' }).unref()
    return 'appka Jarvis HUD na ploche'
  }
  const bin = browserBin()
  if (bin) {
    // A separate profile keeps the HUD window (and its microphone permission) apart from everyday browsing.
    const profile = join(DATA_DIR, 'browser-profile')
    spawn(bin, [`--app=${url}`, '--start-fullscreen', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
    return 'okno prehliadača na celú obrazovku'
  }
  // No Chromium browser found: fall back to whatever opens http links.
  if (IS_MAC) spawn('/usr/bin/open', [url], { detached: true, stdio: 'ignore' }).unref()
  else if (IS_WIN) spawn(winSys('rundll32.exe'), ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref()
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  return 'predvolený prehliadač'
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
  console.log(ok ? `Jarvis ukazuje Tvoje appky${opened ? ` (${opened})` : ''}: http://localhost:${PORT}/#appky` : `HUD sa neozval. Otvor http://localhost:${PORT}/#appky`)
} else {
  console.log(`HUD beží na http://localhost:${PORT}, otváram ${await openWindow()}.`)
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
