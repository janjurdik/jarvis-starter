/**
 * Game detection across launchers: which games are installed on this computer and, where the
 * launcher keeps it locally, how long and when they were played.
 *
 * One record per game:
 *   { id, name, launcher, installed, sizeBytes?, playtimeMin?, lastPlayed?, path?, exe?, approx?, kind?, also? }
 *
 *   id          "<launcher>:<launcher's own id>", stable between runs
 *   launcher    key of LAUNCHER_NAMES (steam, epic, gog, battlenet, riot, ea, ubisoft, xbox, itch, rockstar,
 *               minecraft, prism, multimc, curseforge, modrinth, atlauncher, roblox, heroic, standalone)
 *   installed   true when the game files are on this computer now
 *   playtimeMin minutes played, only where the launcher stores it (Steam, GOG Galaxy, itch, Heroic, Prism, Modrinth)
 *   lastPlayed  ISO time; `approx: true` when it is derived from file times instead of the launcher's own record
 *   exe         executable file names, used by the activity log to recognise the running game
 *   also        other launchers that list the same game
 *
 * Everything is read-only. Every detector takes an `env` (folders, platform, registry and SQLite readers),
 * so the tests run all of them, also the Windows ones, against small fixture folders. A broken or
 * half-written launcher file never throws: the detector returns what it could read.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { exists, guarded, list, mapLimit, names, plain, readJson, readText, statOf, withDbCopy } from './util.mjs'

export const LAUNCHER_NAMES = {
  steam: 'Steam',
  epic: 'Epic Games',
  gog: 'GOG Galaxy',
  battlenet: 'Battle.net',
  riot: 'Riot Games',
  ea: 'EA app',
  ubisoft: 'Ubisoft Connect',
  xbox: 'Xbox',
  itch: 'itch.io',
  rockstar: 'Rockstar Games',
  heroic: 'Heroic',
  minecraft: 'Minecraft',
  prism: 'Prism Launcher',
  multimc: 'MultiMC',
  curseforge: 'CurseForge',
  modrinth: 'Modrinth',
  atlauncher: 'ATLauncher',
  roblox: 'Roblox',
  standalone: 'samostatne nainštalované',
}
/** When two launchers list the same game, the earlier one here keeps the record. */
const PRIORITY = Object.keys(LAUNCHER_NAMES)

// ── environment ──
/** Folders and readers of this computer. Tests pass their own. */
export function defaultEnv(over = {}) {
  const home = over.home ?? homedir()
  const platform = over.platform ?? process.platform
  const e = (name, fallback) => process.env[name] || fallback
  return {
    platform,
    home,
    appData: e('APPDATA', join(home, 'AppData', 'Roaming')),
    localAppData: e('LOCALAPPDATA', join(home, 'AppData', 'Local')),
    programData: e('ProgramData', 'C:\\ProgramData'),
    programFiles: e('ProgramFiles', 'C:\\Program Files'),
    programFiles86: e('ProgramFiles(x86)', 'C:\\Program Files (x86)'),
    macSupport: join(home, 'Library', 'Application Support'),
    /** /Users/Shared on macOS (Riot, GOG). */
    shared: '/Users/Shared',
    /** Where macOS apps live. */
    appDirs: ['/Applications', join(home, 'Applications')],
    /** Windows drive roots to look for Xbox and Riot folders on. */
    drives: platform === 'win32' ? ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\'] : [],
    /**
     * False for background use (the activity log): Desktop, Documents and Downloads are never touched,
     * because macOS would ask for permission in the middle of the day.
     */
    userFolders: true,
    /** Installed apps from the scan ([{ name, path, lastUsed }]), when the caller already has them. */
    apps: null,
    reg: platform === 'win32' ? regTree : async () => new Map(),
    sqlite: withDbCopy,
    now: Date.now(),
    ...over,
  }
}

const isMac = (env) => env.platform === 'darwin'
const isWin = (env) => env.platform === 'win32'

/** A folder the detector may read: not guarded by macOS privacy and, in background use, not a personal folder. */
function allowed(env, path) {
  if (!path) return false
  if (env.platform === process.platform && guarded(path)) return false
  if (env.userFolders === false) {
    for (const name of ['Desktop', 'Documents', 'Downloads']) {
      const dir = join(env.home, name)
      if (path === dir || path.startsWith(dir + sep)) return false
    }
  }
  return true
}

// ── small helpers ──
const uniq = (items) => [...new Set(items.filter(Boolean))]
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Milliseconds → ISO, undefined for missing, zero or absurd values (a clock set wrong, a corrupt file). */
export function iso(ms, now = Date.now()) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 946_684_800_000 || n > now + 2 * 86_400_000) return undefined
  return new Date(n).toISOString()
}
/** Unix seconds or milliseconds (launchers use both) → ISO. */
const isoUnix = (v, now) => {
  const n = num(v)
  return iso(n > 0 && n < 100_000_000_000 ? n * 1000 : n, now)
}
const isoText = (text, now) => (typeof text === 'string' && text ? iso(Date.parse(text), now) : undefined)

/** Name used for matching the same game between launchers: no case, diacritics, trademark signs or punctuation. */
export const normName = (name) =>
  plain(name)
    .replace(/[®™©]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

function game(launcher, key, name, extra = {}) {
  const out = { id: `${launcher}:${String(key).trim()}`, name: String(name ?? '').replace(/\s+/g, ' ').trim(), launcher, installed: extra.installed !== false }
  const size = Math.round(num(extra.sizeBytes))
  if (size > 0) out.sizeBytes = size
  const minutes = Math.round(num(extra.playtimeMin))
  if (minutes > 0) out.playtimeMin = minutes
  if (extra.lastPlayed) out.lastPlayed = extra.lastPlayed
  if (extra.lastPlayed && extra.approx) out.approx = true
  if (extra.path) out.path = String(extra.path)
  const exe = uniq((Array.isArray(extra.exe) ? extra.exe : [extra.exe]).map((x) => (x ? basename(String(x).replace(/\\/g, '/')) : null)))
  if (exe.length) out.exe = exe
  if (extra.kind) out.kind = extra.kind
  return out
}

/** Sub-folders of a folder as [{ name, path }], hidden ones left out. */
async function subdirs(dir) {
  if (!dir) return []
  return (await list(dir)).entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => ({ name: e.name, path: join(dir, e.name) }))
}

const mtime = (path) => statOf(path)?.mtimeMs ?? 0

// ── Valve KeyValues (Steam .vdf / .acf) ──
/**
 * Text KeyValues → nested plain objects. Never throws: an unterminated string, a missing brace or
 * binary garbage give back whatever was read up to that point. Not recursive, so a hostile file with
 * thousands of nested blocks cannot overflow the stack. Keys keep their casing, use pick() to read them.
 */
