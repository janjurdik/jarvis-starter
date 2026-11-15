#!/usr/bin/env node
/**
 * Runs one Jarvis routine without anyone at the keyboard: a headless Claude Code run in this
 * folder with the prompt from routines/<id>.md. The result is saved into memory/schranka,
 * shown and spoken in the HUD (when it is open) and sent as a system notification.
 *
 *   npm run routine -- ranny-brief            run now
 *   npm run routine -- ranny-brief --mock     no Claude, sample text (tests the whole delivery path)
 *   npm run routine -- ranny-brief --silent   do not speak, do not notify
 *   npm run routine -- --list                 routines from config/jarvis.json
 *
 * The system scheduler (launchd on macOS, Task Scheduler on Windows) calls this script,
 * see scripts/schedule.mjs.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_BIN, MEMORY_EXTERNAL, cleanEnv, modelArgs, permissionArgs } from '../hud/server/agent.mjs'
import { readDay } from '../hud/server/chatlog.mjs'
import { getConfig } from '../hud/server/config.mjs'
import { FOLDERS, MEMORY_DIR, parseFrontmatter } from '../hud/server/memory/index.mjs'
import { DOW_LONG, isoDay } from '../hud/server/util.mjs'
import { callReady } from '../hud/server/call.mjs'
import { DATA_DIR, LOG_DIR, REPO, callOut, hudAlive, inWindow, notify, parseArgs, postHud, spawnBin } from './lib.mjs'

const { flags, rest } = parseArgs()
const cfg = getConfig()

if (flags.has('list') || !rest[0]) {
  console.log('Rutiny (config/jarvis.json):')
  for (const r of cfg.routines) console.log(`  ${r.enabled ? '●' : '○'} ${r.id.padEnd(20)} ${r.time}  ${r.days}  ${r.title}`)
  console.log('\nSpustenie: npm run routine -- <id>')
  process.exit(rest[0] ? 0 : flags.has('list') ? 0 : 1)
}

const id = rest[0]
if (!/^[a-z0-9-]+$/.test(id)) {
  console.error('Názov rutiny smie obsahovať len malé písmená, číslice a pomlčku.')
  process.exit(1)
}
const promptFile = join(REPO, 'routines', `${id}.md`)
let source
try {
  source = readFileSync(promptFile, 'utf8')
} catch {
  console.error(`Rutina ${id} nemá zadanie: chýba súbor routines/${id}.md`)
  process.exit(1)
}

mkdirSync(LOG_DIR, { recursive: true })
const logFile = join(LOG_DIR, `routine-${id}.log`)
const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`
  appendFileSync(logFile, line + '\n')
  if (process.stdout.isTTY) console.log(msg)
}

// One run of a routine at a time (a wake-up after sleep can fire the scheduler twice).
const lockFile = join(DATA_DIR, `routine-${id}.lock`)
try {
  if (Date.now() - statSync(lockFile).mtimeMs < 30 * 60_000) {
    log('rutina už beží, končím')
    process.exit(0)
  }
} catch {
  // no lock
}
mkdirSync(DATA_DIR, { recursive: true })
writeFileSync(lockFile, String(process.pid))
const unlock = () => rmSync(lockFile, { force: true })
process.on('exit', unlock)

const { fm, body } = parseFrontmatter(source)
const entry = cfg.routines.find((r) => r.id === id)
const title = fm.title || entry?.title || id
// A watch routine (every N minutes) stays inside its window; started by hand it always runs.
if (entry?.every && entry.between && !process.stdout.isTTY && !inWindow(entry.between)) process.exit(0)
const now = new Date()
const today = isoDay(now)

/** Today's conversation with Jarvis in the HUD, as plain text for routines that summarise the day. */
async function chatOfDay() {
  const turns = await readDay(today)
  if (!turns.length) return ''
  return turns
    .map((t) => `[${t.at.slice(11, 16)}] používateľ: ${t.user}\n[${t.at.slice(11, 16)}] Jarvis: ${t.jarvis}`)
    .join('\n')
    .slice(-12_000)
}

const context = [
  `Dnes je ${DOW_LONG[now.getDay()]} ${now.getDate()}. ${now.getMonth() + 1}. ${now.getFullYear()}, ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}.`,
  `Bežíš ako naplánovaná rutina „${title}" bez používateľa pri počítači. Nepýtaj sa, rozhoduj sám, pracuj až do konca.`,
  cfg.name ? `Používateľ sa volá ${cfg.name}, býva v meste ${cfg.city}.` : '',
  MEMORY_EXTERNAL ? `Pamäť nie je v priečinku memory/, ale tu: ${MEMORY_DIR}. Všade, kde zadanie hovorí memory/, použi túto cestu.` : '',
  'Tvoja posledná správa je výsledok rutiny v tomto tvare: najprv celý text (markdown, stručne), potom samostatný riadok `---` a riadok `HLAS: …` s jednou až tromi vetami, ktoré Jarvis prečíta nahlas (bez markdownu, prirodzene, ako komorník).',
  'Nič neposielaj von za používateľa (maily, správy). Návrhy priprav a napíš, že čakajú na schválenie.',
  callReady() ? 'Vieš používateľovi zavolať na mobil. Použi to len vtedy, keď niečo naozaj nepočká (niekto čaká na odpoveď do hodiny, termín padá dnes, niečo sa pokazilo): na samostatný riadok na konci napíš `VOLAJ: …` s jednou až tromi vetami, ktoré mu povieš do telefónu.' : '',
  entry?.every ? `Toto je strážna rutina, beží každých ${entry.every} minút. Ozvi sa len vtedy, keď je naozaj čo povedať. Keď nie je, tvoja celá odpoveď je jediné slovo: NIČ. To isté, čo si už ohlásil, neopakuj: čo si ohlásil, si zapíš do data/pulse/${id}.md a pred ohlásením sa tam pozri.` : '',
].filter(Boolean).join('\n')

