#!/usr/bin/env node
/**
 * Jarvis says a sentence out loud: in the HUD window when one is open (with the animation),
 * otherwise through the computer's speakers. The onboarding uses it for the first "this is what
 * I know about you" moment.
 *
 *   node scripts/say.mjs "Dobrý deň. Už viem, kto ste."
 *   node scripts/say.mjs "…" --local     always through the speakers, never the HUD
 */
import { hudListeners, parseArgs, postHud } from './lib.mjs'

const { flags, rest } = parseArgs()
const text = rest.join(' ').replace(/\s+/g, ' ').trim()
if (!text) {
  console.error('Napíš, čo má Jarvis povedať: node scripts/say.mjs "Dobrý deň."')
  process.exit(1)
}

if (!flags.has('local') && (await hudListeners()) > 0 && (await postHud('/api/say', { text: text.slice(0, 1200) }))) {
  console.log('Jarvis to hovorí v HUD.')
  process.exit(0)
}
const { speakLocal } = await import('../hud/server/speak.mjs')
const res = await speakLocal(text, { force: true })
console.log(res.ok ? `Jarvis to povedal cez reproduktory (${res.via}).` : 'Zvuk sa nepodarilo prehrať.')
process.exit(res.ok ? 0 : 1)