export function parseVdf(text) {
  const src = typeof text === 'string' ? text : ''
  const root = {}
  const stack = [root]
  let key = null
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\uFEFF') {
      i++
    } else if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
    } else if (ch === '{') {
      const child = {}
      if (key !== null) stack[stack.length - 1][key] = child
      // a block without a name is still walked, its content just hangs nowhere
      stack.push(child)
      key = null
      i++
      if (stack.length > 200) break
    } else if (ch === '}') {
      if (stack.length > 1) stack.pop()
      key = null
      i++
    } else {
      let token = ''
      if (ch === '"') {
        i++
        while (i < n && src[i] !== '"') {
          if (src[i] === '\\' && i + 1 < n) {
            const next = src[i + 1]
            token += next === 'n' ? '\n' : next === 't' ? '\t' : next
            i += 2
          } else token += src[i++]
        }
        i++
      } else {
        while (i < n && !/[\s{}"]/.test(src[i])) token += src[i++]
      }
      if (key === null) key = token
      else {
        stack[stack.length - 1][key] = token
        key = null
      }
    }
  }
  return root
}

/** Case-insensitive lookup in a parsed tree: Steam changed the casing of keys between versions. */
export function pick(obj, ...keys) {
  let cur = obj
  for (const want of keys) {
    if (!cur || typeof cur !== 'object') return undefined
    const lower = String(want).toLowerCase()
    const hit = Object.keys(cur).find((k) => k.toLowerCase() === lower)
    cur = hit === undefined ? undefined : cur[hit]
  }
  return cur
}

// ── Windows registry ──
/**
 * `reg.exe query <key> /s` as Map(key path → { value name: value }). Empty when the key is missing.
 * The key is a fixed string from this file, never user data.
 */
export function regTree(key) {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', key, '/s'], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout) => resolve(parseReg(err ? '' : stdout)))
  })
}

/** Parser of the reg.exe text output (exported for the tests). */
export function parseReg(text) {
  const out = new Map()
  let cur = null
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) {
      cur = {}
      out.set(line.trim(), cur)
      continue
    }
    const m = /^\s{4}(.+?)\s{4}(REG_[A-Z_]+)\s{4}(.*)$/.exec(line) ?? /^\s{4}(.+?)\s{4}(REG_[A-Z_]+)\s*$/.exec(line)
    if (!m || !cur) continue
    const raw = m[3] ?? ''
    cur[m[1].trim()] = /^REG_(DWORD|QWORD)$/.test(m[2]) && /^0x[0-9a-f]+$/i.test(raw) ? Number.parseInt(raw, 16) : raw
  }
  return out
}

const UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]
/** Installed programs from the Windows registry: [{ key, name, publisher, path, sizeBytes }]. Read once per run. */
async function uninstallEntries(env) {
  if (!isWin(env)) return []
  env.cache ??= {}
  env.cache.uninstall ??= (async () => {
    const out = []
    for (const root of UNINSTALL_KEYS) {
      let tree = new Map()
      try {
        tree = await env.reg(root)
      } catch {
        // registry not readable: the folder checks still work
      }
      for (const [path, v] of tree) {
        if (!v.DisplayName || v.SystemComponent === 1 || v.ParentKeyName) continue
        out.push({ key: path.split('\\').pop(), name: String(v.DisplayName), publisher: String(v.Publisher ?? ''), path: String(v.InstallLocation ?? '').replace(/^"|"$/g, '').replace(/[\\/]+$/, ''), sizeBytes: num(v.EstimatedSize) * 1024 })
      }
    }
    return out
  })()
  return env.cache.uninstall
}

// ── Steam ──
const STEAM_TOOLS = /^(steamworks common|steam linux runtime|proton\b|steamvr|steam controller)|redistributable|dedicated server|\bsdk\b|\bsoundtrack\b/i
/** Software sold on Steam that is not a game (the local files do not say what kind of app it is). */
const STEAM_SOFTWARE = /^(wallpaper engine|soundpad|obs studio|blender|aseprite|3dmark|borderless gaming|lossless scaling|vtube studio|virtual desktop|rpg maker|krita|godot engine|source filmmaker|gamemaker|fps monitor|live2d|substance 3d|crosshair x|voicemod|fences|displayfusion|clip studio)\b/i

