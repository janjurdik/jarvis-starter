#!/usr/bin/env node
/**
 * Registers Jarvis's routines in the system scheduler, so they run on their own:
 * launchd agents on macOS, Task Scheduler on Windows. Times come from config/jarvis.json.
 *
 *   npm run schedule -- install            register (or update) all enabled routines
 *   npm run schedule -- install --dry-run  only show what would be registered
 *   npm run schedule -- status             what is registered now
 *   npm run schedule -- remove             remove everything Jarvis registered
 *
 * A routine that was missed because the computer slept runs after it wakes up. The alarm
 * (scripts/alarm.mjs) is registered here too: its brief a few minutes ahead and the ring itself.
 * On Windows both wake the computer from sleep; on macOS the pulse keeps the Mac awake instead.
 *
 * After `install`, the pulse is started once through the scheduler to prove that the system really
 * runs Jarvis (macOS may keep it out of Downloads, Desktop and Documents).
 */
// .env first: the modules below read JARVIS_MEMORY_DIR and JARVIS_DATA_DIR when they load.
import '../hud/server/env.mjs'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { prepareSlot } from '../hud/server/alarm.mjs'
import { getConfig } from '../hud/server/config.mjs'
import { DATA_DIR, IS_MAC, IS_WIN, LABEL, LOG_DIR, REPO, TASK_FOLDER, has, parseArgs, sh } from './lib.mjs'

const { flags, rest } = parseArgs()
const action = rest[0] ?? 'status'
// JARVIS_SCHEDULE_DRY=1: never touch the system scheduler (development and tests on a machine that runs its own Jarvis).
const dry = flags.has('dry-run') || process.env.JARVIS_SCHEDULE_DRY === '1'
const NODE = process.execPath
const SCRIPT = join(REPO, 'scripts', 'routine.mjs')
const PULSE = join(REPO, 'scripts', 'pulse.mjs')
const ALARM = join(REPO, 'scripts', 'alarm.mjs')
/** What the scheduler starts: a routine goes through routine.mjs, the pulse and the alarm are their own scripts. */
const command = (job) => (job.script ? [job.script, ...(job.args ?? [])] : [SCRIPT, job.id])
/** "07:30 (daily)" or "každých 5 min". */
const when = (job) => (job.every ? `každých ${job.every} min` : `${job.time} (${job.days})`)
const AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents')
const PREFIX = `${LABEL}.routine.`

