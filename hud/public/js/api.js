// Klient API servera (kontrakt v docs/V2-SPEC.md, sekcia 3). POST endpointy idú
// len z loopbacku, pri HUD_HOST=0.0.0.0 server chce token: ?token=… v URL HUD.

export function createApi({ token = null } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) {
    headers.authorization = `Bearer ${token}`
    headers['x-hud-token'] = token
  }

  async function request(method, path, body) {
    let res
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' })
    } catch (err) {
      throw Object.assign(new Error('server neodpovedá'), { status: 0, cause: err })
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data?.ok === false) throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), { status: res.status, data })
    return data
  }

  const get = (path) => request('GET', path)
  const post = (path, body = {}) => request('POST', path, body)

  return {
    chat: (text, via = 'text', extra = {}) => post('/api/chat', { text, via, ...extra }),
    stop: () => post('/api/chat/stop'),
    history: () => get('/api/chat/history'),
    listen: (mode = 'once', extra = {}) => post('/api/listen', { mode, ...extra }),
    /** Push-to-talk: nahrávka z MediaRecorder, server ju prepíše a pošle do chatu. */
    async stt(blob) {
      let res
      try {
        res = await fetch('/api/stt', { method: 'POST', headers: { ...headers, 'content-type': blob.type || 'audio/webm' }, body: blob, cache: 'no-store' })
      } catch (err) {
        throw Object.assign(new Error('server neodpovedá'), { status: 0, cause: err })
      }
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok === false) throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), { status: res.status, data })
      return data
    },
    wake: (on) => post('/api/listen/wake', { on }),
    mode: (film) => post('/api/mode', { film }),
    status: () => get('/api/status'),
    snapshot: () => get('/api/snapshot'),
    jobs: () => get('/api/jobs'),
    jobStop: (id) => post(`/api/jobs/${encodeURIComponent(id)}/stop`),
    jobReply: (id, text) => post(`/api/jobs/${encodeURIComponent(id)}/reply`, { text }),
    scene: (id) => get(`/api/scene/${encodeURIComponent(id)}`),
  }
}
