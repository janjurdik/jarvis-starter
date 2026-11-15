/**
 * Probe "media": music (Spotify, Apple Music, local files), photos (the Photos library is only
 * noticed, never opened), videos, and creative project files that show what the person makes.
 */
import { join } from 'node:path'
import { IS_MAC, IS_WIN } from '../lib.mjs'
import { installedApps } from './apps.mjs'
import { APPDATA, HOME, LOCALAPPDATA, MAC_SUPPORT, ago, countFiles, day, exists, gb, list, lstatOf, names, readText, sk, some, statOf, tilde } from './util.mjs'

const AUDIO = new Set(['mp3', 'flac', 'm4a', 'wav', 'aiff', 'aif', 'ogg', 'opus', 'aac', 'wma', 'alac'])
const IMAGES = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'gif', 'webp', 'tif', 'tiff', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2'])
const VIDEO = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'mts', 'wmv'])

const FAMILIES = [
  { id: 'music.projects', category: 'music', title: 'Hudobné projekty', labels: ['Ableton Live', 'FL Studio', 'Logic Pro', 'GarageBand', 'Pro Tools', 'REAPER'], use: 'Vidím, že tvoríš hudbu. Môžem ti viesť zoznam skladieb, nápadov a rozrobených vecí.' },
  { id: 'media.video-projects', category: 'media', title: 'Video projekty', labels: ['Premiere Pro', 'After Effects', 'DaVinci Resolve', 'Final Cut Pro', 'iMovie'], use: 'Vidím, že striháš video. Môžem ti pomáhať so scenármi, plánom a zoznamom rozrobených videí.' },
  { id: 'media.design-files', category: 'media', title: 'Grafické súbory', labels: ['Photoshop', 'Illustrator', 'InDesign', 'Figma', 'Sketch', 'Affinity', 'GIMP', 'Krita'], use: 'Vidím, že robíš grafiku. Môžem ti viesť zákazky a podklady k návrhom.' },
  { id: 'media.3d-files', category: 'media', title: '3D modely a tlač', labels: ['Blender', 'Fusion', '3D tlač', 'SketchUp', 'AutoCAD', 'Cinema 4D'], use: 'Vidím, že modeluješ alebo tlačíš v 3D. Môžem ti viesť projekty a objednávky.' },
  { id: 'code.creative', category: 'code', title: 'Hry, výpočty a písanie', labels: ['Unity', 'Unreal Engine', 'Jupyter', 'LaTeX', 'Scrivener'], use: 'Vidím ďalšie veci, ktoré tvoríš. Poviem ti, ako ti s nimi viem pomôcť.' },
]

