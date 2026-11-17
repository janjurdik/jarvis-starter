/**
 * Turns the raw activity log of one day (activity.mjs) into what a person would say about it:
 * time per app and per kind of work, sessions, games, breaks. On top of that it gathers a few cheap
 * signals of the same day that say WHAT was done, not only where: commits made on this computer,
 * files that changed in Desktop, Documents and Downloads (names only), conversations with Jarvis,
 * finished background jobs and routines.
 *
 * `aggregate()` is pure (records in, numbers out) and is what the tests cover.
 * `dayReport()` adds the signals and is what `node scripts/activity.mjs today --json` prints.
 */
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { matchApp } from '../../scripts/scan/catalog.mjs'
import { activityConfig, activityDays, isIgnored, readRecords } from './activity.mjs'
import { readDay } from './chatlog.mjs'
import { FOLDERS, MEMORY_DIR, todos } from './memory/index.mjs'
import { BRAIN_DIR, DATA_DIR, HOME, IS_MAC, REPO, addDays, dayStartMs, isoDay, mapLimit } from './util.mjs'

// ── kinds of work ──
export const CATEGORY_LABEL = { dev: 'programovanie', work: 'práca', communication: 'komunikácia', browsing: 'web', creative: 'tvorba', media: 'médiá', games: 'hry', system: 'systém', other: 'ostatné' }
/** Groups of the scan's app catalog → category. */
const GROUP_CATEGORY = { code: 'dev', notes: 'work', ai: 'work', office: 'work', tasks: 'work', finance: 'work', study: 'work', comms: 'communication', browser: 'browsing', design: 'creative', video: 'creative', audio: 'creative', d3: 'creative', music: 'media', media: 'media', reading: 'media', games: 'games', passwords: 'other', cloud: 'other', health: 'other', tools: 'other' }
/** Apps the catalog does not know or that show up under a process name. Normalised names; a key also matches "key something". */
const BUILT_IN = {
  dev: ['terminal', 'iterm2', 'iterm', 'warp', 'ghostty', 'alacritty', 'kitty', 'wezterm', 'hyper', 'windowsterminal', 'windows terminal', 'powershell', 'windows powershell', 'cmd', 'command prompt', 'xcode', 'simulator', 'android studio', 'docker desktop', 'docker', 'postman', 'insomnia', 'tableplus', 'dbeaver', 'datagrip', 'github desktop', 'sourcetree', 'fork', 'tower', 'visual studio code', 'code', 'cursor', 'windsurf', 'zed', 'sublime text', 'intellij idea', 'pycharm', 'webstorm', 'visual studio', 'devenv', 'console', 'script editor', 'unity', 'unity hub', 'godot', 'unreal editor'],
  system: ['finder', 'explorer', 'windows explorer', 'file explorer', 'system settings', 'system preferences', 'settings', 'activity monitor', 'task manager', 'taskmgr', 'installer', 'software update', 'app store', 'microsoft store', 'archive utility', 'searchhost', 'startmenuexperiencehost', 'shellexperiencehost', 'control center', 'notification center', 'dock', 'spotlight', 'disk utility', 'migration assistant', 'screenshot', 'snipping tool', 'usernotificationcenter', 'coreservicesuiagent', 'securityagent'],
  communication: ['mail', 'outlook', 'microsoft outlook', 'messages', 'facetime', 'zoom', 'zoom us', 'zoom workplace', 'microsoft teams', 'teams', 'ms teams', 'google meet', 'webex', 'phone', 'phone link', 'beeper', 'spark', 'thunderbird', 'messenger', 'whatsapp', 'telegram', 'signal', 'discord', 'slack', 'skype', 'viber'],
  browsing: ['safari', 'google chrome', 'chrome', 'chromium', 'firefox', 'microsoft edge', 'msedge', 'arc', 'brave browser', 'brave', 'opera', 'opera gx', 'vivaldi', 'zen browser', 'zen', 'duckduckgo', 'orion', 'dia', 'comet', 'chatgpt atlas'],
  media: ['spotify', 'music', 'apple music', 'tv', 'apple tv', 'vlc', 'iina', 'netflix', 'youtube', 'youtube music', 'podcasts', 'photos', 'quicktime player', 'plex', 'prime video', 'disney', 'twitch', 'stremio', 'mpv', 'windows media player', 'media player', 'movies tv', 'books', 'kindle', 'audible', 'tidal', 'deezer'],
  creative: ['figma', 'adobe photoshop', 'photoshop', 'adobe illustrator', 'illustrator', 'adobe premiere pro', 'premiere pro', 'adobe after effects', 'after effects', 'adobe lightroom', 'lightroom', 'adobe indesign', 'final cut pro', 'logic pro', 'garageband', 'blender', 'davinci resolve', 'resolve', 'canva', 'sketch', 'affinity photo', 'affinity designer', 'affinity publisher', 'capcut', 'obs', 'obs studio', 'ableton live', 'fl studio', 'audacity', 'procreate', 'pixelmator pro', 'krita', 'gimp', 'inkscape', 'imovie', 'motion', 'compressor', 'cinema 4d', 'fusion 360', 'autocad', 'sketchup'],
  work: ['notes', 'obsidian', 'notion', 'microsoft word', 'word', 'winword', 'microsoft excel', 'excel', 'microsoft powerpoint', 'powerpoint', 'powerpnt', 'pages', 'numbers', 'keynote', 'calendar', 'reminders', 'onenote', 'preview', 'adobe acrobat', 'acrobat', 'acrobat reader', 'textedit', 'notepad', 'calculator', 'claude', 'chatgpt', 'linear', 'asana', 'trello', 'todoist', 'things', 'microsoft to do', 'jarvis', 'jarvis hud', 'freeform', 'miro', 'stickies', 'contacts', 'maps', 'translate', 'dictionary'],
}
const BUILT_IN_EXACT = new Map()
const BUILT_IN_PREFIX = []
for (const [category, names] of Object.entries(BUILT_IN)) {
  for (const name of names) {
    BUILT_IN_EXACT.set(name, category)
    if (name.length >= 6 || name.includes(' ')) BUILT_IN_PREFIX.push([name, category])
  }
}
BUILT_IN_PREFIX.sort((a, b) => b[0].length - a[0].length)

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.(app|exe)$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Category of one app (name, optional bundle id or process name, optional game). Unknown apps are "other". */
export function categoryOf({ app = '', id = '', game = null } = {}) {
  if (game) return 'games'
  for (const key of [norm(app), norm(id), norm(String(id).split('.').pop())]) {
    if (!key) continue
    const hit = BUILT_IN_EXACT.get(key)
    if (hit) return hit
    const cat = GROUP_CATEGORY[matchApp(key)?.group]
    if (cat) return cat
    for (const [prefix, category] of BUILT_IN_PREFIX) if (key.startsWith(`${prefix} `)) return category
  }
  return 'other'
}

