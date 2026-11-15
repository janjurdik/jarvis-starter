/**
 * Probe "ai": AI tools the person already uses (Claude Code, Claude and ChatGPT apps, Cursor,
 * Codex, local models) and the connectors Claude already has (mail, calendar, drive…).
 * Tokens and keys in these config files are never read into the result: only names.
 */
import { basename, join } from 'node:path'
import { IS_MAC, IS_WIN, findBin, sh } from '../lib.mjs'
import { installedApps } from './apps.mjs'
import { APPDATA, HOME, MAC_SUPPORT, ago, day, exists, list, names, readJson, readText, sk, some, statOf, uniq } from './util.mjs'

/** What a connector gives, guessed from its name. */
const KINDS = [
  ['mail', /gmail|outlook|\bmail\b|imap|fastmail|proton ?mail/i],
  ['calendar', /calendar|kalend|gcal|cal\.com|calendly/i],
  ['drive', /drive|dropbox|onedrive|\bbox\b|sharepoint/i],
  ['docs', /docs|sheets|slides|office|word|excel/i],
  ['chat', /slack|teams|discord|whatsapp|telegram|beeper|imessage|messenger|signal/i],
  ['notes', /notion|obsidian|evernote|onenote|bear|logseq|craft/i],
  ['tasks', /asana|linear|jira|trello|clickup|todoist|things|ticktick|monday|basecamp|height/i],
  ['code', /github|gitlab|bitbucket|vercel|netlify|cloudflare|supabase|sentry|railway|posthog/i],
  ['design', /figma|canva|framer/i],
  ['meetings', /fireflies|granola|otter|zoom|meet\b|fathom/i],
  ['music', /spotify|apple music/i],
  ['health', /garmin|strava|oura|whoop|fitbit|health/i],
  ['money', /stripe|paypal|revolut|bank|quickbooks|xero/i],
  ['web', /firecrawl|apify|tavily|perplexity|brave|search|browser|chrome|playwright|puppeteer/i],
]
export const connectorKind = (name) => KINDS.find(([, re]) => re.test(name))?.[0] ?? 'other'

const KIND_SK = { mail: 'mail', calendar: 'kalendár', drive: 'súbory v cloude', docs: 'dokumenty', chat: 'správy', notes: 'poznámky', tasks: 'úlohy', code: 'vývoj', design: 'dizajn', meetings: 'meetingy', music: 'hudba', health: 'zdravie', money: 'peniaze', web: 'web' }

