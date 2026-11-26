/**
 * Jarvis on the phone: the login that guards every request coming from outside this computer.
 *
 * Localhost stays exactly as it was, without a password. Everything else (a phone through the
 * Cloudflare tunnel, server/tunnel.mjs) needs a session: one account per Jarvis, an email and a
 * password the user picks himself in Settings → Mobil on this computer. The password never goes
 * through the chat, the brain or a log; only its scrypt hash with a random salt is kept.
 *
 *   data/brain/remote.json   { enabled, email, password: { algo, N, r, p, salt, hash }, sessions, tunnel }
 *   data/brain/tunnel-token  the token of the user's own Cloudflare tunnel (never shown back in full)
 *
 * A session is 256 random bits in an HttpOnly, Secure, SameSite=Strict cookie; the server keeps
 * only its SHA-256. It lives 30 days from the last use and the cookie is renewed once a day.
 * Wrong logins slow down per address and, when there are many from everywhere, for everybody.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BRAIN_DIR, clean, errMsg, isLoopback, log, writeFileAtomic } from './util.mjs'

export const REMOTE_FILE = join(BRAIN_DIR, 'remote.json')
export const TOKEN_FILE = join(BRAIN_DIR, 'tunnel-token')
export const COOKIE = 'jarvis_session'
export const SESSION_DAYS = 30
const DAY = 86_400_000
const SESSION_MS = SESSION_DAYS * DAY
export const PASSWORD_MIN = 10
const PASSWORD_MAX = 200
const MAX_SESSIONS = 20
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64 }
const EMAIL_RE = /^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`]{2,}$/
const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/
const TUNNEL_TOKEN_RE = /^[A-Za-z0-9+/=_-]{40,4096}$/

const bad = (message, status = 400) => Object.assign(new Error(message), { status })
const sha = (text) => createHash('sha256').update(String(text)).digest('hex')
const normEmail = (v) => String(v ?? '').trim().toLowerCase()

function scrypt(password, salt, { N, r, p, keylen }) {
  return new Promise((done, fail) => {
    scryptCb(String(password).normalize('NFKC'), salt, keylen, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) => (err ? fail(err) : done(key)))
  })
}

/** A scrypt hash of the password with a new random salt, in the shape stored in remote.json. */
export async function hashPassword(password, params = SCRYPT) {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, params)
  return { algo: 'scrypt', N: params.N, r: params.r, p: params.p, salt: salt.toString('base64'), hash: key.toString('base64') }
}

const DUMMY = { algo: 'scrypt', ...SCRYPT, salt: Buffer.alloc(16).toString('base64'), hash: Buffer.alloc(64).toString('base64') }

/** Constant time: the hash is computed also when there is no password, so a missing account is not faster. */
export async function verifyPassword(password, record) {
  const rec = record?.algo === 'scrypt' ? record : DUMMY
  const expected = Buffer.from(rec.hash, 'base64')
  let key
  try {
    key = await scrypt(String(password ?? ''), Buffer.from(rec.salt, 'base64'), { N: rec.N, r: rec.r, p: rec.p, keylen: expected.length })
  } catch {
    return false
  }
  return key.length === expected.length && timingSafeEqual(key, expected) && rec !== DUMMY
}

/** Compares two strings without leaking where they differ (both are hashed to the same length first). */
const sameText = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest())