// ── formatting ──
const pad = (n) => String(n).padStart(2, '0')
const clock = (sec) => {
  const d = new Date(sec * 1000)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const minutes = (sec) => Math.round(sec / 60)
/** "2 h 05 min", "45 min". */
export function fmtDuration(min) {
  const m = Math.max(0, Math.round(min))
  return m >= 60 ? `${Math.floor(m / 60)} h ${pad(m % 60)} min` : `${m} min`
}

// ── aggregation ──
/**
 * Raw records of one day → the day in numbers.
 *
 * How time is counted: a sample stands for the time until the next sample, but never for longer
 * than its sampler's own interval (plus half of it for jitter). So a HUD sample covers a minute and
 * a pulse sample its few minutes; time nobody sampled (the computer slept, was off, Jarvis did not
 * run) stays "no data" instead of being guessed. When a sample says the last input was N seconds
 * ago, the active time before it is cut back to that moment.
 */
export function aggregate(records, { day, cfg = activityConfig(), now = Date.now() } = {}) {
  const dayStart = Math.floor(dayStartMs(day) / 1000)
  const dayEnd = Math.floor(dayStartMs(addDays(day, 1)) / 1000)
  const limit = Math.min(dayEnd, Math.floor(now / 1000))
  const recs = records
    .filter((r) => r && Number.isFinite(r.t) && r.t >= dayStart - 60 && r.t < dayEnd)
    .sort((a, b) => a.t - b.t)

  /** @type {{ start: number, end: number, st: string, label: string|null, app: string|null, id: string|null, game: string|null, priv: boolean, src: string, title: string|null }[]} */
  const spans = []
  recs.forEach((r, i) => {
    const nominal = Math.max(30, Math.min(1800, Number(r.d) || 60))
    const next = recs[i + 1]?.t ?? Infinity
    const start = Math.max(r.t, dayStart)
    const end = Math.min(next <= r.t + nominal * 1.5 ? next : r.t + nominal, limit)
    if (end <= start) return
    const st = ['active', 'passive', 'idle', 'locked'].includes(r.st) ? r.st : 'active'
    const away = st === 'idle' || st === 'locked'
    const priv = !away && (r.priv === 1 || r.priv === true || isIgnored(cfg.ignore, r.app, r.id) || (r.game ? isIgnored(cfg.ignore, r.game) : false))
    const game = away || priv ? null : typeof r.game === 'string' && r.game ? r.game : null
    const app = away || priv ? null : typeof r.app === 'string' && r.app ? r.app : null
    spans.push({ start, end, st, label: game ?? app, app, id: away || priv ? null : (r.id ?? null), game, priv, src: r.src === 'pulse' ? 'pulse' : 'hud', title: !away && !priv && typeof r.title === 'string' ? r.title : null, idleFrom: st === 'idle' && Number(r.idle) > 0 ? r.t - Number(r.idle) : null })
  })

  // the last input was before the idle sample: what looked active since then was already away
  for (let k = 0; k < spans.length; k++) {
    const from = spans[k].idleFrom
    if (from === null) continue
    for (let j = k - 1; j >= 0; j--) {
      const s = spans[j]
      if (s.st !== 'active' || s.end <= from) break
      if (s.start >= from) {
        Object.assign(s, { st: 'idle', label: null, app: null, id: null, game: null, priv: false, title: null })
        continue
      }
      spans.splice(j + 1, 0, { ...s, start: from, st: 'idle', label: null, app: null, id: null, game: null, priv: false, title: null, idleFrom: null })
      s.end = from
      k++
      break
    }
  }

  // neighbouring spans of the same thing become one segment
  const segments = []
  for (const s of spans) {
    const last = segments[segments.length - 1]
    if (last && s.start - last.end <= 1 && last.st === s.st && last.label === s.label && last.priv === s.priv) {
      last.end = s.end
      if (s.src === 'pulse') last.pulseSec += s.end - s.start
    } else segments.push({ start: s.start, end: s.end, st: s.st, label: s.label, app: s.app, id: s.id, game: s.game, priv: s.priv, pulseSec: s.src === 'pulse' ? s.end - s.start : 0 })
  }

  const totals = { active: 0, passive: 0, idle: 0, locked: 0, priv: 0, pulse: 0 }
  const apps = new Map()
  const gamesMap = new Map()
  const cats = new Map()
  const titles = new Map()
  for (const s of spans) {
    const sec = s.end - s.start
    totals[s.st] += sec
    if (s.st !== 'active' && s.st !== 'passive') continue
    if (s.src === 'pulse') totals.pulse += sec
    if (s.priv) {
      totals.priv += sec
      continue
    }
    if (!s.label) continue
    const category = categoryOf(s)
    const a = apps.get(s.label) ?? { app: s.label, category, sec: 0, passiveSec: 0 }
    a.sec += sec
    if (s.st === 'passive') a.passiveSec += sec
    apps.set(s.label, a)
    cats.set(category, (cats.get(category) ?? 0) + sec)
    if (s.game) gamesMap.set(s.game, (gamesMap.get(s.game) ?? 0) + sec)
    if (s.title) {
      const key = `${s.label}\u0000${s.title}`
      titles.set(key, (titles.get(key) ?? 0) + sec)
    }
  }

  // sessions: runs of one app; a detour shorter than five minutes (a look at a chat, a search) does not break a run
  const runs = []
  for (const s of segments) {
    if ((s.st !== 'active' && s.st !== 'passive') || s.priv || !s.label) continue
    const sec = s.end - s.start
    const last = runs[runs.length - 1]
    const prev = runs[runs.length - 2]
    if (last && last.label === s.label && s.start - last.end <= 120) {
      last.end = s.end
      last.sec += sec
      last.pulseSec += s.pulseSec
    } else if (prev && last && prev.label === s.label && last.sec < 300 && s.start - prev.end <= 360) {
      runs.pop()
      prev.end = s.end
      prev.sec += sec
      prev.pulseSec += s.pulseSec
    } else runs.push({ label: s.label, app: s.app, id: s.id, game: s.game, start: s.start, end: s.end, sec, pulseSec: s.pulseSec })
  }
  const longRuns = runs.filter((r) => r.sec >= 300)
  const shown = longRuns.length > 40 ? [...longRuns].sort((a, b) => b.sec - a.sec).slice(0, 40).sort((a, b) => a.start - b.start) : longRuns

  // breaks: away (idle or locked) and stretches without any sample
  const gaps = []
  const addGap = (start, end, kind) => {
    const last = gaps[gaps.length - 1]
    if (last && last.kind === kind && start - last.end <= 1) last.end = end
    else gaps.push({ start, end, kind })
  }
  let cursor = null
  for (const s of segments) {
    if (cursor !== null && s.start - cursor > 1) addGap(cursor, s.start, 'no-data')
    if (s.st === 'idle' || s.st === 'locked') addGap(s.start, s.end, s.st)
    cursor = s.end
  }

  const present = segments.filter((s) => s.st === 'active' || s.st === 'passive')
  const first = present[0]?.start ?? null
  const last = present.length ? present[present.length - 1].end : null
  const noData = gaps.filter((g) => g.kind === 'no-data').reduce((sum, g) => sum + (g.end - g.start), 0)
  const bySrc = { hud: 0, pulse: 0 }
  for (const r of recs) bySrc[r.src === 'pulse' ? 'pulse' : 'hud']++

  return {
    day,
    samples: recs.length,
    sources: bySrc,
    from: recs.length ? clock(Math.max(recs[0].t, dayStart)) : null,
    to: spans.length ? clock(spans[spans.length - 1].end) : null,
    first: first === null ? null : clock(first),
    last: last === null ? null : clock(last),
    totals: {
      /** At the computer: input within the idle limit. */
      activeMin: minutes(totals.active),
      /** No input, but a film, a call or a game kept going. Counted as being there; an estimate. */
      passiveMin: minutes(totals.passive),
      idleMin: minutes(totals.idle),
      lockedMin: minutes(totals.locked),
      /** Part of the time at the computer spent in apps from the ignore list (no names). */
      privateMin: minutes(totals.priv),
      /** Part of the time at the computer known only from the pulse (a sample every few minutes): an estimate. */
      estimatedMin: minutes(totals.pulse),
      noDataMin: minutes(noData),
    },
    apps: [...apps.values()]
      .sort((a, b) => b.sec - a.sec)
      .filter((a) => a.sec >= 30)
      .slice(0, 30)
      .map((a) => ({ app: a.app, category: a.category, minutes: minutes(a.sec), ...(a.passiveSec >= 60 ? { passiveMin: minutes(a.passiveSec) } : {}) })),
    categories: [...cats.entries()]
      .sort((a, b) => b[1] - a[1])
      .filter(([, sec]) => sec >= 30)
      .map(([category, sec]) => ({ category, label: CATEGORY_LABEL[category] ?? category, minutes: minutes(sec) })),
    games: [...gamesMap.entries()].sort((a, b) => b[1] - a[1]).map(([game, sec]) => ({ game, minutes: minutes(sec) })),
    sessions: shown.map((r) => ({ from: clock(r.start), to: clock(r.end), app: r.label, category: categoryOf(r), minutes: minutes(r.sec), ...(r.game ? { game: r.game } : {}), ...(r.pulseSec > r.sec / 2 ? { estimated: true } : {}) })),
    sessionsOmitted: runs.length - shown.length,
    gaps: gaps.filter((g) => g.end - g.start >= 300).map((g) => ({ from: clock(g.start), to: clock(g.end), minutes: minutes(g.end - g.start), kind: g.kind })),
    ...(titles.size
      ? {
          titles: [...titles.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([key, sec]) => ({ app: key.split('\u0000')[0], title: key.split('\u0000')[1], minutes: minutes(sec) })),
        }
      : {}),
  }
}

// ── signals of the same day ──
const withTimeout = (promise, ms, fallback) => {
  let timer
  return Promise.race([promise.catch(() => fallback), new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]).finally(() => clearTimeout(timer))
}
const inDay = (ms, day) => ms >= dayStartMs(day) && ms < dayStartMs(addDays(day, 1))

/** Desktop, Documents and Downloads are guarded by macOS: a first read from a background process opens a system dialog. */
function guardedFolder(path) {
  if (!IS_MAC) return null
  for (const name of ['Desktop', 'Documents', 'Downloads']) {
    const dir = join(HOME, name)
    if (path === dir || path.startsWith(dir + sep)) return name
  }
  return null
}
/** In light mode a guarded folder is read only when Jarvis itself lives in it (then the access already exists). */
const mayRead = (path, full) => {
  const guard = guardedFolder(path)
  return !guard || full || guardedFolder(REPO) === guard || guardedFolder(MEMORY_DIR) === guard
}

async function tail(file, bytes) {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const len = Math.min(size, bytes)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

/** Git repositories up to two levels deep in the folders where people keep code. Names of folders only. */
async function discoverRepos() {
  const { skipDir, walk } = await import('../../scripts/scan/util.mjs')
  const roots = ['Desktop', 'Documents', 'Projects', 'projects', 'Developer', 'dev', 'code', 'Code', 'src', 'repos', 'git', 'GitHub', 'work', 'Sites'].map((name) => ({ path: join(HOME, name), depth: 0 }))
  const found = []
  await walk(roots, { maxDepth: 2, maxDirs: 500, deadline: Date.now() + 3000, conc: 8 }, (dir, entries) => {
    if (!entries) return null
    if (entries.some((e) => e.name === '.git')) {
      if (dir.path !== REPO) found.push(dir.path)
      return null
    }
    return entries.filter((e) => e.isDirectory() && !skipDir(e.name)).map((e) => e.name)
  })
  return found
}

/**
 * Commits made on this computer that day, read from each repository's own reflog (.git/logs/HEAD).
 * Git is never started (on a Mac without developer tools it would open an installer) and commits
 * that were only pulled from someone else are not counted. Repositories come from the last scan.
 */
export async function gitSignal(day, { full = true } = {}) {
  let repos = []
  try {
    const scan = JSON.parse(await readFile(join(DATA_DIR, 'scan', 'scan.json'), 'utf8'))
    repos = (scan.findings ?? []).find((f) => f.id === 'code.repos')?.data?.repos?.map((r) => r.path).filter((p) => typeof p === 'string') ?? []
  } catch {
    repos = []
  }
  // projects created since the last scan: a quick look into the usual places (only in full mode, it walks the user's folders)
  if (full) repos = [...new Set([...repos, ...(await withTimeout(discoverRepos(), 4000, []))])]
  if (!repos.length) return { available: false, note: 'Git projekty nepoznám (sken počítača ešte nebežal alebo žiadne nenašiel).', commits: 0, repos: [] }
  const readable = repos.slice(0, 120).filter((p) => mayRead(p, full))
  const found = await mapLimit(readable, 8, (path) =>
    withTimeout(
      (async () => {
        const text = await tail(join(path, '.git', 'logs', 'HEAD'), 200_000)
        const subjects = new Set()
        for (const line of text.split('\n')) {
          const m = /> (\d{9,11}) [+-]\d{4}\tcommit(?: \((?:initial|amend|merge)\))?: (.*)$/.exec(line)
          if (m && inDay(Number(m[1]) * 1000, day)) subjects.add(m[2].trim().slice(0, 120))
        }
        return subjects.size ? { repo: basename(path), commits: subjects.size, subjects: [...subjects].slice(-6) } : null
      })(),
      2500,
      null,
    ),
  )
  const list = found.filter(Boolean).sort((a, b) => b.commits - a.commits)
  return {
    available: true,
    commits: list.reduce((sum, r) => sum + r.commits, 0),
    repos: list.slice(0, 15),
    checked: readable.length,
    ...(readable.length < Math.min(repos.length, 120) ? { note: `${Math.min(repos.length, 120) - readable.length} projektov v chránených priečinkoch som teraz nečítal.` } : {}),
  }
}

const JUNK_FILE = /^(\.|~\$)|\.(tmp|temp|crdownload|part|download|partial|lock|swp)$|^(desktop\.ini|thumbs\.db|icon\r?)$/i

/**
 * Files in Desktop, Documents and Downloads that changed that day: how many, and a few names.
 * Only names and times are read, never the content. Folders with code (git) are left to gitSignal.
 */
export async function filesSignal(day, { deadlineMs = 5000 } = {}) {
  const { userFolders } = await import('../../scripts/scan/index.mjs')
  const { skipDir, walk } = await import('../../scripts/scan/util.mjs')
  const folders = await withTimeout(userFolders(), 14_000, null)
  if (!folders) return { available: false, note: 'Priečinky používateľa sa nepodarilo zistiť.', changed: 0, created: 0, names: [] }
  const roots = [['Plocha', folders.desktop], ['Dokumenty', folders.documents], ['Stiahnuté', folders.downloads]].filter(([, p]) => p)
  const files = []
  const denied = []
  const res = await walk(
    roots.map(([, path]) => ({ path, depth: 0 })),
    { maxDepth: 2, maxDirs: 600, deadline: Date.now() + deadlineMs, conc: 8 },
    (dir, entries, err) => {
      if (!entries) {
        if (dir.depth === 0 && (err?.code === 'EPERM' || err?.code === 'EACCES')) denied.push(roots.find(([, p]) => p === dir.path)?.[0])
        return null
      }
      // a code project, Jarvis itself or its memory: not "documents"
      if (dir.depth > 0 && (entries.some((e) => e.name === '.git') || dir.path === REPO || dir.path === MEMORY_DIR)) return null
      const down = []
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!skipDir(e.name)) down.push(e.name)
        } else if (e.isFile() && !JUNK_FILE.test(e.name) && files.length < 6000) files.push(join(dir.path, e.name))
      }
      return down
    },
  )
  const hits = []
  await mapLimit(files, 24, async (file) => {
    try {
      const st = await stat(file)
      if (!inDay(st.mtimeMs, day)) return
      hits.push({ file, mtime: st.mtimeMs, created: inDay(st.birthtimeMs, day) })
    } catch {
      // gone meanwhile
    }
  })
  hits.sort((a, b) => b.mtime - a.mtime)
  const where = (file) => roots.find(([, p]) => file.startsWith(p + sep))?.[0] ?? ''
  const perFolder = {}
  for (const h of hits) {
    const key = where(h.file)
    perFolder[key] ??= { changed: 0, created: 0 }
    perFolder[key].changed++
    if (h.created) perFolder[key].created++
  }
  return {
    available: denied.length < roots.length,
    changed: hits.length,
    created: hits.filter((h) => h.created).length,
    folders: perFolder,
    names: hits.slice(0, 15).map((h) => `${where(h.file)}/${basename(h.file)}${h.created ? ' (nový)' : ''}`),
    ...(denied.length ? { denied: denied.filter(Boolean), note: 'Niektoré priečinky systém nedovolil čítať.' } : {}),
    ...(res.truncated || files.length >= 6000 ? { truncated: true } : {}),
  }
}

