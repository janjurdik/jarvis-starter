// Zvuk scény: dekódovanie, obálka hlasitosti a vlna. Všetko je funkcia času t,
// takže živé prehrávanie aj render po snímkach dávajú rovnaký obraz.

import { clamp, hash } from './format.js'

const ENV_RATE = 100 // vzoriek obálky za sekundu

/** Stiahne a dekóduje MP3. OfflineAudioContext funguje aj bez kliknutia (autoplay pravidlá). */
export async function loadAudio(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`zvuk ${url}: ${res.status}`)
  const data = await res.arrayBuffer()
  const decoder = new OfflineAudioContext(1, 1, 44100)
  const buffer = await decoder.decodeAudioData(data)
  const mono = new Float32Array(buffer.length)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c)
    for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / buffer.numberOfChannels
  }
  return { url, buffer, mono, rate: buffer.sampleRate, duration: buffer.duration, envelope: envelopeOf(mono, buffer.sampleRate) }
}

/**
 * RMS po 10 ms, normalizované na 95. percentil a vyhladené ako VU meter
 * (rýchly nábeh 25 ms, pomalý dozvuk 170 ms). Jadro tak dýcha s rečou, nebliká.
 */
function envelopeOf(mono, rate) {
  const hop = Math.round(rate / ENV_RATE)
  const n = Math.ceil(mono.length / hop)
  const raw = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const from = Math.max(0, (i - 2) * hop)
    const to = Math.min(mono.length, (i + 1) * hop)
    let sum = 0
    for (let j = from; j < to; j++) sum += mono[j] * mono[j]
    raw[i] = Math.sqrt(sum / Math.max(1, to - from))
  }
  const sorted = Array.from(raw).filter((v) => v > 0.002).sort((a, b) => a - b)
  const ref = sorted[Math.floor(sorted.length * 0.95)] || 1
  const env = new Float32Array(n)
  const dt = 1 / ENV_RATE
  const attack = 1 - Math.exp(-dt / 0.025)
  const release = 1 - Math.exp(-dt / 0.17)
  let prev = 0
  for (let i = 0; i < n; i++) {
    const x = clamp(raw[i] / ref, 0, 1.25)
    prev += (x > prev ? attack : release) * (x - prev)
    env[i] = Math.pow(prev, 0.85)
  }
  return env
}

/** Hlasitosť v čase t (0 až ~1), lineárne medzi vzorkami obálky. */
export function levelAt(audio, t) {
  if (!audio || t < 0) return 0
  const x = t * ENV_RATE
  const i = Math.floor(x)
  const a = audio.envelope[i] ?? 0
  const b = audio.envelope[i + 1] ?? 0
  return a + (b - a) * (x - i)
}

/**
 * Vlna: `out.length` bodov zo zvuku okolo času t (okno ~26 ms), znormalizované
 * na obálku, aby tichá aj hlasná veta mali čitateľný tvar.
 */
export function waveAt(audio, t, out) {
  const n = out.length
  if (!audio || t < 0 || t > audio.duration) return out.fill(0)
  const span = Math.round(audio.rate * 0.026)
  const end = Math.min(audio.mono.length, Math.round(t * audio.rate))
  const start = Math.max(0, end - span)
  let peak = 1e-4
  for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(audio.mono[i]))
  const gain = Math.min(1 / peak, 18) * Math.min(1, levelAt(audio, t) * 1.4)
  for (let k = 0; k < n; k++) {
    const idx = start + Math.floor(((end - start) * k) / n)
    out[k] = (audio.mono[idx] ?? 0) * gain
  }
  return out
}

/**
 * Prehrá zvuk od `offset`. Vráti hodiny scény: time() je presná pozícia v MP3
 * podľa AudioContextu, s odpočítanou latenciou výstupu.
 */
export async function play(audio, offset, { muted = false } = {}) {
  const ctx = new AudioContext({ latencyHint: 'interactive' })
  await ctx.resume()
  const source = ctx.createBufferSource()
  source.buffer = audio.buffer
  const gain = ctx.createGain()
  gain.gain.value = muted ? 0 : 1
  source.connect(gain).connect(ctx.destination)
  const startAt = ctx.currentTime + 0.06
  source.start(startAt, Math.max(0, offset))
  const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0)
  return {
    time: () => offset + (ctx.currentTime - startAt) - latency,
    stop: () => {
      try {
        source.stop()
      } catch {
        // už zastavené
      }
      ctx.close()
    },
  }
}

/**
 * Syntetický hlas pre živé udalosti, keď Jarvis hovorí na Macu a HUD nemá zvuk.
 * Slabiky podľa textu, deterministicky z času.
 */
export function syntheticLevel(text, start, duration, t) {
  const x = t - start
  if (x < 0 || x > duration) return 0
  const seed = (hash(text) % 1000) / 1000
  const syllable = 0.55 + 0.45 * Math.sin(x * 15.7 + seed * 6.28) * Math.sin(x * 4.3 + seed * 3.1)
  const words = 0.7 + 0.3 * Math.sin(x * 2.1 + seed * 9.0)
  const edge = Math.min(1, x / 0.12, (duration - x) / 0.25)
  return clamp(syllable * words * edge, 0, 1) * 0.85
}

export function syntheticWave(text, start, duration, t, out) {
  const level = syntheticLevel(text, start, duration, t)
  const seed = (hash(text) % 97) / 97
  for (let k = 0; k < out.length; k++) {
    const u = k / out.length
    out[k] =
      level *
      (0.55 * Math.sin(u * 37.7 + t * 31 + seed * 6) +
        0.3 * Math.sin(u * 91.1 - t * 47 + seed * 2) +
        0.15 * Math.sin(u * 213.6 + t * 19))
  }
  return out
}
