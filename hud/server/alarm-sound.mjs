/**
 * The sound of the alarm clock. Before the spoken brief Jarvis plays either his built-in chime, the
 * song that setup downloaded, or any sound the user gave him.
 *
 *   config/jarvis.json  "alarm": { …, "sound": "default" | "builtin" | "sound-custom.mp3", "soundSeconds": 45 }
 *
 *   no "sound" key, or "default"   the downloaded song when it is on the disk, otherwise the chime
 *   "builtin"                      always the chime
 *   a file name                    that file in data/alarm (copied there by `alarm.mjs sound <file|url>`)
 *   an absolute path               played from where it is (for people who edit the config by hand)
 *
 * The files live in data/alarm:
 *   sound-default.mp3     the song from JARVIS_ALARM_SONG_URL (scripts/media.mjs prepare)
 *   sound-custom.<ext>    the user's own sound, one at a time
 *   ring-<name>-<n>s.mp3  the first n seconds with a fade in and out, which is what really plays
 *   sound.json            titles of the sounds, for the status line
 *
 * A missing or broken file never means silence: the chime plays instead.
 */
import './env.mjs'
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { ALARM_DIR } from './alarm.mjs'
import { CONFIG_FILE } from './config.mjs'
import { MediaError, cutClip, downloadAudio, ffmpeg, looksLikeUrl, mediaAvailable } from './media.mjs'
import { IS_MAC } from './util.mjs'

/** The song setup downloads as the default alarm sound. */
export const DEFAULT_SONG_URL = process.env.JARVIS_ALARM_SONG_URL || 'https://www.youtube.com/watch?v=l482T0yNkeo'
const DEFAULT_NAME = 'sound-default.mp3'
const META_FILE = join(ALARM_DIR, 'sound.json')
/** Formats the system players handle on their own (afplay, Windows Media). Everything else is converted to mp3. */
const NATIVE = new Set(['.mp3', '.wav', '.m4a'])
const CONVERTIBLE = new Set(['.aac', '.aiff', '.aif', '.flac', '.ogg', '.oga', '.opus', '.wma', '.mp4', '.mov', '.webm', '.mka'])
const MAX_BYTES = 300 * 1024 * 1024
const NAME_RE = /^sound-[a-z0-9-]{1,40}\.(mp3|wav|m4a)$/

const clamp = (n, min, max) => Math.min(max, Math.max(min, n))

function rawConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  } catch {
    return null
  }
}

function meta() {
  try {
    return JSON.parse(readFileSync(META_FILE, 'utf8')) ?? {}
  } catch {
    return {}
  }
}

function saveMeta(patch) {
  mkdirSync(ALARM_DIR, { recursive: true })
  writeFileSync(META_FILE, JSON.stringify({ ...meta(), ...patch }, null, 1))
}

/** How many seconds of the sound play before Jarvis starts to speak: "soundSeconds" in the config, JARVIS_ALARM_SOUND_SEC, or 45. */
export function soundSeconds(raw = rawConfig()) {
  const n = Number(raw?.alarm?.soundSeconds ?? process.env.JARVIS_ALARM_SOUND_SEC)
  return Number.isFinite(n) && n > 0 ? clamp(Math.round(n), 3, 300) : 45
}

