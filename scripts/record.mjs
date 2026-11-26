#!/usr/bin/env node
/**
 * Record mode from the command line: the same as telling Jarvis "nahrávaj" and "stačí" (docs/ZAZNAM.md).
 * The open Jarvis window records the microphone (and the screen video in Chrome), the server takes
 * pictures of the screen and transcribes as it goes. After the end a background job writes the note,
 * the tasks, reminders, calendar entries and drafts of messages.
 *
 *   node scripts/record.mjs start ["Porada s Petrom"]   starts (or says which one runs)
 *   node scripts/record.mjs stop                        ends the running one
 *   node scripts/record.mjs status [--json]             what runs right now
 *   node scripts/record.mjs list [--json]               the latest recordings and their state
 *   node scripts/record.mjs finish <id>                 runs the after-actions again (interrupted, failed)
 *
 * Recordings are in data/recordings/<id>/ on this computer.
 */
import { HUD_URL, hudAlive, parseArgs } from './lib.mjs'

const { flags, rest } = parseArgs()
const [command = 'status', ...args] = rest
const json = flags.has('json')

const STATE = { recording: 'nahráva sa', finishing: 'dokončuje sa prepis', processing: 'spracúva sa', done: 'hotový', failed: 'nepodaril sa', interrupted: 'prerušený' }
const mins = (s) => (s < 60 ? `${s} s` : `${Math.round(s / 60)} min`)
const mb = (b) => `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`
const line = (x) => `${x.id}  ${(STATE[x.status] ?? x.status).padEnd(20)} ${mins(x.seconds)}, ${mb(x.bytes)}  ${x.title}${x.job ? `  (úloha ${x.job})` : ''}${x.warn ? `\n      ! ${x.warn}` : ''}`

async function call(method, path, body) {
  const res = await fetch(`${HUD_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) {
    console.error(`✗ ${data.error ?? `HTTP ${res.status}`}`)
    process.exit(1)
  }
  return data
}

if (!(await hudAlive())) {
  console.error('✗ Jarvis nebeží. Záznam robí jeho server a okno: node scripts/hud.mjs')
  process.exit(1)
}

switch (command) {
  case 'start': {
    const r = await call('POST', '/api/record/start', { title: args.join(' ').trim(), via: 'cli' })
    if (json) console.log(JSON.stringify(r))
    else console.log(r.already ? `Záznam už beží: ${line(r.session)}` : `✓ Záznam beží: ${r.session.id}. Zvuk nahráva otvorené okno Jarvisa, súbory sú v ${r.session.dir}`)
    break
  }
  case 'stop': {
    const r = await call('POST', '/api/record/stop', {})
    if (json) console.log(JSON.stringify(r))
    else console.log(`✓ Záznam ${r.session.id} končí (${mins(r.session.seconds)}). Prepis sa dokončí a spracovanie beží na pozadí.`)
    break
  }
  case 'finish': {
    if (!args[0]) {
      console.error('Zadaj id záznamu: node scripts/record.mjs finish 2026-11-26-1432 (zoznam: list)')
      process.exit(1)
    }
    const r = await call('POST', '/api/record/finish', { id: args[0] })
    if (json) console.log(JSON.stringify(r))
    else console.log(`✓ ${r.session.id}: ${STATE[r.session.status] ?? r.session.status}`)
    break
  }
  case 'list':
  case 'status': {
    const r = await call('GET', '/api/record')
    if (json) {
      console.log(JSON.stringify(command === 'status' ? { active: r.active, sttReady: r.sttReady } : r))
      break
    }
    if (command === 'status') {
      console.log(r.active ? line(r.active) : 'Žiadny záznam nebeží.')
      if (r.active && !r.sttReady) console.log('  ! Lokálny Whisper nebeží, prepis nebude (node scripts/voice.mjs).')
      break
    }
    console.log(r.recent.length ? r.recent.map(line).join('\n') : 'Zatiaľ žiadne záznamy.')
    break
  }
  default:
    console.log('node scripts/record.mjs start ["názov"] | stop | status | list | finish <id>')
}
