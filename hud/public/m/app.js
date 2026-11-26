// Jarvis on the phone: the conversation, the voice and the jobs, without the 3D world. The same API
// and SSE events as the HUD (docs/API.md). The session cookie from the login goes with every request.
//
// While this page is in front, the phone owns Jarvis's voice: answers are spoken here and the
// computer stays quiet (server/sse.mjs, role `phone`). Hidden or locked, it gives the voice back.

import { openEvents } from '/js/events.js'
import { NODE_ICON, icon, toolIcon } from '/js/icons.js'

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const APPROVE = 'Schvaľujem, pokračuj presne podľa návrhu.'
const SUGGESTIONS = ['Čo mám dnes?', 'Aké mám otvorené úlohy?', 'Čo o mne vieš?']
const ACTIVE = new Set(['queued', 'running', 'needs_ok'])

const feed = $('feed')
const feedIn = $('feed-in')
const text = $('text')
const send = $('send')
const talk = $('talk')
const stateEl = $('state')
const app = $('app')

send.innerHTML = icon('send')
talk.innerHTML = icon('mic')
$('stop').innerHTML = `${icon('stop')}<span>Zastaviť</span>`
$('full').innerHTML = `${icon('app')}<span>Otvoriť celého Jarvisa</span>`
$('logout').innerHTML = `${icon('power')}<span>Odhlásiť sa</span>`

let status = null
let me = null
let owner = null
let voice = 'idle'
let connected = false
let source = null
let aliveTimer = 0
const turns = new Map()
const jobs = new Map()

// ── server ──

function toLogin() {
  location.replace(`/m/login.html?next=${encodeURIComponent('/m/')}`)
}

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' })
  if (res.status === 401) {
    toLogin()
    throw new Error('Najprv sa prihláste.')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.ok === false) throw new Error(data?.error ?? `chyba ${res.status}`)
  return data
}

let hintTimer = 0
function hint(message, { warn = false, ms = 3200 } = {}) {
  const el = $('hint')
  el.textContent = message
  el.classList.toggle('is-warn', warn)
  el.hidden = false
  clearTimeout(hintTimer)
  hintTimer = setTimeout(() => (el.hidden = true), ms)
}

// ── what Jarvis is doing, in the header ──

const VOICE_TEXT = { idle: 'Pripravený', listening: 'Počúvam', transcribing: 'Prepisujem, čo ste povedali', thinking: 'Premýšľam…', speaking: 'Hovorím', wake: 'Počúvam' }
function paintState() {
  app.classList.toggle('is-thinking', voice === 'thinking' || voice === 'transcribing')
  app.classList.toggle('is-speaking', voice === 'speaking' || playing)
  app.classList.toggle('is-listening', Boolean(rec))
  let line = !connected ? 'Pripájam sa…' : rec ? 'Počúvam, pustite a pošlem' : playing ? 'Hovorím' : VOICE_TEXT[voice] ?? 'Pripravený'
  if (connected && status && status.brain !== 'ready' && status.brain !== 'mock' && voice === 'idle' && !rec) line = status.brain === 'starting' ? 'Prebúdzam sa…' : 'Mozog teraz nebeží'
  stateEl.textContent = line
  stateEl.className = !connected ? 'is-off' : voice !== 'idle' || rec || playing ? 'is-on' : ''
  $('busy').hidden = !(voice === 'thinking' || voice === 'speaking' || playing)
}

// ── the conversation ──

const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120
function toBottom(force = false) {
  if (force || nearBottom()) requestAnimationFrame(() => (feed.scrollTop = feed.scrollHeight))
}

