/**
 * Probe "exports": data exports the person already downloaded from other services (Instagram,
 * WhatsApp, ChatGPT, Google Takeout…). Detection reads file names and the file list of a zip,
 * never the content. It only tells the person what was found; reading the export is the agent's job.
 */
import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ago, countFiles, day, exists, isOffline, list, mapLimit, mb, plain, readHead, sizeText, sk, some, tilde, zipNames } from './util.mjs'

export const SOURCES = {
  instagram: { label: 'Instagram', gives: 'správy, ľudia, s ktorými si píšeš, príspevky a koho sleduješ' },
  facebook: { label: 'Facebook', gives: 'správy z Messengera, priatelia, príspevky a udalosti' },
  whatsapp: { label: 'WhatsApp', gives: 'celý rozhovor s jedným človekom alebo skupinou' },
  discord: { label: 'Discord', gives: 'správy zo serverov a súkromných rozhovorov' },
  telegram: { label: 'Telegram', gives: 'správy a kontakty z Telegramu' },
  chatgpt: { label: 'ChatGPT', gives: 'všetky rozhovory s ChatGPT, teda roky tvojich otázok, plánov a nápadov' },
  claude: { label: 'Claude', gives: 'staršie rozhovory s Claude' },
  spotify: { label: 'Spotify', gives: 'história počúvania: čo, kedy a ako často' },
  takeout: { label: 'Google', gives: 'dáta z Googlu: kalendár, kontakty, YouTube, mapy a fotky' },
  apple: { label: 'Apple', gives: 'dáta z Apple účtu: nákupy, hudba, poznámky' },
  health: { label: 'Apple Zdravie', gives: 'kroky, spánok, tréningy a tep z iPhonu a hodiniek' },
  unknown: { label: 'iná služba', gives: 'dáta z ďalšej služby' },
}

const has = (inner, re) => inner.some((n) => re.test(n))

