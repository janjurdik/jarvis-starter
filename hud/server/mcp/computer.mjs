#!/usr/bin/env node
/**
 * MCP server `computer`: small, safe actions on the user's computer. Works on macOS and Windows.
 *
 *   open_app(name)   opens (or brings forward) an application
 *   open_url(url)    opens a web page in the default browser
 */
import { spawn } from 'node:child_process'
import { serveMcp } from './stdio.mjs'

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    child.stderr.on('data', (d) => (err = `${err}${d}`.slice(-400)))
    child.on('error', (e) => resolve({ ok: false, error: e.message }))
    child.on('exit', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim() || `kód ${code}` }))
  })
}

/** Names are passed as arguments, never through a shell string. */
const safeName = (name) => String(name ?? '').replace(/[^\p{L}\p{N} ._+&-]/gu, '').trim().slice(0, 80)

async function openApp(name) {
  const app = safeName(name)
  if (!app) return { ok: false, error: 'chýba názov aplikácie' }
  if (IS_MAC) return run('/usr/bin/open', ['-a', app])
  if (IS_WIN) {
    // Start-Process finds Store apps and anything on PATH or in App Paths (spotify, chrome, notepad, …).
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${app.replace(/'/g, "''")}'`])
  }
  return run('xdg-open', [app])
}

async function openUrl(url) {
  let parsed
  try {
    parsed = new URL(String(url ?? ''))
  } catch {
    return { ok: false, error: 'neplatná adresa' }
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { ok: false, error: 'len http a https adresy' }
  if (IS_MAC) return run('/usr/bin/open', [parsed.href])
  if (IS_WIN) return run('rundll32.exe', ['url.dll,FileProtocolHandler', parsed.href])
  return run('xdg-open', [parsed.href])
}

serveMcp({
  name: 'computer',
  instructions: 'Jednoduché akcie na počítači používateľa: otvoriť aplikáciu alebo web.',
  tools: [
    {
      name: 'open_app',
      description: 'Otvorí aplikáciu podľa názvu (napr. Spotify, Google Chrome, Notes, Kalkulačka). Na Windows názov spustiteľného programu alebo appky (spotify, chrome, notepad).',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      handler: async ({ name }) => {
        const r = await openApp(name)
        return r.ok ? `Otvorené: ${safeName(name)}` : { text: `Nepodarilo sa otvoriť ${safeName(name)}: ${r.error}`, isError: true }
      },
    },
    {
      name: 'open_url',
      description: 'Otvorí webovú stránku v predvolenom prehliadači. Celá adresa s https://.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      handler: async ({ url }) => {
        const r = await openUrl(url)
        return r.ok ? `Otvorené: ${url}` : { text: `Nepodarilo sa otvoriť: ${r.error}`, isError: true }
      },
    },
  ],
})