export async function detectSteam(env) {
  let fromReg = null
  if (isWin(env)) {
    try {
      const tree = await env.reg('HKCU\\Software\\Valve\\Steam')
      fromReg = [...tree.values()].map((v) => v.SteamPath).find(Boolean)?.replace(/\//g, '\\') ?? null
    } catch {
      fromReg = null
    }
  }
  const candidates = uniq([
    env.steamDir,
    process.env.STEAM_DIR,
    isMac(env) ? join(env.macSupport, 'Steam') : null,
    fromReg,
    isWin(env) ? join(env.programFiles86, 'Steam') : null,
    isWin(env) ? join(env.programFiles, 'Steam') : null,
    !isMac(env) && !isWin(env) ? join(env.home, '.steam', 'steam') : null,
    !isMac(env) && !isWin(env) ? join(env.home, '.local', 'share', 'Steam') : null,
    !isMac(env) && !isWin(env) ? join(env.home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam') : null,
  ])
  // the registry, the default folder and libraryfolders.vdf spell the same folder differently (case, slashes)
  const key = (p) => (isWin(env) || isMac(env) ? resolve(p).toLowerCase() : resolve(p))
  const byKey = new Map()
  for (const p of candidates) if (!byKey.has(key(p)) && (exists(join(p, 'steamapps')) || exists(join(p, 'userdata')))) byKey.set(key(p), p)
  const roots = [...byKey.values()]
  if (!roots.length) return null
  const root = roots[0]

  // library folders: the main one plus every folder listed in libraryfolders.vdf (old and new format)
  const libs = new Set(roots)
  const libKeys = new Set(roots.map(key))
  const skipped = []
  for (const file of roots.flatMap((r) => [join(r, 'steamapps', 'libraryfolders.vdf'), join(r, 'config', 'libraryfolders.vdf')])) {
    const tree = parseVdf(readText(file, 2_000_000) ?? '')
    const folders = pick(tree, 'libraryfolders') ?? pick(tree, 'libraryfolder') ?? {}
    for (const value of Object.values(folders)) {
      const path = typeof value === 'string' ? value : pick(value, 'path')
      if (typeof path !== 'string' || !/[\\/]/.test(path)) continue
      const clean = path.replace(/[\\/]+$/, '')
      // a library on an external or network disk is left alone (macOS would ask for permission, a sleeping disk would block)
      if (!allowed(env, clean)) skipped.push(clean)
      else if (!libKeys.has(key(clean)) && exists(join(clean, 'steamapps'))) {
        libKeys.add(key(clean))
        libs.add(clean)
      }
    }
  }

  const installed = new Map()
  for (const lib of libs) {
    for (const file of (await names(join(lib, 'steamapps'))).filter((f) => /^appmanifest_\d+\.acf$/i.test(f))) {
      const text = readText(join(lib, 'steamapps', file), 400_000) ?? ''
      // a manifest that does not end with its closing brace was cut off in the middle of a write
      if (!/\}\s*$/.test(text)) continue
      const app = pick(parseVdf(text), 'AppState')
      const appid = String(pick(app, 'appid') ?? '').trim()
      const name = pick(app, 'name')
      if (!/^\d+$/.test(appid) || typeof name !== 'string' || !name.trim() || STEAM_TOOLS.test(name) || STEAM_SOFTWARE.test(name.trim())) continue
      const dir = pick(app, 'installdir')
      installed.set(appid, {
        name,
        sizeBytes: num(pick(app, 'SizeOnDisk')),
        last: num(pick(app, 'LastPlayed')) * 1000,
        minutes: 0,
        path: typeof dir === 'string' && dir ? join(lib, 'steamapps', 'common', dir) : undefined,
      })
    }
  }

  // playtime is in the local config of each Steam account; the most recently used account wins per game
  let persona = null
  const played = new Map()
  const users = (await list(join(root, 'userdata'))).entries.filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
  const configs = users
    .map((u) => join(root, 'userdata', u.name, 'config', 'localconfig.vdf'))
    .filter(exists)
    .sort((a, b) => mtime(b) - mtime(a))
  for (const file of configs.slice(0, 6)) {
    const store = pick(parseVdf(readText(file, 40_000_000) ?? ''), 'UserLocalConfigStore')
    persona ??= pick(store, 'friends', 'PersonaName') ?? null
    const apps = pick(store, 'Software', 'Valve', 'Steam', 'apps')
    if (!apps || typeof apps !== 'object') continue
    for (const [appid, v] of Object.entries(apps)) {
      if (played.has(appid) || !v || typeof v !== 'object') continue
      const minutes = num(pick(v, 'Playtime'))
      const last = num(pick(v, 'LastPlayed')) * 1000
      if (minutes > 0 || last > 0) played.set(appid, { minutes, last })
    }
  }

  const games = []
  for (const [appid, g] of installed) {
    const p = played.get(appid)
    games.push(game('steam', appid, g.name, { sizeBytes: g.sizeBytes, playtimeMin: p?.minutes, lastPlayed: iso(Math.max(g.last, p?.last ?? 0), env.now), path: g.path }))
  }
  const gone = [...played.entries()].filter(([appid, p]) => !installed.has(appid) && p.minutes > 0)
  return {
    launcher: 'steam',
    root,
    libraries: [...libs],
    skippedLibraries: [...new Set(skipped)],
    persona: typeof persona === 'string' ? persona : null,
    games,
    // Steam keeps no names of games that were uninstalled, only their ids and minutes
    playedNotInstalled: gone.length,
    playedNotInstalledMin: gone.reduce((sum, [, p]) => sum + p.minutes, 0),
    totalMin: [...played.values()].reduce((sum, p) => sum + p.minutes, 0),
  }
}

// ── Epic Games Launcher ──
export async function detectEpic(env) {
  const dir = isMac(env) ? join(env.macSupport, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests') : isWin(env) ? join(env.programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests') : null
  if (!dir || !exists(dir)) return null
  const games = []
  for (const file of (await names(dir)).filter((f) => f.toLowerCase().endsWith('.item'))) {
    const item = readJson(join(dir, file), 2_000_000)
    if (!item || typeof item !== 'object' || typeof item.DisplayName !== 'string' || !item.DisplayName.trim()) continue
    // Unreal Engine, plugins and add-ons live in the same folder
    if (Array.isArray(item.AppCategories) && !item.AppCategories.includes('games')) continue
    if (item.bIsApplication === false) continue
    if (item.MainGameAppName && item.AppName && item.MainGameAppName !== item.AppName) continue
    const path = typeof item.InstallLocation === 'string' ? item.InstallLocation : undefined
    games.push(game('epic', item.AppName || item.CatalogItemId || file.replace(/\.item$/i, ''), item.DisplayName, { installed: item.bIsIncompleteInstall !== true, sizeBytes: item.InstallSize, path, exe: item.LaunchExecutable }))
  }
  return { launcher: 'epic', games }
}

// ── Heroic (open launcher for Epic and GOG games) ──
export async function detectHeroic(env) {
  const dir = isMac(env) ? join(env.macSupport, 'heroic') : isWin(env) ? join(env.appData, 'heroic') : join(env.home, '.config', 'heroic')
  if (!exists(dir)) return null
  const times = readJson(join(dir, 'store', 'timestamp.json'), 4_000_000) ?? {}
  const games = []
  const add = (id, title, extra) => {
    if (!id || typeof title !== 'string' || !title.trim()) return
    const t = times[id] && typeof times[id] === 'object' ? times[id] : {}
    games.push(game('heroic', id, title, { ...extra, playtimeMin: t.totalPlayed, lastPlayed: isoText(t.lastPlayed, env.now) }))
  }
  const legendary = readJson(join(dir, 'legendaryConfig', 'legendary', 'installed.json'), 8_000_000)
  if (legendary && typeof legendary === 'object') {
    for (const [id, g] of Object.entries(legendary)) if (g && typeof g === 'object' && !g.is_dlc) add(id, g.title, { sizeBytes: g.install_size, path: g.install_path, exe: g.executable })
  }
  const gogTitles = new Map()
  for (const g of readJson(join(dir, 'store_cache', 'gog_library.json'), 30_000_000)?.games ?? []) if (g?.app_name && g.title) gogTitles.set(String(g.app_name), g.title)
  for (const g of readJson(join(dir, 'gog_store', 'installed.json'), 8_000_000)?.installed ?? []) {
    if (g && typeof g === 'object' && g.appName) add(String(g.appName), gogTitles.get(String(g.appName)) ?? (g.install_path ? basename(String(g.install_path).replace(/\\/g, '/')) : ''), { path: g.install_path })
  }
  return { launcher: 'heroic', games }
}

// ── GOG Galaxy ──
export async function detectGog(env) {
  const db = isWin(env) ? join(env.programData, 'GOG.com', 'Galaxy', 'storage', 'galaxy-2.0.db') : isMac(env) ? join(env.shared, 'GOG.com', 'Galaxy', 'Storage', 'galaxy-2.0.db') : null
  const games = new Map()
  const other = []
  let source = null
  if (db && exists(db)) {
    try {
      await env.sqlite(db, async (query) => {
        const rows = async (sql) => {
          try {
            return (await query(sql)) ?? []
          } catch {
            return []
          }
        }
        const titles = new Map()
        for (const r of await rows('SELECT productId AS id, title FROM LimitedDetails')) if (r.title) titles.set(`gog_${r.id}`, String(r.title))
        for (const r of await rows("SELECT gp.releaseKey AS k, gp.value AS v FROM GamePieces gp JOIN GamePieceTypes t ON t.id = gp.gamePieceTypeId WHERE t.type IN ('title', 'originalTitle')")) {
          try {
            const title = JSON.parse(r.v)?.title
            if (typeof title === 'string' && title && !titles.has(r.k)) titles.set(String(r.k), title)
          } catch {
            // one broken row does not matter
          }
        }
        const minutes = new Map()
        for (const r of await rows('SELECT releaseKey AS k, minutesInGame AS m FROM GameTimes')) minutes.set(String(r.k), Math.max(minutes.get(String(r.k)) ?? 0, num(r.m)))
        const last = new Map()
        for (const r of await rows('SELECT gameReleaseKey AS k, lastPlayedDate AS d FROM LastPlayedDates')) {
          const at = typeof r.d === 'string' && r.d ? Date.parse(`${r.d.replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(r.d) ? '' : 'Z'}`) : 0
          if (at > (last.get(String(r.k)) ?? 0)) last.set(String(r.k), at)
        }
        const paths = new Map()
        for (const r of await rows('SELECT productId AS id, installationPath AS p FROM InstalledBaseProducts')) paths.set(`gog_${r.id}`, r.p ? String(r.p) : undefined)
        for (const key of new Set([...paths.keys(), ...minutes.keys(), ...last.keys()])) {
          const title = titles.get(key)
          if (!title) continue
          const extra = { playtimeMin: minutes.get(key), lastPlayed: iso(last.get(key), env.now) }
          if (key.startsWith('gog_')) {
            if (!paths.has(key) && !extra.playtimeMin && !extra.lastPlayed) continue
            games.set(key, game('gog', key.slice(4), title, { ...extra, installed: paths.has(key), path: paths.get(key) }))
          } else if (extra.playtimeMin || extra.lastPlayed) {
            // Galaxy also tracks time in games of other shops it is connected to (Epic, Xbox…)
            other.push({ name: title, platform: key.split('_')[0], ...extra })
          }
        }
        source = 'galaxy-2.0.db'
      })
    } catch {
      // no SQLite reader on this computer or the database is locked: the registry below still lists the games
    }
  }
  if (isWin(env)) {
    let tree = new Map()
    try {
      tree = await env.reg('HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games')
    } catch {
      tree = new Map()
    }
    for (const v of tree.values()) {
      const id = String(v.gameID ?? v.productID ?? '').trim()
      if (!id || !v.gameName || (v.dependsOn && String(v.dependsOn).trim())) continue
      const key = `gog_${id}`
      const known = games.get(key)
      if (known) {
        known.installed = true
        known.path ??= v.path ? String(v.path) : undefined
        if (v.exe) known.exe = [basename(String(v.exe).replace(/\\/g, '/'))]
      } else games.set(key, game('gog', id, v.gameName, { path: v.path, exe: v.exe }))
      source ??= 'registry'
    }
  }
  if (!source && !games.size) return null
  return { launcher: 'gog', games: [...games.values()].filter((g) => g.name), other, source }
}

// ── Battle.net ──
/** Product codes of the Battle.net client → [game, its usual folder name, sub-folder that tells editions in one folder apart]. */
const BNET = {
  wow: ['World of Warcraft', 'World of Warcraft', '_retail_'],
  wow_classic: ['World of Warcraft Classic', 'World of Warcraft', '_classic_'],
  wow_classic_era: ['World of Warcraft Classic Era', 'World of Warcraft', '_classic_era_'],
  pro: ['Overwatch 2', 'Overwatch'],
  prometheus: ['Overwatch 2', 'Overwatch'],
  d3: ['Diablo III'],
  fenris: ['Diablo IV'],
  osi: ['Diablo II: Resurrected', 'Diablo II Resurrected'],
  anbs: ['Diablo Immortal'],
  hsb: ['Hearthstone'],
  hs_beta: ['Hearthstone'],
  s1: ['StarCraft', 'StarCraft'],
  s2: ['StarCraft II'],
  heroes: ['Heroes of the Storm'],
  w3: ['Warcraft III', 'Warcraft III'],
  gryphon: ['Warcraft Rumble'],
  rtro: ['Blizzard Arcade Collection'],
  wlby: ["Crash Bandicoot 4: It's About Time", 'Crash Bandicoot 4'],
  viper: ['Call of Duty: Black Ops 4', 'Call of Duty Black Ops 4'],
  odin: ['Call of Duty: Modern Warfare', 'Call of Duty Modern Warfare'],
  lazr: ['Call of Duty: Modern Warfare 2 Campaign Remastered', 'Call of Duty Modern Warfare 2 Campaign Remastered'],
  zeus: ['Call of Duty: Black Ops Cold War', 'Call of Duty Black Ops Cold War'],
  fore: ['Call of Duty: Vanguard', 'Call of Duty Vanguard'],
  auks: ['Call of Duty', 'Call of Duty'],
}

export async function detectBattleNet(env) {
  const configFile = isWin(env) ? join(env.appData, 'Battle.net', 'Battle.net.config') : isMac(env) ? join(env.macSupport, 'Battle.net', 'Battle.net.config') : null
  const config = configFile ? readJson(configFile, 4_000_000) : null
  const roots = isWin(env) ? [env.programFiles86, env.programFiles] : isMac(env) ? env.appDirs : []
  const uninstall = (await uninstallEntries(env)).filter((u) => /blizzard|activision/i.test(u.publisher) && !/battle\.net|launcher/i.test(u.name))
  const byName = new Map()
  const put = (name, extra) => {
    const key = normName(name)
    const known = byName.get(key)
    if (!known) return byName.set(key, { name, ...extra })
    known.installed ||= extra.installed
    known.path ??= extra.path
    known.lastPlayed ??= extra.lastPlayed
    known.sizeBytes ??= extra.sizeBytes
  }
  for (const [code, [name, folder = name, marker = null]] of Object.entries(BNET)) {
    const played = isoUnix(config?.Games?.[code]?.LastPlayed, env.now)
    const path = roots.map((r) => (marker ? join(r, folder, marker) : join(r, folder))).find((p) => exists(p)) ?? (isMac(env) && !marker ? roots.map((r) => join(r, `${folder}.app`)).find((p) => exists(p)) : undefined)
    if (played || path) put(name, { code, installed: Boolean(path), path, lastPlayed: played })
  }
  for (const u of uninstall) put(u.name, { code: u.key, installed: true, path: u.path || undefined, sizeBytes: u.sizeBytes })
  const present = Boolean(config) || byName.size > 0 || (isWin(env) && exists(join(env.programData, 'Battle.net')))
  if (!present) return null
  return { launcher: 'battlenet', games: [...byName.values()].map((g) => game('battlenet', g.code, g.name, g)) }
}

// ── Riot Games ──
const RIOT = { league_of_legends: 'League of Legends', valorant: 'VALORANT', bacon: 'Legends of Runeterra', lion: '2XKO' }

export async function detectRiot(env) {
  const metaDirs = isWin(env) ? [join(env.programData, 'Riot Games', 'Metadata')] : isMac(env) ? [join(env.shared, 'Riot Games', 'Metadata')] : []
  const games = new Map()
  for (const meta of metaDirs) {
    for (const d of await subdirs(meta)) {
      const product = d.name.split('.')[0]
      if (!RIOT[product] || games.has(product)) continue
      const yaml = readText(join(d.path, `${d.name}.product_settings.yaml`), 400_000) ?? ''
      const path = /^product_install_full_path:\s*"?(.+?)"?\s*$/m.exec(yaml)?.[1]?.replace(/\\\\/g, '\\') ?? /^product_install_root:\s*"?(.+?)"?\s*$/m.exec(yaml)?.[1]?.replace(/\\\\/g, '\\')
      games.set(product, { name: RIOT[product], path, installed: path ? exists(path) : false })
    }
  }
  // without the metadata (an old client, a copied folder): the usual install folders
  const folders = isWin(env) ? env.drives.map((d) => join(d, 'Riot Games')) : isMac(env) ? [join(env.shared, 'Riot Games')] : []
  for (const root of folders) {
    for (const d of await subdirs(root)) {
      const product = Object.keys(RIOT).find((k) => normName(RIOT[k]) === normName(d.name))
      if (product && !games.get(product)?.installed) games.set(product, { name: RIOT[product], path: d.path, installed: true })
    }
  }
  if (isMac(env)) {
    for (const dir of env.appDirs) {
      for (const [product, name] of Object.entries(RIOT)) {
        const app = join(dir, `${name}.app`)
        if (exists(app) && !games.get(product)?.installed) games.set(product, { name, path: app, installed: true })
      }
    }
  }
  // Riot keeps no playtime on the computer; the newest game log says when it ran last
  const logs = {
    valorant: [join(env.localAppData, 'VALORANT', 'Saved', 'Logs')],
    league_of_legends: (path) => [path && join(path, 'Logs', 'GameLogs'), path && join(path, 'Contents', 'LoL', 'Logs', 'GameLogs')],
  }
  const out = []
  for (const [product, g] of games) {
    const dirs = typeof logs[product] === 'function' ? logs[product](g.path) : (logs[product] ?? [])
    const last = Math.max(0, ...dirs.filter(Boolean).map(mtime))
    out.push(game('riot', product, g.name, { installed: g.installed, path: g.path, lastPlayed: iso(last, env.now), approx: true }))
  }
  const present = out.length > 0 || metaDirs.some((d) => exists(d)) || folders.some((d) => exists(d))
  return present ? { launcher: 'riot', games: out } : null
}

// ── EA app and Origin ──
export async function detectEa(env) {
  if (!isWin(env)) return null
  const games = new Map()
  const roots = [join(env.programFiles, 'EA Games'), join(env.programFiles86, 'EA Games'), join(env.programFiles86, 'Origin Games'), join(env.programFiles, 'Origin Games')]
  for (const root of roots) {
    for (const d of await subdirs(root)) {
      const xml = readText(join(d.path, '__Installer', 'installerdata.xml'), 1_000_000) ?? ''
      const title = /<gameTitle[^>]*locale="en_US"[^>]*>([^<]+)<\/gameTitle>/i.exec(xml)?.[1] ?? /<gameTitle[^>]*>([^<]+)<\/gameTitle>/i.exec(xml)?.[1] ?? d.name
      const clean = title.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&amp;/g, '&').replace(/[™®©]/g, '')
      games.set(normName(clean), game('ea', d.name, clean, { path: d.path }))
    }
  }
  for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\EA Games', 'HKLM\\SOFTWARE\\EA Games', 'HKLM\\SOFTWARE\\WOW6432Node\\Origin Games']) {
    let tree = new Map()
    try {
      tree = await env.reg(key)
    } catch {
      tree = new Map()
    }
    for (const [path, v] of tree) {
      const dir = String(v['Install Dir'] ?? v.InstallDir ?? '').replace(/[\\/]+$/, '')
      const title = String(v.DisplayName ?? '').trim() || path.split('\\').pop()
      // an entry whose folder is gone is a leftover of an uninstalled game
      if (!dir || !exists(dir) || games.has(normName(title))) continue
      games.set(normName(title), game('ea', path.split('\\').pop(), title, { path: dir }))
    }
  }
  const present = games.size > 0 || exists(join(env.programData, 'EA Desktop')) || exists(join(env.programData, 'Origin'))
  return present ? { launcher: 'ea', games: [...games.values()] } : null
}

