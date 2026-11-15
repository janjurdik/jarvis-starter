/**
 * One shared walk of the home folder (depth 4). Several probes need the same facts (git repos,
 * folders full of notes, zip files, documents, folder names), so the disk is read only once.
 * Only names are collected here, never file contents.
 */
import { join, sep } from 'node:path'
import { IS_MAC, IS_WIN, REPO } from '../lib.mjs'
import { HOME, exists, extOf, isDenied, powershellJson, readText, skipDir, walk } from './util.mjs'

/** Document types worth listing by name. */
export const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'odt', 'rtf', 'pages', 'xls', 'xlsx', 'ods', 'numbers', 'csv', 'ppt', 'pptx', 'odp', 'key', 'txt', 'md', 'epub'])
/** File types that say what the person creates. */
export const PROJECT_EXT = {
  als: 'Ableton Live', flp: 'FL Studio', logicx: 'Logic Pro', band: 'GarageBand', ptx: 'Pro Tools', rpp: 'REAPER',
  prproj: 'Premiere Pro', aep: 'After Effects', drp: 'DaVinci Resolve', fcpbundle: 'Final Cut Pro', imovielibrary: 'iMovie',
  psd: 'Photoshop', ai: 'Illustrator', indd: 'InDesign', fig: 'Figma', sketch: 'Sketch', afphoto: 'Affinity', afdesign: 'Affinity', xcf: 'GIMP', kra: 'Krita',
  blend: 'Blender', f3d: 'Fusion', stl: '3D tlač', '3mf': '3D tlač', gcode: '3D tlač', skp: 'SketchUp', dwg: 'AutoCAD', c4d: 'Cinema 4D',
  tex: 'LaTeX', ipynb: 'Jupyter', unity: 'Unity', uproject: 'Unreal Engine', scriv: 'Scrivener',
}

const HOME_SKIP = new Set(
  IS_MAC
    ? ['Library', 'Applications', 'Public', 'Parallels', 'VirtualBox VMs', 'Virtual Machines.localized', 'miniconda3', 'anaconda3', 'miniforge3', 'opt', 'go']
    : ['AppData', 'Application Data', 'Local Settings', 'Cookies', 'NetHood', 'PrintHood', 'Recent', 'SendTo', 'Start Menu', 'Templates', 'My Documents', 'scoop', 'miniconda3', 'anaconda3', 'go', 'snap', 'VirtualBox VMs'],
)

let foldersMemo
/** The person's main folders. On Windows they may be redirected (OneDrive), on Linux localized. */
export function userFolders() {
  foldersMemo ??= (async () => {
    const out = {
      desktop: join(HOME, 'Desktop'),
      documents: join(HOME, 'Documents'),
      downloads: join(HOME, 'Downloads'),
      pictures: join(HOME, 'Pictures'),
      music: join(HOME, 'Music'),
      videos: join(HOME, IS_MAC ? 'Movies' : 'Videos'),
    }
    if (IS_WIN) {
      const res = await powershellJson(
        `$d = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders').'{374DE290-123F-4565-9164-39C4925E467B}'
[pscustomobject]@{ desktop=[Environment]::GetFolderPath('Desktop'); documents=[Environment]::GetFolderPath('MyDocuments'); pictures=[Environment]::GetFolderPath('MyPictures'); music=[Environment]::GetFolderPath('MyMusic'); videos=[Environment]::GetFolderPath('MyVideos'); downloads=[Environment]::ExpandEnvironmentVariables("$d") } | ConvertTo-Json -Compress`,
        12_000,
      )
      for (const key of Object.keys(out)) if (res?.[key] && exists(res[key])) out[key] = res[key]
    } else if (!IS_MAC) {
      const text = readText(join(HOME, '.config', 'user-dirs.dirs')) ?? ''
      const map = { desktop: 'DESKTOP', documents: 'DOCUMENTS', downloads: 'DOWNLOAD', pictures: 'PICTURES', music: 'MUSIC', videos: 'VIDEOS' }
      for (const [key, xdg] of Object.entries(map)) {
        const m = text.match(new RegExp(`XDG_${xdg}_DIR="([^"]+)"`))
        const path = m?.[1].replace('$HOME', HOME)
        if (path && exists(path)) out[key] = path
      }
    }
    return out
  })()
  return foldersMemo
}

/** True when `path` is `dir` or lies inside it. */
export const inside = (path, dir) => path === dir || path.startsWith(dir + sep)

