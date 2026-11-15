/**
 * WhatsApp "Export chat": one text file per conversation, bare or inside a zip with media.
 *
 *   iPhone   [31.12.2026, 21:15:03] Meno: text          (file _chat.txt in "WhatsApp Chat - Meno.zip")
 *   Android  31. 12. 2026, 21:15 - Meno: text           (file "WhatsApp Chat with Meno.txt")
 *   US       12/31/26, 9:15 PM - Name: text             [12/31/26, 9:15:03 PM] Name: text
 *
 * The date layout follows the phone's language, so day/month order is worked out from the
 * whole file. Lines without a timestamp continue the previous message. Times are local times
 * of the phone, they are read in this computer's time zone.
 */
import { basename, dirname } from 'node:path'
import { UserError, decodeText } from '../util.mjs'
import { ME_HINT, guessSelf } from './common.mjs'

const MARKS = /[‎‏‪-‮⁦-⁩﻿]/g
const DATE = '(\\d{1,4})([./-])\\s?(\\d{1,2})\\2\\s?(\\d{2,4})'
const TIME = '(\\d{1,2})[:.](\\d{2})(?:[:.](\\d{2}))?(?:[\\s\\u202f\\u00a0]*(AM|PM|am|pm|a\\.\\s?m\\.|p\\.\\s?m\\.|A\\.\\s?M\\.|P\\.\\s?M\\.|dop\\.|odp\\.|vorm\\.|nachm\\.))?'
const IOS = new RegExp(`^[\\u200e\\u200f\\ufeff]*\\[${DATE},?\\s+${TIME}\\]\\s?(.*)$`, 's')
const ANDROID = new RegExp(`^[\\u200e\\u200f\\ufeff]*${DATE},?\\s+${TIME}\\s[-–]\\s(.*)$`, 's')
const head = (line) => IOS.exec(line) ?? ANDROID.exec(line)

const ATTACHED_IOS = /<[^<>:\n]{2,24}:\s*([^<>\n]+?\.[A-Za-z0-9]{2,5})>/
const ATTACHED_ANDROID = /^(.+?\.[A-Za-z0-9]{2,5}) \((?:file attached|súbor priložený|súbor bol priložený|priložený súbor|soubor přiložen|soubor byl přiložen|přiložený soubor|Datei angehängt)\)\s*(?:\n([\s\S]*))?$/i
const OMITTED_ANY = /^<[^<>\n]*(?:omitted|vynechan|vynechán|weggelassen|omis|omitido)[^<>\n]*>$/i
const OMITTED_WORD = /(?:^|\s)(image|photo|video|audio|sticker|gif|document|contact card|voice message|obrázok|obrázek|fotka|fotografia|zvuk|nálepka|dokument|kontakt|vizitka|hlasová správa|hlasová zpráva|súbor|soubor) (?:omitted|vynechan\S*|vynechán\S*)$/i
const DELETED = /^(?:this message was deleted|you deleted this message|táto správa bola (?:odstránená|vymazaná)|túto správu ste (?:odstránili|vymazali)|tato zpráva byla (?:odstraněna|smazána)|tuto zprávu jste (?:odstranili|smazali))\.?$/i
const EDITED = /\s*<[^<>\n]*(?:edited|upraven)[^<>\n]*>\s*$/i
const TITLE_PREFIX = /^(?:WhatsApp\s+Chat\s*(?:-|–|with|mit|con|avec|s|se)|Chat\s+(?:de\s+)?WhatsApp\s+(?:s|se|con|com|avec)|(?:Konverzácia|Konverzace|Čet|Chat)\s+(?:v\s+)?WhatsApp(?:e|u)?\s+(?:s|so|se)|WhatsApp\s+(?:čet|chat|konverzácia)\s+(?:s|so|se))\s+/i

/** True when the text starts like a WhatsApp transcript. */
export function looksLikeWhatsApp(text) {
  const lines = String(text).split(/\r?\n/).slice(0, 40)
  let hits = 0
  for (const line of lines) if (head(line)) hits++
  return hits >= 1 && hits >= Math.min(2, lines.filter((l) => l.trim()).length)
}

