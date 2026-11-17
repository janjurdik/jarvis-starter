/**
 * Every release is signed by the author. An update is installed only when the manifest of the
 * downloaded version carries a valid signature and every file in the download is exactly the file
 * that manifest names. A stolen GitHub account or a tampered download then cannot put code on
 * anyone's computer: the signing key never leaves the author's machine.
 *
 *   jarvis.manifest.json       what the version ships (path → sha256)
 *   jarvis.manifest.json.sig   ed25519 signature of the manifest, base64
 *
 * A fork that publishes its own versions sets its own key: JARVIS_UPDATE_PUBKEY (base64, SPKI DER).
 * JARVIS_UPDATE_UNSIGNED=1 turns the check off for people who know what that means.
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { join } from 'node:path'
import { MANIFEST, abs, fileHash, isNoise, isProtected, readBuf, toLF, walk } from './core.mjs'
import { readManifest } from './manifest.mjs'

export const SIGNATURE = `${MANIFEST}.sig`
/** The author's public key (ed25519, SPKI DER, base64). The private half is not in this repository. */
export const PUBLIC_KEY = 'MCowBQYDK2VwAyEAtUJ5V3o6IvZB3/GQc5f1lNA9qDthsOHs+x7oLQzz/ss='

const publicKey = () => createPublicKey({ key: Buffer.from(process.env.JARVIS_UPDATE_PUBKEY || PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' })

/** Signs the manifest text with the author's private key (PEM). Returns the signature as base64. */
export function signManifest(manifestBuf, privateKeyPem) {
  return sign(null, toLF(manifestBuf), createPrivateKey(privateKeyPem)).toString('base64')
}

/**
 * Checks an unpacked version in `dir`. { ok: true } or { ok: false, reason, detail }.
 * reason: unsigned (no signature), bad-signature, tampered (a file differs from the manifest or is not in it).
 */
export function verifyRelease(dir) {
  const manifestBuf = readBuf(join(dir, MANIFEST))
  const sigBuf = readBuf(join(dir, SIGNATURE))
  if (!manifestBuf || !sigBuf) return { ok: false, reason: 'unsigned', detail: 'chýba podpis vydania' }
  let good = false
  try {
    good = verify(null, toLF(manifestBuf), publicKey(), Buffer.from(sigBuf.toString('utf8').trim(), 'base64'))
  } catch {
    good = false
  }
  if (!good) return { ok: false, reason: 'bad-signature', detail: 'podpis vydania nesedí' }
  const manifest = readManifest(join(dir, MANIFEST))
  if (!manifest) return { ok: false, reason: 'tampered', detail: 'manifest sa nedá prečítať' }
  for (const [rel, hash] of Object.entries(manifest.files)) {
    const buf = readBuf(abs(rel, dir))
    if (!buf || fileHash(buf) !== hash) return { ok: false, reason: 'tampered', detail: `súbor ${rel} nesedí s vydaním` }
  }
  // Nothing may ride along outside the signed list.
  for (const rel of walk(dir)) {
    if (rel === MANIFEST || rel === SIGNATURE || isProtected(rel) || isNoise(rel)) continue
    if (!(rel in manifest.files)) return { ok: false, reason: 'tampered', detail: `súbor ${rel} nie je súčasťou vydania` }
  }
  return { ok: true, version: manifest.version }
}
