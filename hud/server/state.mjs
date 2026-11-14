/**
 * Trvalý stav, ktorý musí prežiť reštart: režim natáčania a „Hey Jarvis".
 * Natáčanie hlavne: keď server spadne počas natáčania, nesmie sa vrátiť s menami na obrazovke.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BRAIN_DIR, writeFileAtomic } from './util.mjs'

const FILE = join(BRAIN_DIR, 'state.json')

function load() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'))
    return { film: raw.film === true, wake: raw.wake === true }
  } catch {
    return { film: false, wake: false }
  }
}

export const state = load()

let persist = true
/** Vedľajšie inštancie (capture, testy na inom porte) stav len čítajú, inak by prepísali hlavný HUD. */
export function setPersist(on) {
  persist = on
}

export async function saveState() {
  if (!persist) return
  await writeFileAtomic(FILE, JSON.stringify({ film: state.film, wake: state.wake }, null, 2) + '\n', 0o600)
}