function typeOfFile(name) {
  const n = name.toLowerCase()
  if (/-sticker-|\.webp$/.test(n)) return 'sticker'
  if (/\.(jpe?g|png|heic|gif)$/.test(n)) return 'photo'
  if (/\.(mp4|mov|3gp|avi|mkv|webm)$/.test(n)) return 'video'
  if (/\.(opus|ogg|m4a|mp3|aac|wav|amr)$/.test(n)) return 'audio'
  return 'share'
}
function typeOfWord(word) {
  const w = word.toLowerCase()
  if (/^(image|photo|obrázok|obrázek|fotka|fotografia|gif)$/.test(w)) return 'photo'
  if (w === 'video') return 'video'
  if (/^(audio|zvuk|voice message|hlasová správa|hlasová zpráva)$/.test(w)) return 'audio'
  if (/^(sticker|nálepka)$/.test(w)) return 'sticker'
  return 'share'
}

/** Body of one message → { type, text, file } or null when there is nothing to keep. */
function classify(raw) {
  const marked = /^[‎‏]/.test(raw)
  let text = raw.replace(MARKS, '').replace(EDITED, '').trim()
  if (DELETED.test(text)) return null
  let m = ATTACHED_ANDROID.exec(text)
  if (m) return { type: typeOfFile(m[1]), text: (m[2] ?? '').trim(), file: m[1].trim() }
  m = ATTACHED_IOS.exec(text)
  if (m) return { type: typeOfFile(m[1]), text: text.replace(m[0], '').trim(), file: m[1].trim() }
  if (OMITTED_ANY.test(text)) return { type: 'photo', text: '' }
  m = OMITTED_WORD.exec(text)
  if (m) return { type: typeOfWord(m[1]), text: text.slice(0, m.index).replace(/[•·\s]+$/, '').trim() }
  if (marked) {
    // iPhone marks generated lines: calls, group events, the encryption notice
    if (/\b(call|hovor)\b/i.test(text)) return { type: 'call', text }
    return { type: 'system', text }
  }
  if (!text) return null
  return { type: 'text', text }
}

/** Day-first or month-first, decided from all dates of the file. */
function dateOrder(heads) {
  if (heads.some((h) => h[1].length === 4)) return 'ymd'
  let dayFirst = 0
  let monthFirst = 0
  for (const h of heads) {
    if (Number(h[1]) > 12) dayFirst++
    if (Number(h[3]) > 12) monthFirst++
  }
  if (dayFirst && !monthFirst) return 'dmy'
  if (monthFirst && !dayFirst) return 'mdy'
  // every date is ambiguous (only days 1 to 12): the right order never goes back in time
  const key = (h, order) => {
    const y = Number(h[4]) < 100 ? 2000 + Number(h[4]) : Number(h[4])
    const [d, mo] = order === 'dmy' ? [Number(h[1]), Number(h[3])] : [Number(h[3]), Number(h[1])]
    return y * 10000 + mo * 100 + d
  }
  const jumps = (order) => {
    let n = 0
    for (let i = 1; i < heads.length; i++) if (key(heads[i], order) < key(heads[i - 1], order)) n++
    return n
  }
  const a = jumps('dmy')
  const b = jumps('mdy')
  if (a !== b) return a < b ? 'dmy' : 'mdy'
  return heads[0]?.[2] === '/' && heads.some((h) => h[8]) ? 'mdy' : 'dmy'
}