async function runClaude(prompt) {
  if (!CLAUDE_BIN) throw new Error('Claude Code CLI sa nenašiel')
  const ctxFile = join(DATA_DIR, `routine-${id}.context.md`)
  writeFileSync(ctxFile, context, { mode: 0o600 })
  const model = entry?.model || fm.model
  const args = ['-p', '--output-format', 'json', ...(model ? ['--model', String(model)] : modelArgs()), ...permissionArgs(), '--append-system-prompt-file', ctxFile]
  return new Promise((resolve, reject) => {
    const child = spawnBin(CLAUDE_BIN, args, { cwd: REPO, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('rutina trvala viac ako 20 minút'))
    }, 20 * 60_000)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err = `${err}${d}`.slice(-2000)))
    child.on('error', (e) => (clearTimeout(timer), reject(e)))
    child.on('exit', (code) => {
      clearTimeout(timer)
      try {
        const res = JSON.parse(out.trim().split('\n').pop())
        if (res.is_error) return reject(new Error(String(res.result ?? 'Claude skončil chybou').slice(0, 400)))
        resolve(String(res.result ?? ''))
      } catch {
        reject(new Error(`Claude skončil (${code}): ${err.trim().split('\n').pop() ?? 'bez výstupu'}`))
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}

const MOCK_TEXT = `# ${title} (skúška)\n\nToto je skúšobný beh rutiny bez Claude. Overuje, že výsledok sa uloží do pamäte, ukáže v HUD a príde ako oznámenie.\n\n---\nHLAS: Skúška rutiny prebehla v poriadku. Všetko funguje.`

try {
  log(`štart rutiny ${id}${flags.has('mock') ? ' (mock)' : ''}`)
  let prompt = body.trim()
  if (prompt.includes('{{rozhovor}}')) prompt = prompt.replace('{{rozhovor}}', (await chatOfDay()) || '(dnes sme sa v HUD nerozprávali)')
  prompt = prompt.replaceAll('{{dnes}}', today)
  const t0 = Date.now()
  let result = flags.has('mock') ? MOCK_TEXT : await runClaude(prompt)
  // "VOLAJ: …" on its own line asks for a phone call. It is not part of the written result.
  const callLine = /^[ \t]*VOLAJ:[ \t]*(.+)$/im.exec(result)?.[1]?.trim() ?? ''
  result = result.replace(/^[ \t]*VOLAJ:.*$\n?/gim, '').trim()
  const [textPart, voicePart = ''] = result.split(/\n-{3,}\s*\n(?=\s*HLAS:)/)
  const text = textPart.trim()
  const say = voicePart.replace(/^\s*HLAS:\s*/i, '').trim().replace(/\s+/g, ' ')
  // A watch routine that found nothing answers with the single word NIČ: no file, no card, no voice.
  if (/^ni[cč]\.?$/i.test(text) || (!text && !say)) {
    log(`nič na ohlásenie (${Math.round((Date.now() - t0) / 1000)} s)`)
    process.exit(0)
  }

  const outRel = `${FOLDERS.inbox}/${today}-${id}.md`
  const outFile = join(MEMORY_DIR, outRel)
  mkdirSync(join(MEMORY_DIR, FOLDERS.inbox), { recursive: true })
  writeFileSync(outFile, `---\ntitle: ${title}\nrutina: ${id}\ndatum: ${today}\n---\n${text}\n`)
  log(`hotovo za ${Math.round((Date.now() - t0) / 1000)} s, uložené do memory/${outRel}`)

  if (!flags.has('silent')) {
    const plainText = text.replace(/^#+\s*/gm, '').replace(/[*_`>]/g, '').trim()
    // In quiet hours the result still shows up, it just is not read aloud.
    const hush = inWindow(cfg.quiet)
    const delivered = (await hudAlive()) ? await postHud('/api/announce', { title, text: plainText, say: say || plainText.slice(0, 300), node: 'rutiny', silent: hush }) : false
    log(delivered ? 'ukázané v HUD' : 'HUD nebeží, posielam len oznámenie')
    await notify(`Jarvis: ${title}`, say || plainText)
    // A phone call: when the routine asked for one, or when the routine is set to arrive by phone (`"call": true`).
    const phone = callLine || (entry?.call ? say || plainText.slice(0, 600) : '')
    if (phone && !hush && callReady()) {
      callOut(phone, id)
      log('volám na mobil')
    }
  }
  process.exit(0)
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  log(`chyba: ${msg}`)
  if (!flags.has('silent')) {
    await postHud('/api/event', { type: 'alert', text: `Rutina ${title} zlyhala`, icon: 'alarm', node: 'rutiny', source: 'jarvis' })
    await notify(`Jarvis: ${title} sa nepodarila`, msg)
  }
  process.exit(1)
}

