/**
 * Steam: nothing to export, the game list is read from the local Steam files.
 *
 *   steamapps/libraryfolders.vdf                  other library folders
 *   steamapps/appmanifest_<appid>.acf             installed game: name, LastPlayed, SizeOnDisk
 *   userdata/<id>/config/localconfig.vdf          per game: Playtime (minutes), LastPlayed
 *
 * Writes memory/hry/Steam.md. Names are only known for installed games (the local files of
 * Steam do not keep names of games that were uninstalled).
 */
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isoDay } from '../../hud/server/util.mjs'
import { writeGeneratedNote } from './notes.mjs'
import { MEMORY_DIR, UserError, fmtInt, plural } from './util.mjs'

/**
 * Valve KeyValues text ("key" "value" pairs and nested { } blocks) → plain object.
 * Keys are lower-cased because their casing differs between Steam versions.
 */
export function parseVdf(text) {
  const src = String(text)
  let i = 0
  const token = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++
      if (src[i] === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++
        continue
      }
      break
    }
    if (i >= src.length) return null
    const ch = src[i]
    if (ch === '{' || ch === '}') {
      i++
      return { brace: ch }
    }
    if (ch === '"') {
      let out = ''
      i++
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const next = src[i + 1]
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next
          i += 2
        } else out += src[i++]
      }
      i++
      return { text: out }
    }
    let out = ''
    while (i < src.length && !/[\s{}"]/.test(src[i])) out += src[i++]
    return { text: out }
  }
  const block = () => {
    const obj = {}
    for (;;) {
      const key = token()
      if (!key || key.brace === '}') return obj
      if (key.brace) continue
      const value = token()
      if (!value) return obj
      obj[key.text.toLowerCase()] = value.brace === '{' ? block() : (value.text ?? '')
    }
  }
  return block()
}

function steamRoots(extra) {
  const home = homedir()
  const list = [
    extra,
    process.env.STEAM_DIR,
    join(home, 'Library', 'Application Support', 'Steam'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Steam'),
    join(home, '.steam', 'steam'),
    join(home, '.local', 'share', 'Steam'),
    join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
  ]
  return list.filter((p) => p && existsSync(p))
}

const readVdf = async (path) => {
  try {
    return parseVdf(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

export async function importSteam({ dir = null } = {}) {
  const root = steamRoots(dir)[0]
  if (!root) throw new UserError('Steam som na tomto počítači nenašiel. Ak ho máš nainštalovaný inde, zadaj cestu: node scripts/import.mjs steam --dir "cesta k priečinku Steam".')

  // library folders: the main one plus the ones listed in libraryfolders.vdf
  const libs = new Set([join(root, 'steamapps')])
  for (const file of [join(root, 'steamapps', 'libraryfolders.vdf'), join(root, 'config', 'libraryfolders.vdf')]) {
    const data = await readVdf(file)
    const folders = data?.libraryfolders ?? data?.libraryfolder ?? {}
    for (const value of Object.values(folders)) {
      const path = typeof value === 'string' ? value : value?.path
      if (path && existsSync(join(path, 'steamapps'))) libs.add(join(path, 'steamapps'))
    }
  }

  const games = new Map()
  for (const lib of libs) {
    let files = []
    try {
      files = (await readdir(lib)).filter((f) => /^appmanifest_\d+\.acf$/i.test(f))
    } catch {
      continue
    }
    for (const f of files) {
      const app = (await readVdf(join(lib, f)))?.appstate
      if (!app?.appid || !app.name) continue
      // Steam's own runtime packages are not games
      if (/^(Steamworks Common Redistributables|Steam Linux Runtime|Proton|SteamVR)/i.test(app.name)) continue
      games.set(String(app.appid), { id: String(app.appid), name: app.name, minutes: 0, last: Number(app.lastplayed) || 0, installed: true, bytes: Number(app.sizeondisk) || 0 })
    }
  }

  let unnamedMinutes = 0
  let unnamed = 0
  let persona = null
  let users = []
  try {
    users = (await readdir(join(root, 'userdata'), { withFileTypes: true })).filter((d) => d.isDirectory() && /^\d+$/.test(d.name)).map((d) => d.name)
  } catch {
    // no user data: only installed games are known
  }
  for (const user of users) {
    const cfg = await readVdf(join(root, 'userdata', user, 'config', 'localconfig.vdf'))
    const store = cfg?.userlocalconfigstore
    persona = persona ?? store?.friends?.personaname ?? null
    const apps = store?.software?.valve?.steam?.apps ?? {}
    for (const [id, app] of Object.entries(apps)) {
      if (!app || typeof app !== 'object') continue
      const minutes = Number(app.playtime) || 0
      const last = Number(app.lastplayed) || 0
      const game = games.get(id)
      if (game) {
        game.minutes += minutes
        game.last = Math.max(game.last, last)
      } else if (minutes > 0) {
        unnamed++
        unnamedMinutes += minutes
      }
    }
  }
  if (!games.size && !unnamed) throw new UserError('V priečinku Steamu som nenašiel žiadne hry.')

  const list = [...games.values()].sort((a, b) => b.minutes - a.minutes || b.last - a.last)
  const totalMinutes = list.reduce((s, g) => s + g.minutes, 0)
  const hours = (min) => (min >= 600 || min === 0 ? fmtInt(min / 60) : (min / 60).toFixed(1).replace('.', ','))
  const lastDay = (sec) => (sec > 0 ? isoDay(new Date(sec * 1000)) : '')
  const lines = [
    '# Steam',
    '',
    'Hry zo Steamu na tomto počítači. Vzniklo z miestnych súborov Steamu, pri ďalšom načítaní sa prepíše.',
    '',
    `- Nainštalovaných hier: ${list.length}`,
    `- Nahraté spolu: ${hours(totalMinutes)} hodín`,
    ...(persona ? [`- Prezývka na Steame: ${persona}`] : []),
    ...(unnamed ? [`- Hry, ktoré už nie sú nainštalované: ${unnamed}, spolu ${hours(unnamedMinutes)} hodín (ich názvy Steam v počítači neuchováva)`] : []),
    '',
    '## Hry',
    '',
    '| Hra | Hodiny | Naposledy hrané |',
    '|---|---|---|',
    ...list.map((g) => `| ${g.name.replace(/\|/g, ' ')} | ${hours(g.minutes)} | ${lastDay(g.last)} |`),
  ]
  const rel = await writeGeneratedNote('hry/Steam.md', { zdroj: 'steam' }, lines.join('\n'))
  return {
    ok: true,
    source: 'steam',
    games: list.length,
    hours: Math.round(totalMinutes / 60),
    notes: [rel],
    path: join(MEMORY_DIR, rel),
    top: list.slice(0, 5).map((g) => ({ name: g.name, hours: Math.round(g.minutes / 6) / 10 })),
    summary: `Steam: ${plural(list.length, 'nainštalovaná hra', 'nainštalované hry', 'nainštalovaných hier')}, spolu ${hours(totalMinutes)} hodín.${list[0]?.minutes ? ` Najviac ${list.slice(0, 3).filter((g) => g.minutes).map((g) => g.name).join(', ')}.` : ''}`,
    warnings: unnamed ? [`Hry, ktoré už nie sú nainštalované (${unnamed}), sú v prehľade bez názvu. Steam si ich názvy v počítači neuchováva.`] : [],
  }
}
