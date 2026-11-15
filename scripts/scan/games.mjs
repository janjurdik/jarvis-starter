/**
 * Probe "games": Steam (installed games, playtime), other launchers, Minecraft and Roblox.
 * Games say a lot about how the person rests and who they play with.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IS_MAC, IS_WIN, sh } from '../lib.mjs'
import { installedApps } from './apps.mjs'
import { APPDATA, HOME, LOCALAPPDATA, MAC_SUPPORT, PROGRAMDATA, PROGRAMFILES, PROGRAMFILES86, ago, day, exists, gb, guarded, list, mapLimit, names, parseVdf, readJson, readText, regValue, sk, some, statOf, uniq } from './util.mjs'

/** Case-insensitive lookup in a parsed VDF tree. */
const pick = (obj, ...keys) => {
  let cur = obj
  for (const key of keys) {
    if (!cur || typeof cur !== 'object') return undefined
    const hit = Object.keys(cur).find((k) => k.toLowerCase() === key.toLowerCase())
    cur = hit === undefined ? undefined : cur[hit]
  }
  return cur
}
const NOT_A_GAME = /steamworks common|proton|steam linux runtime|steamvr|redistributable|dedicated server|\bsdk\b/i

async function steam(ctx) {
  const roots = uniq([
    IS_MAC ? join(MAC_SUPPORT, 'Steam') : null,
    IS_WIN ? (await regValue('HKCU\\Software\\Valve\\Steam', 'SteamPath'))?.replace(/\//g, '\\') : null,
    IS_WIN ? join(PROGRAMFILES86, 'Steam') : null,
    IS_WIN ? join(PROGRAMFILES, 'Steam') : null,
    !IS_MAC && !IS_WIN ? join(HOME, '.steam', 'steam') : null,
    !IS_MAC && !IS_WIN ? join(HOME, '.local', 'share', 'Steam') : null,
    !IS_MAC && !IS_WIN ? join(HOME, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam') : null,
  ]).filter((p) => exists(join(p, 'steamapps')) || exists(join(p, 'userdata')))
  const root = roots[0]
  if (!root) return

  const libs = new Set([root])
  const folders = pick(parseVdf(readText(join(root, 'steamapps', 'libraryfolders.vdf'), 500_000) ?? ''), 'libraryfolders') ?? {}
  for (const value of Object.values(folders)) {
    const path = typeof value === 'string' ? value : value?.path
    if (path && !guarded(path) && exists(path)) libs.add(path)
  }
  const installed = new Map()
  for (const lib of libs) {
    for (const file of (await names(join(lib, 'steamapps'))).filter((n) => /^appmanifest_\d+\.acf$/.test(n))) {
      const app = pick(parseVdf(readText(join(lib, 'steamapps', file), 200_000) ?? ''), 'AppState')
      if (!app?.appid || !app.name || NOT_A_GAME.test(app.name)) continue
      installed.set(String(app.appid), { appid: String(app.appid), name: app.name, sizeGB: gb(Number(app.SizeOnDisk) || 0), lastPlayed: Number(app.LastPlayed) * 1000 || 0, minutes: 0 })
    }
  }

  // playtime lives in the newest user's local config
  let persona = null
  const played = new Map()
  const users = (await list(join(root, 'userdata'))).entries.filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
  const configs = users.map((u) => join(root, 'userdata', u.name, 'config', 'localconfig.vdf')).filter(exists).sort((a, b) => (statOf(b)?.mtimeMs ?? 0) - (statOf(a)?.mtimeMs ?? 0))
  if (configs[0]) {
    const tree = pick(parseVdf(readText(configs[0], 30_000_000) ?? ''), 'UserLocalConfigStore')
    persona = pick(tree, 'friends', 'PersonaName') ?? null
    for (const [appid, v] of Object.entries(pick(tree, 'Software', 'Valve', 'Steam', 'apps') ?? {})) {
      const minutes = Number(pick(v, 'Playtime')) || 0
      const last = Number(pick(v, 'LastPlayed')) * 1000 || 0
      if (minutes || last) played.set(appid, { minutes, last })
    }
  }
  for (const [appid, p] of played) {
    const game = installed.get(appid)
    if (game) {
      game.minutes = p.minutes
      if (p.last > game.lastPlayed) game.lastPlayed = p.last
    }
  }
  const games = [...installed.values()]
  const totalMinutes = [...played.values()].reduce((n, p) => n + p.minutes, 0)
  const byTime = games.filter((g) => g.minutes > 0).sort((a, b) => b.minutes - a.minutes)
  const byRecent = games.filter((g) => g.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed)
  const unnamed = [...played.keys()].filter((id) => !installed.has(id)).length
  const hours = (m) => Math.round(m / 60)
  ctx.finding({
    id: 'games.steam',
    category: 'games',
    title: 'Steam',
    detail:
      `Steam: ${sk(games.length, 'nainštalovaná hra', 'nainštalované hry', 'nainštalovaných hier')}${games.length ? ` (${some(games.map((g) => g.name), 6)})` : ''}.` +
      (totalMinutes ? ` Spolu odohraných ${hours(totalMinutes)} hodín v ${played.size} hrách.` : '') +
      (byTime.length ? ` Najviac: ${byTime.slice(0, 4).map((g) => `${g.name} (${hours(g.minutes)} h)`).join(', ')}.` : '') +
      (byRecent[0] ? ` Naposledy: ${byRecent[0].name} (${ago(byRecent[0].lastPlayed)}).` : '') +
      (persona ? ` Prezývka: ${persona}.` : ''),
    path: root,
    data: {
      persona,
      installed: games.sort((a, b) => b.lastPlayed - a.lastPlayed).map((g) => ({ name: g.name, appid: g.appid, sizeGB: g.sizeGB, hours: Math.round((g.minutes / 60) * 10) / 10, lastPlayed: day(g.lastPlayed) })),
      playedGames: played.size,
      totalHours: hours(totalMinutes),
      playedButNotInstalled: unnamed,
    },
    use: 'Poznám tvoje hry a koľko času pri nich tráviš. Hodí sa to, keď plánujem tvoj oddych, a viem, o čom hovoríš.',
    action: 'none',
    weight: 3,
  })
}

async function launchers(ctx, apps) {
  const found = []
  // Epic Games
  const epicDir = IS_MAC ? join(MAC_SUPPORT, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests') : IS_WIN ? join(PROGRAMDATA, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests') : null
  const epicGames = []
  for (const file of (await names(epicDir ?? '')).filter((n) => n.endsWith('.item'))) {
    const item = readJson(join(epicDir, file), 2_000_000)
    if (item?.DisplayName && item.bIsApplication !== false) epicGames.push(item.DisplayName)
  }
  if (epicGames.length || apps.has('Epic Games Launcher')) found.push({ launcher: 'Epic Games', games: uniq(epicGames) })

  // GOG
  const gogGames = []
  if (IS_WIN) {
    const res = await sh('reg.exe', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', '/s', '/v', 'gameName'], { timeout: 8000 })
    for (const m of res.out.matchAll(/gameName\s+REG_SZ\s+(.+)/gi)) gogGames.push(m[1].trim())
  }
  if (gogGames.length || apps.has('GOG Galaxy')) found.push({ launcher: 'GOG', games: uniq(gogGames) })

  // Riot
  const riotDir = IS_WIN ? 'C:\\Riot Games' : IS_MAC ? '/Users/Shared/Riot Games' : null
  const riotGames = (await names(riotDir ?? '')).filter((n) => !/^(riot client|metadata)$/i.test(n) && !n.startsWith('.'))
  if (apps.has('League of Legends')) riotGames.push('League of Legends')
  if (apps.has('VALORANT')) riotGames.push('VALORANT')
  if (riotGames.length || apps.has('Riot Client')) found.push({ launcher: 'Riot Games', games: uniq(riotGames) })

  // Battle.net
  const blizzard = ['World of Warcraft', 'Overwatch', 'Diablo IV', 'Diablo III', 'Diablo II Resurrected', 'Hearthstone', 'StarCraft II', 'StarCraft', 'Heroes of the Storm', 'Call of Duty', 'Warcraft III']
  const blizzardRoots = IS_WIN ? [PROGRAMFILES86, PROGRAMFILES] : IS_MAC ? ['/Applications'] : []
  const blizzardGames = blizzard.filter((g) => blizzardRoots.some((r) => exists(join(r, g))))
  if (blizzardGames.length || apps.has('Battle.net')) found.push({ launcher: 'Battle.net', games: blizzardGames })

  for (const name of ['EA app', 'Ubisoft Connect', 'Xbox', 'GeForce NOW', 'Rockstar Games Launcher', 'Heroic', 'itch']) if (apps.has(name)) found.push({ launcher: name, games: [] })
  if (!found.length) return
  const withGames = found.filter((f) => f.games.length)
  ctx.finding({
    id: 'games.launchers',
    category: 'games',
    title: 'Ďalšie herné obchody',
    detail: `Herné obchody a hry mimo Steamu: ${found.map((f) => (f.games.length ? `${f.launcher} (${some(f.games, 4)})` : f.launcher)).join(', ')}.`,
    data: { launchers: found },
    use: withGames.length ? 'Viem, aké ďalšie hry hrávaš.' : 'Viem, kde ďalej hrávaš. Názvy hier z týchto obchodov v počítači nevidím.',
    action: 'none',
    weight: 2,
  })
}

/** Names and addresses of saved multiplayer servers from the (uncompressed NBT) servers.dat. */
function minecraftServers(file) {
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    return []
  }
  const read = (tag) => {
    const out = []
    const needle = Buffer.concat([Buffer.from([0x08, 0x00, tag.length]), Buffer.from(tag)])
    let at = 0
    while ((at = buf.indexOf(needle, at)) >= 0) {
      const start = at + needle.length
      if (start + 2 > buf.length) break
      const len = buf.readUInt16BE(start)
      out.push(buf.toString('utf8', start + 2, start + 2 + len))
      at = start + 2 + len
    }
    return out
  }
  const serverNames = read('name')
  const ips = read('ip')
  return serverNames.slice(0, 40).map((name, i) => ({ name: name.replace(/§./g, ''), address: ips[i] ?? null }))
}

async function worldsIn(savesDir) {
  const entries = (await list(savesDir)).entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  const worlds = await mapLimit(entries.slice(0, 200), 16, async (e) => ({ name: e.name, played: statOf(join(savesDir, e.name, 'level.dat'))?.mtimeMs ?? statOf(join(savesDir, e.name))?.mtimeMs ?? 0 }))
  return worlds
}

async function minecraft(ctx, apps) {
  const dir = IS_MAC ? join(MAC_SUPPORT, 'minecraft') : IS_WIN ? join(APPDATA, '.minecraft') : join(HOME, '.minecraft')
  const worlds = []
  const instances = []
  let servers = []
  const players = []
  let profiles = []
  let mods = 0
  let lastUsed = 0
  if (exists(dir)) {
    worlds.push(...(await worldsIn(join(dir, 'saves'))))
    servers = minecraftServers(join(dir, 'servers.dat'))
    const lp = readJson(join(dir, 'launcher_profiles.json'))
    profiles = Object.values(lp?.profiles ?? {})
      .map((p) => ({ name: p.name || p.type || null, version: p.lastVersionId ?? null, lastUsed: p.lastUsed ? Date.parse(p.lastUsed) || 0 : 0 }))
      .filter((p) => p.version)
      .sort((a, b) => b.lastUsed - a.lastUsed)
    for (const file of ['launcher_accounts.json', 'launcher_accounts_microsoft_store.json']) {
      for (const acc of Object.values(readJson(join(dir, file))?.accounts ?? {})) if (acc?.minecraftProfile?.name) players.push(acc.minecraftProfile.name)
    }
    mods = (await names(join(dir, 'mods'))).filter((n) => n.endsWith('.jar')).length
    lastUsed = Math.max(statOf(join(dir, 'saves'))?.mtimeMs ?? 0, statOf(join(dir, 'logs'))?.mtimeMs ?? 0, profiles[0]?.lastUsed ?? 0)
  }
  // launchers with separate instances
  const instanceRoots = [
    ['Prism Launcher', IS_MAC ? join(MAC_SUPPORT, 'PrismLauncher', 'instances') : IS_WIN ? join(APPDATA, 'PrismLauncher', 'instances') : join(HOME, '.local', 'share', 'PrismLauncher', 'instances')],
    ['CurseForge', join(HOME, 'curseforge', 'minecraft', 'Instances')],
    ['CurseForge', join(HOME, 'Documents', 'curseforge', 'minecraft', 'Instances')],
    ['Modrinth', IS_MAC ? join(MAC_SUPPORT, 'ModrinthApp', 'profiles') : IS_WIN ? join(APPDATA, 'ModrinthApp', 'profiles') : join(HOME, '.local', 'share', 'ModrinthApp', 'profiles')],
    ['MultiMC', join(HOME, 'MultiMC', 'instances')],
  ]
  for (const [launcher, root] of instanceRoots) {
    for (const e of (await list(root)).entries.filter((x) => x.isDirectory() && !x.name.startsWith('.') && !x.name.startsWith('_'))) {
      const base = join(root, e.name)
      const game = [join(base, '.minecraft'), join(base, 'minecraft'), base].find((p) => exists(join(p, 'saves')) || exists(join(p, 'mods'))) ?? base
      const inst = { launcher, name: e.name, lastUsed: statOf(game)?.mtimeMs ?? 0 }
      instances.push(inst)
      worlds.push(...(await worldsIn(join(game, 'saves'))))
      if (!servers.length) servers = minecraftServers(join(game, 'servers.dat'))
      if (inst.lastUsed > lastUsed) lastUsed = inst.lastUsed
    }
  }
  // Bedrock edition on Windows
  if (IS_WIN) {
    const bedrock = join(LOCALAPPDATA, 'Packages', 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', 'LocalState', 'games', 'com.mojang', 'minecraftWorlds')
    for (const id of await names(bedrock)) {
      const name = readText(join(bedrock, id, 'levelname.txt'), 500)?.trim()
      if (name) worlds.push({ name: `${name} (Bedrock)`, played: statOf(join(bedrock, id))?.mtimeMs ?? 0 })
    }
  }
  const extra = ['Lunar Client', 'Badlion Client'].filter((n) => apps.has(n) || (n === 'Lunar Client' && exists(join(HOME, '.lunarclient'))))
  if (!exists(dir) && !instances.length && !worlds.length && !apps.has('Minecraft')) return
  worlds.sort((a, b) => b.played - a.played)
  if (worlds[0]?.played > lastUsed) lastUsed = worlds[0].played
  ctx.finding({
    id: 'games.minecraft',
    category: 'games',
    title: 'Minecraft',
    detail:
      `Minecraft${players.length ? ` (prezývka ${uniq(players).join(', ')})` : ''}: ${sk(worlds.length, 'svet', 'svety', 'svetov')}${worlds.length ? ` (${some(worlds.map((w) => w.name), 5)})` : ''}` +
      (servers.length ? `, uložené servery: ${some(servers.map((s) => s.name || s.address), 5)}` : '') +
      (instances.length ? `, ${sk(instances.length, 'vlastná inštalácia', 'vlastné inštalácie', 'vlastných inštalácií')} hry (${some(instances.map((i) => i.name), 4)})` : '') +
      (lastUsed ? `. Naposledy hraný ${ago(lastUsed)}.` : '.'),
    path: exists(dir) ? dir : null,
    data: {
      players: uniq(players),
      worlds: worlds.slice(0, 60).map((w) => ({ name: w.name, lastPlayed: day(w.played) })),
      servers,
      profiles: profiles.slice(0, 20).map((p) => ({ ...p, lastUsed: day(p.lastUsed) })),
      instances: instances.sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 40).map((i) => ({ ...i, lastUsed: day(i.lastUsed) })),
      mods,
      otherClients: extra,
      lastUsed: day(lastUsed),
    },
    use: 'Poznám tvoje svety a servery, na ktorých hrávaš. Viem sa na ne odvolávať a pamätať si, čo v nich staviaš.',
    action: 'none',
    weight: 3,
  })
}

async function roblox(ctx, apps) {
  const dir = IS_MAC ? join(HOME, 'Library', 'Roblox') : IS_WIN ? join(LOCALAPPDATA, 'Roblox') : null
  if (!exists(dir) && !apps.has('Roblox', 'RobloxStudio')) return
  const used = Math.max(statOf(join(dir ?? '', 'logs'))?.mtimeMs ?? 0, statOf(dir ?? '')?.mtimeMs ?? 0)
  ctx.finding({
    id: 'games.roblox',
    category: 'games',
    title: 'Roblox',
    detail: `Roblox je nainštalovaný${used ? `, naposledy spustený ${ago(used)}` : ''}${apps.has('RobloxStudio') ? '. Máš aj Roblox Studio na tvorbu vlastných hier' : ''}.`,
    path: exists(dir) ? dir : null,
    data: { lastUsed: day(used), studio: apps.has('RobloxStudio') },
    use: 'Viem, že hrávaš Roblox. Ak v ňom aj tvoríš, poviem ti, ako ti viem pomôcť so skriptami.',
    action: 'none',
    weight: 2,
  })
}

export async function games(ctx) {
  const apps = await installedApps()
  await Promise.all([
    ctx.step('steam', () => steam(ctx)),
    ctx.step('launchers', () => launchers(ctx, apps)),
    ctx.step('minecraft', () => minecraft(ctx, apps)),
    ctx.step('roblox', () => roblox(ctx, apps)),
  ])
}
