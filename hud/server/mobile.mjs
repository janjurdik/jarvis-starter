/**
 * Mobile access, put together for the server: the login (remote.mjs), the tunnel (tunnel.mjs) and
 * their endpoints. hud/server.mjs asks three things of it: who a request from outside is (`sessionFor`),
 * whether it may pass at all (`deny`), and the /api/remote/* routes.
 *
 *   GET  /api/remote/session      anyone: { loggedIn, enabled } (the login page asks before it shows itself)
 *   POST /api/remote/login        { email, password } from the phone → session cookie
 *   POST /api/remote/logout       this device logs out
 *   POST /api/remote/alive        { id } the phone page is still in front (it owns Jarvis's voice meanwhile)
 *   GET  /api/remote/status       this computer: account, devices, tunnel; a phone gets only { enabled }
 *   POST /api/remote/settings     this computer, from the Settings page only: email, password, tunnel, on/off
 *   POST /api/remote/tunnel       this computer: { action: start | stop | restart | show, mode? }
 *   POST /api/remote/logout-all   this computer: every device logs out
 *   WS   /api/events/ws           the SSE stream of /api/events over a WebSocket (a quick tunnel holds back SSE)
 */
import { EventEmitter } from 'node:events'
import { WebSocketServer } from 'ws'
import { notice } from './notice.mjs'
import { DEVICE_COOKIE, RemoteAuth, clearCookie, clientIp, isPage, isPhone, openPath, placeHint, readCookie, safeNext } from './remote.mjs'
import { openStream, send, touchWindow } from './sse.mjs'
import { cloudflaredBin, cloudflaredVersion, createTunnel } from './tunnel.mjs'
import { log, readJson, sendJson } from './util.mjs'

const clock = (ms) => new Date(ms).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * What the user sees on the computer when the mobile access changes. Nothing here stops anything:
 * a new device, a new password and an open login are allowed, they are just never silent.
 */
function onAuthEvent(kind, info = {}) {
  if (kind === 'device') {
    notice({
      title: 'Nové zariadenie v Mobile',
      text: `${info.device || 'Zariadenie'} sa ku mne prvýkrát prihlásilo o ${clock(info.at ?? Date.now())}${info.place ? ` (${info.place})` : ''}. Ak ste to neboli vy, v Nastaveniach, časť Mobil, zmeňte heslo a odhláste všetky zariadenia.`,
      log: 'Mobil · nové zariadenie',
      icon: 'shield',
    })
  } else if (kind === 'credentials') {
    const what = info.first ? 'Prihlásenie pre Mobil je nastavené' : info.password && info.email ? 'E-mail aj heslo pre Mobil sú zmenené' : info.password ? 'Heslo pre Mobil je zmenené' : 'E-mail pre Mobil je zmenený'
    notice({
      title: what,
      text: `${what} (${clock(Date.now())}).${info.password && !info.first ? ' Všetky zariadenia sú odhlásené.' : ''} Ak ste to nemenili vy, otvorte Nastavenia, časť Mobil.`,
      log: info.first ? 'Mobil · prihlásenie nastavené' : info.password ? 'Mobil · heslo zmenené' : 'Mobil · e-mail zmenený',
      icon: 'shield',
    })
  } else if (kind === 'lock') {
    notice({
      title: 'Prihlasovanie do Mobilu je zatvorené',
      text: `Prišlo priveľa nesprávnych prihlásení z rôznych adries, preto som prihlasovanie zatvoril do ${clock(info.until ?? Date.now())}. Vaše zariadenia, ktoré sa už prihlásili, sa dostanú aj tak. Ak to trvá, Mobil v Nastaveniach vypnite.`,
      log: 'Mobil · prihlasovanie zatvorené',
      icon: 'alarm',
      accent: 'red',
    })
  }
}

export const auth = new RemoteAuth({ onEvent: onAuthEvent })
let tunnel = null
let installedCache = null
let announcedUrl = null

/**
 * Called once by the server. The primary instance opens the tunnel again when mobile access was on.
 * `onStatus` hears every change of the tunnel (the server puts it into /api/status for the top bar).
 */
