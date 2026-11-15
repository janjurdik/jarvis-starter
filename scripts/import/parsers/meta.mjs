/**
 * Instagram and Facebook / Messenger (Meta "Export your information", JSON format).
 *
 *   your_instagram_activity/messages/inbox/<thread>/message_N.json       (older: messages/inbox/...)
 *   your_facebook_activity/messages/{inbox,archived_threads,e2ee_cutover,filtered_threads}/<thread>/message_N.json
 *   <thread>/message_N.json                                              (single conversation download)
 *   <Name>_<n>.json at the root + media/                                 (Messenger encrypted chat backup)
 *
 * Meta writes UTF-8 bytes as latin1 code points, so every name and text is repaired first.
 * The HTML format (Meta's default) cannot be imported: the user gets a clear instruction.
 */
import { basename, dirname } from 'node:path'
import { UserError, fixMojibake, fold, iso, normName, oneLine, safeId, shortHash } from '../util.mjs'

const SECTIONS = 'inbox|archived_threads|filtered_threads|e2ee_cutover'
const THREAD_RE = new RegExp(`(?:^|/)messages/(${SECTIONS}|message_requests)/([^/]+)/message_(\\d+)\\.(json|html)$`, 'i')
const MEDIA_RE = new RegExp(`(?:^|/)messages/(?:${SECTIONS})/[^/]+/(?:photos|videos|audio|gifs|files)/[^/]+$`, 'i')
const SINGLE_RE = /(?:^|\/)([^/]+)\/message_(\d+)\.json$/i
const HTML_HINT = /(?:^|\/)messages\/(?:inbox|e2ee_cutover|archived_threads)\/[^/]+\/message_\d+\.html$|(?:^|\/)your_(?:instagram|facebook)_activity\/.*\.html$|(?:^|\/)start_here\.html$/i

const HTML_HELP = (app) =>
  `Tento export z ${app} je vo formáte HTML a ten sa nedá načítať. Požiadaj o nový export a pri nastavení zmeň položku „Formát" z HTML na JSON ` +
  '(Centrum účtov → Vaše informácie a povolenia → Exportujte svoje informácie → Vytvoriť export → Exportovať do zariadenia → Formát: JSON, Rozsah dátumov: Celé obdobie). ' +
  'Keď príde nový súbor, pretiahni ho sem znova.'

