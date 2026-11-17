#!/usr/bin/env node
/**
 * Garmin Connect as a live source for Jarvis: sleep, HRV, resting heart rate, body battery,
 * steps, stress, training readiness and workouts, straight from the user's watch account.
 *
 *   node scripts/garmin.mjs                    is Garmin connected, when was the last sync (also --json)
 *   node scripts/garmin.mjs status --check     also ask Garmin whether the saved login still works
 *   node scripts/garmin.mjs login              connect: the user runs this in their own terminal
 *   node scripts/garmin.mjs sync               pull the last 14 days into the daily log (also --json)
 *   node scripts/garmin.mjs sync --days 2      a shorter range (the alarm's brief uses 2)
 *   node scripts/garmin.mjs logout             disconnect: delete the saved login from this computer
 *
 * `login` asks for the Garmin e-mail and password, so it only runs in a real terminal with the
 * user at the keyboard. From Claude, a routine or any other place without one it refuses and prints
 * the one line to type. The password goes from the keyboard to Garmin and is never stored: only
 * the session tokens are kept, in data/garmin/ (docs/GARMIN.md).
 *
 * `sync` writes into memory/dennik/RRRR-MM-DD.md: the header fields spanok, spanok_skore, hrv,
 * tep_pokoj, bateria, kroky… and workouts under "## Tréning". Running it twice changes nothing,
 * and a sleep the user said or typed is never replaced (hud/server/garmin/index.mjs).
 *
 * The pulse starts `sync --auto` in the background when one is due. That run prints nothing and
 * logs to data/logs/garmin.log.
 *
 * Tests: `sync --fixture <file> [--today RRRR-MM-DD]` answers from a file instead of Garmin and
 * only works when JARVIS_MEMORY_DIR and JARVIS_DATA_DIR point to a sandbox.
 */
// .env first: the modules below read JARVIS_MEMORY_DIR and JARVIS_DATA_DIR when they load.
import '../hud/server/env.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig } from '../hud/server/config.mjs'
import { checkGarmin, describeDay, garminConnected, garminStatus, hMin, loginCommands, logoutGarmin, readState, runLogin, syncGarmin, uvReady, STATE_FILE } from '../hud/server/garmin/index.mjs'
import { isoDay, writeFileAtomic } from '../hud/server/util.mjs'
import { DATA_DIR, IS_WIN, hudListeners, notify, postHud, quietNow } from './lib.mjs'

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')[0]))
const value = (name) => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i < 0) return null
  return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1] ?? null
}
const VALUE_FLAGS = /^--(days|fixture|today|reason)$/
const rest = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.test(argv[i - 1])))
const action = rest[0] ?? 'status'
const asJson = flags.has('json')

