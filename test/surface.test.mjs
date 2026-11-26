import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync as makeTemp, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  MAC_APP_ID,
  OLD_MAC_IDS,
  appWindowLaunch,
  closesProfileWindow,
  macAppExe,
  macAppPath,
  macAppPids,
  macAppSource,
  macAppState,
  normalizeSurface,
  ownBrowserRunning,
  parsePlistStrings,
  resolveSurface,
  surfacesFor,
} from '../hud/server/surface.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const temps = []
/** A temporary folder, removed again when the tests end. */
const mkdtempSync = (prefix) => {
  const dir = makeTemp(prefix)
  temps.push(dir)
  return dir
}
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')

/** A bundle with an XML Info.plist, the way build.sh and launcher.mjs write them. */
function bundle(path, values) {
  mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true })
  const keys = Object.entries(values).map(([k, v]) => `  <key>${k}</key>\n  <string>${xml(v)}</string>`).join('\n')
  writeFileSync(join(path, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${keys}\n</dict>\n</plist>\n`)
  writeFileSync(join(path, 'Contents', 'MacOS', 'Jarvis'), '#!/bin/sh\n')
  return path
}

test('surface: names, the old "web" and nonsense', () => {
  assert.equal(normalizeSurface('desktop'), 'desktop')
  assert.equal(normalizeSurface(' App '), 'app')
  assert.equal(normalizeSurface('browser'), 'browser')
  assert.equal(normalizeSurface('web'), 'app')
  assert.equal(normalizeSurface('tv'), null)
  assert.equal(normalizeSurface(undefined), null)
})

test('surface: the desktop exists only on a Mac', () => {
  assert.deepEqual(surfacesFor('darwin'), ['desktop', 'app', 'browser'])
  assert.deepEqual(surfacesFor('win32'), ['app', 'browser'])
})

test('surface: config wins over setup, defaults by platform, raw value is kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-surface-'))
  assert.deepEqual(resolveSurface({ dataDir: dir, config: null, platform: 'darwin' }), { surface: 'desktop', raw: null })
  assert.deepEqual(resolveSurface({ dataDir: dir, config: null, platform: 'win32' }), { surface: 'app', raw: null })
  writeFileSync(join(dir, 'setup.json'), JSON.stringify({ surface: 'browser' }))
  assert.deepEqual(resolveSurface({ dataDir: dir, config: null, platform: 'darwin' }), { surface: 'browser', raw: 'browser' })
  assert.deepEqual(resolveSurface({ dataDir: dir, config: 'app', platform: 'darwin' }), { surface: 'app', raw: 'app' })
  // A window from 1.8.0 stays a window and is told apart from a chosen app (no icon is made for it).
  assert.deepEqual(resolveSurface({ dataDir: dir, config: 'web', platform: 'win32' }), { surface: 'app', raw: 'web' })
  // The desktop asked for on Windows falls back to the app.
  assert.deepEqual(resolveSurface({ dataDir: dir, config: 'desktop', platform: 'win32' }), { surface: 'app', raw: 'desktop' })
  const cfg = join(dir, 'jarvis.json')
  writeFileSync(cfg, JSON.stringify({ surface: 'desktop' }))
  assert.deepEqual(resolveSurface({ dataDir: dir, configFile: cfg, platform: 'darwin' }), { surface: 'desktop', raw: 'desktop' })
})

test('mac app: one Jarvis.app, its place can be moved for tests', () => {
  assert.equal(macAppPath({ JARVIS_APP_DIR: '/tmp/x' }), '/tmp/x/Jarvis.app')
  assert.match(macAppPath({}), /\/Applications\/Jarvis\.app$/)
  assert.equal(macAppExe('/A/Jarvis.app'), '/A/Jarvis.app/Contents/MacOS/Jarvis')
  assert.equal(MAC_APP_ID, 'com.jarvis-starter.app')
  // The app must declare itself under the same id the tools look for, and ask for the microphone and the camera.
  const plist = parsePlistStrings(readFileSync(join(REPO, 'hud', 'desktop', 'Info.plist'), 'utf8'))
  assert.equal(plist.CFBundleIdentifier, MAC_APP_ID)
  assert.equal(plist.CFBundleName, 'Jarvis')
  assert.equal(plist.CFBundleExecutable, 'Jarvis')
  assert.ok(plist.NSMicrophoneUsageDescription && plist.NSCameraUsageDescription)
  assert.equal(plist.JarvisSource, '__JARVIS_SOURCE__')
})

test('mac app: plist strings are read with their escapes', () => {
  assert.deepEqual(parsePlistStrings('<plist><dict><key>A</key><string>x &amp; y &lt;z&gt;</string><key>B</key>\n  <string></string></dict></plist>'), { A: 'x & y <z>', B: '' })
  assert.equal(parsePlistStrings('not a plist'), null)
})

test('mac app: ready, stale (code, folder, port, node), foreign and missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-macapp-'))
  const app = join(dir, 'Jarvis.app')
  assert.equal(macAppState({ app, repo: REPO, port: 4545 }).state, 'missing')
  const source = macAppSource(REPO)
  assert.match(source, /^[0-9a-f]{64}$/)
  const good = { CFBundleIdentifier: MAC_APP_ID, JarvisRepo: REPO, JarvisPort: '4545', JarvisNode: process.execPath, JarvisSource: source }
  bundle(app, good)
  assert.equal(macAppState({ app, repo: REPO, port: 4545 }).state, 'ready')
  assert.deepEqual(
    [{ JarvisSource: 'old' }, { JarvisRepo: '/elsewhere' }, { JarvisPort: '4611' }, { JarvisNode: join(dir, 'gone', 'node') }].map((change) => {
      bundle(app, { ...good, ...change })
      return macAppState({ app, repo: REPO, port: 4545 }).why
    }),
    ['iný kód appky', 'iný priečinok', 'iný port', 'Node sa presťahoval'],
  )
  // The icon of 1.9.7 and somebody else's app are not ours to call stale.
  bundle(app, { CFBundleIdentifier: OLD_MAC_IDS.launcher })
  assert.deepEqual(macAppState({ app, repo: REPO, port: 4545 }), { state: 'foreign', id: OLD_MAC_IDS.launcher })
  bundle(app, { CFBundleIdentifier: 'com.janjurdik.jarvis-hud' })
  assert.equal(macAppState({ app, repo: REPO, port: 4545 }).id, 'com.janjurdik.jarvis-hud')
})

test('mac app: the hash of the sources matches the one build.sh writes', { skip: process.platform !== 'darwin' }, () => {
  const dir = join(REPO, 'hud', 'desktop')
  const r = spawnSync('/bin/sh', ['-c', 'cat main.swift Info.plist | /usr/bin/shasum -a 256 | cut -d" " -f1'], { cwd: dir, encoding: 'utf8' })
  assert.equal(r.stdout.trim(), macAppSource(REPO))
})

test('mac app: running copies are found by their own program, not by a name', () => {
  const app = '/Users/a/Applications/Jarvis.app'
  const ps = [
    '  101 /Users/a/Applications/Jarvis.app/Contents/MacOS/Jarvis',
    '  102 /Users/a/Applications/Jarvis.app/Contents/MacOS/Jarvis --surface app',
    '  103 /Users/a/Applications/Jarvis HUD.app/Contents/MacOS/JarvisHUD',
    '  104 /Users/a/Desktop/jarvis-hud/build/Jarvis.app/Contents/MacOS/Jarvis',
    '  105 grep /Users/a/Applications/Jarvis.app/Contents/MacOS/Jarvis',
  ].join('\n')
  assert.deepEqual(macAppPids(ps, app), [101, 102])
})

test('app window: the user\'s own browser, never a second instance with an empty profile', () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const ps = [
    `  200 ${chrome}`,
    `  201 ${chrome} Helper --type=renderer`,
    `  202 ${chrome} --app=http://localhost:4545/?surface=app --user-data-dir=/x/data/browser-profile`,
  ].join('\n')
  assert.equal(ownBrowserRunning(ps, chrome), true)
  // Only the Jarvis window of 1.9.7 with its own profile: the user's browser does not run.
  assert.equal(ownBrowserRunning(ps.split('\n').slice(1).join('\n'), chrome), false)

  const url = 'http://localhost:4545/'
  // Not running: started by the system, so the browser answers for the camera itself.
  assert.deepEqual(appWindowLaunch({ platform: 'darwin', bin: chrome, url, running: false }), { cmd: '/usr/bin/open', args: ['-a', '/Applications/Google Chrome.app', '--args', '--app=http://localhost:4545/?surface=app'] })
  // Running: the program with --app hands the window over to it.
  assert.deepEqual(appWindowLaunch({ platform: 'darwin', bin: chrome, url, running: true }), { cmd: chrome, args: ['--app=http://localhost:4545/?surface=app'] })
  assert.deepEqual(appWindowLaunch({ platform: 'linux', bin: '/usr/bin/chromium', url }), { cmd: '/usr/bin/chromium', args: ['--app=http://localhost:4545/?surface=app'] })
  for (const platform of ['darwin', 'linux']) assert.ok(!appWindowLaunch({ platform, bin: chrome, url, profile: '/p', running: false }).args.some((a) => a.startsWith('--user-data-dir')))
  // Windows keeps Edge with a profile of its own, full screen.
  const win = appWindowLaunch({ platform: 'win32', bin: 'C:\\Edge\\msedge.exe', url, profile: 'C:\\J\\data\\browser-profile' })
  assert.equal(win.cmd, 'C:\\Edge\\msedge.exe')
  assert.ok(win.args.includes('--user-data-dir=C:\\J\\data\\browser-profile') && win.args.includes('--start-fullscreen'))
})