function platformOf(src) {
  let ig = 0
  let fb = 0
  for (const p of src.paths) {
    if (/instagram/i.test(basename(p))) ig += 1000
    if (/facebook|messenger/i.test(basename(p))) fb += 1000
  }
  for (const e of src.entries) {
    const n = e.name
    if (/(?:^|\/)your_instagram_activity\/|(?:^|\/)followers_and_following\/|instagram_profile_information|(?:^|\/)personal_information\/personal_information/i.test(n)) ig++
    else if (/(?:^|\/)your_facebook_activity\/|(?:^|\/)profile_information\/profile_information|(?:^|\/)friends_and_followers\/|(?:^|\/)e2ee_cutover\//i.test(n)) fb++
  }
  return ig > fb ? 'instagram' : 'facebook'
}

/** Own display name and username from the profile files of the export, when they are there. */
export async function metaProfile(src) {
  const out = { name: null, username: null }
  const ig = src.find(/(?:^|\/)personal_information(?:\/personal_information)?\/personal_information\.json$/i) ?? src.find(/(?:^|\/)account_information\/personal_information\.json$/i)
  if (ig && ig.size < 2_000_000) {
    try {
      const data = await src.json(ig.name)
      const map = data?.profile_user?.[0]?.string_map_data ?? {}
      for (const [rawKey, val] of Object.entries(map)) {
        const key = fold(fixMojibake(rawKey))
        const value = fixMojibake(val?.value ?? '')
        if (!value) continue
        if (/^(username|pouzivatelske meno|uzivatelske jmeno|meno pouzivatela)$/.test(key)) out.username = value
        else if (/^(name|meno|jmeno)$/.test(key)) out.name = value
      }
    } catch {
      // profile file is optional
    }
  }
  const fb = src.find(/(?:^|\/)profile_information\/profile_information\.json$/i)
  if (fb && fb.size < 5_000_000 && !out.name) {
    try {
      const data = await src.json(fb.name)
      out.name = fixMojibake(data?.profile_v2?.name?.full_name ?? data?.profile?.name?.full_name ?? '') || null
      out.username = out.username ?? (String(data?.profile_v2?.profile_uri ?? '').match(/facebook\.com\/([^/?#]+)/)?.[1] ?? null)
    } catch {
      // optional
    }
  }
  if (!out.username) {
    const m = /^(?:instagram|facebook)-([^-]+(?:-[^-\d][^-]*)*)-\d{4}-\d{2}-\d{2}/i.exec(basename(src.path))
    if (m) out.username = m[1]
  }
  return out
}

/** Root level "<Name>_<n>.json" files of the Messenger encrypted chat backup. */
async function backupFiles(src) {
  const roots = src.entries.filter((e) => /^(?:[^/]+\/)?[^/]+\.json$/i.test(e.name) && !/(?:^|\/)(conversations|projects|users|memories|result|user|index|manifest)[^/]*\.json$/i.test(e.name))
  if (!roots.length) return []
  for (const sample of roots.slice(0, 3)) {
    try {
      const head = await src.head(sample.name, 3000)
      if (/"threadName"\s*:/.test(head) || (/"senderName"\s*:/.test(head) && /"participants"\s*:/.test(head))) return roots
    } catch {
      // not readable: not this format
    }
  }
  return []
}

export async function sniff(src) {
  const threads = new Set()
  let json = 0
  let html = 0
  for (const e of src.entries) {
    const m = THREAD_RE.exec(e.name)
    if (!m) continue
    if (m[4].toLowerCase() === 'json') {
      json++
      if (m[1].toLowerCase() !== 'message_requests') threads.add(`${m[1]}/${m[2]}`)
    } else html++
  }
  if (json || html) {
    const source = platformOf(src)
    const profile = await metaProfile(src)
    return {
      source,
      confidence: json ? 0.95 : 0.9,
      details: { format: json ? 'json' : 'html', threads: threads.size, user: profile.username ?? profile.name ?? null, name: profile.name ?? null },
    }
  }
  // a part of a multi-part export that carries only the photos and videos of the conversations
  const media = src.entries.filter((e) => MEDIA_RE.test(e.name)).length
  if (media) return { source: platformOf(src), confidence: 0.9, details: { format: 'media', threads: 0, files: media, user: null } }
  const backup = await backupFiles(src)
  if (backup.length) return { source: 'facebook', confidence: 0.85, details: { format: 'e2ee', threads: backup.length, user: null, note: 'Záloha šifrovaných četov Messengera' } }

  // one conversation downloaded on its own: <thread>/message_1.json
  const single = src.entries.filter((e) => SINGLE_RE.test(e.name) || /^message_\d+\.json$/i.test(e.name))
  if (single.length) {
    try {
      const head = await src.head(single[0].name, 2000)
      if (/"participants"\s*:/.test(head) && /"(sender_name|messages)"\s*:/.test(head)) {
        return { source: platformOf(src), confidence: 0.7, details: { format: 'json', threads: new Set(single.map((e) => dirname(e.name))).size, user: null, single: true } }
      }
    } catch {
      // fall through
    }
  }
  // an HTML export without any message folder still deserves the clear instruction
  if (src.entries.some((e) => HTML_HINT.test(e.name)) && src.entries.some((e) => /your_(instagram|facebook)_activity\//i.test(e.name))) {
    return { source: platformOf(src), confidence: 0.8, details: { format: 'html', threads: 0, user: null } }
  }
  // Messenger chat backup that does not look like anything known: say so instead of guessing
  if (src.kind === 'zip' && /^messages(\s*\(\d+\))?\.zip$/i.test(basename(src.path))) {
    return { source: 'facebook', confidence: 0.4, details: { format: 'unknown-backup', threads: 0, user: null } }
  }
  return null
}

const DURATION = (s) => (Number(s) > 0 ? ` (${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')})` : '')

/** One message of the classic export → archive message (or null for empty and unsent ones). */
function convert(m, self) {
  const t = iso(m.timestamp_ms)
  if (!t || m.is_unsent) return null
  const from = fixMojibake(m.sender_name ?? '') || 'Neznámy'
  let text = fixMojibake(m.content ?? '')
  let type = 'text'
  let photo = null
  if (m.photos?.length) {
    type = 'photo'
    photo = m.photos[0]?.uri ?? null
  } else if (m.videos?.length) type = 'video'
  else if (m.audio_files?.length) type = 'audio'
  else if (m.gifs?.length) type = 'photo'
  else if (m.sticker) type = 'sticker'
  else if (m.share) {
    type = 'share'
    const extra = oneLine(fixMojibake(m.share.share_text ?? ''), 400)
    text = [text, extra && extra !== text ? extra : '', m.share.link ?? ''].filter(Boolean).join('\n')
  } else if (m.call_duration !== undefined || m.type === 'Call') {
    type = 'call'
    text = text || `Hovor${DURATION(m.call_duration)}`
  } else if (m.files?.length) {
    type = 'share'
    text = text || basename(String(m.files[0]?.uri ?? ''))
  } else if (m.type === 'Subscribe' || m.type === 'Unsubscribe') type = 'system'
  if (type === 'text') {
    if (!text) return null
    if (/^(Liked a message|Reacted .{1,12} to your message ?|.{1,60} liked a message)$/i.test(text)) type = 'system'
  }
  const out = { t, from, me: from === self, text, type }
  if (photo) out.photo = photo
  if (m.reactions?.length) out.reactions = m.reactions.slice(0, 12).map((r) => ({ from: fixMojibake(r.actor ?? ''), emoji: fixMojibake(r.reaction ?? '') }))
  return out
}

/** One message of the encrypted chat backup (already proper UTF-8). */
function convertBackup(m, self) {
  const t = iso(m.timestamp ?? m.timestamp_ms)
  if (!t || m.isUnsent) return null
  const from = String(m.senderName ?? '') || 'Neznámy'
  const text = String(m.text ?? '')
  const uri = m.media?.[0]?.uri ?? null
  let type = 'text'
  if (uri) type = /\.(jpe?g|png|webp|heic|gif)$/i.test(uri) ? 'photo' : /\.(mp4|mov|webm)$/i.test(uri) ? 'video' : /\.(mp3|m4a|aac|ogg|opus|wav)$/i.test(uri) ? 'audio' : 'share'
  else if (m.type === 'link') type = 'share'
  else if (m.type === 'placeholder') type = 'system'
  if (type === 'text' && !text) return null
  const out = { t, from, me: from === self, text, type }
  if (type === 'photo') out.photo = String(uri).replace(/^\.\//, '')
  if (m.reactions?.length) out.reactions = m.reactions.slice(0, 12).map((r) => ({ from: String(r.actor ?? ''), emoji: String(r.reaction ?? '') }))
  return out
}

/** The participant who is in most conversations is the owner of the export. */
function mostCommon(lists, prefer = []) {
  const count = new Map()
  for (const names of lists) for (const n of new Set(names)) count.set(n, (count.get(n) ?? 0) + 1)
  if (!count.size) return null
  for (const p of prefer) {
    if (!p) continue
    const hit = [...count.keys()].find((n) => n === p) ?? [...count.keys()].find((n) => normName(n) === normName(p))
    if (hit) return hit
  }
  const sorted = [...count].sort((a, b) => b[1] - a[1])
  // one conversation only: both sides appear once, so there is nothing to tell them apart
  if (lists.length < 2 || (sorted[1] && sorted[1][1] === sorted[0][1])) return null
  return sorted[0][0]
}

export async function run(ctx) {
  const { src, det } = ctx
  const app = det.source === 'instagram' ? 'Instagramu' : 'Facebooku'
  if (det.details.format === 'html') throw new UserError(HTML_HELP(app))
  if (det.details.format === 'unknown-backup') {
    throw new UserError('Toto vyzerá ako záloha četov z Messengera, ale v podobe, ktorú zatiaľ nepoznám. Rozbaľ ju a pretiahni sem priečinok s rozbalenými súbormi, alebo mi povedz, čo v nej je.')
  }
  if (det.details.format === 'e2ee') return runBackup(ctx)
  if (det.details.format === 'media') {
    ctx.progress(0.5, 'Dopĺňam fotky k načítaným konverzáciám')
    return { me: null, mediaOnly: true }
  }

  // group message files by conversation folder
  const threads = new Map()
  let requests = 0
  for (const e of src.entries) {
    let section
    let folder
    const m = THREAD_RE.exec(e.name)
    if (m) {
      if (m[4].toLowerCase() !== 'json') continue
      if (m[1].toLowerCase() === 'message_requests') {
        requests++
        continue
      }
      section = m[1].toLowerCase()
      folder = m[2]
    } else if (det.details.single) {
      const s = SINGLE_RE.exec(e.name)
      if (!s && !/^message_\d+\.json$/i.test(e.name)) continue
      section = 'inbox'
      folder = s ? s[1] : basename(src.path).replace(/\.zip$/i, '')
    } else continue
    const key = folder
    if (!threads.has(key)) threads.set(key, { folder, section, files: [], dir: dirname(e.name) })
    threads.get(key).files.push(e)
  }
  if (!threads.size) throw new UserError(`V tomto exporte z ${app} nie sú žiadne správy. Pri vytváraní exportu treba zaškrtnúť „Správy" a formát JSON.`)
  if (src.entries.some((e) => THREAD_RE.test(e.name) && /\.html$/i.test(e.name))) ctx.warn('Časť exportu je vo formáte HTML, tú som preskočil. Načítal som len súbory JSON.')

  // who is the owner: the profile file, or the name present in most conversations
  ctx.progress(0.02, 'Zisťujem, kto si v konverzáciách ty')
  const profile = await metaProfile(src)
  const firstFiles = [...threads.values()].map((t) => t.files.find((f) => /message_1\.json$/i.test(f.name)) ?? t.files[0]).sort((a, b) => a.size - b.size).slice(0, 300)
  const lists = []
  for (const f of firstFiles) {
    try {
      const data = await src.json(f.name)
      lists.push((data.participants ?? []).map((p) => fixMojibake(p.name ?? '')).filter(Boolean))
    } catch {
      // unreadable file is reported later
    }
  }
  const self = mostCommon(lists, [ctx.options.me, profile.name, ...ctx.identity.me])
  if (!self) ctx.warn('Neviem určiť, ktoré správy sú tvoje. Spusti import znova a zadaj svoje meno tak, ako ho máš v profile.')

  const all = [...threads.values()]
  let done = 0
  for (const th of all) {
    done++
    ctx.progress(0.05 + 0.9 * (done / all.length), `Čítam konverzácie (${done} z ${all.length})`)
    const messages = []
    let title = ''
    let participants = []
    let group = false
    for (const f of th.files) {
      let data
      try {
        data = await src.json(f.name)
      } catch {
        ctx.warn(`Súbor ${f.name} sa nedal prečítať, preskočil som ho.`)
        continue
      }
      title = title || fixMojibake(data.title ?? '')
      if (!participants.length) participants = (data.participants ?? []).map((p) => fixMojibake(p.name ?? '')).filter(Boolean)
      if (data.joinable_mode) group = true
      for (const m of data.messages ?? []) {
        const msg = convert(m, self)
        if (!msg) continue
        if (msg.photo) {
          const local = `${th.dir}/photos/${basename(msg.photo)}`
          msg.photo = src.has(local) ? local : msg.photo
        }
        messages.push(msg)
      }
    }
    if (!messages.length) continue
    const kind = group || participants.length > 2 ? 'group' : 'dm'
    if (kind === 'dm' && self && !participants.some((p) => p !== self) && title && title !== self) participants.push(title)
    await ctx.put({ id: th.folder, title: title || participants.filter((p) => p !== self).join(', '), kind, participants, self }, messages)
  }
  if (requests) ctx.warn('Žiadosti o správy od cudzích ľudí som vynechal.')
  if (det.source === 'facebook' && [...threads.values()].some((t) => t.section === 'e2ee_cutover')) {
    ctx.warn('Hlavný export z Facebooku obsahuje šifrované čety len po deň, keď sa zapli. Novšie správy sú v samostatnej zálohe: facebook.com → Messenger → Možnosti → História četu → Stiahnuť zálohu četu. Ten súbor sem potom pretiahni tiež.')
  }
  return { me: self, handle: profile.username }
}

async function runBackup(ctx) {
  const { src } = ctx
  const files = await backupFiles(src)
  ctx.progress(0.02, 'Zisťujem, kto si v konverzáciách ty')
  const parsed = []
  let done = 0
  for (const f of files) {
    done++
    ctx.progress(0.05 + 0.4 * (done / files.length), `Čítam zálohu Messengera (${done} z ${files.length})`)
    let data
    try {
      data = await src.json(f.name)
    } catch {
      ctx.warn(`Súbor ${f.name} sa nedal prečítať, preskočil som ho.`)
      continue
    }
    if (!Array.isArray(data?.messages)) continue
    const participants = (data.participants ?? []).map((p) => (typeof p === 'string' ? p : p?.name)).filter(Boolean)
    parsed.push({ file: f, data, participants })
  }
  if (!parsed.length) throw new UserError('V zálohe četov z Messengera som nenašiel žiadne správy.')
  const self = mostCommon(parsed.map((p) => p.participants), [ctx.options.me, ...ctx.identity.me])
  if (!self) ctx.warn('Neviem určiť, ktoré správy sú tvoje. Spusti import znova a zadaj svoje meno tak, ako ho máš na Facebooku.')
  done = 0
  const root = dirname(parsed[0].file.name) === '.' ? '' : `${dirname(parsed[0].file.name)}/`
  for (const { data, participants, file } of parsed) {
    done++
    ctx.progress(0.45 + 0.5 * (done / parsed.length), `Ukladám konverzácie (${done} z ${parsed.length})`)
    const messages = []
    for (const m of data.messages) {
      const msg = convertBackup(m, self)
      if (!msg) continue
      if (msg.photo) msg.photo = `${root}${msg.photo}`
      messages.push(msg)
    }
    if (!messages.length) continue
    const title = String(data.threadName ?? '') || basename(file.name, '.json').replace(/_\d+$/, '')
    const kind = participants.length > 2 ? 'group' : 'dm'
    // the number in the file name changes between downloads, so the id comes from the people in it
    const id = `e2ee-${safeId(title).slice(0, 50)}-${shortHash([...participants].sort().join('|'))}`
    await ctx.put({ id, title, kind, participants, self }, messages)
  }
  return { me: self }
}
