/**
 * Probe "games": every game on this computer, whichever shop it came from (Steam, Epic, GOG, Battle.net,
 * Riot, EA, Ubisoft, Xbox, itch, Rockstar, Heroic, Minecraft with its launchers, Roblox, games installed
 * on their own), with playtime and the last session where the launcher keeps them. The detection itself
 * is in launchers.mjs; this file turns it into findings and adds Minecraft worlds and servers.
 * Games say a lot about how the person rests and who they play with.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IS_MAC, IS_WIN } from '../lib.mjs'
import { installedApps } from './apps.mjs'
import { LAUNCHER_NAMES, defaultEnv, detectGames, instanceGameDir, minecraftDir } from './launchers.mjs'
import { HOME, LOCALAPPDATA, ago, exists, gb, list, mapLimit, names, readJson, readText, sk, some, statOf, uniq } from './util.mjs'

const hours = (minutes) => Math.round(minutes / 60)
const dayOf = (isoTime) => (isoTime ? isoTime.slice(0, 10) : null)
const msOf = (isoTime) => (isoTime ? Date.parse(isoTime) || 0 : 0)
/** "Hades (12 h, naposledy pred 3 dňami)". */
const withTime = (g) => {
  const bits = [g.playtimeMin >= 60 ? `${hours(g.playtimeMin)} h` : g.playtimeMin ? `${g.playtimeMin} min` : null, g.lastPlayed ? `naposledy ${ago(msOf(g.lastPlayed))}` : null].filter(Boolean)
  return bits.length ? `${g.name} (${bits.join(', ')})` : g.name
}
/** The record as it goes into the report: hours next to minutes, a day instead of a timestamp. */
const row = (g) => ({
  id: g.id,
  name: g.name,
  launcher: g.launcher,
  installed: g.installed,
  ...(g.sizeBytes ? { sizeBytes: g.sizeBytes, sizeGB: gb(g.sizeBytes) } : {}),
  ...(g.playtimeMin ? { playtimeMin: g.playtimeMin, hours: Math.round((g.playtimeMin / 60) * 10) / 10 } : {}),
  ...(g.lastPlayed ? { lastPlayed: g.lastPlayed, lastPlayedDay: dayOf(g.lastPlayed), ...(g.approx ? { approx: true } : {}) } : {}),
  ...(g.path ? { path: g.path } : {}),
  ...(g.also ? { also: g.also } : {}),
})

function steamFinding(ctx, detected) {
  const info = detected.launchers.find((l) => l.id === 'steam')
  if (!info) return
  const games = detected.games.filter((g) => g.launcher === 'steam')
  const byTime = games.filter((g) => g.playtimeMin > 0).sort((a, b) => b.playtimeMin - a.playtimeMin)
  const byRecent = games.filter((g) => g.lastPlayed).sort((a, b) => b.lastPlayed.localeCompare(a.lastPlayed))
  const playedGames = byTime.length + (info.playedNotInstalled ?? 0)
  ctx.finding({
    id: 'games.steam',
    category: 'games',
    title: 'Steam',
    detail:
      `Steam: ${sk(games.length, 'nainštalovaná hra', 'nainštalované hry', 'nainštalovaných hier')}${games.length ? ` (${some(games.map((g) => g.name), 6)})` : ''}.` +
      (info.totalMin ? ` Spolu odohraných ${hours(info.totalMin)} hodín v ${sk(playedGames, 'hre', 'hrách', 'hrách')}.` : '') +
      (byTime.length ? ` Najviac: ${byTime.slice(0, 4).map((g) => `${g.name} (${hours(g.playtimeMin)} h)`).join(', ')}.` : '') +
      (byRecent[0] ? ` Naposledy: ${byRecent[0].name} (${ago(msOf(byRecent[0].lastPlayed))}).` : '') +
      (info.playedNotInstalled ? ` Ďalších ${sk(info.playedNotInstalled, 'hru', 'hry', 'hier')} (${hours(info.playedNotInstalledMin)} h) už nainštalovaných nie je, ich názvy Steam v počítači neuchováva.` : '') +
      (info.skippedLibraries?.length ? ` Knižnicu na externom disku som nečítal (${some(info.skippedLibraries, 2)}).` : '') +
      (info.persona ? ` Prezývka: ${info.persona}.` : ''),
    path: info.root,
    data: {
      persona: info.persona,
      installed: byRecent
        .concat(games.filter((g) => !g.lastPlayed))
        .map((g) => ({ name: g.name, appid: g.id.split(':')[1], sizeGB: gb(g.sizeBytes ?? 0), hours: Math.round(((g.playtimeMin ?? 0) / 60) * 10) / 10, lastPlayed: dayOf(g.lastPlayed) })),
      playedGames,
      totalHours: hours(info.totalMin ?? 0),
      playedButNotInstalled: info.playedNotInstalled ?? 0,
      libraries: info.libraries,
      skippedLibraries: info.skippedLibraries ?? [],
    },
    use: 'Poznám tvoje hry a koľko času pri nich tráviš. Hodí sa to, keď plánujem tvoj oddych, a viem, o čom hovoríš.',
    action: 'none',
    weight: 3,
  })
}

