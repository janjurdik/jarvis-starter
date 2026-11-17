/**
 * The video theater: Jarvis takes a link to a video, downloads it and "analyses" it on the HUD.
 *
 *   POST /api/video { url }                 starts the analysis and opens the theater → { ok, video }
 *   GET  /api/video                         { ok, current, videos }: recent analyses, newest first
 *   GET  /api/video/:id                     { ok, video, transcript, peaks, position }
 *   GET  /api/video/:id/file                the video itself (range requests)
 *   GET  /api/video/:id/thumb               its thumbnail
 *   GET  /api/video/:id/transcript          text with timestamps for the brain (?from=&to=&q=&max=)
 *   POST /api/video/:id/seek { t }          jumps to a time (seconds, "mm:ss", "h:mm:ss", "+30", "-10")
 *   POST /api/video/:id/control { action }  play | pause | rate (with { rate }) | close
 *   POST /api/video/:id/position { t, … }   the page reports where playback is (not broadcast)
 *
 * `:id` may be the word `current` for the video that is open right now.
 *
 * Everything the page needs arrives as SSE `video` events:
 *   { type: 'open', url, video }       the theater opens (video is null until the metadata is known)
 *   { type: 'state', video }           the whole state of one video changed
 *   { type: 'progress', id, step, state, pct, text }
 *   { type: 'transcript', id }         new transcript lines are ready to fetch
 *   { type: 'seek', id, t, label, by } { type: 'control', id, action, rate }
 *   { type: 'error', url, error }      the link could not be opened at all
 *
 * Files of one video live in data/video/<id>/: meta.json, video.<ext>, thumb.<ext>, transcript.json,
 * peaks.json. Only the newest few are kept (JARVIS_VIDEO_KEEP, JARVIS_VIDEO_CACHE_GB).
 *
 * Text that comes out of a video (title, description, transcript) is untrusted data: the tools
 * hand it to the brain framed as such, never as instructions.
 */
import './env.mjs'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { LIMITS, MediaError, audioPeaks, checkUrl, downloadVideo, mediaAvailable, mediaId, probe, splitAudio, subtitles } from './media.mjs'
import { send } from './sse.mjs'
import { sttLocal, transcribeFile } from './stt.mjs'
import { DATA_DIR, errMsg, log, readJson, sendJson, writeFileAtomic } from './util.mjs'

export const VIDEO_DIR = join(DATA_DIR, 'video')
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
const KEEP = Math.max(1, Math.min(200, Math.round(Number(process.env.JARVIS_VIDEO_KEEP) || 6)))
const CACHE_BYTES = Math.max(0.2, Number(process.env.JARVIS_VIDEO_CACHE_GB) || 6) * 1024 ** 3
const MAX_HEIGHT = Math.max(144, Math.min(2160, Math.round(Number(process.env.JARVIS_VIDEO_HEIGHT) || 720)))
const WHISPER_MAX_S = Math.max(1, Number(process.env.JARVIS_VIDEO_WHISPER_MAX_MIN) || 60) * 60
const TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', jpg: 'image/jpeg', webp: 'image/webp', png: 'image/png' }

const videos = new Map() // id → entry (the same shape as meta.json)
const running = new Map() // id → AbortController of its analysis
let current = null
let position = null // { id, t, paused, rate, at }
let seekedAt = 0 // a jump from the server: reports the page sent before it landed are ignored for a moment
let loading = null // the one read of data/video at start
let openSeq = 0 // a close or a newer open while the metadata is being read cancels that open
const listeners = new Set([(payload) => send('video', payload)])

