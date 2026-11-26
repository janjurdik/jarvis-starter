/**
 * The Cloudflare tunnel that carries Jarvis to the phone (docs/MOBIL.md). The server runs
 * `cloudflared` as its own child while mobile access is on, starts it again when it falls, and
 * opens it again after a restart of the server.
 *
 *   quick   no account: `cloudflared tunnel --url http://127.0.0.1:<port>`, a random
 *           https://<words>.trycloudflare.com address that changes on every start
 *   named   the user's own tunnel from the Cloudflare dashboard: `cloudflared tunnel run` with the
 *           token in the environment (never on the command line, where every process could read it)
 *
 * Output goes to data/logs/tunnel.log. Finding and installing cloudflared is here too, the server
 * and scripts/tunnel.mjs share it.
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import { DATA_DIR, IS_MAC, IS_WIN, errMsg, findBin, log } from './util.mjs'

export const BIN_DIR = join(DATA_DIR, 'bin')
export const LOG_FILE = join(DATA_DIR, 'logs', 'tunnel.log')
const EMPTY_CONFIG = join(DATA_DIR, 'tunnel', 'empty.yml')
const WIN_DIRS = ['C:\\Program Files (x86)\\cloudflared', 'C:\\Program Files\\cloudflared']

// ── reading cloudflared's output ──────────────────────────────────────────

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

/** The address of a quick tunnel in one line of output, or null. */
export function parseQuickUrl(line) {
  const m = /https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)\.trycloudflare\.com\b/i.exec(String(line))
  return m && m[1] !== 'api' ? `https://${m[1].toLowerCase()}.trycloudflare.com` : null
}

/** A connection to Cloudflare's edge is up: from now on the address works. */
export const isConnected = (line) => /Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(String(line))

/**
 * An error line worth showing, cleaned of time stamps and of anything that looks like a token.
 * Plain noise (retries that will be followed by success) is left out by the caller via `isConnected`.
 */
export function parseError(line) {
  const s = String(line).replace(ANSI, '').trim()
  if (!/\b(ERR|FTL|error|failed)\b/i.test(s)) return null
  const msg = s
    .replace(/^\S*\d{4}-\d{2}-\d{2}T\S+\s+/, '')
    .replace(/^(ERR|FTL|INF|WRN)\s+/, '')
    .replace(/[A-Za-z0-9+/=_-]{60,}/g, '…')
    .slice(0, 220)
  return msg || null
}

// ── finding and installing cloudflared ────────────────────────────────────

/** Path to cloudflared: JARVIS_CLOUDFLARED, PATH, the usual install places, then data/bin. */
export function cloudflaredBin() {
  const override = process.env.JARVIS_CLOUDFLARED
  if (override) return existsSync(override) ? override : null
  return findBin('cloudflared', { extraDirs: [...(IS_WIN ? WIN_DIRS : []), BIN_DIR] })
}

export function cloudflaredVersion(bin = cloudflaredBin()) {
  if (!bin) return null
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
  const m = /version\s+(\d{4}\.\d+\.\d+)/i.exec(`${r.stdout ?? ''}${r.stderr ?? ''}`)
  return r.status === 0 && m ? m[1] : null
}

/** The official release file for this computer on github.com/cloudflare/cloudflared. */
export function releaseAsset(os = platform(), cpu = arch()) {
  const a = cpu === 'arm64' ? 'arm64' : cpu === 'x64' ? 'amd64' : cpu === 'arm' ? 'arm' : cpu === 'ia32' ? '386' : null
  if (!a) return null
  if (os === 'darwin') return { name: `cloudflared-darwin-${a === 'arm64' ? 'arm64' : 'amd64'}.tgz`, tgz: true }
  if (os === 'win32') return { name: `cloudflared-windows-${a === '386' ? '386' : 'amd64'}.exe`, tgz: false }
  if (os === 'linux') return { name: `cloudflared-linux-${a}`, tgz: false }
  return null
}