/** What happened with Jarvis that day: conversation turns, finished background jobs, routines that ran. */
export async function jarvisSignal(day) {
  const turns = await readDay(day).catch(() => [])
  const tools = {}
  for (const t of turns) {
    for (const name of Array.isArray(t?.tools) ? t.tools : []) {
      const short = String(name).replace(/^mcp__.+?__/, '')
      tools[short] = (tools[short] ?? 0) + 1
    }
  }
  const jobs = []
  try {
    const data = JSON.parse(await readFile(join(BRAIN_DIR, 'jobs.json'), 'utf8'))
    for (const j of data.jobs ?? []) {
      if (!j?.endedAt || j.mock || !['done', 'needs_ok', 'error'].includes(j.status)) continue
      if (isoDay(new Date(j.endedAt)) === day) jobs.push({ title: String(j.title ?? '').slice(0, 120), status: j.status })
    }
  } catch {
    // no jobs yet
  }
  let routines = []
  try {
    routines = (await readdir(join(MEMORY_DIR, FOLDERS.inbox))).map((n) => new RegExp(`^${day}-(.+)\\.md$`).exec(n)?.[1]).filter(Boolean)
  } catch {
    routines = []
  }
  return { chatTurns: turns.length, tools, jobs, routines }
}

/**
 * To-dos. ulohy.md keeps no date of completion, so what was ticked off by hand or by another tool
 * cannot be told. Known reliably: what Jarvis ticked off in the HUD that day, reminders that fired,
 * and what is still open with a deadline up to that day.
 */