// ── Ubisoft Connect ──
export async function detectUbisoft(env) {
  if (!isWin(env)) return null
  const games = new Map()
  const launcherDir = join(env.programFiles86, 'Ubisoft', 'Ubisoft Game Launcher')
  for (const d of await subdirs(join(launcherDir, 'games'))) games.set(normName(d.name), game('ubisoft', d.name, d.name, { path: d.path }))
  let tree = new Map()
  try {
    tree = await env.reg('HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs')
  } catch {
    tree = new Map()
  }
  for (const [path, v] of tree) {
    const dir = String(v.InstallDir ?? '').replace(/[\\/]+$/, '')
    if (!dir || !exists(dir)) continue
    const name = basename(dir.replace(/\\/g, '/'))
    if (name && !games.has(normName(name))) games.set(normName(name), game('ubisoft', path.split('\\').pop(), name, { path: dir }))
  }
  for (const u of await uninstallEntries(env)) {
    if (!/^uplay install \d+$/i.test(u.key) || games.has(normName(u.name))) continue
    games.set(normName(u.name), game('ubisoft', u.key.replace(/\D+/g, ''), u.name, { path: u.path || undefined, sizeBytes: u.sizeBytes }))
  }
  const present = games.size > 0 || exists(launcherDir)
  return present ? { launcher: 'ubisoft', games: [...games.values()] } : null
}