/**
 * Walks the home folder once. Returns:
 *   dirs      Map path → { path, name, depth, parent, files, md, txt, notes (md in the whole subtree) }
 *   repos     [{ path, names }] git repositories (the walk stops there)
 *   zips      [{ path, name, depth }]
 *   docs      [{ path, name, ext }] documents by name (capped)
 *   special   [{ path, name, kind }] files that matter to a specific probe (calendar files, chat exports)
 *   projects  Map label → [paths] creative project files (Ableton, Blender, Photoshop…)
 *   denied    main folders macOS refused to open
 */
export async function buildIndex({ deadline = Infinity, deep = false } = {}) {
  const folders = await userFolders()
  const main = [folders.desktop, folders.documents, folders.downloads]
  const index = { folders, dirs: new Map(), repos: [], zips: [], docs: [], special: [], projects: new Map(), denied: [], truncated: false }
  // if the walk does not finish in time, the probes work with what was collected so far
  let timer
  const late = new Promise((done) => {
    timer = setTimeout(() => done('late'), Math.max(1000, deadline - Date.now() + 1500))
  })
  if ((await Promise.race([fill(index, main, deadline, deep), late])) === 'late') index.truncated = true
  clearTimeout(timer)
  countNotes(index)
  return index
}

async function fill(index, main, deadline, deep) {
  const folders = index.folders
  // folders that live outside the home folder (or deeper in it) still count as top level
  const extra = uniqPaths(Object.values(folders).filter((p) => exists(p) && join(p, '..') !== HOME))
  const roots = [{ path: HOME, depth: 0 }, ...extra.map((path) => ({ path, depth: 1 }))]
  const extraSet = new Set(extra)

  const res = await walk(roots, { maxDepth: 4, maxDirs: deep ? 80_000 : 30_000, deadline, conc: 24 }, (dir, entries, err) => {
    if (!entries) {
      if (isDenied(err) && main.includes(dir.path)) index.denied.push(dir.path)
      return null
    }
    const parent = join(dir.path, '..')
    const info = { path: dir.path, name: dir.path.slice(parent.length + 1) || dir.path, depth: dir.depth, parent, files: 0, md: 0, txt: 0, notes: 0, sub: 0 }
    index.dirs.set(dir.path, info)
    const isHome = dir.path === HOME
    if (!isHome && entries.some((e) => e.name === '.git')) {
      index.repos.push({ path: dir.path, names: entries.map((e) => e.name) })
      info.repo = true
      return null
    }
    const down = []
    for (const e of entries) {
      const name = e.name
      const ext = extOf(name)
      if (e.isDirectory()) {
        info.sub++
        if (PROJECT_EXT[ext]) addProject(index, PROJECT_EXT[ext], join(dir.path, name))
        if (isHome && HOME_SKIP.has(name)) continue
        if (skipDir(name)) continue
        const full = join(dir.path, name)
        if (full === REPO || extraSet.has(full)) continue
        down.push(name)
      } else if (e.isFile() && !name.startsWith('.')) {
        info.files++
        const full = join(dir.path, name)
        if (ext === 'md' || ext === 'markdown') info.md++
        else if (ext === 'txt') info.txt++
        if (ext === 'zip') index.zips.push({ path: full, name, depth: dir.depth + 1 })
        if (DOC_EXT.has(ext) && index.docs.length < 12_000) index.docs.push({ path: full, name, ext })
        if (PROJECT_EXT[ext]) addProject(index, PROJECT_EXT[ext], full)
        const kind = specialKind(name, ext)
        if (kind) index.special.push({ path: full, name, kind, depth: dir.depth + 1 })
      }
    }
    return entries.length > 5000 ? null : down
  })
  if (res.truncated) index.truncated = true
}

/** Notes in the whole subtree of every folder, deepest folders first. */
function countNotes(index) {
  const byDepth = [...index.dirs.values()].sort((a, b) => b.depth - a.depth)
  for (const d of byDepth) {
    d.notes += d.md
    const up = index.dirs.get(d.parent)
    if (up && !d.repo) up.notes += d.notes
  }
}

function addProject(index, label, path) {
  const list = index.projects.get(label) ?? []
  if (list.length < 200) list.push(path)
  index.projects.set(label, list)
}

function specialKind(name, ext) {
  if (ext === 'ics') return 'ics'
  if (ext === 'vcf') return 'vcf'
  if (name === 'result.json') return 'telegram'
  if (name === 'conversations.json') return 'conversations'
  if (name === 'export.xml') return 'health'
  if (name === '_chat.txt' || (ext === 'txt' && /whatsapp/i.test(name))) return 'whatsapp'
  if (ext === 'json' && /^(StreamingHistory|Streaming_History_Audio)/.test(name)) return 'spotify'
  return null
}

function uniqPaths(paths) {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length)
  return sorted.filter((p, i) => !sorted.slice(0, i).some((q) => inside(p, q)))
}
