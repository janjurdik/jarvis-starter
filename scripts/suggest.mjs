#!/usr/bin/env node
/**
 * Recommendations: what Jarvis thinks is worth adding next (hud/server/suggest.mjs). Routines and
 * an agent working in this folder use it to put an idea in front of the user; the desktop shows it
 * under „Odporúčam" and a click says it to Jarvis.
 *
 *   node scripts/suggest.mjs list [--json]
 *   node scripts/suggest.mjs add "<what to add>" --why "<one sentence>" --say "<the sentence that orders it>"
 *   node scripts/suggest.mjs done <id>      it is done, or the user does not want it
 *
 * Works with the HUD running (the desktop updates at once) and without it (the file is written directly).
 */
import { HUD_URL, hudAlive, parseArgs } from './lib.mjs'

const argv = process.argv.slice(2)
const value = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}
const skip = new Set([value('why'), value('say')].filter((v) => v !== undefined))
const { flags, rest } = parseArgs(argv.filter((a) => !skip.has(a)))
const [command = 'list', ...args] = rest
const json = flags.has('json')

async function call(body) {
  if (await hudAlive()) {
    const res = await fetch(`${HUD_URL}/api/suggest`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
    const out = await res.json().catch(() => ({}))
    if (!res.ok || !out.ok) throw new Error(out.error ?? `HUD odpovedal ${res.status}`)
    return out.items
  }
  const m = await import('../hud/server/suggest.mjs')
  if (body?.add) await m.addSuggestion(body.add)
  if (body?.dismiss !== undefined) await m.dismissSuggestion(body.dismiss)
  return m.suggestions()
}

try {
  let items
  if (command === 'add') {
    const title = args.join(' ').trim()
    if (!title) throw new Error('Chýba, čo odporúčaš: node scripts/suggest.mjs add "Orb Financie" --why "…" --say "…"')
    items = await call({ add: { title, why: value('why'), say: value('say') } })
  } else if (command === 'done') {
    if (!args[0]) throw new Error('Chýba id: node scripts/suggest.mjs done <id>')
    items = await call({ dismiss: args[0] })
  } else items = await call(null)
  if (json) console.log(JSON.stringify({ ok: true, items }, null, 2))
  else console.log(items.length ? items.map((i) => `${i.id}\n  ${i.title}${i.why ? `: ${i.why}` : ''}`).join('\n') : 'Žiadne odporúčania.')
} catch (err) {
  console.log(json ? JSON.stringify({ ok: false, error: err.message }) : err.message)
  process.exit(1)
}
