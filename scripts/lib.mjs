/**
 * Shared helpers for the command line scripts (doctor, hud, routine, schedule, autostart).
 * Loads .env first, then reuses the same building blocks as the HUD server.
 */
import '../hud/server/env.mjs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, IS_MAC, IS_WIN, REPO, findBin, spawnBin } from '../hud/server/util.mjs'

export { DATA_DIR, IS_MAC, IS_WIN, REPO, findBin, spawnBin }

export const PORT = Number(process.env.PORT ?? process.env.HUD_PORT ?? 4545)
export const HUD_URL = `http://127.0.0.1:${PORT}`
export const LOG_DIR = join(DATA_DIR, 'logs')
/** Label prefix of everything Jarvis registers in the system (launchd agents, scheduled tasks). */
export const LABEL = 'com.jarvis-starter'
export const TASK_FOLDER = 'Jarvis'

export const has = (path) => existsSync(path)

/** Runs a command and returns { code, out }. Never throws. */
export function sh(bin, args = [], { timeout = 20_000, cwd = REPO, input = null } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, out: out.trim() })
    }
    let child
    try {
      child = spawnBin(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      return resolve({ code: 1, out: String(err?.message ?? err) })
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(124)
    }, timeout)
    child.stdout.on('data', (d) => (out = `${out}${d}`.slice(-200_000)))
    child.stderr.on('data', (d) => (out = `${out}${d}`.slice(-200_000)))
    child.on('error', (err) => {
      out = `${out}${err.message}`
      finish(1)
    })
    child.on('exit', (code) => finish(code ?? 1))
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

export async function hudAlive() {
  try {
    const res = await fetch(`${HUD_URL}/api/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

export async function postHud(path, body) {
  try {
    const res = await fetch(`${HUD_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
    return res.ok
  } catch {
    return false
  }
}

/** Flags like --dry-run and --json, plus positional arguments. */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2)))
  const rest = argv.filter((a) => !a.startsWith('--'))
  return { flags, rest }
}
