#!/usr/bin/env node
/**
 * The Jarvis icon for an app window that runs in a browser.
 *
 *   node scripts/launcher.mjs install   create or refresh the icon
 *   node scripts/launcher.mjs remove    move it away (nothing else changes)
 *   node scripts/launcher.mjs status
 *
 * Windows: a "Jarvis" shortcut on the desktop and in the Start menu, started without a console window.
 * macOS: the icon is the Jarvis app itself (hud/desktop, ~/Applications/Jarvis.app), which lives on
 * the desktop or in its own window. Only a Mac that cannot build it (no developer tools) gets this
 * stand-in under the same name: a tiny bundle whose program is a shell script. The build of the real
 * app replaces it (hud/desktop/install.sh), and the stand-in never replaces the real app.
 * Both run `node scripts/hud.mjs --front`: start the server when it is not running, open the window,
 * or bring the open one forward. The paths of Node and of this folder are written into the icon, so
 * run `install` again after moving the folder (scripts/hud.mjs does it on every start).
 *
 * JARVIS_LAUNCHER_DIR puts the icon into another folder (tests, a second installation).
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR, IS_MAC, IS_WIN, LOG_DIR, PORT, REPO, WIN_POWERSHELL, has, parseArgs, sh, winSys } from './lib.mjs'
import { MAC_APP_ID, OLD_MAC_IDS, macAppPath, parsePlistStrings } from '../hud/server/surface.mjs'

const NODE = process.execPath
const SCRIPT = join(REPO, 'scripts', 'hud.mjs')
const OVERRIDE = process.env.JARVIS_LAUNCHER_DIR || null
const MAC_APP = OVERRIDE ? join(OVERRIDE, 'Jarvis.app') : macAppPath()
const WIN_VBS = join(DATA_DIR, 'jarvis-launcher.vbs')
const WIN_ICON = join(REPO, 'hud', 'desktop', 'jarvis.ico')
/** What makes this installation different from the default one has to travel with the icon. */
const ENV_KEYS = ['PORT', 'HUD_PORT', 'JARVIS_DATA_DIR', 'JARVIS_MEMORY_DIR', 'JARVIS_CONFIG', 'JARVIS_BROWSER', 'JARVIS_NO_AUTOSTART', 'JARVIS_LAUNCHER_DIR', 'JARVIS_APP_DIR', 'JARVIS_NO_MOVE']

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const vbq = (s) => `"${String(s).replace(/"/g, '""')}"`
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`

const macPlist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Jarvis</string>
  <key>CFBundleDisplayName</key><string>Jarvis</string>
  <key>CFBundleIdentifier</key><string>${OLD_MAC_IDS.launcher}</string>
  <key>CFBundleExecutable</key><string>Jarvis</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>JarvisFolder</key><string>${xml(REPO)}</string>
</dict>
</plist>
`

const macScript = () => {
  const env = ENV_KEYS.filter((k) => process.env[k]).map((k) => `export ${k}=${shq(process.env[k])}`)
  const path = [dirname(NODE), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter)
  return `#!/bin/sh
# Opens Jarvis in his own window. Created by scripts/launcher.mjs, do not edit: it is rewritten.
export PATH=${shq(path)}
${env.join('\n')}${env.length ? '\n' : ''}mkdir -p ${shq(LOG_DIR)}
cd ${shq(REPO)} || exit 1
exec ${shq(NODE)} ${shq(SCRIPT)} --front >> ${shq(join(LOG_DIR, 'launcher.log'))} 2>&1
`
}

const winVbs = () => {
  const env = ENV_KEYS.filter((k) => process.env[k]).map((k) => `shell.Environment("Process")(${vbq(k)}) = ${vbq(process.env[k])}`)
  return [`' Opens Jarvis in his own window, without a console window. Created by scripts/launcher.mjs.`, 'Set shell = CreateObject("WScript.Shell")', `shell.CurrentDirectory = ${vbq(REPO)}`, ...env, `shell.Run ${vbq(`"${NODE}" "${SCRIPT}" --front`)}, 0, False`, ''].join('\r\n')
}

/** PowerShell that writes one shortcut into each of the given special folders (or into the test folder). */
const winShortcuts = (remove = false) => {
  const dirs = OVERRIDE ? psq(OVERRIDE) : `[Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')`
  if (remove) return `foreach ($d in @(${dirs})) { $f = Join-Path $d 'Jarvis.lnk'; if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } }`
  return [
    `$w = New-Object -ComObject WScript.Shell`,
    `foreach ($d in @(${dirs})) {`,
    `  if (-not $d) { continue }`,
    `  New-Item -ItemType Directory -Force -Path $d | Out-Null`,
    `  $s = $w.CreateShortcut((Join-Path $d 'Jarvis.lnk'))`,
    `  $s.TargetPath = ${psq(winSys('wscript.exe'))}`,
    `  $s.Arguments = ${psq(`"${WIN_VBS}"`)}`,
    `  $s.WorkingDirectory = ${psq(REPO)}`,
    `  $s.IconLocation = ${psq(`${WIN_ICON},0`)}`,
    `  $s.Description = 'Jarvis'`,
    `  $s.Save()`,
    `}`,
  ].join('\n')
}

/** -EncodedCommand keeps paths with diacritics intact whatever the console code page is. */
const powershell = (script) => sh(WIN_POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 30_000 })

const same = (file, text) => {
  try {
    return readFileSync(file, 'utf8') === text
  } catch {
    return false
  }
}