export async function todoSignal(day, jarvis) {
  let fired = []
  try {
    const text = await readFile(join(MEMORY_DIR, 'pripomienky.md'), 'utf8')
    fired = text.split(/\r?\n/).map((l) => new RegExp(`^\\s*[-*]\\s+\\[x\\]\\s+${day}(?:\\s+\\d{1,2}:\\d{2})?\\s+!*\\s*(.+)$`, 'i').exec(l)?.[1]).filter(Boolean)
  } catch {
    fired = []
  }
  let overdue = []
  try {
    overdue = (await todos()).filter((t) => !t.done && t.due && t.due <= day).map((t) => `${t.text} (do ${t.due})`)
  } catch {
    overdue = []
  }
  return {
    completedViaJarvis: jarvis?.tools?.complete_todo ?? 0,
    addedViaJarvis: jarvis?.tools?.add_todo ?? 0,
    remindersFired: fired.slice(0, 20),
    openDueByToday: overdue.slice(0, 20),
    note: 'Súbor ulohy.md neuchováva dátum dokončenia. Viem len, koľko úloh sa v ten deň odškrtlo cez Jarvisa v HUD, nie čo bolo odškrtnuté ručne.',
  }
}

// ── the whole day ──
/** Human summary of the aggregated day, in Slovak. Used by the CLI and the voice tool. */
export function summaryText(r) {
  const lines = []
  if (!r.samples) lines.push(`${r.day}: žiadny záznam aktivity.`)
  else {
    const t = r.totals
    lines.push(`${r.day}: pri počítači ${fmtDuration(t.activeMin + t.passiveMin)}${r.first ? ` (prvá aktivita ${r.first}, posledná ${r.last})` : ''}.`)
    if (r.categories.length) lines.push(`Podľa druhu: ${r.categories.slice(0, 6).map((c) => `${c.label} ${fmtDuration(c.minutes)}`).join(', ')}.`)
    if (r.apps.length) lines.push(`Appky: ${r.apps.slice(0, 8).map((a) => `${a.app} ${fmtDuration(a.minutes)}`).join(', ')}.`)
    lines.push(r.games.length ? `Hry: ${r.games.map((g) => `${g.game} ${fmtDuration(g.minutes)}`).join(', ')}.` : 'Hry: žiadna.')
    if (r.sessions.length) lines.push(`Dlhšie úseky: ${r.sessions.slice(0, 14).map((s) => `${s.from} až ${s.to} ${s.app}${s.estimated ? ' (odhad)' : ''}`).join('; ')}.`)
    const breaks = r.gaps.filter((g) => g.minutes >= 15)
    if (breaks.length) lines.push(`Prestávky: ${breaks.slice(0, 8).map((g) => `${g.from} až ${g.to} (${g.kind === 'locked' ? 'zamknuté' : g.kind === 'idle' ? 'bez vstupu' : 'bez záznamu'})`).join(', ')}.`)
  }
  const s = r.signals
  if (s?.git?.commits) lines.push(`Commity: ${s.git.repos.map((x) => `${x.repo} ${x.commits}`).join(', ')}.`)
  if (s?.files?.changed) lines.push(`Súbory zmenené v ten deň: ${s.files.changed}${s.files.names.length ? ` (${s.files.names.slice(0, 5).join(', ')})` : ''}.`)
  if (s?.jarvis && (s.jarvis.chatTurns || s.jarvis.jobs.length)) lines.push(`Jarvis: ${s.jarvis.chatTurns} výmen v rozhovore${s.jarvis.jobs.length ? `, dokončené úlohy na pozadí: ${s.jarvis.jobs.map((j) => j.title).join(', ')}` : ''}.`)
  for (const n of r.notes ?? []) lines.push(`Poznámka: ${n}`)
  return lines.join('\n')
}

