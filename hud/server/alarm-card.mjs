/**
 * The alarm card: in the conversation the user sets when Jarvis wakes him and clicks the song he
 * wants to wake up to. The brain asks for it with the voice tool `ask_alarm` (the setup step
 * `budik` does, and "zmeň mi skladbu na budík" any time later); the page posts the choice to
 * POST /api/alarm/card/step.
 *
 * Card shape (in the chat, kept in the history):
 *   { id, kind: 'alarm', title, icon, node, time: 'HH:MM', days, daysText,
 *     songs: [{ id, title, artist, ready }], song: id | null, own: title | null, ask, note,
 *     state: 'form' | 'done' | 'closed', message, accent }
 *
 * `own` is the user's own sound when that is what rings now: the card says so and leaves it alone
 * unless he clicks one of the offered songs.
 *
 * The songs themselves are never shipped: each is downloaded once on this computer
 * (alarm-sound.mjs, SONGS). A song that is not on the disk yet is downloaded when it is chosen.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { daysLabel, weekdaysOf } from './alarm.mjs'
import { SONGS, resolveSound, setSound, songList, songPreview } from './alarm-sound.mjs'
import { findCard, pushCard, sendChat, updateCard } from './chat.mjs'
import { getConfig } from './config.mjs'
import { playSound } from './speak.mjs'
import { REPO, clean, errMsg, log } from './util.mjs'

const newId = () => `alarm-${randomBytes(6).toString('hex')}`
const TIME_RE = /^(\d{1,2})[:.](\d{2})$/

/** "6:30", "06.30" → "06:30", or null when it is not a time of day. */
export function readTime(value) {
  const m = TIME_RE.exec(String(value ?? '').trim())
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null
  return `${m[1].padStart(2, '0')}:${m[2]}`
}

const validDays = (days) => typeof days === 'string' && days.trim() && (Boolean(weekdaysOf(days)) || /^(daily|denne)$/i.test(days.trim())) ? days.trim().toLowerCase() : null

/** The card as it is shown: the alarm as it is now, with whatever the brain already knows filled in. */
export function alarmCard({ time = null, days = null } = {}, id = newId()) {
  const alarm = getConfig().alarm
  const sound = resolveSound()
  const rule = validDays(days) ?? alarm?.days ?? 'daily'
  const formal = getConfig().formal !== false
  return {
    id,
    kind: 'alarm',
    title: 'Budík',
    icon: 'alarm',
    node: 'rutiny',
    time: readTime(time) ?? alarm?.time ?? '07:00',
    days: rule,
    daysText: daysLabel(rule),
    songs: songList().map(({ id: song, title, artist, ready }) => ({ id: song, title, artist, ready })),
    // Nothing chosen yet (a first run, or the chime) preselects the first song: one click on the button is enough.
    song: sound.kind === 'custom' ? null : sound.song ?? SONGS[0].id,
    own: sound.kind === 'custom' ? sound.title : null,
    ask: formal ? 'Ktorou skladbou vás mám zobudiť?' : 'Ktorou skladbou ťa mám zobudiť?',
    note: sound.kind === 'custom' ? `Teraz zvoní ${formal ? 'váš' : 'tvoj'} zvuk ${sound.title}. Ostane, kým ${formal ? 'nevyberiete' : 'nevyberieš'} jednu z týchto.` : 'Vlastnú skladbu mi stačí pretiahnuť do okna.',
    state: 'form',
    message: null,
    accent: 'ice',
  }
}

/** The brain's tool `ask_alarm` (through /api/brain/hud) and POST /api/alarm/card: puts the card into the conversation. */
export function brainAlarmCard(body = {}) {
  const card = alarmCard({ time: body.time, days: body.days })
  pushCard(card)
  log('alarm', 'karta budíka')
  return {
    ok: true,
    card: card.id,
    text: 'Karta budíka je na obrazovke. Povedz mu jednou vetou, nech si v nej klikom vyberie skladbu, skontroluje čas a potvrdí. Výsledok ti príde sám ako správa [systém: …], nečakaj naň a teraz už žiadny nástroj nevolaj.',
  }
}

/** Sets the time through the alarm script, which also registers it in the system scheduler. Replaced in tests. */
let runAlarm = (args) =>
  new Promise((resolve) => {
    execFile(process.execPath, [join(REPO, 'scripts', 'alarm.mjs'), ...args, '--json'], { cwd: REPO, timeout: 150_000, windowsHide: true, maxBuffer: 1_000_000 }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1)))
      } catch {
        resolve({ ok: false, summary: `Budík sa nepodarilo nastaviť: ${clean(String(err?.message ?? stdout), 200)}` })
      }
    })
  })
let chooseSound = (id) => setSound(id)

/** The brain hears what the user chose as a hidden turn, so it can confirm it in its own words and carry on. */
function tellBrain(text) {
  try {
    sendChat({ text: `[systém: karta budíka na obrazovke. ${text}]`, via: 'text', hidden: true })
  } catch (err) {
    log('alarm', `mozog sa o budíku nedozvedel: ${errMsg(err)}`)
  }
}

// ── a short listen ──────────────────────────────────────────────────────

const PREVIEW_SECONDS = 15
let preview = null

/** Stops the song that is playing as a preview, if any. */
export function stopPreview() {
  preview?.stop.abort()
  preview = null
}

