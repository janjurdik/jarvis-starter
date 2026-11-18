import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'jarvis-asking-'))
process.env.JARVIS_DATA_DIR = join(dir, 'data')
process.env.JARVIS_MEMORY_DIR = join(dir, 'memory')
process.env.JARVIS_CONFIG = join(dir, 'jarvis.json')
mkdirSync(process.env.JARVIS_DATA_DIR, { recursive: true })
mkdirSync(process.env.JARVIS_MEMORY_DIR, { recursive: true })
writeFileSync(process.env.JARVIS_CONFIG, JSON.stringify({ name: 'Martin Novák', address: 'pane', formal: true, city: 'Brno' }))
// An old note says otherwise: the settings were changed later and must win.
writeFileSync(
  join(process.env.JARVIS_MEMORY_DIR, 'ja.md'),
  '# Martin\n\nŠtuduje informatiku.\n\n- 2026-11-17: Chce tykanie, oslovenie Maťo.\n- 2026-11-17: Vykázal zisk z brigády.\n',
)

const { waitNudge, waitOf } = await import('../../hud/server/jobs.mjs')
const { addressRule, buildPersona, contextLine } = await import('../../hud/server/persona.mjs')

test('a question and an approval are told apart', () => {
  assert.deepEqual(waitOf('Nenašiel som ho.\nOTÁZKA: Ako sa ten účet volá presne?'), { kind: 'question', text: 'Ako sa ten účet volá presne?' })
  assert.deepEqual(waitOf('Návrh je hotový.\nNEEDS_OK: mail pre Petra o termíne'), { kind: 'approval', text: 'mail pre Petra o termíne' })
  assert.equal(waitOf('Hotovo, všetko je v pamäti.'), null)
})

test('a plain question sent the old way through NEEDS_OK is still a question', () => {
  assert.equal(waitOf('NEEDS_OK: Ako sa ten účet alebo človek volá presne?').kind, 'question')
  assert.equal(waitOf('NEEDS_OK: Poslať pripravený mail?').kind, 'approval')
})

test('Jarvis asks himself, never "the job"', () => {
  const nudge = waitNudge({ id: 'j4', title: 'Rozhovor s Petrom', wait: 'question', needsOk: 'Ako sa ten účet volá presne?', summary: 'V správach som ho nenašiel.' })
  assert.match(nudge, /^\[systém: /)
  assert.match(nudge, /Spýtaj sa ho na to sám/)
  assert.match(nudge, /agent_reply \(id j4\)/)
  const ok = waitNudge({ id: 'j5', title: 'Mail', wait: 'approval', needsOk: 'mail pre Petra' })
  assert.match(ok, /či to môžeš poslať/)
})

test('the address comes from the settings, an old note in memory does not count', () => {
  const persona = buildPersona()
  assert.doesNotMatch(persona, /Maťo/)
  assert.match(persona, /Vykáš, vždy/)
  assert.match(persona, /Oslovuješ ho „pane"/)
  // only the lines about the address are left out of the profile, not other words that look alike
  assert.match(persona, /Vykázal zisk/)
  assert.match(contextLine({ via: 'text', film: false }), /vykaj, oslovenie „pane"/)
  assert.match(addressRule(), /^Používateľovi vykáš a oslovuješ ho „pane" \(krstné meno Martin/)
})
