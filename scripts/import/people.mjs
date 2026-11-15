/**
 * People in the imported conversations.
 *
 *   buildCandidates()   who the user talks to, merged across sources, with a suggestion which
 *                       existing person note it could be. Nothing is written to the notes.
 *   applyDecisions()    the user's answers: create a person note, attach to an existing one, or skip.
 *                       Updates memory/ludia/, archiv/identity.json and writes a digest per person.
 *   refreshLinked()     after a new import: people that are already linked get fresh numbers.
 *
 * Nothing here invents facts: a person note only gets counts and date ranges. What the
 * conversations say about the person is left to a later Claude job that reads the digests.
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, open, readFile, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { FOLDERS, parseFrontmatter, slugify } from '../../hud/server/memory/index.mjs'
import { writeFileAtomic } from '../../hud/server/util.mjs'
import { cutSection, joinNote, setFrontmatter, splitNote } from './notes.mjs'
import { CANDIDATES_FILE, SKIP, archivedSources, loadIdentity, loadThreads, readThread, saveIdentity } from './store.mjs'
import { ARCHIVE_DIR, DIGEST_DIR, MEMORY_DIR, SOURCE_NAME, UserError, day, fmtInt, fold, localStamp, nameTokens, normName, oneLine, plural, readJson, safeFileName, writeJson } from './util.mjs'

const PEOPLE_DIR = join(MEMORY_DIR, FOLDERS.people)
const MIN_MESSAGES = 15
const MIN_GROUP_MESSAGES = 50
const DIGEST_CHARS = 30_000

const FAMILY = /^(mama|mamka|mamina|mami|maminka|mamicka|otec|oco|ocko|ocino|tato|tatko|tata|babka|babicka|dedo|dedko|starka|stary otec|stara mama|sestra|sestricka|brat|bracek|teta|ujo|krstna|krstny|krstna mama|krstny otec|svokra|svokor|mom|mum|dad|grandma|grandpa)$/
const PARTNER = /^(laska|laska moja|moja laska|milacik|manzel|manzelka|zenicka|muzicek|wife|husband|my love)$/

const idKey = (source, name) => `${source}:${name}`
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\u20e3]/gu
const TYPE_LABEL = { photo: '[fotka]', video: '[video]', audio: '[hlasová správa]', sticker: '[nálepka]', call: '[hovor]', share: '[odkaz]' }
const shown = (m, max = 160) => oneLine(m.text || TYPE_LABEL[m.type] || '', max)

/** Surname without the endings that differ between men and women of one family. */
function surnameStem(name) {
  const tokens = nameTokens(name)
  if (tokens.length < 2) return null
  let s = tokens[tokens.length - 1]
  if (s.length > 5 && s.endsWith('ova')) s = s.slice(0, -3)
  s = s.replace(/[aeiouy]$/, '')
  return s.length >= 4 ? s : null
}