// ── Xbox app (Microsoft Store games) ──
export async function detectXbox(env) {
  if (!isWin(env)) return null
  const games = []
  for (const drive of env.drives) {
    for (const d of await subdirs(join(drive, 'XboxGames'))) {
      if (/^gameSave$/i.test(d.name) || !exists(join(d.path, 'Content'))) continue
      games.push(game('xbox', d.name, d.name, { path: d.path }))
    }
  }
  return games.length ? { launcher: 'xbox', games } : null
}

// ── itch.io ──
export async function detectItch(env) {
  const dir = isMac(env) ? join(env.macSupport, 'itch') : isWin(env) ? join(env.appData, 'itch') : join(env.home, '.config', 'itch')
  const db = join(dir, 'db', 'butler.db')
  if (!exists(dir)) return null
  const games = []
  if (exists(db)) {
    try {
      await env.sqlite(db, async (query) => {
        let rows = []
        try {
          rows = await query(
            "SELECT g.id AS id, g.title AS title, g.classification AS kind, c.seconds_run AS seconds, c.last_touched_at AS last, c.installed_size AS size, c.install_folder_name AS folder, l.path AS root FROM caves c JOIN games g ON g.id = c.game_id LEFT JOIN install_locations l ON l.id = c.install_location_id",
          )
        } catch {
          try {
            rows = await query('SELECT g.id AS id, g.title AS title, c.seconds_run AS seconds, c.last_touched_at AS last FROM caves c JOIN games g ON g.id = c.game_id')
          } catch {
            rows = []
          }
        }
        for (const r of rows ?? []) {
          if (!r.title || (r.kind && !/^(game|)$/i.test(String(r.kind)))) continue
          games.push(game('itch', r.id, r.title, { playtimeMin: num(r.seconds) / 60, lastPlayed: isoText(r.last, env.now), sizeBytes: r.size, path: r.root && r.folder ? join(String(r.root), String(r.folder)) : undefined }))
        }
      })
    } catch {
      // no SQLite reader: the app is still reported as present
    }
  }
  return { launcher: 'itch', games }
}

