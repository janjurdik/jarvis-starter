/**
 * Jarvis as a living thing. He notices the day and the computer he lives in, and speaks up on his
 * own:
 *
 *   the day        New Year, Christmas, Easter, the user's birthday and name day, the day they met.
 *                  Said once: at midnight when the user is at the computer, otherwise in the
 *                  morning when he comes to it, or at the start of the first conversation of the day.
 *   the computer   a battery that runs low (and the relief of a charger), a disk that fills up,
 *                  the internet that went away and came back.
 *
 * What was already said is kept in data/life.json, so a restart does not repeat a wish.
 */
import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { readFileSync } from 'node:fs'
import { readFile, statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveLang, getConfig } from './config.mjs'
import { FILES, MEMORY_DIR } from './memory/index.mjs'
import { getSetup } from './setup.mjs'
import { DATA_DIR, IS_MAC, IS_WIN, errMsg, log, winSys, writeFileAtomic } from './util.mjs'

const STATE_FILE = join(DATA_DIR, 'life.json')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pad = (n) => String(n).padStart(2, '0')
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const monthDay = (d) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

let NAMEDAYS = {}
try {
  NAMEDAYS = JSON.parse(readFileSync(join(ROOT, 'server/assets/namedays-sk.json'), 'utf8')).days ?? {}
} catch {
  NAMEDAYS = {}
}

let deps = { canSpeak: () => false, brainReady: () => false, speakTurn: () => {}, say: () => {}, toast: () => {}, notify: () => {}, quiet: () => false }
let state = { said: {}, low: null, disk: null }
let loaded = false
let vitals = { battery: null, diskFreeGb: null, online: true }

async function load() {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, 'utf8'))
    state = { said: raw.said && typeof raw.said === 'object' ? raw.said : {}, low: raw.low ?? null, disk: raw.disk ?? null }
  } catch {
    // first run
  }
}
function save() {
  // Wishes older than two weeks are of no use any more.
  const cut = dayKey(new Date(Date.now() - 14 * 864e5))
  for (const k of Object.keys(state.said)) if (k.slice(0, 10) < cut) delete state.said[k]
  writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 1), 0o600).catch((err) => log('life', errMsg(err)))
}

// ── the day ────────────────────────────────────────────────────────────

/** Easter Sunday of a year (Gregorian calendar). */
export function easter(year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const g = Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const l = (32 + 2 * e + 2 * Math.floor(c / 4) - h - (c % 4)) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  return new Date(year, month - 1, ((h + l - 7 * m + 114) % 31) + 1)
}

/** The user's birthday: settings first, then `narodeniny:` in the head of memory/ja.md. → { md, year } | null */
function birthday(cfg) {
  let raw = cfg.birthday
  if (!raw) {
    try {
      raw = /^narodeniny:\s*["']?((?:\d{4}-)?\d{2}-\d{2})/m.exec(readFileSync(join(MEMORY_DIR, FILES.me), 'utf8').slice(0, 1200))?.[1]
    } catch {
      raw = null
    }
  }
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(String(raw ?? ''))
  return m ? { md: `${m[2]}-${m[3]}`, year: m[1] ? Number(m[1]) : null } : null
}

/** What today is, for this user. Every item: { id, what, how } (the second two are words for the brain). */
export function occasions(now = new Date(), cfg = getConfig()) {
  const md = monthDay(now)
  const out = []
  if (md === '01-01') out.push({ id: 'novy-rok', what: 'Nový rok', how: `Zaželaj šťastný nový rok ${now.getFullYear()}.`, plain: 'Šťastný nový rok' })
  if (md === '12-24') out.push({ id: 'vianoce', what: 'Štedrý deň', how: 'Zaželaj veselé Vianoce.', plain: 'Veselé Vianoce' })
  if (dayKey(easter(now.getFullYear())) === dayKey(now)) out.push({ id: 'velka-noc', what: 'Veľkonočná nedeľa', how: 'Zaželaj peknú Veľkú noc.', plain: 'Peknú Veľkú noc' })
  const b = birthday(cfg)
  if (b?.md === md) {
    const age = b.year ? now.getFullYear() - b.year : null
    out.push({ id: 'narodeniny', what: `jeho narodeniny${age ? ` (${age} rokov)` : ''}`, how: 'Zablahoželaj mu k narodeninám, osobne, podľa toho, čo o ňom vieš.', plain: 'Všetko najlepšie k narodeninám' })
  }
  const first = String(cfg.name ?? '').trim().split(/\s+/)[0]
  if (first && (NAMEDAYS[md] ?? []).includes(first)) out.push({ id: 'meniny', what: 'jeho meniny', how: 'Zablahoželaj mu k meninám.', plain: 'Všetko najlepšie k meninám' })
  const since = getSetup().startedAt
  if (since && since.slice(5, 10) === md && Number(since.slice(0, 4)) < now.getFullYear()) {
    const years = now.getFullYear() - Number(since.slice(0, 4))
    out.push({ id: 'vyrocie', what: `výročie: ${years === 1 ? 'rok' : `${years} roky`} odvtedy, čo ťa má`, how: 'Spomeň to jednou vetou, s humorom.', plain: 'Dnes je to rok, čo sme spolu' })
  }
  return out
}

const pending = (now) => occasions(now).filter((o) => !state.said[`${dayKey(now)}:${o.id}`])
function markSaid(list, now) {
  for (const o of list) state.said[`${dayKey(now)}:${o.id}`] = new Date().toISOString()
  save()
}

/** Seconds since the last key or mouse move, or null when the system does not say. */
function idleSeconds() {
  if (!IS_MAC) return Promise.resolve(null)
  return new Promise((done) => {
    execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 4000, maxBuffer: 4_000_000 }, (err, out) => {
      const m = err ? null : /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(out))
      done(m ? Number(m[1]) / 1e9 : null)
    })
  })
}

