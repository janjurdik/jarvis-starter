// Voice in the browser: plays `tts` clips exactly in seq order through WebAudio with an analyser
// (real loudness, waveform for the core, word-by-word subtitles) and push-to-talk in two ways:
//   local   getUserMedia + MediaRecorder, the recording goes to POST /api/stt (local Whisper);
//           in the desktop app the app captures the microphone itself (native-mic.js) and the
//           recording is a WAV file
//   browser the browser's own speech recognition (Chrome, Edge), nothing to install
// When the server has no voice engine, sentences marked `speak` are read by speechSynthesis.

import { clamp } from './format.js'
import { MIC_RATE, acquireNativeMic, nativeMicAvailable, wavBlob } from './native-mic.js'
import { micAudio } from './mic-pick.js'

const now = () => performance.now() / 1000
const GAP = 0.06 // pauza medzi vetami, klipy už majú vlastné ticho na okrajoch
const SKIP_AFTER = 3 // s: keď chýba klip v poradí a ďalšie sú pripravené, preskočí ho

export function createSpeech({ onBlocked, onError, onPlayed, desktop = false } = {}) {
  let lang = 'sk-SK'
  let ctx = null
  let out = null
  let analyser = null
  const timeBuf = new Float32Array(2048)
  let level = 0
  let lastLevelAt = 0

  // Fronta klipov aktuálneho ťahu.
  let turn = null
  let expected = null
  const clips = new Map() // seq → {seq, url, text, last, buffer, failed}
  const scheduled = [] // [{seq, source, ctxStart, ctxEnd, text, key}]
  const stopped = new Set()
  let waitingSince = null
  let lastEnd = 0

  function ensure() {
    if (ctx) return ctx
    ctx = new AudioContext({ latencyHint: 'interactive' })
    out = ctx.createGain()
    analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0
    out.connect(analyser)
    analyser.connect(ctx.destination)
    return ctx
  }

  /** Volať pri každom geste používateľa: Chrome pustí zvuk až po interakcii. */
  function unlock() {
    ensure()
    if (ctx.state !== 'running') ctx.resume().catch(() => undefined)
  }

  /**
   * Zobudí AudioContext pred prehraním. Upozornenie na odomknutie zvuku len vtedy, keď ostane
   * suspended aj po resume() (vo WKWebView je autoplay povolený, tam sa to nestane).
   */
  async function wakeAudio() {
    ensure()
    lastAudioAt = now()
    if (ctx.state === 'running') return true
    await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 800))])
    if (ctx.state !== 'running') onBlocked?.()
    return ctx.state === 'running'
  }

  // Plocha: keď 10 s nič nehrá ani nenahráva, AudioContext sa uspí (coreaudiod v pokoji nebeží).
  let lastAudioAt = 0
  if (desktop) {
    setInterval(() => {
      if (!ctx || ctx.state !== 'running' || scheduled.length || rec || clips.size) return
      if (now() - lastAudioAt > 10) ctx.suspend().catch(() => undefined)
    }, 2000)
  }

  const latency = () => (ctx ? (ctx.outputLatency || 0) + (ctx.baseLatency || 0) : 0)

  async function load(clip) {
    try {
      const res = await fetch(clip.url, { cache: 'force-cache' })
      if (!res.ok) throw new Error(`hlas ${res.status}`)
      const data = await res.arrayBuffer()
      clip.buffer = await ensure().decodeAudioData(data)
    } catch (err) {
      clip.failed = true
      onError?.(err)
    }
    pump()
  }

  /**
   * {turn, seq, url, text, last} zo SSE `tts`. {turn, stop: true} zahodí frontu ťahu,
   * {url: null, last: true} je ukončenie bez zvuku.
   */
  function enqueue(msg) {
    if (!msg) return
    const t = String(msg.turn ?? '')
    if (msg.stop) {
      if (t === turn || !turn) stop()
      else stopped.add(t)
      return
    }
    if (stopped.has(t)) return
    if (msg.speak && !msg.url) return speakBrowser(t, msg)
    if (!msg.url) return
    if (t !== turn) {
      stopAll()
      turn = t
      expected = 0
      clips.clear()
    }
    const seq = Number(msg.seq) || 0
    if (clips.has(seq)) return
    const clip = { seq, url: msg.url, text: msg.text ?? '', last: Boolean(msg.last), buffer: null, failed: false }
    clips.set(seq, clip)
    wakeAudio()
    load(clip)
  }

  /** Naplánuje ďalší klip hneď za predchádzajúci (bez medzery v reči). */
  function pump() {
    if (!ctx || expected === null) return
    for (;;) {
      const clip = clips.get(expected)
      if (!clip) {
        // Chýba klip v poradí: počkaj, a keď sú za ním hotové ďalšie, po chvíli ho preskoč.
        const later = [...clips.values()].filter((c) => c.seq > expected && (c.buffer || c.failed))
        if (later.length) {
          waitingSince ??= now()
          // Na začiatku ťahu čakaj na prvú vetu kratšie (seq môže začínať od 1).
          if (now() - waitingSince > (expected === 0 ? 0.8 : SKIP_AFTER)) {
            expected = Math.min(...later.map((c) => c.seq))
            waitingSince = null
            continue
          }
          setTimeout(pump, 250)
        }
        return
      }
      waitingSince = null
      if (clip.failed) {
        clips.delete(expected)
        expected += 1
        continue
      }
      if (!clip.buffer) return
      const source = ctx.createBufferSource()
      source.buffer = clip.buffer
      source.connect(out)
      const start = Math.max(ctx.currentTime + 0.03, lastEnd > ctx.currentTime ? lastEnd + GAP : 0)
      source.start(start)
      const entry = { seq: clip.seq, source, ctxStart: start, ctxEnd: start + clip.buffer.duration, text: clip.text, key: `${turn}:${clip.seq}` }
      const playedTurn = turn
      source.onended = () => {
        const i = scheduled.indexOf(entry)
        if (i >= 0) {
          scheduled.splice(i, 1)
          onPlayed?.(playedTurn, entry.seq)
        }
      }
      scheduled.push(entry)
      lastEnd = entry.ctxEnd
      lastAudioAt = now() + clip.buffer.duration
      clips.delete(expected)
      expected += 1
    }
  }

  // ── fallback voice: the browser reads the sentence itself ──
  let synthCue = null
  let synthCount = 0
  function speakBrowser(t, msg) {
    const synth = window.speechSynthesis
    if (!synth || !msg.text) return onPlayed?.(t, Number(msg.seq) || 0)
    if (t !== turn) {
      stopAll()
      turn = t
      expected = null
      clips.clear()
    }
    const u = new SpeechSynthesisUtterance(msg.text)
    u.lang = lang
    const voices = synth.getVoices().filter((v) => v.lang?.toLowerCase().startsWith(lang.slice(0, 2)))
    if (voices.length) u.voice = voices.find((v) => /natural|neural|online/i.test(v.name)) ?? voices[0]
    u.rate = 1.05
    const seq = Number(msg.seq) || 0
    synthCount++
    u.onstart = () => (synthCue = { key: `${t}:${seq}`, text: msg.text, t: now(), end: now() + Math.max(1.2, msg.text.length * 0.07) })
    const finish = () => {
      synthCount = Math.max(0, synthCount - 1)
      if (synthCue?.key === `${t}:${seq}`) synthCue = null
      onPlayed?.(t, seq)
    }
    u.onend = finish
    u.onerror = finish
    synth.speak(u)
  }

  function stopAll() {
    if (synthCount) window.speechSynthesis?.cancel()
    synthCount = 0
    synthCue = null
    for (const s of scheduled.splice(0)) {
      try {
        s.source.stop()
      } catch {
        // už dohral
      }
    }
    lastEnd = 0
  }

  /** Esc: zastaví hlas aj zvyšok fronty, ďalšie klipy tohto ťahu ignoruje. */
  function stop() {
    if (turn) stopped.add(turn)
    stopAll()
    clips.clear()
    expected = null
  }

  /** Klip, ktorý je práve počuť (s ohľadom na latenciu výstupu). */
  function currentEntry() {
    if (!ctx || !scheduled.length) return null
    const heard = ctx.currentTime - latency()
    return scheduled.find((s) => heard >= s.ctxStart - 0.02 && heard < s.ctxEnd + 0.05) ?? null
  }

  /** Hovorí, kým je naplánovaný aspoň jeden klip (medzery medzi vetami drží main.js). */
  const speaking = () => scheduled.length > 0 || synthCount > 0

  /** Titulok: {key, text, t, end} v čase performance.now(), ako živé cue v main.js. */
  function cue() {
    if (synthCue) return synthCue
    const e = currentEntry()
    if (!e || !e.text) return null
    const offset = now() - (ctx.currentTime - latency())
    return { key: e.key, text: e.text, t: e.ctxStart + offset, end: e.ctxEnd + offset }
  }

  /** Hlasitosť Jarvisa 0 až 1 (RMS, rýchly nábeh, pomalý dozvuk ako VU meter). */
  function voiceLevel() {
    const t = now()
    const dt = Math.min(0.1, t - lastLevelAt || 0.016)
    lastLevelAt = t
    let x = 0
    // The browser voice gives no samples: a soft synthetic pulse keeps the core alive.
    if (synthCount) x = 0.35 + 0.25 * Math.abs(Math.sin(t * 9) * Math.sin(t * 2.7))
    else if (analyser && scheduled.length) {
      analyser.getFloatTimeDomainData(timeBuf)
      let sum = 0
      for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i]
      x = clamp(Math.sqrt(sum / timeBuf.length) * 5.2, 0, 1.2)
    }
    const k = x > level ? 1 - Math.exp(-dt / 0.03) : 1 - Math.exp(-dt / 0.17)
    level += (x - level) * k
    return Math.pow(clamp(level), 0.85)
  }

  /** Vlna pre jadro a čiaru nad riadkom: out.length bodov z posledných ~26 ms. */
  function wave(outBuf) {
    if (!analyser || !scheduled.length) return null
    const span = Math.min(timeBuf.length, Math.round(ctx.sampleRate * 0.026))
    const start = timeBuf.length - span
    let peak = 1e-4
    for (let i = start; i < timeBuf.length; i++) peak = Math.max(peak, Math.abs(timeBuf[i]))
    const gain = Math.min(1 / peak, 18) * Math.min(1, level * 1.4)
    for (let k = 0; k < outBuf.length; k++) outBuf[k] = timeBuf[start + Math.floor((span * k) / outBuf.length)] * gain
    return outBuf
  }

  // ── microphone ──
  // Raw capture on purpose: echo cancellation, noise suppression and automatic gain make the system
  // switch the microphone to its voice processing mode (macOS) or to a communications session
  // (Windows), and a call running in another app (Discord, Meet, Teams) then loses its microphone
  // or gets ducked. Whisper does not need any of it. The stream stays open for a short while after
  // the last use, so the next press has no delay, and is given back after MIC_IDLE_MS.
  const MIC_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
  const MIC_IDLE_MS = 20_000
  let micIdleTimer = 0
  const micKeep = () => {
    clearTimeout(micIdleTimer)
    micIdleTimer = setTimeout(() => (rec || recog ? micKeep() : micRelease()), MIC_IDLE_MS)
  }
  let mic = null // {stream, source, analyser, buf} or, in the desktop app, {native, on, rms, at, ring, release}
  let micOpening = null
  let micLevel = 0
  let micLastAt = 0
  // The desktop app captures the microphone itself: the web view's capture restarts the audio devices
  // of the whole computer (a call in Discord loses its microphone) and its level meter waits for the
  // playback AudioContext, so the wave came seconds late.
  const nativeMic = desktop && nativeMicAvailable()
  const PRE_ROLL = 2 // frames (160 ms) kept from before the key went down, so the first syllable is whole

  function nativeStart() {
    micOpening = new Promise((resolve) => {
      const m = { native: true, on: false, rms: 0, at: 0, ring: [], release: null }
      let settled = false
      const settle = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        micOpening = null
        resolve(value)
      }
      const fail = (name) => {
        m.release?.()
        if (mic === m) mic = null
        if (rec?.native) rec = null
        onError?.(Object.assign(new Error('Mikrofón nie je dostupný.'), { name }))
        settle(null)
      }
      const timer = setTimeout(() => fail('NotReadableError'), 4000)
      m.release = acquireNativeMic({
        onFrame(pcm, rms) {
          m.rms = rms
          m.at = now()
          if (rec?.native) {
            rec.chunks.push(pcm)
            rec.peak = Math.max(rec.peak, rms)
            rec.measured = true
          } else {
            m.ring.push(pcm)
            if (m.ring.length > PRE_ROLL) m.ring.shift()
          }
          if (!m.on) {
            m.on = true
            settle(m)
          }
        },
        onState(state) {
          if (state === 'denied') fail('NotAllowedError')
          else if (state === 'error') fail('NotReadableError')
          else if (state === 'off' && mic === m) {
            // The app took the microphone back (the page reloaded, the device went away).
            m.release?.()
            mic = null
          }
        },
      })
      mic = m
      micKeep()
    })
    return micOpening
  }

  async function micStart() {
    if (mic && (!mic.native || mic.on)) return mic
    if (micOpening) return micOpening
    if (nativeMic) return nativeStart()
    if (!navigator.mediaDevices?.getUserMedia) return null
    micOpening = (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: await micAudio(MIC_AUDIO) })
        ensure()
        if (ctx.state !== 'running') ctx.resume().catch(() => undefined)
        const source = ctx.createMediaStreamSource(stream)
        const an = ctx.createAnalyser()
        an.fftSize = 1024
        an.smoothingTimeConstant = 0
        source.connect(an)
        mic = { stream, source, analyser: an, buf: new Float32Array(1024) }
        // Keď macOS alebo Chrome mikrofón odoberie, ďalšie stlačenie ho otvorí znova.
        for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => (mic = null))
        micKeep()
      } catch (err) {
        onError?.(err)
      } finally {
        micOpening = null
      }
      return mic
    })()
    return micOpening
  }

  // ── push-to-talk nahrávka ──
  const REC_TYPES = ['audio/webm;codecs=opus', 'audio/mp4']
  const SILENCE_RMS = 0.006 // ≈ -44 dBFS, tichá miestnosť je pod tým, reč vysoko nad tým
  let rec = null // {recorder, chunks, startedAt, type}

  /** Začne nahrávať. Vráti false, keď mikrofón nie je (povolenie, žiadne zariadenie). */
  async function recStart() {
    if (rec) return true
    wakeAudio()
    const m = await micStart()
    if (m?.native) {
      micKeep()
      // What was heard just before the key went down belongs to the sentence.
      rec = { native: true, chunks: m.ring.splice(0), startedAt: now(), peak: 0, measured: false }
      return true
    }
    if (!m || typeof MediaRecorder === 'undefined') return false
    micKeep()
    const type = REC_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? ''
    const recorder = new MediaRecorder(m.stream, type ? { mimeType: type, audioBitsPerSecond: 64_000 } : undefined)
    const chunks = []
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data?.size) chunks.push(e.data)
    })
    recorder.start(120)
    rec = { recorder, chunks, startedAt: now(), type: recorder.mimeType || type || 'audio/webm', peak: 0, measured: false, timer: 0 }
    // Najvyššia hlasitosť počas nahrávky: ticho (náhodné stlačenie) sa neposiela, Whisper by si vymyslel vetu.
    const r = rec
    r.timer = setInterval(() => {
      lastAudioAt = now()
      if (ctx?.state !== 'running') return
      m.analyser.getFloatTimeDomainData(m.buf)
      let sum = 0
      for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] * m.buf[i]
      r.peak = Math.max(r.peak, Math.sqrt(sum / m.buf.length))
      r.measured = true
    }, 50)
    return true
  }

  /**
   * Ukončí nahrávanie: {blob, ms, silent} alebo null, keď sa nenahrávalo. silent = počas celej
   * nahrávky nič nad prahom (meria sa len pri bežiacom AudioContexte, inak sa ticho nehádže).
   */
  function recStop() {
    const r = rec
    rec = null
    if (!r) return Promise.resolve(null)
    micKeep()
    if (r.native) {
      const samples = r.chunks.reduce((n, c) => n + c.length, 0)
      return Promise.resolve({ blob: wavBlob(r.chunks), ms: Math.round((samples / MIC_RATE) * 1000), silent: r.measured && r.peak < SILENCE_RMS })
    }
    clearInterval(r.timer)
    return new Promise((done) => {
      r.recorder.addEventListener('stop', () => done({ blob: new Blob(r.chunks, { type: r.type }), ms: Math.round((now() - r.startedAt) * 1000), silent: r.measured && r.peak < SILENCE_RMS }), { once: true })
      try {
        r.recorder.stop()
      } catch {
        done(null)
      }
    })
  }

  /** Pokoj na ploche: uvoľní mikrofón (ďalšie stlačenie ho znova otvorí). Počas nahrávania nič. */
  function micRelease() {
    if (!mic || rec) return
    clearTimeout(micIdleTimer)
    if (mic.native) mic.release?.()
    else {
      for (const track of mic.stream.getTracks()) track.stop()
      mic.source.disconnect()
    }
    mic = null
  }

  /** Esc počas nahrávania: zahodí nahrávku. */
  function recCancel() {
    const r = rec
    rec = null
    if (r?.native) return
    if (r) clearInterval(r.timer)
    if (r && r.recorder.state !== 'inactive') {
      try {
        r.recorder.stop()
      } catch {
        // už zastavené
      }
    }
  }

  // ── push-to-talk through the browser's speech recognition ──
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
  let recog = null // {r, finals, interim, done, ended}

  /** Starts recognising. False when the browser has no speech recognition or the mic is blocked. */
  function recogStart(onInterim) {
    if (!Recognition) return false
    if (recog) return true
    const r = new Recognition()
    r.lang = lang
    r.continuous = true
    r.interimResults = true
    const state = { r, finals: [], interim: '', done: null, ended: false, error: null, startedAt: now() }
    r.onresult = (e) => {
      state.interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        if (res.isFinal) state.finals.push(res[0].transcript.trim())
        else state.interim += res[0].transcript
      }
      onInterim?.([...state.finals, state.interim.trim()].filter(Boolean).join(' '))
    }
    r.onerror = (e) => (state.error = e.error)
    r.onend = () => {
      state.ended = true
      state.done?.()
    }
    try {
      r.start()
    } catch {
      return false
    }
    recog = state
    // The level meter needs its own stream (the recogniser gives no samples). Failure is harmless.
    micStart().catch(() => undefined)
    return true
  }

  /** Stops recognising: { text, ms, error } or null when nothing was running. */
  function recogStop({ cancel = false } = {}) {
    const state = recog
    recog = null
    if (!state) return Promise.resolve(null)
    return new Promise((resolve) => {
      const finish = () => resolve(cancel ? null : { text: [...state.finals, state.interim.trim()].filter(Boolean).join(' ').trim(), ms: Math.round((now() - state.startedAt) * 1000), error: state.error })
      if (state.ended) return finish()
      state.done = finish
      setTimeout(finish, 1800)
      try {
        if (cancel) state.r.abort()
        else state.r.stop()
      } catch {
        finish()
      }
    })
  }

  function listenLevel() {
    const t = now()
    const dt = Math.min(0.1, t - micLastAt || 0.016)
    micLastAt = t
    let x = 0
    if (mic?.native) {
      // The app sends the loudness with every frame (80 ms); a frame that is late means silence.
      x = t - mic.at < 0.3 ? clamp(mic.rms * 7, 0, 1.2) : 0
    } else if (mic) {
      mic.analyser.getFloatTimeDomainData(mic.buf)
      let sum = 0
      for (let i = 0; i < mic.buf.length; i++) sum += mic.buf[i] * mic.buf[i]
      x = clamp(Math.sqrt(sum / mic.buf.length) * 7, 0, 1.2)
    }
    const k = x > micLevel ? 1 - Math.exp(-dt / 0.025) : 1 - Math.exp(-dt / 0.14)
    micLevel += (x - micLevel) * k
    return clamp(micLevel)
  }

  return {
    unlock,
    enqueue,
    stop,
    cue,
    voiceLevel,
    wave,
    speaking,
    micStart,
    recStart,
    recStop,
    recCancel,
    micRelease,
    listenLevel,
    recogStart,
    recogStop,
    /** True when this browser can recognise speech on its own (Chrome, Edge). */
    canRecognise: Boolean(Recognition),
    setLang(next) {
      if (typeof next === 'string' && /^[a-z]{2}-[A-Z]{2}$/.test(next)) lang = next
    },
    get recording() {
      return Boolean(rec) || Boolean(recog)
    },
    /** Mikrofón dáva dáta len pri bežiacom AudioContexte (po prvom geste na stránke). */
    get micOpen() {
      return mic?.native ? mic.on : Boolean(mic) && ctx?.state === 'running'
    },
    get blocked() {
      return Boolean(ctx) && ctx.state !== 'running'
    },
  }
}