/** Where the icon is, for messages. */
export const launcherPlace = () => (IS_MAC ? MAC_APP : IS_WIN ? (OVERRIDE ?? 'pracovná plocha a ponuka Štart') : null)

/** The bundle id of whatever is at the place of the icon on a Mac (null: nothing there or no plist). */
function macOccupant() {
  try {
    return parsePlistStrings(readFileSync(join(MAC_APP, 'Contents', 'Info.plist'), 'utf8'))?.CFBundleIdentifier ?? null
  } catch {
    return null
  }
}

/** Is the icon there and does it point at this folder? */
export function launcherReady() {
  if (IS_MAC) return same(join(MAC_APP, 'Contents', 'MacOS', 'Jarvis'), macScript()) && same(join(MAC_APP, 'Contents', 'Info.plist'), macPlist())
  if (IS_WIN) return same(`${WIN_VBS}.sig`, winVbs() + winShortcuts())
  return false
}

/** Creates or refreshes the icon. { ok, created, place, error }. Never throws. */
export async function ensureLauncher() {
  try {
    if (!IS_MAC && !IS_WIN) return { ok: false, created: false, place: null, error: 'Ikona je pripravená pre macOS a Windows.' }
    if (launcherReady()) return { ok: true, created: false, place: launcherPlace() }
    if (IS_MAC) {
      // The real Jarvis app, or any other app of that name, is never written over.
      const occupant = has(MAC_APP) ? macOccupant() : null
      if (has(MAC_APP) && occupant !== OLD_MAC_IDS.launcher) return { ok: occupant === MAC_APP_ID, created: false, place: MAC_APP, error: occupant === MAC_APP_ID ? null : `V ${MAC_APP} je iná appka (${occupant ?? 'neznáma'}).` }
      const bin = join(MAC_APP, 'Contents', 'MacOS')
      const res = join(MAC_APP, 'Contents', 'Resources')
      mkdirSync(bin, { recursive: true })
      mkdirSync(res, { recursive: true })
      writeFileSync(join(MAC_APP, 'Contents', 'Info.plist'), macPlist())
      writeFileSync(join(bin, 'Jarvis'), macScript())
      chmodSync(join(bin, 'Jarvis'), 0o755)
      copyFileSync(join(REPO, 'hud', 'desktop', 'AppIcon.icns'), join(res, 'AppIcon.icns'))
      // Finder and Launchpad learn about the new app (and its icon) right away.
      await sh('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', MAC_APP], { timeout: 15_000 })
      return { ok: true, created: true, place: MAC_APP }
    }
    mkdirSync(dirname(WIN_VBS), { recursive: true })
    // UTF-16 with a byte order mark: the only encoding in which Windows Script Host reads paths with diacritics.
    writeFileSync(WIN_VBS, `﻿${winVbs()}`, 'utf16le')
    const r = await powershell(winShortcuts())
    if (r.code !== 0) return { ok: false, created: false, place: null, error: String(r.out ?? '').trim().split('\n').slice(-2).join(' ') }
    writeFileSync(`${WIN_VBS}.sig`, winVbs() + winShortcuts())
    return { ok: true, created: true, place: launcherPlace() }
  } catch (err) {
    return { ok: false, created: false, place: null, error: err?.message ?? String(err) }
  }
}

/** Takes the icon away. On a Mac the stand-in is moved to the Trash folder of the user, never deleted (the real app stays). */
export async function removeLauncher() {
  try {
    if (IS_MAC) {
      if (!has(MAC_APP) || macOccupant() !== OLD_MAC_IDS.launcher) return { ok: true, removed: false }
      const trash = join(homedir(), '.Trash', `Jarvis ${Date.now()}.app`)
      renameSync(MAC_APP, trash)
      return { ok: true, removed: true, place: trash }
    }
    if (IS_WIN) {
      const r = await powershell(winShortcuts(true))
      if (has(`${WIN_VBS}.sig`)) renameSync(`${WIN_VBS}.sig`, `${WIN_VBS}.sig.off`)
      return { ok: r.code === 0, removed: r.code === 0 }
    }
    return { ok: false, removed: false }
  } catch (err) {
    return { ok: false, removed: false, error: err?.message ?? String(err) }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { rest } = parseArgs()
  const action = rest[0] ?? 'status'
  if (action === 'install') {
    const r = await ensureLauncher()
    console.log(r.ok ? (r.created ? `Ikona Jarvis je pripravená: ${r.place}` : `Ikona Jarvis už je na mieste: ${r.place}`) : `Ikonu sa nepodarilo vytvoriť. ${r.error ?? ''}`.trim())
    process.exit(r.ok ? 0 : 1)
  } else if (action === 'remove') {
    const r = await removeLauncher()
    console.log(r.ok ? (r.removed ? 'Ikona Jarvis je preč. Jarvis sám beží ďalej.' : 'Ikona Jarvis tu nebola.') : `Ikonu sa nepodarilo odstrániť. ${r.error ?? ''}`.trim())
    process.exit(r.ok ? 0 : 1)
  } else {
    if (IS_MAC && has(MAC_APP) && macOccupant() === MAC_APP_ID) console.log(`Jarvis je appka ${MAC_APP}, inú ikonu netreba.`)
    else console.log(launcherReady() ? `Ikona Jarvis je pripravená: ${launcherPlace()}` : 'Ikona Jarvis nie je vytvorená. Vytvorí ju: node scripts/launcher.mjs install')
  }
}