function toIso(h, order) {
  let y
  let mo
  let d
  if (order === 'ymd') [y, mo, d] = [Number(h[1]), Number(h[3]), Number(h[4])]
  else if (order === 'dmy') [d, mo, y] = [Number(h[1]), Number(h[3]), Number(h[4])]
  else [mo, d, y] = [Number(h[1]), Number(h[3]), Number(h[4])]
  if (y < 100) y += 2000
  let hour = Number(h[5])
  if (h[8]) {
    const pm = /^(p|odp|nachm)/i.test(h[8])
    if (pm && hour < 12) hour += 12
    if (!pm && hour === 12) hour = 0
  }
  const date = new Date(y, mo - 1, d, hour, Number(h[6]), Number(h[7] ?? 0))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Text of a transcript → { messages, names, chatName, group }. Pure, no file access. */
export function parseTranscript(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  const items = []
  let cur = null
  for (const line of lines) {
    const h = head(line)
    if (h) {
      cur = { h, rest: h[9] }
      items.push(cur)
    } else if (cur) cur.rest += `\n${line}`
  }
  const order = dateOrder(items.map((i) => i.h))
  const messages = []
  const names = new Set()
  let chatName = null
  let group = false
  for (const it of items) {
    const t = toIso(it.h, order)
    if (!t) continue
    const rest = it.rest.replace(/^[‎‏]+/, '')
    const m = /^([^:\n]{1,80}?):(?:[  ]([\s\S]*))?$/.exec(rest)
    if (!m) {
      const text = rest.replace(MARKS, '').trim()
      if (/(created group|vytvoril\S* skupinu|vytvořil\S* skupinu|added|pridal|přidal|joined using|changed the (subject|group)|zmenil\S* (predmet|názov)|left$|opustil)/i.test(text)) group = true
      if (text) messages.push({ t, from: '', me: false, text, type: 'system' })
      continue
    }
    const from = m[1].replace(MARKS, '').trim()
    const c = classify(m[2] ?? '')
    if (!c) continue
    if (c.type === 'system') {
      // on iPhone the first generated line is written under the name of the chat itself
      chatName = chatName ?? from
      messages.push({ t, from: '', me: false, text: c.text, type: 'system' })
      continue
    }
    names.add(from)
    const msg = { t, from, me: false, text: c.text, type: c.type }
    if (c.file) msg.file = c.file
    messages.push(msg)
  }
  return { messages, names: [...names], chatName, group }
}

const isTranscript = (name) => /(?:^|\/)_chat\.txt$/i.test(name) || (/\.txt$/i.test(name) && /whatsapp/i.test(basename(name)))

async function transcripts(src) {
  const named = src.entries.filter((e) => isTranscript(e.name))
  if (named.length) return named
  // a zip or folder with one text file next to media, or a bare .txt: look inside
  const txt = src.entries.filter((e) => /\.txt$/i.test(e.name) && e.name.split('/').length <= 2)
  const out = []
  for (const e of txt.slice(0, 5)) {
    try {
      if (looksLikeWhatsApp(await src.head(e.name, 6000))) out.push(e)
    } catch {
      // unreadable: not a transcript
    }
  }
  return out
}

function titleOf(src, entry) {
  let base = basename(entry.name).replace(/\.txt$/i, '')
  if (/^_chat$/i.test(base)) {
    const parent = dirname(entry.name)
    base = parent && parent !== '.' ? basename(parent) : basename(src.path).replace(/\.(zip|txt)$/i, '')
  }
  const title = base.replace(TITLE_PREFIX, '').replace(/\s*\(\d+\)$/, '').trim()
  return /^(_chat|whatsapp chat|chat)$/i.test(title) ? '' : title
}

export async function sniff(src) {
  const files = await transcripts(src)
  if (!files.length) return null
  const title = files.length === 1 ? titleOf(src, files[0]) : null
  return { source: 'whatsapp', confidence: isTranscript(files[0].name) ? 0.95 : 0.8, details: { threads: files.length, title: title || null, user: title || null, media: src.entries.length - files.length } }
}

export async function run(ctx) {
  const { src } = ctx
  const files = await transcripts(src)
  if (!files.length) throw new UserError('V tomto súbore som nenašiel konverzáciu z WhatsAppu.')
  let self = null
  let done = 0
  for (const entry of files) {
    done++
    ctx.progress(0.1 + 0.8 * ((done - 1) / files.length), files.length > 1 ? `Čítam konverzácie (${done} z ${files.length})` : 'Čítam konverzáciu')
    const parsed = parseTranscript(decodeText(await src.read(entry.name)))
    if (!parsed.messages.length) {
      ctx.warn(`V súbore ${basename(entry.name)} som nenašiel žiadne správy.`)
      continue
    }
    const title = titleOf(src, entry) || parsed.chatName || ''
    const group = parsed.group || parsed.names.length > 2
    const me = await guessSelf(parsed.names, { override: ctx.options.me, known: ctx.identity.me, title: group ? null : title || parsed.chatName })
    if (!me) ctx.warn(`${ME_HINT} V konverzácii píšu: ${parsed.names.slice(0, 6).join(', ')}.`)
    self = self ?? me
    const dir = dirname(entry.name) === '.' ? '' : `${dirname(entry.name)}/`
    for (const m of parsed.messages) {
      m.me = Boolean(me) && m.from === me
      if (m.file) {
        if (m.type === 'photo') m.photo = `${dir}${m.file}`
        delete m.file
      }
    }
    const other = parsed.names.filter((n) => n !== me)
    await ctx.put({ id: title || other.join('-') || basename(src.path), title: title || other.join(', '), kind: group ? 'group' : 'dm', participants: parsed.names, self: me }, parsed.messages)
  }
  return { me: self, participants: undefined }
}
