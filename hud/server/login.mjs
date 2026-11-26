/**
 * The login card: a service that needs the user's own credentials (Garmin first) gets a small form
 * in the conversation instead of a terminal. The brain asks for it with the voice tool `ask_login`,
 * the page posts the values to POST /api/login, and the service's own client logs in.
 *
 * Where the values go, and where they never go:
 *   page → POST /api/login (only from this computer: loopback, a localhost Host, the page's own
 *   origin) → the service's session (Garmin: the worker's stdin) → the service. They are never
 *   put into the card, the chat history, the brain's context, an SSE event, a log line, the
 *   telemetry or a file. The service's client keeps only what it keeps anyway (Garmin: session
 *   tokens in data/garmin/). The brain hears only the outcome: connected, needs a code, wrong
 *   password, failed, each with a human sentence.
 *
 * Why not from the phone: the phone reaches this computer through a tunnel, so a password typed
 * there would pass through the tunnel's servers, and a stolen phone session could change what the
 * computer is logged into. The card on the phone says the login is finished at the computer.
 *
 * Card shape (in the chat, kept in the history, never with a secret):
 *   { id, kind: 'login', service, title, icon, node, text, fields: [{ name, label, type, autocomplete }],
 *     code: { label, hint }, submit, state: 'form' | 'code' | 'done' | 'closed', message, accent }
 */
import { randomBytes } from 'node:crypto'
import { currentTurnId, findCard, pushCard, sendChat, updateCard } from './chat.mjs'
import { loginSession } from './garmin/index.mjs'
import { clean, errMsg, log } from './util.mjs'

/** Services with a login card. `start()` returns a session with submit(values), code(value), close(). */
export const SERVICES = {
  garmin: {
    title: 'Prihlásenie do Garminu',
    icon: 'heart',
    node: 'spanok',
    text: 'Heslo ide rovno do Garminu, ja ho nevidím ani neukladám.',
    fields: [
      { name: 'email', label: 'E-mail', type: 'email', autocomplete: 'username' },
      { name: 'password', label: 'Heslo', type: 'password', autocomplete: 'current-password' },
    ],
    code: { label: 'Overovací kód', hint: 'Garmin vám práve poslal kód e-mailom alebo SMS.' },
    submit: 'Prihlásiť',
    done: (name) => `Garmin je pripojený${name ? ` (${name})` : ''}.`,
    start: () => loginSession(),
    /** What the brain hears after a successful login. */
    after: (name) => `Garmin je pripojený${name ? `, účet ${name}` : ''}. Hneď stiahni posledných 14 dní nástrojom garmin_sync (days 14) a povedz mu dvoma krátkymi vetami, čo z hodiniek vidíš, napríklad ako spal poslednú noc.`,
  },
}

/** Wrong passwords in a row make a service lock the account for a while: after this many in 15 minutes, the card waits. */
const MAX_WRONG = 3
const WRONG_WINDOW_MS = 15 * 60_000

const sessions = new Map()
const wrong = new Map()

const newId = () => `login-${randomBytes(6).toString('hex')}`

/** The card as it is shown, for one service. */
export function loginCard(service, id = newId()) {
  const s = SERVICES[service]
  if (!s) return null
  return {
    id,
    kind: 'login',
    service,
    title: s.title,
    icon: s.icon,
    node: s.node,
    text: s.text,
    fields: s.fields.map((f) => ({ ...f })),
    code: { ...s.code },
    submit: s.submit,
    state: 'form',
    message: null,
    accent: 'ice',
  }
}

/** The brain's tool `ask_login` (through /api/brain/hud): puts the card into the conversation. */
export function brainLogin(body = {}) {
  const service = String(body.service ?? '').toLowerCase()
  if (!SERVICES[service]) return { ok: false, error: `neznáma služba ${JSON.stringify(body.service)}, karta na prihlásenie je pre: ${Object.keys(SERVICES).join(', ')}` }
  const card = loginCard(service)
  // A login the service cancelled (the background sync found out): the card says why it is back.
  if (body.reason === 'expired') Object.assign(card, { message: 'Prihlásenie vypršalo, služba chce heslo znova.', accent: 'amber' })
  pushCard(card)
  log('login', `karta na prihlásenie: ${service}`)
  return {
    ok: true,
    card: card.id,
    text: 'Karta na prihlásenie je na obrazovke. Povedz mu jednou vetou, nech tam zadá e-mail a heslo a klikne Prihlásiť, a že heslo nevidíš. Výsledok ti príde sám ako správa [systém: …], nečakaj naň a teraz už žiadny nástroj nevolaj.',
  }
}

/** The brain hears the outcome as a hidden turn, so it can carry on by itself (Garmin: sync and say what it sees). */
function tellBrain(text, { important = false } = {}) {
  // An intermediate step (a code, a wrong password) must not cut off what Jarvis is saying right now.
  if (!important && currentTurnId()) return
  try {
    sendChat({ text: `[systém: prihlásenie cez kartu na obrazovke. ${text} Heslo ani kód nikdy nepýtaj do rozhovoru.]`, via: 'text', hidden: true })
  } catch (err) {
    log('login', `mozog sa o výsledku nedozvedel: ${errMsg(err)}`)
  }
}

const recentWrong = (service, now = Date.now()) => (wrong.get(service) ?? []).filter((t) => now - t < WRONG_WINDOW_MS)

function closeSession(id) {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  try {
    s.session?.close()
  } catch {
    // already closed
  }
}

