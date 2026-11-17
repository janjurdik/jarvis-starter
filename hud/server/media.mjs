/**
 * Media from the web: yt-dlp and ffmpeg without any manual install.
 *
 * Both run through uv, which Jarvis already needs for his voice: a small Python launcher
 * (media/ytdlp_worker.py) gets a pinned yt-dlp and the ffmpeg binary from imageio-ffmpeg, so the
 * same code works on macOS and Windows. JARVIS_YTDLP_BIN points at a system yt-dlp instead
 * (then ffmpeg comes from PATH or JARVIS_FFMPEG_BIN).
 *
 *   probe(url)                         metadata: id, title, uploader, duration, chapters, thumbnail
 *   downloadAudio(url, outFile)        the audio as mp3
 *   downloadVideo(url, dir, opts)      one playable file (mp4 when possible), at most opts.maxHeight
 *   subtitles(url, langs, opts)        subtitles as segments [{ start, end, text }]
 *   ffmpeg(args), audioPeaks(file), cutClip(src, out), splitAudio(file, dir)
 *
 * Every call takes { signal, timeoutMs, onProgress }. Errors are MediaError with a `code` and a
 * Slovak message that can be shown or spoken as it is.
 *
 * Security: this starts programs with a URL that came from a conversation. Nothing is ever built
 * into a shell string, the URL must be http(s) to a public host and always follows `--`, yt-dlp
 * runs with --ignore-config and without plugins, and output names are fixed (no templates from
 * the outside).
 */
import './env.mjs'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { dirname, extname, join } from 'node:path'
import { DATA_DIR, findBin, IS_WIN, ROOT, spawnBin, winSys, workerEnv } from './util.mjs'

/** Pinned versions: a new yt-dlp goes in here after it was tried (see docs/VIDEO.md). */
export const YTDLP_PIN = '2026.10.26'
const IMAGEIO_FFMPEG_PIN = '0.8.1'
const WORKER = join(ROOT, 'server', 'media', 'ytdlp_worker.py')
const MEDIA_DIR = join(DATA_DIR, 'media')
const HEAL_FILE = join(MEDIA_DIR, 'ytdlp.json')
const HEAL_DAYS = 14

const UV = findBin('uv', { override: process.env.UV_BIN })
const wantBin = String(process.env.JARVIS_YTDLP_BIN ?? '').trim()
const YTDLP_BIN = wantBin ? (wantBin === 'system' ? findBin('yt-dlp') : existsSync(wantBin) ? wantBin : null) : null
const FFMPEG_SYS = findBin('ffmpeg', { override: process.env.JARVIS_FFMPEG_BIN })

const num = (value, fallback, min, max) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : fallback
}

/** Limits, all configurable in .env. */
export const LIMITS = {
  /** Longest video that is downloaded, in seconds (JARVIS_VIDEO_MAX_MIN, default 180 minutes). */
  videoSeconds: num(process.env.JARVIS_VIDEO_MAX_MIN, 180, 1, 720) * 60,
  /** Biggest video file in bytes (JARVIS_VIDEO_MAX_MB, default 1500 MB). */
  videoBytes: num(process.env.JARVIS_VIDEO_MAX_MB, 1500, 10, 20_000) * 1024 * 1024,
  /** Longest audio that becomes a sound (the alarm), in seconds (JARVIS_AUDIO_MAX_MIN, default 30 minutes). */
  audioSeconds: num(process.env.JARVIS_AUDIO_MAX_MIN, 30, 1, 240) * 60,
}

const MESSAGES = {
  'no-uv': 'Na sťahovanie videí chýba program uv. Nainštaluje sa pri nastavení Jarvisa (krok 1), potom to pôjde.',
  setup: 'Nepodarilo sa pripraviť yt-dlp. Najčastejšie chýba internet, skús to o chvíľu znova.',
  url: 'Toto nie je odkaz na video. Potrebujem adresu, ktorá začína na https://.',
  network: 'Nepodarilo sa pripojiť. Buď nejde internet, alebo stránka s videom neodpovedá.',
  unavailable: 'Video nie je dostupné. Je zmazané, súkromné alebo zablokované v tejto krajine.',
  age: 'Video má vekové obmedzenie a bez prihlásenia sa nedá stiahnuť.',
  login: 'Video je len pre prihlásených, bez prihlásenia sa nedá stiahnuť.',
  bot: 'YouTube si teraz pýta potvrdenie, že nie si robot. Skús to o pár minút znova.',
  rate: 'Stránka ma na chvíľu zablokovala, lebo som sa pýtal príliš často. Skús to o pár minút.',
  live: 'Živé vysielanie sa nedá stiahnuť. Skús to, keď skončí.',
  unsupported: 'Na tejto adrese som nenašiel video, ktoré viem stiahnuť.',
  playlist: 'Toto je celý zoznam videí. Pošli mi odkaz na jedno konkrétne video.',
  'too-long': 'Video je príliš dlhé.',
  'too-big': 'Video je príliš veľké.',
  timeout: 'Trvalo to príliš dlho, tak som to zrušil.',
  cancelled: 'Zrušené.',
  ffmpeg: 'Chýba ffmpeg, bez neho zvuk ani video nespracujem.',
  failed: 'Sťahovanie zlyhalo.',
}

