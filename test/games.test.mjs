/**
 * Game detection (scripts/scan/launchers.mjs) against the fixture folders in test/fixtures/games.
 * The Windows detectors run here too: every path and the registry come from the test environment.
 *
 *   node --test test/*.test.mjs
 */
import { TMP } from './setup.mjs'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const { dedupeGames, defaultEnv, detectGames, iso, normName, parseIni, parseReg, parseVdf, pick } = await import('../scripts/scan/launchers.mjs')

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'games')
const NOW = Date.parse('2026-11-17T12:00:00Z')

/** Copies a fixture tree into the temp folder and puts its real path where the files say {{ROOT}}. */
function stage(name) {
  const root = join(TMP, `games-${name}`)
  cpSync(join(FIXTURES, name), root, { recursive: true })
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.(vdf|acf|item|yaml|json|txt|cfg)$/.test(e.name) && statSync(full).size < 200_000) {
        const text = readFileSync(full, 'utf8')
        if (!text.includes('{{ROOT}}')) continue
        // each format writes Windows paths its own way: VDF and JSON escape the backslash, Riot's YAML uses forward slashes
        const path = /\.yaml$/.test(e.name) ? root.replaceAll('\\', '/') : /\.txt$/.test(e.name) ? root : root.replaceAll('\\', '\\\\')
        writeFileSync(full, text.replaceAll('{{ROOT}}', path))
      }
    }
  }
  walk(root)
  return root
}

let sqlite = null
try {
  sqlite = await import('node:sqlite')
} catch {
  sqlite = null
}
/** Reads a database directly (the real code copies it first; the copy is not what is tested here). */
const sqliteReader = async (file, fn) => {
  if (!sqlite) throw new Error('no sqlite')
  const db = new sqlite.DatabaseSync(file)
  try {
    return await fn((sql) => db.prepare(sql).all())
  } finally {
    db.close()
  }
}

function winEnv(root) {
  const tree = parseReg(readFileSync(join(root, 'registry.txt'), 'utf8'))
  const full = (key) => key.replace(/^HKLM\\/, 'HKEY_LOCAL_MACHINE\\').replace(/^HKCU\\/, 'HKEY_CURRENT_USER\\')
  return defaultEnv({
    platform: 'win32',
    home: join(root, 'home'),
    appData: join(root, 'Roaming'),
    localAppData: join(root, 'Local'),
    programData: join(root, 'ProgramData'),
    programFiles: join(root, 'ProgramFiles'),
    programFiles86: join(root, 'ProgramFiles86'),
    drives: [join(root, 'drive')],
    reg: async (key) => new Map([...tree].filter(([path]) => path === full(key) || path.startsWith(`${full(key)}\\`))),
    sqlite: sqliteReader,
    now: NOW,
  })
}

test('parseVdf never throws on broken input and reads both casings', () => {
  for (const bad of ['', '{', '}}}}', '"a"', '"a" {', '"a" { "b" "c"', '\u0000\u0001{{{"', '"unterminated', 'a b c { d e } }', null, undefined, 42, '"a"\n{\n\t"b"\t\t"c\\\\d"\n}\n// comment']) {
    assert.doesNotThrow(() => parseVdf(bad))
  }
  const tree = parseVdf('"AppState"\n{\n\t"AppID"\t\t"730"\n\t"path"\t\t"C:\\\\Games\\\\X"\n\t"nested" { "Deep" { "k" "v" } }\n}')
  assert.equal(pick(tree, 'appstate', 'appid'), '730')
  assert.equal(pick(tree, 'AppState', 'path'), 'C:\\Games\\X')
  assert.equal(pick(tree, 'APPSTATE', 'NESTED', 'deep', 'K'), 'v')
  assert.equal(pick(tree, 'appstate', 'missing', 'deeper'), undefined)
  // thousands of nested blocks must not overflow the stack
  assert.doesNotThrow(() => parseVdf('"a" {'.repeat(50_000)))
})

test('parseReg reads reg.exe output, parseIni reads instance.cfg', () => {
  const tree = parseReg('\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\X\\Y\r\n    Name    REG_SZ    Some Game\r\n    Size    REG_DWORD    0x10\r\n    Empty    REG_SZ    \r\n\r\ngarbage line\r\n')
  assert.deepEqual(tree.get('HKEY_LOCAL_MACHINE\\SOFTWARE\\X\\Y'), { Name: 'Some Game', Size: 16, Empty: '' })
  assert.equal(parseReg(null).size, 0)
  assert.deepEqual(parseIni('[General]\nname=My World\ntotalTimePlayed=120\nbroken line\n'), { name: 'My World', totalTimePlayed: '120' })
})