/** Own heuristics: name of the file or folder plus the names inside it. Returns { source, confidence, note } or null. */
export function guessExport(name, inner = []) {
  const n = plain(name)
  if (has(inner, /(^|\/)your_instagram_activity\//i) || (has(inner, /(^|\/)personal_information\//i) && has(inner, /(^|\/)connections\/followers_and_following\//i))) return { source: 'instagram', confidence: 0.95 }
  if (has(inner, /(^|\/)(your_facebook_activity|your_activity_across_facebook)\//i)) return { source: 'facebook', confidence: 0.95 }
  if (has(inner, /^Takeout\//)) return { source: 'takeout', confidence: 0.95 }
  if (has(inner, /(^|\/)apple_health_export\/export\.xml$/i) || (n === 'apple_health_export' && has(inner, /export\.xml$/i))) return { source: 'health', confidence: 0.97 }
  if (has(inner, /(^|\/)messages\/index\.json$/i) && has(inner, /(^|\/)(account\/user\.json|servers\/index\.json)$/i)) return { source: 'discord', confidence: 0.95 }
  if (has(inner, /(^|\/)conversations\.json$/) && has(inner, /(^|\/)chat\.html$/)) return { source: 'chatgpt', confidence: 0.95 }
  if (has(inner, /(^|\/)conversations\.json$/) && has(inner, /(^|\/)users\.json$/)) return { source: 'claude', confidence: 0.95 }
  if (has(inner, /(Spotify Account Data|Spotify Extended Streaming History|Spotify Technical Log Information)\//i) || has(inner, /(^|\/)(StreamingHistory|Streaming_History_Audio)[^/]*\.json$/)) return { source: 'spotify', confidence: 0.95 }
  if (has(inner, /(^|\/)_chat\.txt$/) || has(inner, /WhatsApp Chat with .+\.txt$/i)) return { source: 'whatsapp', confidence: 0.95 }
  if (has(inner, /(^|\/)result\.json$/) && (/^(chatexport|dataexport)_/.test(n) || has(inner, /(^|\/)(chats|lists|profile_pictures)\//))) return { source: 'telegram', confidence: 0.9 }
  if (has(inner, /(^|\/)messages\d*\.html$/) && /^chatexport_/.test(n)) return { source: 'telegram', confidence: 0.9 }
  if (has(inner, /(^|\/)data\/(tweets|account)\.js$/)) return { source: 'unknown', confidence: 0.9, note: 'X (Twitter)' }
  if (has(inner, /(^|\/)(Connections|Profile|Positions)\.csv$/) && /linkedin/.test(n)) return { source: 'unknown', confidence: 0.9, note: 'LinkedIn' }
  if (has(inner, /(^|\/)DI_CONNECT\//)) return { source: 'unknown', confidence: 0.9, note: 'Garmin' }

  if (/^instagram-/.test(n)) return { source: 'instagram', confidence: 0.75 }
  if (/^facebook-/.test(n)) return { source: 'facebook', confidence: 0.75 }
  if (/^takeout-\d{8}t\d{6}z/.test(n)) return { source: 'takeout', confidence: 0.9 }
  if (/^my_spotify_data/.test(n)) return { source: 'spotify', confidence: 0.9 }
  if (/whatsapp/.test(n) && /(chat|cet|konverz)/.test(n)) return { source: 'whatsapp', confidence: 0.85 }
  if (/^(chatexport|dataexport)_\d{4}/.test(n)) return { source: 'telegram', confidence: 0.8 }
  if (/^data-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}/.test(n)) return { source: 'claude', confidence: 0.6 }
  if (/apple media services|app_store_itunes_store|apple id account and device|icloud (notes|contacts|calendars|bookmarks|drive|photos|mail)|apple\.com and apple store|apple ?music activity/.test(n)) return { source: 'apple', confidence: 0.85 }
  if (n === 'apple_health_export' || n === 'apple_health_export.zip') return { source: 'health', confidence: 0.9 }
  if (/^twitter-\d{4}-\d{2}-\d{2}/.test(n)) return { source: 'unknown', confidence: 0.8, note: 'X (Twitter)' }
  if (/linkedindataexport/.test(n)) return { source: 'unknown', confidence: 0.85, note: 'LinkedIn' }
  if (/^tiktok[_ -]?data/.test(n)) return { source: 'unknown', confidence: 0.8, note: 'TikTok' }
  if (/^mydata~\d+/.test(n)) return { source: 'unknown', confidence: 0.75, note: 'Snapchat' }
  if (/^netflix-report/.test(n)) return { source: 'unknown', confidence: 0.8, note: 'Netflix' }
  if (/^export-[0-9a-f]{8}-[0-9a-f]{4}-/.test(n)) return { source: 'unknown', confidence: 0.7, note: 'Notion' }
  if (/^meta-\d{4}/.test(n)) return { source: 'facebook', confidence: 0.5 }
  if (n === 'package.zip') return { source: 'discord', confidence: 0.4 }
  if (n === 'export.zip') return { source: 'health', confidence: 0.4 }
  return null
}

/** Names inside a folder, two levels deep, as relative paths (folders end with a slash). */
async function folderNames(dir) {
  const out = []
  const top = await list(dir)
  for (const e of top.entries.slice(0, 300)) out.push(e.isDirectory() ? `${e.name}/` : e.name)
  await mapLimit(top.entries.filter((e) => e.isDirectory()).slice(0, 30), 8, async (sub) => {
    for (const e of (await list(join(dir, sub.name))).entries.slice(0, 200)) out.push(`${sub.name}/${e.name}${e.isDirectory() ? '/' : ''}`)
  })
  return out
}

export async function exportsProbe(ctx) {
  const index = await ctx.index()
  const found = new Map()
  const add = async (path, kind, hit) => {
    if (!hit || hit.confidence < 0.5 || found.has(path)) return
    let sizeMB = null
    let modified = null
    try {
      const st = await stat(path)
      modified = st.mtimeMs
      if (kind === 'folder') {
        const size = await countFiles(path, { maxDepth: 6, maxDirs: 800, maxStats: 5000, deadline: ctx.deadline })
        sizeMB = mb(size.bytes)
        if (size.newest > modified) modified = size.newest
      } else sizeMB = mb(st.size)
    } catch {
      return
    }
    found.set(path, { path, source: hit.source, sizeMB, modified: day(modified), confidence: hit.confidence, kind, ...(hit.note ? { note: hit.note } : {}), modifiedMs: modified })
  }

  await ctx.step('zips', async () => {
    const zips = index.zips.filter((z) => z.depth <= 4).slice(0, 400)
    await mapLimit(zips, 8, async (z) => {
      // peeking into a zip costs a few kilobytes of reading, so every zip in reach gets a look
      // (unless it only lives in the cloud: then its name has to do)
      const inner = isOffline(z.path) ? [] : (zipNames(z.path) ?? [])
      await add(z.path, 'zip', guessExport(z.name, inner))
    })
  })

  await ctx.step('folders', async () => {
    const candidates = new Set()
    for (const d of index.dirs.values()) {
      if (d.depth > 4 || d.depth === 0) continue
      if (guessExport(d.name)) candidates.add(d.path)
    }
    for (const s of index.special) if (['telegram', 'conversations', 'health', 'spotify'].includes(s.kind) || s.name === '_chat.txt') candidates.add(dirname(s.path))
    const roots = new Set(Object.values(index.folders))
    await mapLimit([...candidates].filter((p) => !roots.has(p)).slice(0, 80), 6, async (path) => {
      const inner = await folderNames(path)
      const head = inner.includes('result.json') && !isOffline(join(path, 'result.json')) ? (readHead(join(path, 'result.json'), 400) ?? '') : ''
      const extra = /"(chats|personal_information|contacts|about)"/.test(head) ? ['chats/'] : []
      await add(path, 'folder', guessExport(basename(path), [...inner, ...extra]))
    })
  })

  await ctx.step('files', async () => {
    for (const s of index.special.filter((x) => x.kind === 'whatsapp' && x.name !== '_chat.txt').slice(0, 60)) {
      if ([...found.keys()].some((p) => s.path.startsWith(p))) continue
      await add(s.path, 'file', { source: 'whatsapp', confidence: /whatsapp chat|chat whatsapp/i.test(s.name) ? 0.9 : 0.6 })
    }
  })

  const all = [...found.values()].sort((a, b) => b.confidence - a.confidence || b.modifiedMs - a.modifiedMs)
  // an unpacked folder next to its zip is the same export: keep both paths, but say it once
  const bySource = new Map()
  for (const e of all) {
    const key = e.source === 'unknown' ? `unknown:${e.note ?? ''}` : e.source
    const arr = bySource.get(key) ?? []
    arr.push(e)
    bySource.set(key, arr)
  }
  for (const e of all) {
    const { modifiedMs, ...rest } = e
    ctx.export(rest)
  }
  for (const [key, items] of bySource) {
    const best = items[0]
    const meta = SOURCES[best.source]
    const label = best.note ?? meta.label
    ctx.finding({
      id: `exports.${key.replace(/^unknown:/, 'other.').replace(/[^a-z0-9.]+/gi, '-').toLowerCase()}`,
      category: 'exports',
      title: `Stiahnuté dáta: ${label}`,
      detail: `Našiel som ${sk(items.length, 'export', 'exporty', 'exportov')} (${label}): ${some(items.map((i) => `${basename(i.path)} (${i.sizeMB != null ? `${sizeText(i.sizeMB)}, ` : ''}${ago(i.modifiedMs)})`), 3)}.`,
      path: best.path,
      data: { source: best.source, label, items: items.map(({ modifiedMs, ...i }) => ({ ...i, shown: tilde(i.path) })) },
      use: `Čo v ňom je: ${meta.gives}. Viem ho načítať do pamäte, nič z neho neodíde z počítača.`,
      action: 'import-export',
      weight: best.confidence >= 0.8 ? 5 : 3,
    })
  }
}
