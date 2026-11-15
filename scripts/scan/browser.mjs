/**
 * Probe "browser": installed browsers, their profiles and bookmarks. With --deep also the most
 * visited sites of the last 90 days (domains only, read from a private copy of the history file).
 * Safari is guarded by macOS and only read with --allow safari.
 */
import { join } from 'node:path'
import { IS_MAC, IS_WIN } from '../lib.mjs'
import { installedApps } from './apps.mjs'
import { APPDATA, HOME, LOCALAPPDATA, MAC_SUPPORT, canSqlite, exists, isDenied, list, readJson, readPlist, readText, sk, some, statOf, uniq, withDbCopy } from './util.mjs'

/** Chromium-family browsers: [name, macOS folder, Windows folder (under %LOCALAPPDATA% unless roaming), Linux folder] */
const CHROMIUM = [
  ['Google Chrome', 'Google/Chrome', 'Google\\Chrome\\User Data', 'google-chrome'],
  ['Microsoft Edge', 'Microsoft Edge', 'Microsoft\\Edge\\User Data', 'microsoft-edge'],
  ['Brave', 'BraveSoftware/Brave-Browser', 'BraveSoftware\\Brave-Browser\\User Data', 'BraveSoftware/Brave-Browser'],
  ['Arc', 'Arc/User Data', null, null],
  ['Vivaldi', 'Vivaldi', 'Vivaldi\\User Data', 'vivaldi'],
  ['Opera', 'com.operasoftware.Opera', 'roaming:Opera Software\\Opera Stable', 'opera'],
  ['Opera GX', 'com.operasoftware.OperaGX', 'roaming:Opera Software\\Opera GX Stable', null],
  ['Chromium', 'Chromium', 'Chromium\\User Data', 'chromium'],
  ['Dia', 'Dia/User Data', null, null],
  ['Comet', 'Comet', 'Perplexity\\Comet\\User Data', null],
]

function chromiumRoot([, mac, win, linux]) {
  if (IS_MAC) return mac ? join(MAC_SUPPORT, mac) : null
  if (IS_WIN) return win ? (win.startsWith('roaming:') ? join(APPDATA, win.slice(8)) : join(LOCALAPPDATA, win)) : null
  return linux ? join(HOME, '.config', linux) : null
}

/** Flattens a Chromium bookmark tree into folders and links. */
export function readBookmarks(file) {
  const roots = readJson(file)?.roots
  if (!roots) return null
  const folders = []
  const links = []
  const bar = []
  const visit = (node, inBar, depth) => {
    if (!node) return
    if (node.type === 'url') {
      links.push(node)
      if (inBar && bar.length < 30) bar.push({ title: (node.name || '').slice(0, 80), host: hostOf(node.url) })
    } else if (Array.isArray(node.children)) {
      if (depth > 0 && node.name) folders.push(node.name)
      // bar items first, then what is inside its folders
      for (const child of node.children.filter((c) => c.type === 'url')) visit(child, inBar, depth + 1)
      for (const child of node.children.filter((c) => c.type !== 'url')) visit(child, inBar, depth + 1)
    }
  }
  visit(roots.bookmark_bar, true, 0)
  visit(roots.other, false, 0)
  visit(roots.synced, false, 0)
  const hosts = new Map()
  for (const l of links) {
    const h = hostOf(l.url)
    if (h) hosts.set(h, (hosts.get(h) ?? 0) + 1)
  }
  const topHosts = [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([host, count]) => ({ host, count }))
  return { count: links.length, folders: uniq(folders).slice(0, 60), bar, topHosts }
}

export function hostOf(url) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

const HOSTS_SQL = (table, where) => `
SELECT host, SUM(c) AS visits FROM (
  SELECT CASE WHEN instr(rest, '/') > 0 THEN substr(rest, 1, instr(rest, '/') - 1) ELSE rest END AS host, c FROM (
    SELECT substr(url, instr(url, '://') + 3) AS rest, c FROM (${table}) WHERE ${where}
  )
) GROUP BY host ORDER BY visits DESC LIMIT 120`

