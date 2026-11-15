/**
 * Telegram Desktop export in the machine-readable format: result.json.
 *
 *   full export   { personal_information, chats: { list: [chat] }, left_chats: { list: [chat] } }
 *   one chat      { name, type, id, messages: [...] }
 *   chat          { name, type: personal_chat|private_group|private_supergroup|public_supergroup|
 *                   private_channel|public_channel|saved_messages|bot_chat, id, messages }
 *   message       { type: message|service, date, date_unixtime, from, from_id, text (string or
 *                   array of strings and entities), photo, file, media_type, action }
 *
 * The file can have hundreds of megabytes, so it is read as a stream, one message at a time.
 */
import { dirname } from 'node:path'
import { UserError, iso, scanJson } from '../util.mjs'
import { ME_HINT, guessSelf } from './common.mjs'

const RESULT_RE = /(?:^|\/)result\.json$/i

const HTML_HELP =
  'Tento export z Telegramu je vo formáte HTML a ten sa nedá načítať. V Telegram Desktop ho sprav znova: Nastavenia → Rozšírené → Exportovať údaje z Telegramu ' +
  'a dole pri formáte vyber „Strojovo čitateľný JSON". Potom sem pretiahni priečinok s exportom alebo súbor result.json.'

export async function sniff(src) {
  const entry = src.entries.filter((e) => RESULT_RE.test(e.name)).sort((a, b) => a.name.length - b.name.length)[0]
  if (entry) {
    const head = await src.head(entry.name, 3000).catch(() => '')
    const full = /"(personal_information|chats|left_chats|frequent_contacts)"\s*:/.test(head)
    const single = /"type"\s*:\s*"(personal_chat|private_group|private_supergroup|public_supergroup|private_channel|public_channel|saved_messages|bot_chat)"/.test(head)
    if (full || single) {
      const name = /"first_name"\s*:\s*"([^"]*)"/.exec(head)?.[1] ?? null
      const chat = single ? (/"name"\s*:\s*"([^"]*)"/.exec(head)?.[1] ?? null) : null
      return { source: 'telegram', confidence: 0.95, details: { format: 'json', single: !full, user: full ? decode(name) : decode(chat), file: entry.name } }
    }
  }
  if (src.find(/(?:^|\/)messages\d*\.html$/i) && src.find(/(?:^|\/)css\/style\.css$/i) && src.find(/(?:^|\/)js\/script\.js$/i)) {
    return { source: 'telegram', confidence: 0.85, details: { format: 'html', user: null } }
  }
  return null
}

const decode = (s) => {
  if (!s) return null
  try {
    return JSON.parse(`"${s}"`)
  } catch {
    return s
  }
}

const KIND = { personal_chat: 'dm', saved_messages: 'channel', bot_chat: 'channel', private_group: 'group', private_supergroup: 'group', public_supergroup: 'group', private_channel: 'channel', public_channel: 'channel', replies: 'channel' }

const flat = (text) => (Array.isArray(text) ? text.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('') : String(text ?? ''))
const included = (path) => typeof path === 'string' && path && !path.startsWith('(')

function convert(m, selfId) {
  const t = m.date_unixtime ? iso(Number(m.date_unixtime) * 1000) : iso(Date.parse(m.date))
  if (!t) return null
  if (m.type === 'service') {
    if (m.action !== 'phone_call' && m.action !== 'group_call') return null
    const from = m.actor ?? 'Zmazaný účet'
    return { t, from, fromId: m.actor_id ?? null, me: Boolean(selfId) && m.actor_id === selfId, text: `Hovor${m.duration_seconds ? ` (${Math.floor(m.duration_seconds / 60)}:${String(m.duration_seconds % 60).padStart(2, '0')})` : ''}`, type: 'call' }
  }
  const from = m.from ?? 'Zmazaný účet'
  let text = flat(m.text)
  let type = 'text'
  let photo = null
  if (m.photo) {
    type = 'photo'
    if (included(m.photo)) photo = m.photo
  } else if (m.media_type === 'sticker') {
    type = 'sticker'
    text = text || m.sticker_emoji || ''
  } else if (m.media_type === 'video_file' || m.media_type === 'video_message' || m.media_type === 'animation') type = 'video'
  else if (m.media_type === 'voice_message' || m.media_type === 'audio_file') type = 'audio'
  else if (m.file) {
    type = 'share'
    text = text || m.file_name || ''
  } else if (m.location_information || m.contact_information || m.poll) {
    type = 'share'
    text = text || m.poll?.question || m.place_name || ''
  }
  if (type === 'text' && !text) return null
  const out = { t, from, fromId: m.from_id ?? null, me: Boolean(selfId) && m.from_id === selfId, text, type }
  if (photo) out.photo = photo
  return out
}

