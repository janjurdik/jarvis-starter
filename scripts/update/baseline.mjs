/**
 * The baseline: a pristine copy of the version this install started from. Three-way merging needs
 * it to tell the user's changes from upstream's changes.
 *
 *   data/update/base/        the pristine files
 *   data/update/state.json   { version, at, source, ref, files: { path: hash }, missing: [paths] }
 *
 * It is captured as early as possible (the first check), while most files are still untouched:
 * a local file whose hash equals the manifest hash IS the pristine file. Files the user changed
 * before that are looked up upstream at the release tag or in the local git history, and only
 * accepted when their hash matches the manifest.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MANIFEST, P, REPO, abs, cmpVersion, copyInto, exists, fileHash, isGenerated, isProtected, mapLimit, readBuf, readJson, rmDir, writeFile, writeJson } from './core.mjs'
import { cleanManifest, packageVersion, readManifest } from './manifest.mjs'
import { baseFinder, readUpstream } from './source.mjs'

export const localManifest = () => readManifest(join(REPO, MANIFEST))
export const loadState = () => {
  const state = readJson(P.state)
  return state && typeof state.version === 'string' && state.files && typeof state.files === 'object' ? state : null
}

/** A manifest for an install that has none: the author can publish one per old version in updates/manifests/. */
async function retroManifest(version, incomingDir, network) {
  if (!version) return null
  const rel = `updates/manifests/${version}.json`
  if (incomingDir) {
    const found = readManifest(abs(rel, incomingDir))
    if (found) return found
  }
  if (!network) return null
  const res = await readUpstream(rel)
  if (!res.ok) return null
  try {
    return cleanManifest(JSON.parse(res.buf.toString('utf8')))
  } catch {
    return null
  }
}

/** Starts a fresh baseline from a manifest: every local file that still matches becomes its own base. */
function capture(manifest, source) {
  rmDir(P.base)
  mkdirSync(P.base, { recursive: true })
  const files = {}
  const missing = []
  for (const [rel, hash] of Object.entries(manifest.files)) {
    if (isProtected(rel)) continue
    files[rel] = hash
    const buf = readBuf(abs(rel))
    if (buf && fileHash(buf) === hash) copyInto(abs(rel), abs(rel, P.base))
    else missing.push(rel)
  }
  const state = { version: manifest.version, at: new Date().toISOString(), source, ref: manifest.ref ?? null, files, missing }
  writeJson(P.state, state)
  return state
}

/**
 * Makes sure a baseline exists and says how complete it is.
 *   fetch        also look for the pristine version of files the user changed (network, git history)
 *   retro        an install without a manifest may ask upstream for updates/manifests/<version>.json
 *   incomingDir  an unpacked upstream version that may carry that file
 * Returns { kind: "full" | "partial" | "none", version, files, missing }.
 */
export async function ensureBaseline({ fetch = false, retro = fetch, incomingDir = null } = {}) {
  const manifest = localManifest()
  let state = loadState()
  // A manifest newer than the saved baseline means the files were replaced some other way (git pull).
  if (state && manifest && cmpVersion(state.version, manifest.version) !== 0) state = null
  if (state && !exists(P.base)) state = null
  if (!state) {
    if (manifest) state = capture(manifest, 'manifest')
    else {
      const old = await retroManifest(packageVersion(), incomingDir, retro)
      if (old) state = capture(old, 'retro')
    }
  }
  if (!state) return { kind: 'none', version: null, files: {}, missing: [] }

  if (fetch && state.missing.length) {
    const find = baseFinder({ version: state.version, ref: state.ref })
    const still = []
    await mapLimit(state.missing, 6, async (rel) => {
      const buf = await find(rel, (candidate) => fileHash(candidate) === state.files[rel])
      if (buf) writeFile(abs(rel, P.base), buf)
      else still.push(rel)
    })
    if (still.length !== state.missing.length) {
      state.missing = still.sort()
      writeJson(P.state, state)
    }
  }
  return { kind: state.missing.length ? 'partial' : 'full', version: state.version, files: state.files, missing: state.missing, source: state.source }
}

/** Shipped files the user changed or deleted, by comparing hashes with the baseline. */
export function customizedPaths(baseline) {
  const out = []
  for (const [rel, hash] of Object.entries(baseline.files)) {
    if (isGenerated(rel)) continue
    const buf = readBuf(abs(rel))
    if (!buf || fileHash(buf) !== hash) out.push(rel)
  }
  return out.sort()
}

/** The version this install is on: the baseline, else the manifest, else package.json. */
export function currentVersion(baseline) {
  return baseline?.version ?? localManifest()?.version ?? packageVersion() ?? '0.0.0'
}
