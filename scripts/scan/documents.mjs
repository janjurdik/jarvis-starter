/**
 * Probe "documents": what lies on the Desktop, in Documents and in Downloads. Only file NAMES
 * are looked at. The one exception is a CV saved as plain text, where the first 2 KB are read.
 */
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { inside } from './index.mjs'
import { HOME, countFiles, day, extOf, gb, isOffline, list, mapLimit, plain, readHead, sk, some, tilde } from './util.mjs'

const TYPES = {
  dokumenty: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'pages', 'txt', 'md', 'epub'],
  tabuľky: ['xls', 'xlsx', 'csv', 'numbers', 'ods'],
  prezentácie: ['ppt', 'pptx', 'key', 'odp'],
  obrázky: ['jpg', 'jpeg', 'png', 'heic', 'gif', 'webp', 'svg', 'tif', 'tiff', 'bmp', 'raw', 'cr2', 'nef', 'arw', 'dng', 'psd', 'ai'],
  videá: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'],
  zvuk: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'aiff'],
  archívy: ['zip', 'rar', '7z', 'tar', 'gz'],
  inštalátory: ['dmg', 'pkg', 'exe', 'msi', 'apk', 'iso'],
  kód: ['js', 'ts', 'tsx', 'py', 'html', 'css', 'json', 'sh', 'sql', 'ipynb', 'java', 'c', 'cpp', 'swift', 'php'],
}
const TYPE_OF = new Map(Object.entries(TYPES).flatMap(([type, exts]) => exts.map((e) => [e, type])))
const typeOf = (name) => TYPE_OF.get(extOf(name)) ?? 'iné'

/** Name patterns (Slovak, Czech, English), matched without diacritics. */
const PATTERNS = [
  { id: 'cv', title: 'Životopis', re: /(^|[^a-z])(cv|resume|zivotopis|curriculum|lebenslauf|motivacny|cover.?letter)([^a-z]|$)/, weight: 4, action: 'import-file', use: 'Zo životopisu viem naraz zistiť tvoju školu, prácu a zručnosti. Stačí povedať a prečítam si ho.' },
  { id: 'school', title: 'Školské dokumenty', re: /diplom|vysvedc|rozvrh|maturit|bakalar|semest|seminar|thesis|syllab|zapoct|skusk|prednask|cvicen|zadani|referat|prihlask|studij|zaverecn/, weight: 3, action: 'ask', use: 'Vidím, že riešiš školu. Môžem ti strážiť termíny a pomáhať s učivom, keď mi povieš viac.' },
  { id: 'invoices', title: 'Faktúry a účtenky', re: /faktur|invoice|uctenk|receipt|blocek|vyuctovan|objednavk|dobropis/, weight: 2, action: 'ask', use: 'Vidím, že riešiš faktúry. Môžem ti strážiť splatnosti a pripravovať podklady.' },
  { id: 'contracts', title: 'Zmluvy', re: /zmluv|smlouv|contract|dohoda|agreement|(^|[^a-z])nda([^a-z]|$)/, weight: 2, action: 'ask', use: 'Viem, že máš uložené zmluvy. Keď budeš chcieť, pozriem sa do nich a zapíšem si dôležité termíny.' },
  { id: 'finance', title: 'Dane, výpisy a výplaty', re: /danov|priznanie|(^|[^a-z])tax([^ai]|$)|vypis|statement|vyplatn|payslip|rozpocet|budget/, weight: 2, action: 'ask', use: 'Viem, že si vedieš papiere k financiám. Môžem ti pripomínať daňové a iné termíny.' },
  { id: 'travel', title: 'Cestovanie', re: /letenk|boarding.?pass|palubn|rezervaci|booking|itinerar|vstupenk|(^|[^a-z])tickets?([^a-z]|$)/, weight: 2, action: 'ask', use: 'Vidím lístky a rezervácie. Z nich viem pridať cesty do kalendára.' },
]
const JUNK = /^(readme|license|licence|changelog|requirements|notes?|todo|untitled|robots|package|index)(\.|$)/i

