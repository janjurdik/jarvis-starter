#!/usr/bin/env node
/**
 * The activity log from the command line: what Jarvis recorded about a day at the computer.
 * The log itself is written by the HUD (every minute) and by the pulse; see docs/AKTIVITA.md.
 *
 *   node scripts/activity.mjs status            is it on, how much is stored, what is in front right now
 *   node scripts/activity.mjs today [--json]    today in numbers: apps, kinds of work, sessions, games, breaks, commits, files
 *   node scripts/activity.mjs yesterday [--json]
 *   node scripts/activity.mjs day 2026-11-16 [--json]
 *   node scripts/activity.mjs off | on          stop or start recording (config/jarvis.json, activity.enabled)
 *   node scripts/activity.mjs purge all         delete everything recorded
 *   node scripts/activity.mjs purge 2026-11-16  delete one day
 *   node scripts/activity.mjs purge --older 30  delete days older than 30 days
 *   node scripts/activity.mjs games [--json]    games found on this computer (all launchers), with playtime where known
 *   node scripts/activity.mjs sample [--dry-run]  take one sample now (what the pulse does)
 */
// .env first: the modules below read JARVIS_MEMORY_DIR and JARVIS_DATA_DIR when they load.
import '../hud/server/env.mjs'
import { activityConfig, activityDays, activityStatus, buildRecord, gameIndex, probe, purge, refreshGameIndex, sampleOnce, setActivityEnabled } from '../hud/server/activity.mjs'
import { dayReport } from '../hud/server/activity-report.mjs'
import { addDays, isoDay } from '../hud/server/util.mjs'
import { parseArgs } from './lib.mjs'

