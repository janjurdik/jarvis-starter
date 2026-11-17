#!/usr/bin/env node
/**
 * A background job from the command line: the same as telling Jarvis in the HUD "zisti mi…" or
 * "cez noc mi priprav…". A full Claude Code run in this folder that works while you do something
 * else (or sleep). Its result is announced in the HUD, and what ended overnight is in the morning
 * brief and in the alarm. The HUD server must run, the script starts it when it does not.
 *
 *   node scripts/job.mjs "Priprav prehľad konkurencie do memory/poznamky/Konkurencia.md" --title "Prehľad konkurencie"
 *   node scripts/job.mjs --list
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { HUD_URL, REPO, hudAlive, parseArgs } from './lib.mjs'

const argv = process.argv.slice(2)
const ti = argv.indexOf('--title')
const title = ti >= 0 ? argv[ti + 1] ?? '' : ''
const { flags, rest } = parseArgs(ti >= 0 ? argv.filter((_, i) => i !== ti && i !== ti + 1) : argv)
const task = rest.join(' ').trim()

if (!(await hudAlive())) {
  if (flags.has('list')) {
    console.log('HUD nebeží, žiadne úlohy na pozadí.')
    process.exit(0)
  }
  const res = spawnSync(process.execPath, [join(REPO, 'scripts', 'hud.mjs'), '--server'], { cwd: REPO, stdio: 'ignore', windowsHide: true })
  if (res.status !== 0 || !(await hudAlive())) {
    console.error('HUD server sa nepodarilo spustiť, úlohy na pozadí bežia v ňom. Pozri data/logs/hud-server.log')
    process.exit(1)
  }
}

if (flags.has('list') || !task) {
  if (!task && !flags.has('list')) console.log('Zadanie: node scripts/job.mjs "čo má Jarvis spraviť" --title "Krátky názov"\n')
  const jobs = await (await fetch(`${HUD_URL}/api/jobs`)).json()
  const label = { queued: 'čaká', running: 'beží', needs_ok: 'čaká na súhlas', done: 'hotová', error: 'zlyhala', stopped: 'zastavená' }
  console.log(jobs.length ? jobs.slice(0, 15).map((j) => `${j.id}  ${(label[j.status] ?? j.status).padEnd(15)} ${j.title}${j.summary ? `\n      ${j.summary.slice(0, 160)}` : ''}`).join('\n') : 'Žiadne úlohy.')
  process.exit(0)
}

const res = await fetch(`${HUD_URL}/api/jobs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ task, title: title || task.split(/\s+/).slice(0, 5).join(' '), mock: flags.has('mock') }),
})
const body = await res.json().catch(() => ({}))
if (!res.ok || !body.ok) {
  console.error(`Úlohu sa nepodarilo spustiť: ${body.error ?? res.status}`)
  process.exit(1)
}
console.log(`Úloha ${body.job.id} „${body.job.title}" ${body.job.status === 'queued' ? 'čaká vo fronte' : 'beží'}. Výsledok ohlási Jarvis v HUD, a čo skončí v noci, povie ráno v brífe.`)
