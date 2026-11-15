/**
 * Probe "code": git repositories in the home folder and the developer tools installed.
 * Repositories show what the person works on. Git itself is never started (on a Mac without
 * developer tools it would pop up an installer): everything is read from the .git folder.
 */
import { basename, join } from 'node:path'
import { IS_MAC, IS_WIN, REPO, findBin } from '../lib.mjs'
import { gitConfigSection } from './identity.mjs'
import { HOME, ago, countFiles, day, exists, mapLimit, names, readJson, readTail, readText, sk, some, statOf } from './util.mjs'

const MARKERS = [
  ['TypeScript', /^tsconfig.*\.json$/],
  ['JavaScript', /^package\.json$/],
  ['Python', /^(pyproject\.toml|requirements.*\.txt|setup\.py|Pipfile|uv\.lock)$/],
  ['Rust', /^Cargo\.toml$/],
  ['Go', /^go\.mod$/],
  ['Swift', /^(Package\.swift|.+\.xcodeproj|.+\.xcworkspace)$/],
  ['Kotlin / Java', /^(build\.gradle(\.kts)?|pom\.xml|settings\.gradle(\.kts)?)$/],
  ['PHP', /^composer\.json$/],
  ['Ruby', /^Gemfile$/],
  ['C#', /^.+\.(sln|csproj)$/],
  ['C / C++', /^(CMakeLists\.txt|Makefile|.+\.vcxproj)$/],
  ['Dart', /^pubspec\.yaml$/],
  ['Elixir', /^mix\.exs$/],
  ['Unity', /^ProjectSettings$/],
  ['Godot', /^project\.godot$/],
  ['HTML', /^index\.html$/],
]
const EXT_LANG = { ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', py: 'Python', rs: 'Rust', go: 'Go', swift: 'Swift', kt: 'Kotlin / Java', java: 'Kotlin / Java', php: 'PHP', rb: 'Ruby', cs: 'C#', c: 'C / C++', cpp: 'C / C++', h: 'C / C++', dart: 'Dart', html: 'HTML', css: 'CSS', vue: 'Vue', svelte: 'Svelte', lua: 'Lua', sh: 'Shell', sql: 'SQL', ipynb: 'Jupyter', tex: 'LaTeX', gd: 'Godot', md: 'Markdown' }
const FRAMEWORKS = ['next', 'react', 'vue', 'svelte', 'astro', 'nuxt', 'expo', 'react-native', 'electron', 'express', 'fastify', 'three', 'tailwindcss', 'drizzle-orm', 'prisma', 'vite', '@anthropic-ai/sdk', 'openai', 'discord.js', 'phaser']

/** "https://user:token@github.com/org/repo.git" → { host: 'github.com', org: 'org', repo: 'repo' } (credentials dropped). */
function parseRemote(url) {
  if (!url) return null
  const m = url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](.+?)(?:\.git)?\/?$/i)
  if (!m) return null
  const parts = m[2].split('/').filter(Boolean)
  if (parts.length < 2) return { host: m[1], org: null, repo: parts[0] ?? null }
  return { host: m[1], org: parts.slice(0, -1).join('/'), repo: parts[parts.length - 1] }
}

