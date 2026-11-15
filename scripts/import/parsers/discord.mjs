/**
 * Discord.
 *
 * Official data package ("Request all of my Data"): it holds ONLY the messages the user sent.
 *   Messages/index.json                 channel id → "Direct Message with name#0000" / "general in Server"
 *   Messages/c<id>/channel.json         { id, type, name?, guild?, recipients? }
 *   Messages/c<id>/messages.json        [{ ID, Timestamp, Contents, Attachments }]   (older: messages.csv)
 *   Account/user.json                   { username, global_name, ... }
 * Folder names are capitalised in new packages and lower case in old ones.
 *
 * DiscordChatExporter JSON (both sides of a conversation):
 *   { guild, channel: { id, type, name }, messages: [{ timestamp, content, author: { name, nickname }, attachments }] }
 */
import { basename, dirname } from 'node:path'
import { UserError, csvRows, iso, scanJson } from '../util.mjs'
import { ME_HINT, guessSelf } from './common.mjs'

const CHANNEL_RE = /(?:^|\/)messages\/(c?\d+)\/messages\.(json|csv)$/i
const INDEX_RE = /(?:^|\/)messages\/index\.json$/i
const USER_RE = /(?:^|\/)account\/user\.json$/i

async function exporterFiles(src) {
  const out = []
  const json = src.entries.filter((e) => /\.json$/i.test(e.name) && !CHANNEL_RE.test(e.name))
  for (const e of json.slice(0, 400)) {
    try {
      const head = await src.head(e.name, 1500)
      if (/"guild"\s*:/.test(head) && /"channel"\s*:/.test(head)) out.push(e)
      else if (out.length === 0 && json.indexOf(e) >= 3) break
    } catch {
      // not readable
    }
  }
  return out
}

export async function sniff(src) {
  const channels = src.entries.filter((e) => CHANNEL_RE.test(e.name))
  if (channels.length && (src.find(INDEX_RE) || src.find(USER_RE) || channels.length > 1)) {
    let user = null
    const u = src.find(USER_RE)
    if (u && u.size < 20_000_000) {
      try {
        const data = await src.json(u.name)
        user = data.global_name || data.username || null
      } catch {
        // optional
      }
    }
    return { source: 'discord', confidence: 0.95, details: { format: 'package', threads: channels.length, user } }
  }
  const files = await exporterFiles(src)
  if (files.length) return { source: 'discord', confidence: 0.85, details: { format: 'exporter', threads: files.length, user: null } }
  return null
}

const KIND = { 1: 'dm', DM: 'dm', 3: 'group', GROUP_DM: 'group' }
const stamp = (raw) => {
  let s = String(raw ?? '').trim()
  if (!s) return null
  s = s.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1')
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += 'Z'
  const ms = Date.parse(s)
  // whole seconds, so the package and a DiscordChatExporter file of the same channel line up
  return Number.isNaN(ms) ? null : iso(Math.floor(ms / 1000) * 1000)
}
const attachType = (a) => (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(a) ? 'photo' : /\.(mp4|mov|webm)(\?|$)/i.test(a) ? 'video' : /\.(mp3|ogg|wav|m4a)(\?|$)/i.test(a) ? 'audio' : 'share')