/** Same person under two spellings? Careful on purpose: a wrong merge is worse than a missed one. */
function nameKeys(name) {
  // like nameTokens, but a number standing alone stays ("Peter 2" is not "Peter"), while digits
  // glued to a handle go away ("jana.novakova99")
  const tokens = fold(String(name ?? '').replace(EMOJI, ' '))
    .replace(/#\d{1,4}\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .map((t) => (/^\d+$/.test(t) ? t : t.replace(/\d+/g, '')))
    .filter(Boolean)
  if (tokens.length >= 2) return { own: [`set:${[...tokens].sort().join(' ')}`, `join:${tokens.join('')}`, `join:${[...tokens].reverse().join('')}`], lookup: [] }
  // a single word is only matched as a handle ("jankonovak") against a full name, never against
  // another single word: two people called Katarína are two people
  return { own: [], lookup: tokens.length && tokens[0].length >= 8 ? [`join:${tokens[0]}`] : [] }
}

async function peopleNotes() {
  let files = []
  try {
    files = (await readdir(PEOPLE_DIR)).filter((f) => f.toLowerCase().endsWith('.md'))
  } catch {
    return []
  }
  const out = []
  for (const f of files) {
    let text = ''
    try {
      text = await readFile(join(PEOPLE_DIR, f), 'utf8')
    } catch {
      continue
    }
    const { fm } = parseFrontmatter(text)
    const zdroje = Array.isArray(fm.zdroje) ? fm.zdroje : typeof fm.zdroje === 'string' && fm.zdroje ? [fm.zdroje] : []
    const title = f.slice(0, -3)
    out.push({ title, tokens: nameTokens(title), zdroje, vztah: typeof fm.vztah === 'string' ? fm.vztah : null })
  }
  return out
}

function suggestFor(names, keys, notes) {
  const cleanKey = (k) => normName(k.replace(/^[a-z]+:/, '')) + k.slice(0, k.indexOf(':'))
  for (const n of notes) {
    if (n.zdroje.some((z) => keys.some((k) => z.includes(':') && cleanKey(z) === cleanKey(k)))) return { note: n.title, score: 1, reason: 'Táto poznámka už má tento účet medzi zdrojmi.' }
  }
  let best = { note: null, score: 0, reason: 'V pamäti som nenašiel nikoho s podobným menom.' }
  const offer = (note, score, reason) => {
    if (score > best.score) best = { note, score, reason }
  }
  for (const name of names) {
    const t = nameTokens(name)
    if (!t.length) continue
    for (const n of notes) {
      const nt = n.tokens
      if (!nt.length) continue
      if (t.join(' ') === nt.join(' ')) offer(n.title, 0.98, 'Rovnaké meno.')
      else if (t.length >= 2 && [...t].sort().join(' ') === [...nt].sort().join(' ')) offer(n.title, 0.95, 'Rovnaké meno v inom poradí.')
      else if (t.length === 1 && nt.length >= 2 && t[0].length >= 8 && (t[0] === nt.join('') || t[0] === [...nt].reverse().join(''))) offer(n.title, 0.85, 'Prezývka zodpovedá menu a priezvisku.')
      else if (t.length >= 2 && nt.length >= 2 && t.filter((x) => nt.includes(x)).length >= 2) offer(n.title, 0.8, 'Meno a priezvisko sa zhodujú.')
      else if (t.length === 2 && nt.length >= 2 && t[0] === nt[0] && t[1].length <= 2 && nt[nt.length - 1].startsWith(t[1])) offer(n.title, 0.75, 'Krstné meno a začiatok priezviska sedia.')
      else if (t.length >= 2 && nt.length === 1 && t[0] === nt[0] && t[0].length >= 3) offer(n.title, 0.55, 'V pamäti je človek s rovnakým krstným menom.')
      else if (t.length === 1 && t[0] === nt[0] && t[0].length >= 3) {
        const same = notes.filter((x) => x.tokens[0] === t[0]).length
        offer(n.title, same === 1 ? 0.6 : 0.3, same === 1 ? 'Rovnaké krstné meno, jediný taký človek v pamäti.' : 'Rovnaké krstné meno má v pamäti viac ľudí.')
      }
    }
  }
  return best.score >= 0.5 ? best : { note: null, score: 0, reason: best.score > 0 ? best.reason : 'V pamäti som nenašiel nikoho s podobným menom.' }
}

function kindGuess(names, meNames) {
  for (const name of names) {
    const n = normName(name)
    if (FAMILY.test(n)) return 'rodina'
    if (PARTNER.test(n)) return 'partner'
  }
  const mine = new Set(meNames.map(surnameStem).filter(Boolean))
  if (mine.size && names.some((name) => mine.has(surnameStem(name)))) return 'rodina'
  return null
}

/** Last lines of a thread file without reading all of it. */
async function tail(file, bytes = 48_000) {
  let fh
  try {
    fh = await open(file, 'r')
    const { size } = await fh.stat()
    const len = Math.min(size, bytes)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    if (len < size) lines.shift()
    return lines.map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    }).filter(Boolean)
  } catch {
    return []
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** Every identity (one name in one source) with its private chats and shared groups. */
async function collectIdentities(identity) {
  const me = new Set(identity.me.map(normName).filter(Boolean))
  const ids = new Map()
  const get = (source, name) => {
    const key = idKey(source, name)
    if (!ids.has(key)) ids.set(key, { key, source, name, threads: [], messages: 0, mine: 0, theirs: 0, first: null, last: null, groups: [], groupMessages: 0 })
    return ids.get(key)
  }
  const span = (o, first, last) => {
    if (first && (!o.first || first < o.first)) o.first = first
    if (last && (!o.last || last > o.last)) o.last = last
  }
  for (const source of await archivedSources()) {
    for (const t of await loadThreads(source)) {
      if (t.kind === 'dm') {
        const others = t.participants.filter((p) => p !== t.self && !me.has(normName(p)))
        const other = others.length === 1 ? others[0] : (others.find((p) => normName(p) === normName(t.title)) ?? null)
        if (!other) continue
        const o = get(source, other)
        o.threads.push(t)
        o.messages += t.count
        o.mine += t.mine
        o.theirs += t.by?.[other] ?? t.count - t.mine
        span(o, t.first, t.last)
      } else if (t.kind === 'group') {
        for (const p of t.participants) {
          if (p === t.self || me.has(normName(p))) continue
          const o = get(source, p)
          o.groups.push(t)
          o.groupMessages += t.by?.[p] ?? 0
        }
      }
    }
  }
  return ids
}

/**
 * People candidates, biggest first. Returns the shape of `import.mjs people --json`.
 * The full list (with small ones) is cached in archiv/candidates.json for `apply`.
 */
export async function buildCandidates({ all = false } = {}) {
  const identity = await loadIdentity()
  const ids = await collectIdentities(identity)
  const notes = await peopleNotes()

  // union of identities that look like the same person
  const list = [...ids.values()]
  const parent = new Map(list.map((o) => [o.key, o.key]))
  const find = (k) => {
    while (parent.get(k) !== k) {
      parent.set(k, parent.get(parent.get(k)))
      k = parent.get(k)
    }
    return k
  }
  const byName = new Map()
  for (const o of list) {
    for (const nk of nameKeys(o.name).own) {
      if (byName.has(nk)) parent.set(find(o.key), find(byName.get(nk)))
      else byName.set(nk, o.key)
    }
  }
  for (const o of list) {
    for (const nk of nameKeys(o.name).lookup) if (byName.has(nk)) parent.set(find(o.key), find(byName.get(nk)))
  }
  const clusters = new Map()
  for (const o of list) {
    const root = find(o.key)
    if (!clusters.has(root)) clusters.set(root, [])
    clusters.get(root).push(o)
  }

  const candidates = []
  for (const members of clusters.values()) {
    const open = members.filter((o) => identity.map[o.key] === undefined)
    if (!open.length) continue
    // people only seen in groups count once they wrote enough there
    if (!open.some((o) => o.threads.length) && open.reduce((s, o) => s + o.groupMessages, 0) < MIN_GROUP_MESSAGES) continue
    open.sort((a, b) => b.messages - a.messages || b.groupMessages - a.groupMessages)
    const main = open[0]
    const dm = open.reduce((s, o) => s + o.messages, 0)
    const groupOnly = dm === 0
    const names = [...new Set(open.map((o) => o.name))]
    const keys = open.map((o) => o.key)
    const linked = members.map((o) => identity.map[o.key]).find((v) => v && v !== SKIP)
    const suggest = linked ? { note: linked, score: 1, reason: 'Ten istý človek je už prepojený cez iný účet.' } : suggestFor(names, keys, notes)

    // newest lines and photos come from the most recent private chat
    const threads = open.flatMap((o) => o.threads.map((t) => ({ t, source: o.source }))).sort((a, b) => (a.t.last < b.t.last ? 1 : -1))
    let sample = []
    if (threads.length) {
      const lines = await tail(join(ARCHIVE_DIR, threads[0].t.file))
      sample = lines.filter((m) => m.type !== 'system').slice(-6).map((m) => ({ t: m.t, from: m.from, text: shown(m) }))
    }
    const photos = []
    for (const { t, source } of threads) {
      if (photos.length >= 6 || !t.photos) continue
      const dir = join(ARCHIVE_DIR, source, 'media', t.id)
      try {
        for (const f of (await readdir(dir)).sort().reverse()) if (photos.length < 6) photos.push(join(dir, f))
      } catch {
        // media folder was removed by hand
      }
    }
    if (groupOnly) {
      // no private chat: show their latest lines from the group where they write most
      const best = open.flatMap((o) => o.groups.map((g) => ({ g, name: o.name, n: g.by?.[o.name] ?? 0 }))).sort((a, b) => b.n - a.n)[0]
      if (best) {
        const lines = await tail(join(ARCHIVE_DIR, best.g.file), 200_000)
        sample = lines.filter((m) => m.from === best.name && m.type !== 'system').slice(-6).map((m) => ({ t: m.t, from: m.from, text: shown(m) }))
      }
      for (const o of open) for (const g of o.groups) if (g.by?.[o.name]) {
        if (!o.first || g.first < o.first) o.first = g.first
        if (!o.last || g.last > o.last) o.last = g.last
      }
    }
    const firsts = open.map((o) => o.first).filter(Boolean).sort()
    const lasts = open.map((o) => o.last).filter(Boolean).sort()
    // the most name-like spelling: "Jana Nováková" rather than "jana.novakova" or "Jana 🌸"
    const pretty = (n) => n.replace(EMOJI, '').replace(/\s+/g, ' ').trim()
    const rank = (n) => (/\s/.test(pretty(n)) ? 2 : 0) + (/^\p{Lu}/u.test(pretty(n)) ? 1 : 0)
    const bestName = pretty([...names].sort((a, b) => rank(b) - rank(a) || nameTokens(b).length - nameTokens(a).length)[0]) || main.name
    candidates.push({
      key: main.key,
      name: bestName,
      sources: open.map((o) => ({ source: o.source, handle: o.name, threadIds: o.threads.map((t) => t.id) })),
      messages: groupOnly ? open.reduce((s, o) => s + o.groupMessages, 0) : dm,
      mine: open.reduce((s, o) => s + o.mine, 0),
      theirs: groupOnly ? open.reduce((s, o) => s + o.groupMessages, 0) : open.reduce((s, o) => s + o.theirs, 0),
      first: firsts[0] ?? null,
      last: lasts[lasts.length - 1] ?? null,
      groupsShared: new Set(open.flatMap((o) => o.groups.map((g) => `${o.source}/${g.id}`))).size,
      sample,
      photos,
      suggest,
      kindGuess: kindGuess(names, identity.me),
      identities: keys,
    })
  }
  candidates.sort((a, b) => b.messages - a.messages)
  await writeJson(CANDIDATES_FILE, { updated: new Date().toISOString(), candidates })
  const visible = all ? candidates : candidates.filter((c) => c.messages >= MIN_MESSAGES)
  return { ok: true, me: identity.me, candidates: visible.map(({ identities, ...c }) => c), total: visible.length, hiddenSmall: candidates.length - visible.length }
}

// ── notes and digests ──────────────────────────────────────────────────

/** Everything the archive knows about the identities linked to one person note. */
async function personData(title, identity, ids) {
  const keys = Object.entries(identity.map).filter(([, v]) => v === title).map(([k]) => k)
  const parts = keys.map((k) => ids.get(k)).filter(Boolean)
  return { keys, parts }
}

function conversationSection(parts) {
  const lines = ['## Konverzácie', '']
  for (const o of parts) {
    const label = `${SOURCE_NAME[o.source] ?? o.source} (${o.name})`
    if (o.messages) lines.push(`- ${label}: ${plural(o.messages, 'správa', 'správy', 'správ')}, ${day(o.first)} až ${day(o.last)}`)
    else if (o.groupMessages) lines.push(`- ${label}: ${plural(o.groupMessages, 'správa', 'správy', 'správ')} v skupinách`)
  }
  const groups = new Map()
  for (const o of parts) for (const g of o.groups) groups.set(`${o.source}/${g.id}`, g.title)
  if (groups.size) lines.push(`- Spoločné skupiny: ${groups.size} (${[...groups.values()].slice(0, 6).join(', ')}${groups.size > 6 ? ' a ďalšie' : ''})`)
  if (lines.length === 2) lines.push('- Zatiaľ žiadne súkromné správy.')
  return lines.join('\n')
}

/** New section goes before `## Zapamätané` (Jarvis keeps appending there), else to the end. */
function insertSection(body, section) {
  const lines = body.split('\n')
  const at = lines.findIndex((l) => /^## Zapamätané\s*$/.test(l))
  if (at < 0) return `${body.replace(/\s+$/, '')}\n\n${section}\n`
  return `${lines.slice(0, at).join('\n').replace(/\s+$/, '')}\n\n${section}\n\n${lines.slice(at).join('\n')}`
}

const zdrojOf = (key) => key.replace(/[,[\]\n]/g, ' ').replace(/\s+/g, ' ').trim()

/** Creates or updates memory/ludia/<title>.md. Returns { rel, created }. */
async function writePersonNote(title, identity, ids, { vztah = null, avatar = null, create = true } = {}) {
  const rel = `${FOLDERS.people}/${title}.md`
  const full = join(MEMORY_DIR, rel)
  const exists = existsSync(full)
  if (!exists && !create) return null
  const { keys, parts } = await personData(title, identity, ids)
  let fotka = null
  if (avatar && existsSync(avatar)) {
    const ext = (extname(avatar) || '.jpg').toLowerCase()
    fotka = `_fotky/${slugify(title) || 'osoba'}${ext === '.jpeg' ? '.jpg' : ext}`
    await mkdir(join(PEOPLE_DIR, '_fotky'), { recursive: true })
    await copyFile(avatar, join(PEOPLE_DIR, fotka))
  }
  const section = conversationSection(parts)
  if (!exists) {
    const lines = setFrontmatter([], { vztah: vztah || null, zdroje: keys.map(zdrojOf), fotka })
    await writeFileAtomic(full, joinNote(lines, `# ${title}\n\n${section}\n`))
    return { rel, created: true }
  }
  const text = await readFile(full, 'utf8')
  const { lines, body } = splitNote(text)
  const { fm } = parseFrontmatter(text)
  const had = Array.isArray(fm.zdroje) ? fm.zdroje : typeof fm.zdroje === 'string' && fm.zdroje ? [fm.zdroje] : []
  const zdroje = [...new Set([...had, ...keys.map(zdrojOf)])]
  const nextLines = setFrontmatter(lines, { vztah: vztah || null, zdroje: zdroje.length ? zdroje : null, fotka })
  const cut = cutSection(body, 'Konverzácie')
  const nextBody = cut.section
    ? `${cut.before.replace(/\s+$/, '')}\n\n${section}\n${cut.after.trim() ? `\n${cut.after.replace(/^\n+/, '')}` : ''}`
    : insertSection(body, section)
  const next = joinNote(nextLines, nextBody.replace(/^\n+/, ''))
  if (next !== text) await writeFileAtomic(full, next.endsWith('\n') ? next : `${next}\n`)
  return { rel, created: false }
}

const line = (m) => `[${localStamp(m.t)}] ${m.from}: ${shown(m, 240)}`

/** Digest for the later Claude job: numbers first, then a sampled transcript. */
async function writePersonDigest(title, identity, ids) {
  const { keys, parts } = await personData(title, identity, ids)
  if (!parts.length) return null
  const all = []
  for (const o of parts) {
    for (const t of o.threads) {
      for (const m of await readThread(join(ARCHIVE_DIR, t.file))) if (m.type !== 'system') all.push(m)
    }
  }
  all.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
  // someone known only from groups: their own lines there are all there is to read
  const inGroups = []
  if (!all.length) {
    for (const o of parts) {
      for (const g of o.groups.filter((x) => x.by?.[o.name]).sort((a, b) => b.by[o.name] - a.by[o.name]).slice(0, 5)) {
        for (const m of await readThread(join(ARCHIVE_DIR, g.file))) if (m.from === o.name && m.type !== 'system') inGroups.push({ ...m, from: `${m.from} (v skupine ${g.title})` })
      }
    }
    inGroups.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
  }
  const years = new Map()
  const days = new Map()
  for (const m of all) {
    years.set(m.t.slice(0, 4), (years.get(m.t.slice(0, 4)) ?? 0) + 1)
    days.set(m.t.slice(0, 10), (days.get(m.t.slice(0, 10)) ?? 0) + 1)
  }
  const mine = all.filter((m) => m.me).length
  const groups = new Map()
  for (const o of parts) for (const g of o.groups) groups.set(`${o.source}/${g.id}`, { title: g.title, n: g.by?.[o.name] ?? 0 })
  const topGroups = [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 8)
  const head = [
    `# ${title}: konverzácie`,
    '',
    `Podklad pre Jarvisa. Vznikol z importovaných správ. Poznámka človeka je v pamäti ako ${FOLDERS.people}/${title}.md.`,
    'Úloha: zistiť, kto tento človek pre používateľa je (vzťah, odkiaľ sa poznajú, o čom sa bavia, dôležité udalosti a dátumy) a doplniť to do jeho poznámky. Písať len to, čo zo správ naozaj vyplýva.',
    '',
    '## Čísla',
    '',
    `- účty: ${keys.join(', ')}`,
    `- súkromné správy spolu: ${fmtInt(all.length)} (používateľ ${fmtInt(mine)}, druhá strana ${fmtInt(all.length - mine)})`,
    ...parts.filter((o) => o.messages).map((o) => `- ${SOURCE_NAME[o.source] ?? o.source} (${o.name}): ${fmtInt(o.messages)} správ, ${day(o.first)} až ${day(o.last)}`),
    `- prvá správa: ${all.length ? day(all[0].t) : 'žiadna'}, posledná: ${all.length ? day(all[all.length - 1].t) : 'žiadna'}`,
    `- po rokoch: ${[...years].sort().map(([y, n]) => `${y}: ${fmtInt(n)}`).join(', ') || 'nič'}`,
    `- spoločné skupiny: ${topGroups.length ? topGroups.map((g) => `${g.title}${g.n ? ` (${fmtInt(g.n)} jeho správ)` : ''}`).join(', ') : 'žiadne'}`,
    '',
  ].join('\n')

  const firstN = all.slice(0, 40)
  const lastN = all.slice(Math.max(40, all.length - 150))
  const middle = all.slice(40, Math.max(40, all.length - 150))
  const busy = [...days].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => d).sort()
  const dayBlocks = []
  for (const d of busy) {
    const ofDay = middle.filter((m) => m.t.startsWith(d))
    if (ofDay.length < 5) continue
    dayBlocks.push([`### ${d} (${fmtInt(days.get(d))} správ)`, '', ...ofDay.slice(0, 30).map(line), ''].join('\n'))
  }
  const first = firstN.length ? ['## Prvé správy', '', ...firstN.map(line), ''].join('\n') : ''
  const lastLines = lastN.map(line)
  let budget = DIGEST_CHARS - head.length - first.length - 60
  while (dayBlocks.length && dayBlocks.join('\n').length > budget * 0.4) dayBlocks.pop()
  const middleText = dayBlocks.length ? `## Najživšie dni\n\n${dayBlocks.join('\n')}` : ''
  budget -= middleText.length
  while (lastLines.length && lastLines.join('\n').length > budget) lastLines.shift()
  const last = lastLines.length ? ['## Posledné správy', '', ...lastLines, ''].join('\n') : ''
  const groupLines = inGroups.slice(-150).map(line)
  while (groupLines.length && groupLines.join('\n').length > budget) groupLines.shift()
  const groupText = groupLines.length ? ['## Jeho správy v skupinách (súkromné správy nie sú)', '', ...groupLines, ''].join('\n') : ''
  const path = join(DIGEST_DIR, `${slugify(title) || 'osoba'}.md`)
  await writeFileAtomic(path, [head, first, middleText, last, groupText].filter(Boolean).join('\n'))
  return path
}

/** Finds an existing person note by title, forgiving case and diacritics. */
async function existingTitle(title) {
  if (existsSync(join(PEOPLE_DIR, `${title}.md`))) return title
  const want = slugify(title)
  const notes = await peopleNotes()
  return notes.find((n) => slugify(n.title) === want)?.title ?? null
}

/**
 * Applies the user's decisions.
 * decisions: [{ key, action: 'new'|'merge'|'skip', name?, vztah?, note?, avatar? }]
 */
export async function applyDecisions(decisions) {
  if (!Array.isArray(decisions)) throw new UserError('Rozhodnutia musia byť zoznam (JSON pole).')
  const identity = await loadIdentity()
  let cache = (await readJson(CANDIDATES_FILE, null))?.candidates ?? null
  if (!cache || decisions.some((d) => !cache.some((c) => c.key === d?.key))) {
    await buildCandidates({ all: true })
    cache = (await readJson(CANDIDATES_FILE, null))?.candidates ?? []
  }
  const ids = await collectIdentities(identity)
  const created = []
  const merged = []
  const digests = []
  const warnings = []
  const titles = new Set()
  let skipped = 0
  for (const d of decisions) {
    const cand = cache.find((c) => c.key === d?.key)
    if (!cand) {
      warnings.push(`Človeka s kľúčom ${d?.key} som medzi návrhmi nenašiel.`)
      continue
    }
    if (d.action === 'skip') {
      for (const k of cand.identities) identity.map[k] = SKIP
      skipped++
      continue
    }
    if (d.action !== 'new' && d.action !== 'merge') {
      warnings.push(`Neznáma akcia „${d.action}" pri ${cand.name}.`)
      continue
    }
    // a note may come as a title or as a path ("ludia/Jana Nováková.md")
    const asTitle = (v) => (typeof v === 'string' ? v.replace(/\\/g, '/').split('/').pop().replace(/\.md$/i, '') : null)
    const wanted = safeFileName(d.action === 'merge' ? (asTitle(d.note) ?? d.name ?? cand.name) : (d.name ?? cand.name))
    if (!wanted) {
      warnings.push(`Pri ${cand.key} chýba meno.`)
      continue
    }
    const found = await existingTitle(wanted)
    // a merge target that does not exist becomes a new note under the person's own name
    const title = found ?? (d.action === 'merge' ? safeFileName(d.name ?? cand.name) || wanted : wanted)
    if (d.action === 'merge' && !found) warnings.push(`Poznámku „${wanted}" som nenašiel, vytvoril som novú: ${title}.`)
    for (const k of cand.identities) identity.map[k] = title
    const avatar = typeof d.avatar === 'string' && d.avatar ? [d.avatar, join(MEMORY_DIR, d.avatar), join(ARCHIVE_DIR, d.avatar)].find((p) => existsSync(p)) ?? null : null
    if (d.avatar && !avatar) warnings.push(`Fotku ${d.avatar} som nenašiel.`)
    const res = await writePersonNote(title, identity, ids, { vztah: typeof d.vztah === 'string' && d.vztah.trim() ? d.vztah.trim() : null, avatar })
    ;(res.created ? created : merged).push(res.rel)
    titles.add(title)
  }
  await saveIdentity(identity)
  for (const title of titles) {
    const path = await writePersonDigest(title, identity, ids)
    if (path) digests.push(path)
  }
  await buildCandidates({ all: true })
  return { ok: true, created, merged, skipped, digests, analysisTask: analysisTask(digests), warnings }
}

function analysisTask(digests) {
  if (!digests.length) return ''
  return [
    'Používateľ práve potvrdil, ktorí ľudia z importovaných správ patria do jeho pamäte. Ku každému je pripravený súhrn konverzácií.',
    'Prečítaj postupne tieto súbory:',
    ...digests.map((p) => `- ${p}`),
    '',
    `Pri každom človeku otvor jeho poznámku v memory/${FOLDERS.people}/ (názov je v prvom riadku súhrnu) a doplň do nej pod nadpis človeka dva až päť viet: kto to pre používateľa je, odkiaľ sa poznajú, o čom sa najčastejšie bavia a čo dôležité sa medzi nimi stalo.`,
    'Ak zo správ jasne vyplýva vzťah (rodina, partner, priateľ, kolega, klient, známy) alebo dátum narodenín, doplň pole vztah alebo narodeniny v hlavičke, ak tam ešte nie je.',
    'Trvalé fakty zapíš pod „## Zapamätané" v tvare „- RRRR-MM-DD: fakt". Sekciu „## Konverzácie" a pole zdroje nemeň.',
    'Píš len to, čo zo správ naozaj vyplýva. Nič si nedomýšľaj a necituj dlhé úryvky. Keď niečo nie je jasné, vynechaj to.',
    'Ak si na detail potrebuješ dohľadať viac, použi nástroje search_messages a read_thread.',
  ].join('\n')
}

/** After an import: refresh numbers and digests of people already linked to that source. */
export async function refreshLinked(source) {
  const identity = await loadIdentity()
  const titles = new Set(Object.entries(identity.map).filter(([k, v]) => v !== SKIP && k.startsWith(`${source}:`)).map(([, v]) => v))
  const digests = []
  if (!titles.size) return digests
  const ids = await collectIdentities(identity)
  for (const title of titles) {
    const res = await writePersonNote(title, identity, ids, { create: false })
    if (!res) continue
    const path = await writePersonDigest(title, identity, ids)
    if (path) digests.push(path)
  }
  return digests
}