export class MediaError extends Error {
  constructor(code, detail = '') {
    super(detail || MESSAGES[code] || MESSAGES.failed)
    this.name = 'MediaError'
    this.code = code
    this.status = code === 'url' || code === 'playlist' ? 400 : code === 'cancelled' ? 499 : 502
  }
}

/** Is there a way to run yt-dlp at all? { ok, via: 'uv' | 'bin' | null } */
export function mediaAvailable() {
  return YTDLP_BIN ? { ok: true, via: 'bin' } : UV ? { ok: true, via: 'uv' } : { ok: false, via: null }
}

// ── the URL ─────────────────────────────────────────────────────────────

function privateHost(host) {
  if (isIP(host)) return privateIp(host)
  return host === 'localhost' || !host.includes('.') || /\.(localhost|local|internal|lan|home|intranet)$/.test(host)
}

function privateIp(ip) {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase()
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)
    if (mapped) return privateIp(mapped[1])
    return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)
  }
  const [a, b] = ip.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
}

/**
 * The only kind of address yt-dlp ever gets: http(s), no credentials, a public host.
 * Returns the normalised URL (it always starts with "http", so it can never be read as an option).
 */
export function checkUrl(input) {
  const raw = String(input ?? '').trim()
  if (!raw || raw.length > 2048 || /[\u0000- \u007f]/.test(raw)) throw new MediaError('url')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new MediaError('url')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new MediaError('url')
  if (url.username || url.password) throw new MediaError('url')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || privateHost(host)) throw new MediaError('url')
  return url.href
}

/**
 * checkUrl plus a look at where the name really points: a public-looking name that resolves to
 * this computer or the home network (192.168.1.1.nip.io and friends) is refused too.
 */
export async function publicUrl(input) {
  const href = checkUrl(input)
  const host = new URL(href).hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return href
  let found = []
  try {
    found = await lookup(host, { all: true })
  } catch {
    throw new MediaError('network')
  }
  if (!found.length || found.some((a) => privateIp(a.address))) throw new MediaError('url')
  return href
}

/** True when the text is nothing but one link that looks like a video address. */
export function looksLikeUrl(text) {
  try {
    checkUrl(text)
    return true
  } catch {
    return false
  }
}

// ── running the tools ───────────────────────────────────────────────────

let healed = undefined
/** After the pinned yt-dlp failed on a site and the newest one worked, the newest is used for two weeks. */
async function useLatest() {
  if (healed !== undefined) return healed
  healed = false
  try {
    const saved = JSON.parse(await readFile(HEAL_FILE, 'utf8'))
    healed = saved.pin === YTDLP_PIN && Date.now() - Date.parse(saved.at) < HEAL_DAYS * 86_400_000
  } catch {
    healed = false
  }
  return healed
}

async function rememberLatest() {
  healed = true
  await mkdir(MEDIA_DIR, { recursive: true }).catch(() => {})
  await writeFile(HEAL_FILE, JSON.stringify({ pin: YTDLP_PIN, at: new Date().toISOString() })).catch(() => {})
}

const autoUpdate = () => process.env.JARVIS_YTDLP_AUTOUPDATE !== '0' && !process.env.JARVIS_YTDLP_VERSION && !YTDLP_BIN

/** The command line for one tool run: { bin, argv }. */
function command(mode, args, { latest = false, refresh = false } = {}) {
  if (YTDLP_BIN) {
    if (mode === 'ytdlp') return { bin: YTDLP_BIN, argv: [...(FFMPEG_SYS ? ['--ffmpeg-location', FFMPEG_SYS] : []), ...args] }
    if (!FFMPEG_SYS) throw new MediaError('ffmpeg')
    return { bin: FFMPEG_SYS, argv: args }
  }
  if (!UV) throw new MediaError('no-uv')
  const version = process.env.JARVIS_YTDLP_VERSION || YTDLP_PIN
  const ytdlp = latest ? 'yt-dlp[default]' : `yt-dlp[default]==${version}`
  return {
    bin: UV,
    argv: [
      'run', '--quiet', '--no-project', '--python', '>=3.11',
      ...(refresh ? ['--refresh-package', 'yt-dlp', '--refresh-package', 'yt-dlp-ejs'] : []),
      '--with', ytdlp, '--with', `imageio-ffmpeg==${IMAGEIO_FFMPEG_PIN}`,
      'python', WORKER, mode, ...args,
    ],
  }
}

