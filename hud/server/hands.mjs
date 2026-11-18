/**
 * Hand control: the model the page needs to find hands in the camera picture.
 *
 * The camera never leaves the page: the picture is read in the browser, on this computer, and
 * nothing of it is sent or stored. The server only keeps the model file (7.8 MB, Apache 2.0,
 * MediaPipe Hand Landmarker). It is downloaded once, the first time hand control is switched on,
 * from one fixed address and only accepted when its checksum matches.
 *
 *   GET /api/hands/model    the model file (downloads it on the first call)
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR, errMsg, log, sendJson, writeFileAtomic } from './util.mjs'

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const MODEL_SHA256 = 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1'
const MODEL_BYTES = 7_819_105
const DIR = join(DATA_DIR, 'cache', 'hands')
const FILE = join(DIR, 'hand_landmarker.task')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

let pending = null
/** Path of the verified model, downloading it when it is not here yet. */
export function handModel() {
  pending ??= (async () => {
    if (existsSync(FILE) && (await stat(FILE)).size === MODEL_BYTES && sha256(await readFile(FILE)) === MODEL_SHA256) return FILE
    log('hands', 'sťahujem model na sledovanie rúk (7,8 MB)')
    const res = await fetch(MODEL_URL, { redirect: 'error', signal: AbortSignal.timeout(180_000) })
    if (!res.ok) throw new Error(`model sa nedá stiahnuť (${res.status})`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length !== MODEL_BYTES || sha256(buf) !== MODEL_SHA256) throw new Error('stiahnutý model nesedí s kontrolným súčtom')
    await mkdir(DIR, { recursive: true, mode: 0o700 })
    await writeFileAtomic(FILE, buf, 0o600)
    log('hands', 'model je pripravený')
    return FILE
  })().catch((err) => {
    pending = null
    throw err
  })
  return pending
}

export async function routeHands(req, res, url) {
  if (url.pathname !== '/api/hands/model') return false
  try {
    const buf = await readFile(await handModel())
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length, 'cache-control': 'private, max-age=86400' })
    res.end(buf)
  } catch (err) {
    log('hands', errMsg(err))
    sendJson(res, 502, { ok: false, error: `Model na sledovanie rúk sa nepodarilo pripraviť: ${errMsg(err)}` })
  }
  return true
}
