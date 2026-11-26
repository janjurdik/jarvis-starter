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
    async stt(blob, attachments = []) {
      let res
      try {
        res = await fetch(`/api/stt${attachments.length ? `?attach=${encodeURIComponent(JSON.stringify(attachments))}` : ''}`, { method: 'POST', headers: { ...headers, 'content-type': blob.type || 'audio/webm' }, body: blob, cache: 'no-store' })
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
    job: (id) => get(`/api/jobs/${encodeURIComponent(id)}`),
    jobStop: (id) => post(`/api/jobs/${encodeURIComponent(id)}/stop`),
    jobReply: (id, text) => post(`/api/jobs/${encodeURIComponent(id)}/reply`, { text }),
    scene: (id) => get(`/api/scene/${encodeURIComponent(id)}`),
    /** The login card (server/login.mjs): only this computer is let in, the values are sent once and not kept. */
    login: (body) => post('/api/login', body),
    /** A button under "not signed in": Jarvis opens the login window himself (server/terminal.mjs). */
    openTerminal: (action) => post('/api/terminal', { action }),
    /** One task of the Úlohy board: { action: 'delete' | 'edit' | 'done' | 'restore', ref, text, due, undo }. */
    todos: (body) => post('/api/todos', body),

    // ── files, imports and the people review (drop.js, people.js) ──
    /** URL of a private file (attachment, photo from an export) usable in <img>: adds the token when there is one. */
    fileUrl: (url) => (token && url && String(url).startsWith('/') && !String(url).startsWith('//') ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url),
    uploadBegin: (name, size, folder = false) => post('/api/upload/begin', { name, size, folder }),
    uploadFinish: (id) => post('/api/upload/finish', { id }),
    uploadCancel: (id) => post('/api/upload/cancel', { id }),
    /** Desktop app only: a file by its path on this computer, nothing is copied over HTTP. */
    uploadLocal: (path) => post('/api/upload/local', { path }),
    /**
     * One file of an upload as a raw streamed body. XMLHttpRequest because fetch cannot report
     * upload progress. Returns { promise, abort }.
     */
    uploadPart(id, path, file, onProgress) {
      const xhr = new XMLHttpRequest()
      const promise = new Promise((done, failed) => {
        xhr.open('POST', `/api/upload?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`)
        if (token) xhr.setRequestHeader('x-hud-token', token)
        xhr.setRequestHeader('content-type', 'application/octet-stream')
        xhr.upload.onprogress = (e) => onProgress?.(e.loaded)
        xhr.onload = () => {
          let data = {}
          try {
            data = JSON.parse(xhr.responseText)
          } catch {
            data = {}
          }
          if (xhr.status >= 200 && xhr.status < 300 && data.ok !== false) done(data)
          else failed(Object.assign(new Error(data.error ?? `HTTP ${xhr.status}`), { status: xhr.status }))
        }
        xhr.onerror = () => failed(Object.assign(new Error('nahrávanie sa prerušilo'), { status: 0 }))
        xhr.onabort = () => failed(Object.assign(new Error('zrušené'), { status: 0, aborted: true }))
        xhr.send(file)
      })
      return { promise, abort: () => xhr.abort() }
    },
    importStatus: () => get('/api/import/status'),
    importPeople: () => get('/api/import/people'),
    importApply: (decisions) => post('/api/import/apply', { decisions }),
    importDismiss: (id) => post('/api/import/dismiss', { id }),
  }
}
