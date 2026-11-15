/**
 * Phone calls: when something cannot wait, Jarvis rings the user's mobile and says it.
 *
 * A real outgoing call through the user's own Twilio account. The spoken text travels inside the
 * request (inline TwiML), so nothing on this computer has to be reachable from the internet.
 * After the message the user can answer by voice: Twilio records only the user's side of the
 * call, Jarvis downloads the recording when the call ends and acts on what was said.
 *
 * Settings in .env (see docs/HOVORY.md):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN   the account
 *   TWILIO_FROM                             the Twilio number that calls
 *   JARVIS_CALL_TO                          the user's mobile, +421…
 *   JARVIS_CALL_VOICE                       optional, default Google.sk-SK-Wavenet-B (cs: Google.cs-CZ-Wavenet-B)
 *   JARVIS_CALL_REPLY=0                     do not wait for a spoken answer
 *   JARVIS_CALL_MAX_PER_DAY                 stops a runaway loop from burning credit, default 12
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfig } from './config.mjs'
import { DATA_DIR, isoDay, sleep } from './util.mjs'

const API = 'https://api.twilio.com/2010-04-01'
export const CALL_DIR = join(DATA_DIR, 'calls')
const LOG_FILE = join(CALL_DIR, 'log.jsonl')
const E164 = /^\+[1-9]\d{6,14}$/
const DONE = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled'])

export function callConfig() {
  const env = process.env
  const lang = (env.JARVIS_LANG || 'sk').toLowerCase().startsWith('cs') ? 'cs-CZ' : 'sk-SK'
  return {
    sid: (env.TWILIO_ACCOUNT_SID ?? '').trim(),
    token: (env.TWILIO_AUTH_TOKEN ?? '').trim(),
    from: (env.TWILIO_FROM ?? '').replace(/[\s()-]/g, ''),
    to: (env.JARVIS_CALL_TO ?? '').replace(/[\s()-]/g, ''),
    lang,
    voice: (env.JARVIS_CALL_VOICE ?? '').trim() || `Google.${lang}-Wavenet-B`,
    reply: env.JARVIS_CALL_REPLY !== '0',
    maxPerDay: Math.max(1, Number(env.JARVIS_CALL_MAX_PER_DAY) || 12),
  }
}

/** What is missing before Jarvis can call, as Slovak sentences. An empty list means ready. */
export function callProblems(c = callConfig()) {
  const out = []
  if (!/^AC[0-9a-f]{32}$/i.test(c.sid)) out.push('Chýba TWILIO_ACCOUNT_SID (začína na AC).')
  if (c.token.length < 16) out.push('Chýba TWILIO_AUTH_TOKEN.')
  if (!E164.test(c.from)) out.push('Chýba TWILIO_FROM: tvoje číslo v Twiliu v tvare +1… alebo +421…')
  if (!E164.test(c.to)) out.push('Chýba JARVIS_CALL_TO: tvoj mobil v tvare +421…')
  return out
}
export const callReady = () => callProblems().length === 0

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const mask = (n) => n.replace(/\d(?=\d{3})/g, '•')

/** The whole call as TwiML: a short pause, the message, and (optionally) room for a spoken answer. */
export function twiml(text, { reply = true, formal = true, c = callConfig() } = {}) {
  const say = (t) => `<Say language="${c.lang}" voice="${xml(c.voice)}">${xml(t)}</Say>`
  const message = String(text).replace(/\s+/g, ' ').trim().slice(0, 2400)
  const czech = c.lang === 'cs-CZ'
  const ask = czech
    ? formal ? 'Pokud chcete odpovědět, mluvte teď a pak zavěste.' : 'Jestli chceš odpovědět, mluv teď a pak zavěs.'
    : formal ? 'Ak chcete odpovedať, hovorte teraz a potom zložte.' : 'Ak chceš odpovedať, hovor teraz a potom zlož.'
  const bye = czech ? 'Na shledanou.' : 'Dovidenia.'
  return `<Response><Pause length="1"/>${say(message)}${reply ? `<Pause length="1"/>${say(ask)}<Pause length="25"/>` : ''}${say(bye)}</Response>`
}

async function api(c, path, { method = 'GET', form = null, raw = false } = {}) {
  const res = await fetch(`${API}/Accounts/${c.sid}${path}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`${c.sid}:${c.token}`).toString('base64')}`, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  if (raw) return res
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(twilioError(res.status, body)), { status: res.status, code: body.code })
  return body
}

