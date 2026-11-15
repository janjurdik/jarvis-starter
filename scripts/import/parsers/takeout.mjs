/**
 * Google Takeout. Only the YouTube watch history is imported (as an overview note in
 * memory/zdroje/), the other products are listed so the user knows what else is inside.
 *
 *   Takeout/YouTube and YouTube Music/history/watch-history.json
 *   [{ header: "YouTube", title: "Watched <video>", titleUrl, subtitles: [{ name: channel }], time }]
 *
 * Folder and file names follow the language of the Google account ("YouTube a YouTube Music",
 * "história pozerania.json"), so the file is recognised by its content.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeGeneratedNote } from '../notes.mjs'
import { ARCHIVE_DIR, UserError, day, fmtInt, oneLine, readJson, scanJsonArray, writeJson } from '../util.mjs'

const TAKEOUT_RE = /(?:^|\/)Takeout\/([^/]+)\//
const PREFIX = /^(?:Watched|Pozreté:|Pozreli ste video|Pozreli ste|Zhlédnuto:|Zhlédli jste video|Zhlédli jste|Sledované:|Angesehen:|Obejrzano:|Megtekintve:)\s+/i

/** The watch history file: { entry, format: 'json' | 'html' } or null. */
export async function findWatchHistory(src) {
  const inYoutube = src.entries.filter((e) => /youtube/i.test(e.name) && /\.(json|html)$/i.test(e.name) && e.name.split('/').length >= 3 && !/(search|hľad|hlad|hled|vyhľad|vyhlad|such|recherch|busq|comment|koment|playlist|zoznam|subscri|odber)/i.test(e.name.split('/').pop()))
  const single = src.entries.length === 1 && /\.json$/i.test(src.entries[0].name) ? [src.entries[0]] : []
  for (const e of [...inYoutube.filter((x) => /\.json$/i.test(x.name)), ...single]) {
    const head = await src.head(e.name, 8000).catch(() => '')
    if (/"titleUrl"\s*:/.test(head) && /youtube\.com\/watch/.test(head)) return { entry: e, format: 'json' }
  }
  const html = inYoutube.find((e) => /\.html$/i.test(e.name) && /(histor|verlauf|watch|pozeran|sledov)/i.test(e.name))
  return html ? { entry: html, format: 'html' } : null
}

export async function sniff(src) {
  const products = new Set()
  for (const e of src.entries) {
    const m = TAKEOUT_RE.exec(e.name)
    if (m) products.add(m[1])
  }
  const history = await findWatchHistory(src)
  if (!products.size && !history) return null
  return {
    source: 'takeout',
    confidence: products.size ? 0.95 : 0.85,
    details: { products: [...products].sort(), youtube: history ? { file: history.entry.name, format: history.format } : null, user: null },
  }
}