/** Plain text with links that open in a new tab. Nothing else of the answer is HTML. */
function linkify(s) {
  return esc(s).replace(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
}

/**
 * Photos, videos and audio of a card, inline in the conversation. The files come from the same
 * logged-in session as everything else; a tap on a photo shows it across the whole width.
 */
function mediaHtml(items) {
  const ok = /^\/api\/(?:media\/m[0-9a-f]{16}|jobs\/j\d+\/file\/\d{1,2})$/
  const list = items.filter((m) => m && ok.test(String(m.url ?? ''))).slice(0, 24)
  if (!list.length) return ''
  return `<div class="card-media">${list
    .map((m) => {
      const url = esc(m.url)
      if (m.kind === 'image') return `<img class="cm-img" src="${url}" alt="${esc(m.name ?? '')}" loading="lazy" decoding="async">`
      if (m.kind === 'video') return `<video class="cm-video" src="${url}#t=0.1" controls playsinline preload="metadata"></video>`
      if (m.kind === 'audio') return `<div class="cm-audio"><span>${esc(m.name ?? '')}</span><audio src="${url}" controls preload="none"></audio></div>`
      return ''
    })
    .join('')}</div>`
}

function cardHtml(c = {}) {
  // The login card is filled in only at the computer: a password never goes through the tunnel (server/login.mjs).
  if (c.kind === 'login') {
    const text = c.state === 'done' ? c.message || 'Prihlásené.' : c.state === 'closed' ? c.message || 'Prihlásenie zrušené.' : 'Prihlásenie dokončíte priamo na počítači, na ktorom bežím. Heslo cez internet neposielam.'
    return `<div class="card"><div class="card-h">${icon(c.icon || NODE_ICON[c.node] || 'shield')}<span>${esc(c.title ?? 'Prihlásenie')}</span></div><p class="card-text">${esc(text)}</p></div>`
  }
  const acc = c.accent === 'amber' ? ' acc-amber' : c.accent === 'red' ? ' acc-red' : ''
  let body = ''
  if (c.value !== null && c.value !== undefined && c.value !== '') body += `<div class="card-v">${esc(c.value)}${c.unit ? `<small>${esc(c.unit)}</small>` : ''}</div>`
  if (Array.isArray(c.series) && c.series.length) {
    const vals = c.series.map((s) => Number(s.value) || 0)
    const max = Math.max(...vals, 1)
    body += `<div class="card-chart">${c.series.map((s, i) => `<span class="${i === vals.length - 1 ? 'hi' : ''}"><i style="height:${Math.max(6, Math.round((vals[i] / max) * 100))}%"></i><em>${esc(s.label ?? '')}</em></span>`).join('')}</div>`
  }
  if (Array.isArray(c.items) && c.items.length) body += `<ul class="card-list">${c.items.map((it) => `<li><span>${esc(it.label ?? '')}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span><span>${esc(it.value ?? '')}</span></li>`).join('')}</ul>`
  if (c.text) body += `<p class="card-text">${linkify(c.text)}</p>`
  if (Array.isArray(c.media) && c.media.length) body += mediaHtml(c.media)
  if (c.caption) body += `<div class="card-c">${esc(c.caption)}</div>`
  return `<div class="card${acc}"><div class="card-h">${icon(c.icon || NODE_ICON[c.node] || 'sparkle')}<span>${esc(c.title ?? '')}</span></div>${body}</div>`
}

function emptyState() {
  if (turns.size) return
  feedIn.innerHTML = `<div class="empty" id="empty"><span class="mark" aria-hidden="true"><svg viewBox="0 0 40 40"><path class="r" d="M22.95 3.26A17 17 0 0 1 35.97 25.81M33.02 30.93A17 17 0 0 1 6.98 30.93M4.03 25.81A17 17 0 0 1 17.05 3.26"/><circle class="d" cx="20" cy="20" r="10.5"/><circle class="c" cx="20" cy="20" r="4.8"/></svg></span><p>Čo pre vás môžem urobiť?</p><div class="chips">${SUGGESTIONS.map((s) => `<button type="button" data-say="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`
}

/** One turn: the user's sentence (when there is one) and Jarvis's answer under it. */
function turnFor(id) {
  const key = String(id)
  let t = turns.get(key)
  if (t) return t
  $('empty')?.remove()
  const wrap = document.createElement('div')
  wrap.className = 'turn'
  wrap.style.display = 'contents'
  wrap.innerHTML = '<div class="msg-u" hidden></div><div class="msg-j"><div class="tools" hidden></div><p class="txt" hidden></p><div class="cards"></div></div>'
  feedIn.append(wrap)
  t = { id: key, wrap, user: wrap.querySelector('.msg-u'), tools: wrap.querySelector('.tools'), txt: wrap.querySelector('.txt'), cards: wrap.querySelector('.cards'), text: '', toolMap: new Map(), dots: null }
  turns.set(key, t)
  return t
}

function setUser(t, textValue, via) {
  if (!textValue) return
  t.user.hidden = false
  t.user.innerHTML = `${via === 'voice' ? icon('mic') : ''}${esc(textValue)}`
}

function setText(t, value) {
  t.text = value
  t.txt.hidden = !value
  t.txt.innerHTML = linkify(value)
}

function thinking(t, on) {
  if (on && !t.dots) {
    t.dots = document.createElement('span')
    t.dots.className = 'thinking'
    t.dots.setAttribute('aria-label', 'Jarvis premýšľa')
    t.dots.innerHTML = '<i></i><i></i><i></i>'
    t.txt.before(t.dots)
  } else if (!on && t.dots) {
    t.dots.remove()
    t.dots = null
  }
}

function paintTools(t) {
  const list = [...t.toolMap.values()]
  t.tools.hidden = !list.length
  t.tools.innerHTML = list.map((x) => `<span class="tool ${x.status === 'error' ? 'error' : x.status === 'ok' ? 'ok' : 'run'}">${icon(toolIcon(x))}<span>${esc(x.label || x.name || 'Pracujem')}${x.status === 'run' ? '…' : ''}</span></span>`).join('')
}

function renderHistory(list) {
  turns.clear()
  feedIn.innerHTML = ''
  for (const h of Array.isArray(list) ? list : []) {
    const t = turnFor(h.turn)
    setUser(t, h.user, h.via)
    setText(t, h.jarvis || '')
    if (h.error && !h.jarvis) {
      t.txt.hidden = false
      t.txt.classList.add('is-err')
      t.txt.textContent = h.error
    }
    t.cards.innerHTML = (h.cards ?? []).map(cardHtml).join('')
  }
  emptyState()
  toBottom(true)
}

function onChat(ev) {
  if (!ev || ev.turn === undefined) return
  const stick = nearBottom()
  const t = turnFor(ev.turn)
  if (ev.phase === 'user') setUser(t, ev.text, ev.via)
  else if (ev.phase === 'start') thinking(t, true)
  else if (ev.phase === 'delta') {
    thinking(t, false)
    setText(t, t.text + (ev.text ?? ''))
  } else if (ev.phase === 'tool') {
    t.toolMap.set(ev.id, { name: ev.name, label: ev.label, icon: ev.icon, node: ev.node, status: ev.status })
    paintTools(t)
  } else if (ev.phase === 'card' && ev.card) {
    thinking(t, false)
    t.cards.insertAdjacentHTML('beforeend', cardHtml(ev.card))
  } else if (ev.phase === 'done') {
    thinking(t, false)
    if (ev.text && ev.text.length >= t.text.length) setText(t, ev.text)
    if (!t.text && !t.cards.children.length && !t.user.hidden && ev.stopped) setText(t, 'Zastavené.')
  } else if (ev.phase === 'error') {
    thinking(t, false)
    t.txt.hidden = false
    t.txt.classList.add('is-err')
    t.txt.textContent = ev.message || 'Niečo sa pokazilo.'
  }
  if (stick || ev.phase === 'user') toBottom(true)
}

async function say(value, via = 'text') {
  const msg = String(value ?? '').trim()
  if (!msg) return
  unlockAudio()
  try {
    const r = await api('POST', '/api/chat', { text: msg, via })
    if (r.turn !== undefined && r.turn !== null) {
      const t = turnFor(r.turn)
      if (t.user.hidden) setUser(t, msg, via)
      if (!t.text && !t.dots) thinking(t, true)
      toBottom(true)
    }
  } catch (err) {
    hint(`Neodoslané: ${err.message}`, { warn: true })
  }
}

// ── jobs in the background: what runs, and what waits for an answer ──

function paintJobs() {
  const stick = nearBottom()
  const box = $('jobs')
  const list = [...jobs.values()].filter((j) => ACTIVE.has(j.status)).sort((a, b) => (b.status === 'needs_ok') - (a.status === 'needs_ok'))
  box.hidden = !list.length
  box.innerHTML = list
    .map((j) => {
      if (j.status !== 'needs_ok') return `<div class="job"><div class="job-h"><span class="spin" aria-hidden="true"></span><b>${esc(j.title)}</b><em>${j.status === 'queued' ? 'v poradí' : 'beží'}</em></div>${j.step ? `<p class="job-step">${esc(j.step)}</p>` : ''}</div>`
      const question = j.wait === 'question'
      return `<div class="job is-wait" data-job="${esc(j.id)}"><div class="job-h"><span class="dot" aria-hidden="true"></span><b>${esc(j.title)}</b><em>${question ? 'mám otázku' : 'čakám na súhlas'}</em></div><p class="job-q">${linkify(j.needsOk ?? '')}</p><div class="job-acts">${question ? '' : `<button type="button" class="btn is-amber" data-act="ok">${icon('check')}<span>Schváliť</span></button>`}<form data-act="reply"><input type="text" maxlength="4000" placeholder="${question ? 'Odpoveď…' : 'Alebo napíšte, čo zmeniť…'}" enterkeyhint="send" autocomplete="off"><button type="submit" class="btn${question ? ' is-main' : ''}" aria-label="Poslať">${icon('send')}</button></form></div></div>`
    })
    .join('')
  // The list above grew or shrank: the conversation stays at its newest line.
  if (stick) toBottom(true)
}

async function loadJobs() {
  try {
    const list = await api('GET', '/api/jobs')
    jobs.clear()
    for (const j of Array.isArray(list) ? list : []) jobs.set(j.id, j)
    paintJobs()
  } catch {
    // the jobs come again with the next event
  }
}

$('jobs').addEventListener('click', async (e) => {
  const ok = e.target.closest('[data-act="ok"]')
  if (!ok) return
  const id = ok.closest('[data-job]').dataset.job
  ok.disabled = true
  try {
    await api('POST', `/api/jobs/${encodeURIComponent(id)}/reply`, { text: APPROVE })
    hint('Schválené, pokračujem.')
  } catch (err) {
    ok.disabled = false
    hint(`Nepodarilo sa: ${err.message}`, { warn: true })
  }
})
$('jobs').addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-act="reply"]')
  if (!form) return
  e.preventDefault()
  const input = form.querySelector('input')
  const value = input.value.trim()
  if (!value) return
  const id = form.closest('[data-job]').dataset.job
  input.disabled = true
  try {
    await api('POST', `/api/jobs/${encodeURIComponent(id)}/reply`, { text: value })
    hint('Odoslané, pokračujem.')
  } catch (err) {
    input.disabled = false
    hint(`Nepodarilo sa: ${err.message}`, { warn: true })
  }
})