export async function media(ctx) {
  const apps = await installedApps()
  const index = await ctx.index()
  const f = index.folders

  // ── Spotify ──
  await ctx.step('spotify', async () => {
    const dirs = [
      IS_MAC ? join(MAC_SUPPORT, 'Spotify') : null,
      IS_WIN ? join(APPDATA, 'Spotify') : null,
      !IS_MAC && !IS_WIN ? join(HOME, '.config', 'spotify') : null,
      ...(IS_WIN ? (await names(join(LOCALAPPDATA, 'Packages'))).filter((n) => n.startsWith('SpotifyAB.SpotifyMusic')).map((n) => join(LOCALAPPDATA, 'Packages', n, 'LocalState', 'Spotify')) : []),
    ].filter((d) => exists(d))
    if (!dirs.length && !apps.has('Spotify')) return
    let username = null
    for (const dir of dirs) {
      const prefs = readText(join(dir, 'prefs'), 100_000) ?? ''
      username ??= prefs.match(/autologin\.canonical_username="([^"]+)"/)?.[1] ?? prefs.match(/autologin\.username="([^"]+)"/)?.[1] ?? null
      username ??= (await names(join(dir, 'Users'))).find((n) => n.endsWith('-user'))?.replace(/-user$/, '') ?? null
    }
    const used = Math.max(0, ...dirs.map((d) => statOf(d)?.mtimeMs ?? 0))
    ctx.finding({
      id: 'music.spotify',
      category: 'music',
      title: 'Spotify',
      detail: `Spotify máš v počítači${username ? `, prihlásený účet ${username}` : ''}${used ? `, naposledy použitý ${ago(used)}` : ''}.`,
      path: dirs[0] ?? null,
      data: { username, lastUsed: day(used) },
      use: 'Históriu počúvania si vieš vyžiadať na spotify.com/account/privacy. Z nej spoznám tvoj hudobný vkus a zvyky.',
      action: 'ask',
      weight: 3,
    })
  })

  // ── music library and local files ──
  await ctx.step('music', async () => {
    const top = await list(f.music)
    if (!top.ok) return
    const library = IS_MAC ? lstatOf(join(f.music, 'Music', 'Music Library.musiclibrary')) : statOf(join(f.music, 'iTunes', 'iTunes Library.itl'))
    const counted = await countFiles(f.music, { maxDepth: 6, maxDirs: 4000, maxStats: ctx.deep ? 30_000 : 0, deadline: ctx.deadline, wanted: AUDIO })
    if (counted.files < 30) return
    const folders = top.entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
    ctx.finding({
      id: 'music.library',
      category: 'music',
      title: 'Hudba v počítači',
      detail:
        `V priečinku ${tilde(f.music)} vidím ${sk(counted.files, 'skladbu', 'skladby', 'skladieb')}${counted.bytes ? ` (${gb(counted.bytes)} GB)` : ''}.` +
        (library ? ` Knižnica ${IS_MAC ? 'Apple Music' : 'iTunes'} bola naposledy zmenená ${ago(library.mtimeMs)}.` : '') +
        (folders.length ? ` Priečinky: ${some(folders, 8)}.` : ''),
      path: f.music,
      data: { tracks: counted.files, sizeGB: counted.bytes ? gb(counted.bytes) : null, folders: folders.slice(0, 60), appleMusicLibrary: Boolean(library), libraryModified: day(library?.mtimeMs) },
      use: 'Z názvov priečinkov a skladieb viem, čo počúvaš, aj keď nepoužívaš streamovanie.',
      action: 'read',
      weight: counted.files >= 200 ? 3 : 2,
    })
  })

  // ── photos ──
  await ctx.step('photos', async () => {
    const top = await list(f.pictures)
    if (!top.ok) return
    const libraries = top.entries.filter((e) => e.name.endsWith('.photoslibrary')).map((e) => join(f.pictures, e.name))
    if (libraries.length && !ctx.allow.has('photos')) {
      const st = lstatOf(libraries[0])
      ctx.finding({
        id: 'photos.library',
        category: 'photos',
        title: 'Knižnica Fotiek',
        detail: `Máš knižnicu appky Fotky (${tilde(libraries[0])}), naposledy zmenenú ${ago(st?.mtimeMs)}. Je chránená, takže som ju neotváral.`,
        path: libraries[0],
        data: { libraries, modified: day(st?.mtimeMs), locked: 'photos' },
        use: 'Po povolení zistím, koľko fotiek máš, z akých rokov, aké máš albumy a ktorí ľudia sú v nich pomenovaní.',
        action: 'ask',
        weight: 3,
      })
    }
    const counted = await countFiles(f.pictures, { maxDepth: 5, maxDirs: 3000, deadline: ctx.deadline, wanted: IMAGES })
    const folders = top.entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.endsWith('.photoslibrary')).map((e) => e.name)
    const cameras = [...index.dirs.values()].filter((d) => /^(DCIM|\d{3}(CANON|APPLE|ANDRO|MSDCF|NIKON|_PANA|GOPRO|MEDIA|OLYMP|_FUJI)|Camera Roll|Camera Uploads)$/i.test(d.name)).map((d) => d.path)
    if (counted.files >= 30 || cameras.length) {
      ctx.finding({
        id: 'photos.folders',
        category: 'photos',
        title: 'Obrázky v priečinkoch',
        detail:
          `V priečinku ${tilde(f.pictures)} vidím mimo knižnice ${sk(counted.files, 'obrázok', 'obrázky', 'obrázkov')}.` +
          (folders.length ? ` Priečinky: ${some(folders, 8)}.` : '') +
          (cameras.length ? ` Priečinky z fotoaparátu alebo telefónu: ${some(cameras.map(tilde), 3)}.` : ''),
        path: f.pictures,
        data: { images: counted.files, folders: folders.slice(0, 60), cameraFolders: cameras.slice(0, 20) },
        use: 'Názvy priečinkov s fotkami často hovoria o výletoch a udalostiach. Môžem z nich poskladať časovú os.',
        action: 'read',
        weight: 2,
      })
    }
  })

  // ── videos ──
  await ctx.step('videos', async () => {
    const top = await list(f.videos)
    if (!top.ok) return
    const counted = await countFiles(f.videos, { maxDepth: 4, maxDirs: 2000, maxStats: 4000, deadline: ctx.deadline, wanted: VIDEO })
    if (counted.files < 5) return
    const folders = top.entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
    ctx.finding({
      id: 'media.videos',
      category: 'media',
      title: 'Videá v počítači',
      detail: `V priečinku ${tilde(f.videos)} vidím ${sk(counted.files, 'video', 'videá', 'videí')} (${gb(counted.bytes)} GB), najnovšie ${ago(counted.newest)}.${folders.length ? ` Priečinky: ${some(folders, 8)}.` : ''}`,
      path: f.videos,
      data: { videos: counted.files, sizeGB: gb(counted.bytes), newest: day(counted.newest), folders: folders.slice(0, 60) },
      use: 'Vidím, že pracuješ s videom alebo si ho ukladáš. Podľa priečinkov viem, o aké projekty ide.',
      action: 'read',
      weight: 2,
    })
  })

  // ── what the person creates ──
  await ctx.step('creative', async () => {
    for (const family of FAMILIES) {
      const parts = family.labels.map((label) => ({ label, files: index.projects.get(label) ?? [] })).filter((p) => p.files.length)
      const total = parts.reduce((n, p) => n + p.files.length, 0)
      if (total < 2) continue
      ctx.finding({
        id: family.id,
        category: family.category,
        title: family.title,
        detail: `Našiel som ${sk(total, 'projektový súbor', 'projektové súbory', 'projektových súborov')}: ${parts.map((p) => `${p.label} (${p.files.length})`).join(', ')}.`,
        data: { byTool: parts.map((p) => ({ tool: p.label, count: p.files.length, examples: p.files.slice(0, 8).map(tilde) })) },
        use: family.use,
        action: 'ask',
        weight: total >= 10 ? 4 : 3,
      })
    }
  })
}
