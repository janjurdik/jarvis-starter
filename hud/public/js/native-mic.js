// The microphone of the desktop app. In the app "Jarvis HUD" the microphone is opened by the app
// itself (a plain system input), not by the web view: the web view's own capture restarts the audio
// devices for every app on the computer, and a call running elsewhere (Discord) loses its microphone.
// The app delivers 16 kHz mono Int16 in frames of 1280 samples (80 ms) with their loudness, which is
// exactly what the wake word server expects, and enough to write a recording for Whisper.
//
//   if (nativeMicAvailable()) {
//     const release = acquireNativeMic({ onFrame(pcm /* Int16Array */, rms /* 0..1 */) {}, onState(state) {} })
//     release()            // the microphone is given back when nobody listens any more
//   }
//
// state: 'starting' | 'on' | 'off' | 'denied' (no permission) | 'error' (no device)

export const MIC_RATE = 16000
export const MIC_FRAME = 1280

const bridge = () => (typeof window === 'undefined' ? null : window.__jarvisDesktop ?? null)

/** True in a desktop app that captures the microphone itself (bridge version 3 and later). */
export const nativeMicAvailable = () => Boolean(bridge()?.native && bridge().mic === true && typeof bridge().post === 'function')

const listeners = new Set()
let state = 'off'
let installed = false

function decode(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1)
}

function install() {
  if (installed) return
  installed = true
  const d = bridge()
  d.onMicFrame = (b64, rms) => {
    if (!listeners.size) return
    if (state !== 'on') setState('on')
    const pcm = decode(b64)
    for (const l of listeners) l.onFrame?.(pcm, Number(rms) || 0)
  }
  d.onMicState = (next) => setState(String(next))
}

function setState(next) {
  if (next === state) return
  state = next
  for (const l of [...listeners]) l.onState?.(next)
}

/** Starts listening. Returns the function that stops it for this listener. */
export function acquireNativeMic(listener) {
  install()
  listeners.add(listener)
  if (state === 'on' || state === 'starting') listener.onState?.(state)
  else {
    setState('starting')
    bridge().post({ type: 'mic', on: true })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    listeners.delete(listener)
    if (listeners.size) return
    bridge()?.post({ type: 'mic', on: false })
    state = 'off'
  }
}

export const nativeMicState = () => state

/**
 * A recording as a WAV file (16 kHz mono, 16 bit) from frames of Int16 samples. The microphone is
 * captured raw, so a quiet one is brought up to a healthy level first (at most ten times).
 */
export function wavBlob(chunks) {
  const samples = chunks.reduce((n, c) => n + c.length, 0)
  let peak = 1
  for (const c of chunks) for (let i = 0; i < c.length; i++) peak = Math.max(peak, c[i] < 0 ? -c[i] : c[i])
  const gain = Math.min(10, Math.max(1, (0.9 * 32767) / peak))
  const buf = new ArrayBuffer(44 + samples * 2)
  const v = new DataView(buf)
  const text = (at, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i))
  }
  text(0, 'RIFF')
  v.setUint32(4, 36 + samples * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, MIC_RATE, true)
  v.setUint32(28, MIC_RATE * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  text(36, 'data')
  v.setUint32(40, samples * 2, true)
  let at = 44
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, at += 2) v.setInt16(at, Math.max(-32768, Math.min(32767, Math.round(c[i] * gain))), true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

/**
 * Slow automatic gain for a raw microphone, the same the wake word worklet applies: a quiet
 * microphone would otherwise fall under the wake word's ear. Returns a function that takes a frame
 * and gives back { pcm (a new Int16Array), rms } after the gain.
 */
export function createGain() {
  let gain = 1
  let env = 0
  return (frame) => {
    const out = new Int16Array(frame.length)
    let sum = 0
    for (let i = 0; i < frame.length; i++) {
      const x = frame[i] / 32768
      const a = x < 0 ? -x : x
      env = a > env ? a : env * 0.99985
      if (env > 0.01) gain += (Math.min(8, Math.max(1, 0.25 / env)) - gain) * 0.0015
      const y = x * gain
      const s = y > 1 ? 1 : y < -1 ? -1 : y
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      sum += s * s
    }
    return { pcm: out, rms: Math.sqrt(sum / frame.length) }
  }
}
