#!/usr/bin/env node
/**
 * Jarvis calls your mobile and says something. A real phone call through your own Twilio account.
 *
 *   node scripts/call.mjs "O desať minút máte zubára."   call now and say it
 *   node scripts/call.mjs --test                         a short test call
 *   node scripts/call.mjs --status                       what is set up (no secrets shown)
 *   node scripts/call.mjs "…" --no-reply                 just say it, do not wait for an answer
 *   node scripts/call.mjs "…" --json                     the result as data
 *
 * After the message you can answer by voice. When the call ends, Jarvis listens to your answer
 * (needs local speech recognition, docs/HLAS.md) and acts on it in the HUD.
 * Setup: docs/HOVORY.md. The pulse and the routines use this script when something is urgent.
 */
import { readFile } from 'node:fs/promises'
import { callStatus, fetchReply, placeCall, waitCall } from '../hud/server/call.mjs'
import { HUD_URL, hudAlive, parseArgs, postHud } from './lib.mjs'

const { flags, rest } = parseArgs()
const json = flags.has('json')
const say = (line) => !json && console.log(line)
const STATUS_SK = { completed: 'prebehol', busy: 'obsadené', failed: 'zlyhal', 'no-answer': 'bez odpovede', canceled: 'zrušený', unknown: 'neznámy stav' }

if (flags.has('status')) {
  const st = await callStatus()
  if (json) console.log(JSON.stringify(st, null, 2))
  else {
    console.log(`\n  Hovory: ${st.ready ? 'pripravené' : 'ešte nie sú nastavené'}\n`)
    if (st.ready) console.log(`  volám na ${st.to} z čísla ${st.from}, hlas ${st.voice}\n  dnes ${st.today} z ${st.maxPerDay} hovorov, odpoveď hlasom: ${st.reply ? 'áno' : 'nie'}\n`)
    for (const p of st.problems) console.log(`  → ${p}`)
    if (!st.ready) console.log('\n  Postup je v docs/HOVORY.md.\n')
  }
  process.exit(st.ready ? 0 : 1)
}

const text = flags.has('test') ? 'Dobrý deň, tu Jarvis. Toto je skúšobný hovor. Ak ma počujete, všetko funguje.' : rest.join(' ').trim()
if (!text) {
  console.error('Čo mám povedať? Napríklad: node scripts/call.mjs "O desať minút máte zubára."')
  process.exit(1)
}
const source = [...flags].find((f) => f.startsWith('source='))?.slice(7) ?? 'ručne'

try {
  const call = await placeCall({ text, reply: flags.has('no-reply') || flags.has('test') ? false : null, source })
  say(`Volám na ${call.to}…`)
  const end = await waitCall(call.sid)
  say(`Hovor ${STATUS_SK[end.status] ?? end.status}${end.seconds ? ` (${end.seconds} s)` : ''}.`)
  const result = { ok: end.answered, sid: call.sid, ...end, reply: null }

  if (end.answered && call.reply) {
    const rec = await fetchReply(call.sid)
    if (rec && rec.seconds >= 1 && (await hudAlive())) {
      // The HUD server keeps the speech recognition warm, so it does the listening.
      const res = await fetch(`${HUD_URL}/api/stt?send=0`, { method: 'POST', headers: { 'content-type': 'audio/mpeg' }, body: await readFile(rec.file), signal: AbortSignal.timeout(120_000) }).then((r) => r.json()).catch(() => null)
      if (res?.ok && res.text) {
        result.reply = res.text
        say(`Odpoveď: ${res.text}`)
        await postHud('/api/chat', { text: `[telefonát] Zavolal si mi a povedal: „${text.slice(0, 600)}" Odpovedal som ti do telefónu: „${res.text}"`, via: 'voice', silent: true })
      } else if (res && res.ok === false && /prepis/.test(res.error ?? '')) {
        await postHud('/api/announce', { title: 'Odpoveď z hovoru', text: 'Odpoveď z hovoru je nahratá, ale neviem ju prepísať. Zapni lokálny prepis reči (docs/HLAS.md).', silent: true, icon: 'mic' })
      }
    }
  } else if (!end.answered && (await hudAlive())) {
    await postHud('/api/announce', { title: 'Nedovolal som sa', text, say: text, icon: 'alarm' })
  }
  if (json) console.log(JSON.stringify(result, null, 2))
  process.exit(end.answered ? 0 : 2)
} catch (err) {
  if (json) console.log(JSON.stringify({ ok: false, error: err.message }))
  else console.error(err.message)
  process.exit(1)
}