async function runPackage(ctx) {
  const { src } = ctx
  const channels = src.entries.filter((e) => CHANNEL_RE.test(e.name))
  let me = ctx.options.me || null
  let handle = null
  const u = src.find(USER_RE)
  if (u) {
    try {
      const data = await src.json(u.name)
      handle = data.username || null
      me = me || data.global_name || data.username || null
    } catch {
      ctx.warn('Súbor s údajmi o účte sa nedal prečítať.')
    }
  }
  me = me || ctx.identity.me[0] || 'ja'
  let index = {}
  const ix = src.find(INDEX_RE)
  if (ix) {
    try {
      index = await src.json(ix.name)
    } catch {
      // titles fall back to channel.json
    }
  }
  let done = 0
  for (const entry of channels) {
    done++
    ctx.progress(0.05 + 0.9 * (done / channels.length), `Čítam kanály a súkromné správy (${done} z ${channels.length})`)
    const folder = basename(dirname(entry.name))
    const id = folder.replace(/^c/i, '')
    let channel = {}
    const chEntry = src.get(`${dirname(entry.name)}/channel.json`)
    if (chEntry) {
      try {
        channel = await src.json(chEntry.name)
      } catch {
        // title from the index only
      }
    }
    const rows = []
    try {
      if (/\.csv$/i.test(entry.name)) {
        let header = null
        for await (const row of csvRows(src.stream(entry.name))) {
          if (!header) {
            header = row.map((h) => h.trim().toLowerCase())
            continue
          }
          const get = (k) => row[header.indexOf(k)] ?? ''
          rows.push({ Timestamp: get('timestamp'), Contents: get('contents'), Attachments: get('attachments') })
        }
      } else rows.push(...(await src.json(entry.name)))
    } catch {
      ctx.warn(`Kanál ${folder} sa nedal prečítať, preskočil som ho.`)
      continue
    }
    const messages = []
    for (const r of rows) {
      const t = stamp(r.Timestamp)
      if (!t) continue
      const text = String(r.Contents ?? '')
      const attach = String(r.Attachments ?? '').trim()
      if (!text && !attach) continue
      messages.push({ t, from: me, me: true, text, type: text ? 'text' : attachType(attach) })
    }
    if (!messages.length) continue
    const kind = KIND[channel.type] ?? (channel.guild ? 'channel' : /^Direct Message with /i.test(index[id] ?? '') ? 'dm' : 'channel')
    let title = index[id] || (channel.name ? `${channel.name}${channel.guild?.name ? ` in ${channel.guild.name}` : ''}` : '') || `Kanál ${id}`
    const participants = [me]
    if (kind === 'dm') {
      const other = /^Direct Message with (.+)$/i.exec(title)?.[1]?.replace(/#0+$/, '').trim()
      if (other && !/^unknown participant$/i.test(other)) {
        participants.push(other)
        title = other
      }
    }
    await ctx.put({ id: `c${id}`, title, kind, participants, self: me }, messages)
  }
  ctx.warn('Balík z Discordu obsahuje len správy, ktoré si napísal ty. Odpovede druhej strany v ňom nie sú.')
  return { me, handle }
}

async function runExporter(ctx) {
  const { src } = ctx
  const files = await exporterFiles(src)
  let self = null
  let done = 0
  for (const entry of files) {
    done++
    ctx.progress(0.05 + 0.9 * ((done - 1) / files.length), `Čítam konverzácie (${done} z ${files.length})`)
    let guild = null
    let channel = null
    const raw = []
    await scanJson(
      src.stream(entry.name),
      (p) => (p.length === 1 && (p[0] === 'guild' || p[0] === 'channel')) || (p.length === 2 && p[0] === 'messages'),
      (p, v) => {
        if (p[0] === 'guild') guild = v
        else if (p[0] === 'channel') channel = v
        else raw.push(v)
      },
    )
    if (!channel || !raw.length) continue
    const type = String(channel.type ?? '')
    const kind = /^DirectTextChat$/i.test(type) || type === '1' ? 'dm' : /^DirectGroupTextChat$/i.test(type) || type === '3' ? 'group' : 'channel'
    const names = [...new Set(raw.map((m) => m.author?.name).filter(Boolean))]
    const display = new Map(raw.filter((m) => m.author?.name).map((m) => [m.author.name, m.author.nickname || m.author.name]))
    let me = await guessSelf(names, { override: ctx.options.me, known: ctx.identity.me, title: kind === 'dm' ? channel.name : null })
    if (!me) me = [...display].find(([, nick]) => ctx.identity.me.includes(nick))?.[0] ?? null
    if (!me && kind !== 'channel') ctx.warn(`${ME_HINT} V konverzácii píšu: ${names.slice(0, 6).join(', ')}.`)
    // own messages go under the name the data package uses, so both kinds of export merge
    const selfName = me ? (ctx.identity.me.find((k) => k === me || k === display.get(me)) ?? me) : null
    self = self ?? selfName
    const messages = []
    for (const m of raw) {
      const t = stamp(m.timestamp)
      if (!t) continue
      const author = m.author?.name ?? 'Neznámy'
      const mine = Boolean(me) && author === me
      const text = String(m.content ?? '')
      const attach = m.attachments?.[0]?.fileName ?? m.attachments?.[0]?.url ?? ''
      if (/^(RecipientAdd|RecipientRemove|ChannelPinnedMessage|GuildMemberJoin|ChannelNameChange)$/i.test(String(m.type ?? ''))) continue
      if (!text && !attach) continue
      messages.push({ t, from: mine ? selfName : author, me: mine, text, type: /^Call$/i.test(String(m.type ?? '')) ? 'call' : text ? 'text' : attachType(attach) })
    }
    const title = kind === 'channel' ? `${channel.name}${guild?.name ? ` in ${guild.name}` : ''}` : channel.name
    const participants = [...new Set(messages.map((m) => m.from))]
    await ctx.put({ id: `c${channel.id}`, title, kind, participants, self: selfName }, messages)
  }
  return { me: self }
}

export async function run(ctx) {
  if (ctx.det.details.format === 'package') return runPackage(ctx)
  if (ctx.det.details.format === 'exporter') return runExporter(ctx)
  throw new UserError('V tomto súbore som nenašiel správy z Discordu.')
}