/** Says today's wishes when the moment is right. Otherwise they wait for the first conversation (lifeNote). */
async function wishes(now) {
  const list = pending(now)
  if (!list.length || !deps.canSpeak()) return
  // At night Jarvis speaks only to somebody who is at the computer right now (midnight on New Year's Eve, a late evening of work).
  if (deps.quiet()) {
    const idle = await idleSeconds()
    if (idle === null || idle > 240) return
  }
  markSaid(list, now)
  const what = list.map((o) => o.what).join(' a ')
  log('life', `príležitosť: ${what}`)
  deps.toast(list[0].plain, 'sparkle', 'info')
  if (deps.brainReady()) {
    deps.speakTurn(`[systém: dnes je ${what}. Ozvi sa sám od seba. ${list.map((o) => o.how).join(' ')} Jedna až dve vety vo svojom štýle, s oslovením. Nič iné teraz nerieš a žiadny nástroj nevolaj.]`)
  } else deps.say(`${list.map((o) => o.plain).join('. ')}.`)
}

/**
 * For the context of a user's message: what Jarvis should know right now without being asked.
 * A wish nobody has heard yet is handed over here (and counts as said), so the first conversation
 * of the day starts with it.
 */
export function lifeNote(now = new Date()) {
  const parts = []
  if (loaded) {
    const list = pending(now)
    if (list.length) {
      markSaid(list, now)
      parts.push(`dnes je ${list.map((o) => o.what).join(' a ')} a ešte si to nespomenul: začni odpoveď jednou vetou k tomu (${list.map((o) => o.how).join(' ')})`)
    }
  }
  const b = vitals.battery
  if (b && !b.charging) parts.push(`počítač beží na batériu, ${b.pct} %`)
  if (vitals.diskFreeGb !== null && vitals.diskFreeGb < 10) parts.push(`na disku ostáva ${vitals.diskFreeGb} GB`)
  return parts.join(' · ')
}

// ── the computer ───────────────────────────────────────────────────────

function run(cmd, args, timeout = 6000) {
  return new Promise((done) => execFile(cmd, args, { timeout, windowsHide: true }, (err, out) => done(err ? '' : String(out))))
}

/** { pct, charging } or null on a computer without a battery. */
async function readBattery() {
  if (IS_MAC) {
    const out = await run('/usr/bin/pmset', ['-g', 'batt'])
    const m = /(\d{1,3})%;\s*([a-z ]+);/i.exec(out)
    if (!m) return null
    return { pct: Number(m[1]), charging: /AC Power/.test(out) || /^(charging|charged|finishing charge)/i.test(m[2].trim()) }
  }
  if (IS_WIN) {
    const out = await run(winSys('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', '$b = Get-CimInstance Win32_Battery | Select-Object -First 1; if ($b) { "$($b.EstimatedChargeRemaining);$($b.BatteryStatus)" }'], 12_000)
    const m = /^(\d{1,3});(\d+)/.exec(out.trim())
    // BatteryStatus 1 = discharging, everything else is some kind of mains power.
    return m ? { pct: Number(m[1]), charging: m[2] !== '1' } : null
  }
  return null
}