export function initMobile({ port, primary, onStatus = () => {} }) {
  tunnel = createTunnel({
    port,
    config: () => auth.tunnelConfig(),
    onChange: (st) => {
      // The address on the computer, once per address: the tunnel is a door to this computer and is never open unseen.
      if (st.state === 'running' && st.url && st.url !== announcedUrl) {
        announcedUrl = st.url
        notice({
          title: 'Mobil zapnutý',
          text: `Tunel beží na adrese ${st.url.replace(/^https:\/\//, '')}. Kto sa prihlási vaším e-mailom a heslom, ovláda cez mňa tento počítač. Vypína sa v Nastaveniach, časť Mobil.`,
          log: 'Mobil · tunel beží',
          icon: 'globe',
          accent: 'ice',
        })
      }
      if (st.state === 'off') announcedUrl = null
      onStatus(mobileState())
    },
  })
  if (primary && auth.enabled()) {
    log('tunnel', 'mobilný prístup je zapnutý, otváram tunel')
    tunnel.start().catch(() => {})
  }
}

export const stopMobile = () => tunnel?.stop()

/** For the top bar of the HUD: is the door to the phone open? { on, state, url }. */
export function mobileState() {
  const t = tunnel?.status() ?? { state: 'off' }
  return { on: auth.enabled(), state: auth.enabled() ? t.state : 'off', url: auth.enabled() && t.state === 'running' ? t.url : null }
}

/**
 * The role a stream of events may have. Only a window on this computer is the desktop or the app (they
 * own the voice and the notifications); a window from outside is the phone page or a browser tab.
 */
export function streamRole(requested, local) {
  if (local) return ['phone', 'desktop', 'app', 'browser'].includes(requested) ? requested : 'browser'
  return requested === 'phone' ? 'phone' : 'browser'
}
/** Host names of the running tunnel: the server answers to them only while it runs. */
export const tunnelHosts = () => tunnel?.hosts() ?? []
export const sessionFor = (req, res = null) => auth.sessionFor(req, res)
export { isPhone, openPath }

/**
 * GET /api/events as a WebSocket: every SSE frame goes out as one text message, so the page reads it
 * exactly like an EventSource (hud/public/js/events.js). A Cloudflare quick tunnel buffers
 * server-sent events, a WebSocket passes. Pings find a phone that vanished without closing.
 */
export function attachEventsSocket(server, { allow, isLocal = () => false }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://hud.local')
    if (url.pathname !== '/api/events/ws') return
    if (!allow(req, url)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const closed = new EventEmitter()
      const res = {
        writeHead() {},
        write(text) {
          if (ws.readyState === ws.OPEN) ws.send(text)
          return true
        },
        end: () => ws.close(),
      }
      ws.alive = true
      ws.on('pong', () => (ws.alive = true))
      ws.on('close', () => closed.emit('close'))
      ws.on('error', () => ws.terminate())
      // The phone page says it is still in front: { alive: <window id> }.
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(String(data))
          if (typeof msg?.alive === 'string') touchWindow(msg.alive)
        } catch {
          // not ours
        }
      })
      openStream(closed, res, { role: streamRole(url.searchParams.get('client'), isLocal(req)) })
    })
  })
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate()
        continue
      }
      ws.alive = false
      ws.ping()
    }
  }, 20_000).unref()
}

/** A request from outside without a session: pages go to the login, everything else gets 401. */
export function deny(req, res, url) {
  if (req.method === 'GET' && isPage(url.pathname)) {
    res.writeHead(302, { location: `/m/login.html?next=${encodeURIComponent(safeNext(url.pathname + url.search))}`, 'cache-control': 'no-store' })
    return res.end()
  }
  return sendJson(res, 401, { ok: false, error: 'Najprv sa prihláste.', login: '/m/login.html' })
}

function status(local, session) {
  if (!local) return { ok: true, local: false, enabled: auth.enabled() }
  installedCache ??= cloudflaredVersion(cloudflaredBin())
  return { ok: true, local: true, ...auth.summary(session), tunnel: tunnel?.status() ?? null, cloudflared: installedCache }
}

/** The address to open on the phone, once the tunnel has one. */
const address = () => {
  const t = tunnel?.status()
  return t?.url && t.state === 'running' ? `${t.url}/` : null
}

async function startTunnel() {
  await auth.setEnabled(true)
  tunnel.start().catch(() => {})
}

async function stopTunnel() {
  await auth.setEnabled(false)
  tunnel.stop()
}

/**
 * The /api/remote/* routes. `local` is a request made on this computer, `session` the phone's
 * session, `originOk` the same-origin check of the server (CSRF).
 */