// ── Jarvis's voice on the phone ──
// One <audio> for every clip. iOS lets a page play sound only after a tap, so the first tap plays a
// moment of silence and the element stays unlocked from then on.

const audio = new Audio()
audio.preload = 'auto'
let unlocked = false
let playing = null
let speakTurn = null
const clips = new Map()
let nextSeq = null
let gapSince = 0

function silentWav() {
  const n = 800
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  w(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  w(8, 'WAVEfmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, 8000, true)
  v.setUint32(28, 16000, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  w(36, 'data')
  v.setUint32(40, n * 2, true)
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
}

function unlockAudio() {
  if (unlocked) return
  unlocked = true
  if (playing) return
  audio.src = silentWav()
  audio.play().catch(() => (unlocked = false))
}

function stopVoice() {
  clips.clear()
  nextSeq = null
  playing = null
  audio.pause()
  window.speechSynthesis?.cancel()
  paintState()
}

function pump() {
  if (playing || nextSeq === null) return
  let clip = clips.get(nextSeq)
  if (!clip) {
    const later = [...clips.keys()].filter((s) => s > nextSeq)
    if (!later.length) return
    gapSince ||= Date.now()
    // A sentence that never came: after a moment the next one plays.
    if (Date.now() - gapSince < 2500) return void setTimeout(pump, 300)
    nextSeq = Math.min(...later)
    clip = clips.get(nextSeq)
  }
  gapSince = 0
  clips.delete(nextSeq)
  const turn = speakTurn
  const seq = clip.seq
  nextSeq = seq + 1
  const finished = () => {
    if (playing !== clip) return
    playing = null
    fetch('/api/tts/played', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ turn, seq }) }).catch(() => {})
    paintState()
    pump()
  }
  playing = clip
  paintState()
  if (clip.speak && !clip.url) {
    const u = new SpeechSynthesisUtterance(clip.text)
    u.lang = status?.lang ?? 'sk-SK'
    u.onend = finished
    u.onerror = finished
    return window.speechSynthesis?.speak(u) ?? finished()
  }
  audio.onended = finished
  audio.onerror = finished
  audio.src = clip.url
  audio.play().catch(() => {
    finished()
    if (!unlocked) hint('Ťuknite kamkoľvek, aby som mohol hovoriť.')
  })
}

