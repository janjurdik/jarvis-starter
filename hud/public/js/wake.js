// „Hey Jarvis" cez mikrofón prehliadača: getUserMedia (surový zvuk, hlasitosť dorovná worklet)
// → AudioWorklet (16 kHz Int16, rámce 80 ms) → WebSocket /api/mic. Wake word, koniec vety a prepis
// rieši server, výsledok príde cez SSE `voice` a `chat` ako pri hlase.
//
// Server cez ten istý WebSocket hlási, či je wake zapnutý ({type: 'wake', on}). Mikrofón je otvorený
// a stream ide len pri zapnutom wake a viditeľnej karte, pri skrytí karty sa mikrofón uvoľní.
// Aktívna je vždy len posledná karta: staršia dostane `replaced` a mikrofón vráti, kým nebude znova viditeľná.
//
//   const wake = createWake({ onLevel, onState, onError })
//   wake.start()   // pripojí sa, ďalej sa riadi stavom servera (POST /api/listen/wake {on})
//   wake.stop()
//   wake.active    // true, keď práve streamuje
//
// onState: 'off' | 'connecting' | 'idle' (wake vypnutý) | 'streaming' | 'paused' (skrytá karta) |
//          'suspended' (Chrome čaká na klik alebo kláves, potom sám pokračuje) | 'blocked' (mikrofón
//          zamietnutý) | 'replaced' (mikrofón má iná karta) | 'reconnecting' | 'error'
// onLevel(0..1): hlasitosť mikrofónu ~12x za sekundu, kým streamuje (na f.listen).

const levelOf = (rms) => Math.min(1, Math.sqrt(rms / 0.12))

