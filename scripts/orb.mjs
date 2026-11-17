#!/usr/bin/env node
/**
 * The orbs of the 3D world from the command line. Jarvis uses this to extend his own interface:
 * add an orb for something new in the user's life, fill it with a panel of components, or take
 * one away. The vocabulary of the panel is in docs/ORBY.md.
 *
 *   node scripts/orb.mjs list [--json]
 *   node scripts/orb.mjs add financie --label "Financie" [--icon chart] [--color "#9affc8"] [--shape orb] [--moon] [--folder financie]
 *   node scripts/orb.mjs set financie --file obsah.json        what the orb shows (value, sub, items, panel)
 *   node scripts/orb.mjs set financie --json '{"value":"3","sub":"faktúry čakajú"}'
 *   node scripts/orb.mjs clear financie
 *   node scripts/orb.mjs hide spanok | show spanok | remove financie
 *   node scripts/orb.mjs shapes
 *
 * Works with the HUD running or not: files are written here and an open HUD redraws at once.
 */
import { readFileSync } from 'node:fs'
import { ICONS, SHAPES, changeOrbs, getOrbs, orbContent } from '../hud/server/orbs.mjs'
import { parseArgs, postHud } from './lib.mjs'

const argv = process.argv.slice(2)
const { flags } = parseArgs(argv)
const json = flags.has('json') && argv[0] !== 'set'
/** Value of `--name value` or `--name=value`. */
function opt(name) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}
const [cmd, id] = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !argv[i - 1].includes('=') && !['--json', '--moon'].includes(argv[i - 1])))

function out(result) {
  if (json) console.log(JSON.stringify(result, null, 2))
  else console.log(result.summary ?? 'Hotovo.')
}

try {
  if (!cmd || cmd === 'list') {
    const orbs = getOrbs()
    if (json) console.log(JSON.stringify(orbs, null, 2))
    else {
      console.log(`Vlastné orby: ${orbs.custom.length ? orbs.custom.map((c) => `${c.id} („${c.label}", ${c.kind === 'moon' ? 'mesiac' : 'planéta'})`).join(', ') : 'žiadne'}`)
      console.log(`Skryté: ${orbs.hidden.join(', ') || 'žiadne'} · Pripnuté: ${orbs.pinned.join(', ') || 'žiadne'}`)
      for (const [key, c] of Object.entries(orbs.content)) console.log(`  ${key}: ${[c.value, c.sub].filter(Boolean).join(' · ') || 'bez čísla'}${c.panel ? ', má panel' : ''}${c.count ? `, ${c.count} položiek` : ''}`)
    }
  } else if (cmd === 'shapes') {
    console.log(`Tvary: ${SHAPES.join(', ')}\nIkony: ${ICONS.join(', ')}`)
  } else if (cmd === 'show-content') {
    console.log(JSON.stringify(orbContent(id), null, 2))
  } else {
    let body
    if (cmd === 'add' || cmd === 'update') {
      body = { action: cmd, id, label: opt('label'), icon: opt('icon'), color: opt('color'), shape: opt('shape'), folder: opt('folder'), ...(flags.has('moon') ? { kind: 'moon' } : flags.has('planet') ? { kind: 'planet' } : {}) }
    } else if (cmd === 'set') {
      const file = opt('file')
      const raw = file ? readFileSync(file, 'utf8') : opt('json')
      if (!raw) throw new Error('Chýba obsah: --file <súbor.json> alebo --json \'{…}\'.')
      body = { action: 'content', id, content: raw }
    } else body = { action: cmd, id }
    const result = changeOrbs(body)
    // An open HUD redraws the ring at once. Without one the change shows on its next start.
    await postHud('/api/orbs', { action: 'reload', id }).catch(() => null)
    out(result)
  }
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
