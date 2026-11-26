// Record mode in the page: the microphone (and the screen as a video where the browser can) go to
// the server in short chunks while Jarvis keeps answering. The server keeps the session, transcribes
// and runs the after-actions (hud/server/record.mjs, docs/ZAZNAM.md).
//
//   initRecord({ on, toast, ownsAudio, token, desktop })
//
// Only the window that owns the voice records (the desktop before the app window before a tab), so
// two open windows never record twice. A window that loads again while a recording runs (a reload,
// a server restart) continues in the same session from the next chunk.

import { MIC_RATE, acquireNativeMic, createGain, nativeMicAvailable } from './native-mic.js'
import { esc } from './format.js'

/** About five seconds of sound per chunk: frames of 80 ms. */
const FRAMES_PER_CHUNK = 63
const FRAME_MS = 80
/** Chunks kept in memory while the server cannot be reached (a restart): about ten minutes. */
const QUEUE_MAX = 120
/** A keepalive request may carry at most 64 kB: the piece sent when the window closes is cut to fit. */
const UNLOAD_PIECE = 60_000
const VIDEO_SLICE_MS = 10_000
const FRAME_EVERY_MS = 60_000

const LABEL = { recording: 'Záznam', finishing: 'Dokončujem', processing: 'Spracúvam' }

/** Int16 frames → a plain WAV (16 kHz mono). No gain here: the microphone path applies its own. */
export function encodeWav(frames, rate = MIC_RATE) {
  const samples = frames.reduce((n, f) => n + f.length, 0)
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
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  text(36, 'data')
  v.setUint32(40, samples * 2, true)
  let at = 44
  for (const f of frames) for (let i = 0; i < f.length; i++, at += 2) v.setInt16(at, f[i], true)
  return new Uint8Array(buf)
}

const two = (n) => String(n).padStart(2, '0')
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  return h ? `${h}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`
}