// desktop: true v appke Jarvis HUD.app na ploche. Okno plochy je často zakryté inými oknami
// (document.hidden), „Hey Jarvis" má však počúvať stále, preto sa tam stream pri skrytí nepozastaví.
export function createWake({ onLevel, onState, onError, query = null, desktop = false } = {}) {
  let started = false
  let state = 'off'
  let ws = null
  let wsOpen = false
  let serverWake = false
  let retry = 0
  let retryTimer = null
  let ctx = null
  let stream = null
  let source = null
  let node = null
  let mute = null
  let acquiring = null
  let wantMic = false
  let failedAt = 0
  let retryMicTimer = null

  const token = new URLSearchParams(location.search).get('token')
  const visible = () => desktop || document.visibilityState === 'visible'
  const wantStream = () => started && wsOpen && serverWake && visible()

  function setState(next) {
    if (next === state) return
    state = next
    onState?.(next)
  }

  function wsUrl() {
    const params = new URLSearchParams(query ?? {})
    if (token) params.set('token', token)
    if (desktop) params.set('client', 'desktop')
    const qs = params.toString()
    return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/mic${qs ? `?${qs}` : ''}`
  }

  function connect() {
    if (!started || ws) return
    clearTimeout(retryTimer)
    setState(retry ? 'reconnecting' : 'connecting')
    const sock = new WebSocket(wsUrl())
    sock.binaryType = 'arraybuffer'
    ws = sock
    sock.onopen = () => {
      if (ws !== sock) return
      wsOpen = true
      retry = 0
    }
    sock.onmessage = (e) => {
      if (ws !== sock || typeof e.data !== 'string') return
      let msg
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      if (msg.type === 'hello') serverWake = Boolean(msg.wake)
      else if (msg.type === 'wake') serverWake = Boolean(msg.on)
      update()
    }
    sock.onclose = (e) => {
      if (ws !== sock) return
      ws = null
      wsOpen = false
      releaseMic()
      if (!started) return setState('off')
      // Novšia karta prevzala mikrofón: nebojovať o neho, znova sa pripojí, až keď bude táto karta viditeľná.
      // 4002 = mikrofón má appka na ploche, karta v prehliadači ho nechá tak.
      if (e.code === 4001 || e.code === 4002) return setState('replaced')
      const delay = Math.min(10_000, 500 * 2 ** retry++)
      setState('reconnecting')
      retryTimer = setTimeout(connect, delay)
    }
    sock.onerror = () => {}
  }

  function releaseMic() {
    wantMic = false
    for (const track of stream?.getTracks() ?? []) track.stop()
    try {
      source?.disconnect()
      node?.disconnect()
      mute?.disconnect()
    } catch {
      // už odpojené
    }
    if (node) node.port.onmessage = null
    ctx?.close().catch(() => {})
    ctx = stream = source = node = mute = null
    onLevel?.(0)
  }

  async function acquireMic() {
    wantMic = true
    if (node || acquiring) return acquiring
    acquiring = (async () => {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          // Raw capture: the system's voice processing would take the microphone away from a call in another app (see speech.js).
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        })
        if (!wantMic) {
          for (const track of media.getTracks()) track.stop()
          return
        }
        stream = media
        ctx = new AudioContext({ latencyHint: 'interactive' })
        await ctx.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url))
        if (!wantMic) return releaseMic()
        source = ctx.createMediaStreamSource(stream)
        node = new AudioWorkletNode(ctx, 'mic-frames', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
        // Uzol musí byť napojený na výstup, inak ho Chrome nemusí spracúvať. Nulová hlasitosť.
        mute = ctx.createGain()
        mute.gain.value = 0
        source.connect(node)
        node.connect(mute)
        mute.connect(ctx.destination)
        node.port.onmessage = (e) => {
          const { pcm, rms } = e.data
          onLevel?.(levelOf(rms))
          if (wantStream() && ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < 64_000) ws.send(pcm)
        }
        ctx.onstatechange = () => update()
        for (const track of stream.getTracks()) track.onended = () => update()
        if (ctx.state !== 'running') await ctx.resume().catch(() => {})
      } catch (err) {
        releaseMic()
        failedAt = Date.now()
        setState(err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'blocked' : 'error')
        onError?.(err)
      }
    })().finally(() => {
      acquiring = null
      update()
    })
    return acquiring
  }

  function update() {
    if (!started) return setState('off')
    if (state === 'blocked') return
    if (!ws) return
    if (!wsOpen) return setState(retry ? 'reconnecting' : 'connecting')
    if (wantStream()) {
      if (!node) {
        // Po chybe mikrofónu (nie zamietnutí) skúsi znova o 5 s, nie v slučke.
        const wait = failedAt + 5000 - Date.now()
        if (wait > 0) {
          clearTimeout(retryMicTimer)
          retryMicTimer = setTimeout(update, wait)
          return
        }
        acquireMic()
        return
      }
      if (stream && stream.getTracks().some((t) => t.readyState === 'ended')) {
        releaseMic()
        acquireMic()
        return
      }
      return setState(ctx?.state === 'running' ? 'streaming' : 'suspended')
    }
    releaseMic()
    setState(!serverWake ? 'idle' : 'paused')
  }

  const onVisibility = () => {
    if (!started) return
    if (visible() && !ws) {
      retry = 0
      connect()
    }
    update()
  }
  // Chrome spustí AudioContext až po geste používateľa, ak ho stránka ešte nemala.
  const unlock = () => {
    if (ctx && ctx.state === 'suspended') ctx.resume().then(update, () => {})
  }

  return {
    start() {
      if (started) return
      started = true
      retry = 0
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('pointerdown', unlock, true)
      window.addEventListener('keydown', unlock, true)
      if (state === 'blocked') state = 'off'
      connect()
    },
    stop() {
      started = false
      clearTimeout(retryTimer)
      clearTimeout(retryMicTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pointerdown', unlock, true)
      window.removeEventListener('keydown', unlock, true)
      releaseMic()
      const sock = ws
      ws = null
      wsOpen = false
      sock?.close(1000)
      setState('off')
    },
    get active() {
      return state === 'streaming'
    },
    get state() {
      return state
    },
  }
}