async function describeRepo(repo, deep, deadline) {
  const gitDir = join(repo.path, '.git')
  const config = readText(join(gitDir, 'config'), 100_000)
  const url = config?.match(/\[remote "origin"\][^[]*?url\s*=\s*(.+)/)?.[1]?.trim() ?? config?.match(/url\s*=\s*(.+)/)?.[1]?.trim()
  const remote = parseRemote(url)
  // the reflog ends with the last commit, pull or checkout: "<old> <new> Name <mail> 1700000000 +0100\t..."
  const last = readTail(join(gitDir, 'logs', 'HEAD'), 600)?.trim().split('\n').pop()
  const stamp = Number(last?.match(/> (\d{9,11}) [+-]\d{4}/)?.[1]) * 1000
  const lastActivity = stamp || statOf(join(gitDir, 'HEAD'))?.mtimeMs || statOf(gitDir)?.mtimeMs || 0
  const author = last?.match(/^\S+ \S+ (.+?) <([^>]*)>/)
  let language = MARKERS.find(([, re]) => repo.names.some((n) => re.test(n)))?.[0] ?? null
  const stack = []
  if (repo.names.includes('package.json')) {
    const pkg = readJson(join(repo.path, 'package.json'), 400_000)
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies }
    for (const f of FRAMEWORKS) if (deps[f]) stack.push(f)
  }
  if (deep) {
    const counted = await countFiles(repo.path, { maxDepth: 4, maxDirs: 400, deadline, wanted: new Set(Object.keys(EXT_LANG)) })
    const totals = new Map()
    for (const [ext, n] of counted.byExt) if (ext !== 'md') totals.set(EXT_LANG[ext], (totals.get(EXT_LANG[ext]) ?? 0) + n)
    const top = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]
    if (top) language = top[0]
  }
  return {
    name: basename(repo.path),
    path: repo.path,
    host: remote?.host ?? null,
    org: remote?.org ?? null,
    lastActivity: day(lastActivity),
    lastActivityMs: lastActivity,
    lastAuthor: author?.[1] ?? null,
    lastAuthorEmail: author?.[2] ?? null,
    language,
    stack,
    hasInstructions: repo.names.some((n) => /^(CLAUDE|AGENTS)\.md$/.test(n)),
  }
}

