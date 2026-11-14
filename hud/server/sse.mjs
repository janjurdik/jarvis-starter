/**
 * SSE hub: jeden zdroj pravdy pre všetky udalosti, ktoré HUD dostáva.
 * Pomenované udalosti (event: chat|tts|voice|world|hud|snapshot|status|mode), `hud` má históriu ako v1.
 */
const clients = new Set()
const roles = new Map() // res → 'desktop' (appka Jarvis HUD.app na ploche) | 'browser'
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
  roles.set(res, role === 'desktop' ? 'desktop' : 'browser')
  if (role === 'desktop') onRoles()
  req.on('close', () => {
    clients.delete(res)
    const was = roles.get(res)
    roles.delete(res)
    if (was === 'desktop') onRoles()
  })
}

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n')
}, 15_000).unref()