// ── Rockstar Games Launcher ──
export async function detectRockstar(env) {
  if (!isWin(env)) return null
  const games = new Map()
  const skip = /^(launcher|social club)$/i
  for (const root of [join(env.programFiles, 'Rockstar Games'), join(env.programFiles86, 'Rockstar Games')]) {
    for (const d of await subdirs(root)) if (!skip.test(d.name)) games.set(normName(d.name), game('rockstar', d.name, d.name, { path: d.path }))
  }
  let tree = new Map()
  try {
    tree = await env.reg('HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games')
  } catch {
    tree = new Map()
  }
  for (const [path, v] of tree) {
    const name = path.split('\\').pop()
    const dir = String(v.InstallFolder ?? '').replace(/[\\/]+$/, '')
    if (!dir || !exists(dir) || skip.test(name) || /launcher|social club/i.test(name) || games.has(normName(name))) continue
    games.set(normName(name), game('rockstar', name, name, { path: dir }))
  }
  const present = games.size > 0 || exists(join(env.programFiles, 'Rockstar Games', 'Launcher'))
  return present ? { launcher: 'rockstar', games: [...games.values()] } : null
}

// ── Minecraft: the official launcher and launchers with separate instances ──
/** `key=value` lines of an instance.cfg (Prism, MultiMC, PolyMC). */
export function parseIni(text) {
  const out = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_.]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && !(m[1] in out)) out[m[1]] = m[2]
  }
  return out
}

/** The game folder of an instance (where saves, mods and logs are). */
export const instanceGameDir = (base) => [join(base, '.minecraft'), join(base, 'minecraft'), base].find((p) => exists(join(p, 'saves')) || exists(join(p, 'mods')) || exists(join(p, 'logs'))) ?? base

export function minecraftDir(env) {
  return isMac(env) ? join(env.macSupport, 'minecraft') : isWin(env) ? join(env.appData, '.minecraft') : join(env.home, '.minecraft')
}

export function instanceRoots(env) {
  const support = (mac, win, linux) => (isMac(env) ? join(env.macSupport, mac) : isWin(env) ? join(env.appData, win) : join(env.home, '.local', 'share', linux))
  return [
    ['prism', support('PrismLauncher', 'PrismLauncher', 'PrismLauncher')],
    ['prism', support('PolyMC', 'PolyMC', 'PolyMC')],
    ['multimc', join(env.home, 'MultiMC')],
    ['multimc', isMac(env) ? '/Applications/MultiMC.app/Data' : join(env.home, 'Downloads', 'MultiMC')],
    ['curseforge', join(env.home, 'curseforge', 'minecraft')],
    ['curseforge', join(env.home, 'Documents', 'curseforge', 'minecraft')],
    ['modrinth', support('ModrinthApp', 'ModrinthApp', 'ModrinthApp')],
    ['modrinth', support('com.modrinth.theseus', 'com.modrinth.theseus', 'com.modrinth.theseus')],
    ['atlauncher', isWin(env) ? join(env.appData, 'ATLauncher') : join(env.home, '.local', 'share', 'atlauncher')],
  ].filter(([, root]) => allowed(env, root))
}