export async function code(ctx) {
  await ctx.step('repos', async () => {
    const index = await ctx.index()
    const found = index.repos.filter((r) => r.path !== REPO)
    if (!found.length) return
    const all = await mapLimit(found.slice(0, 400), 12, (r) => describeRepo(r, false, ctx.deadline))
    all.sort((a, b) => b.lastActivityMs - a.lastActivityMs)
    const repos = all.slice(0, 80)
    if (ctx.deep) {
      const byPath = new Map(found.map((r) => [r.path, r]))
      const detailed = await mapLimit(repos.slice(0, 40), 6, (r) => describeRepo(byPath.get(r.path), true, ctx.deadline))
      detailed.forEach((d, i) => (repos[i] = d))
    }
    const me = gitConfigSection(readText(join(HOME, '.gitconfig'), 200_000), 'user')
    const orgs = new Map()
    const langs = new Map()
    for (const r of all) {
      if (r.org) orgs.set(`${r.host}/${r.org}`, (orgs.get(`${r.host}/${r.org}`) ?? 0) + 1)
      if (r.language) langs.set(r.language, (langs.get(r.language) ?? 0) + 1)
    }
    const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    const active = all.filter((r) => r.lastActivityMs > Date.now() - 30 * 86_400_000)
    // the reflog records whoever worked in this checkout, so repeated addresses are the person's own
    const mailCount = new Map()
    for (const r of all) if (r.lastAuthorEmail && !/noreply/.test(r.lastAuthorEmail)) mailCount.set(r.lastAuthorEmail, (mailCount.get(r.lastAuthorEmail) ?? 0) + 1)
    ctx.identity({ emails: [...mailCount.entries()].filter(([mail, n]) => n >= 2 || mail === me.email).map(([mail]) => mail) })
    ctx.finding({
      id: 'code.repos',
      category: 'code',
      title: 'Projekty s kódom',
      detail:
        `${sk(all.length, 'projekt', 'projekty', 'projektov')} s gitom, z toho ${active.length} živých za posledný mesiac. ` +
        `Naposledy: ${some(repos.map((r) => r.name), 6)}.` +
        (langs.size ? ` Najčastejšie jazyky: ${top(langs, 4).map(([l, n]) => `${l} (${n})`).join(', ')}.` : '') +
        (orgs.size ? ` Najviac ich patrí pod ${top(orgs, 3).map(([o, n]) => `${o} (${n})`).join(', ')}.` : ''),
      path: null,
      data: {
        total: all.length,
        activeLast30Days: active.length,
        orgs: top(orgs, 15).map(([org, count]) => ({ org, count })),
        languages: top(langs, 12).map(([language, count]) => ({ language, count })),
        repos: repos.map(({ lastActivityMs, lastAuthorEmail, ...r }) => ({ ...r, ago: ago(lastActivityMs) })),
        truncated: index.truncated,
      },
      use: 'Vidím, na čom programuješ a pre koho. Z toho viem založiť tvoje projekty v pamäti a pomáhať ti priamo v nich.',
      action: 'read',
      weight: active.length ? 5 : 3,
    })
  })

  await ctx.step('tools', async () => {
    const tools = []
    const check = (name, label = name) => {
      const bin = findBin(name)
      // /usr/bin on macOS holds placeholders that only open an installer
      if (bin && !(IS_MAC && bin.startsWith('/usr/bin/') && ['git', 'python3', 'pip3', 'make', 'gcc', 'clang'].includes(name))) tools.push(label)
    }
    if (IS_MAC && (exists('/Library/Developer/CommandLineTools') || exists('/Applications/Xcode.app'))) tools.push('git', 'vývojárske nástroje Apple')
    else check('git')
    for (const [name, label] of [['node', 'Node.js'], ['npm'], ['pnpm'], ['yarn'], ['bun'], ['deno'], ['python3', 'Python'], ['python', 'Python'], ['uv'], ['pip3', 'pip'], ['cargo', 'Rust'], ['go', 'Go'], ['docker', 'Docker'], ['gh', 'GitHub CLI'], ['brew', 'Homebrew'], ['ffmpeg'], ['java', 'Java'], ['dotnet', '.NET'], ['php', 'PHP'], ['ruby', 'Ruby'], ['vercel', 'Vercel CLI'], ['wrangler', 'Cloudflare Wrangler'], ['supabase', 'Supabase CLI'], ['railway', 'Railway CLI'], ['ollama', 'Ollama'], ['claude', 'Claude Code'], ['codex', 'Codex'], ['tailscale', 'Tailscale']]) check(name, label ?? name)
    if (IS_WIN) for (const [name, label] of [['winget'], ['choco', 'Chocolatey'], ['scoop', 'Scoop'], ['wsl', 'WSL (Linux vo Windows)']]) check(name, label ?? name)
    const unique = [...new Set(tools)]
    const brewed = IS_MAC ? [...(await names('/opt/homebrew/Cellar')), ...(await names('/usr/local/Cellar'))].filter((n) => !n.startsWith('.')) : []
    const casks = IS_MAC ? [...(await names('/opt/homebrew/Caskroom')), ...(await names('/usr/local/Caskroom'))].filter((n) => !n.startsWith('.')) : []
    const ghUser = readText(join(HOME, '.config', 'gh', 'hosts.yml'), 20_000)?.match(/^\s+user:\s*(\S+)/m)?.[1] ?? null
    if (unique.length < 3 && !brewed.length) return
    ctx.finding({
      id: 'code.tools',
      category: 'code',
      title: 'Vývojárske nástroje',
      detail: `V počítači sú nástroje: ${some(unique, 14)}.${brewed.length ? ` Homebrew spravuje ${sk(brewed.length, 'balík', 'balíky', 'balíkov')}.` : ''}${ghUser ? ` Na GitHube si ako ${ghUser}.` : ''}`,
      data: { tools: unique, homebrew: brewed.slice(0, 200), casks: casks.slice(0, 100), githubUser: ghUser },
      use: 'Viem, čo môžem v tomto počítači rovno spustiť, keď budeš chcieť technickú prácu.',
      action: 'none',
      weight: 2,
    })
  })
}