const MINECRAFT_FAMILY = new Set(['minecraft', 'prism', 'multimc', 'curseforge', 'modrinth', 'atlauncher'])
/** Launchers that the detection may miss (no local game list) but whose app is installed. */
const APP_ONLY = { epic: 'Epic Games Launcher', gog: 'GOG Galaxy', riot: 'Riot Client', battlenet: 'Battle.net', ea: 'EA app', ubisoft: 'Ubisoft Connect', xbox: 'Xbox', rockstar: 'Rockstar Games Launcher', heroic: 'Heroic', itch: 'itch' }

function launchersFinding(ctx, detected, apps) {
  const found = []
  for (const l of detected.launchers) {
    if (l.id === 'steam' || l.id === 'roblox' || MINECRAFT_FAMILY.has(l.id)) continue
    found.push({ id: l.id, launcher: LAUNCHER_NAMES[l.id] ?? l.name, records: detected.games.filter((g) => g.launcher === l.id) })
  }
  for (const [id, appName] of Object.entries(APP_ONLY)) if (!found.some((f) => f.id === id) && apps.has(appName)) found.push({ id, launcher: LAUNCHER_NAMES[id], records: [] })
  if (apps.has('GeForce NOW')) found.push({ id: 'geforcenow', launcher: 'GeForce NOW', records: [] })
  if (!found.length) return
  const withGames = found.filter((f) => f.records.length)
  const timed = found.some((f) => f.records.some((g) => g.playtimeMin || g.lastPlayed))
  ctx.finding({
    id: 'games.launchers',
    category: 'games',
    title: 'Ďalšie herné obchody',
    detail: `Herné obchody a hry mimo Steamu: ${found.map((f) => (f.records.length ? `${f.launcher} (${some(f.records.map(withTime), 4)})` : f.launcher)).join(', ')}.`,
    data: { launchers: found.map((f) => ({ launcher: f.launcher, id: f.id, games: uniq(f.records.map((g) => g.name)), records: f.records.map(row) })) },
    use: withGames.length
      ? `Viem, aké ďalšie hry hrávaš${timed ? ' a pri niektorých aj kedy naposledy' : ''}. Odohraný čas si v počítači ukladá len Steam, GOG Galaxy, itch a Heroic.`
      : 'Viem, kde ďalej hrávaš. Názvy hier z týchto obchodov v počítači nevidím.',
    action: 'none',
    weight: 2,
  })
}