/** Another listener for the events (the command line shows progress with it). Returns a function that removes it. */
export function onVideoEvent(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit(payload) {
  for (const fn of listeners) {
    try {
      fn(payload)
    } catch {
      // a listener must never stop the analysis
    }
  }
}

// ── ids, paths, time ────────────────────────────────────────────────────

/** The folder of one video, or null when the id is not one of ours (path containment). */
function dirOf(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null
  const dir = join(VIDEO_DIR, id)
  return dir.startsWith(VIDEO_DIR + sep) ? dir : null
}

/** YouTube links carry the id in the address: an analysed video opens without asking the site again. */
function quickId(url) {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^(www|m|music)\./, '')
    let id = null
    if (host === 'youtu.be') id = u.pathname.split('/')[1]
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') id = u.pathname === '/watch' ? u.searchParams.get('v') : /^\/(shorts|embed|live|v)\/([^/]+)/.exec(u.pathname)?.[2]
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? mediaId('Youtube', id) : null
  } catch {
    return null
  }
}

/** The start time a YouTube link asks for (?t=754, ?t=12m34s), in seconds. */
function linkStart(url) {
  try {
    const raw = new URL(url).searchParams.get('t') ?? new URL(url).searchParams.get('start')
    return raw ? parseTime(raw) : null
  } catch {
    return null
  }
}

/** "12:40" | "1:02:03" | "754" | "12m40s" | "+30" | "-10" → seconds. Relative values use `from`. */
export function parseTime(value, from = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = String(value ?? '').trim().toLowerCase().replace(',', '.')
  if (!raw || raw.length > 24) return null
  const rel = /^[+-]/.test(raw) ? (raw[0] === '-' ? -1 : 1) : 0
  const body = rel ? raw.slice(1).trim() : raw
  let secs = null
  if (/^\d+(\.\d+)?$/.test(body)) secs = Number(body)
  else if (/^\d{1,3}(:\d{1,2}){1,2}(\.\d+)?$/.test(body)) secs = body.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
  else {
    const m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/.exec(body)
    if (m && (m[1] || m[2] || m[3])) secs = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  }
  if (secs === null || !Number.isFinite(secs)) return null
  return rel ? from + rel * secs : secs
}

/** 754 → "12:34", 3725 → "1:02:05". */
export function stamp(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// ── state on disk ───────────────────────────────────────────────────────

/** Reads the saved videos once. Every caller waits for the same read, so nobody sees a half-filled list. */
function load() {
  loading ??= readSaved()
  return loading
}

async function readSaved() {
  for (const name of await readdir(VIDEO_DIR).catch(() => [])) {
    const dir = dirOf(name)
    if (!dir) continue
    try {
      const entry = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))
      if (entry?.id !== name) continue
      // An analysis that was running when the server stopped did not finish.
      if (entry.state !== 'ready' && entry.state !== 'error') Object.assign(entry, { state: 'error', error: { code: 'cancelled', text: 'Analýza sa prerušila. Otvor video znova a dokončím ju.' } })
      if (entry.transcript?.state === 'pending') entry.transcript = { ...entry.transcript, state: 'none', note: 'Prepis sa nedokončil.' }
      videos.set(name, entry)
    } catch {
      // a folder without readable metadata is removed by the next prune
    }
  }
}

const save = (entry) => writeFileAtomic(join(dirOf(entry.id), 'meta.json'), JSON.stringify(entry, null, 1)).catch((err) => log('video', `stav sa nepodarilo uložiť: ${errMsg(err)}`))

/** What leaves the server about one video (no local paths). */
function pub(entry) {
  if (!entry) return null
  const { file, thumb, ...rest } = entry
  return {
    ...rest,
    hasFile: Boolean(file),
    fileUrl: file ? `/api/video/${entry.id}/file` : null,
    thumbUrl: thumb ? `/api/video/${entry.id}/thumb` : null,
    open: current === entry.id,
  }
}

function update(entry, patch, { quiet = false } = {}) {
  Object.assign(entry, patch)
  if (!quiet) emit({ type: 'state', video: pub(entry) })
  return save(entry)
}

function progress(entry, step, state, pct, text) {
  entry.step = { key: step, state, pct: Number.isFinite(pct) ? pct : null, text }
  emit({ type: 'progress', id: entry.id, step, state, pct: entry.step.pct, text })
}

