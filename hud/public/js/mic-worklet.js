// AudioWorklet pre „Hey Jarvis": mikrofón → 16 kHz mono Int16, rámce po 1280 vzorkách (80 ms),
// presne to, čo čaká server na /api/mic (openWakeWord a Silero VAD). Prevzorkovanie: 2× Butterworth
// low-pass pri 7 kHz (proti aliasingu) a lineárna interpolácia, pri 16 kHz vstupe len prevod.
// Správa do hlavného vlákna: { pcm: ArrayBuffer (Int16 × 1280), rms: 0..1 }.

const OUT_RATE = 16000
const FRAME = 1280

function lowpass(fs, f0, q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * f0) / fs
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  const a0 = 1 + alpha
  const b0 = (1 - cos) / 2 / a0
  const b1 = (1 - cos) / a0
  const b2 = b0
  const a1 = (-2 * cos) / a0
  const a2 = (1 - alpha) / a0
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  return (x) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    return y
  }
}

class MicFrames extends AudioWorkletProcessor {
  constructor() {
    super()
    // `sampleRate` je globálna premenná AudioWorkletGlobalScope (frekvencia AudioContextu).
    this.step = sampleRate / OUT_RATE
    this.filters = sampleRate > OUT_RATE ? [lowpass(sampleRate, 7000), lowpass(sampleRate, 7000)] : null
    this.t = 0 // pozícia ďalšej výstupnej vzorky vo vstupných vzorkách, relatívne k začiatku bloku
    this.prev = 0 // posledná (filtrovaná) vzorka predošlého bloku, index -1
    this.frame = new Int16Array(FRAME)
    this.n = 0
    this.sumSq = 0
    this.buf = new Float32Array(128)
    // Slow automatic gain: the microphone is captured raw (no system voice processing, so calls in
    // other apps keep working), and a quiet microphone would otherwise fall under the wake word's ear.
    this.gain = 1
    this.env = 0
  }

  push(x) {
    // Envelope follower (fast attack, slow release), gain towards a peak of 0.25, at most 8×, never below 1×.
    const a = x < 0 ? -x : x
    this.env = a > this.env ? a : this.env * 0.99995
    if (this.env > 0.01) this.gain += (Math.min(8, Math.max(1, 0.25 / this.env)) - this.gain) * 0.0005
    const v = x * this.gain
    const s = v > 1 ? 1 : v < -1 ? -1 : v
    this.frame[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff
    this.sumSq += s * s
    if (this.n === FRAME) {
      const rms = Math.sqrt(this.sumSq / FRAME)
      this.port.postMessage({ pcm: this.frame.buffer, rms }, [this.frame.buffer])
      this.frame = new Int16Array(FRAME)
      this.n = 0
      this.sumSq = 0
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch || !ch.length) return true
    const len = ch.length
    if (this.buf.length < len) this.buf = new Float32Array(len)
    const x = this.buf
    if (this.filters) {
      const [f1, f2] = this.filters
      for (let i = 0; i < len; i++) x[i] = f2(f1(ch[i]))
    } else {
      x.set(ch)
    }
    if (this.step === 1) {
      for (let i = 0; i < len; i++) this.push(x[i])
      return true
    }
    let t = this.t
    while (t < len - 1) {
      const i = Math.floor(t)
      const frac = t - i
      const a = i < 0 ? this.prev : x[i]
      const b = x[i + 1]
      this.push(a + (b - a) * frac)
      t += this.step
    }
    this.t = t - len
    this.prev = x[len - 1]
    return true
  }
}

registerProcessor('mic-frames', MicFrames)