function libraryFinding(ctx, detected) {
  const games = detected.games.filter((g) => g.kind !== 'instance')
  if (games.length < 2 || new Set(games.map((g) => g.launcher)).size < 2) return
  const byTime = games.filter((g) => g.playtimeMin > 0).sort((a, b) => b.playtimeMin - a.playtimeMin)
  const recent = games.filter((g) => g.lastPlayed).sort((a, b) => b.lastPlayed.localeCompare(a.lastPlayed))
  ctx.finding({
    id: 'games.all',
    category: 'games',
    title: 'Všetky hry v počítači',
    detail:
      `${sk(games.length, 'hra', 'hry', 'hier')} z ${sk(new Set(games.map((g) => g.launcher)).size, 'zdroja', 'zdrojov', 'zdrojov')}.` +
      (byTime.length ? ` Najviac nahraté: ${byTime.slice(0, 5).map((g) => `${g.name} (${hours(g.playtimeMin)} h)`).join(', ')}.` : '') +
      (recent.length ? ` Naposledy: ${recent.slice(0, 3).map((g) => `${g.name} (${ago(msOf(g.lastPlayed))})`).join(', ')}.` : ''),
    data: { games: games.map(row), errors: detected.errors },
    use: 'Jeden zoznam hier naprieč obchodmi. Podľa neho v zázname aktivity spoznám, ktorú hru práve hráš.',
    action: 'none',
    weight: 1,
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
  return mapLimit(entries.slice(0, 200), 16, async (e) => ({ name: e.name, played: statOf(join(savesDir, e.name, 'level.dat'))?.mtimeMs ?? statOf(join(savesDir, e.name))?.mtimeMs ?? 0 }))
}

async function minecraft(ctx, detected, apps) {
  const dir = minecraftDir(defaultEnv())
  const worlds = []
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
      .map((p) => ({ name: p?.name || p?.type || null, version: p?.lastVersionId ?? null, lastUsed: p?.lastUsed ? Date.parse(p.lastUsed) || 0 : 0 }))
      .filter((p) => p.version)
      .sort((a, b) => b.lastUsed - a.lastUsed)
    for (const file of ['launcher_accounts.json', 'launcher_accounts_microsoft_store.json']) {
      for (const acc of Object.values(readJson(join(dir, file))?.accounts ?? {})) if (acc?.minecraftProfile?.name) players.push(acc.minecraftProfile.name)
    }
    mods = (await names(join(dir, 'mods'))).filter((n) => n.endsWith('.jar')).length
    lastUsed = Math.max(statOf(join(dir, 'saves'))?.mtimeMs ?? 0, statOf(join(dir, 'logs'))?.mtimeMs ?? 0, profiles[0]?.lastUsed ?? 0)
  }
  // launchers with separate instances (Prism, MultiMC, CurseForge, Modrinth, ATLauncher)
  const instances = []
  for (const g of detected.games.filter((x) => x.kind === 'instance')) {
    const used = msOf(g.lastPlayed)
    instances.push({ launcher: LAUNCHER_NAMES[g.launcher] ?? g.launcher, name: g.name.replace(/^Minecraft: /, ''), lastUsed: used, hours: g.playtimeMin ? Math.round((g.playtimeMin / 60) * 10) / 10 : null })
    const gameDir = instanceGameDir(g.path)
    worlds.push(...(await worldsIn(join(gameDir, 'saves'))))
    if (!servers.length) servers = minecraftServers(join(gameDir, 'servers.dat'))
    if (used > lastUsed) lastUsed = used
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
  const instanceMin = detected.games.filter((x) => x.kind === 'instance').reduce((sum, g) => sum + (g.playtimeMin ?? 0), 0)
  ctx.finding({
    id: 'games.minecraft',
    category: 'games',
    title: 'Minecraft',
    detail:
      `Minecraft${players.length ? ` (prezývka ${uniq(players).join(', ')})` : ''}: ${sk(worlds.length, 'svet', 'svety', 'svetov')}${worlds.length ? ` (${some(worlds.map((w) => w.name), 5)})` : ''}` +
      (servers.length ? `, uložené servery: ${some(servers.map((s) => s.name || s.address), 5)}` : '') +
      (instances.length ? `, ${sk(instances.length, 'vlastná inštalácia', 'vlastné inštalácie', 'vlastných inštalácií')} hry (${some(instances.map((i) => i.name), 4)})` : '') +
      (instanceMin >= 60 ? `, v nich odohraných ${hours(instanceMin)} hodín` : '') +
      (lastUsed ? `. Naposledy hraný ${ago(lastUsed)}.` : '.'),
    path: exists(dir) ? dir : null,
    data: {
      players: uniq(players),
      worlds: worlds.slice(0, 60).map((w) => ({ name: w.name, lastPlayed: w.played ? new Date(w.played).toISOString().slice(0, 10) : null })),
      servers,
      profiles: profiles.slice(0, 20).map((p) => ({ ...p, lastUsed: p.lastUsed ? new Date(p.lastUsed).toISOString().slice(0, 10) : null })),
      instances: instances.sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 40).map((i) => ({ ...i, lastUsed: i.lastUsed ? new Date(i.lastUsed).toISOString().slice(0, 10) : null })),
      instanceHours: hours(instanceMin),
      mods,
      otherClients: extra,
      lastUsed: lastUsed ? new Date(lastUsed).toISOString().slice(0, 10) : null,
    },
    use: 'Poznám tvoje svety a servery, na ktorých hrávaš. Viem sa na ne odvolávať a pamätať si, čo v nich staviaš.',
    action: 'none',
    weight: 3,
  })
}

function roblox(ctx, detected, apps) {
  const game = detected.games.find((g) => g.launcher === 'roblox')
  if (!game && !apps.has('Roblox', 'RobloxStudio')) return
  const used = msOf(game?.lastPlayed)
  ctx.finding({
    id: 'games.roblox',
    category: 'games',
    title: 'Roblox',
    detail: `Roblox je nainštalovaný${used ? `, naposledy spustený ${ago(used)}` : ''}${apps.has('RobloxStudio') ? '. Máš aj Roblox Studio na tvorbu vlastných hier' : ''}.`,
    path: game?.path ?? null,
    data: { lastUsed: dayOf(game?.lastPlayed), studio: apps.has('RobloxStudio') },
    use: 'Viem, že hrávaš Roblox. Ak v ňom aj tvoríš, poviem ti, ako ti viem pomôcť so skriptami.',
    action: 'none',
    weight: 2,
  })
}

export async function games(ctx) {
  const apps = await installedApps()
  const detected = (await ctx.step('detect', () => detectGames({ apps: IS_MAC ? apps.list : null }, { timeout: Math.max(4000, ctx.deadline - Date.now()) }))) ?? { games: [], launchers: [], errors: [] }
  for (const e of detected.errors) ctx.local?.errors?.push({ probe: `games.${e.launcher}`, error: e.error })
  await Promise.all([
    ctx.step('steam', () => steamFinding(ctx, detected)),
    ctx.step('launchers', () => launchersFinding(ctx, detected, apps)),
    ctx.step('library', () => libraryFinding(ctx, detected)),
    ctx.step('minecraft', () => minecraft(ctx, detected, apps)),
    ctx.step('roblox', () => roblox(ctx, detected, apps)),
  ])
}