async function folderBytes(dir) {
  let total = 0
  for (const name of await readdir(dir).catch(() => [])) total += (await stat(join(dir, name)).catch(() => ({ size: 0 }))).size
  return total
}

/** Keeps the newest videos and removes the rest (never the one that is open or being analysed). */
async function prune() {
  await load()
  const order = [...videos.values()].sort((a, b) => String(b.openedAt ?? '').localeCompare(String(a.openedAt ?? '')))
  let used = 0
  let kept = 0
  for (const entry of order) {
    const dir = dirOf(entry.id)
    const size = await folderBytes(dir)
    const pinned = entry.id === current || running.has(entry.id)
    if (pinned || (kept < KEEP && used + size <= CACHE_BYTES)) {
      kept++
      used += size
      continue
    }
    videos.delete(entry.id)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    log('video', `zmazané staršie video ${entry.id}`)
  }
  // Folders nobody knows about (an interrupted first download).
  for (const name of await readdir(VIDEO_DIR).catch(() => [])) {
    if (!videos.has(name) && dirOf(name)) await rm(dirOf(name), { recursive: true, force: true }).catch(() => {})
  }
}

// ── the analysis ────────────────────────────────────────────────────────

const userLangs = () => {
  const lang = (process.env.JARVIS_LANG || 'sk').toLowerCase().slice(0, 2)
  return lang === 'cs' ? ['cs', 'sk'] : ['sk', 'cs']
}

/** Failures of a download that often pass on a second try. */
const TRANSIENT = new Set(['unavailable', 'network', 'failed', 'rate', 'bot', 'timeout'])

const failure = (err) => (err instanceof MediaError ? { code: err.code, text: err.message } : { code: 'failed', text: `Analýza zlyhala: ${errMsg(err).slice(0, 200)}` })

async function saveThumb(entry, url, signal) {
  try {
    // Node 20.0 has no AbortSignal.any: one controller that follows both the analysis and a timeout.
    const stop = new AbortController()
    const timer = setTimeout(() => stop.abort(), 15_000)
    signal.addEventListener('abort', () => stop.abort(), { once: true })
    const res = await fetch(checkUrl(url), { redirect: 'error', signal: stop.signal }).finally(() => clearTimeout(timer))
    const type = String(res.headers.get('content-type') ?? '').split(';')[0].trim()
    const ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' }[type]
    if (!res.ok || !ext) return
    const data = Buffer.from(await res.arrayBuffer())
    if (data.length < 200 || data.length > 6_000_000) return
    await writeFile(join(dirOf(entry.id), `thumb.${ext}`), data)
    await update(entry, { thumb: `thumb.${ext}` })
  } catch {
    // no thumbnail: the theater shows its own placeholder
  }
}

const countWords = (segments) => segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0)

async function writeTranscript(entry, segments, info) {
  await writeFileAtomic(join(dirOf(entry.id), 'transcript.json'), JSON.stringify(segments))
  await update(entry, { transcript: { state: info.state ?? 'ready', source: info.source, lang: info.lang ?? null, lines: segments.length, words: countWords(segments), note: info.note ?? null } }, { quiet: true })
  emit({ type: 'transcript', id: entry.id })
  emit({ type: 'state', video: pub(entry) })
}

/** Subtitles from the site. They come first (two or three seconds), so the transcript is there while the video still downloads. */
async function transcriptFromSubtitles(entry, info, signal) {
  try {
    const subs = await subtitles(entry.url, userLangs(), { info, signal, dir: join(dirOf(entry.id), 'subs') })
    await rm(join(dirOf(entry.id), 'subs'), { recursive: true, force: true }).catch(() => {})
    if (!subs) return false
    await writeTranscript(entry, subs.segments, { source: subs.auto ? 'auto' : 'subtitles', lang: subs.lang })
    return true
  } catch (err) {
    if (signal.aborted) throw err
    log('video', `titulky sa nepodarilo stiahnuť: ${errMsg(err)}`)
    return false
  }
}