/** Ends a child with everything it started (uv → python → ffmpeg). */
function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return
  if (IS_WIN) {
    try {
      spawn(winSys('taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
      return
    } catch {
      // falls through to a plain kill
    }
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  setTimeout(() => {
    if (child.exitCode !== null) return
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }, 4000).unref()
}

/**
 * Runs one tool. stdout goes line by line to `onLine`, or is collected whole (`collect`, a byte
 * limit). Returns { code, stdout: Buffer, stderr: string }. Rejects with MediaError on abort or timeout.
 */
function run(mode, args, { signal = null, timeoutMs = 120_000, onLine = null, onData = null, collect = 0, cwd = undefined, latest = false, refresh = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new MediaError('cancelled'))
    let spec
    try {
      spec = command(mode, args, { latest, refresh })
    } catch (err) {
      return reject(err)
    }
    let child
    try {
      // Its own process group on macOS and Linux, so a cancelled download takes ffmpeg down with it.
      child = spawnBin(spec.bin, spec.argv, {
        cwd,
        detached: !IS_WIN,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...workerEnv(), PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(FFMPEG_SYS && process.env.JARVIS_FFMPEG_BIN ? { JARVIS_FFMPEG_BIN: FFMPEG_SYS } : {}) },
      })
    } catch (err) {
      return reject(new MediaError('setup', `Program sa nepodarilo spustiť: ${err.message}`))
    }
    const chunks = []
    let size = 0
    let pending = ''
    let stderr = ''
    let ended = null
    const finish = (fn, value) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }
    const onAbort = () => {
      ended = new MediaError('cancelled')
      killTree(child)
    }
    const timer = setTimeout(() => {
      ended = new MediaError('timeout')
      killTree(child)
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (data) => {
      if (onData) onData(data)
      if (collect && size < collect) {
        chunks.push(data)
        size += data.length
      }
      if (!onLine) return
      pending += data.toString('utf8')
      let cut
      while ((cut = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, cut).replace(/\r$/, '')
        pending = pending.slice(cut + 1)
        if (line) onLine(line)
      }
      if (pending.length > 65_536) pending = ''
    })
    child.stderr.on('data', (data) => (stderr = `${stderr}${data}`.slice(-12_000)))
    child.on('error', (err) => finish(reject, new MediaError('setup', `Program sa nepodarilo spustiť: ${err.message}`)))
    child.on('close', (code) => {
      if (ended) return finish(reject, ended)
      if (onLine && pending.trim()) onLine(pending.trim())
      finish(resolve, { code: code ?? 1, stdout: Buffer.concat(chunks), stderr })
    })
  })
}

/** What went wrong, from yt-dlp's (or uv's) error output. `raw` keeps the tool's own last error line for the log. */
function classify(stderr) {
  const problem = classifyText(stderr)
  problem.raw = String(stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ').slice(0, 600)
  return problem
}

function classifyText(stderr) {
  const text = String(stderr ?? '')
  const last = text.split('\n').filter((l) => /^ERROR:/.test(l.trim())).at(-1) ?? ''
  const has = (re) => re.test(text)
  if (!last && has(/error: .*(Failed to (fetch|download)|No solution found|failed to resolve|client error \(Connect\)|dns error|Request failed)/is)) return new MediaError('setup')
  if (has(/confirm you.{0,3}re not a bot/i)) return new MediaError('bot')
  if (has(/confirm your age|age[- ]restricted|inappropriate for some users|age verification/i)) return new MediaError('age')
  if (has(/HTTP Error 429|Too Many Requests/i)) return new MediaError('rate')
  if (has(/is live|live event|live stream|will begin in|Premieres in|is_live|is_upcoming/i) && !has(/was live/i)) return new MediaError('live')
  if (has(/Private video|video is private|members[- ]only|Join this channel|requires payment|login required|log in|Sign in to|This video is only available to|registered users|use --cookies/i)) return new MediaError('login')
  if (has(/Video unavailable|video is unavailable|video (is )?not available|has been removed|no longer available|not available in your country|geo.?restrict|blocked (it )?(in|on)|account .*terminated|does not exist|removed by the uploader|HTTP Error 40[34]|HTTP Error 410|This video is not available/i)) return new MediaError('unavailable')
  if (has(/Unsupported URL|No video formats found|no video could be found|Requested format is not available|No media found/i)) return new MediaError('unsupported')
  if (has(/Unable to download webpage|getaddrinfo|Name or service not known|nodename nor servname|Temporary failure in name resolution|timed out|Connection refused|Network is unreachable|TransportError|urlopen error|Connection reset|No address associated|SSL:|RemoteDisconnected/i)) return new MediaError('network')
  const detail = last.replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*[\w-]*:?\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 200)
  return new MediaError('failed', detail ? `Sťahovanie zlyhalo: ${detail}` : MESSAGES.failed)
}

