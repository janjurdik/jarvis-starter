#!/usr/bin/env node
/**
 * One command from a freshly downloaded folder to Jarvis on the desktop. It prepares the
 * computer, puts Jarvis on screen and steps back: from there the setup is a conversation with
 * Jarvis himself (hud/server/persona.mjs, section Úvodné nastavenie).
 *
 *   node scripts/setup.mjs [--ai claude|codex|antigravity] [--surface desktop|web] [--no-hud] [--json]
 *       1. packages of the HUD (npm install, once)
 *       2. the AI Jarvis runs on: Claude Code, Codex or Antigravity, whichever started this (or is installed)
 *       3. uv, the one helper the voice, Whisper and the video tools share
 *       4. speech: local Whisper chosen for this computer's hardware and free disk space
 *       5. yt-dlp and the default alarm song
 *       6. Jarvis on the desktop, starting with the computer from now on. On a Mac `--surface`
 *          says where: `desktop` (the default, Jarvis as the desktop itself, under the windows)
 *          or `web` (a full-screen browser window). The choice is kept in data/setup.json
 *          (Settings on the desktop write `surface` to config/jarvis.json later, which wins).
 *     Every step is safe to repeat. A step that fails never stops the rest: it is listed at the
 *     end with what to do, and Jarvis works without it in the meantime.
 *
 *   node scripts/setup.mjs status [--json]
 *   node scripts/setup.mjs note [--done sken,oslovenie] [--waiting "…"] [--resolved "…"] [--goal "…"] [--finish]
 *       where the setup conversation stands (data/setup.json). Jarvis writes it himself through his
 *       tool; an agent working in this folder uses these commands.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { INSTALL_HINT, antigravityStatus } from '../hud/server/antigravity.mjs'
import { PROVIDERS, cleanEnv } from '../hud/server/provider.mjs'
import { STEPS, SETUP_FILE, getSetup, noteSetup } from '../hud/server/setup.mjs'
import { DATA_DIR, IS_MAC, IS_WIN, REPO, WIN_POWERSHELL, findBin, hudAlive, parseArgs, sh } from './lib.mjs'

const argv = process.argv.slice(2)
const { flags } = parseArgs(argv)
const json = flags.has('json')
const opt = (name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}
const command = argv.find((a) => !a.startsWith('--') && a !== opt('ai') && a !== opt('surface') && a !== opt('done') && a !== opt('waiting') && a !== opt('resolved') && a !== opt('goal'))

// ── notes about the setup conversation ─────────────────────────────────────

if (command === 'status') {
  const s = getSetup()
  if (json) console.log(JSON.stringify({ ok: true, ...s, steps: STEPS.map((x) => ({ ...x, done: s.hotove.includes(x.id) })) }, null, 2))
  else {
    console.log(s.done ? 'Nastavenie je hotové.' : `Nastavenie beží. Ďalší krok: ${s.next ?? 'ukončiť'}.`)
    for (const x of STEPS) console.log(`  ${s.hotove.includes(x.id) ? '✓' : '·'} ${x.id}: ${x.say}`)
    if (s.ciel) console.log(`Chce: ${s.ciel}`)
    for (const t of s.caka) console.log(`Čaká na používateľa: ${t}`)
  }
  process.exit(0)
}
if (command === 'note') {
  const list = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : undefined)
  const s = await noteSetup({ done: list(opt('done')), waiting: opt('waiting') ? [opt('waiting')] : undefined, resolved: opt('resolved') ? [opt('resolved')] : undefined, goal: opt('goal'), finished: flags.has('finish') ? true : undefined })
  console.log(json ? JSON.stringify({ ok: true, ...s }) : s.done ? 'Nastavenie je uzavreté.' : `Zapísané. Ďalší krok: ${s.next ?? 'ukončiť (--finish)'}.`)
  process.exit(0)
}

// ── the bootstrap ──────────────────────────────────────────────────────────

const todo = []
const done = []
const say = (text) => !json && console.log(text)
const step = (id, ok, text, fix = null) => {
  ;(ok ? done : todo).push({ id, text, ...(fix ? { fix } : {}) })
  say(`${ok ? '✓' : '!'} ${text}${!ok && fix ? `\n  ${fix}` : ''}`)
}

/** Runs one of the prepare scripts and shows its progress on one line (they print JSON lines with --progress). */
function prepare(script, { timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(REPO, 'scripts', script), 'prepare', '--progress'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let last = null
    let buf = ''
    let shown = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (d) => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        try {
          const m = JSON.parse(line)
          last = m
          const text = m.text ? `${m.text}${Number.isFinite(m.pct) ? ` ${Math.round(m.pct)} %` : ''}` : ''
          // One line per change of text, a percentage only every tenth: a log an assistant can read.
          const key = `${m.step}|${m.text}|${Number.isFinite(m.pct) ? Math.floor(m.pct / 10) : ''}`
          if (text && key !== shown && !json) console.log(`  ${text}`)
          shown = key
        } catch {
          // not a progress line
        }
      }
    })
    child.stderr.on('data', () => {})
    child.on('error', () => resolve(null))
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(last)
    })
  })
}