export async function run(ctx) {
  const { src, det } = ctx
  const products = det.details.products ?? []
  const history = det.details.youtube ? { entry: src.get(det.details.youtube.file), format: det.details.youtube.format } : await findWatchHistory(src)
  const others = products.filter((p) => !/youtube/i.test(p))
  if (others.length) ctx.warn(`V Takeoute sú aj ďalšie služby, ktoré zatiaľ nečítam: ${others.join(', ')}. Nechal som ich tak.`)
  if (!history) throw new UserError(`V tomto Takeoute som nenašiel históriu pozerania YouTube.${products.length ? ` Je v ňom: ${products.join(', ')}.` : ''} Pri vytváraní exportu zaškrtni „YouTube a YouTube Music".`)
  if (history.format === 'html') {
    throw new UserError('História YouTube je v tomto Takeoute vo formáte HTML a ten sa nedá načítať. Na takeout.google.com pri položke „YouTube a YouTube Music" klikni na „Viaceré formáty" a pri histórii zmeň HTML na JSON. Potom sem pretiahni nový súbor.')
  }

  const months = {}
  const recent = []
  let n = 0
  const size = history.entry.size || 1
  await scanJsonArray(src.stream(history.entry.name), (item) => {
    if (!item || typeof item !== 'object' || !item.time) return
    if ((item.details ?? []).some((d) => /ads/i.test(d?.name ?? ''))) return
    if (!/youtube\.com\/watch|youtu\.be\//.test(item.titleUrl ?? '')) return
    n++
    const key = String(item.time).slice(0, 7)
    const m = (months[key] ??= { n: 0, c: {} })
    m.n++
    const channel = item.subtitles?.[0]?.name ?? ''
    if (channel) m.c[channel] = (m.c[channel] ?? 0) + 1
    const title = String(item.title ?? '').replace(PREFIX, '')
    recent.push({ t: item.time, title, channel })
    if (recent.length > 400) {
      recent.sort((a, b) => (a.t < b.t ? 1 : -1))
      recent.length = 60
    }
    if (n % 2000 === 0) ctx.progress(Math.min(0.9, 0.05 + 0.85 * ((n * 450) / size)), `Čítam históriu YouTube (${fmtInt(n)} videí)`)
  })
  if (!n) throw new UserError('V histórii pozerania YouTube nie sú žiadne videá.')

  // merge with earlier imports: the fuller version of each month wins
  const dir = join(ARCHIVE_DIR, 'takeout')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'youtube.json')
  const old = await readJson(file, null)
  const merged = { ...(old?.months ?? {}) }
  for (const [key, m] of Object.entries(months)) {
    if (!merged[key] || m.n > merged[key].n) merged[key] = { n: m.n, c: Object.fromEntries(Object.entries(m.c).sort((a, b) => b[1] - a[1]).slice(0, 300)) }
  }
  const seen = new Set()
  const latest = [...recent, ...(old?.recent ?? [])]
    .sort((a, b) => (a.t < b.t ? 1 : -1))
    .filter((r) => !seen.has(`${r.t}|${r.title}`) && seen.add(`${r.t}|${r.title}`))
    .slice(0, 30)
  await writeJson(file, { updated: new Date().toISOString(), months: merged, recent: latest })

  const keys = Object.keys(merged).sort()
  const channels = {}
  const years = {}
  let total = 0
  for (const key of keys) {
    total += merged[key].n
    const y = (years[key.slice(0, 4)] ??= { n: 0, c: {} })
    y.n += merged[key].n
    for (const [name, c] of Object.entries(merged[key].c)) {
      channels[name] = (channels[name] ?? 0) + c
      y.c[name] = (y.c[name] ?? 0) + c
    }
  }
  const topChannels = Object.entries(channels).sort((a, b) => b[1] - a[1]).slice(0, 40)
  const lines = [
    '# YouTube história',
    '',
    'Prehľad toho, čo používateľ pozerá na YouTube. Vznikol z Google Takeout, pri ďalšom importe sa prepíše.',
    '',
    `- Spolu: ${fmtInt(total)} pozretých videí`,
    `- Obdobie: ${keys[0]} až ${keys[keys.length - 1]}`,
    `- Rôznych kanálov: ${fmtInt(Object.keys(channels).length)}`,
    '',
    '## Najsledovanejšie kanály',
    '',
    ...topChannels.map(([name, c], i) => `${i + 1}. ${name} · ${fmtInt(c)} videí`),
    '',
    '## Po rokoch',
    '',
    ...Object.keys(years).sort().reverse().map((y) => `- ${y}: ${fmtInt(years[y].n)} videí. Najviac ${Object.entries(years[y].c).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name).join(', ')}.`),
    '',
    '## Naposledy pozreté',
    '',
    ...latest.map((r) => `- ${day(r.t)} · ${oneLine(r.title, 110)}${r.channel ? ` (${r.channel})` : ''}`),
  ]
  ctx.note(await writeGeneratedNote('zdroje/YouTube história.md', { zdroj: 'youtube' }, lines.join('\n')))
  return {
    me: null,
    summary: `YouTube: ${fmtInt(total)} pozretých videí od ${keys[0]} do ${keys[keys.length - 1]}.${topChannels.length ? ` Najviac ${topChannels.slice(0, 3).map(([name]) => name).join(', ')}.` : ''}`,
    stats: { threads: 0, messages: n, from: `${keys[0]}-01T00:00:00.000Z`, to: `${keys[keys.length - 1]}-28T00:00:00.000Z` },
  }
}