test('iso and normName', () => {
  assert.equal(iso(0), undefined)
  assert.equal(iso(NaN), undefined)
  assert.equal(iso(Date.parse('2090-01-01'), NOW), undefined)
  assert.equal(iso(Date.parse('2026-11-01T10:00:00Z'), NOW), '2026-11-01T10:00:00.000Z')
  assert.equal(normName('Tom Clancy’s Rainbow Six® Siege'), normName("tom clancy's rainbow six siege"))
  assert.equal(normName('ELDEN RING™'), 'elden ring')
})

test('Windows: every launcher is found, with playtime where the launcher stores it', async () => {
  const root = stage('win')
  // account 222 was used long ago: its numbers must not replace those of the account used last
  utimesSync(join(root, 'ProgramFiles86', 'Steam', 'userdata', '222', 'config', 'localconfig.vdf'), new Date('2020-01-01'), new Date('2020-01-01'))
  const res = await detectGames(winEnv(root))
  assert.deepEqual(res.errors, [])
  const by = (name) => res.games.find((g) => g.name === name)

  // Steam: two libraries, playtime of the account used last, tools and broken manifests skipped
  const cs = by('Counter-Strike 2')
  assert.equal(cs.launcher, 'steam')
  assert.equal(cs.id, 'steam:730')
  assert.equal(cs.playtimeMin, 6000)
  assert.equal(cs.lastPlayed, new Date(1763000000 * 1000).toISOString())
  assert.equal(cs.sizeBytes, 35000000000)
  assert.ok(cs.path.endsWith(join('steamapps', 'common', 'Counter-Strike Global Offensive')))
  // the same game from Epic is merged into the Steam record
  assert.deepEqual(cs.also, ['epic'])
  assert.equal(res.games.filter((g) => normName(g.name) === 'counter strike 2').length, 1)
  const elden = by('ELDEN RING')
  assert.equal(elden.playtimeMin, 4321)
  assert.ok(elden.path.startsWith(join(root, 'SteamLibrary')))
  assert.equal(by('Steamworks Common Redistributables'), undefined)
  assert.equal(res.games.some((g) => /Half Writ/.test(g.name)), false)
  const steam = res.launchers.find((l) => l.id === 'steam')
  assert.equal(steam.persona, 'tester')
  assert.equal(steam.playedNotInstalled, 1)
  assert.equal(steam.playedNotInstalledMin, 300)
  assert.equal(steam.libraries.length, 2)

  // Epic: games only, no engine, no add-on, no broken file
  assert.equal(by('Fortnite').launcher, 'epic')
  assert.deepEqual(by('Fortnite').exe, ['FortniteClient-Win64-Shipping.exe'])
  assert.equal(by('Unreal Engine'), undefined)
  assert.equal(by('Rocket League Season Pack'), undefined)
  assert.equal(by('Broken Game'), undefined)

  // GOG from the registry: the game, not its add-on
  assert.equal(by('The Witcher 3: Wild Hunt').launcher, 'gog')
  assert.deepEqual(by('The Witcher 3: Wild Hunt').exe, ['witcher3.exe'])
  assert.equal(by('The Witcher 3: Blood and Wine'), undefined)

  // Battle.net: last played from the client's config, installed from the folder or the registry
  assert.equal(by('World of Warcraft').installed, false)
  assert.equal(by('World of Warcraft').lastPlayed, new Date(1761000000 * 1000).toISOString())
  assert.equal(by('Overwatch 2').installed, true)
  assert.equal(by('Diablo IV').launcher, 'battlenet')
  assert.equal(by('Battle.net'), undefined)
  assert.equal(by('Hearthstone'), undefined)

  // Riot: installed only when the folder from the metadata exists
  assert.equal(by('VALORANT').launcher, 'riot')
  assert.equal(by('VALORANT').installed, true)
  assert.equal(by('VALORANT').approx, true)
  assert.equal(by('League of Legends').installed, false)

  assert.equal(by('The Sims 4').launcher, 'ea')
  assert.equal(by("Assassin's Creed Valhalla").launcher, 'ubisoft')
  assert.equal(by("Tom Clancy's Rainbow Six Siege").launcher, 'ubisoft')
  assert.equal(by('Grand Theft Auto V').launcher, 'rockstar')
  // a registry entry whose folder is gone is a leftover of an uninstalled game
  assert.equal(by('Red Dead Redemption 2'), undefined)
  assert.equal(by('Launcher'), undefined)
  assert.equal(by('Forza Horizon 5').launcher, 'xbox')
  assert.equal(by('GameSave'), undefined)
  assert.equal(by('Genshin Impact').launcher, 'standalone')
  assert.equal(by('Genshin Impact').sizeBytes, 0x4c4b400 * 1024)
  assert.equal(by('Microsoft Office Professional Plus 2021'), undefined)

  // Heroic keeps playtime
  assert.equal(by('Rocket League').launcher, 'heroic')
  assert.equal(by('Rocket League').playtimeMin, 845)
  assert.equal(by('Rocket League DLC'), undefined)

  // Minecraft: the launcher itself and the instances of other launchers
  assert.equal(by('Minecraft').id, 'minecraft:java')
  const prism = by('Minecraft: Vanilla 1.21 (survival)')
  assert.equal(prism.launcher, 'prism')
  assert.equal(prism.playtimeMin, 121)
  assert.equal(prism.lastPlayed, new Date(1763400000000).toISOString())
  assert.equal(prism.kind, 'instance')
  assert.equal(res.games.some((g) => /_LAUNCHER_TEMP/.test(g.name)), false)
  assert.equal(by('Minecraft: Fabulously Optimized').lastPlayed, '2026-11-01T20:15:00.000Z')
  assert.equal(by('Minecraft: All the Mods 9').launcher, 'curseforge')
  assert.equal(by('Roblox').launcher, 'roblox')

  // the data model holds for every record
  for (const g of res.games) {
    assert.match(g.id, /^[a-z]+:.+/)
    assert.equal(typeof g.name, 'string')
    assert.ok(g.name.length > 0)
    assert.equal(typeof g.installed, 'boolean')
    for (const key of Object.keys(g)) assert.ok(['id', 'name', 'launcher', 'installed', 'sizeBytes', 'playtimeMin', 'lastPlayed', 'approx', 'path', 'exe', 'kind', 'also'].includes(key), `unexpected field ${key}`)
    if (g.lastPlayed) assert.ok(!Number.isNaN(Date.parse(g.lastPlayed)))
    if (g.playtimeMin !== undefined) assert.ok(Number.isInteger(g.playtimeMin) && g.playtimeMin > 0)
  }
  assert.equal(new Set(res.games.map((g) => g.id)).size, res.games.length)
})