function onTts(msg) {
  if (!msg || owner !== me) return
  const t = String(msg.turn ?? '')
  if (msg.stop) {
    if (t === speakTurn) stopVoice()
    return
  }
  if (!msg.url && !msg.speak) return
  if (t !== speakTurn) {
    stopVoice()
    speakTurn = t
  }
  const seq = Number(msg.seq) || 0
  clips.set(seq, { seq, url: msg.url, text: msg.text ?? '', speak: msg.speak === true })
  if (nextSeq === null) nextSeq = Math.min(...clips.keys())
  pump()
}

// ── hold to talk ──
// With a local Whisper on the computer the phone records and sends the file (/api/stt); otherwise
// the phone's own speech recognition writes it down and sends the text.

let rec = null
let pressAt = 0
const localStt = () => status && !['browser', 'off'].includes(status.sttEngine)
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition

async function startTalk() {
  unlockAudio()
  if (rec) return
  if (voice === 'speaking' || playing || voice === 'thinking') {
    stopVoice()
    api('POST', '/api/chat/stop').catch(() => {})
  }
  pressAt = Date.now()
  if (!localStt()) return startRecognition()
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return startRecognition()
  const r = { kind: 'media', chunks: [], cancelled: false }
  rec = r
  paintState()
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    if (rec !== r) return stream.getTracks().forEach((x) => x.stop())
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported?.(m)) ?? ''
    r.stream = stream
    r.recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    r.recorder.ondataavailable = (e) => e.data.size && r.chunks.push(e.data)
    r.recorder.onstop = () => finishMedia(r)
    r.recorder.start()
    meter(r, stream)
  } catch {
    rec = null
    talk.classList.remove('is-rec')
    paintState()
    hint('Mikrofón nie je povolený. Povoľte ho pre túto stránku v nastaveniach prehliadača.', { warn: true, ms: 6000 })
    return
  }
  talk.classList.add('is-rec')
  if (navigator.vibrate) navigator.vibrate(12)
}

