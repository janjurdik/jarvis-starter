// The stream of server events (docs/API.md, SSE /api/events) with one way to open it everywhere.
// On this computer it is a plain EventSource. Through the mobile tunnel it rides a WebSocket
// (/api/events/ws): a Cloudflare quick tunnel holds back server-sent events, a WebSocket goes through.
// The WebSocket carries the very same SSE frames, so a page cannot tell the two apart.
//
//   const source = openEvents('/api/events?client=phone')
//   source.addEventListener('chat', (e) => JSON.parse(e.data))   source.close()

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]'])

class SocketEvents {
  constructor(path) {
    this.path = path
    this.listeners = new Map()
    this.ws = null
    this.closed = false
    this.retry = 3000
    this.connect()
  }

  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set())
    this.listeners.get(name).add(fn)
  }

  removeEventListener(name, fn) {
    this.listeners.get(name)?.delete(fn)
  }

  emit(name, data) {
    for (const fn of this.listeners.get(name) ?? []) fn({ type: name, data })
  }

  connect() {
    if (this.closed) return
    const url = new URL(this.path.replace(/^\/api\/events/, '/api/events/ws'), location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onopen = () => this.emit('open', null)
    ws.onmessage = (e) => {
      // One message is one or more whole SSE frames: "event: x\ndata: {…}\n\n".
      for (const block of String(e.data).split('\n\n')) {
        let event = 'message'
        const data = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7)
          else if (line.startsWith('data: ')) data.push(line.slice(6))
          else if (line.startsWith('retry: ')) this.retry = Number(line.slice(7)) || this.retry
        }
        if (data.length) this.emit(event, data.join('\n'))
      }
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.emit('error', null)
      if (!this.closed) setTimeout(() => this.connect(), this.retry)
    }
  }

  /** Something only the page knows, for example that a phone page is still in front. */
  post(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj))
  }

  close() {
    this.closed = true
    this.ws?.close()
  }
}

export function openEvents(path) {
  if (LOCAL.has(location.hostname) || typeof WebSocket === 'undefined') return new EventSource(path)
  return new SocketEvents(path)
}