/**
 * Everything about one day. signals: "full" (the CLI and the evening routine), "light" (the voice
 * tool: no walk through the user's folders), "none".
 */
export async function dayReport(day = isoDay(), { signals = 'full', now = Date.now() } = {}) {
  const cfg = activityConfig()
  const records = readRecords(day)
  const agg = aggregate(records, { day, cfg, now })
  const notes = []
  const t = agg.totals
  if (!agg.samples) {
    notes.push(
      !cfg.enabled
        ? cfg.reason === 'config'
          ? 'Záznam aktivity je vypnutý (activity.enabled v config/jarvis.json).'
          : cfg.reason === 'setup'
            ? 'Jarvis ešte nie je nastavený, záznam aktivity nebeží.'
            : 'Záznam aktivity je v tomto procese vypnutý.'
        : 'Pre tento deň nie je žiadna vzorka: HUD ani pulz vtedy nebežali, alebo bol počítač vypnutý.',
    )
  } else {
    if (t.estimatedMin >= 5) notes.push(`${fmtDuration(t.estimatedMin)} je odhad: HUD vtedy nebežal a pulz sa pozrel len raz za pár minút.`)
    if (t.passiveMin >= 5) notes.push(`${fmtDuration(t.passiveMin)} bolo bez klávesnice a myši, ale bežal film, hovor alebo hra. Počítam to ako čas pri počítači.`)
    if (t.noDataMin >= 30) notes.push(`${fmtDuration(t.noDataMin)} medzi prvou a poslednou vzorkou je bez záznamu (počítač spal, bol vypnutý alebo Jarvis nebežal).`)
    if (t.privateMin >= 1) notes.push(`${fmtDuration(t.privateMin)} v súkromných appkách zo zoznamu ignore. Ich názvy sa neukladajú a nemajú sa spomínať.`)
    notes.push('Vidím len appku v popredí, nie čo sa v nej dialo. Čo presne sa robilo, hovoria commity, súbory, rozhovor a kalendár.')
  }
  const out = { ok: true, generatedAt: new Date(now).toISOString(), enabled: cfg.enabled, titles: cfg.titles, idleMinutes: cfg.idleMinutes, ...agg }
  if (signals !== 'none') {
    const full = signals === 'full'
    const jarvis = await withTimeout(jarvisSignal(day), 4000, { chatTurns: 0, tools: {}, jobs: [], routines: [] })
    const [git, files, todo] = await Promise.all([
      withTimeout(gitSignal(day, { full }), 8000, { available: false, note: 'Čítanie git projektov trvalo pridlho.', commits: 0, repos: [] }),
      full ? withTimeout(filesSignal(day), 22_000, { available: false, note: 'Čítanie priečinkov trvalo pridlho.', changed: 0, created: 0, names: [] }) : null,
      withTimeout(todoSignal(day, jarvis), 4000, { completedViaJarvis: 0, addedViaJarvis: 0, remindersFired: [], openDueByToday: [], note: '' }),
    ])
    const { tools, ...jarvisPublic } = jarvis
    out.signals = { git, ...(files ? { files } : {}), jarvis: jarvisPublic, todos: todo }
  }
  out.notes = notes
  out.daysWithLog = activityDays().length
  out.summary = summaryText(out)
  return out
}