/** No subtitles anywhere: the local Whisper listens to the sound, 25 seconds at a time. Only when it is installed. */
async function transcriptFromWhisper(entry, file, signal) {
  if (!sttLocal()) return update(entry, { transcript: { state: 'none', source: null, lang: null, lines: 0, words: 0, note: 'Video nemá titulky. S lokálnym prepisom reči (docs/HLAS.md) by som ho vedel prepísať sám.' } })
  if (entry.duration && entry.duration > WHISPER_MAX_S) return update(entry, { transcript: { state: 'none', source: null, lang: null, lines: 0, words: 0, note: `Video nemá titulky a na vlastný prepis je príliš dlhé (limit ${Math.round(WHISPER_MAX_S / 60)} minút).` } })
  const CHUNK = 25
  const work = join(dirOf(entry.id), 'stt')
  try {
    progress(entry, 'transcript', 'converting', 0, 'Pripravujem zvuk na prepis')
    const parts = await splitAudio(file, work, { chunkS: CHUNK, signal })
    if (!parts.length) throw new Error('zvuk sa nepodarilo rozdeliť')
    const segments = []
    for (let i = 0; i < parts.length; i++) {
      if (signal.aborted) throw new MediaError('cancelled')
      progress(entry, 'transcript', 'downloading', Math.round((i / parts.length) * 100), `Počúvam, čo sa hovorí (${stamp(i * CHUNK)})`)
      const heard = await transcribeFile(parts[i]).catch(() => ({ text: '' }))
      const line = String(heard.text ?? '').replace(/\s+/g, ' ').trim()
      if (line) segments.push({ start: i * CHUNK, end: Math.min((i + 1) * CHUNK, entry.duration || (i + 1) * CHUNK), text: line })
      // Lines appear in the theater while the rest is still being listened to.
      if (segments.length && (i % 6 === 5 || i === parts.length - 1)) await writeTranscript(entry, segments, { state: i === parts.length - 1 ? 'ready' : 'pending', source: 'whisper', lang: (process.env.JARVIS_LANG || 'sk').slice(0, 2) })
    }
    if (!segments.length) await update(entry, { transcript: { state: 'none', source: 'whisper', lang: null, lines: 0, words: 0, note: 'Vo videu som nepočul žiadnu reč.' } })
  } catch (err) {
    if (signal.aborted) throw err
    log('video', `vlastný prepis zlyhal: ${errMsg(err)}`)
    await update(entry, { transcript: { state: 'error', source: 'whisper', lang: null, lines: entry.transcript?.lines ?? 0, words: entry.transcript?.words ?? 0, note: 'Prepis sa nepodarilo dokončiť.' } })
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

async function analyse(entry, info) {
  const control = new AbortController()
  running.set(entry.id, control)
  const { signal } = control
  const dir = dirOf(entry.id)
  try {
    await mkdir(dir, { recursive: true })
    if (info.thumbnail && !entry.thumb) saveThumb(entry, info.thumbnail, signal)
    await update(entry, { state: 'downloading', error: null })
    // One request to the site at a time: two at once make YouTube refuse one of them now and then.
    let hasSubs = entry.transcript?.state === 'ready'
    if (!hasSubs) {
      progress(entry, 'transcript', 'checking', null, 'Hľadám titulky')
      hasSubs = await transcriptFromSubtitles(entry, info, signal)
    }

    if (!entry.file) {
      const fetchVideo = () => {
        progress(entry, 'video', 'downloading', 0, 'Sťahujem video')
        return downloadVideo(entry.url, dir, {
          info,
          signal,
          maxHeight: MAX_HEIGHT,
          onProgress: (p) => {
            if (p.state === 'downloading') progress(entry, 'video', 'downloading', p.pct, 'Sťahujem video')
            else if (p.state === 'converting') progress(entry, 'video', 'converting', null, 'Skladám obraz a zvuk')
          },
        })
      }
      let got
      try {
        got = await fetchVideo()
      } catch (err) {
        // The site answered the metadata a moment ago, so a refusal now is usually a passing one: one more try.
        if (signal.aborted || !(err instanceof MediaError) || !TRANSIENT.has(err.code)) throw err
        log('video', `${entry.id}: prvý pokus zlyhal (${err.code}), skúšam ešte raz${err.raw ? ` [${err.raw}]` : ''}`)
        await new Promise((r) => setTimeout(r, 2500))
        if (signal.aborted) throw err
        got = await fetchVideo()
      }
      entry.file = `video.${got.ext}`
      entry.bytes = got.bytes
    }
    // Playable from here on. The waveform and a transcript by Whisper may still be on their way.
    progress(entry, hasSubs ? 'waveform' : 'transcript', 'checking', null, hasSubs ? 'Meriam zvuk' : 'Hľadám prepis')
    await update(entry, { state: 'ready', error: null, transcript: hasSubs ? entry.transcript : { state: 'pending', source: 'whisper', lang: null, lines: 0, words: 0, note: null } })

    const file = join(dir, entry.file)
    if (!entry.peaks) {
      const peaks = await audioPeaks(file, { signal }).catch(() => null)
      if (peaks) {
        await writeFileAtomic(join(dir, 'peaks.json'), JSON.stringify(peaks))
        await update(entry, { peaks: true })
      }
    }
    if (!hasSubs) await transcriptFromWhisper(entry, file, signal)
    progress(entry, 'done', 'done', 100, 'Analýza je hotová')
    await save(entry)
    log('video', `pripravené ${entry.id} (${Math.round((entry.bytes ?? 0) / 1024 / 1024)} MB, prepis: ${entry.transcript?.state ?? 'žiadny'})`)
  } catch (err) {
    const error = signal.aborted ? { code: 'cancelled', text: 'Analýzu som zastavil.' } : failure(err)
    if (!signal.aborted) log('video', `${entry.id}: ${error.text}${err?.raw ? ` [${err.raw}]` : ''}`)
    // A video that already plays stays usable even when a later step failed.
    if (entry.file && entry.state === 'ready') await update(entry, { transcript: entry.transcript?.state === 'pending' ? { ...entry.transcript, state: 'none', note: 'Prepis sa nedokončil.' } : entry.transcript })
    else await update(entry, { state: 'error', error })
  } finally {
    if (running.get(entry.id) === control) running.delete(entry.id)
    prune().catch(() => {})
  }
}

// ── actions ─────────────────────────────────────────────────────────────

const fresh = (id, url) => ({
  id,
  url,
  title: 'Video',
  uploader: '',
  duration: null,
  chapters: [],
  state: 'probing',
  step: { key: 'probe', state: 'checking', pct: null, text: 'Čítam údaje o videu' },
  file: null,
  thumb: null,
  bytes: null,
  peaks: false,
  transcript: { state: 'pending', source: null, lang: null, lines: 0, words: 0, note: null },
  error: null,
  createdAt: new Date().toISOString(),
  openedAt: new Date().toISOString(),
})

/**
 * Opens a video in the theater and starts its analysis. Resolves as soon as the metadata is known
 * (the download goes on in the background) with the public state of the video.
 */
export async function openVideo(input, { wait = false } = {}) {
  const url = checkUrl(input)
  if (!mediaAvailable().ok) throw new MediaError('no-uv')
  await load()
  const startAt = linkStart(url)
  const known = quickId(url)
  const cached = known ? videos.get(known) : null
  if (cached && (cached.state === 'ready' || running.has(cached.id))) {
    current = cached.id
    cached.openedAt = new Date().toISOString()
    await save(cached)
    emit({ type: 'open', url, video: pub(cached), startAt })
    prune().catch(() => {})
    return pub(cached)
  }

  const seq = ++openSeq
  emit({ type: 'open', url, video: null, startAt })
  let info
  try {
    info = await probe(url)
    if (seq !== openSeq) throw new MediaError('cancelled')
    if (info.live) throw new MediaError('live')
    if (info.duration && info.duration > LIMITS.videoSeconds) throw new MediaError('too-long', `Video má ${Math.round(info.duration / 60)} minút a limit je ${Math.round(LIMITS.videoSeconds / 60)}. Limit sa dá zmeniť v .env (JARVIS_VIDEO_MAX_MIN).`)
  } catch (err) {
    const error = failure(err)
    if (seq === openSeq) emit({ type: 'error', url, error })
    throw err instanceof MediaError ? err : new MediaError('failed', error.text)
  }
  const id = info.key && ID_RE.test(info.key) ? info.key : null
  if (!id || !dirOf(id)) {
    emit({ type: 'error', url, error: { code: 'unsupported', text: 'Toto video neviem uložiť.' } })
    throw new MediaError('unsupported')
  }
  // One analysis at a time: a new video ends the download of the previous one.
  for (const [other, control] of running) if (other !== id) control.abort()

  const entry = videos.get(id) ?? fresh(id, info.url || url)
  Object.assign(entry, {
    url: info.url || url,
    title: info.title,
    uploader: info.uploader,
    duration: info.duration,
    chapters: info.chapters,
    extractor: info.extractor,
    views: info.views,
    uploaded: info.uploaded,
    language: info.language,
    description: info.description,
    openedAt: new Date().toISOString(),
    error: null,
  })
  if (entry.state !== 'ready') entry.state = 'downloading'
  videos.set(id, entry)
  current = id
  await mkdir(dirOf(id), { recursive: true })
  await save(entry)
  emit({ type: 'open', url, video: pub(entry), startAt })
  if (!running.has(id)) {
    const job = analyse(entry, info)
    if (wait) await job
  }
  return pub(entry)
}

async function entryOf(id) {
  await load()
  const key = id === 'current' ? current : id
  return key && dirOf(key) ? videos.get(key) ?? null : null
}

const need = (entry) => {
  if (!entry) throw Object.assign(new Error('Také video nemám. Otvor ho najprv cez odkaz.'), { status: 404 })
  return entry
}

/** Jumps to a time. Opens the theater on that video when it is not the one on screen. */
export async function seekVideo(id, time, { by = 'jarvis' } = {}) {
  const entry = need(await entryOf(id))
  const from = position?.id === entry.id ? position.t : 0
  const wanted = parseTime(time, from)
  if (wanted === null) throw Object.assign(new Error('Čas nerozumiem. Napíš sekundy alebo tvar 12:40.'), { status: 400 })
  const t = Math.max(0, Math.min(entry.duration ? Math.max(0, entry.duration - 1) : wanted, wanted))
  if (current !== entry.id) {
    current = entry.id
    entry.openedAt = new Date().toISOString()
    await save(entry)
    emit({ type: 'open', url: entry.url, video: pub(entry), startAt: null })
  }
  position = { id: entry.id, t, paused: position?.id === entry.id ? position.paused : false, rate: position?.id === entry.id ? position.rate : 1, at: Date.now() }
  seekedAt = Date.now()
  emit({ type: 'seek', id: entry.id, t, label: stamp(t), by })
  return { id: entry.id, t, label: stamp(t), ready: entry.state === 'ready' }
}

/** play | pause | rate | close. */
export async function controlVideo(id, action, { rate = null } = {}) {
  if (action === 'close') {
    const was = current
    current = null
    position = null
    openSeq++
    // Closing the theater ends a download that has not finished: nobody is waiting for it.
    for (const control of running.values()) control.abort()
    emit({ type: 'control', id: was, action: 'close' })
    prune().catch(() => {})
    return { id: was, action }
  }
  const entry = need(await entryOf(id))
  if (action === 'rate') {
    const value = Number(rate)
    if (!Number.isFinite(value) || value < 0.25 || value > 3) throw Object.assign(new Error('Rýchlosť je číslo od 0.25 do 3.'), { status: 400 })
    emit({ type: 'control', id: entry.id, action, rate: Math.round(value * 100) / 100 })
    return { id: entry.id, action, rate: value }
  }
  if (action !== 'play' && action !== 'pause') throw Object.assign(new Error('Neznáma akcia. Poznám play, pause, rate a close.'), { status: 400 })
  emit({ type: 'control', id: entry.id, action })
  return { id: entry.id, action }
}

async function readSegments(entry) {
  try {
    const list = JSON.parse(await readFile(join(dirOf(entry.id), 'transcript.json'), 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * The transcript as text for the brain: one line per segment, "[12:40] text". A window (from, to),
 * lines matching a query (with one line of context), or around the current position by default
 * when the whole text would not fit.
 */
export async function transcriptText(id, { from = null, to = null, query = '', max = 9000 } = {}) {
  const entry = need(await entryOf(id))
  const segments = await readSegments(entry)
  const head = { id: entry.id, title: entry.title, duration: entry.duration, state: entry.transcript?.state ?? 'none', source: entry.transcript?.source ?? null, lang: entry.transcript?.lang ?? null, total: segments.length }
  if (!segments.length) return { ...head, text: '', lines: 0, truncated: false, note: entry.transcript?.state === 'pending' ? 'Prepis sa ešte pripravuje, skús to o chvíľu.' : entry.transcript?.note || 'Toto video nemá prepis.' }
  const limit = Math.max(500, Math.min(30_000, Math.round(Number(max) || 9000)))
  const now = position?.id === entry.id ? position.t : 0
  const a = from === null || from === '' ? null : parseTime(from, now)
  const b = to === null || to === '' ? null : parseTime(to, now)
  let picked = segments.map((s, i) => ({ ...s, i }))
  if (a !== null) picked = picked.filter((s) => s.end > a)
  if (b !== null) picked = picked.filter((s) => s.start < b)
  const q = fold(String(query ?? '').trim().slice(0, 120))
  let matches = null
  if (q) {
    const words = q.split(/\s+/).filter(Boolean)
    const hits = new Set(picked.filter((s) => words.every((w) => fold(s.text).includes(w))).map((s) => s.i))
    matches = hits.size
    const keep = new Set()
    for (const i of hits) for (const j of [i - 1, i, i + 1]) keep.add(j)
    picked = picked.filter((s) => keep.has(s.i)).map((s) => ({ ...s, hit: hits.has(s.i) }))
  }
  const lines = picked.map((s) => `[${stamp(s.start)}]${s.hit ? ' *' : ''} ${s.text}`)
  let out = []
  let size = 0
  let truncated = false
  for (const line of lines) {
    if (size + line.length + 1 > limit) {
      truncated = true
      break
    }
    out.push(line)
    size += line.length + 1
  }
  const last = picked[out.length - 1]
  return {
    ...head,
    text: out.join('\n'),
    lines: out.length,
    matches,
    truncated,
    note: truncated && last ? `Text sa nezmestil celý. Pokračovanie: from="${stamp(last.end)}".` : null,
    position: position?.id === entry.id ? stamp(position.t) : null,
  }
}

/** Recent analyses, newest first. */
export async function listVideos() {
  await load()
  return [...videos.values()].sort((a, b) => String(b.openedAt ?? '').localeCompare(String(a.openedAt ?? ''))).map(pub)
}

/** Ends running downloads (server shutdown). */
export function stopVideo() {
  for (const control of running.values()) control.abort()
}

// ── HTTP ────────────────────────────────────────────────────────────────

/** A file with range requests, so the browser can jump around in the video. */
async function serveMedia(req, res, file, type) {
  let info
  try {
    info = await stat(file)
  } catch {
    return sendJson(res, 404, { ok: false, error: 'súbor nie je' })
  }
  if (!info.isFile()) return sendJson(res, 404, { ok: false, error: 'súbor nie je' })
  const headers = { 'content-type': type, 'cache-control': 'private, max-age=3600', 'accept-ranges': 'bytes', 'last-modified': info.mtime.toUTCString(), 'x-content-type-options': 'nosniff' }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : info.size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : info.size - 1
    start = Math.max(0, start)
    end = Math.min(info.size - 1, end)
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` })
      return res.end()
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1 })
    if (req.method === 'HEAD') return res.end()
    return createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res)
  }
  res.writeHead(200, { ...headers, 'content-length': info.size })
  if (req.method === 'HEAD') return res.end()
  return createReadStream(file).on('error', () => res.destroy()).pipe(res)
}

const fail = (res, err) => sendJson(res, err.status ?? 500, { ok: false, error: err.message, code: err.code ?? null })

/** GET /api/video…: returns true when the request was one of ours. */
export async function routeVideoGet(req, res, url) {
  const path = url.pathname
  if (path === '/api/video') {
    sendJson(res, 200, { ok: true, current, available: mediaAvailable().ok, videos: await listVideos() })
    return true
  }
  const m = /^\/api\/video\/([A-Za-z0-9_-]{1,100})(?:\/(file|thumb|transcript))?$/.exec(path)
  if (!m) return false
  try {
    const entry = need(await entryOf(m[1]))
    const dir = dirOf(entry.id)
    if (m[2] === 'file' || m[2] === 'thumb') {
      const name = m[2] === 'file' ? entry.file : entry.thumb
      // Only the two names this module wrote itself, never anything from the request.
      if (!name || !/^(video|thumb)\.[a-z0-9]{2,4}$/.test(name)) throw Object.assign(new Error(m[2] === 'file' ? 'video sa ešte sťahuje' : 'náhľad nie je'), { status: 404 })
      await serveMedia(req, res, join(dir, name), TYPES[name.split('.').pop()] ?? 'application/octet-stream')
      return true
    }
    if (m[2] === 'transcript') {
      const q = url.searchParams
      sendJson(res, 200, { ok: true, ...(await transcriptText(entry.id, { from: q.get('from'), to: q.get('to'), query: q.get('q') ?? '', max: q.get('max') })) })
      return true
    }
    let peaks = null
    if (entry.peaks) peaks = await readFile(join(dir, 'peaks.json'), 'utf8').then(JSON.parse).catch(() => null)
    sendJson(res, 200, { ok: true, video: pub(entry), transcript: url.searchParams.get('brief') === '1' ? null : await readSegments(entry), peaks: url.searchParams.get('brief') === '1' ? null : peaks, position: position?.id === entry.id ? position : null })
  } catch (err) {
    fail(res, err)
  }
  return true
}

/** POST /api/video…: returns true when the request was one of ours. The caller has already checked who is asking. */
export async function routeVideoPost(req, res, path) {
  if (path !== '/api/video' && !path.startsWith('/api/video/')) return false
  try {
    const body = await readJson(req, 8000)
    if (path === '/api/video') {
      const video = await openVideo(body.url)
      sendJson(res, 200, { ok: true, video })
      return true
    }
    const m = /^\/api\/video\/([A-Za-z0-9_-]{1,100})\/(seek|control|position)$/.exec(path)
    if (!m) {
      sendJson(res, 404, { ok: false, error: `nenájdené: POST ${path}` })
      return true
    }
    if (m[2] === 'seek') sendJson(res, 200, { ok: true, ...(await seekVideo(m[1], body.t ?? body.time, { by: body.by === 'user' ? 'user' : 'jarvis' })) })
    else if (m[2] === 'control') sendJson(res, 200, { ok: true, ...(await controlVideo(m[1], String(body.action ?? ''), { rate: body.rate })) })
    else {
      const entry = need(await entryOf(m[1]))
      const t = Number(body.t)
      if (Number.isFinite(t) && t >= 0 && Date.now() - seekedAt > 2500) position = { id: entry.id, t, paused: body.paused === true, rate: Number(body.rate) > 0 ? Number(body.rate) : 1, at: Date.now() }
      sendJson(res, 200, { ok: true })
    }
  } catch (err) {
    fail(res, err)
  }
  return true
}