export async function documents(ctx) {
  const index = await ctx.index()
  const f = index.folders
  const main = [
    { key: 'desktop', path: f.desktop, label: 'Plocha', where: 'Na ploche', use: 'Plocha ukazuje, čo máš práve rozrobené. Priečinky na nej bývajú tvoje aktuálne projekty.', weight: 3 },
    { key: 'documents', path: f.documents, label: 'Dokumenty', where: 'V Dokumentoch', use: 'V Dokumentoch býva to trvalé: škola, práca, papiere. Podľa priečinkov viem, čo ťa zamestnáva.', weight: 3 },
    { key: 'downloads', path: f.downloads, label: 'Stiahnuté', where: 'V Stiahnutých', use: 'V Stiahnutých hľadám hlavne exporty tvojich dát z iných služieb.', weight: 1 },
  ]

  for (const m of main) {
    await ctx.step(m.key, async () => {
      const top = await list(m.path)
      if (!top.ok) {
        if (top.denied) ctx.folderDenied(m.path)
        return
      }
      const folders = top.entries.filter((e) => e.isDirectory() && !/^[.$]|\.app$/.test(e.name)).map((e) => e.name)
      const files = top.entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name)
      const byType = {}
      for (const name of files) byType[typeOf(name)] = (byType[typeOf(name)] ?? 0) + 1
      const types = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t} (${n})`)
      const data = { folders: folders.slice(0, 80), folderCount: folders.length, fileCount: files.length, byType }
      if (ctx.deep) {
        const all = await countFiles(m.path, { maxDepth: 8, maxDirs: 12_000, maxStats: 40_000, deadline: ctx.deadline })
        const deepTypes = {}
        for (const [ext, n] of all.byExt) deepTypes[TYPE_OF.get(ext) ?? 'iné'] = (deepTypes[TYPE_OF.get(ext) ?? 'iné'] ?? 0) + n
        data.deep = { files: all.files, sizeGB: gb(all.bytes), sizedFiles: all.sized, byType: deepTypes, newest: day(all.newest), truncated: all.truncated }
      }
      ctx.finding({
        id: `documents.${m.key}`,
        category: 'documents',
        title: m.label,
        detail:
          `${m.where} vidím ${sk(folders.length, 'priečinok', 'priečinky', 'priečinkov')} a ${sk(files.length, 'súbor', 'súbory', 'súborov')}.` +
          (folders.length ? ` Priečinky: ${some(folders, 10)}.` : '') +
          (types.length ? ` Zo súborov je najviac: ${types.join(', ')}.` : '') +
          (data.deep ? ` Spolu aj s podpriečinkami ${sk(data.deep.files, 'súbor', 'súbory', 'súborov')}, ${data.deep.sizeGB} GB.` : ''),
        path: m.path,
        data,
        use: m.use,
        action: 'none',
        weight: m.weight,
      })
    })
  }

  await ctx.step('by-name', async () => {
    const roots = [f.desktop, f.documents, f.downloads]
    const docs = index.docs.filter((d) => roots.some((r) => inside(d.path, r)) || dirname(d.path) === HOME)
    const stamped = await mapLimit(docs.slice(0, 8000), 32, async (d) => {
      try {
        return { ...d, modified: (await stat(d.path)).mtimeMs }
      } catch {
        return null
      }
    })
    const all = stamped.filter(Boolean).sort((a, b) => b.modified - a.modified)
    const show = (d) => ({ name: d.name, folder: tilde(dirname(d.path)), path: d.path, modified: day(d.modified) })

    const recent = all.filter((d) => d.ext !== 'md' && d.ext !== 'txt' && d.ext !== 'csv' && !JUNK.test(d.name)).slice(0, 25)
    if (recent.length) {
      ctx.finding({
        id: 'documents.recent',
        category: 'documents',
        title: 'Posledné dokumenty',
        detail: `Naposledy upravené dokumenty: ${some(recent.map((d) => d.name), 6)}.`,
        data: { files: recent.map(show) },
        use: 'Podľa názvov vidím, čo sa u teba riešilo v posledných dňoch. Do obsahu sa pozriem, len keď mi povieš.',
        action: 'ask',
        weight: 3,
      })
    }

    for (const p of PATTERNS) {
      // notes are handled by the notes probe: only a CV may be a plain text file. Copies count once.
      const names = new Set()
      const hits = all.filter((d) => {
        const key = plain(d.name)
        if (!p.re.test(key) || JUNK.test(d.name) || names.has(key)) return false
        const isNote = d.ext === 'md' || d.ext === 'txt'
        if (isNote && (p.id !== 'cv' || (index.dirs.get(dirname(d.path))?.md ?? 0) >= 25)) return false
        names.add(key)
        return true
      })
      if (!hits.length) continue
      const data = { count: hits.length, files: hits.slice(0, 30).map(show) }
      if (p.id === 'cv') {
        const text = hits.find((d) => d.ext === 'txt' || d.ext === 'md')
        if (text && !isOffline(text.path)) data.preview = { path: text.path, text: readHead(text.path, 2048) }
      }
      ctx.finding({
        id: `documents.${p.id}`,
        category: p.id === 'school' ? 'school' : p.id === 'invoices' || p.id === 'contracts' ? 'work' : 'documents',
        title: p.title,
        detail: `${sk(hits.length, 'súbor', 'súbory', 'súborov')} podľa názvu, najnovšie: ${some(hits.map((d) => d.name), 4)}.`,
        path: p.id === 'cv' ? hits[0].path : null,
        data,
        use: p.use,
        action: p.action,
        weight: p.weight,
      })
    }
  })
}