function meter(r, stream) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const an = ctx.createAnalyser()
    an.fftSize = 512
    ctx.createMediaStreamSource(stream).connect(an)
    const data = new Uint8Array(an.fftSize)
    r.ctx = ctx
    const tick = () => {
      if (rec !== r) return
      an.getByteTimeDomainData(data)
      let peak = 0
      for (const x of data) peak = Math.max(peak, Math.abs(x - 128))
      talk.style.setProperty('--lvl', Math.min(1, peak / 64).toFixed(2))
      requestAnimationFrame(tick)
    }
    tick()
  } catch {
    // no level meter, the recording works anyway
  }
}

async function finishMedia(r) {
  r.stream?.getTracks().forEach((x) => x.stop())
  r.ctx?.close().catch(() => {})
  if (r.cancelled || !r.chunks.length) return
  const blob = new Blob(r.chunks, { type: r.recorder?.mimeType || r.chunks[0].type || 'audio/webm' })
  if (blob.size < 1500) return hint('Nič som nepočul. Podržte tlačidlo a hovorte.')
  voice = 'transcribing'
  paintState()
  try {
    const res = await fetch('/api/stt', { method: 'POST', headers: { 'content-type': blob.type.split(';')[0] || 'audio/webm' }, body: blob, cache: 'no-store' })
    if (res.status === 401) return toLogin()
    const out = await res.json().catch(() => ({}))
    if (res.status === 409 && status) status.sttEngine = 'browser'
    if (!res.ok || out.ok === false) throw new Error(out.error ?? `chyba ${res.status}`)
    if (out.turn !== null && out.turn !== undefined) {
      const t = turnFor(out.turn)
      if (t.user.hidden) setUser(t, out.text, 'voice')
      toBottom(true)
    }
  } catch (err) {
    voice = 'idle'
    paintState()
    hint(`Prepis sa nepodaril: ${err.message}`, { warn: true, ms: 5000 })
  }
}

