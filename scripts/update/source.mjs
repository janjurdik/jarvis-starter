/**
 * Where new versions come from: a GitHub repository (default janjurdik/jarvis-starter, branch main)
 * or, with JARVIS_UPDATE_SOURCE, a local folder or .tar.gz that replaces all network access.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { DEFAULT_BRANCH, DEFAULT_REPO, IS_WIN, P, REPO, abs, copyInto, exists, findBin, git, installMode, readBuf, readJson, rmDir, sh, walk } from './core.mjs'
import { extractTarGz } from './untar.mjs'

const REPO_RE = /^[\w.-]+\/[\w.-]+$/
const BRANCH_RE = /^[\w][\w./-]{0,100}$/
const pick = (value, re) => (typeof value === 'string' && re.test(value.trim()) ? value.trim() : null)

/** The upstream this install follows: environment first, then config/jarvis.json, then the default. */
export function upstream() {
  const cfg = readJson(process.env.JARVIS_CONFIG || join(REPO, 'config', 'jarvis.json'))?.update ?? {}
  const repo = pick(process.env.JARVIS_UPDATE_REPO, REPO_RE) ?? pick(cfg.repo, REPO_RE) ?? DEFAULT_REPO
  const branch = pick(process.env.JARVIS_UPDATE_BRANCH, BRANCH_RE) ?? pick(cfg.branch, BRANCH_RE) ?? DEFAULT_BRANCH
  const source = process.env.JARVIS_UPDATE_SOURCE || null
  return { repo, branch, source, baseSource: process.env.JARVIS_UPDATE_BASE_SOURCE || null, label: source ? `lokálny zdroj ${source}` : `${repo} (${branch})` }
}

/** Automatic checks can be turned off in .env (JARVIS_UPDATE_CHECK=0) or in config ("update": { "check": false }). */
export function checkEnabled() {
  if (process.env.JARVIS_UPDATE_CHECK === '0') return false
  return readJson(process.env.JARVIS_CONFIG || join(REPO, 'config', 'jarvis.json'))?.update?.check !== false
}

/** GET as a Buffer. Never throws: { ok, buf } or { ok: false, reason: "offline" | "not-found" | "http-500" }. */
export async function fetchBuf(url, timeout = 8000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'follow', headers: { 'user-agent': 'jarvis-updater' } })
    if (!res.ok) return { ok: false, reason: res.status === 404 ? 'not-found' : `http-${res.status}` }
    return { ok: true, buf: Buffer.from(await res.arrayBuffer()) }
  } catch {
    return { ok: false, reason: 'offline' }
  }
}

const rawUrl = (repo, ref, rel) => `https://raw.githubusercontent.com/${repo}/${ref.split('/').map(encodeURIComponent).join('/')}/${rel.split('/').map(encodeURIComponent).join('/')}`

function systemTar() {
  if (process.env.JARVIS_UPDATE_TAR === '0') return null
  if (IS_WIN) {
    // The tar that ships with Windows 10+. A GNU tar from Git Bash earlier on PATH misreads "C:\..." paths.
    const own = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    if (exists(own)) return own
  }
  return findBin('tar')
}

/** Unpacks a .tar.gz without its top folder. System tar first, the built-in unpacker as the fallback. */
export async function unpack(file, dest) {
  rmDir(dest)
  mkdirSync(dest, { recursive: true })
  const tar = systemTar()
  if (tar) {
    // Relative names keep drive letters out of the arguments.
    const res = await sh(tar, ['-xzf', basename(file), '-C', relative(dirname(file), dest) || '.', '--strip-components=1'], { cwd: dirname(file), timeout: 180_000 })
    if (res.code === 0 && walk(dest, { limit: 1 }).length) return 'tar'
    rmDir(dest)
    mkdirSync(dest, { recursive: true })
  }
  try {
    return extractTarGz(file, dest) > 0 ? 'node' : null
  } catch {
    return null
  }
}

const trees = new Map()
/** A local source as a folder: the folder itself, or the archive unpacked into `scratch` (once per run). */
async function localTree(source, scratch) {
  if (trees.has(source)) return trees.get(source)
  let dir = null
  try {
    if (statSync(source).isDirectory()) dir = source
    else if (await unpack(source, scratch)) dir = scratch
  } catch {
    dir = null
  }
  trees.set(source, dir)
  return dir
}

