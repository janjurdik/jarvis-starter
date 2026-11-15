/**
 * Conversations with other AI assistants: ChatGPT and Claude.
 *
 * ChatGPT   conversations.json, or shards conversations-000.json, conversations-001.json ... in
 *           large accounts. Each conversation is a tree (`mapping`): the visible branch is the
 *           path from `current_node` up through the parents. Extra files: user.json and others.
 * Claude    conversations.json ({ uuid, name, chat_messages: [{ sender: human|assistant, text,
 *           content: [blocks] }] }), users.json, memories.json and projects (projects.json or
 *           one file per project in projects/).
 *
 * Besides the threads (kind "ai") a digest of the user's own words is written to
 * archiv/digests/_chatgpt.md or _claude.md, so a later Claude job can pull facts about the user.
 */
import { join } from 'node:path'
import { writeFileAtomic } from '../../../hud/server/util.mjs'
import { ARCHIVE_DIR, DIGEST_DIR, UserError, day, fmtInt, iso, oneLine, readJson, scanJsonArray, writeJson } from '../util.mjs'

const CONV_RE = /(?:^|\/)conversations(?:[-_]\d+)?\.json$/i
const DIGEST_CONVERSATIONS = 400
const DIGEST_CHARS = 60_000

const convFiles = (src) => src.entries.filter((e) => CONV_RE.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))

export async function sniff(src) {
  const files = convFiles(src)
  if (!files.length) return null
  const head = await src.head(files[0].name, 60_000).catch(() => '')
  const isGpt = /"mapping"\s*:/.test(head)
  const isClaude = /"chat_messages"\s*:/.test(head)
  if (!isGpt && !isClaude) {
    // an empty or unusual first file: the neighbours decide
    if (src.find(/(?:^|\/)(chat\.html|message_feedback\.json|shared_conversations\.json)$/i)) return { source: 'chatgpt', confidence: 0.7, details: { files: files.length, user: null } }
    if (src.find(/(?:^|\/)users\.json$/i) && src.find(/(?:^|\/)projects\.json$/i)) return { source: 'claude', confidence: 0.7, details: { files: files.length, user: null } }
    return null
  }
  let user = null
  const u = src.find(isGpt ? /(?:^|\/)user\.json$/i : /(?:^|\/)users\.json$/i)
  if (u && u.size < 1_000_000) {
    try {
      const data = await src.json(u.name)
      user = isGpt ? (data.email ?? null) : (data?.[0]?.full_name ?? data?.[0]?.email_address ?? null)
    } catch {
      // optional
    }
  }
  return { source: isGpt ? 'chatgpt' : 'claude', confidence: 0.95, details: { files: files.length, user } }
}

// ── ChatGPT ────────────────────────────────────────────────────────────