const shortDay = (day) => `${Number(day.slice(8))}. ${Number(day.slice(5, 7))}.`
const when = (iso) => {
  if (!iso) return 'ešte nikdy'
  const d = new Date(iso)
  const day = isoDay(d)
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${day === isoDay() ? 'dnes' : `${shortDay(day)} ${d.getFullYear()}`} o ${time}`
}
const myCommand = () => (IS_WIN ? loginCommands().windows : loginCommands().mac)
const out = (data, text) => console.log(asJson ? JSON.stringify(data, null, 2) : text)

const UV_HINT = IS_WIN ? 'PowerShell: irm https://astral.sh/uv/install.ps1 | iex' : 'Terminál: curl -LsSf https://astral.sh/uv/install.sh | sh'

function howToConnect() {
  return [
    'Pripojenie spustíš sám v termináli, lebo sa pri ňom zadáva heslo ku Garminu (Jarvis ani Claude ho nevidia):',
    `  macOS (Terminál):       ${loginCommands().mac}`,
    `  Windows (PowerShell):   ${loginCommands().windows}`,
  ].join('\n')
}

/** What the last night looked like, or why it is not known yet. */
function nightText(o) {
  if (o.lastNight) return `Posledná noc (${shortDay(o.lastNight.day)}): ${describeDay(o.lastNight)}`
  const lines = ['Dnešný spánok hodinky ešte neposlali. Objaví sa, keď sa po zobudení zosynchronizujú s mobilom.']
  if (o.latestSleep) lines.push(`Naposledy známa noc (${shortDay(o.latestSleep.day)}): ${hMin(o.latestSleep.minutes)}${o.latestSleep.score ? `, skóre ${Math.round(o.latestSleep.score)}` : ''}.`)
  return lines.join('\n')
}

// ── status ──────────────────────────────────────────────────────────────

async function status() {
  const s = garminStatus()
  const check = flags.has('check') && s.connected ? await checkGarmin() : null
  const data = { ...s, ...(check ? { valid: check.valid, name: check.name ?? null, checkError: check.error ?? null } : {}) }
  if (!s.connected) {
    return out(data, ['Garmin nie je pripojený.', s.uv ? '' : `Najprv treba program uv. ${UV_HINT}`, howToConnect()].filter(Boolean).join('\n'))
  }
  const lines = [`Garmin je pripojený (prihlásenie uložené ${when(s.savedAt)}). Posledná synchronizácia: ${when(s.lastSync)}. Dní v pamäti: ${s.cachedDays}.`]
  if (check) lines.push(check.valid ? `Prihlásenie platí${check.name ? ` (${check.name})` : ''}.` : `Prihlásenie sa nepodarilo overiť: ${check.message ?? 'neznáma chyba'}`)
  if (s.lastError) lines.push(`Posledná chyba (${when(s.lastError.at)}): ${s.lastError.message}${s.lastError.code === 'needs_login' ? `\n${howToConnect()}` : ''}`)
  if (s.cachedDays) lines.push(nightText(s))
  out(data, lines.join('\n'))
}

// ── login ───────────────────────────────────────────────────────────────

async function login() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const message = 'Prihlásenie do Garminu sa dá spustiť len v termináli s človekom pri klávesnici, lebo sa pri ňom zadáva heslo.'
    out({ ok: false, error: 'needs_terminal', message, login: loginCommands() }, `${message}\n${howToConnect()}\nKeď to dobehne, napíš Jarvisovi „hotovo".`)
    process.exit(2)
  }
  if (!uvReady()) {
    console.log(`Chýba program uv, cez ktorý Jarvis spúšťa pripojenie na Garmin. ${UV_HINT}`)
    process.exit(1)
  }
  console.log('Pripravujem pripojenie (prvýkrát to môže trvať do minúty)…\n')
  const code = await runLogin()
  if (code !== 0 || !garminConnected()) {
    if (code === 0) console.log('Prihlásenie sa neuložilo. Skús to znova.')
    process.exit(code || 1)
  }
  console.log('\nSťahujem posledných 14 dní…')
  const res = await syncGarmin({ days: 14, reason: 'login' })
  if (!res.ok) {
    console.log(`Garmin je pripojený, ale prvé stiahnutie sa nepodarilo: ${res.message}\nSkús neskôr: node scripts/garmin.mjs sync`)
    process.exit(1)
  }
  console.log(`${res.message}\n${nightText(res)}\nOdteraz si Jarvis dáta sťahuje sám. Odpojenie: node scripts/garmin.mjs logout`)
}

// ── sync ────────────────────────────────────────────────────────────────

/** Saves a few fields into the sync state without touching the rest. */
async function patchState(patch) {
  await writeFileAtomic(STATE_FILE, `${JSON.stringify({ ...readState(), ...patch }, null, 1)}\n`, 0o600)
}

/**
 * After a background sync. Two things are worth telling the user, each at most once:
 *   - last night's sleep has just arrived from the watch. The alarm could not say it (the watch
 *     only reports a night after waking up), so on a morning when the alarm rang Jarvis adds it
 *     out loud. On other mornings it is a silent card in the HUD.
 *   - Garmin rejected the saved login, so the user has to connect again.
 */
