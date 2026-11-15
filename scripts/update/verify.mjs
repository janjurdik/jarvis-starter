/**
 * Proof that the install still works after an update: every script parses, the doctor still
 * reports the same readiness, and the HUD server really starts and answers.
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { REPO, abs, exists, mapLimit, sh } from './core.mjs'

/** Runs the doctor and reads its verdict. { parsed, ready, failing }. Never throws. */
export async function doctorReady() {
  if (!exists(abs('scripts/doctor.mjs'))) return { parsed: false, ready: null, detail: 'scripts/doctor.mjs chýba' }
  const res = await sh(process.execPath, [abs('scripts/doctor.mjs'), '--json'], { timeout: 90_000 })
  try {
    const data = JSON.parse(res.out.slice(res.out.indexOf('{'), res.out.lastIndexOf('}') + 1))
    return { parsed: true, ready: data.ready === true, failing: (data.checks ?? []).filter((c) => !c.ok).map((c) => c.id) }
  } catch {
    return { parsed: false, ready: null, detail: res.out.slice(-400) }
  }
}

function modules(dir, prefix) {
  const out = []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'node_modules') out.push(...modules(join(dir, e.name), `${prefix}/${e.name}`))
    else if (e.isFile() && e.name.endsWith('.mjs')) out.push(`${prefix}/${e.name}`)
  }
  return out
}

/** `node --check` on every .mjs of the scripts and the HUD server. Returns the files that fail. */
export async function syntaxCheck() {
  const files = ['hud/server.mjs', ...modules(join(REPO, 'hud', 'server'), 'hud/server'), ...modules(join(REPO, 'scripts'), 'scripts')].filter((rel) => exists(abs(rel)))
  const failed = []
  await mapLimit(files, 4, async (rel) => {
    const res = await sh(process.execPath, ['--check', abs(rel)], { timeout: 30_000 })
    if (res.code !== 0) failed.push({ file: rel, detail: res.out.slice(0, 600) })
  })
  return { count: files.length, failed: failed.sort((a, b) => (a.file < b.file ? -1 : 1)) }
}

const freePort = () =>
  new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })

/**
 * Starts the HUD server as a second, mock instance on a free port (it leaves the saved state and
 * the running HUD alone), waits for /api/health and the page itself, then stops it.
 */
export async function smoke({ wait = 30_000 } = {}) {
  if (process.env.JARVIS_UPDATE_SMOKE === '0') return { ok: true, skipped: true, detail: 'preskočené (JARVIS_UPDATE_SMOKE=0)' }
  let port
  try {
    port = await freePort()
  } catch {
    return { ok: false, detail: 'nenašiel sa voľný port' }
  }
  let log = ''
  let exited = false
  const child = spawn(process.execPath, [abs('hud/server.mjs')], {
    cwd: REPO,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), HUD_PORT: String(port), JARVIS_SECONDARY: '1', JARVIS_MOCK: '1', JARVIS_BRAIN_AUTOSTART: '0', JARVIS_UPDATE_CHECK: '0' },
  })
  child.stdout.on('data', (d) => (log = `${log}${d}`.slice(-4000)))
  child.stderr.on('data', (d) => (log = `${log}${d}`.slice(-4000)))
  child.on('error', (err) => {
    log += err.message
    exited = true
  })
  child.on('exit', () => (exited = true))

  const get = async (path) => {
    try {
      return await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2500) })
    } catch {
      return null
    }
  }
  let health = false
  let page = 0
  const until = Date.now() + wait
  while (Date.now() < until && !exited) {
    const res = await get('/api/health')
    if (res?.ok) {
      health = (await res.json().catch(() => null))?.ok === true
      if (health) {
        page = (await get('/'))?.status ?? 0
        break
      }
    }
    await new Promise((r) => setTimeout(r, 300))
  }

  if (!exited) {
    child.kill()
    for (let i = 0; i < 30 && !exited; i++) await new Promise((r) => setTimeout(r, 100))
    if (!exited) child.kill('SIGKILL')
  }
  const ok = health && page === 200
  const detail = ok ? `server naštartoval na porte ${port}, /api/health aj stránka odpovedajú` : exited && !health ? `server spadol pri štarte: ${log.trim().slice(-600)}` : !health ? 'server neodpovedal na /api/health' : `stránka vrátila ${page}`
  return { ok, port, detail }
}