say('\nJ.A.R.V.I.S. · príprava\n')

// 1. packages
if (!existsSync(join(REPO, 'node_modules', 'three', 'package.json'))) {
  say('Inštalujem súčasti obrazovky (raz, asi minútu)…')
  const r = await sh(IS_WIN ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { timeout: 6 * 60_000 })
  step('deps', r.code === 0, r.code === 0 ? 'Súčasti obrazovky sú nainštalované.' : 'Súčasti obrazovky sa nepodarilo nainštalovať.', 'Skús v tomto priečinku: npm install')
} else step('deps', true, 'Súčasti obrazovky sú na mieste.')

// 2. the AI Jarvis runs on
// Antigravity marks every command it runs for the user, so it is recognised even when it forgets to say --ai.
const harness = process.env.ANTIGRAVITY_AGENT || process.env.ANTIGRAVITY_CONVERSATION_ID ? 'antigravity' : ''
const asked = String(opt('ai') ?? process.env.JARVIS_AI ?? harness).toLowerCase()
const ai = PROVIDERS[asked] ?? (PROVIDERS.claude.bin() ? PROVIDERS.claude : PROVIDERS.codex.bin() ? PROVIDERS.codex : PROVIDERS.antigravity.bin() ? PROVIDERS.antigravity : PROVIDERS.claude)
mkdirSync(DATA_DIR, { recursive: true })
{
  // Remembered next to the setup state, so the HUD, the routines and the background jobs all use the same one.
  let raw = {}
  try {
    raw = JSON.parse(readFileSync(SETUP_FILE, 'utf8'))
  } catch {
    raw = {}
  }
  if (raw.ai !== ai.id) writeFileSync(SETUP_FILE, `${JSON.stringify({ ...raw, ai: ai.id }, null, 2)}\n`, { mode: 0o600 })
}
if (!ai.bin()) {
  step('ai', false, `${ai.product} nie je nainštalovaný.`, ai.id === 'antigravity' ? INSTALL_HINT : ai.id === 'codex' ? 'Nainštaluj: npm i -g @openai/codex, potom: codex login' : IS_WIN ? 'PowerShell: irm https://claude.ai/install.ps1 | iex, potom: claude' : 'Terminál: curl -fsSL https://claude.ai/install.sh | bash, potom: claude')
} else if (ai.id === 'claude') {
  const auth = await sh(ai.bin(), ['auth', 'status', '--json'])
  let info = null
  try {
    info = JSON.parse(auth.out.slice(auth.out.indexOf('{'), auth.out.lastIndexOf('}') + 1))
  } catch {
    info = null
  }
  const plan = String(info?.subscriptionType ?? '').toLowerCase()
  if (info?.loggedIn !== true) step('ai', false, 'Claude Code nie je prihlásený.', 'Spusti: claude auth login (v prehliadači klikni Povoliť)')
  else if (plan === 'free') step('ai', false, 'Claude je prihlásený bezplatným účtom. Jarvis potrebuje predplatné Pro alebo Max.', 'claude.ai/upgrade, potom: claude auth login')
  else step('ai', true, `Mozog: Claude (${plan || 'predplatné'}).`)
} else if (ai.id === 'antigravity') {
  // The agent is asked itself (it opens an empty session). The sign-in is its own: Jarvis only says how to start it.
  const cwd = join(DATA_DIR, 'brain', 'antigravity')
  mkdirSync(cwd, { recursive: true })
  const s = await antigravityStatus({ env: cleanEnv(), cwd })
  if (s.loggedIn) step('ai', true, `Mozog: Gemini cez Antigravity${s.tier ? ` (${s.tier})` : ''}.`)
  else if (s.needsLogin) step('ai', false, 'Antigravity nie je prihlásený.', 'Spusti: node scripts/antigravity.mjs login (otvorí sa prehliadač, prihlás sa účtom Google)')
  else step('ai', false, 'Antigravity sa nepodarilo spustiť.', String(s.error ?? '').slice(0, 300) || 'Skús: node scripts/antigravity.mjs status')
} else {
  const auth = await sh(ai.bin(), ['login', 'status'])
  step('ai', auth.code === 0 && /logged in/i.test(auth.out), auth.code === 0 && /logged in/i.test(auth.out) ? 'Mozog: ChatGPT cez Codex.' : 'Codex nie je prihlásený.', 'Spusti: codex login')
}