/** Options every yt-dlp run gets. */
const BASE = [
  '--ignore-config', '--no-plugin-dirs', '--no-playlist', '--playlist-items', '1', '--color', 'never', '--no-warnings',
  '--socket-timeout', '20', '--retries', '3', '--fragment-retries', '3', '--no-mtime', '--no-cache-dir',
  // YouTube needs a JavaScript runtime for its player code: the Node that runs this server.
  '--js-runtimes', `node:${process.execPath}`,
]

/**
 * One yt-dlp run. When the pinned version fails in a way that looks like an outdated extractor,
 * the newest yt-dlp is tried once (and kept for two weeks when it works).
 */
async function ytdlp(args, opts = {}) {
  const latest = await useLatest()
  const first = await run('ytdlp', [...BASE, ...args], { ...opts, latest })
  if (first.code === 0) return first
  const problem = classify(first.stderr)
  const outdated = problem.code === 'failed' || problem.code === 'unsupported' || problem.code === 'bot'
  if (!outdated || latest || !autoUpdate() || mediaAvailable().via !== 'uv') throw problem
  const second = await run('ytdlp', [...BASE, ...args], { ...opts, latest: true, refresh: true }).catch(() => null)
  if (second?.code !== 0) throw problem
  await rememberLatest()
  return second
}

/** Makes sure the tools are downloaded and start: { ytdlp: "<version>", ffmpeg: "<path>" | null, via }. */
export async function warm({ signal = null, timeoutMs = 300_000 } = {}) {
  if (YTDLP_BIN) {
    const res = await run('ytdlp', ['--version'], { signal, timeoutMs: 30_000, collect: 2000 })
    if (res.code !== 0) throw new MediaError('setup', 'Nastavený program yt-dlp sa nepodarilo spustiť (JARVIS_YTDLP_BIN).')
    return { ytdlp: res.stdout.toString('utf8').trim(), ffmpeg: FFMPEG_SYS, via: 'bin' }
  }
  const res = await run('where', [], { signal, timeoutMs, collect: 4000, latest: await useLatest() })
  if (res.code !== 0) throw classify(res.stderr).code === 'failed' ? new MediaError('setup') : classify(res.stderr)
  try {
    const info = JSON.parse(res.stdout.toString('utf8').trim().split('\n').at(-1))
    return { ytdlp: String(info.ytdlp), ffmpeg: String(info.ffmpeg), via: 'uv' }
  } catch {
    throw new MediaError('setup')
  }
}

// ── metadata ────────────────────────────────────────────────────────────

const text = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '')
const seconds = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value) * 100) / 100 : null)

/** Languages that have subtitles: { lang: [ext, …] }, without live chat and other non-speech tracks. */
function tracks(map, limit) {
  const out = {}
  for (const [lang, list] of Object.entries(map && typeof map === 'object' ? map : {})) {
    if (!/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8}){0,2}$/.test(lang) || !Array.isArray(list)) continue
    out[lang] = list.map((f) => String(f?.ext ?? '')).filter(Boolean).slice(0, 12)
    if (Object.keys(out).length >= limit) break
  }
  return out
}

/** A short, safe id for folders and URLs: "youtube-l482T0yNkeo". */
export function mediaId(extractor, id) {
  const clean = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 48)
  const out = [clean(extractor).toLowerCase(), clean(id)].filter(Boolean).join('-')
  return out || null
}

