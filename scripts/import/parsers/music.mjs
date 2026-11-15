/**
 * Listening history: Spotify and Apple Music. No people here, the result is one overview note
 * in memory/hudba/ and compact monthly aggregates in archiv/<source>/aggregate.json.
 *
 * Spotify account data   StreamingHistory0.json, StreamingHistory_music_0.json
 *                        [{ endTime: "2026-01-31 18:20", artistName, trackName, msPlayed }]
 * Spotify extended       Streaming_History_Audio_2019-2020_0.json (older: endsong_0.json)
 *                        [{ ts, ms_played, master_metadata_track_name, master_metadata_album_artist_name }]
 * Apple Music            Apple Music Play Activity.csv, Apple Music - Play History Daily Tracks.csv
 *
 * Re-imports never count a play twice: aggregates are kept per month and the month with
 * more listening wins (the extended history contains everything the short one has).
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeGeneratedNote } from '../notes.mjs'
import { ARCHIVE_DIR, UserError, csvRows, fmtInt, readJson, scanJsonArray, writeJson } from '../util.mjs'

const SPOTIFY_SHORT = /(?:^|\/)StreamingHistory(?:_music)?_?\d+\.json$/i
const SPOTIFY_LONG = /(?:^|\/)(?:Streaming_History_Audio_[^/]*|endsong_\d+)\.json$/i
const APPLE_ACTIVITY = /(?:^|\/)Apple Music Play Activity\.csv$/i
const APPLE_DAILY = /(?:^|\/)Apple Music - Play History Daily Tracks\.csv$/i
const APPLE_NESTED = /(?:^|\/)Apple_Media_Services\.zip$/i
const MIN_PLAY_MS = 30_000
const SEP = '\t'

export async function sniffSpotify(src) {
  const short = src.filter(SPOTIFY_SHORT)
  const long = src.filter(SPOTIFY_LONG)
  if (!short.length && !long.length) return null
  return { source: 'spotify', confidence: 0.95, details: { format: long.length ? 'extended' : 'account', files: short.length + long.length, user: null } }
}

export async function sniffApple(src) {
  if (src.find(APPLE_ACTIVITY) || src.find(APPLE_DAILY)) return { source: 'applemusic', confidence: 0.95, details: { files: src.filter(APPLE_ACTIVITY).length + src.filter(APPLE_DAILY).length, user: null } }
  if (src.find(APPLE_NESTED)) return { source: 'applemusic', confidence: 0.8, details: { nested: true, user: null } }
  return null
}

// ── aggregation ────────────────────────────────────────────────────────

const emptyMonth = () => ({ ms: 0, plays: 0, a: {}, t: {}, h: new Array(24).fill(0) })

function add(months, atMs, played, artist, track) {
  if (!Number.isFinite(atMs) || !(played > 0)) return
  const date = new Date(atMs)
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  const m = (months[key] ??= emptyMonth())
  const play = played >= MIN_PLAY_MS ? 1 : 0
  m.ms += played
  m.plays += play
  m.h[date.getHours()] += played
  if (artist) {
    const a = (m.a[artist] ??= [0, 0])
    a[0] += played
    a[1] += play
  }
  if (track) {
    const t = (m.t[`${artist ?? ''}${SEP}${track}`] ??= [0, 0])
    t[0] += played
    t[1] += play
  }
}

const top = (obj, n) => Object.fromEntries(Object.entries(obj).sort((x, y) => y[1][0] - x[1][0]).slice(0, n))

/** Keeps the fuller version of each month and trims the long tail. */
function mergeMonths(...sets) {
  const out = {}
  for (const months of sets) {
    for (const [key, m] of Object.entries(months ?? {})) {
      if (!out[key] || m.ms > out[key].ms) out[key] = m
    }
  }
  for (const m of Object.values(out)) {
    m.a = top(m.a, 400)
    m.t = top(m.t, 600)
  }
  return out
}

const hours = (ms) => fmtInt(ms / 3_600_000)