async function afterAuto(res, before) {
  const cfg = getConfig()
  const now = new Date()
  const today = isoDay(now)
  const state = readState()
  if (!res.ok) {
    if (res.error === 'needs_login' && state.notifiedLogin !== state.lastError?.at) {
      await notify('Jarvis: Garmin', 'Prihlásenie do Garminu vypršalo. Pripoj ho znova: node scripts/garmin.mjs login')
      await patchState({ notifiedLogin: state.lastError?.at ?? now.toISOString() })
    }
    return
  }
  const sleepData = res.lastNight?.sleep
  if (!sleepData || before.lastNightKnown || state.announced === today || cfg.garmin?.announce === false || now.getHours() >= 13) return
  await patchState({ announced: today })
  // An alarm that is still ahead today says the sleep itself.
  const alarm = cfg.alarm?.enabled ? /^(\d{1,2}):(\d{2})$/.exec(cfg.alarm.time) : null
  if (alarm && now.getHours() * 60 + now.getMinutes() < Number(alarm[1]) * 60 + Number(alarm[2])) return
  let rangToday = false
  try {
    rangToday = JSON.parse(readFileSync(join(DATA_DIR, 'alarm', 'rang.json'), 'utf8'))?.day === today
  } catch {
    rangToday = false
  }
  const h = Math.floor(sleepData.minutes / 60)
  const m = Math.round(sleepData.minutes % 60)
  const hours = `${h} ${h === 1 ? 'hodinu' : h >= 2 && h <= 4 ? 'hodiny' : 'hodín'}`
  const say = `Ešte k spánku. Hodinky hlásia ${hours}${m ? ` a ${m} ${m === 1 ? 'minútu' : m >= 2 && m <= 4 ? 'minúty' : 'minút'}` : ''}${sleepData.score ? `, skóre ${Math.round(sleepData.score)}` : ''}.`
  const text = describeDay(res.lastNight)
  const listeners = await hudListeners()
  const hush = quietNow(cfg, now) || !rangToday
  if (listeners >= 0) await postHud('/api/announce', { title: 'Spánok z hodiniek', text, say, node: 'spanok', icon: 'moon', silent: hush || listeners === 0 })
  if (!hush && listeners <= 0) {
    const { localVoiceOn, speakLocal } = await import('../hud/server/speak.mjs')
    if (localVoiceOn()) await speakLocal(say)
  }
}

async function sync() {
  const auto = flags.has('auto')
  const days = Number(value('days')) || (auto ? 2 : 14)
  const before = auto ? garminStatus() : null
  const res = await syncGarmin({ days, fixture: value('fixture'), today: value('today'), reason: value('reason') || (auto ? 'auto' : 'manual') })
  if (auto) {
    try {
      await afterAuto(res, before)
    } catch {
      // the announcement is a nicety, the data is already saved
    }
    process.exit(0)
  }
  if (!res.ok) {
    out(res, `${res.message}${res.error === 'not_connected' || res.error === 'needs_login' ? `\n${howToConnect()}` : res.error === 'no_uv' ? ` ${UV_HINT}` : ''}`)
    process.exit(1)
  }
  const lines = [res.message, nightText(res)]
  if (res.partial) lines.push('Garmin ma v polovici pribrzdil, zvyšok dotiahnem pri ďalšej synchronizácii.')
  if (res.kept?.length) lines.push(`Tvoje vlastné hodnoty som nechal tak: ${res.kept.map((k) => `${shortDay(k.day)} (${k.fields.join(', ')})`).join(', ')}.`)
  out(res, lines.join('\n'))
}

// ── logout ──────────────────────────────────────────────────────────────

async function logout() {
  const res = await logoutGarmin()
  out(res, res.removed ? 'Garmin je odpojený: uložené prihlásenie som z tohto počítača zmazal. Čo je už v denníku, ostáva.' : 'Garmin nebol pripojený, nie je čo mazať.')
}

const ACTIONS = { status, login, sync, logout }
if (!ACTIONS[action]) {
  console.error('Použitie: node scripts/garmin.mjs [status|login|sync|logout] [--days 14] [--json]')
  process.exit(1)
}
await ACTIONS[action]()
