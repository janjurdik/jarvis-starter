#!/usr/bin/env node
/**
 * Makes the Jarvis HUD start on its own after you log in.
 *
 *   npm run autostart -- install            turn it on
 *   npm run autostart -- install --dry-run  only show what would be written
 *   npm run autostart -- status
 *   npm run autostart -- remove             turn it off (and remember it, so `ensure` leaves it off)
 *   npm run autostart -- ensure             turn it on unless it is on already or the user turned it off;
 *                                           scripts/hud.mjs runs this, so Jarvis starts after every login
 *
 * macOS: a launchd agent that runs `node scripts/hud.mjs` at login.
 * Windows: a small script in your Startup folder that does the same (no admin rights needed).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { DATA_DIR, IS_MAC, IS_WIN, LABEL, LOG_DIR, REPO, has, parseArgs, sh } from './lib.mjs'

const { flags, rest } = parseArgs()
const action = rest[0] ?? 'status'
const dry = flags.has('dry-run')
const NODE = process.execPath
const SCRIPT = join(REPO, 'scripts', 'hud.mjs')
const MAC_LABEL = `${LABEL}.hud`
const MAC_FILE = join(homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`)
const WIN_FILE = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Jarvis HUD.vbs')

/** Written by `remove`: the user does not want Jarvis to start at login, `ensure` respects it. */
const OFF_FILE = join(DATA_DIR, 'autostart-off')

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const macPlist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(NODE)}</string>
    <string>${xml(SCRIPT)}</string>
    <string>--login</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(REPO)}</string>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml([dirname(NODE), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter))}</string></dict>
  <key>StandardOutPath</key><string>${xml(join(LOG_DIR, 'autostart.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(LOG_DIR, 'autostart.log'))}</string>
</dict>
</plist>
`

const vbq = (s) => `"${String(s).replace(/"/g, '""')}"`
const winVbs = () => `' Starts the Jarvis HUD after login, without a console window. Created by scripts/autostart.mjs.\r\nSet shell = CreateObject("WScript.Shell")\r\nshell.CurrentDirectory = ${vbq(REPO)}\r\nshell.Run ${vbq(`"${NODE}" "${SCRIPT}" --login`)}, 0, False\r\n`

if (!IS_MAC && !IS_WIN) {
  console.error('Automatické spúšťanie je pripravené pre macOS a Windows.')
  process.exit(1)
}

const file = IS_MAC ? MAC_FILE : WIN_FILE
const content = IS_MAC ? macPlist() : winVbs()

/** The file as it is on the disk now (Windows Script Host files are UTF-16), or null. */
const current = () => {
  try {
    const buf = readFileSync(file)
    return buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le').replace(/^\ufeff/, '') : buf.toString('utf8')
  } catch {
    return null
  }
}
/** Windows Script Host reads paths with diacritics only from UTF-16 with a byte order mark. */
const write = () => (IS_WIN ? writeFileSync(file, `\ufeff${content}`, 'utf16le') : writeFileSync(file, content))

if (action === 'ensure') {
  if (existsSync(OFF_FILE)) process.exit(0)
  // An older start at login of this very folder (from before `--login` existed) is brought up to date quietly.
  // One that points at another folder belongs to another installation and stays as it is.
  if (has(file)) {
    const now = current()
    if (!dry && now !== content && now?.includes(SCRIPT)) write()
    process.exit(0)
  }
  if (dry) {
    console.log(`Zapol by som spúšťanie po prihlásení: ${file}`)
    process.exit(0)
  }
  mkdirSync(dirname(file), { recursive: true })
  mkdirSync(LOG_DIR, { recursive: true })
  write()
  console.log('Jarvis sa odteraz zapne sám po každom zapnutí počítača (vypnúť: npm run autostart -- remove).')
} else if (action === 'install') {
  if (dry) {
    console.log(`Nič nezapisujem (--dry-run). Zapísal by som ${file}:\n\n${content}`)
    process.exit(0)
  }
  mkdirSync(dirname(file), { recursive: true })
  mkdirSync(LOG_DIR, { recursive: true })
  if (IS_MAC) await sh('/bin/launchctl', ['bootout', `gui/${userInfo().uid}/${MAC_LABEL}`])
  write()
  rmSync(OFF_FILE, { force: true })
  // Registered for the next login. The HUD is not restarted now (start it with: npm run hud).
  console.log(`Hotovo. HUD sa po prihlásení spustí sám.\n  ${file}`)
} else if (action === 'remove') {
  if (dry) console.log(`Odstránil by som ${file}`)
  else {
    if (IS_MAC) await sh('/bin/launchctl', ['bootout', `gui/${userInfo().uid}/${MAC_LABEL}`])
    rmSync(file, { force: true })
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(OFF_FILE, `${new Date().toISOString()}\n`)
    console.log('Automatické spúšťanie je vypnuté.')
  }
} else {
  console.log(has(file) ? `Zapnuté: ${file}` : 'Vypnuté. Zapneš ho cez: npm run autostart -- install')
}
