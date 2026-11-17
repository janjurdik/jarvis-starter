#!/usr/bin/env node
/**
 * Checks everything Jarvis needs on this computer and says what is missing.
 *
 *   npm run doctor            readable checklist
 *   npm run doctor -- --json  machine readable (the onboarding uses this)
 *
 * Works before `npm install` too: it only uses Node built-ins and files from this repo.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { DATA_DIR, IS_MAC, IS_WIN, LABEL, PORT, REPO, TASK_FOLDER, findBin, has, hudAlive, parseArgs, sh } from './lib.mjs'
import { aiProvider } from '../hud/server/provider.mjs'
import { prepareNeeded, prepareRunning, sttSummary } from '../hud/server/stt-plan.mjs'

const { flags } = parseArgs()
const checks = []
const add = (id, ok, label, detail = '', fix = '') => checks.push({ id, ok, label, detail, fix })

// ── system ──
const osName = IS_MAC ? 'macOS' : IS_WIN ? 'Windows' : process.platform
add('os', IS_MAC || IS_WIN, 'Operačný systém', `${osName} (${process.arch})`, 'Jarvis je pripravený pre macOS a Windows.')

const nodeMajor = Number(process.versions.node.split('.')[0])
add('node', nodeMajor >= 20, 'Node.js 20 alebo novší', `v${process.versions.node}`, IS_WIN ? 'winget install OpenJS.NodeJS.LTS' : 'brew install node (alebo inštalátor z nodejs.org)')

add('deps', has(join(REPO, 'node_modules', 'three', 'package.json')) && has(join(REPO, 'node_modules', 'ws', 'package.json')), 'Balíčky HUD (npm install)', '', 'npm install')

// ── the AI Jarvis runs on: Claude Code or Codex (hud/server/provider.mjs) ──
const ai = aiProvider()
let login = null
if (ai.id === 'codex') {
  const codex = ai.bin()
  if (codex) {
    const ver = await sh(codex, ['--version'])
    add('claude', ver.code === 0, 'Codex CLI (ChatGPT)', ver.out.split('\n')[0] || codex, '')
    const auth = await sh(codex, ['login', 'status'])
    const ok = auth.code === 0 && /logged in/i.test(auth.out)
    login = { loggedIn: ok, subscriptionType: ok ? 'chatgpt' : null }
    add('claude-login', ok, 'Prihlásenie do ChatGPT', ok ? auth.out.split('\n')[0] : 'neprihlásený', 'Spusti: codex login  (v prehliadači sa prihlás účtom ChatGPT s predplatným Plus alebo Pro).')
  } else add('claude', false, 'Codex CLI (ChatGPT)', 'nenašiel sa', 'npm i -g @openai/codex, potom: codex login')
} else {
  const claude = ai.bin()
  if (claude) {
    const ver = await sh(claude, ['--version'])
    add('claude', ver.code === 0, 'Claude Code CLI', ver.out.split('\n')[0] || claude, '')
    const auth = await sh(claude, ['auth', 'status', '--json'])
    try {
      login = JSON.parse(auth.out)
    } catch {
      login = null
    }
    // Jarvis runs on the Claude subscription (Pro or Max). A Console login works too, but every run is paid per use.
    const plan = String(login?.subscriptionType ?? '').toLowerCase()
    const consoleLogin = login?.authMethod === 'console' || login?.apiKeySource
    const loginDetail = !login?.loggedIn ? 'neprihlásený' : plan === 'free' ? 'bezplatný účet: Jarvis potrebuje predplatné Pro alebo Max' : consoleLogin && !plan ? 'prihlásený cez Anthropic Console: každé použitie sa platí z kreditu, nie z predplatného' : `predplatné ${login.subscriptionType ?? 'neznáme'}`
    add('claude-login', login?.loggedIn === true && plan !== 'free', 'Prihlásenie do Claude', loginDetail, plan === 'free' ? 'Predplatné Pro alebo Max: claude.ai/upgrade, potom znova: claude auth login' : 'Spusti: claude auth login  (otvorí sa prehliadač, klikni Povoliť). Ak nejde, v Termináli napíš claude a prihlás sa.')
  } else {
    add('claude', false, 'Claude Code CLI', 'nenašiel sa', IS_WIN ? 'PowerShell: irm https://claude.ai/install.ps1 | iex' : 'Terminál: curl -fsSL https://claude.ai/install.sh | bash')
  }
}

const git = findBin('git')
add('git', Boolean(git), 'Git (voliteľné, na aktualizácie)', git ? '' : 'nenašiel sa', IS_WIN ? 'winget install Git.Git' : 'xcode-select --install')

// ── voice ──
const uv = findBin('uv', { override: process.env.UV_BIN })
add('uv', Boolean(uv), 'uv (hlas Jarvisa)', uv ? '' : 'nenašiel sa: Jarvis bude hovoriť hlasom prehliadača', IS_WIN ? 'PowerShell: irm https://astral.sh/uv/install.ps1 | iex' : 'Terminál: curl -LsSf https://astral.sh/uv/install.sh | sh')

// Speech recognition: which engine and model this computer gets and why (hud/server/stt-plan.mjs).
const stt = sttSummary()
const sttLocal = stt.engine === 'mlx' || stt.engine === 'faster'
const sttWaiting = prepareNeeded()
const sttName = sttLocal ? `lokálny Whisper ${stt.model}${stt.sizeMb ? ` (${(stt.sizeMb / 1000).toFixed(1).replace('.', ',')} GB)` : ''}` : stt.engine === 'off' ? 'vypnuté' : 'v prehliadači'
add(
  'stt',
  stt.status === 'ready' || !sttWaiting,
  'Rozpoznávanie reči',
  `${sttName}${stt.status === 'ready' ? '' : sttLocal ? (prepareRunning() ? ', práve sa pripravuje' : ', ešte nie je stiahnuté') : ''}: ${stt.reason}`,
  sttWaiting ? 'node scripts/voice.mjs prepare' : '',
)

// ── setup ──
const configFile = process.env.JARVIS_CONFIG || join(REPO, 'config', 'jarvis.json')
let config = null
try {
  config = JSON.parse(readFileSync(configFile, 'utf8'))
} catch {
  config = null
}
add('config', Boolean(config?.name), 'Nastavenie (config/jarvis.json)', config?.name ? `meno: ${config.name}, mesto: ${config.city ?? '?'}` : 'ešte nie je', 'Jarvis ťa nastavením prevedie na ploche: node scripts/setup.mjs')

const memoryDir = process.env.JARVIS_MEMORY_DIR || join(REPO, 'memory')
let notes = 0
const walk = (dir, depth = 0) => {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory() && depth < 6) walk(join(dir, e.name), depth + 1)
    else if (e.isFile() && e.name.endsWith('.md') && e.name.toLowerCase() !== 'readme.md') notes++
  }
}
walk(memoryDir)
add('memory', has(join(memoryDir, 'ja.md')), 'Pamäť (memory/ja.md)', `${notes} poznámok v ${memoryDir}`, 'Jarvis ťa nastavením prevedie na ploche: node scripts/setup.mjs')

// ── location ──
if (IS_MAC) {
  const home = homedir()
  const risky = ['Downloads', 'Desktop', 'Documents'].find((d) => REPO.startsWith(join(home, d) + sep) || REPO === join(home, d))
  add('location', !risky, 'Umiestnenie priečinka', REPO, risky ? `Priečinok je v ${risky}. Rutiny na pozadí tam macOS nepustí bez povolenia. Odporúčam ho presunúť do ${join(home, 'Jarvis')}.` : '')
}

// ── running pieces ──
const alive = await hudAlive()
add('hud', alive, 'HUD server beží', alive ? `http://localhost:${PORT}` : 'nebeží', 'npm run hud')

let scheduled = []
if (IS_MAC) {
  const dir = join(homedir(), 'Library', 'LaunchAgents')
  try {
    scheduled = readdirSync(dir).filter((n) => n.startsWith(`${LABEL}.`)).map((n) => n.replace(/\.plist$/, ''))
  } catch {
    scheduled = []
  }
} else if (IS_WIN) {
  const res = await sh('schtasks.exe', ['/Query', '/FO', 'CSV', '/NH'])
  scheduled = res.out.split(/\r?\n/).map((l) => l.split('","')[0].replace(/^"/, '')).filter((n) => n.startsWith(`\\${TASK_FOLDER}\\`))
}
add('schedule', scheduled.length > 0, 'Rutiny naplánované v systéme', scheduled.length ? scheduled.join(', ') : 'zatiaľ nie', 'npm run schedule -- install')

// ── alarm ──
const alarm = config?.alarm && typeof config.alarm === 'object' ? config.alarm : null
const alarmOn = Boolean(alarm?.time) && alarm.enabled !== false
const alarmIn = scheduled.some((n) => /(^|[.\\])budik$/.test(n))
add('alarm', alarmOn && alarmIn, 'Budík', alarmOn ? `${alarm.time} (${alarm.days ?? 'daily'})${alarmIn ? '' : ', ešte nie je v systéme'}` : 'nenastavený', alarmOn ? 'node scripts/schedule.mjs install' : 'Povedz Jarvisovi: zobuď ma o 6:30  (alebo node scripts/alarm.mjs set 06:30)')

let dataOk = true
try {
  dataOk = !has(DATA_DIR) || statSync(DATA_DIR).isDirectory()
} catch {
  dataOk = false
}

const required = ['os', 'node', 'deps', 'claude', 'claude-login']
const ready = checks.filter((c) => required.includes(c.id)).every((c) => c.ok) && dataOk

if (flags.has('json')) {
  const sttOut = { choice: stt.choice, engine: stt.engine, model: stt.model, sizeMb: stt.sizeMb, device: stt.device, status: stt.status, reason: stt.reason, notes: stt.notes, specs: stt.specs }
  console.log(JSON.stringify({ ready, platform: process.platform, arch: process.arch, repo: REPO, port: PORT, subscription: login?.subscriptionType ?? null, stt: sttOut, checks }, null, 2))
} else {
  console.log('\n  Jarvis: kontrola počítača\n')
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : required.includes(c.id) ? '✗' : '·'} ${c.label}${c.detail ? `  (${c.detail})` : ''}`)
    if (!c.ok && c.fix) console.log(`      → ${c.fix}`)
  }
  console.log(`\n  ${ready ? 'Základ je pripravený.' : 'Niečo dôležité chýba (riadky s ✗).'} Riadky s bodkou sú voliteľné.\n`)
}
process.exit(ready ? 0 : 1)