/** The Twilio errors people actually hit, in plain Slovak. */
function twilioError(status, body) {
  const code = Number(body.code)
  if (status === 401 && /trial account has expired/i.test(body.message ?? '')) return 'Skúšobný účet Twilio vypršal. V Twiliu ho treba povýšiť a dobiť kredit (Upgrade), potom hovory pôjdu.'
  if (status === 401) return 'Twilio odmietol prihlásenie: skontroluj TWILIO_ACCOUNT_SID a TWILIO_AUTH_TOKEN.'
  if (code === 21219 || code === 21608) return 'Skúšobný účet Twilio smie volať len na overené čísla. Over svoj mobil v Twiliu (Verified Caller IDs).'
  if (code === 21215 || code === 13227) return 'Twilio má vypnuté volania do tejto krajiny. Zapni ju v Twiliu: Voice → Settings → Geo permissions.'
  if (code === 21210 || code === 21212) return 'Číslo TWILIO_FROM nepatrí k tomuto účtu Twilio alebo nevie volať.'
  if (code === 21211 || code === 21214) return 'Číslo JARVIS_CALL_TO nie je platné. Má byť v tvare +421…'
  return `Twilio vrátil chybu ${status}${code ? ` (${code})` : ''}: ${String(body.message ?? '').slice(0, 200)}`
}

async function log(entry) {
  await mkdir(CALL_DIR, { recursive: true })
  await appendFile(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
}

/** Calls made today (local date), to keep a loop from ringing all day. */
export async function callsToday() {
  try {
    const today = isoDay()
    return (await readFile(LOG_FILE, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'placed' && isoDay(new Date(e.at)) === today).length
  } catch {
    return 0
  }
}

/** Starts the call. Returns { sid, to } or throws an Error with a Slovak message. */
export async function placeCall({ text, reply = null, source = 'ručne' }) {
  const c = callConfig()
  const problems = callProblems(c)
  if (problems.length) throw new Error(problems.join(' '))
  if (!String(text ?? '').trim()) throw new Error('Chýba text, ktorý má Jarvis povedať.')
  if ((await callsToday()) >= c.maxPerDay) throw new Error(`Dnes som už volal ${c.maxPerDay}-krát. Viac hovorov povolíš cez JARVIS_CALL_MAX_PER_DAY v .env.`)
  const wantReply = reply ?? c.reply
  const call = await api(c, '/Calls.json', {
    method: 'POST',
    form: {
      To: c.to,
      From: c.from,
      Twiml: twiml(text, { reply: wantReply, formal: getConfig().formal !== false, c }),
      Timeout: '35',
      // Only the user's side is recorded: that is the answer Jarvis needs to hear.
      ...(wantReply ? { Record: 'true', RecordingTrack: 'inbound', RecordingChannels: 'mono', Trim: 'trim-silence' } : {}),
    },
  })
  await log({ event: 'placed', sid: call.sid, source, text: String(text).slice(0, 300), reply: wantReply })
  return { sid: call.sid, to: mask(c.to), reply: wantReply }
}

/** Waits until the call is over. Returns { status, seconds, answered }. */
export async function waitCall(sid, { timeoutMs = 180_000 } = {}) {
  const c = callConfig()
  const t0 = Date.now()
  let call = null
  while (Date.now() - t0 < timeoutMs) {
    call = await api(c, `/Calls/${sid}.json`)
    if (DONE.has(call.status)) break
    await sleep(2500)
  }
  const out = { status: call?.status ?? 'unknown', seconds: Number(call?.duration) || 0, answered: call?.status === 'completed' && Number(call?.duration) > 0 }
  await log({ event: 'ended', sid, ...out })
  return out
}

/**
 * The user's spoken answer: downloads the recording of the call, deletes it at Twilio and returns
 * the local file (or null when nothing was recorded). The audio never stays on Twilio's side.
 */
export async function fetchReply(sid) {
  const c = callConfig()
  let rec = null
  // The recording shows up a moment after the call ends.
  for (let i = 0; i < 8 && !rec; i++) {
    const list = await api(c, `/Calls/${sid}/Recordings.json`)
    rec = (list.recordings ?? []).find((r) => r.status === 'completed') ?? null
    if (!rec) await sleep(2000)
  }
  if (!rec) return null
  const res = await api(c, `/Recordings/${rec.sid}.mp3`, { raw: true })
  if (!res.ok) return null
  const file = join(CALL_DIR, `${sid}.mp3`)
  await mkdir(CALL_DIR, { recursive: true })
  await writeFile(file, Buffer.from(await res.arrayBuffer()), { mode: 0o600 })
  await api(c, `/Recordings/${rec.sid}.json`, { method: 'DELETE', raw: true }).catch(() => {})
  return { file, seconds: Number(rec.duration) || 0 }
}

/** Status for the setup and the doctor: no secrets, the number masked. */
export async function callStatus() {
  const c = callConfig()
  const problems = callProblems(c)
  return { ready: problems.length === 0, problems, to: c.to ? mask(c.to) : null, from: c.from || null, voice: c.voice, reply: c.reply, today: await callsToday(), maxPerDay: c.maxPerDay }
}