test('Windows: with userFolders off nothing under Desktop, Documents and Downloads is read', async () => {
  const root = stage('win')
  mkdirSync(join(root, 'home', 'Documents', 'curseforge', 'minecraft', 'Instances', 'Hidden Pack'), { recursive: true })
  const env = winEnv(root)
  const open = await detectGames({ ...env, userFolders: true }, { only: ['minecraft'] })
  const closed = await detectGames({ ...env, userFolders: false }, { only: ['minecraft'] })
  assert.ok(open.games.some((g) => g.name === 'Minecraft: Hidden Pack'))
  assert.equal(closed.games.some((g) => g.name === 'Minecraft: Hidden Pack'), false)
})

test('macOS: Steam, games by app category, well-known names, Riot, launchers are not games', async () => {
  const root = stage('mac')
  const env = defaultEnv({ platform: 'darwin', home: join(root, 'home'), macSupport: join(root, 'Support'), shared: join(root, 'Shared'), appDirs: [join(root, 'Applications')], sqlite: sqliteReader, now: NOW })
  const res = await detectGames(env)
  assert.deepEqual(res.errors, [])
  const by = (name) => res.games.find((g) => g.name === name)
  assert.equal(by('Stardew Valley').launcher, 'steam')
  assert.equal(by('Chess Pro').launcher, 'standalone')
  assert.equal(by('The Sims 4').launcher, 'standalone')
  assert.equal(by('Notes Like'), undefined)
  assert.equal(by('Steam'), undefined)
  assert.equal(by('League of Legends').launcher, 'riot')
  assert.equal(by('League of Legends').installed, true)
  assert.ok(by('League of Legends').lastPlayed)
  assert.equal(by('Roblox').launcher, 'roblox')
  // a launcher_profiles.json that is not JSON does not break Minecraft
  assert.equal(by('Minecraft').id, 'minecraft:java')
})

test('a detector that fails or hangs does not take the others down', async () => {
  const root = stage('win')
  const env = winEnv(root)
  const res = await detectGames({ ...env, reg: () => new Promise(() => {}) }, { timeout: 300 })
  assert.ok(res.errors.length > 0)
  // Epic needs no registry and still answers
  assert.ok(res.games.some((g) => g.name === 'Fortnite'))
  const thrown = await detectGames({ ...env, reg: async () => { throw new Error('registry is broken') } })
  assert.ok(thrown.games.some((g) => g.name === 'Counter-Strike 2'))
})