/** Lines Jarvis says about the computer, in the user's language and the way he is addressed. */
function lines(cfg) {
  const a = String(cfg.address ?? '').trim()
  const who = a ? `, ${a}` : ''
  const formal = cfg.formal !== false
  if (effectiveLang(cfg) === 'cs') {
    return {
      b20: (p) => `Baterie je na ${p} procentech${who}. Nabíječka by se hodila.`,
      b10: (p) => `${p} procent${who}. Doporučuji nabíječku dřív, než se odmlčím.`,
      b5: (p) => `Posledních ${p} procent${who}. Za chvíli zhasnu, ${formal ? 'uložte si' : 'ulož si'} práci.`,
      plug: `Děkuji${who}. Už se mi vrací barva.`,
      disk: (gb) => `Na disku zbývá ${gb} gigabajtů${who}. Mám se podívat, co zabírá místo?`,
      off: 'Bez internetu. Dokud se nevrátí, neslyším a nepřemýšlím.',
      on: `Internet je zpět${who}. Jsem zase celý.`,
    }
  }
  return {
    b20: (p) => `Batéria je na ${p} percentách${who}. Nabíjačka by sa hodila.`,
    b10: (p) => `${p} percent${who}. Odporúčam nabíjačku skôr, než sa odmlčím.`,
    b5: (p) => `Posledných ${p} percent${who}. O chvíľu zhasnem, ${formal ? 'uložte si' : 'ulož si'} prácu.`,
    plug: `Ďakujem${who}. Už sa mi vracia farba.`,
    disk: (gb) => `Na disku ostáva ${gb} gigabajtov${who}. Mám sa pozrieť, čo zaberá miesto?`,
    off: 'Bez internetu. Kým sa nevráti, nepočujem a nerozmýšľam.',
    on: `Internet je späť${who}. Som zase celý.`,
  }
}

/** Shows it, notifies and, outside quiet hours, says it. */
function report(text, { icon = 'alarm', type = 'alert', title = 'Jarvis', voice = true } = {}) {
  log('life', text)
  deps.toast(text, icon, type)
  deps.notify({ title, body: text, quiet: deps.quiet() })
  if (voice) deps.say(text)
}

let offlineFor = 0
let tickNo = 0
async function body() {
  const cfg = getConfig()
  const say = lines(cfg)

  // Battery: once at 20, 10 and 5 percent of one discharge. Windows is asked less often, it is slower to answer.
  if (!IS_WIN || tickNo % 3 === 0) {
    const b = await readBattery()
    vitals.battery = b
    if (b) {
      if (b.charging || b.pct > 25) {
        if (b.charging && state.low !== null && b.pct <= 25) report(say.plug, { icon: 'check', type: 'done', title: 'Jarvis · nabíjam sa' })
        if (state.low !== null) {
          state.low = null
          save()
        }
      } else {
        const step = b.pct <= 5 ? 5 : b.pct <= 10 ? 10 : b.pct <= 20 ? 20 : null
        if (step !== null && (state.low === null || step < state.low)) {
          state.low = step
          save()
          report(step === 5 ? say.b5(b.pct) : step === 10 ? say.b10(b.pct) : say.b20(b.pct), { title: 'Jarvis · batéria' })
        }
      }
    }
  }

  // Disk: once a day when the home disk is nearly full.
  if (tickNo % 10 === 0) {
    try {
      const s = await statfs(homedir())
      const free = (s.bavail * s.bsize) / 1e9
      const total = (s.blocks * s.bsize) / 1e9
      vitals.diskFreeGb = Math.round(free)
      const today = dayKey(new Date())
      if ((free < 5 || free / total < 0.03) && state.disk !== today) {
        state.disk = today
        save()
        report(say.disk(Math.max(1, Math.round(free))), { title: 'Jarvis · disk' })
      }
    } catch {
      // the system does not say: nothing to report
    }
  }

  // Internet: gone for two checks in a row is worth a word, and so is its return.
  const online = await lookup('one.one.one.one').then(() => true, () => false)
  if (!online) {
    offlineFor++
    if (offlineFor === 2) report(say.off, { voice: false, title: 'Jarvis · bez internetu' })
  } else {
    if (offlineFor >= 2) report(say.on, { icon: 'check', type: 'done', title: 'Jarvis · internet je späť' })
    offlineFor = 0
  }
  vitals.online = online
  tickNo++
}

async function tick() {
  try {
    await load()
    await wishes(new Date())
    await body()
  } catch (err) {
    log('life', errMsg(err))
  }
}

/** For tests: the wish for a given moment, without waiting for the clock. */
export const wishNow = (now) => load().then(() => wishes(now))

/** What Jarvis knows about the computer right now (for the status and for answers). */
export const lifeStatus = () => ({ ...vitals })

/** Starts the watch. `again()` is for moments that matter: somebody opened the desktop, a conversation ended. */
export function startLife(o) {
  deps = { ...deps, ...o }
  setTimeout(tick, 20_000).unref()
  setInterval(tick, 60_000).unref()
  return { again: () => setTimeout(() => load().then(() => wishes(new Date())).catch(() => {}), 4000).unref() }
}
