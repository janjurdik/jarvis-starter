/**
 * Watches for new versions of Jarvis while the HUD runs: a first look two minutes after the start,
 * then every twelve hours. A new version is announced once, the update itself always waits for
 * the user's yes (docs/AKTUALIZACIE.md). Turn it off with JARVIS_UPDATE_CHECK=0 in .env or
 * "update": { "check": false } in config/jarvis.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cachedCheck, check } from '../../scripts/update/check.mjs'
import { checkEnabled } from '../../scripts/update/source.mjs'
import { DATA_DIR, errMsg, log } from './util.mjs'

const FIRST_CHECK_MS = 2 * 60_000
const EVERY_MS = 12 * 3600_000
const ANNOUNCED_FILE = join(DATA_DIR, 'update', 'announced.json')

function announcedVersion() {
  try {
    return JSON.parse(readFileSync(ANNOUNCED_FILE, 'utf8')).version ?? null
  } catch {
    return null
  }
}

function rememberAnnounced(version) {
  try {
    mkdirSync(join(DATA_DIR, 'update'), { recursive: true })
    writeFileSync(ANNOUNCED_FILE, `${JSON.stringify({ version, at: new Date().toISOString() }, null, 2)}\n`)
  } catch (err) {
    log('update', `oznámenú verziu sa nepodarilo zapísať: ${errMsg(err)}`)
  }
}

/**
 * Starts the periodic check. `onAvailable({ version, summary, changelog })` is called at most once
 * per upstream version, also across restarts. Returns { stop, checkNow }.
 */
export function startUpdateWatch({ onAvailable } = {}) {
  if (!checkEnabled()) return { stop() {}, checkNow: async () => null }
  let running = false
  const run = async () => {
    if (running || !checkEnabled()) return null
    running = true
    try {
      const res = await check()
      if (res.ok && res.available && !res.inProgress && res.latest.version !== announcedVersion()) {
        // Remembered first: a handler that throws must not make Jarvis repeat himself every twelve hours.
        rememberAnnounced(res.latest.version)
        log('update', `nová verzia ${res.latest.version} (nainštalovaná ${res.current.version})`)
        await onAvailable?.({ version: res.latest.version, summary: res.summary, changelog: res.changelog })
      }
      return res
    } catch (err) {
      log('update', errMsg(err))
      return null
    } finally {
      running = false
    }
  }
  const first = setTimeout(run, FIRST_CHECK_MS)
  const every = setInterval(run, EVERY_MS)
  first.unref()
  every.unref()
  return {
    stop() {
      clearTimeout(first)
      clearInterval(every)
    },
    checkNow: run,
  }
}

/**
 * What the last check found, for an API route. Never touches the network.
 * { checked, at, ok, available, current, latest, summary, changelog, customized, mode, announced }
 */
export async function updateInfo() {
  const cached = cachedCheck()
  if (!cached) return { checked: false, enabled: checkEnabled(), available: false, current: null, latest: null, summary: '', changelog: '', announced: announcedVersion() }
  return {
    checked: true,
    enabled: checkEnabled(),
    at: cached.at ?? null,
    ok: cached.ok === true,
    available: cached.available === true,
    current: cached.current ?? null,
    latest: cached.latest ?? null,
    summary: cached.summary ?? '',
    changelog: cached.changelog ?? '',
    customized: cached.customized ?? null,
    mode: cached.mode ?? null,
    inProgress: cached.inProgress === true,
    announced: announcedVersion(),
  }
}