export async function run(ctx) {
  const { src, det } = ctx
  if (det.details.format === 'html') throw new UserError(HTML_HELP)
  const entry = src.get(det.details.file)
  const base = dirname(entry.name) === '.' ? '' : `${dirname(entry.name)}/`
  let selfId = null
  let selfName = null
  let chat = null
  let chats = 0
  const total = entry.size || 1
  let seen = 0

  const flush = async () => {
    const c = chat
    chat = null
    if (!c || !c.raw.length) return
    chats++
    const kind = KIND[c.type] ?? 'group'
    let me = selfName
    let messages = c.raw.map((m) => convert(m, selfId)).filter(Boolean)
    if (!selfId) {
      // export of one chat: nothing in the file says who the owner is
      const names = [...new Set(messages.map((m) => m.from))]
      me = await guessSelf(names, { override: ctx.options.me, known: ctx.identity.me, title: kind === 'dm' ? c.name : null })
      if (!me && kind !== 'channel') ctx.warn(`${ME_HINT} V konverzácii píšu: ${names.slice(0, 6).join(', ')}.`)
      for (const m of messages) m.me = Boolean(me) && m.from === me
      selfName = selfName ?? me
    } else if (!me) {
      me = messages.find((m) => m.me)?.from ?? null
      selfName = selfName ?? me
    }
    messages = messages.map(({ fromId, ...m }) => {
      if (m.photo) m.photo = `${base}${m.photo}`
      return m
    })
    const title = c.name || (c.type === 'saved_messages' ? 'Uložené správy' : 'Zmazaný účet')
    const participants = [...new Set(messages.map((m) => m.from))]
    if (kind === 'dm' && c.name && !participants.includes(c.name)) participants.push(c.name)
    await ctx.put({ id: `t${c.id ?? title}`, title, kind, participants, self: me }, messages)
  }

  const isList = (p) => (p[0] === 'chats' || p[0] === 'left_chats') && p[1] === 'list'
  await scanJson(
    src.stream(entry.name),
    (p) => {
      if (p.length === 1) return p[0] === 'name' || p[0] === 'type' || p[0] === 'id' || p[0] === 'personal_information'
      if (p.length === 2) return p[0] === 'messages'
      if (p.length === 4) return isList(p) && p[3] !== 'messages'
      if (p.length === 5) return isList(p) && p[3] === 'messages'
      return false
    },
    async (p, v) => {
      if (p.length === 1 && p[0] === 'personal_information') {
        if (v?.user_id) selfId = `user${v.user_id}`
        selfName = [v?.first_name, v?.last_name].filter(Boolean).join(' ') || null
        return
      }
      const key = p.length <= 2 ? 'single' : `${p[0]}:${p[2]}`
      if (!chat || chat.key !== key) {
        await flush()
        chat = { key, name: null, type: null, id: null, raw: [] }
      }
      if (p.length === 1 || p.length === 4) {
        const field = p[p.length - 1]
        if (field === 'name' || field === 'type' || field === 'id') chat[field] = v
        return
      }
      chat.raw.push(v)
      seen += 220
      if (chat.raw.length % 2000 === 0) ctx.progress(Math.min(0.95, 0.05 + 0.9 * (seen / total)), `Čítam správy z Telegramu (${chats + 1}. konverzácia)`)
    },
  )
  await flush()
  if (!chats) throw new UserError('V exporte z Telegramu som nenašiel žiadne správy.')
  return { me: selfName }
}