// 3. uv: one small tool that runs the voice, Whisper, the video tools and Garmin without installing Python by hand
let uv = findBin('uv', { override: process.env.JARVIS_UV_BIN })
if (!uv) {
  say('Inštalujem uv (pomocník pre hlas a video)…')
  // A package manager when there is one (versions it ships are reviewed), the vendor's installer otherwise.
  const brew = IS_MAC ? findBin('brew') : null
  const winget = IS_WIN ? findBin('winget') : null
  let r = { code: 1 }
  if (brew) r = await sh(brew, ['install', 'uv'], { timeout: 8 * 60_000 })
  else if (winget) r = await sh(winget, ['install', '--id', 'astral-sh.uv', '-e', '--accept-source-agreements', '--accept-package-agreements'], { timeout: 8 * 60_000 })
  if (r.code !== 0) {
    r = IS_WIN
      ? await sh(WIN_POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://astral.sh/uv/install.ps1 | iex'], { timeout: 8 * 60_000 })
      : await sh('/bin/sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], { timeout: 8 * 60_000 })
  }
  uv = findBin('uv', { override: process.env.JARVIS_UV_BIN, extraDirs: [join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.local', 'bin'), join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.cargo', 'bin')] })
  step('uv', Boolean(uv), uv ? 'uv je nainštalované.' : 'uv sa nepodarilo nainštalovať. Jarvis bude hovoriť a počúvať horšie, kým ho nedoplníš.', 'Návod: https://docs.astral.sh/uv/getting-started/installation/')
} else step('uv', true, 'uv je na mieste.')

// 4. speech: Whisper for this hardware, downloaded before the window opens
if (uv) {
  say('Pripravujem reč (model sa vyberá podľa výkonu počítača a voľného miesta)…')
  const v = await prepare('voice.mjs', { timeoutMs: 45 * 60_000 })
  if (v?.ok) step('voice', true, v.stt?.engine === 'browser' ? `Reč: tento počítač použije rozpoznávanie v prehliadači. ${(v.notes ?? [])[0] ?? ''}`.trim() : `Reč: Whisper beží v tomto počítači${v.stt?.model ? ` (model ${v.stt.model})` : ''}.`)
  else step('voice', false, 'Lokálny Whisper sa nepodarilo pripraviť. Jarvis zatiaľ počúva cez prehliadač.', 'Skús neskôr: node scripts/voice.mjs prepare')

  // 5. yt-dlp and the song the alarm rings with
  say('Pripravujem video nástroje a skladbu na budík…')
  const m = await prepare('media.mjs', { timeoutMs: 15 * 60_000 })
  step('media', Boolean(m?.ok), m?.ok ? 'Video nástroje sú pripravené a budík má svoju skladbu.' : 'Skladbu na budík sa nepodarilo stiahnuť. Budík zvoní vstavaným zvukom.', 'Skús neskôr: node scripts/media.mjs prepare')
}

// 6. Jarvis on the desktop
const wanted = String(opt('surface') ?? '').toLowerCase()
if (wanted === 'desktop' || wanted === 'web') {
  // Kept next to the setup state (like the AI): a config file would mean "Jarvis is set up", and he is not yet.
  let raw = {}
  try {
    raw = JSON.parse(readFileSync(SETUP_FILE, 'utf8'))
  } catch {
    raw = {}
  }
  if (raw.surface !== wanted) writeFileSync(SETUP_FILE, `${JSON.stringify({ ...raw, surface: wanted }, null, 2)}\n`, { mode: 0o600 })
}
if (!flags.has('no-hud')) {
  say('Štartujem Jarvisa na ploche…')
  const r = await sh(process.execPath, [join(REPO, 'scripts', 'hud.mjs'), '--no-prepare'], { timeout: 90_000 })
  const where = /appka Jarvis HUD na ploche/.test(r.out) ? 'Jarvis je na ploche (pod oknami, namiesto tapety).' : 'Jarvis beží v okne na celú obrazovku.'
  step('hud', await hudAlive(), (await hudAlive()) ? where : 'Obrazovku Jarvisa sa nepodarilo spustiť.', r.out.split('\n').slice(-2).join(' ') || 'Skús: node scripts/hud.mjs')
  // The desktop was asked for and this Mac could not build the app: say what to do, Jarvis runs in a window meanwhile.
  if (IS_MAC && wanted !== 'web' && /xcode-select --install/.test(r.out)) step('desktop', false, 'Na plochu ma zatiaľ neviem položiť, bežím v okne.', 'Spusti: xcode-select --install, potom: node scripts/hud.mjs')
}

const setup = getSetup()
if (json) console.log(JSON.stringify({ ok: todo.every((t) => !['deps', 'hud'].includes(t.id)), ai: ai.id, done, todo, hud: await hudAlive(), setup }, null, 2))
else {
  console.log('')
  if (todo.length) console.log(`Ešte treba doriešiť (Jarvis funguje aj bez toho, len slabšie):\n${todo.map((t) => `  · ${t.text}${t.fix ? ` ${t.fix}` : ''}`).join('\n')}\n`)
  if (flags.has('no-hud')) console.log('Príprava je hotová. Jarvisa na plochu položí: node scripts/hud.mjs')
  else console.log(setup.done ? 'Jarvis beží. Stačí mu povedať, čo potrebuješ.' : 'Jarvis je na ploche a čaká na teba. Odteraz hovor s ním: zvyšok nastavenia vedie on.')
}
process.exit(todo.some((t) => ['deps', 'hud'].includes(t.id)) ? 1 : 0)