/** Plays the start of one offered song through the speakers (the same way the alarm will). The same song again stops it. */
function previewSong(id) {
  const same = preview?.song === id
  stopPreview()
  if (same || !id) return { playing: null }
  const sound = songPreview(id)
  if (!sound) return { playing: null, error: 'Túto skladbu ešte nemám stiahnutú. Stiahnem ju, keď si ju vyberiete.' }
  const mine = { song: id, stop: new AbortController() }
  preview = mine
  if (process.env.JARVIS_AUDIO !== 'off') {
    playSound({ ...sound, seconds: PREVIEW_SECONDS }, { stop: mine.stop.signal })
      .catch(() => false)
      .finally(() => {
        if (preview === mine) preview = null
      })
  }
  return { playing: id, seconds: PREVIEW_SECONDS }
}

// ── the steps of the card ───────────────────────────────────────────────

const busy = new Set()

/** One step of the card from the page. Returns { status, body, changed } for the response. */
export async function alarmCardStep(body = {}) {
  const id = String(body.card ?? '')
  const found = findCard(id)
  if (!found || found.card.kind !== 'alarm') return { status: 404, body: { ok: false, error: 'Karta budíka sa nenašla.' } }
  const card = found.card
  if (card.state === 'done' || card.state === 'closed') return { status: 410, body: { ok: false, error: 'Táto karta je už uzavretá.', card } }
  const step = String(body.step ?? '')

  if (step === 'preview') {
    const r = previewSong(typeof body.song === 'string' && SONGS.some((s) => s.id === body.song) ? body.song : null)
    return { status: 200, body: { ok: true, ...r, card } }
  }
  if (step === 'cancel') {
    stopPreview()
    return { status: 200, body: { ok: true, card: updateCard(id, { state: 'closed', message: 'Budík ostáva, ako bol.' }) } }
  }
  if (step !== 'set') return { status: 400, body: { ok: false, error: 'neznámy krok' } }
  if (busy.has(id)) return { status: 409, body: { ok: false, error: 'Ešte nastavujem.' } }

  const time = readTime(body.time)
  if (!time) return { status: 200, body: { ok: true, card: updateCard(id, { message: 'Čas napíšte ako 06:30.', accent: 'amber' }) } }
  const song = body.song === null || body.song === undefined || body.song === '' ? null : SONGS.find((s) => s.id === body.song)
  if (song === undefined || (!song && !card.own)) return { status: 200, body: { ok: true, card: updateCard(id, { message: 'Vyberte skladbu, ktorou vás mám zobudiť.', accent: 'amber' }) } }

  busy.add(id)
  stopPreview()
  try {
    const formal = getConfig().formal !== false
    // The song first: a song that cannot be downloaded right now must not cost him the alarm itself.
    let sound = null
    let soundProblem = null
    if (song) {
      try {
        sound = await chooseSound(song.id)
      } catch (err) {
        soundProblem = clean(errMsg(err), 200)
        log('alarm', `skladba ${song.id} sa nepodarila: ${soundProblem}`)
      }
    }
    const res = await runAlarm(['set', time, '--days', card.days ?? 'daily'])
    if (res.ok === false && !res.alarm) {
      return { status: 200, body: { ok: true, card: updateCard(id, { time, song: song?.id ?? null, message: clean(res.summary ?? res.problem ?? 'Budík sa nepodarilo nastaviť.', 200), accent: 'amber' }) } }
    }
    const title = song && !soundProblem ? song.title : card.own
    const rings = soundProblem ? `Skladbu ${song.title} sa nepodarilo stiahnuť, zatiaľ zvoní ${resolveSound().title}.` : title ? `Zobudí ${formal ? 'vás' : 'ťa'} ${title}.` : ''
    const notInSystem = res.registered === false || res.ok === false
    const message = `Budík je nastavený na ${time}, ${daysLabel(card.days)}. ${rings}${notInSystem ? ' Do systému sa ho zatiaľ nepodarilo zapísať.' : ''}`.trim()
    const next = updateCard(id, { state: 'done', time, song: song?.id ?? null, message, accent: soundProblem || notInSystem ? 'amber' : 'ice' })
    log('alarm', `karta: ${time} ${card.days}, zvuk ${sound?.kind ?? 'bez zmeny'}`)
    tellBrain(
      `Používateľ si na karte nastavil budík na ${time} (${daysLabel(card.days)})${title ? ` a vybral skladbu ${title}` : ''}. ${soundProblem ? `Skladbu sa nepodarilo stiahnuť (${soundProblem}), povedz mu to jednou vetou. ` : ''}${notInSystem ? `Do systému sa budík nepodarilo zapísať${res.problem ? ` (${clean(res.problem, 160)})` : ''}, vyrieš to cez agent_task. ` : ''}Potvrď to jednou krátkou vetou a dodaj, že keď budík zazvoní, na obrazovke bude tlačidlo, ktorým zvonenie zastaví a hneď si vypočuje ranný prehľad, a že počítač má ostať zapnutý. Ak beží úvodné nastavenie, zapíš krok budik cez setup_note a pokračuj ďalším krokom.`,
    )
    return { status: 200, changed: true, body: { ok: true, card: next } }
  } finally {
    busy.delete(id)
  }
}

/** Tests: replace the alarm script and the download of a song (no scheduler, no network). */
export function setAlarmCardRunners({ alarm = null, sound = null } = {}) {
  const prev = { alarm: runAlarm, sound: chooseSound }
  if (alarm) runAlarm = alarm
  if (sound) chooseSound = sound
  return () => {
    runAlarm = prev.alarm
    chooseSound = prev.sound
  }
}