function startRecognition() {
  if (!Recognition) return hint('Hlas tu nefunguje, napíšte mi to prosím.', { warn: true, ms: 5000 })
  const r = { kind: 'speech', text: '', cancelled: false }
  const sr = new Recognition()
  sr.lang = status?.lang ?? 'sk-SK'
  sr.interimResults = true
  sr.continuous = true
  sr.onresult = (e) => {
    r.text = [...e.results].map((x) => x[0]?.transcript ?? '').join(' ').replace(/\s+/g, ' ').trim()
  }
  sr.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') hint('Mikrofón alebo rozpoznávanie reči nie je povolené.', { warn: true, ms: 6000 })
  }
  sr.onend = () => {
    if (rec === r) stopTalk()
    if (!r.cancelled && r.text) say(r.text, 'voice')
  }
  r.sr = sr
  rec = r
  try {
    sr.start()
  } catch {
    rec = null
    return
  }
  talk.classList.add('is-rec')
  paintState()
}

function stopTalk({ cancel = false } = {}) {
  const r = rec
  if (!r) return
  rec = null
  talk.classList.remove('is-rec')
  talk.style.removeProperty('--lvl')
  const short = Date.now() - pressAt < 350
  r.cancelled = cancel || short
  if (r.kind === 'media') {
    if (r.recorder && r.recorder.state !== 'inactive') r.recorder.stop()
    else r.stream?.getTracks().forEach((x) => x.stop())
  } else r.sr?.stop()
  if (short && !cancel) hint('Podržte tlačidlo a hovorte, pustením pošlem.')
  paintState()
}

talk.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  talk.setPointerCapture?.(e.pointerId)
  startTalk()
})
talk.addEventListener('pointerup', () => stopTalk())
talk.addEventListener('pointercancel', () => stopTalk({ cancel: true }))
talk.addEventListener('contextmenu', (e) => e.preventDefault())

// ── typing ──

function fit() {
  text.style.height = 'auto'
  text.style.height = `${Math.min(text.scrollHeight, 136)}px`
  send.disabled = !text.value.trim()
}
text.addEventListener('input', fit)
text.addEventListener('keydown', (e) => {
  // Enter sends on a keyboard; on a phone the return key of the keyboard makes a new line only with Shift.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    $('bar').requestSubmit()
  }
})
$('bar').addEventListener('submit', (e) => {
  e.preventDefault()
  const value = text.value.trim()
  if (!value) return
  text.value = ''
  fit()
  say(value)
})
feedIn.addEventListener('click', (e) => {
  const photo = e.target.closest('.cm-img')
  if (photo) return photo.classList.toggle('is-big')
  const chip = e.target.closest('[data-say]')
  if (chip) say(chip.dataset.say)
})
$('stop').addEventListener('click', () => {
  stopVoice()
  api('POST', '/api/chat/stop').catch(() => {})
})
document.addEventListener('pointerdown', unlockAudio, { capture: true })

