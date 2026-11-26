#!/usr/bin/env node
/**
 * Jarvis on the phone: the Cloudflare tunnel from the command line (docs/MOBIL.md). The tunnel
 * itself runs inside the HUD server, this script only asks it. The email and the password are set
 * by the user himself in Settings → Mobil, never here and never in the chat.
 *
 *   node scripts/tunnel.mjs status [--json]   is mobile access on, the address, the logged-in devices
 *   node scripts/tunnel.mjs install           makes sure cloudflared is on this computer
 *   node scripts/tunnel.mjs start [--quick]   turns mobile access on and waits for the address
 *   node scripts/tunnel.mjs stop              turns it off (every device logs out)
 *   node scripts/tunnel.mjs restart           a new connection (a quick tunnel gets a new address)
 *   node scripts/tunnel.mjs show              opens Settings → Mobil on the screen (QR code for the phone)
 */
import { HUD_URL, hudAlive, parseArgs } from './lib.mjs'
import { RemoteAuth } from '../hud/server/remote.mjs'
import { cloudflaredBin, cloudflaredVersion, installCloudflared } from '../hud/server/tunnel.mjs'

const { flags, rest } = parseArgs()
const cmd = rest[0] ?? 'status'
const json = flags.has('json')

const out = (obj, line) => console.log(json ? JSON.stringify(obj, null, 2) : line)
const fail = (error, extra = {}) => {
  out({ ok: false, error, ...extra }, `✗ ${error}`)
  process.exit(1)
}

async function call(method, path, body) {
  const res = await fetch(`${HUD_URL}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

function describe(s) {
  const t = s.tunnel ?? {}
  const lines = []
  if (!s.email || !s.hasPassword) lines.push('Prihlásenie nie je nastavené: e-mail a heslo si používateľ zadá sám v Nastaveniach, časť Mobil.')
  else lines.push(`Prihlásenie: ${s.email}, heslo nastavené.`)
  lines.push(`Mobilný prístup: ${s.enabled ? 'zapnutý' : 'vypnutý'}${s.enabled ? `, tunel ${t.state === 'running' ? 'beží' : t.state === 'error' ? `nejde (${t.error ?? 'chyba'})` : t.installing ? 'čaká na inštaláciu cloudflared' : 'sa otvára'}` : ''}.`)
  lines.push(`Tunel: ${s.mode === 'named' ? `vlastný Cloudflare, ${s.hostname || 'adresa chýba'}${s.hasToken ? '' : ', token chýba'}` : 'rýchly (adresa sa mení pri každom spustení)'}.`)
  if (s.address) lines.push(`Adresa pre mobil: ${s.address}`)
  lines.push(`Prihlásené zariadenia: ${s.devices?.length ?? 0}.`)
  lines.push(`cloudflared: ${s.cloudflared ?? 'nie je nainštalovaný (node scripts/tunnel.mjs install)'}.`)
  return lines.join('\n')
}

if (cmd === 'install') {
  const r = await installCloudflared({ say: (t) => !json && console.log(`  ${t}`) })
  if (!r.ok) fail(r.error)
  out(r, `✓ cloudflared ${r.version} je pripravený (${r.bin}).`)
  process.exit(0)
}

if (!['status', 'start', 'stop', 'restart', 'show'].includes(cmd)) fail(`Neznámy príkaz ${cmd}. Použi status, install, start, stop, restart alebo show.`)

if (!(await hudAlive())) {
  if (cmd !== 'status') fail('Jarvis (HUD server) nebeží. Tunel beží v ňom: najprv node scripts/hud.mjs.')
  // Without the server: what is saved, read straight from the files.
  const auth = new RemoteAuth()
  const s = { ...auth.summary(), tunnel: { state: 'off' }, cloudflared: cloudflaredVersion(cloudflaredBin()), address: null, server: false }
  out({ ok: true, ...s }, `${describe(s)}\nJarvis teraz nebeží, tunel sa otvorí s ním.`)
  process.exit(0)
}

try {
  if (cmd === 'status') {
    const s = await call('GET', '/api/remote/status')
    out(s, describe(s))
    process.exit(0)
  }
  if (cmd === 'show') {
    await call('POST', '/api/remote/tunnel', { action: 'show' })
    out({ ok: true }, '✓ Na obrazovke sú otvorené Nastavenia, časť Mobil.')
    process.exit(0)
  }
  if (cmd === 'stop') {
    const s = await call('POST', '/api/remote/tunnel', { action: 'stop' })
    out(s, '✓ Mobilný prístup je vypnutý, tunel je zavretý a všetky zariadenia sú odhlásené.')
    process.exit(0)
  }
  // start, restart: wait until the tunnel has its address (the first start may install cloudflared).
  let s = await call('POST', '/api/remote/tunnel', { action: cmd, ...(flags.has('quick') ? { mode: 'quick' } : {}) })
  const t0 = Date.now()
  while (Date.now() - t0 < 180_000) {
    if (s.tunnel?.state === 'running' && s.address) break
    if (s.tunnel?.state === 'error' && Date.now() - t0 > 4000) break
    await new Promise((r) => setTimeout(r, 1500))
    s = await call('GET', '/api/remote/status')
  }
  if (s.tunnel?.state !== 'running' || !s.address) fail(`Tunel sa neotvoril: ${s.tunnel?.error ?? 'nedostal adresu do troch minút'}. Podrobnosti v data/logs/tunnel.log.`, s)
  out(s, `✓ Mobilný prístup je zapnutý.\n  Adresa pre mobil: ${s.address}${s.mode === 'quick' ? '\n  Adresa sa mení pri každom spustení tunela.' : ''}\n  QR kód je v Nastaveniach, časť Mobil (node scripts/tunnel.mjs show).`)
} catch (err) {
  fail(err.message)
}