/** Visits per domain in the last 90 days from one history database (Chromium or Firefox). */
export async function topDomains(file, kind) {
  const since = Date.now() - 90 * 86_400_000
  const inner =
    kind === 'chromium'
      ? `SELECT u.url AS url, COUNT(*) AS c FROM visits v JOIN urls u ON u.id = v.url WHERE v.visit_time > ${(since + 11_644_473_600_000) * 1000} GROUP BY u.url`
      : `SELECT p.url AS url, COUNT(*) AS c FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id WHERE v.visit_date > ${since * 1000} GROUP BY p.url`
  return withDbCopy(file, async (query) => {
    const rows = await query(HOSTS_SQL(inner, "url LIKE 'http%'"))
    return rows.map((r) => ({ host: String(r.host ?? '').replace(/^[^@]*@/, '').replace(/:\d+$/, '').replace(/^www\./, ''), visits: Number(r.visits) || 0 }))
  })
}

export async function browser(ctx) {
  const apps = await installedApps()
  const found = []
  const history = [] // [file, kind]
  const blocked = [] // browsers whose data folder exists but may not be read

  await ctx.step('chromium', async () => {
    for (const def of CHROMIUM) {
      const root = chromiumRoot(def)
      if (!exists(root)) continue
      const top = await list(root)
      if (top.denied) {
        blocked.push(def[0])
        continue
      }
      const cache = readJson(join(root, 'Local State'))?.profile?.info_cache ?? {}
      const dirs = top.entries.map((e) => e.name).filter((n) => n === 'Default' || /^Profile \d+$/.test(n))
      // Opera keeps the single profile in the root folder
      const profileDirs = dirs.length ? dirs : exists(join(root, 'Bookmarks')) || exists(join(root, 'History')) ? [''] : []
      const profiles = []
      for (const dir of profileDirs.slice(0, 8)) {
        const base = join(root, dir)
        const info = cache[dir] ?? {}
        const marks = readBookmarks(join(base, 'Bookmarks'))
        const hist = join(base, 'History')
        profiles.push({
          name: info.name ?? (dir || 'hlavný'),
          account: info.user_name || null,
          person: info.gaia_name || null,
          bookmarks: marks?.count ?? 0,
          folders: marks?.folders ?? [],
          bar: marks?.bar ?? [],
          topHosts: marks?.topHosts ?? [],
          lastUsed: statOf(hist)?.mtimeMs ?? 0,
        })
        if (exists(hist)) history.push([hist, 'chromium'])
        ctx.identity({ emails: [info.user_name], nameHints: [info.gaia_name] })
      }
      if (profiles.length) found.push({ browser: def[0], path: root, profiles })
    }
  })

  await ctx.step('firefox', async () => {
    const root = IS_MAC ? join(MAC_SUPPORT, 'Firefox') : IS_WIN ? join(APPDATA, 'Mozilla', 'Firefox') : join(HOME, '.mozilla', 'firefox')
    const ini = readText(join(root, 'profiles.ini'), 100_000)
    if (!ini) return
    const profiles = []
    for (const block of ini.split(/^\[/m)) {
      const path = block.match(/^Path=(.+)$/m)?.[1]?.trim()
      if (!path) continue
      const base = /^IsRelative=0/m.test(block) ? path : join(root, path)
      const places = join(base, 'places.sqlite')
      if (!exists(places)) continue
      profiles.push({ name: block.match(/^Name=(.+)$/m)?.[1]?.trim() ?? 'profil', account: null, person: null, bookmarks: null, folders: [], bar: [], topHosts: [], lastUsed: statOf(places)?.mtimeMs ?? 0 })
      history.push([places, 'firefox'])
    }
    if (profiles.length) found.push({ browser: 'Firefox', path: root, profiles })
  })

  // ── Safari (guarded) ──
  if (IS_MAC) {
    await ctx.step('safari', async () => {
      if (!ctx.allow.has('safari')) {
        ctx.permission({
          id: 'safari',
          title: 'Safari',
          gives: 'Záložky zo Safari a s hlbším skenom aj stránky, na ktoré chodíš najčastejšie.',
          how: 'Safari chráni macOS. Treba v Nastaveniach systému → Súkromie a bezpečnosť → Plný prístup k disku zapnúť Claude (alebo Terminál) a spustiť sken s --allow safari.',
        })
        return
      }
      const plist = await readPlist(join(HOME, 'Library', 'Safari', 'Bookmarks.plist'), { allowGuarded: true })
      if (!plist) {
        ctx.permission({ id: 'safari', title: 'Safari', gives: 'Záložky zo Safari.', how: 'macOS prístup odmietol. Zapni Claude (alebo Terminál) v Nastaveniach systému → Súkromie a bezpečnosť → Plný prístup k disku a skús to znova.' })
        return
      }
      const folders = []
      const bar = []
      let count = 0
      const visit = (node, inBar) => {
        if (node?.URLString) {
          count++
          if (inBar && bar.length < 30) bar.push({ title: (node.URIDictionary?.title ?? '').slice(0, 80), host: hostOf(node.URLString) })
        }
        if (node?.Title && node.Children && !['BookmarksBar', 'BookmarksMenu', 'com.apple.ReadingList'].includes(node.Title)) folders.push(node.Title)
        for (const child of node?.Children ?? []) visit(child, inBar || node.Title === 'BookmarksBar')
      }
      visit(plist, false)
      found.push({ browser: 'Safari', path: join(HOME, 'Library', 'Safari'), profiles: [{ name: 'Safari', account: null, person: null, bookmarks: count, folders: uniq(folders).slice(0, 60), bar, topHosts: [], lastUsed: 0 }] })
      if (ctx.deep) history.push([join(HOME, 'Library', 'Safari', 'History.db'), 'safari'])
    })
  }

  // ── default browser (macOS) ──
  let preferred = null
  if (IS_MAC) {
    await ctx.step('default', async () => {
      const plist = await readPlist(join(HOME, 'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist'))
      const handler = (plist?.LSHandlers ?? []).find((h) => h?.LSHandlerURLScheme === 'https')?.LSHandlerRoleAll
      const map = { 'com.google.chrome': 'Google Chrome', 'com.apple.safari': 'Safari', 'org.mozilla.firefox': 'Firefox', 'com.microsoft.edgemac': 'Microsoft Edge', 'com.brave.browser': 'Brave', 'company.thebrowser.browser': 'Arc', 'com.vivaldi.vivaldi': 'Vivaldi', 'com.operasoftware.opera': 'Opera', 'company.thebrowser.dia': 'Dia' }
      preferred = handler ? (map[handler.toLowerCase()] ?? handler) : 'Safari'
    })
  }

  if (blocked.length) {
    ctx.permission({
      id: 'browser',
      title: `Záložky a profily prehliadača (${blocked.join(', ')})`,
      gives: 'Záložky, účty prihlásené v prehliadači a s hlbším skenom aj stránky, na ktoré chodíš najčastejšie.',
      how: 'Dáta prehliadača mi nedovolil prečítať program, v ktorom bežím (chráni ich). Pomôže spustiť sken priamo v Termináli: otvor Terminál v priečinku Jarvisa a napíš node scripts/scan.mjs. Výsledok si potom prečítam zo súboru.',
    })
  }
  if (!found.length && !blocked.length && !apps.has('Google Chrome', 'Firefox', 'Safari')) return
  found.sort((a, b) => Math.max(...b.profiles.map((p) => p.lastUsed)) - Math.max(...a.profiles.map((p) => p.lastUsed)))
  const totalBookmarks = found.reduce((n, b) => n + b.profiles.reduce((m, p) => m + (p.bookmarks ?? 0), 0), 0)
  const accounts = uniq(found.flatMap((b) => b.profiles.map((p) => p.account)))
  const main = found[0]
  const mainProfile = main?.profiles.slice().sort((a, b) => (b.bookmarks ?? 0) - (a.bookmarks ?? 0))[0]
  ctx.finding({
    id: 'browser.profiles',
    category: 'browser',
    title: 'Prehliadače a záložky',
    detail:
      (found.length ? `Prehliadače s tvojimi dátami: ${found.map((b) => `${b.browser} (${sk(b.profiles.length, 'profil', 'profily', 'profilov')})`).join(', ')}.` : 'Záložky sa mi zatiaľ nepodarilo prečítať.') +
      (blocked.length ? ` K dátam prehliadača ${blocked.join(', ')} ma nepustil program, v ktorom bežím.` : '') +
      (preferred ? ` Predvolený je ${preferred}.` : '') +
      (totalBookmarks ? ` Spolu ${sk(totalBookmarks, 'záložka', 'záložky', 'záložiek')}.` : '') +
      (mainProfile?.bar.length ? ` Na lište záložiek máš napríklad: ${some(uniq(mainProfile.bar.map((b) => b.title || b.host)), 8)}.` : '') +
      (accounts.length ? ` Prihlásené účty: ${some(accounts, 4)}.` : ''),
    path: main?.path ?? null,
    data: { defaultBrowser: preferred, blocked, browsers: found.map((b) => ({ ...b, profiles: b.profiles.map((p) => ({ ...p, lastUsed: p.lastUsed ? new Date(p.lastUsed).toISOString().slice(0, 10) : null })) })) },
    use: 'Záložky ukazujú stránky a nástroje, ktoré používaš každý deň. Viem z nich, s čím pracuješ a čo ťa zaujíma.',
    action: 'read',
    weight: totalBookmarks >= 20 ? 4 : 2,
  })

  // ── most visited sites (deep) ──
  if (!ctx.deep) return
  await ctx.step('history', async () => {
    if (!(await canSqlite())) return
    const totals = new Map()
    let read = 0
    for (const [file, kind] of history.slice(0, 10)) {
      try {
        const rows = kind === 'safari' ? await safariDomains(file) : await topDomains(file, kind)
        read++
        for (const r of rows) if (r.host && !/^(localhost|127\.|192\.168\.|10\.)/.test(r.host) && r.host.includes('.')) totals.set(r.host, (totals.get(r.host) ?? 0) + r.visits)
      } catch (err) {
        if (!isDenied(err)) throw err
      }
    }
    const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([host, visits]) => ({ host, visits }))
    if (!top.length) return
    ctx.finding({
      id: 'browser.history',
      category: 'browser',
      title: 'Najnavštevovanejšie stránky',
      detail: `Za posledných 90 dní chodíš najviac na: ${some(top.map((t) => t.host), 12)}.`,
      data: { days: 90, profilesRead: read, domains: top },
      use: 'Podľa toho viem, ktoré služby naozaj používaš (kde máš mail, kalendár, školu, prácu, zábavu), a ponúknem ti ich pripojenie.',
      action: 'none',
      weight: 4,
    })
  })
}

/** Safari history (needs Full Disk Access): visits per domain in the last 90 days. */
async function safariDomains(file) {
  // Safari counts seconds from 2001-01-01
  const since = (Date.now() - 90 * 86_400_000) / 1000 - 978_307_200
  return withDbCopy(file, async (query) => {
    const rows = await query(HOSTS_SQL(`SELECT i.url AS url, COUNT(*) AS c FROM history_visits v JOIN history_items i ON i.id = v.history_item WHERE v.visit_time > ${since} GROUP BY i.url`, "url LIKE 'http%'"))
    return rows.map((r) => ({ host: String(r.host ?? '').replace(/:\d+$/, '').replace(/^www\./, ''), visits: Number(r.visits) || 0 }))
  })
}
