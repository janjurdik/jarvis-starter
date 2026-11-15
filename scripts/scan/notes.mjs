/**
 * Probe "notes": where the person already writes things down. Obsidian vaults and plain folders
 * of markdown files can be read directly; other apps are reported with the way to get data out.
 */
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { IS_MAC, IS_WIN } from '../lib.mjs'
import { installedApps } from './apps.mjs'
import { inside } from './index.mjs'
import { APPDATA, HOME, MAC_SUPPORT, ago, appData, canSqlite, day, exists, extOf, guarded, isDenied, lstatOf, mapLimit, mb, names, readJson, sk, statOf, tilde, walk, withDbCopy } from './util.mjs'

const DAILY_RE = /^\d{4}-\d{2}-\d{2}$/

/** Counts notes in a vault or notes folder. Returns null when the folder cannot be opened. */
async function measureVault(root, deadline) {
  const top = new Map()
  const mdFiles = []
  let notes = 0
  let other = 0
  let daily = 0
  let denied = false
  let opened = false
  await walk(root, { maxDepth: 8, maxDirs: 6000, deadline }, (dir, entries, err) => {
    if (!entries) {
      if (dir.depth === 0) denied = isDenied(err)
      return null
    }
    opened = true
    const rel = dir.path.slice(root.length + 1)
    const first = rel ? rel.split(/[\\/]/)[0] : '(priamo v priečinku)'
    const down = []
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') down.push(e.name)
      } else if (e.isFile()) {
        const ext = extOf(e.name)
        if (ext === 'md' || ext === 'markdown') {
          notes++
          top.set(first, (top.get(first) ?? 0) + 1)
          if (DAILY_RE.test(e.name.slice(0, -ext.length - 1))) daily++
          if (mdFiles.length < 8000) mdFiles.push(join(dir.path, e.name))
        } else other++
      }
    }
    return down
  })
  if (!opened) return { denied }
  let newest = 0
  let recent = 0
  const monthAgo = Date.now() - 30 * 86_400_000
  await mapLimit(mdFiles, 32, async (file) => {
    try {
      const st = await stat(file)
      if (st.mtimeMs > newest) newest = st.mtimeMs
      if (st.mtimeMs > monthAgo) recent++
    } catch {
      // a note that vanished meanwhile
    }
  })
  const topFolders = [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, notes: count }))
  return { notes, other, daily, newest, recent, topFolders }
}

