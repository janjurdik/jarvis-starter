/**
 * Searching the imported conversations and reading one thread. Used by the command line
 * (`import.mjs search`, `import.mjs thread`) and by the HUD brain (tools search_messages and
 * read_thread), so it has no side effects and imports nothing heavy.
 *
 * The search ignores case and diacritics. It does not parse every message: the query becomes
 * a regular expression that runs over the raw .jsonl text, and only lines with a match inside
 * the "text" field are parsed. Half a million messages take about a second.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SKIP, archivedSources, loadIdentity, loadThreads, readThread } from './store.mjs'
import { ARCHIVE_DIR, UserError, fold, localStamp, nameTokens, normName, oneLine, safeId } from './util.mjs'

const VARIANTS = { a: 'aáäàâãåā', c: 'cčćç', d: 'dďđ', e: 'eéěèêëē', i: 'iíìîïī', l: 'lĺľł', n: 'nňñń', o: 'oóôöòõő', r: 'rŕř', s: 'sšś', t: 'tť', u: 'uúůüùûű', y: 'yýÿ', z: 'zžźż' }
const TEXT_KEY = ',"text":"'
const TYPE_KEY = '","type":"'

/** Regular expression that finds the query in JSON-encoded text, whatever the case or accents. */
function queryRegex(query) {
  const folded = fold(query).trim()
  let out = ''
  let space = false
  for (const ch of folded) {
    if (/\s/.test(ch)) {
      if (!space) out += '(?: |\\\\n|\\\\t)+'
      space = true
      continue
    }
    space = false
    if (/[a-z]/.test(ch)) {
      const v = VARIANTS[ch] ?? ch
      out += `[${v}${v.toUpperCase()}]`
    } else {
      // the files hold JSON, so quotes and backslashes are escaped there
      out += JSON.stringify(ch).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return out ? new RegExp(out, 'g') : null
}

const dayStart = (d) => (d ? `${String(d).slice(0, 10)}T00:00:00.000Z` : null)
const dayEnd = (d) => (d ? (String(d).length > 10 ? String(d) : `${String(d).slice(0, 10)}T23:59:59.999Z`) : null)

/** Names (per source) that belong to the person the caller asked for. */
async function personNames(person) {
  const want = normName(person)
  const tokens = nameTokens(person)
  if (!tokens.length) return null
  const identity = await loadIdentity()
  const linked = new Set()
  for (const [key, title] of Object.entries(identity.map)) {
    if (title !== SKIP && normName(title) === want) linked.add(key)
  }
  return {
    matches: (source, name) => {
      if (linked.has(`${source}:${name}`)) return true
      const t = nameTokens(name)
      return normName(name) === want || (tokens.length >= 1 && tokens.every((x) => t.includes(x)))
    },
  }
}

/**
 * search(query, { person, source, from, to, limit })
 * → { ok, hits: [{ source, thread, title, t, from, text, context: [{ t, from, text, pos }] }], total }
 * Newest first. `context` holds up to two messages before (pos -2, -1) and after (pos 1, 2).
 */
export async function search(query, { person = null, source = null, from = null, to = null, limit = 20 } = {}) {
  const re = queryRegex(String(query ?? ''))
  const who = person ? await personNames(person) : null
  if (!re && !who) throw new UserError('Chýba text, ktorý mám hľadať.')
  const max = Math.min(200, Math.max(1, Number(limit) || 20))
  const since = dayStart(from)
  const until = dayEnd(to)
  const sources = (await archivedSources()).filter((s) => !source || s === source)
  const found = []
  let total = 0

  for (const s of sources) {
    for (const th of await loadThreads(s)) {
      if (since && th.last < since) continue
      if (until && th.first > until) continue
      // with a person: whole private chats with them, and only their own lines in groups
      let onlyFrom = null
      if (who) {
        const names = th.participants.filter((p) => p !== th.self && who.matches(s, p))
        if (!names.length) continue
        if (th.kind !== 'dm') onlyFrom = new Set(names.map((n) => JSON.stringify(n).slice(1, -1)))
      }
      let text
      try {
        text = readFileSync(join(ARCHIVE_DIR, th.file), 'utf8')
      } catch {
        continue
      }
      const mine = []
      const consider = (ls, le) => {
        const t = text.slice(ls + 6, ls + 30)
        if (since && t < since) return
        if (until && t > until) return
        if (onlyFrom) {
          const a = text.indexOf('"from":"', ls) + 8
          const b = text.indexOf('","me":', a)
          if (a < 8 || b < 0 || b > le || !onlyFrom.has(text.slice(a, b))) return
        }
        total++
        mine.push({ t, ls, le })
        if (mine.length > max) mine.shift()
      }
      if (re) {
        re.lastIndex = 0
        let m
        while ((m = re.exec(text))) {
          const at = m.index
          if (m[0].length === 0) {
            re.lastIndex++
            continue
          }
          const ls = text.lastIndexOf('\n', at) + 1
          let le = text.indexOf('\n', at)
          if (le < 0) le = text.length
          const a = text.indexOf(TEXT_KEY, ls)
          const b = text.lastIndexOf(TYPE_KEY, le)
          if (a < 0 || a > le || b < ls) {
            re.lastIndex = le
            continue
          }
          if (at < a + TEXT_KEY.length) {
            // the match is in the sender or a key name: continue inside the text
            re.lastIndex = a + TEXT_KEY.length
            continue
          }
          if (at + m[0].length <= b) consider(ls, le)
          re.lastIndex = le
        }
      } else {
        // no text given: the newest messages of that person
        let le = text.length
        while (le > 0 && mine.length < max) {
          if (text[le - 1] === '\n') le--
          const ls = text.lastIndexOf('\n', le - 1) + 1
          if (le > ls) {
            const before = mine.length
            consider(ls, le)
            if (mine.length > before) mine.unshift(mine.pop())
          }
          le = ls
        }
      }
      for (const h of mine) found.push({ ...h, text, source: s, thread: th })
    }
  }

  found.sort((x, y) => (x.t < y.t ? 1 : x.t > y.t ? -1 : 0))
  const parse = (raw) => {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  const hits = []
  for (const h of found.slice(0, max)) {
    const msg = parse(h.text.slice(h.ls, h.le))
    if (!msg) continue
    const context = []
    let p = h.ls
    for (let i = 1; i <= 2 && p > 0; i++) {
      const end = p - 1
      const start = h.text.lastIndexOf('\n', end - 1) + 1
      const m = parse(h.text.slice(start, end))
      if (m) context.unshift({ t: m.t, from: m.from, text: oneLine(m.text || `[${m.type}]`, 200), pos: -i })
      p = start
    }
    p = h.le
    for (let i = 1; i <= 2 && p < h.text.length - 1; i++) {
      const start = p + 1
      let end = h.text.indexOf('\n', start)
      if (end < 0) end = h.text.length
      const m = parse(h.text.slice(start, end))
      if (m) context.push({ t: m.t, from: m.from, text: oneLine(m.text || `[${m.type}]`, 200), pos: i })
      p = end
    }
    hits.push({ source: h.source, thread: h.thread.id, title: h.thread.title, t: msg.t, from: msg.from, text: msg.text.length > 1200 ? `${msg.text.slice(0, 1200)}…` : msg.text, context })
  }
  return { ok: true, hits, total }
}

/**
 * Messages of one thread. Without `around` the newest `limit` messages, with it a window
 * centred on that moment.
 * → { ok, source, thread, title, kind, participants, total, from, to, messages: [...] }
 */
export async function thread(source, threadId, { around = null, limit = 80 } = {}) {
  const threads = await loadThreads(String(source ?? ''))
  const want = String(threadId ?? '')
  const th = threads.find((t) => t.id === want) ?? threads.find((t) => t.id === safeId(want)) ?? threads.find((t) => fold(t.title) === fold(want))
  if (!th) throw new UserError(`Konverzáciu „${threadId}" v zdroji ${source} nemám.`)
  const all = await readThread(join(ARCHIVE_DIR, th.file))
  const max = Math.min(500, Math.max(1, Number(limit) || 80))
  let start = Math.max(0, all.length - max)
  if (around) {
    const at = String(around).length <= 10 ? `${String(around).slice(0, 10)}T00:00:00.000Z` : String(around)
    let i = all.findIndex((m) => m.t >= at)
    if (i < 0) i = all.length - 1
    start = Math.max(0, Math.min(all.length - max, i - Math.floor(max / 2)))
  }
  const messages = all.slice(start, start + max)
  return {
    ok: true,
    source: String(source),
    thread: th.id,
    title: th.title,
    kind: th.kind,
    participants: th.participants,
    total: all.length,
    from: messages[0]?.t ?? null,
    to: messages[messages.length - 1]?.t ?? null,
    messages,
  }
}

/** Plain text of search hits for the brain (compact, one block per hit). */
export function formatHits(result) {
  return result.hits
    .map((h) => {
      const lines = [`### ${h.title} · ${h.source} · vlákno ${h.thread}`]
      for (const c of h.context.filter((x) => x.pos < 0)) lines.push(`  ${localStamp(c.t)} ${c.from}: ${c.text}`)
      lines.push(`> ${localStamp(h.t)} ${h.from}: ${oneLine(h.text, 600)}`)
      for (const c of h.context.filter((x) => x.pos > 0)) lines.push(`  ${localStamp(c.t)} ${c.from}: ${c.text}`)
      return lines.join('\n')
    })
    .join('\n\n')
}