export async function detectMinecraft(env) {
  const games = []
  const dir = minecraftDir(env)
  if (exists(dir)) {
    const profiles = Object.values(readJson(join(dir, 'launcher_profiles.json'), 4_000_000)?.profiles ?? {})
    const used = Math.max(0, ...profiles.map((p) => (p && typeof p.lastUsed === 'string' ? Date.parse(p.lastUsed) || 0 : 0)), mtime(join(dir, 'logs', 'latest.log')), mtime(join(dir, 'saves')))
    games.push(game('minecraft', 'java', 'Minecraft', { path: dir, lastPlayed: iso(used, env.now), approx: true, exe: ['javaw.exe', 'java'] }))
  }
  if (isWin(env)) {
    const bedrock = join(env.localAppData, 'Packages', 'Microsoft.MinecraftUWP_8wekyb3d8bbwe')
    if (exists(bedrock)) games.push(game('minecraft', 'bedrock', 'Minecraft (Bedrock)', { path: bedrock, lastPlayed: iso(mtime(join(bedrock, 'LocalState', 'games', 'com.mojang', 'minecraftWorlds')), env.now), approx: true, exe: ['Minecraft.Windows.exe'] }))
  }

  for (const [launcher, root] of instanceRoots(env)) {
    const folder = launcher === 'curseforge' ? 'Instances' : launcher === 'modrinth' ? 'profiles' : 'instances'
    // newer Modrinth versions keep names and playtime in app.db next to the profiles folder
    const modrinthDb = new Map()
    if (launcher === 'modrinth' && exists(join(root, 'app.db'))) {
      try {
        await env.sqlite(join(root, 'app.db'), async (query) => {
          let rows = []
          try {
            rows = await query('SELECT path, name, last_played AS last, submitted_time_played AS a, recent_time_played AS b FROM profiles')
          } catch {
            rows = []
          }
          for (const r of rows ?? []) modrinthDb.set(String(r.path), r)
        })
      } catch {
        // the folder names below are enough
      }
    }
    for (const d of await subdirs(join(root, folder))) {
      if (d.name.startsWith('_')) continue
      const gameDir = instanceGameDir(d.path)
      let name = d.name
      let minutes = 0
      let last = 0
      let approx = false
      if (launcher === 'prism' || launcher === 'multimc') {
        const cfg = parseIni(readText(join(d.path, 'instance.cfg'), 200_000))
        if (cfg.name) name = cfg.name
        minutes = num(cfg.totalTimePlayed) / 60
        last = num(cfg.lastLaunchTime)
      } else if (launcher === 'curseforge') {
        const inst = readJson(join(d.path, 'minecraftinstance.json'), 30_000_000)
        if (typeof inst?.name === 'string' && inst.name) name = inst.name
        last = typeof inst?.lastPlayed === 'string' ? Date.parse(inst.lastPlayed) || 0 : 0
      } else if (launcher === 'modrinth') {
        const row = modrinthDb.get(d.name)
        const meta = readJson(join(d.path, 'profile.json'), 4_000_000)?.metadata
        if (row?.name) name = String(row.name)
        else if (typeof meta?.name === 'string' && meta.name) name = meta.name
        minutes = (num(row?.a) + num(row?.b)) / 60
        last = row?.last ? num(row.last) * (num(row.last) < 100_000_000_000 ? 1000 : 1) : typeof meta?.last_played === 'string' ? Date.parse(meta.last_played) || 0 : 0
      } else if (launcher === 'atlauncher') {
        const inst = readJson(join(d.path, 'instance.json'), 30_000_000)?.launcher
        if (typeof inst?.name === 'string' && inst.name) name = inst.name
        last = num(inst?.lastPlayed)
        minutes = num(inst?.totalPlayTime) / 60
      }
      if (!last) {
        last = Math.max(mtime(join(gameDir, 'logs', 'latest.log')), mtime(join(gameDir, 'saves')))
        approx = true
      }
      games.push(game(launcher, d.name, `Minecraft: ${name}`, { path: d.path, playtimeMin: minutes, lastPlayed: iso(last, env.now), approx, kind: 'instance' }))
    }
  }
  return games.length ? { launcher: 'minecraft', games } : null
}

// ── Roblox ──
export async function detectRoblox(env) {
  const dirs = isMac(env) ? [...env.appDirs.map((d) => join(d, 'Roblox.app')), join(env.home, 'Library', 'Roblox')] : isWin(env) ? [join(env.localAppData, 'Roblox', 'Versions'), join(env.programFiles86, 'Roblox', 'Versions')] : []
  const path = dirs.find((p) => exists(p))
  if (!path) return null
  const logs = isMac(env) ? [join(env.home, 'Library', 'Logs', 'Roblox')] : [join(env.localAppData, 'Roblox', 'logs')]
  const last = Math.max(0, ...logs.map(mtime))
  return { launcher: 'roblox', games: [game('roblox', 'player', 'Roblox', { path, lastPlayed: iso(last, env.now), approx: true, exe: ['RobloxPlayerBeta.exe', 'RobloxPlayer'] })] }
}

// ── games installed on their own ──
/** Well-known games that are installed outside the big shops (or next to them). Normalised names. */
const WELL_KNOWN = new Set(
  [
    'Genshin Impact', 'Honkai: Star Rail', 'Zenless Zone Zero', 'Wuthering Waves', 'osu!', 'osu!(lazer)', 'World of Tanks', 'World of Warships', 'War Thunder',
    'Path of Exile', 'Path of Exile 2', 'Escape from Tarkov', 'Star Citizen', 'EVE Online', 'RuneScape', 'Old School RuneScape', 'Guild Wars 2', 'Final Fantasy XIV Online',
    'Albion Online', 'Warframe', 'Fortnite', 'Rocket League', 'Fall Guys', 'FiveM', 'RAGE Multiplayer', 'Among Us', 'Tibia', 'Growtopia', 'Lost Ark', 'Black Desert',
    'The Sims 4', 'Football Manager 2024', 'Football Manager 2025', 'Football Manager 26', 'Factorio', 'Dwarf Fortress', 'Stardew Valley', 'Terraria', 'Celeste', 'Hades',
    'Hollow Knight', 'Baldurs Gate 3', "Baldur's Gate 3", 'Civilization VI', 'Civilization VII', 'Cities: Skylines', 'Cities: Skylines II', 'Dota 2', 'Counter-Strike 2',
    'World of Warcraft', 'Hearthstone', 'Diablo IV', 'Overwatch', 'StarCraft II', 'League of Legends', 'VALORANT', 'Teamfight Tactics', 'Legends of Runeterra',
    'Trackmania', 'Brawlhalla', 'Geometry Dash', 'Clone Hero', 'Beat Saber', 'Euro Truck Simulator 2', 'Farming Simulator 25', 'Farming Simulator 22', 'Assetto Corsa',
    'iRacing', 'Microsoft Flight Simulator', 'Hearts of Iron IV', 'Europa Universalis IV', 'Crusader Kings III', 'Stellaris', 'RimWorld',
    'Project Zomboid', 'Valheim', 'Subnautica', 'No Mans Sky', 'Cyberpunk 2077', 'The Witcher 3', 'Elden Ring', 'Grand Theft Auto V', 'Red Dead Redemption 2',
    'Apex Legends', 'EA SPORTS FC 24', 'EA SPORTS FC 25', 'EA SPORTS FC 26', 'Call of Duty', 'Tom Clancys Rainbow Six Siege', 'Lunar Client', 'Badlion Client', 'Feather Client',
    'Marvel Rivals', 'Delta Force', 'Once Human', 'Tower of Fantasy', 'Mir4', 'Metin2', 'Throne and Liberty', 'New World', 'Smite', 'Paladins', 'Dead by Daylight', 'Sea of Thieves',
  ].map(normName),
)
/** Launchers and helpers that are not games themselves. */
const NOT_GAMES = /^(steam|steam helper|epic games launcher|gog galaxy|battle net|riot client|ea app|origin|ubisoft connect|uplay|xbox|geforce now|rockstar games launcher|heroic|itch|prism launcher|prismlauncher|multimc|curseforge|modrinth app|atlauncher|whisky|crossover|openemu|retroarch|dolphin|parsec|overwolf|medal|faceit|minecraft launcher|roblox studio|robloxstudio|game center)$/