/** The raw "sound" value from the config, or null when the user never chose. */
export function soundSetting(raw = rawConfig()) {
  const value = raw?.alarm?.sound
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

const usable = (file) => {
  try {
    const info = statSync(file)
    return info.isFile() && info.size > 2000 && info.size <= MAX_BYTES
  } catch {
    return false
  }
}

const clipFile = (source, secs) => join(ALARM_DIR, `ring-${basename(source, extname(source)).replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'sound'}-${secs}s.mp3`)

/** The prepared clip of `source`, when it exists and is newer than the sound it was cut from. */
function readyClip(source, secs) {
  const clip = clipFile(source, secs)
  try {
    return usable(clip) && statSync(clip).mtimeMs >= statSync(source).mtimeMs ? clip : null
  } catch {
    return null
  }
}

/**
 * What the alarm plays right now.
 * { kind: 'builtin' | 'default' | 'custom', file, play, prepared, seconds, title }
 * `play` is the file handed to the player (the prepared clip when there is one), null for the chime.
 */
export function resolveSound() {
  const raw = rawConfig()
  const setting = soundSetting(raw)
  const seconds = soundSeconds(raw)
  const builtin = { kind: 'builtin', file: null, play: null, prepared: false, seconds, title: 'zvonenie Jarvisa' }
  const titles = meta()
  const pick = (kind, file, title) => {
    const clip = readyClip(file, seconds)
    return { kind, file, play: clip ?? file, prepared: Boolean(clip), seconds, title }
  }
  if (setting === 'builtin' || setting === 'off') return builtin
  if (setting && setting !== 'default') {
    const file = isAbsolute(setting) ? setting : NAME_RE.test(setting) ? join(ALARM_DIR, setting) : null
    const ext = file ? extname(file).toLowerCase() : ''
    if (file && NATIVE.has(ext) && usable(file)) return pick('custom', file, titles.custom?.file === basename(file) ? titles.custom.title : basename(file))
    // The chosen file is gone or broken: the default song, then the chime.
  }
  const fallback = join(ALARM_DIR, DEFAULT_NAME)
  if (usable(fallback)) return pick('default', fallback, titles.default?.title || 'predvolená pesnička')
  return builtin
}

/** One sentence about the sound, for the status of the alarm. */
export function soundSummary(sound = resolveSound()) {
  if (sound.kind === 'builtin') return soundSetting() && !['builtin', 'off', 'default'].includes(soundSetting()) ? 'Zvuk: zvonenie Jarvisa (vybraný súbor sa nenašiel).' : 'Zvuk: zvonenie Jarvisa.'
  const what = sound.kind === 'default' ? `pesnička ${sound.title}` : `tvoj zvuk ${sound.title}`
  return `Zvuk: ${what}, hrá ${sound.seconds} sekúnd a potom hovorím.`
}

/** Writes alarm.sound (and nothing else) into config/jarvis.json. `null` removes the key. */
export function writeSoundSetting(value) {
  const raw = rawConfig() ?? {}
  const alarm = raw.alarm && typeof raw.alarm === 'object' && !Array.isArray(raw.alarm) ? { ...raw.alarm } : {}
  if (value === null) delete alarm.sound
  else alarm.sound = value
  raw.alarm = alarm
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, `${JSON.stringify(raw, null, 2)}\n`)
}

