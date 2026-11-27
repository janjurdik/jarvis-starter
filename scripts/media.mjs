#!/usr/bin/env node
/**
 * Videos and sound from the web for Jarvis (yt-dlp and ffmpeg through uv, nothing to install by hand).
 *
 *   node scripts/media.mjs prepare [--json] [--progress]   setup: gets yt-dlp ready and downloads the default alarm song
 *   node scripts/media.mjs info <url> [--json]              what the video is: title, author, length, chapters
 *   node scripts/media.mjs audio <url> [--out file.mp3]     the sound of a video as mp3
 *   node scripts/media.mjs video <url> [--local]            opens the video in the HUD theater (downloads and analyses it);
 *                                                           --local or no running HUD: only downloads it into data/video
 *   node scripts/media.mjs transcript <url|id> [--json]     the transcript with times (subtitles of the video)
 *
 * --progress prints one JSON object per line while it works:
 *   {"step":"ytdlp|alarm-song|video|transcript","state":"checking|downloading|converting|done|skipped|error","pct":0-100|null,"text":"…"}
 * and a last line {"ok":true|false,…}. `prepare` never fails the setup: when something goes wrong it says so
 * and the alarm keeps its built-in sound.
 */
import '../hud/server/env.mjs'
import { resolve } from 'node:path'
import { join } from 'node:path'
import { DEFAULT_SONG_URL, SONGS, describe as describeSound, ensureDefaultSong, ensureSong, soundSetting } from '../hud/server/alarm-sound.mjs'
import { MediaError, checkUrl, downloadAudio, mediaAvailable, probe, subtitles, warm } from '../hud/server/media.mjs'
import { onVideoEvent, openVideo, stamp, transcriptText } from '../hud/server/video.mjs'
import { DATA_DIR, HUD_URL, hudAlive } from './lib.mjs'

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')[0]))
const value = (name) => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i < 0) return null
  return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1] ?? null
}
const rest = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && /^--(out)$/.test(argv[i - 1])))
const action = rest[0] ?? 'help'
const asJson = flags.has('json')
const asProgress = flags.has('progress')

/** One progress line. With --progress it is JSON, otherwise a short sentence (without --json). */
let lastShown = ''
function step(name, state, pct, text) {
  const line = { step: name, state, pct: Number.isFinite(pct) ? Math.round(pct) : null, text }
  if (asProgress) return console.log(JSON.stringify(line))
  if (asJson) return
  const shown = state === 'downloading' && line.pct !== null ? `${text} ${Math.floor(line.pct / 10) * 10} %` : text
  if (shown !== lastShown) console.log((lastShown = shown))
}

function finish(result, human) {
  if (asProgress) console.log(JSON.stringify(result))
  else if (asJson) console.log(JSON.stringify(result, null, 2))
  else if (human) console.log(human)
}

const problem = (err) => (err instanceof MediaError ? err.message : `Nepodarilo sa: ${String(err?.message ?? err).slice(0, 200)}`)
const langs = () => ((process.env.JARVIS_LANG || 'sk').toLowerCase().startsWith('cs') ? ['cs', 'sk'] : ['sk', 'cs'])
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

function needUrl() {
  const url = rest[1]
  if (!url) {
    console.error('Chýba odkaz na video.')
    process.exit(1)
  }
  try {
    return checkUrl(url)
  } catch (err) {
    finish({ ok: false, error: err.message }, err.message)
    process.exit(1)
  }
}

// ── prepare ─────────────────────────────────────────────────────────────

