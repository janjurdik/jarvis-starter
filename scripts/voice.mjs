#!/usr/bin/env node
/**
 * Jarvis's voice and hearing, prepared ahead of the first start.
 *
 *   node scripts/voice.mjs prepare             downloads what is missing and tries it out. Safe to run
 *                                              again: what is ready is skipped.
 *   node scripts/voice.mjs prepare --progress  one JSON object per line while it works:
 *                                              {"step":"whisper","state":"downloading","pct":42,"text":"…"}
 *                                              step: uv | plan | tts | whisper
 *                                              state: checking | downloading | verifying | done | skipped | error
 *                                              and the result on the last line:
 *                                              {"ok":true,"stt":{"engine","model",…},"tts":{…},"notes":[…]}
 *   node scripts/voice.mjs prepare --json      only the result, as JSON
 *   node scripts/voice.mjs prepare --force     do it all again (after more memory or disk space, or to pick a model again)
 *   node scripts/voice.mjs plan [--json]       which speech recognition this computer gets and why, nothing is downloaded
 *
 * Which Whisper model is chosen: hud/server/stt-plan.mjs and docs/HLAS.md. When something cannot
 * be prepared, Jarvis listens through the browser instead and says why. The exit code is 0 then too.
 */
// lib.mjs comes first: it loads .env before anything reads the settings.
import { parseArgs } from './lib.mjs'
import { PLAN_FILE, modelsDir, prepareNeeded, prepareRunning, sttSummary } from '../hud/server/stt-plan.mjs'
import { prepareVoice } from '../hud/server/voice-prepare.mjs'

const { flags, rest } = parseArgs()
const command = rest[0] ?? 'plan'
// The reader may go away (a parent that stopped waiting): the preparation carries on regardless.
process.stdout.on('error', () => {})
// Standard output carries only this script's own lines (JSON with --progress and --json):
// log lines of the modules it uses go to standard error.
const print = (line) => process.stdout.write(`${line}\n`)
console.log = (...args) => console.error(...args)

const ENGINE = { mlx: 'lokálny Whisper (MLX)', faster: 'lokálny Whisper (faster-whisper)', browser: 'rozpoznávanie v prehliadači', off: 'vypnuté' }
const gb = (mb) => `${(mb / 1000).toFixed(1).replace('.', ',')} GB`

if (command === 'plan' || command === 'status') {
  const plan = { ...sttSummary(), planFile: PLAN_FILE, modelsDir: modelsDir(), prepareNeeded: prepareNeeded(), prepareRunning: Boolean(prepareRunning()) }
  if (flags.has('json')) print(JSON.stringify(plan, null, 2))
  else {
    const s = plan.specs
    print(`\n  Rozpoznávanie reči: ${ENGINE[plan.engine] ?? plan.engine}${plan.model ? `, model ${plan.model}${plan.sizeMb ? ` (${gb(plan.sizeMb)})` : ''}` : ''}`)
    print(`  ${plan.reason}`)
    for (const note of plan.notes) print(`  ${note}`)
    if (s) print(`\n  Počítač: ${s.cpu || s.arch}, ${s.cores} jadier, ${Math.round(s.ramGb)} GB pamäte${s.gpu?.name ? `, ${s.gpu.name}` : ''}, voľné miesto ${s.freeDiskMb == null ? 'neznáme' : gb(s.freeDiskMb)}`)
    print(`  Modely: ${plan.modelsDir}`)
    print(`  Stav: ${plan.status === 'ready' ? 'pripravené' : plan.prepareRunning ? 'práve sa pripravuje' : plan.prepareNeeded ? 'treba pripraviť: node scripts/voice.mjs prepare' : 'netreba nič sťahovať'}\n`)
  }
  process.exit(0)
}

if (command !== 'prepare') {
  console.error('Použitie: node scripts/voice.mjs prepare [--progress] [--json] [--force] | plan [--json]')
  process.exit(2)
}

const lines = flags.has('progress')
const quiet = flags.has('json') && !lines
const MARK = { done: '✓', skipped: '·', error: '✗' }
let lastLine = ''

function show(p) {
  if (lines) return print(JSON.stringify(p))
  if (quiet) return
  // A download reports every percent: on a terminal one line per ten is enough.
  const key = p.state === 'downloading' && p.pct != null ? `${p.step}|${Math.floor(p.pct / 10)}` : `${p.step}|${p.state}|${p.text}`
  if (key === lastLine) return
  lastLine = key
  print(`  ${MARK[p.state] ?? '…'} ${p.text}${p.state === 'downloading' && p.pct != null ? ` (${p.pct} %)` : ''}`)
}

if (!lines && !quiet) print('\n  Jarvis: príprava hlasu\n')
const result = await prepareVoice({ onProgress: show, force: flags.has('force') })

if (lines) print(JSON.stringify(result))
else if (quiet) print(JSON.stringify(result, null, 2))
else {
  print(`\n  Počúvanie: ${ENGINE[result.stt.engine] ?? result.stt.engine}${result.stt.model ? `, model ${result.stt.model}` : ''}`)
  if (result.stt.reason) print(`  ${result.stt.reason}`)
  print(`  Hlas: ${result.tts.provider}${result.tts.provider === 'edge' ? ` (${result.tts.voice})` : ''}`)
  for (const note of result.notes) print(`  ${note}`)
  print('')
}
// No process.exit here: on a pipe the last line could be cut off. The timer only ends a process that something keeps alive.
process.exitCode = result.ok ? 0 : 1
setTimeout(() => process.exit(), 2000).unref()