/** Checks the values of the form. Returns { email, password } or a message for the card. */
export function readValues(values) {
  if (!values || typeof values !== 'object') return { error: 'Vyplňte e-mail aj heslo.' }
  const email = typeof values.email === 'string' ? values.email.trim() : ''
  const password = typeof values.password === 'string' ? values.password : ''
  if (!email || !password) return { error: 'Vyplňte e-mail aj heslo.' }
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) return { error: 'Toto nevyzerá ako e-mail.' }
  if (password.length > 1024) return { error: 'Heslo je pridlhé.' }
  return { email, password }
}

/** One step of the card from the page. Returns { status, body } for the response; never echoes a value. */
export async function loginStep(body = {}) {
  const id = String(body.card ?? '')
  const found = findCard(id)
  if (!found || found.card.kind !== 'login') return { status: 404, body: { ok: false, error: 'Karta na prihlásenie sa nenašla.' } }
  const card = found.card
  const service = SERVICES[card.service]
  if (!service) return { status: 400, body: { ok: false, error: 'Neznáma služba.' } }
  if (card.state === 'done' || card.state === 'closed') return { status: 410, body: { ok: false, error: 'Táto karta je už uzavretá.', card } }
  const live = sessions.get(id)
  if (live?.busy) return { status: 409, body: { ok: false, error: 'Ešte čakám na odpoveď.' } }
  const step = String(body.step ?? '')

  if (step === 'cancel') {
    closeSession(id)
    return { status: 200, body: { ok: true, card: updateCard(id, { state: 'closed', message: 'Prihlásenie zrušené.' }) } }
  }

  let result
  if (step === 'credentials') {
    const v = readValues(body.values)
    body.values = null
    if (v.error) return { status: 200, body: { ok: true, card: updateCard(id, { message: v.error, accent: 'amber' }) } }
    if (recentWrong(card.service).length >= MAX_WRONG) {
      return { status: 200, body: { ok: true, card: updateCard(id, { state: 'form', message: 'Heslo nesedelo už trikrát. Počkajte štvrť hodinu, inak Garmin prihlásenia na chvíľu zablokuje.', accent: 'amber' }) } }
    }
    closeSession(id)
    const entry = { session: service.start(), busy: true }
    sessions.set(id, entry)
    try {
      result = await entry.session.submit({ email: v.email, password: v.password })
    } catch (err) {
      result = { state: 'error', error: 'failed', message: `Prihlásenie zlyhalo: ${clean(errMsg(err), 120)}` }
    }
    entry.busy = false
  } else if (step === 'code') {
    const code = typeof body.code === 'string' ? body.code.replace(/\s+/g, '').slice(0, 12) : ''
    body.code = null
    if (!live?.session?.open || card.state !== 'code') {
      closeSession(id)
      return { status: 200, body: { ok: true, card: updateCard(id, { state: 'form', message: 'Na kód už nečakám. Prihláste sa znova, príde nový.', accent: 'amber' }) } }
    }
    if (!code) return { status: 200, body: { ok: true, card: updateCard(id, { message: 'Opíšte kód, ktorý vám prišiel.', accent: 'amber' }) } }
    live.busy = true
    try {
      result = await live.session.code(code)
    } catch (err) {
      result = { state: 'error', error: 'failed', message: `Prihlásenie zlyhalo: ${clean(errMsg(err), 120)}` }
    }
    live.busy = false
  } else return { status: 400, body: { ok: false, error: 'neznámy krok' } }

  return { status: 200, body: { ok: true, card: applyResult(id, card, service, result) } }
}

/** Moves the card on according to what the service said, and tells the brain. */
function applyResult(id, card, service, result) {
  if (result.state === 'connected') {
    closeSession(id)
    wrong.delete(card.service)
    const next = updateCard(id, { state: 'done', message: service.done(result.name), accent: 'ice' })
    tellBrain(service.after(result.name), { important: true })
    return next
  }
  if (result.state === 'code') {
    const next = updateCard(id, { state: 'code', message: null, accent: 'ice' })
    tellBrain('Služba poslala používateľovi overovací kód e-mailom alebo SMS a karta teraz čaká na ten kód. Povedz mu jednou vetou, nech ho opíše do karty.')
    return next
  }
  if (result.error === 'wrong_credentials') wrong.set(card.service, [...recentWrong(card.service), Date.now()])
  const keepCode = result.retry === true && sessions.get(id)?.session?.open
  if (!keepCode) closeSession(id)
  const next = updateCard(id, { state: keepCode ? 'code' : 'form', message: result.message, accent: 'amber' })
  const what = { wrong_credentials: 'Služba neprijala e-mail alebo heslo.', wrong_code: 'Kód nesedel.', rate_limited: 'Služba teraz prihlásenia odmieta, priveľa pokusov.', network: 'Službu sa nepodarilo zastihnúť.', timeout: 'Na kód sa čakalo pridlho.', no_uv: 'Chýba program uv, cez ktorý sa Jarvis prihlasuje.' }[result.error] ?? 'Prihlásenie zlyhalo.'
  tellBrain(`${what} Karta to ukazuje. Povedz mu to jednou krátkou vetou${result.error === 'rate_limited' ? ' a že to skúsite o hodinu' : result.error === 'no_uv' ? ' a že si ho doinštaluješ cez agent_task' : ', nech to skúsi v karte znova'}.`)
  return next
}

/** For a server shutdown: every waiting worker ends. */
export function stopLogins() {
  for (const id of [...sessions.keys()]) closeSession(id)
}

/** Tests: replace the session of a service (no real login). */
export function setServiceStart(service, start) {
  const prev = SERVICES[service].start
  SERVICES[service].start = start
  return () => (SERVICES[service].start = prev)
}
