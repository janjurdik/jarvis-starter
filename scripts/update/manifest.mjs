/**
 * The manifest (jarvis.manifest.json): which files a version ships and the identity of each one.
 * { name, version, released, files: { "<posix path>": "<sha256, text with LF line ends>" } }
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { MANIFEST, REPO, abs, exists, fileHash, git, isNoise, isProtected, parseVersion, readBuf, readJson, safeRel, walk } from './core.mjs'

/** Reads and cleans a manifest. Returns null when the file is missing or is not a manifest. */
export function readManifest(file) {
  return cleanManifest(readJson(file))
}

export function cleanManifest(raw) {
  if (!raw || typeof raw !== 'object' || !parseVersion(raw.version) || !raw.files || typeof raw.files !== 'object') return null
  const files = {}
  for (const [rel, hash] of Object.entries(raw.files)) {
    if (safeRel(rel) && typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) && !isProtected(rel) && rel !== MANIFEST) files[rel] = hash
  }
  return {
    name: typeof raw.name === 'string' ? raw.name : 'jarvis-starter',
    version: String(raw.version).replace(/^v/, ''),
    released: typeof raw.released === 'string' ? raw.released : null,
    ref: typeof raw.ref === 'string' && /^[\w./-]{1,80}$/.test(raw.ref) ? raw.ref : null,
    files,
  }
}

/** Identity of every given file under `root`. Files that do not exist are left out. */
export function hashFiles(root, paths) {
  const files = {}
  for (const rel of [...paths].sort()) {
    const buf = readBuf(abs(rel, root))
    if (buf) files[rel] = fileHash(buf)
  }
  return files
}

/**
 * Files a release ships. In a git repository: everything tracked plus new files that are not
 * ignored (what `git add -A` would commit). Elsewhere: every file except protected paths and litter.
 */
export async function shippedFiles(root = REPO) {
  const bin = exists(join(root, '.git')) ? await git() : null
  let list = null
  if (bin) {
    const res = spawnSync(bin, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
    if (res.status === 0) list = res.stdout.split('\0').filter(Boolean)
  }
  list ??= walk(root)
  return list.filter((rel) => safeRel(rel) && rel !== MANIFEST && rel !== `${MANIFEST}.sig` && !isProtected(rel) && !isNoise(rel) && exists(abs(rel, root))).sort()
}

export function packageVersion(root = REPO) {
  const v = readJson(join(root, 'package.json'))?.version
  return parseVersion(v) ? String(v) : null
}

/**
 * The shipped tree of an unpacked version as a manifest. The files on disk are the truth: the
 * manifest file inside only supplies the version and the release date, so a manifest the author
 * forgot to regenerate cannot break an update.
 */
export function treeManifest(root) {
  const declared = readManifest(join(root, MANIFEST))
  const version = declared?.version ?? packageVersion(root)
  if (!version) return null
  const files = hashFiles(root, walk(root, { keep: (rel) => rel !== MANIFEST }))
  const stale = declared ? Object.keys(files).filter((rel) => declared.files[rel] !== files[rel]).length + Object.keys(declared.files).filter((rel) => !(rel in files)).length : 0
  return { name: declared?.name ?? 'jarvis-starter', version, released: declared?.released ?? null, files, declared: Boolean(declared), stale }
}

export const manifestText = ({ name, version, released, ref, files }) =>
  `${JSON.stringify({ name, version, released, ...(ref ? { ref } : {}), files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) }, null, 2)}\n`