const run = (bin, args, timeout = 600_000) => spawnSync(bin, args, { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) })
  if (!res.ok) throw new Error(`sťahovanie ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 1_000_000) throw new Error('stiahnutý súbor je podozrivo malý')
  writeFileSync(file, buf, { mode: 0o755 })
}

/**
 * Makes sure cloudflared is on this computer. Order: what is already there, Homebrew on a Mac,
 * winget on Windows, otherwise the official binary from GitHub into data/bin. Every path ends with
 * a check that the program runs. → { ok, bin, version, via } or { ok: false, error }.
 */
export async function installCloudflared({ say = () => {} } = {}) {
  let bin = cloudflaredBin()
  let version = cloudflaredVersion(bin)
  if (version) return { ok: true, bin, version, via: 'already' }

  if (IS_MAC) {
    const brew = findBin('brew', { extraDirs: ['/opt/homebrew/bin', '/usr/local/bin'] })
    if (brew) {
      say('Inštalujem cloudflared cez Homebrew…')
      const r = run(brew, ['install', 'cloudflared'])
      bin = cloudflaredBin()
      version = cloudflaredVersion(bin)
      if (version) return { ok: true, bin, version, via: 'brew' }
      say(`Homebrew to nezvládol (${String(r.stderr ?? '').trim().split('\n').pop() || `kód ${r.status}`}), skúšam priamo z GitHubu.`)
    }
  }
  if (IS_WIN) {
    const winget = findBin('winget')
    if (winget) {
      say('Inštalujem cloudflared cez winget…')
      run(winget, ['install', '--id', 'Cloudflare.cloudflared', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'])
      bin = cloudflaredBin()
      version = cloudflaredVersion(bin)
      if (version) return { ok: true, bin, version, via: 'winget' }
      say('winget to nezvládol, skúšam priamo z GitHubu.')
    }
  }

  const asset = releaseAsset()
  if (!asset) return { ok: false, error: `Pre tento počítač (${platform()} ${arch()}) nemá Cloudflare hotový program.` }
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.name}`
  const target = join(BIN_DIR, IS_WIN ? 'cloudflared.exe' : 'cloudflared')
  try {
    mkdirSync(BIN_DIR, { recursive: true })
    say('Sťahujem cloudflared z github.com/cloudflare/cloudflared…')
    const tmp = join(BIN_DIR, `.${asset.name}.part`)
    await download(url, tmp)
    if (asset.tgz) {
      const r = run('tar', ['-xzf', tmp, '-C', BIN_DIR], 60_000)
      rmSync(tmp, { force: true })
      if (r.status !== 0 || !existsSync(target)) throw new Error('archív sa nepodarilo rozbaliť')
    } else {
      renameSync(tmp, target)
    }
    if (!IS_WIN) chmodSync(target, 0o755)
  } catch (err) {
    return { ok: false, error: `cloudflared sa nepodarilo stiahnuť: ${errMsg(err)}` }
  }
  version = cloudflaredVersion(target)
  if (!version) {
    rmSync(target, { force: true })
    return { ok: false, error: 'Stiahnutý cloudflared sa nedá spustiť.' }
  }
  return { ok: true, bin: target, version, via: 'github' }
}

// ── the supervisor ────────────────────────────────────────────────────────

