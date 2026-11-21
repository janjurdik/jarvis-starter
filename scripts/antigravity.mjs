#!/usr/bin/env node
/**
 * Google Antigravity as the AI Jarvis runs on: is it installed, is it signed in, and the sign-in.
 *
 *   node scripts/antigravity.mjs [status] [--json]
 *       asks the agent itself (starts it and opens an empty session). Never opens a browser.
 *
 *   node scripts/antigravity.mjs login
 *       starts Antigravity's own Google sign-in: the browser opens and the user signs in there.
 *       The agent keeps the sign-in itself. Jarvis sees no password and no token, he only waits.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { INSTALL_HINT, antigravityInstall, antigravityLogin, antigravityStatus } from '../hud/server/antigravity.mjs'
import { cleanEnv } from '../hud/server/provider.mjs'
import { DATA_DIR, parseArgs } from './lib.mjs'

const { flags, rest } = parseArgs()
const command = rest[0] ?? 'status'
const json = flags.has('json')
// The agent needs a folder to start in: its own corner of data/, the same one the voice brain uses.
const cwd = join(DATA_DIR, 'brain', 'antigravity')
mkdirSync(cwd, { recursive: true })

const SOURCE = { cli: 'Antigravity CLI', t3: 'server Antigravity z aplikácie T3 Code', custom: 'vlastná cesta (JARVIS_ANTIGRAVITY_BIN)' }

if (command === 'login') {
  if (!antigravityInstall()) {
    console.error(`Antigravity nie je nainštalovaný.\n  ${INSTALL_HINT}`)
    process.exit(1)
  }
  console.log('Otváram prihlásenie Google v prehliadači. Prihlás sa tam účtom, na ktorom máš Antigravity, a potvrď prístup. Počkám.')
  try {
    const res = await antigravityLogin({ env: cleanEnv(), cwd, onLink: (url) => console.log(`\nAk sa prehliadač neotvoril, otvor tento odkaz:\n${url}\n`) })
    console.log(`Hotovo, Antigravity je prihlásený${res.tier ? ` (${res.tier})` : ''}. Jarvisa stačí reštartovať: node scripts/hud.mjs --restart`)
    process.exit(0)
  } catch (err) {
    console.error(`Prihlásenie sa nepodarilo: ${err?.message ?? err}\n  Skús to znova (node scripts/antigravity.mjs login) a prihlásenie v prehliadači dokonči až do konca.${err?.auth ? '\n  Keď sa preruší samo do pár sekúnd, na jeho dočasnú adresu v počítači sa pripojil iný program (napríklad nástroj, ktorý sleduje lokálne porty). Na chvíľu ho vypni.' : ''}`)
    process.exit(1)
  }
}

if (command !== 'status') {
  console.error('Použitie: node scripts/antigravity.mjs [status] [--json] | login')
  process.exit(1)
}

const s = await antigravityStatus({ env: cleanEnv(), cwd })
if (json) console.log(JSON.stringify({ ok: s.installed && s.loggedIn, ...s, fix: !s.installed ? INSTALL_HINT : s.loggedIn ? null : 'node scripts/antigravity.mjs login' }, null, 2))
else if (!s.installed) console.log(`Antigravity nie je nainštalovaný.\n  ${INSTALL_HINT}`)
else if (s.loggedIn) console.log(`Antigravity${s.version ? ` ${s.version}` : ''} je pripravený (${SOURCE[s.source] ?? s.source}${s.tier ? `, ${s.tier}` : ''}${s.model ? `, model ${s.model}` : ''}).`)
else console.log(s.needsLogin ? s.error : `Antigravity sa nepodarilo spustiť: ${s.error}`)
process.exit(s.installed && s.loggedIn ? 0 : 1)