/** One file of the newest upstream version, for `check`. { ok, buf } or { ok: false, reason }. */
export async function readUpstream(rel, up = upstream()) {
  if (up.source) {
    const dir = await localTree(up.source, join(P.tmp, 'peek'))
    if (!dir) return { ok: false, reason: 'source-missing' }
    const buf = readBuf(abs(rel, dir))
    return buf ? { ok: true, buf } : { ok: false, reason: 'not-found' }
  }
  return fetchBuf(rawUrl(up.repo, up.branch, rel))
}

/** Downloads the whole newest version into data/update/incoming. { ok, how } or { ok: false, reason }. */
export async function fetchIncoming(up = upstream()) {
  rmDir(P.incoming)
  mkdirSync(P.incoming, { recursive: true })
  let how = null
  if (up.source) {
    let isDir = false
    try {
      isDir = statSync(up.source).isDirectory()
    } catch {
      return { ok: false, reason: 'source-missing' }
    }
    if (isDir) {
      for (const rel of walk(up.source)) copyInto(abs(rel, up.source), abs(rel, P.incoming))
      how = 'folder'
    } else {
      how = await unpack(up.source, P.incoming)
    }
  } else {
    const res = await fetchBuf(`https://codeload.github.com/${up.repo}/tar.gz/refs/heads/${up.branch}`, 180_000)
    if (!res.ok) return { ok: false, reason: res.reason }
    const file = join(P.tmp, 'incoming.tar.gz')
    mkdirSync(P.tmp, { recursive: true })
    writeFileSync(file, res.buf)
    how = await unpack(file, P.incoming)
    rmDir(P.tmp)
  }
  if (!how || !exists(join(P.incoming, 'package.json'))) return { ok: false, reason: 'bad-archive' }
  return { ok: true, how }
}

/** Revisions of the local git history where the pristine version of a file may live. */
async function gitRevs(bin, version, ref) {
  const run = (args) => spawnSync(bin, args, { cwd: REPO, encoding: 'utf8', windowsHide: true })
  const revs = []
  for (const rev of [`v${version}`, ref].filter(Boolean)) {
    if (run(['rev-parse', '--verify', '-q', `${rev}^{commit}`]).status === 0) revs.push(rev)
  }
  const remotes = run(['for-each-ref', '--format=%(refname)', 'refs/remotes'])
  for (const name of remotes.status === 0 ? remotes.stdout.split('\n').filter(Boolean) : []) {
    const mb = run(['merge-base', 'HEAD', name])
    if (mb.status === 0 && mb.stdout.trim()) revs.push(mb.stdout.trim())
  }
  return [...new Set(revs)]
}

/**
 * Returns `find(rel, accept)`: looks for the pristine content of a shipped file of `version` and
 * hands back the first candidate `accept` agrees with (the caller checks the hash from the manifest,
 * so a wrong candidate can never become a baseline). Order: JARVIS_UPDATE_BASE_SOURCE, upstream at
 * the release ref and the tag v<version>, then the local git history.
 */
export function baseFinder({ version, ref = null }) {
  const up = upstream()
  let revs = null
  return async (rel, accept) => {
    if (up.baseSource) {
      const dir = await localTree(up.baseSource, join(P.tmp, 'base-peek'))
      const buf = dir ? readBuf(abs(rel, dir)) : null
      if (buf && accept(buf)) return buf
    }
    if (!up.source) {
      for (const at of [ref, `v${version}`].filter(Boolean)) {
        const res = await fetchBuf(rawUrl(up.repo, at, rel), 12_000)
        if (res.ok && accept(res.buf)) return res.buf
        if (!res.ok && res.reason === 'offline') break
      }
    }
    const bin = installMode() === 'git' ? await git() : null
    if (bin) {
      revs ??= await gitRevs(bin, version, ref)
      const log = spawnSync(bin, ['log', '-n', '25', '--format=%H', '--', rel], { cwd: REPO, encoding: 'utf8', windowsHide: true })
      const own = log.status === 0 ? log.stdout.split('\n').filter(Boolean) : []
      for (const rev of [...revs, ...own]) {
        const res = spawnSync(bin, ['show', `${rev}:${rel}`], { cwd: REPO, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
        if (res.status === 0 && res.stdout && accept(res.stdout)) return res.stdout
      }
    }
    return null
  }
}