function writeLog(line) {
  try {
    mkdirSync(join(DATA_DIR, 'logs'), { recursive: true })
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line.replace(ANSI, '')}\n`)
  } catch {
    // a log that cannot be written must not stop the tunnel
  }
}

/** Keeps tunnel.log short: over 2 MB the old half goes to tunnel.log.1. */
function rotateLog() {
  try {
    if (statSync(LOG_FILE).size > 2_000_000) renameSync(LOG_FILE, `${LOG_FILE}.1`)
  } catch {
    // no log yet
  }
}

/**
 * One tunnel for this server. `config()` → { mode, hostname, token } at the moment of the start.
 * `onChange(status)` is called on every change of the status.
 */
export function createTunnel({ port, config, onChange = () => {} }) {
  let child = null
  let want = false
  let restartTimer = null
  let backoff = 2000
  let upSince = 0
  let installing = null
  let st = { state: 'off', mode: null, url: null, hostname: null, error: null, since: null, pid: null }

  const update = (patch) => {
    st = { ...st, ...patch }
    onChange(status())
  }

  function status() {
    return { ...st, installing: Boolean(installing) }
  }

  /** Host names this server answers to through the tunnel: only while it runs. */
  function hosts() {
    if (!child || !['starting', 'running'].includes(st.state)) return []
    const out = []
    if (st.url) out.push(new URL(st.url).hostname)
    if (st.mode === 'named' && st.hostname) out.push(st.hostname)
    return out
  }

  function spawnChild(bin) {
    const cfg = config()
    const mode = cfg.mode === 'named' ? 'named' : 'quick'
    if (mode === 'named' && (!cfg.token || !cfg.hostname)) {
      want = false
      return update({ state: 'error', mode, error: 'Vlastný tunel potrebuje adresu aj token z Cloudflare (Nastavenia, Mobil).' })
    }
    // A config.yml of another tunnel in ~/.cloudflared would hijack a quick tunnel: an empty one is passed instead.
    mkdirSync(join(DATA_DIR, 'tunnel'), { recursive: true })
    if (!existsSync(EMPTY_CONFIG)) writeFileSync(EMPTY_CONFIG, '# Jarvis: prázdna konfigurácia pre rýchly tunel\n')
    const args = mode === 'quick' ? ['tunnel', '--no-autoupdate', '--config', EMPTY_CONFIG, '--url', `http://127.0.0.1:${port}`] : ['tunnel', '--no-autoupdate', 'run']
    const env = { ...process.env }
    delete env.TUNNEL_TOKEN
    if (mode === 'named') env.TUNNEL_TOKEN = cfg.token
    rotateLog()
    writeLog(`── štart (${mode === 'quick' ? 'rýchly tunel' : `vlastný tunel ${cfg.hostname}`}) ──`)
    let proc
    try {
      proc = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      return update({ state: 'error', mode, error: `cloudflared sa nespustil: ${errMsg(err)}` })
    }
    child = proc
    update({ state: 'starting', mode, url: mode === 'named' ? `https://${cfg.hostname}` : null, hostname: mode === 'named' ? cfg.hostname : null, error: null, since: Date.now(), pid: proc.pid })
    let buf = ''
    const onData = (chunk) => {
      buf += chunk.toString('utf8')
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        writeLog(line)
        if (proc !== child) continue
        const url = mode === 'quick' ? parseQuickUrl(line) : null
        if (url && url !== st.url) update({ url })
        if (isConnected(line)) {
          if (st.state !== 'running') {
            upSince = Date.now()
            log('tunnel', `tunel beží: ${st.url ?? ''}`)
            update({ state: 'running', error: null })
          }
          continue
        }
        const err = parseError(line)
        if (err && st.state !== 'running') st = { ...st, error: err }
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('error', (err) => {
      if (proc !== child) return
      update({ state: 'error', error: `cloudflared: ${errMsg(err)}` })
    })
    proc.on('exit', (code, signal) => {
      writeLog(`── koniec (${signal ?? code}) ──`)
      if (proc !== child) return
      child = null
      if (!want) return update({ state: 'off', url: null, pid: null, since: null, error: null })
      // A tunnel that ran a while starts again quickly, one that keeps falling waits longer each time.
      backoff = upSince && Date.now() - upSince > 300_000 ? 2000 : Math.min(60_000, backoff * 2)
      upSince = 0
      log('tunnel', `cloudflared skončil (${signal ?? code}), znova o ${Math.round(backoff / 1000)} s`)
      update({ state: 'error', url: null, pid: null, error: st.error ?? `cloudflared skončil (${signal ?? code})` })
      clearTimeout(restartTimer)
      restartTimer = setTimeout(() => want && launch(), backoff)
      restartTimer.unref?.()
    })
  }

  async function launch() {
    if (child || !want) return
    let bin = cloudflaredBin()
    if (!bin) {
      if (!installing) {
        update({ state: 'starting', error: null })
        installing = installCloudflared({ say: (t) => writeLog(t) }).finally(() => (installing = null))
      }
      const r = await installing
      if (!r.ok) {
        want = false
        return update({ state: 'error', error: r.error })
      }
      bin = r.bin
      log('tunnel', `cloudflared ${r.version} pripravený (${r.via})`)
    }
    if (!child && want) spawnChild(bin)
  }

  function start() {
    want = true
    backoff = 2000
    clearTimeout(restartTimer)
    return launch()
  }

  function stop() {
    want = false
    clearTimeout(restartTimer)
    const proc = child
    child = null
    if (proc) {
      proc.kill('SIGTERM')
      setTimeout(() => proc.exitCode === null && proc.kill('SIGKILL'), 3000).unref?.()
    }
    update({ state: 'off', url: null, pid: null, since: null, error: null })
  }

  async function restart() {
    stop()
    await new Promise((r) => setTimeout(r, 300))
    return start()
  }

  process.on('exit', () => child?.kill('SIGTERM'))
  return { start, stop, restart, status, hosts, wanted: () => want }
}