/** Does the file start like the audio format its name promises? Cheap, and the same on every system. */
function looksLikeAudio(file) {
  const head = Buffer.alloc(16)
  let fd
  try {
    fd = openSync(file, 'r')
    readSync(fd, head, 0, 16, 0)
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  const ext = extname(file).toLowerCase()
  if (ext === '.mp3') return head.toString('latin1', 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)
  if (ext === '.wav') return head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE'
  if (ext === '.m4a') return head.toString('latin1', 4, 8) === 'ftyp'
  return true
}

/** Can the system really decode it? On macOS afinfo says so in a few milliseconds. */
function decodable(file) {
  if (!IS_MAC) return true
  try {
    execFileSync('/usr/bin/afinfo', [file], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

/** Removes the clips cut from a sound that is being replaced. */
function dropClips(prefix) {
  try {
    for (const name of readdirSync(ALARM_DIR)) if (name.startsWith(`ring-${prefix}-`)) rmSync(join(ALARM_DIR, name), { force: true })
  } catch {
    // nothing to remove
  }
}

/** Cuts the clip that really plays (fade in, the first seconds, fade out). Without uv the whole file is played and the player stops it. */
async function prepareClip(source, { signal = null } = {}) {
  if (!mediaAvailable().ok) return false
  const secs = soundSeconds()
  return cutClip(source, clipFile(source, secs), { seconds: secs, fadeIn: Math.min(6, secs / 3), fadeOut: Math.min(3, secs / 4), signal })
}

/**
 * Makes sure the default song is on the disk (downloads its audio once).
 * Returns { ok, state: 'skipped' | 'done', file, title, bytes, duration }.
 */
export async function ensureDefaultSong({ onProgress = null, signal = null, force = false } = {}) {
  const file = join(ALARM_DIR, DEFAULT_NAME)
  mkdirSync(ALARM_DIR, { recursive: true })
  if (!force && usable(file) && decodable(file)) {
    if (!readyClip(file, soundSeconds())) await prepareClip(file, { signal })
    const known = meta().default ?? {}
    return { ok: true, state: 'skipped', file, title: known.title ?? null, bytes: statSync(file).size, duration: known.duration ?? null }
  }
  const res = await downloadAudio(DEFAULT_SONG_URL, file, { onProgress, signal })
  if (!decodable(file)) {
    rmSync(file, { force: true })
    throw new MediaError('failed', 'Stiahnutá pesnička sa nedá prehrať.')
  }
  saveMeta({ default: { title: res.info.title, url: DEFAULT_SONG_URL, duration: res.info.duration, at: new Date().toISOString() } })
  dropClips('sound-default')
  onProgress?.({ state: 'converting', pct: null })
  await prepareClip(file, { signal })
  return { ok: true, state: 'done', file, title: res.info.title, bytes: res.bytes, duration: res.info.duration }
}

/**
 * Sets the alarm sound from what the user gave: "default", "builtin" (or "off"), a link to a video
 * or a path to a sound file. Returns { ok, kind, title, summary }. Throws MediaError or Error with
 * a Slovak message.
 */
export async function setSound(input, { onProgress = null, signal = null } = {}) {
  const value = String(input ?? '').trim()
  if (!value) throw new Error('Chýba zvuk: daj mi súbor mp3, wav alebo m4a, odkaz na video, alebo slovo default či builtin.')
  const word = value.toLowerCase()

  if (word === 'builtin' || word === 'off' || word === 'zvonenie') {
    writeSoundSetting('builtin')
    return { ok: true, ...describe() }
  }
  if (word === 'default' || word === 'predvolene' || word === 'predvolené') {
    const song = await ensureDefaultSong({ onProgress, signal })
    writeSoundSetting('default')
    return { ok: true, downloaded: song.state === 'done', ...describe() }
  }

  mkdirSync(ALARM_DIR, { recursive: true })
  const clearCustom = () => {
    for (const ext of NATIVE) rmSync(join(ALARM_DIR, `sound-custom${ext}`), { force: true })
    dropClips('sound-custom')
  }

  if (/^https?:\/\//i.test(value)) {
    if (!looksLikeUrl(value)) throw new MediaError('url')
    const target = join(ALARM_DIR, 'sound-custom.mp3')
    const tmp = join(ALARM_DIR, 'sound-incoming.mp3')
    const res = await downloadAudio(value, tmp, { onProgress, signal })
    if (!decodable(tmp)) {
      rmSync(tmp, { force: true })
      throw new MediaError('failed', 'Stiahnutý zvuk sa nedá prehrať.')
    }
    clearCustom()
    copyFileSync(tmp, target)
    rmSync(tmp, { force: true })
    saveMeta({ custom: { file: basename(target), title: res.info.title, source: value, at: new Date().toISOString() } })
    onProgress?.({ state: 'converting', pct: null })
    await prepareClip(target, { signal })
    writeSoundSetting(basename(target))
    return { ok: true, ...describe() }
  }

  const source = resolve(value.replace(/^["']|["']$/g, ''))
  let info
  try {
    info = statSync(source)
  } catch {
    throw new Error(`Súbor ${source} som nenašiel.`)
  }
  if (!info.isFile()) throw new Error('To je priečinok. Potrebujem jeden zvukový súbor.')
  const ext = extname(source).toLowerCase()
  if (!NATIVE.has(ext) && !CONVERTIBLE.has(ext)) throw new Error('Tento typ súboru ako budík nepoužijem. Daj mi mp3, wav alebo m4a.')
  if (info.size < 2000) throw new Error('Ten súbor je prázdny.')
  if (info.size > MAX_BYTES) throw new Error('Ten súbor je na budík priveľký (viac ako 300 MB).')
  const title = basename(source, extname(source)).replace(/[_-]+/g, ' ').trim().slice(0, 80) || 'vlastný zvuk'

  let target
  if (NATIVE.has(ext)) {
    if (!looksLikeAudio(source) || !decodable(source)) throw new Error('Ten súbor sa nedá prehrať, vyzerá poškodený. Skús iný, najlepšie mp3.')
    target = join(ALARM_DIR, `sound-custom${ext}`)
    const tmp = join(ALARM_DIR, `sound-incoming${ext}`)
    copyFileSync(source, tmp)
    clearCustom()
    copyFileSync(tmp, target)
    rmSync(tmp, { force: true })
  } else {
    // Other formats go through ffmpeg once and stay as mp3.
    if (!mediaAvailable().ok) throw new Error('Tento formát si neviem previesť (chýba uv). Daj mi mp3, wav alebo m4a.')
    const tmp = join(ALARM_DIR, 'sound-incoming.mp3')
    onProgress?.({ state: 'converting', pct: null })
    const res = await ffmpeg(['-y', '-i', source, '-vn', '-ar', '44100', '-ac', '2', '-codec:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', tmp], { signal, timeoutMs: 300_000 }).catch(() => ({ code: 1 }))
    if (res.code !== 0 || !usable(tmp) || !decodable(tmp)) {
      rmSync(tmp, { force: true })
      throw new Error('Ten súbor sa nepodarilo previesť na zvuk. Skús mp3, wav alebo m4a.')
    }
    target = join(ALARM_DIR, 'sound-custom.mp3')
    clearCustom()
    copyFileSync(tmp, target)
    rmSync(tmp, { force: true })
  }
  saveMeta({ custom: { file: basename(target), title, source: basename(source), at: new Date().toISOString() } })
  await prepareClip(target, { signal })
  writeSoundSetting(basename(target))
  return { ok: true, ...describe() }
}

/** The current sound for a JSON answer: { kind, title, seconds, prepared, summary }. */
export function describe() {
  const sound = resolveSound()
  return { kind: sound.kind, title: sound.title, seconds: sound.seconds, prepared: sound.prepared, file: sound.file, summary: soundSummary(sound) }
}