/** LSApplicationCategoryType of a macOS app: App Store games and most native games declare it. */
function macAppCategory(appPath) {
  const file = join(appPath, 'Contents', 'Info.plist')
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    return null
  }
  if (buf.length > 4_000_000) return null
  if (buf.subarray(0, 6).toString('latin1') === 'bplist') {
    // binary plist: keys and short ASCII values sit in the file as plain bytes
    const at = buf.indexOf('LSApplicationCategoryType', 0, 'latin1')
    if (at < 0) return null
    return /public\.app-category\.[a-z-]+/.exec(buf.toString('latin1'))?.[0] ?? null
  }
  return /<key>LSApplicationCategoryType<\/key>\s*<string>([^<]+)<\/string>/.exec(buf.toString('utf8'))?.[1] ?? null
}

export async function detectStandalone(env) {
  const games = []
  if (isMac(env)) {
    let apps = env.apps
    if (!apps) {
      apps = []
      for (const dir of env.appDirs) {
        const top = await list(dir)
        for (const e of top.entries) {
          if (e.name.endsWith('.app')) apps.push({ name: e.name.slice(0, -4), path: join(dir, e.name) })
          else if (e.isDirectory() && !e.name.startsWith('.')) for (const s of (await list(join(dir, e.name))).entries) if (s.name.endsWith('.app')) apps.push({ name: s.name.slice(0, -4), path: join(dir, e.name, s.name) })
        }
      }
    }
    await mapLimit(apps.slice(0, 1500), 8, async (app) => {
      if (!app?.path || !app.name || NOT_GAMES.test(normName(app.name))) return
      const known = WELL_KNOWN.has(normName(app.name))
      const category = known ? null : macAppCategory(app.path)
      if (!known && !/games$/.test(category ?? '')) return
      games.push(game('standalone', app.name, app.name, { path: app.path, lastPlayed: iso(app.lastUsed, env.now), approx: true }))
    })
  } else if (isWin(env)) {
    for (const u of await uninstallEntries(env)) {
      if (/^steam app \d+$/i.test(u.key) || /^uplay install/i.test(u.key) || NOT_GAMES.test(normName(u.name))) continue
      if (!WELL_KNOWN.has(normName(u.name))) continue
      games.push(game('standalone', u.key, u.name, { path: u.path || undefined, sizeBytes: u.sizeBytes }))
    }
  }
  return games.length ? { launcher: 'standalone', games } : null
}

// ── everything together ──
const DETECTORS = { steam: detectSteam, epic: detectEpic, gog: detectGog, battlenet: detectBattleNet, riot: detectRiot, ea: detectEa, ubisoft: detectUbisoft, xbox: detectXbox, itch: detectItch, rockstar: detectRockstar, heroic: detectHeroic, minecraft: detectMinecraft, roblox: detectRoblox, standalone: detectStandalone }

/** The same game listed by several launchers becomes one record: the first launcher in PRIORITY keeps it, the rest fill gaps. */
export function dedupeGames(games) {
  const byName = new Map()
  const rank = (g) => {
    const i = PRIORITY.indexOf(g.launcher)
    return i < 0 ? PRIORITY.length : i
  }
  const sorted = [...games].sort((a, b) => rank(a) - rank(b) || Number(b.installed) - Number(a.installed))
  const out = []
  for (const g of sorted) {
    const key = normName(g.name)
    if (!key) continue
    const first = byName.get(key)
    if (!first) {
      const copy = { ...g }
      byName.set(key, copy)
      out.push(copy)
      continue
    }
    if (first.id === g.id) continue
    first.installed ||= g.installed
    if (!first.playtimeMin && g.playtimeMin) first.playtimeMin = g.playtimeMin
    if (g.lastPlayed && (!first.lastPlayed || (first.approx && !g.approx) || (Boolean(first.approx) === Boolean(g.approx) && g.lastPlayed > first.lastPlayed))) {
      first.lastPlayed = g.lastPlayed
      if (g.approx) first.approx = true
      else delete first.approx
    }
    first.sizeBytes ??= g.sizeBytes
    first.path ??= g.path
    if (g.exe?.length) first.exe = uniq([...(first.exe ?? []), ...g.exe])
    if (g.launcher !== first.launcher && g.launcher !== 'standalone') first.also = uniq([...(first.also ?? []), g.launcher])
  }
  for (const g of out) for (const k of Object.keys(g)) if (g[k] === undefined) delete g[k]
  return out
}

/**
 * Runs every detector. Returns
 *   games      deduplicated records (see the top of this file), most recently played first
 *   launchers  [{ id, name, games, …detector details }] for every launcher that left a trace
 *   errors     [{ launcher, error }] detectors that failed or ran out of time (the rest is still valid)
 */
export async function detectGames(over = {}, { only = null, timeout = 25_000 } = {}) {
  const env = defaultEnv(over)
  const results = await Promise.all(
    Object.entries(DETECTORS)
      .filter(([id]) => !only || only.includes(id))
      .map(async ([id, fn]) => {
        let timer
        try {
          const late = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`detector did not finish in ${timeout} ms`)), timeout)
          })
          return { id, res: await Promise.race([fn(env), late]) }
        } catch (err) {
          return { id, error: err instanceof Error ? err.message : String(err) }
        } finally {
          clearTimeout(timer)
        }
      }),
  )
  const all = []
  const launchers = []
  const errors = []
  const borrowed = []
  for (const r of results) {
    if (r.error) {
      errors.push({ launcher: r.id, error: r.error.slice(0, 300) })
      continue
    }
    if (!r.res) continue
    const { games = [], other = [], launcher: _own, ...detail } = r.res
    all.push(...games)
    borrowed.push(...other)
    // the Minecraft detector reports instances under their own launchers
    const perLauncher = new Map()
    for (const g of games) perLauncher.set(g.launcher, (perLauncher.get(g.launcher) ?? 0) + 1)
    if (!perLauncher.size) perLauncher.set(r.id, 0)
    for (const [id, count] of perLauncher) launchers.push({ ...(id === r.id ? detail : {}), id, name: LAUNCHER_NAMES[id] ?? id, games: count })
  }
  const games = dedupeGames(all)
  // playtime GOG Galaxy measured for games of other shops
  for (const o of borrowed) {
    const hit = games.find((g) => normName(g.name) === normName(o.name))
    if (!hit) continue
    if (!hit.playtimeMin && o.playtimeMin) hit.playtimeMin = Math.round(o.playtimeMin)
    if (o.lastPlayed && (!hit.lastPlayed || hit.approx)) {
      hit.lastPlayed = o.lastPlayed
      delete hit.approx
    }
  }
  games.sort((a, b) => (b.lastPlayed ?? '').localeCompare(a.lastPlayed ?? '') || (b.playtimeMin ?? 0) - (a.playtimeMin ?? 0) || a.name.localeCompare(b.name))
  return { games, launchers, errors }
}