const WD = { ne: 0, po: 1, ut: 2, st: 3, 'št': 4, stv: 4, pi: 5, so: 6, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
/** "daily" → null (every day), otherwise the list of weekdays (0 = Sunday). */
function weekdays(days) {
  const rule = String(days ?? 'daily').toLowerCase().trim()
  if (rule === 'daily' || rule === 'denne') return null
  if (rule === 'weekdays' || rule === 'po-pi') return [1, 2, 3, 4, 5]
  if (rule === 'weekend' || rule === 'vikend') return [6, 0]
  const list = rule.split(/[\s,]+/).map((t) => WD[t]).filter((n) => n !== undefined)
  return list.length ? [...new Set(list)] : null
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ── macOS: launchd ─────────────────────────────────────────────────────

function plist(routine) {
  const [hour, minute] = String(routine.time ?? '08:00').split(':').map(Number)
  const wd = weekdays(routine.days)
  const slot = (day) => `    <dict>${day === null ? '' : `<key>Weekday</key><integer>${day}</integer>`}<key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`
  const path = [dirname(NODE), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(PREFIX + routine.id)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(NODE)}</string>
${command(routine).map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(REPO)}</string>
${routine.every ? `  <key>StartInterval</key><integer>${routine.every * 60}</integer>` : `  <key>StartCalendarInterval</key>
  <array>
${(wd ?? [null]).map(slot).join('\n')}
  </array>`}
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(join(LOG_DIR, `routine-${routine.id}.out.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(join(LOG_DIR, `routine-${routine.id}.out.log`))}</string>
</dict>
</plist>
`
}

const macInstalled = () => {
  try {
    return readdirSync(AGENTS_DIR).filter((n) => n.startsWith(PREFIX) && n.endsWith('.plist')).map((n) => n.slice(0, -6))
  } catch {
    return []
  }
}
const domain = () => `gui/${userInfo().uid}`

async function macRemove(label) {
  await sh('/bin/launchctl', ['bootout', `${domain()}/${label}`])
  rmSync(join(AGENTS_DIR, `${label}.plist`), { force: true })
}

async function macInstall(routines) {
  for (const label of macInstalled()) if (!routines.some((r) => PREFIX + r.id === label)) await macRemove(label)
  mkdirSync(AGENTS_DIR, { recursive: true })
  mkdirSync(LOG_DIR, { recursive: true })
  for (const r of routines) {
    const label = PREFIX + r.id
    const file = join(AGENTS_DIR, `${label}.plist`)
    await sh('/bin/launchctl', ['bootout', `${domain()}/${label}`])
    writeFileSync(file, plist(r))
    const res = await sh('/bin/launchctl', ['bootstrap', domain(), file])
    console.log(res.code === 0 ? `  ✓ ${r.title}: ${when(r)}` : `  ✗ ${r.title}: ${res.out}`)
  }
}

// ── Windows: Task Scheduler ────────────────────────────────────────────

const PS_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`

function winScript(routine) {
  const wd = weekdays(routine.days)
  const trigger = routine.every
    ? `New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes ${routine.every}) -RepetitionDuration (New-TimeSpan -Days 3650)`
    : wd ? `New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${wd.map((d) => PS_DAYS[d]).join(',')} -At ${psq(routine.time)}` : `New-ScheduledTaskTrigger -Daily -At ${psq(routine.time)}`
  // wscript + run-hidden.vbs: no console window pops up when the routine starts.
  const argument = `"${join(REPO, 'scripts', 'run-hidden.vbs')}" "${NODE}" ${command(routine).map((a) => `"${a}"`).join(' ')}`
  return [
    `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${psq(argument)} -WorkingDirectory ${psq(REPO)}`,
    `$trigger = ${trigger}`,
    // The alarm wakes the computer from sleep (when wake timers are allowed in the power plan, the default on AC power).
    `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)${routine.wake ? ' -WakeToRun' : ''}`,
    `Register-ScheduledTask -TaskName ${psq(routine.id)} -TaskPath ${psq(`\\${TASK_FOLDER}\\`)} -Action $action -Trigger $trigger -Settings $settings -Description ${psq(`Jarvis: ${routine.title}`)} -Force | Out-Null`,
  ].join('\n')
}

const ps = (script) => sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { input: script, timeout: 60_000 })

async function winInstalled() {
  const res = await ps(`Get-ScheduledTask -TaskPath ${psq(`\\${TASK_FOLDER}\\`)} -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName }`)
  return res.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
}

async function winInstall(routines) {
  for (const name of await winInstalled()) if (!routines.some((r) => r.id === name)) await ps(`Unregister-ScheduledTask -TaskName ${psq(name)} -TaskPath ${psq(`\\${TASK_FOLDER}\\`)} -Confirm:$false`)
  for (const r of routines) {
    const res = await ps(winScript(r))
    console.log(res.code === 0 ? `  ✓ ${r.title}: ${when(r)}` : `  ✗ ${r.title}: ${res.out}`)
  }
}

// ── proof that the scheduler really runs Jarvis ────────────────────────

/**
 * Starts the pulse once through the system scheduler and waits for its heartbeat. When it does
 * not come, the system did not let the scheduled job run: on macOS typically because the folder
 * is in Downloads, Desktop or Documents.
 */
async function selfTest() {
  const file = join(DATA_DIR, 'pulse', 'heartbeat')
  const before = (() => {
    try {
      return statSync(file).mtimeMs
    } catch {
      return 0
    }
  })()
  const started = IS_MAC ? await sh('/bin/launchctl', ['kickstart', `${domain()}/${PREFIX}pulz`]) : await ps(`Start-ScheduledTask -TaskName 'pulz' -TaskPath ${psq(`\\${TASK_FOLDER}\\`)}`)
  if (started.code !== 0) return console.log(`  · Skúšobné spustenie pulzu sa nepodarilo (${started.out.slice(0, 120)}). Over: node scripts/schedule.mjs status`)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      if (statSync(file).mtimeMs > before) return console.log('  ✓ Overené: systém Jarvisa naozaj spúšťa.')
    } catch {
      // not yet
    }
  }
  console.log('  ✗ Systém úlohu spustil, ale Jarvis sa neozval do 15 sekúnd.')
  if (IS_MAC && /\/(Downloads|Desktop|Documents)\//.test(`${REPO}/`)) console.log(`    macOS pravdepodobne nepustil rutiny do priečinka ${REPO}. Presuň Jarvisa do domovského priečinka (napríklad ~/Jarvis) a spusti install znova.`)
  else console.log(`    Pozri ${join(LOG_DIR, 'routine-pulz.out.log')}.`)
}

// ── main ───────────────────────────────────────────────────────────────

if (!IS_MAC && !IS_WIN) {
  console.error('Plánovanie je pripravené pre macOS a Windows. Na Linuxe použi cron: node scripts/routine.mjs <id>')
  process.exit(1)
}

const cfg = getConfig()
/**
 * The pulse is always part of the schedule (unless turned off in the config): every few minutes a
 * tiny script without Claude checks reminders, the calendar and deadlines and speaks up when due.
 */
const pulse = cfg.pulse?.enabled === false ? [] : [{ id: 'pulz', title: 'Pulz (pripomienky, kalendár, termíny)', every: cfg.pulse.every, script: PULSE, enabled: true }]
/** The alarm: Claude prepares the brief a few minutes ahead (routine budik), then the ring itself. */
const alarm = cfg.alarm
  ? [
      { id: 'budik-priprava', title: 'Budík: príprava briefu', ...prepareSlot(cfg.alarm), script: SCRIPT, args: ['budik', '--prepare'], enabled: cfg.alarm.enabled, wake: true },
      { id: 'budik', title: 'Budík', time: cfg.alarm.time, days: cfg.alarm.days, script: ALARM, args: ['ring'], enabled: cfg.alarm.enabled, wake: true },
    ]
  : []
const all = [...cfg.routines.filter((r) => r.id !== 'budik' && r.id !== 'budik-priprava'), ...alarm, ...pulse]
const routines = all.filter((r) => r.enabled)

if (action === 'install') {
  const missing = routines.filter((r) => !r.script && !has(join(REPO, 'routines', `${r.id}.md`)))
  for (const r of missing) console.log(`  · ${r.title}: chýba routines/${r.id}.md, preskakujem`)
  const ready = routines.filter((r) => !missing.includes(r))
  if (!ready.length) {
    console.log('V config/jarvis.json nie je zapnutá žiadna rutina.')
    process.exit(0)
  }
  if (dry) {
    console.log(`Nič nezapisujem (--dry-run). Zaregistroval by som ${ready.length} rutín:\n`)
    for (const r of ready) console.log(IS_MAC ? `# ${join(AGENTS_DIR, `${PREFIX}${r.id}.plist`)}\n${plist(r)}` : `# ${r.id}\n${winScript(r)}\n`)
    process.exit(0)
  }
  console.log('Registrujem rutiny v systéme:')
  if (IS_MAC) await macInstall(ready)
  else await winInstall(ready)
  if (ready.some((r) => r.id === 'pulz') && !flags.has('no-test')) await selfTest()
  console.log('\nHotovo. Rutiny pobežia samy, aj keď je Claude zatvorený. Počítač musí byť zapnutý a ty prihlásený.')
} else if (action === 'remove') {
  const list = IS_MAC ? macInstalled() : await winInstalled()
  if (dry) console.log(`Odstránil by som: ${list.join(', ') || 'nič'}`)
  else {
    for (const name of list) {
      if (IS_MAC) await macRemove(name)
      else await ps(`Unregister-ScheduledTask -TaskName ${psq(name)} -TaskPath ${psq(`\\${TASK_FOLDER}\\`)} -Confirm:$false`)
    }
    console.log(list.length ? `Odstránené: ${list.join(', ')}` : 'Nič nebolo zaregistrované.')
  }
} else {
  const list = IS_MAC ? macInstalled().map((l) => l.slice(PREFIX.length)) : await winInstalled()
  console.log('Rutiny v config/jarvis.json:')
  for (const r of all) console.log(`  ${r.enabled ? '●' : '○'} ${r.id.padEnd(20)} ${when(r).padEnd(18)} ${list.includes(r.id) ? 'v systéme' : 'nezaregistrovaná'}`)
  const stray = list.filter((n) => !all.some((r) => r.id === n))
  if (stray.length) console.log(`\nV systéme navyše: ${stray.join(', ')} (odstráni ich: npm run schedule -- install)`)
}