// ── the menu ──

const menu = $('menu')
$('menu-btn').addEventListener('click', (e) => {
  e.stopPropagation()
  menu.hidden = !menu.hidden
  $('menu-btn').setAttribute('aria-expanded', String(!menu.hidden))
})
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true
})
$('logout').addEventListener('click', async () => {
  try {
    await api('POST', '/api/remote/logout')
  } catch {
    // logged out either way below
  }
  location.replace('/m/login.html')
})

// ── events from the server ──

function alive() {
  if (!me || document.visibilityState !== 'visible') return
  if (source?.post) return source.post({ alive: me })
  fetch('/api/remote/alive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: me }), cache: 'no-store' }).catch(() => {})
}

async function catchUp() {
  try {
    const [history, st] = await Promise.all([api('GET', '/api/chat/history'), api('GET', '/api/status')])
    status = st
    voice = st.voiceState ?? voice
    renderHistory(history)
  } catch {
    // the stream reconnects on its own
  }
  loadJobs()
  paintState()
}

function connect() {
  if (source) return
  source = openEvents('/api/events?client=phone')
  const on = (name, fn) =>
    source.addEventListener(name, (e) => {
      try {
        fn(JSON.parse(e.data))
      } catch (err) {
        console.error(`SSE ${name}:`, err)
      }
    })
  on('you', (m) => (me = m?.id ?? null))
  on('owner', (m) => {
    owner = m?.id ?? null
    if (owner !== me && playing) stopVoice()
  })
  on('status', (s) => {
    status = s
    paintState()
  })
  on('voice', (v) => {
    if (!v?.state) return
    voice = v.state
    paintState()
  })
  on('chat', onChat)
  on('tts', onTts)
  on('job', (j) => {
    if (!j?.id) return
    const was = jobs.get(j.id)?.status
    jobs.set(j.id, j)
    paintJobs()
    if (j.status === 'needs_ok' && was !== 'needs_ok' && navigator.vibrate) navigator.vibrate([30, 60, 30])
  })
  // The server started again or the page changed: this page loads itself again.
  let boot = null
  on('boot', (b) => {
    if (boot && b?.id && b.id !== boot && !rec && !playing) location.reload()
    boot = b?.id ?? boot
  })
  on('reload', () => {
    if (!rec && !playing) location.reload()
  })
  source.addEventListener('open', () => {
    connected = true
    catchUp()
    clearInterval(aliveTimer)
    aliveTimer = setInterval(alive, 20_000)
    setTimeout(alive, 500)
  })
  source.addEventListener('error', () => {
    connected = false
    paintState()
    // A stream refused for a lost login does not recover by retrying: ask once.
    fetch('/api/remote/session', { cache: 'no-store' })
      .then((r) => r.json())
      .then((s) => {
        if (s && !s.loggedIn) toLogin()
      })
      .catch(() => {})
  })
}

function disconnect() {
  clearInterval(aliveTimer)
  source?.close()
  source = null
  connected = false
  me = null
  owner = null
}

// Hidden or locked: the stream closes and the computer gets its voice back. Back in front: everything again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') connect()
  else disconnect()
})
window.addEventListener('pagehide', disconnect)
window.addEventListener('pageshow', () => document.visibilityState === 'visible' && connect())

api('GET', '/api/settings')
  .then((s) => {
    const name = String(s?.assistant?.name ?? '').trim()
    if (name) {
      $('name').textContent = name
      document.title = name
      text.placeholder = name === 'Jarvis' ? 'Napíšte Jarvisovi…' : 'Napíšte správu…'
    }
  })
  .catch(() => {})
emptyState()
fit()
paintState()
connect()