async function prepare() {
  const problems = []
  let tools = null
  let song = null

  step('ytdlp', 'checking', null, 'Pozerám, či mám nástroj na videá')
  if (!mediaAvailable().ok) {
    problems.push('Chýba uv, bez neho videá nestiahnem. Nainštaluje sa v kroku 1 nastavenia.')
    step('ytdlp', 'error', null, problems.at(-1))
  } else {
    try {
      step('ytdlp', 'downloading', null, 'Pripravujem yt-dlp (prvýkrát sa sťahuje, do minúty)')
      tools = await warm()
      step('ytdlp', 'done', 100, `yt-dlp ${tools.ytdlp} je pripravené`)
    } catch (err) {
      problems.push(problem(err))
      step('ytdlp', 'error', null, problems.at(-1))
    }
  }

  if (tools) {
    try {
      step('alarm-song', 'checking', null, 'Pozerám, či mám pesničku na budík')
      const res = await ensureDefaultSong({
        onProgress: (p) => {
          if (p.state === 'downloading') step('alarm-song', 'downloading', p.pct, 'Sťahujem pesničku na budík')
          else if (p.state === 'converting') step('alarm-song', 'converting', null, 'Pripravujem z nej zvonenie')
        },
      })
      song = { file: res.file, title: res.title, bytes: res.bytes, duration: res.duration, downloaded: res.state === 'done' }
      step('alarm-song', res.state === 'done' ? 'done' : 'skipped', 100, res.state === 'done' ? `Pesnička na budík je stiahnutá${res.title ? `: ${res.title}` : ''}` : 'Pesničku na budík už mám')
    } catch (err) {
      problems.push(`${problem(err)} Budík ostáva so zvonením Jarvisa.`)
      step('alarm-song', 'error', null, problems.at(-1))
    }
    // The other songs the alarm card offers: on the disk before the user is asked, so the short listen works at once.
    // One that fails is no problem of the setup: it is downloaded the moment it is chosen.
    for (const other of SONGS.slice(1)) {
      try {
        const res = await ensureSong(other, {
          onProgress: (p) => {
            if (p.state === 'downloading') step('alarm-song', 'downloading', p.pct, `Sťahujem druhú pesničku na výber: ${other.title}`)
            else if (p.state === 'converting') step('alarm-song', 'converting', null, 'Pripravujem z nej zvonenie')
          },
        })
        if (res.state === 'done') step('alarm-song', 'done', 100, `Na výber je aj ${other.title}`)
      } catch {
        step('alarm-song', 'skipped', null, `${other.title} stiahnem, keď si ju vyberieš`)
      }
    }
  } else {
    step('alarm-song', 'skipped', null, 'Pesničku na budík teraz nestiahnem, budík ostáva so zvonením Jarvisa')
  }

  const sound = describeSound()
  const { file, ...shown } = sound
  finish(
    { ok: problems.length === 0, ytdlp: tools?.ytdlp ?? null, song, sound: shown, chosenByUser: soundSetting() !== null, source: DEFAULT_SONG_URL, problems },
    [problems.length ? problems.join('\n') : 'Videá aj zvuk sú pripravené.', sound.summary, 'Vlastný zvuk budíka: daj Jarvisovi súbor mp3 a povedz „toto chcem ako budík".'].join('\n'),
  )
  // Setup must go on whatever happened here.
  process.exit(0)
}

// ── info, audio, video, transcript ──────────────────────────────────────

async function info() {
  const meta = await probe(needUrl())
  const { subtitles: subs, autoCaptions, ...short } = meta
  finish(
    { ok: true, ...short, subtitleLangs: Object.keys(subs), autoCaptionLangs: Object.keys(autoCaptions).length },
    [`${meta.title}`, [meta.uploader, meta.duration ? stamp(meta.duration) : null, meta.height ? `${meta.height}p` : null].filter(Boolean).join(' · '), meta.chapters.length ? `Kapitoly:\n${meta.chapters.map((c) => `  ${stamp(c.start)} ${c.title}`).join('\n')}` : null, `Titulky: ${Object.keys(subs).join(', ') || (Object.keys(autoCaptions).length ? 'len automatické' : 'žiadne')}`].filter(Boolean).join('\n'),
  )
}

async function audio() {
  const url = needUrl()
  const meta = await probe(url)
  const wanted = value('out')
  if (wanted && !/\.mp3$/i.test(wanted)) {
    finish({ ok: false, error: 'Súbor v --out musí končiť na .mp3.' }, 'Súbor v --out musí končiť na .mp3.')
    process.exit(1)
  }
  const out = wanted ? resolve(wanted) : join(DATA_DIR, 'media', 'audio', `${meta.key ?? 'audio'}.mp3`)
  step('video', 'downloading', 0, 'Sťahujem zvuk')
  const res = await downloadAudio(url, out, {
    info: meta,
    onProgress: (p) => (p.state === 'downloading' ? step('video', 'downloading', p.pct, 'Sťahujem zvuk') : p.state === 'converting' ? step('video', 'converting', null, 'Prevádzam na mp3') : null),
  })
  step('video', 'done', 100, 'Zvuk je stiahnutý')
  finish({ ok: true, file: res.file, bytes: res.bytes, title: meta.title, duration: meta.duration }, `${meta.title}\n${res.file} (${mb(res.bytes)})`)
}