export async function ai(ctx) {
  const apps = await installedApps()
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude')
  const claudeJson = readJson(join(HOME, '.claude.json')) ?? readJson(join(claudeDir, '.claude.json'))
  const connectors = new Map()
  const addConnector = (name, source, status = null) => {
    if (!name || typeof name !== 'string') return
    const label = name.replace(/^claude\.ai\s+/i, '').trim()
    const key = label.toLowerCase()
    const prev = connectors.get(key)
    connectors.set(key, { name: label, kind: connectorKind(label), source: prev?.source ?? source, status: status ?? prev?.status ?? null })
  }

  // ── Claude Code ──
  await ctx.step('claude-code', async () => {
    if (!exists(claudeDir)) return
    const projectsDir = join(claudeDir, 'projects')
    const stored = new Set(await names(projectsDir))
    const projects = []
    for (const path of Object.keys(claudeJson?.projects ?? {})) {
      if (path === HOME || /[\\/](tmp|temp|var[\\/]folders|\.claude|worktrees|node_modules)([\\/]|$)/i.test(path)) continue
      const encoded = path.replace(/[^a-zA-Z0-9]/g, '-')
      if (!stored.has(encoded)) continue
      const dir = join(projectsDir, encoded)
      const files = await names(dir)
      const sessions = files.filter((n) => n.endsWith('.jsonl')).length
      if (!sessions) continue
      const memory = (await names(join(dir, 'memory'))).filter((n) => n.endsWith('.md')).length
      projects.push({ name: basename(path), path, exists: exists(path), sessions, memoryNotes: memory, lastActive: statOf(dir)?.mtimeMs ?? 0 })
    }
    projects.sort((a, b) => b.lastActive - a.lastActive)
    const instructions = join(claudeDir, 'CLAUDE.md')
    const hasInstructions = (statOf(instructions)?.size ?? 0) > 20
    const skills = (await list(join(claudeDir, 'skills'))).entries.filter((e) => !e.name.startsWith('.')).map((e) => e.name)
    const agents = (await names(join(claudeDir, 'agents'))).filter((n) => n.endsWith('.md')).length
    const memoryNotes = projects.reduce((n, p) => n + p.memoryNotes, 0)
    const parts = []
    if (projects.length) parts.push(`Claude Code používaš v ${sk(projects.length, 'priečinku', 'priečinkoch', 'priečinkoch')}, naposledy v: ${some(projects.map((p) => p.name), 6)}`)
    else parts.push('Claude Code je nainštalovaný, ale zatiaľ bez histórie práce')
    if (hasInstructions) parts.push('máš napísané vlastné pokyny (CLAUDE.md)')
    if (memoryNotes) parts.push(`Claude si o tvojej práci pamätá ${sk(memoryNotes, 'poznámku', 'poznámky', 'poznámok')}`)
    if (skills.length) parts.push(`máš ${sk(skills.length, 'vlastný skill', 'vlastné skilly', 'vlastných skillov')}`)
    ctx.finding({
      id: 'ai.claude-code',
      category: 'ai',
      title: 'Claude Code',
      detail: `${parts.join(', ')}.`,
      path: claudeDir,
      data: {
        instructions: hasInstructions ? instructions : null,
        projects: projects.slice(0, 40).map((p) => ({ ...p, lastActive: day(p.lastActive) })),
        memoryNotes,
        skills: skills.slice(0, 60),
        agents,
      },
      use: 'Vidím, na čom s Claude pracuješ. Tvoje pokyny a to, čo si už Claude zapamätal, si prevezmem, aby to nebolo treba hovoriť znova.',
      action: 'read',
      weight: projects.length || hasInstructions ? 5 : 2,
    })
    for (const name of Object.keys(claudeJson?.mcpServers ?? {})) addConnector(name, 'claude-code')
    for (const name of claudeJson?.claudeAiMcpEverConnected ?? []) addConnector(name, 'claude.ai')
    for (const project of Object.values(claudeJson?.projects ?? {})) for (const name of Object.keys(project?.mcpServers ?? {})) addConnector(name, 'claude-code')
  })

  // ── Claude and ChatGPT apps ──
  await ctx.step('desktop-apps', async () => {
    const claudeApp = IS_MAC ? join(MAC_SUPPORT, 'Claude') : IS_WIN ? join(APPDATA, 'Claude') : join(HOME, '.config', 'Claude')
    if (exists(claudeApp)) {
      const servers = Object.keys(readJson(join(claudeApp, 'claude_desktop_config.json'))?.mcpServers ?? {})
      for (const name of servers) addConnector(name, 'claude-desktop')
      ctx.finding({
        id: 'ai.claude-desktop',
        category: 'ai',
        title: 'Appka Claude',
        detail: `Appku Claude máš nainštalovanú (naposledy použitá ${ago(statOf(claudeApp)?.mtimeMs)})${servers.length ? `, s ${sk(servers.length, 'vlastným nástrojom', 'vlastnými nástrojmi', 'vlastnými nástrojmi')}: ${some(servers, 6)}` : ''}.`,
        path: claudeApp,
        data: { mcpServers: servers },
        use: 'Staršie rozhovory z claude.ai sa dajú stiahnuť (Nastavenia → Súkromie → Exportovať dáta) a načítať do pamäte.',
        action: 'none',
        weight: 2,
      })
    }
    const chatgptDir = IS_MAC ? join(MAC_SUPPORT, 'com.openai.chat') : null
    if (apps.has('ChatGPT') || exists(chatgptDir)) {
      ctx.finding({
        id: 'ai.chatgpt',
        category: 'ai',
        title: 'ChatGPT',
        detail: `Máš appku ChatGPT${exists(chatgptDir) ? ` (naposledy použitú ${ago(statOf(chatgptDir)?.mtimeMs)})` : ''}. História rozhovorov je v cloude, v počítači nie je čitateľná.`,
        path: exists(chatgptDir) ? chatgptDir : null,
        data: { app: 'ChatGPT' },
        use: 'ChatGPT o tebe môže vedieť roky kontextu. Stačí mu napísať „Vypíš všetko, čo o mne vieš", alebo si stiahnuť export rozhovorov.',
        action: 'ask',
        weight: 4,
      })
    }
  })

  // ── coding assistants ──
  await ctx.step('coding-tools', async () => {
    const tools = []
    const cursorDir = join(HOME, '.cursor')
    if (exists(cursorDir)) {
      const servers = Object.keys(readJson(join(cursorDir, 'mcp.json'))?.mcpServers ?? {})
      for (const name of servers) addConnector(name, 'cursor')
      tools.push({ name: 'Cursor', path: cursorDir, lastUsed: statOf(cursorDir)?.mtimeMs ?? null })
    }
    const codexDir = process.env.CODEX_HOME || join(HOME, '.codex')
    if (exists(codexDir)) {
      const toml = readText(join(codexDir, 'config.toml'), 500_000) ?? ''
      for (const m of toml.matchAll(/^\[mcp_servers\.["']?([^\]"'.]+)/gm)) addConnector(m[1], 'codex')
      tools.push({ name: 'Codex', path: codexDir, lastUsed: statOf(codexDir)?.mtimeMs ?? null, instructions: exists(join(codexDir, 'AGENTS.md')) ? join(codexDir, 'AGENTS.md') : null })
    }
    for (const [name, dir] of [['Gemini CLI', join(HOME, '.gemini')], ['Windsurf', join(HOME, '.codeium', 'windsurf')], ['Aider', join(HOME, '.aider')], ['OpenCode', join(HOME, '.config', 'opencode')]]) {
      if (exists(dir)) tools.push({ name, path: dir, lastUsed: statOf(dir)?.mtimeMs ?? null })
    }
    if (!tools.length) return
    tools.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))
    ctx.finding({
      id: 'ai.coding-tools',
      category: 'ai',
      title: 'Ďalší AI pomocníci na programovanie',
      detail: `Okrem Claude používaš aj: ${tools.map((t) => `${t.name} (${ago(t.lastUsed)})`).join(', ')}.`,
      data: { tools: tools.map((t) => ({ ...t, lastUsed: day(t.lastUsed) })) },
      use: 'Viem, že pracuješ s viacerými AI nástrojmi, a pokyny z nich si môžem prečítať.',
      action: 'read',
      weight: 2,
    })
  })

  // ── models running on this computer ──
  await ctx.step('local-models', async () => {
    const models = []
    const ollama = join(HOME, '.ollama', 'models', 'manifests', 'registry.ollama.ai', 'library')
    for (const model of await names(ollama)) for (const tag of await names(join(ollama, model))) models.push(`${model}:${tag}`)
    for (const root of [join(HOME, '.lmstudio', 'models'), join(HOME, '.cache', 'lm-studio', 'models')]) {
      for (const publisher of (await list(root)).entries.filter((e) => e.isDirectory())) {
        for (const model of (await list(join(root, publisher.name))).entries.filter((e) => e.isDirectory())) models.push(`${publisher.name}/${model.name}`)
      }
    }
    if (!models.length && !apps.has('Ollama', 'LM Studio')) return
    ctx.finding({
      id: 'ai.local-models',
      category: 'ai',
      title: 'AI modely v počítači',
      detail: models.length ? `Modely stiahnuté priamo v počítači (${uniq(models).length}): ${some(uniq(models), 6)}.` : 'Máš nainštalovaný program na AI modely v počítači, ale žiadny stiahnutý model.',
      path: exists(join(HOME, '.ollama')) ? join(HOME, '.ollama') : null,
      data: { models: uniq(models).slice(0, 60) },
      use: 'Lokálny model sa hodí na veci, ktoré nemajú odísť z počítača.',
      action: 'none',
      weight: 2,
    })
  })

  // ── connectors ──
  await ctx.step('connectors', async () => {
    const bin = findBin('claude', { override: process.env.JARVIS_CLAUDE_BIN })
    if (bin && !process.env.JARVIS_SCAN_NO_MCP) {
      const res = await sh(bin, ['mcp', 'list'], { timeout: 15_000, cwd: HOME })
      for (const line of res.out.split('\n')) {
        const m = line.match(/^(.+?): .+ - (\S+)\s+(.*)$/)
        if (!m || /^Checking/i.test(line)) continue
        const status = /connected/i.test(m[3]) && !/fail|not/i.test(m[3]) ? 'connected' : /auth/i.test(m[3]) ? 'needs-login' : 'failed'
        addConnector(m[1].replace(/^plugin:[^:]+:/, ''), 'claude-code', status)
      }
    }
    const all = [...connectors.values()].sort((a, b) => a.name.localeCompare(b.name))
    if (!all.length) return
    const kinds = uniq(all.map((c) => c.kind).filter((k) => k !== 'other'))
    ctx.finding({
      id: 'connectors.list',
      category: 'connectors',
      title: 'Pripojené služby v Claude',
      detail: `Služby pripojené ku Claude (${all.length}): ${some(all.map((c) => c.name), 10)}.${kinds.length ? ` Pokrývajú: ${kinds.map((k) => KIND_SK[k]).join(', ')}.` : ''}`,
      path: exists(join(HOME, '.claude.json')) ? join(HOME, '.claude.json') : null,
      data: { connectors: all, kinds },
      use: 'Čo je pripojené, vidím naživo a netreba to sťahovať ručne. Kalendár a mail cez konektor sú pre ranný brief najcennejšie.',
      action: 'none',
      weight: 4,
    })
  })
}