function slim(raw) {
  const info = raw?._type === 'playlist' ? raw.entries?.find((e) => e && typeof e === 'object') : raw
  if (!info || typeof info !== 'object' || !info.id) throw new MediaError(raw?._type === 'playlist' ? 'playlist' : 'unsupported')
  const live = info.is_live === true || info.live_status === 'is_live' || info.live_status === 'is_upcoming'
  const chapters = (Array.isArray(info.chapters) ? info.chapters : [])
    .map((c) => ({ start: seconds(c?.start_time), end: seconds(c?.end_time), title: text(c?.title, 120) }))
    .filter((c) => c.start !== null && c.title)
    .slice(0, 200)
  return {
    id: String(info.id).slice(0, 64),
    key: mediaId(info.extractor_key ?? info.extractor, info.id),
    extractor: text(info.extractor_key ?? info.extractor, 40),
    url: text(info.webpage_url ?? info.original_url, 2048),
    title: text(info.title, 200) || 'Video',
    uploader: text(info.uploader ?? info.channel ?? info.creator, 120),
    duration: seconds(info.duration),
    chapters,
    thumbnail: /^https:\/\//.test(info.thumbnail ?? '') ? String(info.thumbnail).slice(0, 2048) : null,
    live,
    ageLimit: Number(info.age_limit) || 0,
    width: Number(info.width) || null,
    height: Number(info.height) || null,
    fps: Number(info.fps) || null,
    views: Number.isFinite(Number(info.view_count)) ? Number(info.view_count) : null,
    uploaded: /^\d{8}$/.test(info.upload_date ?? '') ? `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6)}` : null,
    language: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(info.language ?? '') ? info.language : null,
    description: text(info.description, 800),
    sizeApprox: Number(info.filesize_approx ?? info.filesize) || null,
    subtitles: tracks(info.subtitles, 80),
    autoCaptions: tracks(info.automatic_captions, 400),
  }
}

/** Metadata of one video. Nothing is downloaded. */
export async function probe(url, { signal = null, timeoutMs = 90_000 } = {}) {
  const target = await publicUrl(url)
  const res = await ytdlp(['--dump-single-json', '--skip-download', '--', target], { signal, timeoutMs, collect: 24_000_000 })
  let raw
  try {
    raw = JSON.parse(res.stdout.toString('utf8'))
  } catch {
    throw new MediaError('unsupported')
  }
  return slim(raw)
}

// ── downloads ───────────────────────────────────────────────────────────

const PROGRESS = ['--newline', '--progress', '--progress-delta', '0.4', '--progress-template', 'download:JPROG|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(info.format_id)s', '--progress-template', 'postprocess:JPOST|%(progress.status)s|%(progress.postprocessor)s']

/**
 * Turns yt-dlp's progress lines into { state: 'downloading' | 'converting', pct }. A video with a
 * separate sound track arrives as two files: the second one continues where the first ended.
 */
function progressReader(onProgress, { total = null } = {}) {
  let file = null
  let doneBefore = 0
  let lastTotal = 0
  let files = 0
  let lastPct = -1
  return (line) => {
    if (!onProgress) return
    if (line.startsWith('JPOST|')) {
      if (line.split('|')[1] === 'started') onProgress({ state: 'converting', pct: null })
      return
    }
    if (!line.startsWith('JPROG|')) return
    const [, , done, exact, estimate, format] = line.split('|')
    const got = Number(done) || 0
    const size = Number(exact) || Number(estimate) || 0
    if (format !== file) {
      if (file !== null) doneBefore += lastTotal
      file = format
      files++
    }
    lastTotal = size || lastTotal
    let pct
    if (total && total > 0) pct = ((doneBefore + got) / Math.max(total, doneBefore + size)) * 100
    else if (size > 0) pct = files <= 1 ? (got / size) * 85 : 85 + (got / size) * 15
    else return
    pct = Math.max(0, Math.min(99, Math.floor(pct)))
    if (pct === lastPct) return
    lastPct = pct
    onProgress({ state: 'downloading', pct })
  }
}

async function emptyDir(dir) {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
}

/** The finished file yt-dlp left in `dir` under a fixed base name. */
async function produced(dir, base, exts) {
  const names = await readdir(dir).catch(() => [])
  for (const ext of exts) if (names.includes(`${base}.${ext}`)) return join(dir, `${base}.${ext}`)
  return null
}

function tooLong(info, limitS) {
  if (info.live) throw new MediaError('live')
  if (info.duration && info.duration > limitS) throw new MediaError('too-long', `Má ${Math.round(info.duration / 60)} minút a limit je ${Math.round(limitS / 60)}. Limit sa dá zmeniť v .env.`)
}

/**
 * The audio of a video as an mp3 file at `outFile` (a temporary folder next to it is used and removed).
 * Returns { file, info, bytes }.
 */