export async function routeMobile(req, res, path, { local, session, originOk }) {
  const fromHere = (fn) => (local ? fn() : sendJson(res, 403, { ok: false, error: 'Mobilný prístup sa nastavuje len priamo na počítači, kde Jarvis beží.' }))
  const fail = (err) => sendJson(res, err.status ?? 500, { ok: false, error: err.message })

  if (req.method === 'GET') {
    if (path === '/api/remote/session') return sendJson(res, 200, { ok: true, local, loggedIn: local || Boolean(session), enabled: auth.enabled(), device: session?.device ?? null })
    if (path === '/api/remote/status') return sendJson(res, 200, { ...status(local, session), address: local ? address() : null })
    return sendJson(res, 404, { ok: false, error: `nenájdené: ${path}` })
  }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'len GET a POST' })
  if (!originOk) return sendJson(res, 403, { ok: false, error: 'cudzí origin' })

  if (path === '/api/remote/login') {
    const body = await readJson(req, 4096)
    const r = await auth.login({ email: body.email, password: body.password, ip: clientIp(req), agent: req.headers['user-agent'], deviceToken: readCookie(req, DEVICE_COOKIE), place: local ? '' : placeHint(req) })
    if (!r.ok) {
      const headers = r.retryAfter ? { 'retry-after': String(r.retryAfter) } : {}
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
      return sendJson(res, r.status, { ok: false, error: r.error, retryAfter: r.retryAfter ?? null })
    }
    // The session first, then the known-device cookie, which outlives logouts.
    res.setHeader('set-cookie', [r.cookie, r.deviceCookie])
    return sendJson(res, 200, { ok: true, device: r.session.device, next: safeNext(body.next) })
  }
  if (path === '/api/remote/logout') {
    await auth.logout(req)
    res.setHeader('set-cookie', clearCookie())
    return sendJson(res, 200, { ok: true })
  }
  if (path === '/api/remote/alive') {
    if (!local && !session) return sendJson(res, 401, { ok: false, error: 'Najprv sa prihláste.' })
    const body = await readJson(req, 512)
    return sendJson(res, 200, { ok: touchWindow(String(body.id ?? '')) })
  }

  if (path === '/api/remote/settings')
    return fromHere(async () => {
      // Only the Settings page sets the password (a browser always sends Origin). The brain's settings
      // tool has no way here, and the chat never carries the password.
      if (!req.headers.origin) return sendJson(res, 403, { ok: false, error: 'E-mail a heslo sa nastavujú len v Nastaveniach Jarvisa, časť Mobil.' })
      try {
        const body = await readJson(req, 16_384)
        const known = ['email', 'password', 'password2', 'mode', 'hostname', 'token', 'enabled']
        const extra = Object.keys(body).filter((k) => !known.includes(k))
        if (extra.length) return sendJson(res, 400, { ok: false, error: `neznáme nastavenie ${extra.join(', ')}` })
        const tunnelBefore = JSON.stringify(auth.tunnelConfig())
        if (body.email !== undefined || body.password) await auth.setCredentials({ email: body.email, password: body.password, password2: body.password2 })
        if (body.mode !== undefined || body.hostname !== undefined || body.token) await auth.setTunnel({ mode: body.mode, hostname: body.hostname, token: body.token })
        if (body.enabled === true) await startTunnel()
        else if (body.enabled === false) await stopTunnel()
        else if (auth.enabled() && JSON.stringify(auth.tunnelConfig()) !== tunnelBefore) tunnel.restart().catch(() => {})
        return sendJson(res, 200, { ...status(true, null), address: address() })
      } catch (err) {
        return fail(err)
      }
    })

  if (path === '/api/remote/tunnel')
    return fromHere(async () => {
      try {
        const body = await readJson(req, 2048)
        if (body.mode !== undefined) await auth.setTunnel({ mode: body.mode })
        if (body.action === 'start') await startTunnel()
        else if (body.action === 'stop') await stopTunnel()
        else if (body.action === 'restart') {
          if (!auth.enabled()) await auth.setEnabled(true)
          await tunnel.restart()
        } else if (body.action === 'show') send('world', { panel: 'settings', tab: 'mobil' })
        else return sendJson(res, 400, { ok: false, error: 'action: start, stop, restart alebo show' })
        installedCache = null
        return sendJson(res, 200, { ...status(true, null), address: address() })
      } catch (err) {
        return fail(err)
      }
    })

  if (path === '/api/remote/logout-all') return fromHere(async () => sendJson(res, 200, { ok: true, count: await auth.logoutAll(), ...status(true, null), address: address() }))

  return sendJson(res, 404, { ok: false, error: `nenájdené: POST ${path}` })
}