export function readCookie(req, name = COOKIE) {
  for (const part of String(req.headers?.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return null
}

export const sessionCookie = (token, maxAgeS = SESSION_MS / 1000) => `${COOKIE}=${token}; Path=/; Max-Age=${Math.round(maxAgeS)}; HttpOnly; Secure; SameSite=Strict`
export const clearCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`

/**
 * The address a request comes from. Behind the tunnel (cloudflared connects from this computer) it is
 * the address Cloudflare saw, otherwise the socket's own.
 */
export function clientIp(req) {
  const sock = req.socket?.remoteAddress ?? ''
  if (!isLoopback(sock)) return sock || 'unknown'
  const cf = String(req.headers['cf-connecting-ip'] ?? '').trim()
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
  const real = String(req.headers['x-real-ip'] ?? '').trim()
  return (cf || fwd || real || sock).slice(0, 64)
}

/** "iPhone, Safari": what the list of logged-in devices shows. Nothing else of the user agent is kept. */
export function deviceName(ua = '') {
  const s = String(ua)
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : 'Zariadenie'
  const app = /EdgA?\//.test(s) ? 'Edge' : /Firefox|FxiOS/.test(s) ? 'Firefox' : /SamsungBrowser/.test(s) ? 'Samsung Internet' : /CriOS|Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /curl/i.test(s) ? 'curl' : ''
  return app ? `${os}, ${app}` : os
}

/**
 * Brute force brakes. Per address: five wrong tries, then a wait that doubles with every next one (30 s,
 * 1 min, 2 min, … up to an hour); a quiet hour forgets it. For everybody: 50 wrong tries within
 * 15 minutes close the login for 10 minutes, so many addresses together get nowhere either.
 * At most one check per address and four in all run at a time (scrypt costs memory and time).
 */
export class Limiter {
  constructor({ free = 5, base = 30_000, max = 3_600_000, decay = 3_600_000, window = 900_000, globalMax = 50, globalLock = 600_000, inflightPerIp = 1, inflightAll = 4 } = {}) {
    Object.assign(this, { free, base, max, decay, window, globalMax, globalLock, inflightPerIp, inflightAll })
    this.ips = new Map()
    this.recent = []
    this.globalUntil = 0
    this.inflight = new Map()
    this.inflightTotal = 0
  }

  check(ip, now = Date.now()) {
    if (now < this.globalUntil) return { ok: false, retryAfter: Math.ceil((this.globalUntil - now) / 1000), global: true }
    const r = this.ips.get(ip)
    if (r && now - r.last > this.decay) this.ips.delete(ip)
    else if (r && r.until > now) return { ok: false, retryAfter: Math.ceil((r.until - now) / 1000) }
    if ((this.inflight.get(ip) ?? 0) >= this.inflightPerIp || this.inflightTotal >= this.inflightAll) return { ok: false, retryAfter: 2, busy: true }
    return { ok: true }
  }

  begin(ip) {
    this.inflight.set(ip, (this.inflight.get(ip) ?? 0) + 1)
    this.inflightTotal++
  }

  end(ip) {
    const n = (this.inflight.get(ip) ?? 1) - 1
    if (n > 0) this.inflight.set(ip, n)
    else this.inflight.delete(ip)
    this.inflightTotal = Math.max(0, this.inflightTotal - 1)
  }

  fail(ip, now = Date.now()) {
    const r = this.ips.get(ip) ?? { fails: 0, last: 0, until: 0 }
    if (now - r.last > this.decay) r.fails = 0
    r.fails++
    r.last = now
    if (r.fails >= this.free) r.until = now + Math.min(this.max, this.base * 2 ** (r.fails - this.free))
    this.ips.delete(ip)
    this.ips.set(ip, r)
    // A flood of addresses must not grow this map without end: the oldest are forgotten.
    while (this.ips.size > 5000) this.ips.delete(this.ips.keys().next().value)
    this.recent = this.recent.filter((t) => now - t < this.window)
    this.recent.push(now)
    if (this.recent.length >= this.globalMax) {
      this.globalUntil = now + this.globalLock
      this.recent = []
      log('remote', 'priveľa zlých prihlásení zo siete, prihlasovanie je na chvíľu zatvorené')
    }
  }

  success(ip) {
    this.ips.delete(ip)
  }
}

const humanWait = (s) => (s < 90 ? `${s} s` : s < 5400 ? `${Math.ceil(s / 60)} min` : `${Math.ceil(s / 3600)} h`)

/** One account and its sessions. The server keeps one; tests make their own with a temporary file and a clock. */
export class RemoteAuth {
  constructor({ file = REMOTE_FILE, tokenFile = TOKEN_FILE, now = () => Date.now(), scryptParams = SCRYPT, limiter = new Limiter() } = {}) {
    this.file = file
    this.tokenFile = tokenFile
    this.now = now
    this.params = scryptParams
    this.limiter = limiter
    this.saveTimer = null
    this.queue = Promise.resolve()
    this.data = this.load()
  }

  load() {
    let raw = {}
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      raw = {}
    }
    const pw = raw.password
    return {
      enabled: raw.enabled === true,
      email: typeof raw.email === 'string' ? normEmail(raw.email) : '',
      password: pw && pw.algo === 'scrypt' && pw.salt && pw.hash ? pw : null,
      sessions: (Array.isArray(raw.sessions) ? raw.sessions : []).filter((s) => s && /^[0-9a-f]{64}$/.test(s.id)).slice(-MAX_SESSIONS),
      tunnel: { mode: raw.tunnel?.mode === 'named' ? 'named' : 'quick', hostname: HOST_RE.test(String(raw.tunnel?.hostname ?? '')) ? raw.tunnel.hostname : '' },
    }
  }

  /** One write at a time; the file holds hashes, so it is private like the rest of data/brain. */
  save() {
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    const body = `${JSON.stringify(this.data, null, 1)}\n`
    const next = this.queue.then(() => writeFileAtomic(this.file, body, 0o600))
    this.queue = next.catch((err) => log('remote', `remote.json sa neuložil: ${errMsg(err)}`))
    return next
  }

  saveSoon() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => this.save().catch(() => {}), 5000)
    this.saveTimer.unref?.()
  }

  configured() {
    return Boolean(this.data.email && this.data.password)
  }

  /** Mobile access is on: the tunnel runs and sessions are accepted. */
  enabled() {
    return this.data.enabled && this.configured()
  }

  hasTunnelToken() {
    return Boolean(this.tunnelToken())
  }

  tunnelToken() {
    try {
      const t = readFileSync(this.tokenFile, 'utf8').trim()
      return TUNNEL_TOKEN_RE.test(t) ? t : ''
    } catch {
      return ''
    }
  }

  tunnelConfig() {
    return { ...this.data.tunnel, token: this.data.tunnel.mode === 'named' ? this.tunnelToken() : '' }
  }

  /**
   * The session of a request, or null. With `res`, the cookie is renewed once a day (sliding 30 days).
   * Sessions count only while mobile access is on.
   */
  sessionFor(req, res = null) {
    if (!this.enabled()) return null
    const token = readCookie(req)
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const id = sha(token)
    const s = this.data.sessions.find((x) => x.id === id)
    if (!s) return null
    const now = this.now()
    if (now - (s.seen ?? s.created ?? 0) > SESSION_MS) {
      this.data.sessions = this.data.sessions.filter((x) => x !== s)
      this.saveSoon()
      return null
    }
    if (now - (s.seen ?? 0) > 60_000) {
      s.seen = now
      this.saveSoon()
    }
    if (res && now - (s.renewed ?? s.created ?? 0) > DAY && !res.headersSent) {
      s.renewed = now
      res.setHeader('set-cookie', sessionCookie(token))
      this.saveSoon()
    }
    return s
  }

  /**
   * A login try. → { ok: true, cookie, session } or { ok: false, status, error, retryAfter? }.
   * The answer to a wrong email and to a wrong password is the same, and takes the same time.
   */
  async login({ email, password, ip = 'unknown', agent = '' } = {}) {
    if (!this.enabled()) return { ok: false, status: 403, error: 'Mobilný prístup je vypnutý. Zapína sa v Nastaveniach Jarvisa na počítači, časť Mobil.' }
    const now = this.now()
    const gate = this.limiter.check(ip, now)
    if (!gate.ok) return { ok: false, status: 429, retryAfter: gate.retryAfter, error: gate.busy ? 'Chvíľu počkajte a skúste to znova.' : `Priveľa nesprávnych pokusov. Skúste to znova o ${humanWait(gate.retryAfter)}.` }
    this.limiter.begin(ip)
    let ok = false
    try {
      const emailOk = sameText(normEmail(email), this.data.email)
      const passOk = await verifyPassword(String(password ?? '').slice(0, PASSWORD_MAX), this.data.password)
      ok = emailOk && passOk
    } finally {
      this.limiter.end(ip)
    }
    if (!ok) {
      this.limiter.fail(ip, this.now())
      log('remote', `nesprávne prihlásenie (${deviceName(agent)})`)
      return { ok: false, status: 401, error: 'Nesprávny e-mail alebo heslo.' }
    }
    this.limiter.success(ip)
    const token = randomBytes(32).toString('base64url')
    const session = { id: sha(token), created: now, seen: now, renewed: now, device: deviceName(agent) }
    this.data.sessions.push(session)
    while (this.data.sessions.length > MAX_SESSIONS) this.data.sessions.shift()
    await this.save()
    log('remote', `prihlásené zariadenie: ${session.device}`)
    return { ok: true, cookie: sessionCookie(token), session }
  }

  async logout(req) {
    const token = readCookie(req)
    if (!token) return
    const id = sha(token)
    const before = this.data.sessions.length
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id)
    if (this.data.sessions.length !== before) await this.save()
  }

  async logoutAll() {
    const n = this.data.sessions.length
    this.data.sessions = []
    await this.save()
    if (n) log('remote', `odhlásené všetky zariadenia (${n})`)
    return n
  }

  /**
   * Email and password from Settings → Mobil. A new password logs out every device. The password is
   * checked here and only its hash is stored.
   */
  async setCredentials({ email, password, password2 } = {}) {
    if (email !== undefined) {
      const e = normEmail(email)
      if (!EMAIL_RE.test(e) || e.length > 200) throw bad('E-mail nevyzerá správne.')
      this.data.email = e
    }
    if (password !== undefined && password !== '') {
      const p = String(password)
      if (p !== String(password2 ?? '')) throw bad('Heslá sa nezhodujú.')
      if ([...p].length < PASSWORD_MIN) throw bad(`Heslo musí mať aspoň ${PASSWORD_MIN} znakov.`)
      if (p.length > PASSWORD_MAX) throw bad(`Heslo môže mať najviac ${PASSWORD_MAX} znakov.`)
      if (p.trim().toLowerCase() === this.data.email) throw bad('Heslo nesmie byť rovnaké ako e-mail.')
      if (/^(.)\1+$/.test(p) || /^(0123456789|1234567890|qwertyuiop|heslo12345|password12)/i.test(p)) throw bad('Toto heslo sa dá ľahko uhádnuť. Zvoľte iné.')
      this.data.password = await hashPassword(p, this.params)
      this.data.sessions = []
      log('remote', 'heslo pre mobil zmenené, zariadenia odhlásené')
    }
    await this.save()
  }

  async setEnabled(on) {
    if (on && !this.configured()) throw bad('Najprv nastavte e-mail a heslo v Nastaveniach, časť Mobil.', 409)
    if (this.data.enabled === Boolean(on)) return
    this.data.enabled = Boolean(on)
    // Turning it off closes every door at once; a device logs in again after it is back on.
    if (!on) this.data.sessions = []
    await this.save()
    log('remote', on ? 'mobilný prístup zapnutý' : 'mobilný prístup vypnutý')
  }

  /** Tunnel mode and the user's own tunnel (hostname, token). The token is written to its own file and never read back to the page. */
  async setTunnel({ mode, hostname, token } = {}) {
    if (mode !== undefined) {
      if (!['quick', 'named'].includes(mode)) throw bad('Tunel: quick alebo named.')
      this.data.tunnel.mode = mode
    }
    if (hostname !== undefined) {
      const h = String(hostname).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      if (h && !HOST_RE.test(h)) throw bad('Adresa má tvar jarvis.vasa-domena.sk.')
      this.data.tunnel.hostname = h
    }
    if (token !== undefined && token !== '') {
      const t = String(token).trim().replace(/^.*--token\s+/, '').replace(/^cloudflared\s+.*\s/, '')
      if (!TUNNEL_TOKEN_RE.test(t)) throw bad('Token tunela nevyzerá správne. Skopírujte ho z Cloudflare celý (dlhý reťazec za --token).')
      await writeFileAtomic(this.tokenFile, `${t}\n`, 0o600)
    }
    if (token === null) rmSync(this.tokenFile, { force: true })
    await this.save()
  }

  /** What Settings → Mobil shows. Never the password, its hash or the tunnel token. */
  summary(current = null) {
    const d = this.data
    return {
      enabled: this.enabled(),
      email: d.email,
      hasPassword: Boolean(d.password),
      passwordMin: PASSWORD_MIN,
      mode: d.tunnel.mode,
      hostname: d.tunnel.hostname,
      hasToken: this.hasTunnelToken(),
      sessionDays: SESSION_DAYS,
      devices: d.sessions
        .slice()
        .sort((a, b) => (b.seen ?? 0) - (a.seen ?? 0))
        .map((s) => ({ id: s.id.slice(0, 8), device: clean(s.device, 40) || 'Zariadenie', created: s.created ?? null, seen: s.seen ?? null, current: s === current })),
    }
  }
}

// ── the gate for requests from outside ────────────────────────────────────

/** What a phone without a session may load: the login page, its assets and the app icon. */
const OPEN_GET = new Set(['/m/login.html', '/m/login.js', '/m/m.css', '/m/manifest.json', '/m/icon-192.png', '/m/icon-512.png', '/m/apple-touch-icon.png', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/fonts/mona-sans-vf.woff2', '/api/remote/session'])

export function openPath(method, path) {
  if (method === 'POST') return path === '/api/remote/login'
  return OPEN_GET.has(path)
}

/** A page (redirected to the login) or anything else (401). */
export function isPage(path) {
  if (/^\/(api|tts|vendor)\//.test(path)) return false
  return /\.html?$/i.test(path) || !/\.[a-z0-9]{1,8}$/i.test(path)
}

/** A path on this server to come back to after the login, never another site. */
export function safeNext(next) {
  const n = String(next ?? '')
  return /^\/(?![/\\])[^\s]*$/.test(n) && !n.startsWith('/m/login') ? n.slice(0, 500) : '/'
}

export const isPhone = (req) => /iPhone|iPod|Android.+Mobile|Mobile.+Firefox|Windows Phone/i.test(String(req.headers['user-agent'] ?? ''))