export async function downloadAudio(url, outFile, { signal = null, timeoutMs = 600_000, onProgress = null, info = null, maxSeconds = LIMITS.audioSeconds } = {}) {
  const target = await publicUrl(url)
  const meta = info ?? (await probe(target, { signal }))
  tooLong(meta, maxSeconds)
  const tmp = `${outFile}.dl`
  await emptyDir(tmp)
  try {
    onProgress?.({ state: 'downloading', pct: 0 })
    await ytdlp(
      ['--format', 'bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '192K', '--max-filesize', '400M', '--output', 'audio.%(ext)s', ...PROGRESS, '--', target],
      { signal, timeoutMs, cwd: tmp, onLine: progressReader(onProgress) },
    )
    const made = await produced(tmp, 'audio', ['mp3'])
    if (!made) throw new MediaError('failed', 'Zvuk sa nepodarilo previesť na mp3.')
    await mkdir(dirname(outFile), { recursive: true })
    await rename(made, outFile)
    const bytes = (await stat(outFile)).size
    if (bytes < 2000) throw new MediaError('failed', 'Stiahnutý zvuk je prázdny.')
    onProgress?.({ state: 'done', pct: 100 })
    return { file: outFile, info: meta, bytes }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

const VIDEO_EXTS = ['mp4', 'webm', 'mkv', 'mov', 'm4v']

/**
 * One playable file `video.<ext>` in `dir`: H.264 with AAC in mp4 when the site has it (plays in
 * every browser and in the desktop app), at most `maxHeight` pixels high.
 * Returns { file, ext, info, bytes }.
 */
export async function downloadVideo(url, dir, { maxHeight = 720, signal = null, timeoutMs = 3_600_000, onProgress = null, info = null, maxSeconds = LIMITS.videoSeconds, maxBytes = LIMITS.videoBytes } = {}) {
  const target = await publicUrl(url)
  const meta = info ?? (await probe(target, { signal }))
  tooLong(meta, maxSeconds)
  const h = Math.max(144, Math.min(2160, Math.round(Number(maxHeight) || 720)))
  await mkdir(dir, { recursive: true })
  for (const name of await readdir(dir).catch(() => [])) if (/^video\./.test(name)) await rm(join(dir, name), { force: true })
  onProgress?.({ state: 'downloading', pct: 0 })
  await ytdlp(
    [
      '--format', `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`,
      '--format-sort', `vcodec:h264,res:${h},acodec:aac,ext:mp4:m4a`,
      '--merge-output-format', 'mp4',
      '--max-filesize', `${Math.round(maxBytes / 1024 / 1024)}M`,
      '--output', 'video.%(ext)s',
      ...PROGRESS,
      '--', target,
    ],
    { signal, timeoutMs, cwd: dir, onLine: progressReader(onProgress) },
  )
  const file = await produced(dir, 'video', VIDEO_EXTS)
  if (!file) throw new MediaError('too-big', `Video je väčšie ako ${Math.round(maxBytes / 1024 / 1024)} MB, tak som ho nesťahoval. Limit sa dá zmeniť v .env.`)
  const bytes = (await stat(file)).size
  if (bytes > maxBytes * 1.1) {
    await rm(file, { force: true })
    throw new MediaError('too-big', `Video má ${Math.round(bytes / 1024 / 1024)} MB a limit je ${Math.round(maxBytes / 1024 / 1024)}. Limit sa dá zmeniť v .env.`)
  }
  onProgress?.({ state: 'done', pct: 100 })
  return { file, ext: extname(file).slice(1), info: meta, bytes }
}

// ── subtitles ───────────────────────────────────────────────────────────

const base = (lang) => String(lang).toLowerCase().split(/[-_]/)[0]

/**
 * Which subtitle track to take: written by people first (the user's languages, the video's own
 * language, English, anything), then the automatic captions in the language that is spoken.
 * Returns { lang, auto } or null.
 */
export function pickSubtitle(info, langs = []) {
  const manual = Object.keys(info?.subtitles ?? {})
  const auto = Object.keys(info?.autoCaptions ?? {})
  const want = [...new Set(langs.map(base).filter(Boolean))]
  const spoken = info?.language ? base(info.language) : auto.find((l) => /-orig$/i.test(l)) ? base(auto.find((l) => /-orig$/i.test(l))) : null
  const find = (list, lang) => list.find((l) => l.toLowerCase() === lang) ?? list.find((l) => base(l) === lang && !/-orig$/i.test(l)) ?? null
  for (const lang of want) {
    const hit = find(manual, lang)
    if (hit) return { lang: hit, auto: false }
  }
  for (const lang of [spoken, 'en'].filter(Boolean)) {
    const hit = find(manual, lang)
    if (hit) return { lang: hit, auto: false }
  }
  if (manual.length) return { lang: manual[0], auto: false }
  const orig = auto.find((l) => /-orig$/i.test(l))
  if (orig) return { lang: orig, auto: true }
  for (const lang of [spoken, ...want, 'en'].filter(Boolean)) {
    const hit = find(auto, lang)
    if (hit) return { lang: hit, auto: true }
  }
  return null
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const plain = (s) =>
  String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
      if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? m
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 31 && n < 0x10ffff ? String.fromCodePoint(n) : ''
    })
    .replace(/[\u0000-\u001f\u007f​-‏﻿]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** YouTube's json3: events with word pieces. → raw cues [{ start, end, text }] */
function cuesFromJson3(source) {
  const data = JSON.parse(source)
  const cues = []
  for (const ev of Array.isArray(data?.events) ? data.events : []) {
    if (!Array.isArray(ev?.segs) || !Number.isFinite(ev.tStartMs)) continue
    const line = plain(ev.segs.map((s) => s?.utf8 ?? '').join(''))
    if (!line) continue
    cues.push({ start: ev.tStartMs / 1000, end: (ev.tStartMs + (Number(ev.dDurationMs) || 0)) / 1000, text: line })
  }
  return cues
}

const clock = (s) => {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim())
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000 : null
}

/** WebVTT (and SRT, which differs only in details). Automatic captions repeat the previous line in every cue: those repeats are dropped. */
function cuesFromVtt(source) {
  const cues = []
  let lastLine = ''
  for (const block of String(source).replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n')
    const at = lines.findIndex((l) => l.includes('-->'))
    if (at < 0) continue
    const [from, to] = lines[at].split('-->').map((p) => clock(p.trim().split(/\s+/)[0]))
    if (from === null || to === null) continue
    const fresh = []
    for (const raw of lines.slice(at + 1)) {
      const line = plain(raw)
      if (!line || line === lastLine || fresh.includes(line)) continue
      fresh.push(line)
    }
    if (!fresh.length) continue
    if (to - from < 0.05 && cues.length) continue
    lastLine = fresh.at(-1)
    cues.push({ start: from, end: to, text: fresh.join(' ') })
  }
  return cues
}

/**
 * Raw cues → transcript lines people can read: neighbouring cues are joined until a sentence ends
 * or the line is about seven seconds long. Times never overlap.
 */
export function toSegments(cues, { maxSeconds = 7, maxChars = 200 } = {}) {
  const sorted = cues.filter((c) => c.text && Number.isFinite(c.start)).sort((a, b) => a.start - b.start)
  for (let i = 0; i < sorted.length; i++) {
    const next = sorted[i + 1]
    if (!(sorted[i].end > sorted[i].start)) sorted[i].end = next ? next.start : sorted[i].start + 3
    if (next && sorted[i].end > next.start) sorted[i].end = Math.max(sorted[i].start + 0.2, next.start)
  }
  const out = []
  let cur = null
  for (const cue of sorted) {
    const gap = cur ? cue.start - cur.end : 0
    const fits = cur && gap < 1.5 && cue.end - cur.start <= maxSeconds && cur.text.length + cue.text.length + 1 <= maxChars && !/[.!?…]["”')]?$/.test(cur.text)
    if (fits) {
      cur.text = `${cur.text} ${cue.text}`
      cur.end = cue.end
    } else {
      if (cur) out.push(cur)
      cur = { start: cue.start, end: cue.end, text: cue.text }
    }
    if (out.length >= 20_000) break
  }
  if (cur) out.push(cur)
  return out.map((s) => ({ start: Math.round(s.start * 100) / 100, end: Math.round(s.end * 100) / 100, text: s.text }))
}

/**
 * Subtitles of a video as transcript lines. `langs` are the languages the user reads (most wanted
 * first). Returns { segments, lang, auto } or null when the video has none.
 */
export async function subtitles(url, langs = [], { signal = null, timeoutMs = 120_000, info = null, dir = null, onProgress = null } = {}) {
  const target = await publicUrl(url)
  const meta = info ?? (await probe(target, { signal }))
  const pick = pickSubtitle(meta, langs)
  if (!pick) return null
  const work = dir ?? join(MEDIA_DIR, `subs-${process.pid}-${Date.now().toString(36)}`)
  await mkdir(work, { recursive: true })
  for (const name of await readdir(work).catch(() => [])) if (/^subs\./.test(name)) await rm(join(work, name), { force: true })
  onProgress?.({ state: 'downloading', pct: null })
  try {
    await ytdlp(
      ['--skip-download', pick.auto ? '--write-auto-subs' : '--write-subs', '--sub-langs', pick.lang, '--sub-format', 'json3/vtt/srt/best', '--output', 'subs.%(ext)s', '--', target],
      { signal, timeoutMs, cwd: work },
    )
    const name = (await readdir(work)).find((n) => /^subs\..+\.(json3|vtt|srt)$/.test(n))
    if (!name) return null
    const source = await readFile(join(work, name), 'utf8')
    const cues = name.endsWith('.json3') ? cuesFromJson3(source) : cuesFromVtt(source)
    const segments = toSegments(cues)
    if (!segments.length) return null
    onProgress?.({ state: 'done', pct: 100 })
    return { segments, lang: pick.lang.replace(/-orig$/i, ''), auto: pick.auto }
  } finally {
    if (!dir) await rm(work, { recursive: true, force: true }).catch(() => {})
    else for (const name of await readdir(work).catch(() => [])) if (/^subs\./.test(name)) await rm(join(work, name), { force: true }).catch(() => {})
  }
}

// ── ffmpeg ──────────────────────────────────────────────────────────────

/** Runs ffmpeg with the given arguments. Returns { code, stdout, stderr }. */
export function ffmpeg(args, opts = {}) {
  return run('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], { timeoutMs: 180_000, ...opts })
}

/**
 * The loudness of a file over time, for the timeline: `buckets` numbers from 0 to 1.
 * The sound is decoded to 4 kHz mono and only peaks are kept, nothing is stored.
 */
export async function audioPeaks(file, { buckets = 1200, signal = null, timeoutMs = 240_000 } = {}) {
  const WINDOW = 200 // samples: 50 ms at 4 kHz
  const windows = []
  let peak = 0
  let count = 0
  let odd = null
  const res = await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', '4000', '-f', 's16le', 'pipe:1'], {
    signal,
    timeoutMs,
    onData: (data) => {
      let buf = odd ? Buffer.concat([odd, data]) : data
      odd = buf.length % 2 ? buf.subarray(buf.length - 1) : null
      if (odd) buf = buf.subarray(0, buf.length - 1)
      for (let i = 0; i < buf.length; i += 2) {
        const v = Math.abs(buf.readInt16LE(i))
        if (v > peak) peak = v
        if (++count === WINDOW) {
          if (windows.length < 4_000_000) windows.push(peak)
          peak = 0
          count = 0
        }
      }
    },
  })
  if (res.code !== 0 || !windows.length) return null
  const n = Math.min(buckets, windows.length)
  const out = new Array(n).fill(0)
  for (let i = 0; i < windows.length; i++) {
    const b = Math.min(n - 1, Math.floor((i / windows.length) * n))
    if (windows[i] > out[b]) out[b] = windows[i]
  }
  const top = Math.max(...out) || 1
  return out.map((v) => Math.round((v / top) * 100) / 100)
}

/** The first `seconds` of a sound as an mp3 that fades in and out (the alarm). Returns true when it was made. */
export async function cutClip(src, out, { seconds: len = 45, fadeIn = 5, fadeOut = 3, signal = null } = {}) {
  const fade = Math.max(0, Math.min(fadeIn, len / 2))
  const tail = Math.max(0, Math.min(fadeOut, len / 3))
  const filters = [fade ? `afade=t=in:st=0:d=${fade}` : null, tail ? `afade=t=out:st=${Math.max(0, len - tail)}:d=${tail}` : null].filter(Boolean)
  const tmp = `${out}.${process.pid}.tmp.mp3`
  try {
    const res = await ffmpeg(['-y', '-i', src, '-vn', '-t', String(len), ...(filters.length ? ['-af', filters.join(',')] : []), '-ar', '44100', '-ac', '2', '-codec:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', tmp], { signal, timeoutMs: 120_000 })
    if (res.code !== 0 || (await stat(tmp)).size < 2000) return false
    await rename(tmp, out)
    return true
  } catch {
    return false
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

/** Splits the sound of a file into 16 kHz mono WAV pieces of `chunkS` seconds for the local Whisper. Returns the files in order. */
export async function splitAudio(file, dir, { chunkS = 25, signal = null, timeoutMs = 600_000 } = {}) {
  await emptyDir(dir)
  const res = await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'segment', '-segment_time', String(chunkS), '-c:a', 'pcm_s16le', 'part-%05d.wav'], { signal, timeoutMs, cwd: dir })
  if (res.code !== 0) return []
  return (await readdir(dir)).filter((n) => /^part-\d{5}\.wav$/.test(n)).sort().map((n) => join(dir, n))
}