test('SQLite launchers: GOG Galaxy and itch (skipped without node:sqlite)', { skip: !sqlite }, async () => {
  const root = stage('win')
  const gogDir = join(root, 'ProgramData', 'GOG.com', 'Galaxy', 'storage')
  mkdirSync(gogDir, { recursive: true })
  const gog = new sqlite.DatabaseSync(join(gogDir, 'galaxy-2.0.db'))
  gog.exec(`
    CREATE TABLE LimitedDetails (productId INTEGER, title TEXT);
    CREATE TABLE GamePieceTypes (id INTEGER, type TEXT);
    CREATE TABLE GamePieces (releaseKey TEXT, gamePieceTypeId INTEGER, userId INTEGER, value TEXT);
    CREATE TABLE GameTimes (releaseKey TEXT, userId INTEGER, minutesInGame INTEGER);
    CREATE TABLE LastPlayedDates (gameReleaseKey TEXT, userId INTEGER, lastPlayedDate TEXT);
    CREATE TABLE InstalledBaseProducts (productId INTEGER, installationPath TEXT);
    INSERT INTO LimitedDetails VALUES (1207658924, 'The Witcher 3: Wild Hunt');
    INSERT INTO GamePieceTypes VALUES (1, 'title'), (2, 'meta');
    INSERT INTO GamePieces VALUES ('gog_1423049311', 1, 1, '{"title":"Cyberpunk 2077"}'), ('epic_Fortnite', 1, 1, '{"title":"Fortnite"}'), ('gog_1', 1, 1, 'not json');
    INSERT INTO GameTimes VALUES ('gog_1207658924', 1, 5400), ('gog_1423049311', 1, 600), ('epic_Fortnite', 1, 900);
    INSERT INTO LastPlayedDates VALUES ('gog_1207658924', 1, '2026-11-15 20:00:00'), ('epic_Fortnite', 1, '2026-11-16 18:30:00');
    INSERT INTO InstalledBaseProducts VALUES (1207658924, 'C:\\GOG Games\\The Witcher 3 Wild Hunt');
  `)
  gog.close()
  const itchDir = join(root, 'Roaming', 'itch', 'db')
  mkdirSync(itchDir, { recursive: true })
  const itch = new sqlite.DatabaseSync(join(itchDir, 'butler.db'))
  itch.exec(`
    CREATE TABLE games (id INTEGER, title TEXT, classification TEXT);
    CREATE TABLE caves (id TEXT, game_id INTEGER, seconds_run INTEGER, last_touched_at TEXT, installed_size INTEGER, install_folder_name TEXT, install_location_id TEXT);
    CREATE TABLE install_locations (id TEXT, path TEXT);
    INSERT INTO games VALUES (1, 'Celeste Classic', 'game'), (2, 'Tiled', 'tool');
    INSERT INTO caves VALUES ('a', 1, 5400, '2026-11-10T19:00:00Z', 1000000, 'celeste-classic', 'main'), ('b', 2, 60, '2026-11-11T19:00:00Z', 1, 'tiled', 'main');
    INSERT INTO install_locations VALUES ('main', 'C:\\itch');
  `)
  itch.close()
  const res = await detectGames(winEnv(root))
  assert.deepEqual(res.errors, [])
  const by = (name) => res.games.find((g) => g.name === name)
  const witcher = by('The Witcher 3: Wild Hunt')
  assert.equal(witcher.playtimeMin, 5400)
  assert.equal(witcher.lastPlayed, '2026-11-15T20:00:00.000Z')
  assert.equal(witcher.installed, true)
  // owned on GOG, played, not installed now
  assert.equal(by('Cyberpunk 2077').installed, false)
  assert.equal(by('Cyberpunk 2077').playtimeMin, 600)
  // Galaxy's playtime for an Epic game fills the Epic record
  assert.equal(by('Fortnite').launcher, 'epic')
  assert.equal(by('Fortnite').playtimeMin, 900)
  assert.equal(by('Fortnite').lastPlayed, '2026-11-16T18:30:00.000Z')
  assert.equal(by('Celeste Classic').playtimeMin, 90)
  assert.equal(by('Tiled'), undefined)
})

test('dedupeGames keeps the launcher with the better data and never loses playtime', () => {
  const out = dedupeGames([
    { id: 'standalone:x', name: 'Hades', launcher: 'standalone', installed: true, path: '/Applications/Hades.app' },
    { id: 'epic:h', name: 'HADES', launcher: 'epic', installed: false },
    { id: 'steam:1145360', name: 'Hades™', launcher: 'steam', installed: true, playtimeMin: 300, lastPlayed: '2026-01-01T00:00:00.000Z' },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'steam:1145360')
  assert.equal(out[0].playtimeMin, 300)
  assert.equal(out[0].path, '/Applications/Hades.app')
  assert.deepEqual(out[0].also, ['epic'])
})
