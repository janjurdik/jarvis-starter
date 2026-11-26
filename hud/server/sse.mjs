/**
 * SSE hub: jeden zdroj pravdy pre všetky udalosti, ktoré HUD dostáva.
 * Pomenované udalosti (event: chat|tts|voice|world|hud|snapshot|status|mode), `hud` má históriu ako v1.
 */
const clients = new Set()
// res → 'desktop' (appka Jarvis na ploche Macu) | 'app' (the app window) | 'browser' (a plain tab)
const roles = new Map()
// res → { id, at }: who connected when. One window owns the voice: the desktop before the app window
// before a browser tab, and among equals the one that has been there longest. Any other window open
// at the same time (somebody opened the address in a browser) shows Jarvis but stays silent.
const ids = new Map()
let nextId = 0
let ownerId = null
const RANK = { desktop: 0, app: 1, browser: 2 }

function pickOwner() {
  let best = null
  for (const res of clients) {
    const me = { id: ids.get(res)?.id, at: ids.get(res)?.at ?? 0, rank: RANK[roles.get(res)] ?? 2 }
    if (!best || me.rank < best.rank || (me.rank === best.rank && me.at < best.at)) best = me
  }
  const next = best?.id ?? null
  if (next === ownerId) return
  ownerId = next
  const payload = frame('owner', { id: ownerId })
  for (const res of clients) res.write(payload)
}
const hudHistory = []
let hudSeq = 0
let onConnect = () => []
let onRoles = () => {}

/** Zavolá sa, keď sa pripojí alebo odpojí appka na ploche (status.desktop sa zmení). */
export function setOnRolesChange(fn) {
  onRoles = fn
}

/** Funkcia, ktorá pri pripojení vráti [[event, data], …] na úvod (status, mode, voice). */
export function setGreeting(fn) {
  onConnect = fn
}

const frame = (event, data, id) => `${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

export function send(event, data) {
  const payload = frame(event, data)
  for (const res of clients) res.write(payload)
}

/** v1 `hud` udalosť do LOGu (s id a históriou). */
export function sendHud(fields) {
  const event = { id: ++hudSeq, ts: new Date().toISOString(), ...fields }
  hudHistory.push(event)
  if (hudHistory.length > 20) hudHistory.shift()
  const payload = frame('hud', event, event.id)
  for (const res of clients) res.write(payload)
  return event
}

export const clientCount = () => clients.size

/** Počet pripojených appiek na ploche. Kým je aspoň jedna, hlas hrá len ona (karty v Chrome mlčia). */
export const desktopCount = () => [...roles.values()].filter((r) => r === 'desktop').length

/** Open windows by their place: { desktop, app, browser } (scripts/hud.mjs waits for the new one when Jarvis moves). */
export function roleCounts() {
  const out = { desktop: 0, app: 0, browser: 0 }
  for (const r of roles.values()) out[r] = (out[r] ?? 0) + 1
  return out
}

export function openStream(req, res, { role = 'browser' } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write('retry: 3000\n\n')
  res.write(frame('history', hudHistory))
  for (const [event, data] of onConnect()) res.write(frame(event, data))
  clients.add(res)
  roles.set(res, RANK[role] === undefined ? 'browser' : role)
  const id = `w${++nextId}`
  ids.set(res, { id, at: Date.now() })
  res.write(frame('you', { id }))
  if (role === 'desktop') onRoles()
  pickOwner()
  // The newcomer always hears who owns the voice, also when its arrival changed nothing.
  res.write(frame('owner', { id: ownerId }))
  req.on('close', () => {
    clients.delete(res)
    const was = roles.get(res)
    roles.delete(res)
    ids.delete(res)
    if (was === 'desktop') onRoles()
    pickOwner()
  })
}

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n')
}, 15_000).unref()