export async function notes(ctx) {
  const apps = await installedApps()
  const known = [] // folders already reported, so the generic folder search does not repeat them

  // ── Obsidian ──
  await ctx.step('obsidian', async () => {
    const config = readJson(join(appData({ mac: 'obsidian', win: 'obsidian', linux: 'obsidian' }), 'obsidian.json'))
    const vaults = Object.values(config?.vaults ?? {}).filter((v) => v?.path)
    vaults.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
    let n = 0
    for (const vault of vaults.slice(0, 12)) {
      const name = basename(vault.path)
      const gate = guarded(vault.path)
      if (gate && !ctx.allow.has(gate)) {
        ctx.finding({
          id: `notes.obsidian.vault${n++ ? `.${n}` : ''}`,
          category: 'notes',
          title: `Obsidian: ${name}`,
          detail: `Trezor ${name} je uložený v iCloude. Na jeho prečítanie treba tvoje povolenie.`,
          path: vault.path,
          data: { name, locked: gate },
          use: 'Po povolení si z poznámok načítam ľudí, projekty, ciele a denník.',
          action: 'ask',
          weight: 4,
        })
        ctx.permission(icloudPermission())
        continue
      }
      if (!exists(vault.path) && !lstatOf(vault.path)) continue
      const m = await measureVault(vault.path, ctx.deadline)
      if (!m.topFolders) {
        if (m.denied) ctx.folderDenied(vault.path)
        continue
      }
      known.push(vault.path)
      const dailyCfg = readJson(join(vault.path, '.obsidian', 'daily-notes.json'))
      const plugins = readJson(join(vault.path, '.obsidian', 'community-plugins.json'))
      const folders = m.topFolders.filter((f) => !f.name.startsWith('(')).slice(0, 4).map((f) => `${f.name} (${f.notes})`)
      ctx.finding({
        id: `notes.obsidian.vault${n++ ? `.${n}` : ''}`,
        category: 'notes',
        title: `Obsidian: ${name}`,
        detail:
          `${sk(m.notes, 'poznámka', 'poznámky', 'poznámok')}, posledná zmena ${ago(m.newest)}, za posledný mesiac sa ich zmenilo ${m.recent}.` +
          (folders.length ? ` Najviac ich je v priečinkoch ${folders.join(', ')}.` : '') +
          (m.daily ? ` Denných poznámok je ${m.daily}.` : ''),
        path: vault.path,
        data: { name, notes: m.notes, attachments: m.other, lastModified: day(m.newest), editedLast30Days: m.recent, topFolders: m.topFolders, dailyNotes: m.daily, dailyFolder: dailyCfg?.folder ?? null, plugins: Array.isArray(plugins) ? plugins.slice(0, 40) : [], open: vault.open === true },
        use: 'Toto je najlepší zdroj. Z poznámok si viem načítať ľudí, projekty, ciele a denník rovno do pamäte.',
        action: 'import-notes',
        weight: m.notes >= 20 ? 5 : 3,
      })
    }
  })

  // ── Logseq ──
  await ctx.step('logseq', async () => {
    const graphs = (await names(join(HOME, '.logseq', 'graphs'))).filter((n) => n.endsWith('.transit'))
    for (const file of graphs.slice(0, 6)) {
      const path = file.replace(/^logseq_local_/, '').replace(/\.transit$/, '').replace(/\+\+/g, '/').replace(/\+3A/g, ':')
      if (!exists(path) || (guarded(path) && !ctx.allow.has(guarded(path)))) continue
      const m = await measureVault(path, ctx.deadline)
      if (!m.topFolders) continue
      known.push(path)
      ctx.finding({
        id: 'notes.logseq.graph',
        category: 'notes',
        title: `Logseq: ${basename(path)}`,
        detail: `${sk(m.notes, 'stránka', 'stránky', 'stránok')}, posledná zmena ${ago(m.newest)}.`,
        path,
        data: { notes: m.notes, lastModified: day(m.newest), topFolders: m.topFolders },
        use: 'Stránky a denník z Logseq si viem načítať priamo do pamäte.',
        action: 'import-notes',
        weight: m.notes >= 20 ? 5 : 3,
      })
    }
  })

  // ── Joplin ──
  await ctx.step('joplin', async () => {
    const db = join(HOME, '.config', 'joplin-desktop', 'database.sqlite')
    const st = statOf(db)
    if (!st) return
    const data = { sizeMB: mb(st.size), lastModified: day(st.mtimeMs) }
    if (ctx.deep && (await canSqlite())) {
      await withDbCopy(db, async (query) => {
        data.notes = (await query('SELECT COUNT(*) AS c FROM notes'))[0]?.c ?? null
        data.notebooks = (await query('SELECT title FROM folders ORDER BY updated_time DESC LIMIT 40')).map((r) => r.title)
      })
    }
    ctx.finding({
      id: 'notes.joplin',
      category: 'notes',
      title: 'Joplin',
      detail: `Databáza poznámok Joplin má ${data.sizeMB} MB, posledná zmena ${ago(st.mtimeMs)}${data.notes != null ? `, ${sk(data.notes, 'poznámka', 'poznámky', 'poznámok')}` : ''}.`,
      path: db,
      data,
      use: 'V Jopline stačí zvoliť File → Export all → Markdown a celý priečinok si načítam.',
      action: 'ask',
      weight: 3,
    })
  })

  // ── apps that keep notes in their own storage ──
  await ctx.step('note-apps', async () => {
    const groupContainers = IS_MAC ? await names(join(HOME, 'Library', 'Group Containers')) : []
    if (apps.has('Bear') || groupContainers.some((n) => /shinyfrog\.bear/i.test(n))) {
      ctx.finding({
        id: 'notes.bear',
        category: 'notes',
        title: 'Bear',
        detail: 'Máš appku Bear. Poznámky si drží vo vlastnej databáze, ku ktorej sa bez teba nedostanem.',
        data: { app: 'Bear' },
        use: 'V Bear zvoľ File → Export Notes, formát Markdown, a priečinok mi ukáž. Načítam si ho celý.',
        action: 'ask',
        weight: 3,
      })
    }
    const notionDir = IS_MAC ? join(MAC_SUPPORT, 'Notion') : IS_WIN ? join(APPDATA, 'Notion') : null
    if (apps.has('Notion') || exists(notionDir)) {
      ctx.finding({
        id: 'notes.notion',
        category: 'notes',
        title: 'Notion',
        detail: `Máš appku Notion${exists(notionDir) ? ` (naposledy použitú ${ago(statOf(notionDir)?.mtimeMs)})` : ''}. Obsah je v cloude, nie v počítači.`,
        path: exists(notionDir) ? notionDir : null,
        data: { app: 'Notion' },
        use: 'Notion sa dá pripojiť ako konektor v nastaveniach Claude, alebo z neho stiahnuť export (Settings → Export all workspace content).',
        action: 'connect',
        weight: 3,
      })
    }
    if (IS_MAC) {
      const allowed = ctx.allow.has('applenotes')
      if (!allowed) {
        ctx.finding({
          id: 'notes.apple',
          category: 'notes',
          title: 'Apple Poznámky',
          detail: 'Appka Poznámky je na každom Macu. Či v nej niečo máš, zistím až s tvojím povolením.',
          data: { app: 'Notes', locked: 'applenotes' },
          use: 'Po povolení si prečítam názvy poznámok a priečinkov a poviem ti, čo z nich stojí za prenesenie.',
          action: 'ask',
          weight: 2,
        })
        ctx.permission({
          id: 'applenotes',
          title: 'Apple Poznámky',
          gives: 'Koľko poznámok máš v appke Poznámky, v akých priečinkoch a ako sa volajú (bez ich obsahu).',
          how: 'Spustím sken s --allow applenotes. macOS sa spýta, či smie Claude ovládať appku Poznámky. Stačí kliknúť Povoliť.',
        })
      }
    }
  })

  // ── plain folders full of markdown ──
  await ctx.step('folders', async () => {
    const index = await ctx.index()
    const kids = new Map()
    for (const d of index.dirs.values()) {
      const arr = kids.get(d.parent) ?? []
      arr.push(d)
      kids.set(d.parent, arr)
    }
    const generic = new Set([HOME, ...Object.values(index.folders)])
    const MIN = 25
    const pick = (dir) => {
      const below = (kids.get(dir.path) ?? []).filter((k) => k.notes >= MIN).sort((a, b) => b.notes - a.notes)
      if (generic.has(dir.path)) return below.flatMap(pick)
      if (below[0] && below[0].notes >= dir.notes * 0.8) return pick(below[0])
      return [dir]
    }
    const home = index.dirs.get(HOME)
    const starts = [home, ...[...index.dirs.values()].filter((d) => d.depth === 1 && d.parent !== HOME)].filter(Boolean)
    const picked = starts.flatMap(pick).filter((d) => !known.some((k) => inside(d.path, k) || inside(k, d.path)))
    picked.sort((a, b) => b.notes - a.notes)
    let n = 0
    for (const dir of picked.slice(0, 8)) {
      ctx.finding({
        id: `notes.folder${n++ ? `.${n}` : ''}`,
        category: 'notes',
        title: `Priečinok s poznámkami: ${dir.name}`,
        detail: `Priečinok ${tilde(dir.path)} obsahuje aspoň ${sk(dir.notes, 'textovú poznámku', 'textové poznámky', 'textových poznámok')} (.md).`,
        path: dir.path,
        data: { notes: dir.notes },
        use: 'Ak sú to tvoje zápisky, viem si ich prejsť a dôležité veci zapísať do pamäte.',
        action: 'import-notes',
        weight: dir.notes >= 100 ? 4 : 3,
      })
    }
  })
}

export const icloudPermission = () => ({
  id: 'icloud',
  title: 'Súbory v iCloud Drive',
  gives: 'Poznámky a dokumenty, ktoré máš uložené v iCloude (napríklad trezor Obsidianu zdieľaný s telefónom).',
  how: 'Spustím sken s --allow icloud. macOS sa môže spýtať, či smie Claude čítať súbory v iCloud Drive. Stačí kliknúť Povoliť.',
})
