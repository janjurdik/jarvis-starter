/**
 * Probe "apps": every installed app, mapped through the catalog into a handful of groups
 * (notes, AI, code, design…) so the report says what the person does, not 300 app names.
 */
import { join } from 'node:path'
import { IS_MAC, IS_WIN, sh } from '../lib.mjs'
import { GROUPS, matchApp, normApp } from './catalog.mjs'
import { APPDATA, HOME, PROGRAMDATA, ago, list, mapLimit, powershellJson, readText, sk, some, walk } from './util.mjs'

let memo
/** Installed apps: { list: [{ name, path, lastUsed, app }], has(catalogName) }. Shared by several probes. */
export function installedApps() {
  memo ??= (IS_MAC ? macApps() : IS_WIN ? winApps() : linuxApps()).then((found) => {
    const seen = new Map()
    for (const item of found) {
      const key = normApp(item.name)
      if (!key || seen.has(key)) continue
      seen.set(key, { ...item, app: matchApp(item.name) })
    }
    const all = [...seen.values()]
    const known = new Set(all.filter((a) => a.app).map((a) => a.app.name))
    return { list: all, has: (...catalogNames) => catalogNames.some((n) => known.has(n)) }
  })
  return memo
}

async function macApps() {
  const roots = ['/Applications', join(HOME, 'Applications')]
  const found = []
  for (const root of roots) {
    const top = await list(root)
    const folders = []
    for (const e of top.entries) {
      if (e.name.endsWith('.app')) found.push({ name: e.name.slice(0, -4), path: join(root, e.name) })
      else if (e.isDirectory() && !e.name.startsWith('.')) folders.push(join(root, e.name))
    }
    // one level of sub-folders: Adobe, Setapp, Utilities, Chrome Apps…
    await mapLimit(folders, 8, async (dir) => {
      for (const e of (await list(dir)).entries) if (e.name.endsWith('.app')) found.push({ name: e.name.slice(0, -4), path: join(dir, e.name) })
    })
  }
  // Spotlight knows when each app was opened last: one call for all of them
  const res = await sh('/usr/bin/mdls', ['-name', 'kMDItemLastUsedDate', ...found.map((a) => a.path)], { timeout: 15_000 })
  const lines = res.out.split('\n').filter((l) => l.startsWith('kMDItemLastUsedDate'))
  if (lines.length === found.length) {
    lines.forEach((line, i) => {
      const m = line.match(/= (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \+0000/)
      found[i].lastUsed = m ? Date.parse(`${m[1]}T${m[2]}Z`) : null
    })
  }
  return found
}

async function winApps() {
  const found = []
  const junk = /uninstall|odinstal|odinštal|readme|help|license|licen|website|documentation|manual|release notes|what's new|change ?log|repair|configur|setup|update|feedback|command prompt|powershell/i
  for (const root of [join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), join(PROGRAMDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')]) {
    await walk(root, { maxDepth: 3, maxDirs: 600 }, (dir, entries) => {
      if (!entries) return null
      for (const e of entries) {
        if (e.isFile() && /\.(lnk|appref-ms)$/i.test(e.name) && !junk.test(e.name)) found.push({ name: e.name.replace(/\.(lnk|appref-ms)$/i, ''), path: join(dir.path, e.name) })
      }
      return entries.filter((e) => e.isDirectory() && !/^(Startup|Windows |Accessibility|Accessories|Administrative Tools|System Tools|Maintenance)/i.test(e.name)).map((e) => e.name)
    })
  }
  const res = await powershellJson(
    `$keys = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
$reg = @(Get-ItemProperty $keys | Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName } | ForEach-Object { $_.DisplayName })
$store = @(Get-AppxPackage | Where-Object { -not $_.IsFramework -and $_.SignatureKind -ne 'System' } | ForEach-Object { $_.Name })
[pscustomobject]@{ reg = $reg; store = $store } | ConvertTo-Json -Compress`,
    25_000,
  )
  // registry names repeat the Start menu; they only add apps the catalog knows
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : [])
  for (const name of arr(res?.reg)) if (matchApp(name)) found.push({ name, path: null })
  for (const pkg of arr(res?.store)) {
    const short = String(pkg).split('.').pop()
    if (matchApp(short)) found.push({ name: matchApp(short).name, path: null })
  }
  return found
}

async function linuxApps() {
  const found = []
  const dirs = ['/usr/share/applications', join(HOME, '.local', 'share', 'applications'), '/var/lib/flatpak/exports/share/applications', join(HOME, '.local', 'share', 'flatpak', 'exports', 'share', 'applications'), '/var/lib/snapd/desktop/applications']
  for (const dir of dirs) {
    for (const e of (await list(dir)).entries.slice(0, 400)) {
      if (!e.name.endsWith('.desktop')) continue
      const text = readText(join(dir, e.name), 20_000) ?? ''
      if (/^NoDisplay=true/m.test(text)) continue
      const name = text.match(/^Name=(.+)$/m)?.[1]
      if (name) found.push({ name, path: join(dir, e.name) })
    }
  }
  return found
}

export async function apps(ctx) {
  const { list: all } = await installedApps()
  const groups = new Map()
  const other = []
  for (const item of all) {
    if (!item.app) {
      other.push(item)
      continue
    }
    const bucket = groups.get(item.app.group) ?? []
    bucket.push(item)
    groups.set(item.app.group, bucket)
  }
  const recentLimit = Date.now() - 30 * 86_400_000
  // macOS knows when an app was opened last. Where that is known, a never opened app (many come
  // preinstalled) says nothing about the person.
  const usageKnown = all.some((a) => a.lastUsed)
  for (const [group, items] of groups) {
    const meta = GROUPS[group]
    items.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || a.app.name.localeCompare(b.app.name))
    const labels = [...new Set(items.map((i) => i.app.name))]
    const recent = [...new Set(items.filter((i) => i.lastUsed > recentLimit).map((i) => i.app.name))]
    const opened = items.some((i) => i.lastUsed)
    let detail = `Máš ${some(labels, 8)}.`
    if (recent.length) detail += ` Za posledný mesiac boli otvorené: ${some(recent, 6)}.`
    else if (usageKnown && !opened) detail = `Nainštalované, ale zatiaľ neotvorené: ${some(labels, 8)}.`
    else if (usageKnown) detail += ' Za posledný mesiac nebola otvorená žiadna z nich.'
    ctx.finding({
      id: `apps.${group}`,
      category: meta.category,
      title: meta.title,
      detail,
      data: { apps: items.map((i) => ({ name: i.app.name, what: i.app.use, lastUsed: i.lastUsed ? new Date(i.lastUsed).toISOString() : null })) },
      use: meta.use,
      action: 'none',
      weight: usageKnown && !opened ? 1 : Math.max(1, meta.weight - (usageKnown && !recent.length ? 1 : 0)),
    })
  }

  const used = all.filter((a) => a.lastUsed).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 15)
  if (used.length) {
    ctx.finding({
      id: 'apps.recent',
      category: 'apps',
      title: 'Naposledy používané appky',
      detail: `Naposledy otvorené: ${some(used.map((a) => a.app?.name ?? a.name), 10)}.`,
      data: { apps: used.map((a) => ({ name: a.app?.name ?? a.name, lastUsed: new Date(a.lastUsed).toISOString(), ago: ago(a.lastUsed) })) },
      use: 'Podľa toho vidím, čím naozaj tráviš čas pri počítači.',
      action: 'none',
      weight: 3,
    })
  }
  if (other.length) {
    other.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))
    ctx.finding({
      id: 'apps.other',
      category: 'apps',
      title: 'Ďalšie nainštalované appky',
      detail: `${sk(other.length, 'ďalšia appka', 'ďalšie appky', 'ďalších appiek')}, ktoré nemám v zozname známych: ${some(other.map((a) => a.name), 12)}.`,
      data: { apps: other.slice(0, 120).map((a) => a.name), total: all.length },
      use: 'Ak je medzi nimi niečo dôležité pre tvoju prácu, povedz mi a zapamätám si to.',
      action: 'none',
      weight: 1,
    })
  }
}