async function video() {
  const url = needUrl()
  // With a running HUD the server does the work, so the theater opens and shows the progress.
  if (!flags.has('local') && (await hudAlive())) {
    const res = await fetch(`${HUD_URL}/api/video`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(120_000) })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.ok) {
      finish({ ok: false, error: body.error ?? `HTTP ${res.status}` }, body.error ?? 'HUD video neotvoril.')
      process.exit(1)
    }
    const v = body.video
    step('video', v.state === 'ready' ? 'done' : 'downloading', v.state === 'ready' ? 100 : null, v.state === 'ready' ? 'Video je otvorené v HUD' : 'Video sa otvára v HUD a sťahuje sa')
    return finish({ ok: true, hud: true, id: v.id, title: v.title, duration: v.duration, state: v.state }, `${v.title}\nOtvorené na ploche Jarvisa (${v.id}).`)
  }
  const off = onVideoEvent((ev) => {
    if (ev.type === 'progress') step(ev.step === 'transcript' ? 'transcript' : 'video', ev.state, ev.pct, ev.text)
  })
  const v = await openVideo(url, { wait: true })
  off()
  const done = (await transcriptText(v.id, { max: 500 }).catch(() => null)) ?? {}
  const ok = Boolean(v.id) && done.state !== undefined
  finish({ ok, hud: false, id: v.id, title: v.title, duration: v.duration, dir: join(DATA_DIR, 'video', v.id), transcript: done.state ?? 'none', lines: done.total ?? 0 }, `${v.title}\n${join(DATA_DIR, 'video', v.id)}\nPrepis: ${done.total ? `${done.total} riadkov` : 'žiadny'}`)
}

async function transcript() {
  const target = rest[1]
  if (!target) {
    console.error('Chýba odkaz na video alebo id analyzovaného videa.')
    process.exit(1)
  }
  if (!/^https?:\/\//i.test(target)) {
    // An id of a video the HUD has already analysed.
    const res = await transcriptText(target, { max: 30_000 })
    return finish({ ok: res.total > 0, ...res }, res.text || res.note)
  }
  const url = needUrl()
  step('transcript', 'checking', null, 'Hľadám titulky videa')
  const meta = await probe(url)
  const subs = await subtitles(url, langs(), { info: meta, onProgress: (p) => (p.state === 'downloading' ? step('transcript', 'downloading', null, 'Sťahujem titulky') : null) })
  if (!subs) {
    step('transcript', 'error', null, 'Video nemá titulky')
    return finish({ ok: false, title: meta.title, error: 'Video nemá titulky. V HUD ho s lokálnym prepisom reči viem prepísať sám.' }, 'Video nemá titulky. V HUD ho s lokálnym prepisom reči viem prepísať sám.')
  }
  step('transcript', 'done', 100, `Prepis má ${subs.segments.length} riadkov`)
  finish(
    { ok: true, title: meta.title, duration: meta.duration, lang: subs.lang, auto: subs.auto, lines: subs.segments.length, segments: subs.segments },
    subs.segments.map((s) => `[${stamp(s.start)}] ${s.text}`).join('\n'),
  )
}

// ── main ────────────────────────────────────────────────────────────────

const ACTIONS = { prepare, info, audio, video, transcript }
if (!ACTIONS[action]) {
  console.log('Použitie: node scripts/media.mjs prepare | info <url> | audio <url> [--out súbor.mp3] | video <url> [--local] | transcript <url|id>   (--json, --progress)')
  process.exit(action === 'help' ? 0 : 1)
}
try {
  await ACTIONS[action]()
  process.exit(0)
} catch (err) {
  const text = problem(err)
  step(action === 'transcript' ? 'transcript' : action === 'prepare' ? 'ytdlp' : 'video', 'error', null, text)
  finish({ ok: false, error: text, code: err?.code ?? null }, text)
  process.exit(action === 'prepare' ? 0 : 1)
}
