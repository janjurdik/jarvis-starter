/**
 * Where Jarvis lives on this computer. Three places, the user picks one during setup and can change it
 * in Settings:
 *
 *   desktop  macOS only: the "Jarvis HUD" app, Jarvis as the desktop under all windows
 *   app      his own window like any other program, opened with a Jarvis icon
 *            (~/Applications/Jarvis.app, on Windows a shortcut on the desktop and in the Start menu)
 *   browser  a plain page in the user's own browser, opened when he wants it
 *
 * `web` is what 1.8.0 called the window and still means it, so nobody's Jarvis moves on an update.
 * The choice is `surface` in config/jarvis.json (Settings) or, before Jarvis is set up, in data/setup.json.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SURFACES = ['desktop', 'app', 'browser']

/** One of SURFACES, or null for anything else. */
export function normalizeSurface(value) {
  const v = String(value ?? '').trim().toLowerCase()
  if (v === 'web' || v === 'window') return 'app'
  if (v === 'page' || v === 'tab') return 'browser'
  return SURFACES.includes(v) ? v : null
}

/** What this computer can offer. The desktop needs the macOS app. */
export const surfacesFor = (platform = process.platform) => (platform === 'darwin' ? SURFACES : SURFACES.filter((s) => s !== 'desktop'))

const readKey = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).surface ?? null
  } catch {
    return null
  }
}

/**
 * { surface, raw }: the place that applies and the value it came from (null when nothing was chosen).
 * The config wins over what setup wrote down. Without a choice: the desktop on a Mac, a window elsewhere.
 */
export function resolveSurface({ configFile, dataDir, config = undefined, platform = process.platform } = {}) {
  const fallback = platform === 'darwin' ? 'desktop' : 'app'
  const values = [config === undefined ? (configFile ? readKey(configFile) : null) : config, dataDir ? readKey(join(dataDir, 'setup.json')) : null]
  for (const raw of values) {
    const s = normalizeSurface(raw)
    if (!s) continue
    return { surface: surfacesFor(platform).includes(s) ? s : fallback, raw: String(raw).toLowerCase() }
  }
  return { surface: fallback, raw: null }
}
