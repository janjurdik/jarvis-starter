import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MIC_FRAME, MIC_RATE, createGain, nativeMicAvailable, wavBlob } from '../hud/public/js/native-mic.js'

const tone = (amp, frames = 1) => {
  const out = new Int16Array(MIC_FRAME * frames)
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * 440 * i) / MIC_RATE))
  return out
}

test('native mic: not there outside the desktop app', () => {
  assert.equal(nativeMicAvailable(), false)
})

test('native mic: a recording is a valid 16 kHz mono WAV, a quiet one is brought up', async () => {
  const blob = wavBlob([tone(0.05), tone(0.05)])
  assert.equal(blob.type, 'audio/wav')
  const v = new DataView(await blob.arrayBuffer())
  const text = (at) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3))
  assert.equal(text(0), 'RIFF')
  assert.equal(text(8), 'WAVE')
  assert.equal(v.getUint16(22, true), 1)
  assert.equal(v.getUint32(24, true), MIC_RATE)
  assert.equal(v.getUint16(34, true), 16)
  assert.equal(v.getUint32(40, true), MIC_FRAME * 2 * 2)
  assert.equal(v.byteLength, 44 + MIC_FRAME * 2 * 2)
  let peak = 0
  for (let at = 44; at < v.byteLength; at += 2) peak = Math.max(peak, Math.abs(v.getInt16(at, true)))
  // 0.05 of full scale times the largest gain (ten) is a half
  assert.ok(peak > 0.45 * 32767 && peak < 0.55 * 32767, `peak ${peak}`)
})

test('native mic: a loud recording is left alone and never clips', async () => {
  const v = new DataView(await wavBlob([tone(0.98)]).arrayBuffer())
  let peak = 0
  for (let at = 44; at < v.byteLength; at += 2) peak = Math.max(peak, Math.abs(v.getInt16(at, true)))
  assert.ok(peak <= 32767 && peak > 0.9 * 32767)
})

test('native mic: the wake word gain lifts a quiet microphone and keeps silence silent', () => {
  const gain = createGain()
  let last = null
  for (let i = 0; i < 60; i++) last = gain(tone(0.03))
  assert.ok(last.rms > 0.05, `rms ${last.rms}`)
  assert.equal(last.pcm.length, MIC_FRAME)
  const quiet = createGain()(new Int16Array(MIC_FRAME))
  assert.equal(quiet.rms, 0)
})