function buildNote(label, months) {
  const keys = Object.keys(months).sort()
  const artists = {}
  const tracks = {}
  const byYear = {}
  const byHour = new Array(24).fill(0)
  let ms = 0
  let plays = 0
  for (const key of keys) {
    const m = months[key]
    ms += m.ms
    plays += m.plays
    m.h.forEach((v, i) => (byHour[i] += v))
    const year = (byYear[key.slice(0, 4)] ??= { ms: 0, a: {} })
    year.ms += m.ms
    for (const [name, [aMs, aPlays]] of Object.entries(m.a)) {
      const a = (artists[name] ??= [0, 0])
      a[0] += aMs
      a[1] += aPlays
      year.a[name] = (year.a[name] ?? 0) + aMs
    }
    for (const [name, [tMs, tPlays]] of Object.entries(m.t)) {
      const t = (tracks[name] ??= [0, 0])
      t[0] += tMs
      t[1] += tPlays
    }
  }
  // the busiest three-hour window and the share of each part of the day
  let best = 0
  for (let h = 1; h < 24; h++) {
    const sum = (x) => byHour[x] + byHour[(x + 1) % 24] + byHour[(x + 2) % 24]
    if (sum(h) > sum(best)) best = h
  }
  const share = (from, to) => Math.round((100 * byHour.slice(from, to).reduce((s, v) => s + v, 0)) / (ms || 1))
  const window = Math.round((100 * (byHour[best] + byHour[(best + 1) % 24] + byHour[(best + 2) % 24])) / (ms || 1))
  const hh = (h) => `${String(h % 24).padStart(2, '0')}:00`
  const lines = [
    `# ${label}`,
    '',
    `Prehľad počúvania hudby v službe ${label}. Vznikol z exportu údajov, pri ďalšom importe sa prepíše.`,
    '',
    `- Spolu: ${hours(ms)} hodín hudby, ${fmtInt(plays)} prehratí`,
    `- Obdobie: ${keys[0]} až ${keys[keys.length - 1]}`,
    `- Rôznych interpretov: ${fmtInt(Object.keys(artists).length)}`,
    `- Najviac počúva medzi ${hh(best)} a ${hh(best + 3)} (${window} % času). Ráno ${share(6, 12)} %, popoludní ${share(12, 18)} %, večer ${share(18, 24)} %, v noci ${share(0, 6)} %.`,
  ]
  const topArtists = Object.entries(artists).sort((x, y) => y[1][0] - x[1][0]).slice(0, 40)
  if (topArtists.length) {
    lines.push('', '## Najpočúvanejší interpreti', '')
    topArtists.forEach(([name, [aMs, aPlays]], i) => lines.push(`${i + 1}. ${name} · ${hours(aMs)} h · ${fmtInt(aPlays)} prehratí`))
  }
  const topTracks = Object.entries(tracks).sort((x, y) => y[1][1] - x[1][1] || y[1][0] - x[1][0]).slice(0, 40)
  if (topTracks.length) {
    lines.push('', '## Najpočúvanejšie skladby', '')
    topTracks.forEach(([key, [, tPlays]], i) => {
      const [artist, track] = key.split(SEP)
      lines.push(`${i + 1}. ${artist ? `${artist} · ` : ''}${track} · ${fmtInt(tPlays)} prehratí`)
    })
  }
  const years = Object.keys(byYear).sort().reverse()
  if (years.length && topArtists.length) {
    lines.push('', '## Po rokoch')
    for (const y of years) {
      lines.push('', `### ${y} (${hours(byYear[y].ms)} h)`, '')
      Object.entries(byYear[y].a).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([name, aMs], i) => lines.push(`${i + 1}. ${name} · ${hours(aMs)} h`))
    }
  }
  return { text: lines.join('\n'), ms, plays, from: keys[0], to: keys[keys.length - 1], artists: Object.keys(artists).length, top: topArtists.slice(0, 3).map(([n]) => n) }
}

async function finish(ctx, source, label, fresh) {
  if (!Object.keys(fresh).length) throw new UserError(`V exporte zo služby ${label} som nenašiel žiadnu históriu počúvania.`)
  const dir = join(ARCHIVE_DIR, source)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'aggregate.json')
  const old = await readJson(file, null)
  const months = mergeMonths(old?.months, fresh)
  await writeJson(file, { source, updated: new Date().toISOString(), months })
  const note = buildNote(label, months)
  ctx.note(await writeGeneratedNote(`hudba/${label}.md`, { zdroj: source }, note.text))
  return {
    me: null,
    summary: `${label}: ${hours(note.ms)} hodín hudby, ${fmtInt(note.plays)} prehratí od ${note.from} do ${note.to}.${note.top.length ? ` Najviac ${note.top.join(', ')}.` : ''}`,
    stats: { threads: 0, messages: note.plays, from: `${note.from}-01T00:00:00.000Z`, to: `${note.to}-28T00:00:00.000Z` },
  }
}

