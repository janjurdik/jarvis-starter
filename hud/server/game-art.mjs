/**
 * Pictures for the games in the Hry orb, taken only from this computer: the cover Steam keeps in
 * its library cache, or the icon of the game's own app (macOS). Nothing is downloaded and no
 * list of games leaves the computer. A game without a picture simply stays a plain point.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DATA_DIR, IS_MAC, log, errMsg } from './util.mjs'

const CACHE_DIR = join(DATA_DIR, 'cache', 'game-art')
const STEAM_FILES = ['library_600x900.jpg', 'library_capsule.jpg', 'header.jpg', 'library_header.jpg']
/** Launchers a game without its own app is started from: their icon stands in for the game. */
const LAUNCHER_APPS = { minecraft: ['Minecraft', 'Prism Launcher', 'PrismLauncher', 'Modrinth App', 'CurseForge', 'Lunar Client', 'MultiMC'], prism: ['Prism Launcher', 'PrismLauncher'], roblox: ['Roblox', 'RobloxPlayer'] }

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

let index = null
let indexAt = 0
/** Installed games by folded name, refreshed a few times a day at most. */
async function games() {
  if (index && Date.now() - indexAt < 6 * 3600_000) return index
  const next = new Map()
  try {
    const { detectGames } = await import('../../scripts/scan/launchers.mjs')
    const res = await detectGames({ userFolders: false }, { timeout: 20_000 })
    for (const g of res.games) {
      const names = g.kind === 'instance' ? ['Minecraft'] : [g.name]
      for (const name of names) if (!next.has(fold(name))) next.set(fold(name), g)
    }
  } catch (err) {
    log('game-art', errMsg(err))
  }
  index = next
  indexAt = Date.now()
  return index
}

function steamArt(g) {
  const appid = /^steam:(\d+)$/.exec(g.id)?.[1]
  const cut = String(g.path ?? '').replace(/\\/g, '/').toLowerCase().lastIndexOf('/steamapps/')
  if (!appid || cut < 0) return null
  const cache = join(String(g.path).slice(0, cut), 'appcache', 'librarycache')
  for (const name of STEAM_FILES) {
    for (const file of [join(cache, appid, name), join(cache, `${appid}_${name}`)]) if (existsSync(file)) return file
  }
  return null
}

function run(cmd, args) {
  return new Promise((done) => execFile(cmd, args, { timeout: 15_000 }, (err, stdout) => done(err ? null : String(stdout))))
}

/** The .icns of a macOS app, turned into a PNG once and kept in data/cache. */
async function appIcon(app) {
  if (!IS_MAC || !app.endsWith('.app') || !existsSync(app)) return null
  const out = join(CACHE_DIR, `${createHash('sha1').update(app).digest('hex').slice(0, 16)}.png`)
  if (existsSync(out)) return out
  const res = join(app, 'Contents', 'Resources')
  let icns = null
  const named = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', join(app, 'Contents', 'Info.plist')]))?.trim()
  if (named) icns = [join(res, named), join(res, `${named}.icns`)].find((f) => f.endsWith('.icns') && existsSync(f)) ?? null
  if (!icns) {
    try {
      const first = readdirSync(res).find((f) => f.toLowerCase().endsWith('.icns'))
      if (first) icns = join(res, first)
    } catch {
      // no resources folder
    }
  }
  if (!icns) return null
  mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 })
  await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '256', icns, '--out', out])
  return existsSync(out) ? out : null
}

function findApp(names) {
  for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
    for (const name of names) {
      const app = join(dir, `${name}.app`)
      if (existsSync(app)) return app
    }
  }
  return null
}

const found = new Map()
/** Absolute path of a picture for the game with this name, or null. */
export async function gameArt(title) {
  const key = fold(title)
  if (!key) return null
  if (found.has(key) && (found.get(key) === null || existsSync(found.get(key)))) return found.get(key)
  const ix = await games()
  // "Minecraft: 1.8.9" or "Golf With Your Friends (Steam)" still mean the game named first.
  const g = ix.get(key) ?? [...ix].find(([name]) => key.startsWith(`${name} `) || name.startsWith(`${key} `))?.[1] ?? null
  let file = null
  if (g) {
    file = steamArt(g)
    if (!file && g.path) {
      const p = String(g.path)
      file = await appIcon(p.endsWith('.app') ? p : p.includes('.app/') ? `${p.slice(0, p.indexOf('.app/'))}.app` : '')
    }
    if (!file && LAUNCHER_APPS[g.launcher]) file = await appIcon(findApp(LAUNCHER_APPS[g.launcher]) ?? '')
  }
  if (!file) file = await appIcon(findApp([String(title).trim(), ...(LAUNCHER_APPS[key] ?? [])]) ?? '')
  found.set(key, file)
  return file
}