const { flags, rest } = parseArgs()
const json = flags.has('json')
const cmd = rest[0] ?? 'status'
const print = (data, text) => console.log(json ? JSON.stringify(data, null, 2) : text)
const WHY = { env: 'premenná JARVIS_ACTIVITY=0', setup: 'Jarvis ešte nie je nastavený, pred nastavením sa nič nezaznamenáva', config: 'activity.enabled je v config/jarvis.json false', unsupported: 'tento systém neviem prečítať' }
const STATE = { active: 'aktívny', passive: 'bez vstupu, ale niečo beží (film, hovor, hra)', idle: 'bez vstupu', locked: 'zamknutá obrazovka' }
const size = (bytes) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`)

async function status() {
  const s = activityStatus()
  const cfg = activityConfig()
  // one look without writing anything: proves the system can be read and shows exactly what a sample holds
  const p = cfg.enabled ? await probe(cfg, { once: true }) : null
  const now = p ? buildRecord(p, cfg, { source: 'hud' }) : null
  const data = { ok: true, ...s, readable: cfg.enabled ? Boolean(p) : null, now }
  const lines = [
    `Záznam aktivity: ${s.enabled ? 'zapnutý' : `vypnutý (${WHY[s.reason] ?? s.reason})`}`,
    `Uložené: ${s.days ? `${s.days} ${s.days === 1 ? 'deň' : s.days < 5 ? 'dni' : 'dní'} (${s.firstDay} až ${s.lastDay}), ${size(s.bytes)}` : 'zatiaľ nič'} v ${s.dir}`,
    `Uchovávam ${s.retentionDays} dní. Bez vstupu ${s.idleMinutes} minút sa počíta ako prestávka. Názvy okien: ${s.titles ? 'zapnuté (len prehliadače a editory, len na Windows)' : 'vypnuté'}.`,
    `Súkromné appky (nezapisujem ich názov): správcovia hesiel${s.ignore.length ? ` a ${s.ignore.join(', ')}` : ''}.`,
    s.lastSample ? `Posledná vzorka: ${new Date(s.lastSample.at).toLocaleString('sv-SE').slice(0, 16)} (${s.lastSample.src === 'hud' ? 'HUD' : 'pulz'}).` : 'Posledná vzorka: žiadna.',
    `Hry, ktoré viem spoznať podľa priečinka: ${s.games}.`,
  ]
  if (cfg.enabled) lines.push(now ? `Práve teraz: ${now.priv ? 'súkromná appka' : (now.game ?? now.app ?? 'nič v popredí')}, ${STATE[now.st]}, posledný vstup pred ${now.idle} s.` : `Práve teraz: neviem prečítať (${process.platform === 'win32' ? 'tento proces nebeží v prihlásenej relácii s plochou' : process.platform === 'darwin' ? 'systémové nástroje lsappinfo a ioreg neodpovedali' : 'na Linuxe treba X11 s nástrojmi xdotool a xprintidle'}).`)
  print(data, lines.join('\n'))
}

async function report(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) {
    console.error('Deň zadaj ako RRRR-MM-DD, napríklad: node scripts/activity.mjs day 2026-11-16')
    process.exit(1)
  }
  const r = await dayReport(day, { signals: 'full' })
  print(r, r.summary)
}

function toggle(on) {
  const res = setActivityEnabled(on)
  if (!res.ok) return print({ ok: false, reason: res.reason }, 'Jarvis ešte nie je nastavený (chýba config/jarvis.json). Pred nastavením sa aktivita nezaznamenáva.')
  print({ ok: true, enabled: on }, on ? 'Záznam aktivity je zapnutý. HUD začne zapisovať do minúty.' : 'Záznam aktivity je vypnutý. Čo je už uložené, ostáva; zmažeš to príkazom: node scripts/activity.mjs purge all')
}

function doPurge() {
  const days = activityDays()
  const target = rest[1]
  const older = [...process.argv].find((a, i, all) => all[i - 1] === '--older')
  let removed = null
  if (target === 'all') removed = purge({ all: true })
  else if (/^\d{4}-\d{2}-\d{2}$/.test(target ?? '')) removed = purge({ day: target })
  else if (flags.has('older') && Number(older) >= 0 && older !== undefined) removed = purge({ before: addDays(isoDay(), -Math.round(Number(older))) })
  if (removed === null) {
    return print({ ok: false, days: days.length }, `Uložených dní: ${days.length}. Povedz, čo zmazať:\n  node scripts/activity.mjs purge all          všetko\n  node scripts/activity.mjs purge RRRR-MM-DD   jeden deň\n  node scripts/activity.mjs purge --older 30   dni staršie ako 30 dní`)
  }
  print({ ok: true, removed }, removed.length ? `Zmazané dni záznamu aktivity: ${removed.length} (${removed[0]}${removed.length > 1 ? ` až ${removed[removed.length - 1]}` : ''}).` : 'Nebolo čo zmazať.')
}

async function games() {
  const { LAUNCHER_NAMES, detectGames } = await import('./scan/launchers.mjs')
  const res = await detectGames()
  await refreshGameIndex({ force: true }).catch(() => {})
  const hours = (m) => (m >= 60 ? `${Math.round(m / 60)} h` : `${m} min`)
  const lines = [`Hry v tomto počítači: ${res.games.length} (${res.launchers.map((l) => `${l.name} ${l.games}`).join(', ') || 'žiadny herný obchod'}).`]
  for (const g of res.games) lines.push(`  ${g.name}  [${LAUNCHER_NAMES[g.launcher] ?? g.launcher}${g.installed ? '' : ', nenainštalované'}]${g.playtimeMin ? `  ${hours(g.playtimeMin)}` : ''}${g.lastPlayed ? `  naposledy ${g.lastPlayed.slice(0, 10)}${g.approx ? ' (odhad)' : ''}` : ''}`)
  for (const e of res.errors) lines.push(`  ! ${LAUNCHER_NAMES[e.launcher] ?? e.launcher}: ${e.error}`)
  lines.push('Odohraný čas si v počítači ukladajú len Steam, GOG Galaxy, itch, Heroic, Prism Launcher a Modrinth. Pri ostatných ho meria až záznam aktivity.')
  print({ ok: true, ...res, matchable: gameIndex().length }, lines.join('\n'))
}

async function sample() {
  const res = await sampleOnce({ source: 'pulse', every: 300, write: !flags.has('dry-run') })
  print(res, res.ok ? `${flags.has('dry-run') ? 'Vzorka (nezapísaná)' : res.written ? 'Zapísaná vzorka' : 'Vzorka preskočená (HUD práve zapisuje)'}: ${JSON.stringify(res.record)}` : `Vzorka sa nezobrala: ${WHY[res.reason] ?? res.reason}${res.error ? ` (${res.error})` : ''}`)
}

try {
  if (cmd === 'status') await status()
  else if (cmd === 'today' || cmd === 'dnes') await report(isoDay())
  else if (cmd === 'yesterday' || cmd === 'vcera') await report(addDays(isoDay(), -1))
  else if (cmd === 'day' || cmd === 'den') await report(rest[1])
  else if (cmd === 'on' || cmd === 'off') toggle(cmd === 'on')
  else if (cmd === 'purge') doPurge()
  else if (cmd === 'games' || cmd === 'hry') await games()
  else if (cmd === 'sample') await sample()
  else {
    console.error(`Neznámy príkaz „${cmd}". Poznám: status, today, yesterday, day RRRR-MM-DD, on, off, purge, games, sample. Všetko má aj --json.`)
    process.exit(1)
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  if (json) console.log(JSON.stringify({ ok: false, error: message }))
  else console.error(`Nepodarilo sa: ${message}`)
  process.exit(1)
}
// the report may leave timers of file walks behind; everything is printed, so leave
process.stdout.write('', () => process.exit(0))