/** Text of one ChatGPT message, or '' when it is not something the two sides said. */
function gptText(msg) {
  const c = msg?.content
  if (!c) return ''
  if (c.content_type === 'text' || c.content_type === 'multimodal_text') {
    return (c.parts ?? [])
      .map((p) => {
        if (typeof p === 'string') return p
        if (p?.content_type === 'audio_transcription') return p.text ?? ''
        if (p?.content_type === 'image_asset_pointer') return '[obrázok]'
        return typeof p?.text === 'string' ? p.text : ''
      })
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  return ''
}

/** Visible branch of the conversation tree, oldest first. */
function gptBranch(conv) {
  const mapping = conv.mapping ?? {}
  let node = conv.current_node && mapping[conv.current_node] ? conv.current_node : null
  if (!node) {
    // no pointer: take the newest leaf
    let best = -1
    for (const [id, n] of Object.entries(mapping)) {
      if (n?.children?.length) continue
      const at = n?.message?.create_time ?? 0
      if (at >= best) {
        best = at
        node = id
      }
    }
  }
  const out = []
  const guard = new Set()
  while (node && mapping[node] && !guard.has(node)) {
    guard.add(node)
    out.push(mapping[node])
    node = mapping[node].parent
  }
  return out.reverse()
}

async function runChatGPT(ctx) {
  const { src } = ctx
  const files = convFiles(src)
  const total = files.reduce((s, f) => s + f.size, 0) || 1
  const digest = []
  const memories = []
  const instructions = new Set()
  let seenBytes = 0
  let count = 0
  for (const file of files) {
    let fileCount = 0
    await scanJsonArray(src.stream(file.name), async (conv) => {
      if (!conv || typeof conv !== 'object' || !conv.mapping) return
      count++
      fileCount++
      const id = conv.conversation_id ?? conv.id ?? `c${count}`
      const fallback = (conv.create_time ?? conv.update_time ?? 0) * 1000
      const messages = []
      let last = fallback
      for (const node of gptBranch(conv)) {
        const msg = node.message
        if (!msg) continue
        const role = msg.author?.role
        const c = msg.content
        if (c?.content_type === 'user_editable_context') {
          for (const v of [c.user_profile, c.user_instructions]) if (typeof v === 'string' && v.trim()) instructions.add(v.trim())
          continue
        }
        if (role === 'assistant' && msg.recipient === 'bio') {
          // the memory tool: what ChatGPT decided to remember about the user
          const t = gptText(msg) || (typeof c?.text === 'string' ? c.text : '')
          if (t) memories.push(oneLine(t, 400))
          continue
        }
        if (role !== 'user' && role !== 'assistant') continue
        if (msg.metadata?.is_visually_hidden_from_conversation) continue
        if (role === 'assistant' && msg.recipient && msg.recipient !== 'all') continue
        const text = gptText(msg)
        if (!text) continue
        const at = msg.create_time ? msg.create_time * 1000 : last + 1000
        last = at
        const t = iso(at)
        if (!t) continue
        messages.push({ t, from: role === 'user' ? 'ja' : 'ChatGPT', me: role === 'user', text, type: 'text' })
      }
      if (!messages.length) return
      const title = conv.title || oneLine(messages.find((m) => m.me)?.text ?? 'Rozhovor', 60)
      await ctx.put({ id, title, kind: 'ai', participants: ['ja', 'ChatGPT'], self: 'ja' }, messages)
      digest.push({ id, at: iso((conv.update_time ?? conv.create_time ?? 0) * 1000) ?? messages[messages.length - 1].t, title, first: oneLine(messages.find((m) => m.me)?.text ?? '', 320), mine: messages.filter((m) => m.me).length })
      if (count % 25 === 0) ctx.progress(Math.min(0.95, 0.03 + 0.92 * ((seenBytes + file.size * 0.5) / total)), `Čítam rozhovory s ChatGPT (${fmtInt(count)})`)
    })
    seenBytes += file.size
    if (!fileCount && files.length === 1) throw new UserError('V súbore conversations.json nie sú žiadne rozhovory.')
  }
  const extra = {}
  const user = src.find(/(?:^|\/)user\.json$/i)
  if (user && user.size < 1_000_000) {
    try {
      const data = await src.json(user.name)
      const keep = Object.entries(data).filter(([k, v]) => typeof v !== 'object' && !/phone|birth|id$/i.test(k))
      if (keep.length) extra['Účet'] = keep.map(([k, v]) => `- ${k}: ${v}`).join('\n')
    } catch {
      // optional
    }
  }
  for (const e of src.entries.filter((x) => /memor/i.test(x.name) && /\.(json|txt|md)$/i.test(x.name) && x.size < 2_000_000).slice(0, 5)) {
    try {
      extra[`Súbor ${e.name}`] = (await src.text(e.name)).slice(0, 12_000)
    } catch {
      // optional
    }
  }
  const path = await writeDigest('chatgpt', 'ChatGPT', digest, extra, { instructions: [...instructions].map((t) => t.slice(0, 3000)), memories: [...new Set(memories)] })
  ctx.digest(path)
  return { me: 'ja' }
}

// ── Claude ─────────────────────────────────────────────────────────────

function claudeText(m) {
  if (Array.isArray(m.content) && m.content.length) {
    const t = m.content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (t) return t
  }
  return String(m.text ?? '').trim()
}

async function runClaude(ctx) {
  const { src } = ctx
  const files = convFiles(src)
  const total = files.reduce((s, f) => s + f.size, 0) || 1
  const digest = []
  let seenBytes = 0
  let count = 0
  for (const file of files) {
    await scanJsonArray(src.stream(file.name), async (conv) => {
      if (!conv || typeof conv !== 'object' || !Array.isArray(conv.chat_messages)) return
      count++
      const messages = []
      let last = Date.parse(conv.created_at) || 0
      for (const m of conv.chat_messages) {
        const human = m.sender === 'human'
        if (!human && m.sender !== 'assistant') continue
        let text = claudeText(m)
        const attached = [...(m.attachments ?? []), ...(m.files ?? [])].map((a) => a?.file_name).filter(Boolean)
        if (attached.length) text = `${text}${text ? '\n' : ''}[prílohy: ${attached.slice(0, 6).join(', ')}]`
        if (!text) continue
        const at = Date.parse(m.created_at) || last + 1000
        last = at
        const t = iso(at)
        if (!t) continue
        messages.push({ t, from: human ? 'ja' : 'Claude', me: human, text, type: 'text' })
      }
      if (!messages.length) return
      const title = conv.name || oneLine(messages.find((m) => m.me)?.text ?? 'Rozhovor', 60)
      await ctx.put({ id: conv.uuid ?? `c${count}`, title, kind: 'ai', participants: ['ja', 'Claude'], self: 'ja' }, messages)
      digest.push({ id: conv.uuid ?? `c${count}`, at: iso(Date.parse(conv.updated_at ?? conv.created_at)) ?? messages[messages.length - 1].t, title, first: oneLine(messages.find((m) => m.me)?.text ?? '', 320), mine: messages.filter((m) => m.me).length, summary: typeof conv.summary === 'string' ? conv.summary : '' })
      if (count % 25 === 0) ctx.progress(Math.min(0.95, 0.03 + 0.92 * ((seenBytes + file.size * 0.5) / total)), `Čítam rozhovory s Claudom (${fmtInt(count)})`)
    })
    seenBytes += file.size
  }
  const extra = {}
  let name = null
  const users = src.find(/(?:^|\/)users\.json$/i)
  if (users && users.size < 1_000_000) {
    try {
      const data = await src.json(users.name)
      name = data?.[0]?.full_name ?? null
      if (name) extra['Účet'] = `- meno: ${name}${data[0].email_address ? `\n- email: ${data[0].email_address}` : ''}`
    } catch {
      // optional
    }
  }
  const memories = src.find(/(?:^|\/)memories\.json$/i)
  if (memories && memories.size < 5_000_000) {
    try {
      const data = await src.json(memories.name)
      const parts = []
      for (const item of Array.isArray(data) ? data : [data]) {
        if (typeof item?.conversations_memory === 'string' && item.conversations_memory.trim()) parts.push(item.conversations_memory.trim())
        for (const [, text] of Object.entries(item?.project_memories ?? {})) if (typeof text === 'string' && text.trim()) parts.push(`Pamäť projektu:\n${text.trim()}`)
      }
      if (parts.length) extra['Čo si Claude o používateľovi zapamätal (memories.json)'] = parts.join('\n\n').slice(0, 20_000)
    } catch {
      ctx.warn('Súbor memories.json sa nedal prečítať.')
    }
  }
  // projects: one projects.json in older exports, one file per project in projects/ in newer ones
  const projectLines = []
  const addProject = (p) => {
    if (!p?.name || p.is_starter_project) return
    const docs = (p.docs ?? []).map((d) => d?.filename).filter(Boolean)
    projectLines.push(`### ${p.name}\n${[p.description && oneLine(p.description, 500), p.prompt_template && `Zadanie projektu: ${oneLine(p.prompt_template, 1200)}`, docs.length && `Dokumenty: ${docs.slice(0, 15).join(', ')}`].filter(Boolean).join('\n')}`)
  }
  const projects = src.find(/(?:^|\/)projects\.json$/i)
  try {
    if (projects && projects.size < 200_000_000) await scanJsonArray(src.stream(projects.name), addProject)
    for (const e of src.filter(/(?:^|\/)projects\/[^/]+\.json$/i).filter((x) => x.size < 30_000_000).slice(0, 200)) addProject(await src.json(e.name))
  } catch {
    ctx.warn('Projekty z exportu sa nedali prečítať celé.')
  }
  if (projectLines.length) extra['Projekty v Claude'] = projectLines.slice(0, 60).join('\n\n')
  if (!count) throw new UserError('V súbore conversations.json nie sú žiadne rozhovory.')
  const path = await writeDigest('claude', 'Claude', digest, extra)
  ctx.digest(path)
  return { me: 'ja', name }
}

/**
 * Digest of the user's side: titles and first questions, newest conversations first.
 * The pieces are kept in archiv/<source>/digest.json, so a second (partial or sharded)
 * export adds to the digest instead of replacing it.
 */
async function writeDigest(source, label, list, extra, lists = {}) {
  const stateFile = join(ARCHIVE_DIR, source, 'digest.json')
  const state = (await readJson(stateFile, null)) ?? { convs: {}, extra: {}, instructions: [], memories: [] }
  for (const c of list) state.convs[c.id] = c
  Object.assign(state.extra, extra)
  state.instructions = [...new Set([...(state.instructions ?? []), ...(lists.instructions ?? [])])].slice(-20)
  state.memories = [...new Set([...(state.memories ?? []), ...(lists.memories ?? [])])].slice(-300)
  await writeJson(stateFile, state)

  const all = Object.values(state.convs)
  const sorted = [...all].sort((a, b) => (a.at < b.at ? 1 : -1))
  const years = new Map()
  for (const c of all) years.set(c.at.slice(0, 4), (years.get(c.at.slice(0, 4)) ?? 0) + 1)
  const sections = Object.entries(state.extra).map(([heading, body]) => `## ${heading}\n\n${body}`)
  if (state.instructions.length) sections.push(`## Vlastné inštrukcie, ktoré mal používateľ nastavené\n\n${state.instructions.join('\n\n')}`)
  if (state.memories.length) sections.push(`## Čo si ${label} o používateľovi zapamätal\n\n${state.memories.slice(-120).map((m) => `- ${m}`).join('\n')}`)
  const head = [
    `# ${label}: o čom sa používateľ rozprával`,
    '',
    `Podklad pre Jarvisa. Vznikol z exportu rozhovorov s ${label}. Obsahuje len to, čo napísal používateľ: názov rozhovoru a jeho prvú správu.`,
    'Úloha: vyčítať z toho trvalé fakty o používateľovi (práca, projekty, záujmy, ľudia, plány) a zapísať ich do pamäte. Nič si nedomýšľať.',
    '',
    `- rozhovorov: ${fmtInt(all.length)}`,
    `- obdobie: ${sorted.length ? `${day(sorted[sorted.length - 1].at)} až ${day(sorted[0].at)}` : 'nič'}`,
    `- po rokoch: ${[...years].sort().map(([y, n]) => `${y}: ${n}`).join(', ') || 'nič'}`,
    '',
    ...(sections.length ? [sections.join('\n\n').slice(0, 25_000), ''] : []),
    `## Rozhovory (najnovších ${Math.min(DIGEST_CONVERSATIONS, sorted.length)})`,
    '',
  ].join('\n')
  let body = ''
  for (const c of sorted.slice(0, DIGEST_CONVERSATIONS)) {
    const line = `- ${day(c.at)} · ${oneLine(c.title, 90)}${c.first ? `: ${oneLine(c.first, 320)}` : ''}${c.summary ? ` (zhrnutie: ${oneLine(c.summary, 200)})` : ''}\n`
    if (head.length + body.length + line.length > DIGEST_CHARS) break
    body += line
  }
  const path = join(DIGEST_DIR, `_${source}.md`)
  await writeFileAtomic(path, `${head}${body}`)
  return path
}

export async function run(ctx) {
  return ctx.det.source === 'chatgpt' ? runChatGPT(ctx) : runClaude(ctx)
}