test('app window: which window with our own profile closes', () => {
  // Windows: the Edge window closes only when Jarvis moved elsewhere.
  assert.equal(closesProfileWindow('app', 'win32'), false)
  assert.equal(closesProfileWindow('browser', 'win32'), true)
  // A Mac: the Chrome window of 1.9.7 is always a leftover.
  assert.equal(closesProfileWindow('app', 'darwin'), true)
  assert.equal(closesProfileWindow('desktop', 'darwin'), true)
})

/** Runs hud/desktop/install.sh against a temporary Applications folder: nothing in the system changes. */
function install(dir, extra = []) {
  const built = bundle(join(dir, 'build', 'Jarvis.app'), { CFBundleIdentifier: MAC_APP_ID, CFBundleName: 'Jarvis' })
  const env = { ...process.env, JARVIS_APP_DIR: join(dir, 'Apps'), JARVIS_TRASH_DIR: join(dir, 'Trash'), JARVIS_AGENTS_DIR: join(dir, 'Agents') }
  return spawnSync('/bin/sh', [join(REPO, 'hud', 'desktop', 'install.sh'), built, ...extra], { env, encoding: 'utf8' })
}
const idOf = (app) => parsePlistStrings(readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8'))?.CFBundleIdentifier
const trashed = (dir) => (existsSync(join(dir, 'Trash')) ? readdirSync(join(dir, 'Trash')).sort() : [])

test('install: the two apps of 1.9.7 go to the Trash, one Jarvis stays', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-install-'))
  const apps = join(dir, 'Apps')
  const old = bundle(join(apps, 'Jarvis HUD.app'), { CFBundleIdentifier: OLD_MAC_IDS.desktop })
  bundle(join(apps, 'Jarvis.app'), { CFBundleIdentifier: OLD_MAC_IDS.launcher })
  mkdirSync(join(dir, 'Agents'), { recursive: true })
  const agent = join(dir, 'Agents', 'com.jarvis-starter.hud-desktop.plist')
  writeFileSync(agent, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>com.jarvis-starter.hud-desktop</string><key>ProgramArguments</key><array><string>${old}/Contents/MacOS/JarvisHUD</string></array></dict></plist>\n`)
  const r = install(dir)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(readdirSync(apps), ['Jarvis.app'])
  assert.equal(idOf(join(apps, 'Jarvis.app')), MAC_APP_ID)
  assert.equal(existsSync(agent), false)
  const t = trashed(dir)
  assert.equal(t.length, 3)
  assert.ok(t.some((n) => n.startsWith('Jarvis HUD ')) && t.some((n) => /^Jarvis \d/.test(n)) && t.some((n) => n.startsWith('com.jarvis-starter.hud-desktop ')))
  // A rebuild replaces only its own previous build, nothing goes to the Trash.
  assert.equal(install(dir).status, 0)
  assert.equal(trashed(dir).length, 3)
})

test('install: somebody else\'s apps are left alone', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-install-'))
  const apps = join(dir, 'Apps')
  // A private build with the old name and its own start at login: untouched.
  const own = bundle(join(apps, 'Jarvis HUD.app'), { CFBundleIdentifier: 'com.janjurdik.jarvis-hud' })
  mkdirSync(join(dir, 'Agents'), { recursive: true })
  const agent = join(dir, 'Agents', 'com.jarvis-starter.hud-desktop.plist')
  writeFileSync(agent, `<plist version="1.0"><dict><key>ProgramArguments</key><array><string>${own}/Contents/MacOS/JarvisHUD</string></array></dict></plist>\n`)
  assert.equal(install(dir).status, 0)
  assert.equal(idOf(own), 'com.janjurdik.jarvis-hud')
  assert.equal(existsSync(agent), true)
  assert.deepEqual(trashed(dir), [])

  // Another program called Jarvis.app: nothing is written over without --force.
  const other = mkdtempSync(join(tmpdir(), 'jarvis-install-'))
  bundle(join(other, 'Apps', 'Jarvis.app'), { CFBundleIdentifier: 'com.example.jarvis' })
  const r = install(other)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /Nič neprepisujem/)
  assert.equal(idOf(join(other, 'Apps', 'Jarvis.app')), 'com.example.jarvis')
})