// ── Spotify ────────────────────────────────────────────────────────────

export async function runSpotify(ctx) {
  const { src } = ctx
  const short = src.filter(SPOTIFY_SHORT)
  const long = src.filter(SPOTIFY_LONG)
  const files = [...long, ...short]
  const a = {}
  const b = {}
  let done = 0
  let podcasts = 0
  for (const f of files) {
    done++
    ctx.progress(0.05 + 0.85 * ((done - 1) / files.length), `Čítam históriu počúvania (${done} z ${files.length})`)
    const isLong = SPOTIFY_LONG.test(f.name)
    try {
      await scanJsonArray(src.stream(f.name), (r) => {
        if (!r || typeof r !== 'object') return
        if (isLong) {
          if (!r.master_metadata_track_name) {
            if (r.episode_name) podcasts++
            return
          }
          add(a, Date.parse(r.ts), Number(r.ms_played), r.master_metadata_album_artist_name ?? '', r.master_metadata_track_name)
        } else {
          add(b, Date.parse(`${String(r.endTime ?? '').replace(' ', 'T')}:00Z`), Number(r.msPlayed), r.artistName ?? '', r.trackName ?? '')
        }
      })
    } catch {
      ctx.warn(`Súbor ${f.name} sa nedal prečítať, preskočil som ho.`)
    }
  }
  if (podcasts) ctx.warn(`Podcasty a audioknihy (${fmtInt(podcasts)} záznamov) do prehľadu hudby nepočítam.`)
  if (!long.length) ctx.warn('Toto je krátky export zo Spotify, ktorý obsahuje len posledný rok. Celú históriu dostaneš, keď na stránke súkromia Spotify požiadaš o „Rozšírenú históriu streamovania".')
  return finish(ctx, 'spotify', 'Spotify', mergeMonths(a, b))
}

// ── Apple Music ────────────────────────────────────────────────────────

export async function runApple(ctx) {
  const { src } = ctx
  if (!src.find(APPLE_ACTIVITY) && !src.find(APPLE_DAILY)) {
    const nested = src.find(APPLE_NESTED)
    if (nested) {
      ctx.progress(0.05, 'Rozbaľujem Apple Media Services')
      await src.addNested(nested.name, 'Apple_Media_Services/')
    }
  }
  const activity = src.find(APPLE_ACTIVITY)
  const daily = src.find(APPLE_DAILY)
  if (!activity && !daily) throw new UserError('V exporte od Apple som nenašiel históriu Apple Music (súbor Apple Music Play Activity.csv). Pri žiadosti na privacy.apple.com treba zaškrtnúť „Apple Media Services".')
  const months = {}
  const file = activity ?? daily
  const size = file.size || 1
  let header = null
  let col = {}
  let rows = 0
  ctx.progress(0.1, 'Čítam históriu Apple Music')
  for await (const row of csvRows(src.stream(file.name))) {
    if (!header) {
      header = row.map((h) => h.trim().toLowerCase())
      const find = (...names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1
      col = {
        song: find('song name', 'content name', 'track description'),
        artist: find('artist name', 'album artist name'),
        ms: find('play duration milliseconds'),
        at: find('event end timestamp', 'event start timestamp', 'event timestamp', 'event received timestamp'),
        type: find('event type'),
        date: find('date played'),
        hours: find('hours'),
      }
      continue
    }
    rows++
    if (rows % 5000 === 0) ctx.progress(Math.min(0.9, 0.1 + 0.8 * ((rows * 300) / size)), `Čítam históriu Apple Music (${fmtInt(rows)} záznamov)`)
    const played = Number(row[col.ms])
    if (!(played > 0)) continue
    if (activity) {
      if (col.type >= 0 && row[col.type] && row[col.type] !== 'PLAY_END') continue
      add(months, Date.parse(row[col.at]), played, col.artist >= 0 ? row[col.artist] : '', row[col.song] ?? '')
    } else {
      const d = /^(\d{4})(\d{2})(\d{2})$/.exec(String(row[col.date] ?? '').trim())
      if (!d) continue
      const hour = Number(String(row[col.hours] ?? '').split(',')[0]) || 12
      const desc = String(row[col.song] ?? '')
      const cut = desc.indexOf(' - ')
      add(months, new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), hour).getTime(), played, cut > 0 ? desc.slice(0, cut) : '', cut > 0 ? desc.slice(cut + 3) : desc)
    }
  }
  return finish(ctx, 'applemusic', 'Apple Music', months)
}