export function initRecord({ on, toast = () => {}, ownsAudio = () => true, token = null, desktop = false }) {
  const chips = document.getElementById('chips')
  if (!chips) return null
  if (!document.querySelector('link[href="/css/record.css"]')) {
    const css = document.createElement('link')
    css.rel = 'stylesheet'
    css.href = '/css/record.css'
    document.head.append(css)
  }
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = 'chip chip-rec is-off'
  chip.id = 'chip-rec'
  chip.dataset.tip = 'Záznam|Nahrávam mikrofón aj obrazovku a priebežne ukladám, medzitým s vami normálne hovorím. Po konci z toho spravím poznámku, úlohy a návrhy správ. Všetko ostáva vo vašom počítači.'
  chip.setAttribute('aria-pressed', 'false')
  chip.innerHTML = '<svg class="ic ic-rec" viewBox="0 0 24 24" aria-hidden="true"><circle class="rec-ring" cx="12" cy="12" r="7.5"/><circle class="rec-dot" cx="12" cy="12" r="4"/></svg><span>Záznam</span>'
  chips.insertBefore(chip, document.getElementById('chip-set') ?? null)
  // On a phone the chips are hidden: a small red dot with the time stays in the corner.
  const badge = document.createElement('div')
  badge.className = 'rec-live'
  badge.hidden = true
  badge.innerHTML = '<i aria-hidden="true"></i><span></span>'
  document.body.append(badge)

  const headers = token ? { 'x-hud-token': token } : {}
  let session = null
  let tick = 0
  // capture
  let mic = null // { release, frames, startAt }
  // A chunk's number is its place in time (80 ms frames from the start): unique even across reloads.
  let lastSeq = 0
  const seqFor = (startAt) => (lastSeq = Math.max(lastSeq + 1, Math.round((startAt - session.startedAt) / FRAME_MS) + 1))
  const queue = []
  let sending = false
  let screen = null // { stream, recorder, part, frameTimer, video }
  let wantVideo = false

  // ── the chip ──
  function render() {
    const st = session?.status
    const live = st === 'recording'
    const busy = st === 'finishing'
    chip.classList.toggle('is-off', !live && !busy)
    chip.classList.toggle('is-rec', live)
    chip.classList.toggle('is-busy', busy)
    chip.setAttribute('aria-pressed', String(live))
    const span = chip.querySelector('span')
    span.textContent = live ? `${LABEL.recording} ${clock(Date.now() - session.startedAt)}` : busy ? LABEL.finishing : 'Záznam'
    chip.setAttribute('aria-label', live ? `Záznam beží, ${span.textContent}. Klik ho ukončí.` : 'Zapnúť záznam')
    badge.hidden = !live
    if (live) badge.querySelector('span').textContent = clock(Date.now() - session.startedAt)
    clearInterval(tick)
    if (live) tick = setInterval(render, 1000)
  }

  // ── sending ──
  async function json(method, path, body) {
    const res = await fetch(path, { method, headers: { ...headers, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status })
    return data
  }

  async function post(url, body, { keepalive = false } = {}) {
    const res = await fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body, keepalive, cache: 'no-store' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status, data })
    return data
  }

  async function pump() {
    if (sending) return
    sending = true
    try {
      while (queue.length) {
        const item = queue[0]
        try {
          const data = await post(item.url, item.body)
          queue.shift()
          if (data.session) apply(data.session, { quiet: true })
        } catch (err) {
          // The recording ended elsewhere: what is left here has nowhere to go.
          if (err.status === 409 || err.status === 404) {
            queue.length = 0
            if (err.data?.state) apply(err.data.state)
            break
          }
          if (err.status >= 400 && err.status < 500) {
            queue.shift()
            continue
          }
          // The server restarts or the network hiccups: the chunk waits and is sent again.
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
    } finally {
      sending = false
    }
  }

  function enqueue(url, body) {
    queue.push({ url, body })
    while (queue.length > QUEUE_MAX) queue.shift()
    pump()
  }

  function flushAudio({ final = false } = {}) {
    if (!mic || !session) return
    const frames = mic.frames
    if (!frames.length && !final) return
    const startAt = mic.startAt ?? Date.now()
    mic.frames = []
    mic.startAt = null
    if (!frames.length) return
    const body = encodeWav(frames)
    enqueue(`/api/record/chunk?id=${encodeURIComponent(session.id)}&kind=audio&seq=${seqFor(startAt)}&at=${Math.round(startAt)}${final ? '&final=1' : ''}`, body)
  }

  function onFrame(pcm) {
    if (!mic) return
    if (!mic.frames.length) mic.startAt = Date.now() - FRAME_MS
    mic.frames.push(pcm)
    if (mic.frames.length >= FRAMES_PER_CHUNK) flushAudio()
  }

  async function startMic() {
    if (mic) return
    const m = { frames: [], startAt: null, release: null }
    mic = m
    if (nativeMicAvailable()) {
      const gain = createGain()
      m.release = acquireNativeMic({
        onFrame: (frame) => mic === m && onFrame(gain(frame).pcm),
        onState: (st) => {
          if (st === 'denied' || st === 'error') toast('Záznam · mikrofón nie je dostupný, nahrávam len obrazovku', { iconName: 'mic', ms: 6000 })
        },
      })
      return
    }
    try {
      // Raw capture like the wake word: the system's voice processing would take the microphone from a call elsewhere.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } })
      if (mic !== m) return void stream.getTracks().forEach((t) => t.stop())
      const ctx = new AudioContext({ latencyHint: 'playback' })
      await ctx.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url))
      const source = ctx.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(ctx, 'mic-frames', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
      const mute = ctx.createGain()
      mute.gain.value = 0
      source.connect(node)
      node.connect(mute)
      mute.connect(ctx.destination)
      node.port.onmessage = (e) => mic === m && onFrame(new Int16Array(e.data.pcm))
      if (ctx.state !== 'running') await ctx.resume().catch(() => {})
      m.release = () => {
        node.port.onmessage = null
        stream.getTracks().forEach((t) => t.stop())
        ctx.close().catch(() => {})
      }
    } catch (err) {
      if (mic === m) mic = null
      toast(`Záznam · mikrofón nie je dostupný (${esc(err?.name ?? 'chyba')}), nahrávam len obrazovku`, { iconName: 'mic', ms: 7000 })
    }
  }

  function stopMic({ final = false } = {}) {
    if (!mic) return
    flushAudio({ final })
    mic.release?.()
    mic = null
  }

  // ── the screen as a video (Chrome, Edge); elsewhere the server takes pictures ──
  async function startScreen(stream) {
    if (screen || !session) return
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    const type = types.find((t) => window.MediaRecorder?.isTypeSupported?.(t))
    if (!type) return void stream.getTracks().forEach((t) => t.stop())
    const s = { stream, part: session.nextPart ?? 1, recorder: null, frameTimer: 0, video: null }
    screen = s
    s.recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 450_000 })
    s.recorder.ondataavailable = (e) => {
      if (!e.data?.size || !session) return
      e.data.arrayBuffer().then((buf) => enqueue(`/api/record/chunk?id=${encodeURIComponent(session.id)}&kind=video&part=${s.part}`, new Uint8Array(buf)))
    }
    s.recorder.start(VIDEO_SLICE_MS)
    // Now and then one picture from the video: the after-actions look at those, not at the video.
    const video = document.createElement('video')
    video.muted = true
    video.srcObject = stream
    video.play().catch(() => {})
    s.video = video
    const grab = () => {
      if (!session || !video.videoWidth) return
      const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight))
      const c = document.createElement('canvas')
      c.width = Math.round(video.videoWidth * scale)
      c.height = Math.round(video.videoHeight * scale)
      c.getContext('2d').drawImage(video, 0, 0, c.width, c.height)
      c.toBlob((b) => b && b.arrayBuffer().then((buf) => enqueue(`/api/record/chunk?id=${encodeURIComponent(session.id)}&kind=frame&at=${Date.now()}`, new Uint8Array(buf))), 'image/jpeg', 0.72)
    }
    setTimeout(grab, 1500)
    s.frameTimer = setInterval(grab, FRAME_EVERY_MS)
    // "Stop sharing" in the browser bar: the server goes on with its own pictures.
    for (const t of stream.getVideoTracks()) t.addEventListener('ended', () => stopScreen())
  }

  function stopScreen() {
    const s = screen
    if (!s) return
    screen = null
    clearInterval(s.frameTimer)
    try {
      if (s.recorder.state !== 'inactive') s.recorder.stop()
    } catch {
      // already stopped
    }
    s.stream.getTracks().forEach((t) => t.stop())
    if (s.video) s.video.srcObject = null
  }

  /** The picker of the screen has to open inside the click itself (the browser asks for a user gesture). */
  function askScreen() {
    if (desktop || !navigator.mediaDevices?.getDisplayMedia) return null
    return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 4, max: 8 }, width: { max: 1920 }, height: { max: 1080 } }, audio: false }).catch(() => null)
  }

  // ── following the server ──
  function apply(next, { quiet = false } = {}) {
    const before = session?.status
    // A chunk's answer about another (older) session does not move this window.
    if (next && session && next.id !== session.id && quiet) return
    session = next && ['recording', 'finishing'].includes(next.status) ? next : null
    const live = session?.status === 'recording'
    if (live && ownsAudio()) {
      if (!mic) {
        lastSeq = Math.max(lastSeq, (session.nextSeq ?? 1) - 1)
        startMic()
      }
    } else if (mic) stopMic({ final: true })
    if (!live) {
      stopScreen()
      wantVideo = false
    }
    if (screen?.stream && session?.screenOff) stopScreen()
    if (!quiet && before !== 'recording' && live) toast('Záznam beží · ukladám priebežne, kľudne so mnou hovorte ďalej', { iconName: 'mic', ms: 4200 })
    if (!quiet && before === 'recording' && !live) toast('Záznam ukončený · prepis dokončím a spracujem na pozadí', { iconName: 'mic', ms: 5200 })
    if (!quiet && next?.warn && next.warn !== apply.lastWarn) toast(`Záznam · ${esc(next.warn)}`, { iconName: 'alarm', kind: 'warn', ms: 8000 })
    apply.lastWarn = next?.warn ?? null
    render()
  }

  chip.addEventListener('click', async () => {
    if (session?.status === 'recording') {
      chip.disabled = true
      json('POST', '/api/record/stop', { id: session.id }).then((r) => apply(r.session)).catch((err) => toast(`Záznam · ${esc(err.message)}`, { iconName: 'alarm', kind: 'warn' })).finally(() => (chip.disabled = false))
      return
    }
    if (session?.status === 'finishing') return
    // The screen picker first, while the click still counts as the user's gesture.
    const picking = askScreen()
    chip.disabled = true
    try {
      const r = await json('POST', '/api/record/start', { via: 'page' })
      apply(r.session)
      wantVideo = true
      const stream = picking ? await picking : null
      if (stream && wantVideo && session?.status === 'recording') startScreen(stream)
      else stream?.getTracks().forEach((t) => t.stop())
    } catch (err) {
      ;(picking ? await picking : null)?.getTracks().forEach((t) => t.stop())
      toast(`Záznam sa nespustil · ${esc(err.message)}`, { iconName: 'alarm', kind: 'warn', ms: 7000 })
    } finally {
      chip.disabled = false
    }
  })

  on('record', (s) => apply(s))
  // The window that owns the voice can change (another window closed): it takes over the microphone.
  on('owner', () => setTimeout(() => apply(session), 50))
  const load = () =>
    json('GET', `/api/record${token ? `?token=${encodeURIComponent(token)}` : ''}`)
      .then((r) => apply(r.active, { quiet: true }))
      .catch(() => {})
  load()
  // After a reconnect of the events (a server restart) the state is read again.
  on('boot', () => setTimeout(load, 300))

  // The window closes or reloads: what is in the microphone buffer still goes out, in pieces a
  // keepalive request can carry. The server keeps the session for the window that comes back.
  window.addEventListener('pagehide', () => {
    if (!mic || !session || !mic.frames.length) return
    const frames = mic.frames
    const startAt = mic.startAt ?? Date.now()
    mic.frames = []
    const per = Math.max(1, Math.floor(UNLOAD_PIECE / (frames[0].length * 2)))
    for (let i = 0; i < frames.length; i += per) {
      const piece = frames.slice(i, i + per)
      const at = startAt + i * FRAME_MS
      fetch(`/api/record/chunk?id=${encodeURIComponent(session.id)}&kind=audio&seq=${seqFor(at)}&at=${Math.round(at)}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: encodeWav(piece), keepalive: true }).catch(() => {})
    }
  })

  render()
  return {
    state: () => session,
    recording: () => session?.status === 'recording',
    /** Chunks still on their way: a reload waits for them (main.js). */
    pending: () => queue.length > 0 || sending,
  }
}
