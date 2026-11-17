// Files in the HUD: drag anything into the window, paste it, or pick it with the paperclip.
// An ordinary file (photo, PDF, document) becomes an attachment chip above the command bar and
// goes with the next message. A data export (Instagram, WhatsApp, ChatGPT, …) is handed to the
// importer: its progress shows in the section Importy and ends with the people review.
//
// Uploads go through POST /api/upload/begin → /api/upload?id=… (raw body, XMLHttpRequest for the
// progress) → /api/upload/finish. Dropped folders are walked here and sent file by file.

import { icon } from './icons.js'
import { esc, nf, plural } from './format.js'

/** Videos and voice messages are skipped in dropped folders: the importer does not read them and they are most of the size. */
const SKIP_EXT = new Set(['mp4', 'mov', 'm4a', 'opus', 'aac', 'webm'])
const MAX_ATTACH = 12
/** Desktop app: from this size a dropped file is read by the server where it lies instead of being uploaded. */
const LOCAL_MIN_BYTES = 256 * 1024 * 1024
const PART_POOL = 4
const DONE_WINDOW_MS = 2 * 3600_000
const TYPE_ICON = { image: 'fotky', pdf: 'note', doc: 'note', table: 'chart', audio: 'music', video: 'film', archive: 'archive', file: 'note' }
const PILLS = [
  { icon: 'pamat', text: 'Ulož si to do pamäte' },
  { icon: 'eye', text: 'Povedz mi, čo to je' },
]
const SOURCES_LINE = ['Instagram', 'WhatsApp', 'Messenger', 'Telegram', 'Discord', 'ChatGPT', 'Spotify']

const sizeText = (bytes) => {
  if (!Number.isFinite(bytes)) return ''
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1).replace('.', ',')} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} kB`
}
const yearOf = (v) => /^(\d{4})/.exec(String(v ?? ''))?.[1] ?? null

/** Same spinner as a running job (jobs.js), so imports and jobs read as one family. */
function stateIcon(state) {
  if (state === 'importing' || state === 'applying') {
    return '<svg class="jb-ic jb-run" viewBox="0 0 24 24" aria-hidden="true"><circle class="jb-track" cx="12" cy="12" r="8.6"/><path class="jb-arc" d="M12 3.4a8.6 8.6 0 0 1 8.6 8.6"/><circle class="jb-dot" cx="12" cy="12" r="2.2"/></svg>'
  }
  if (state === 'review') return icon('people', 'jb-ic jb-ok')
  if (state === 'done') return icon('check', 'jb-ic jb-done')
  return icon('alarm', 'jb-ic jb-err')
}

export function createDrop({ api, ui, onSend, onReview, desktop = false }) {
  const $ = (id) => document.getElementById(id)
  const zone = $('dropzone')
  const tray = $('tray')
  const hint = $('cmd-hint')
  const clip = $('cmd-clip')
  const picker = $('file-input')
  const cmd = $('cmd')
  const input = $('cmd-input')
  const section = $('mod-imports')
  const list = $('imports')
  const memEntry = $('mem-import')

  /** uid → { uid, name, size, loaded, state: wait|scan|up|detect|error, parts, folder, id, error } */
  const uploads = new Map()
  /** [{ rel, name, type }] waiting for the next message */
  let attachments = []
  /** id → import entry from the server */
  const imports = new Map()
  let pending = 0
  let uidSeq = 0
  let chain = Promise.resolve()

  // ── drop target ──
  zone.innerHTML =
    '<div class="drop-frame"><i class="drop-c c1"></i><i class="drop-c c2"></i><i class="drop-c c3"></i><i class="drop-c c4"></i><i class="drop-scan"></i></div>' +
    '<div class="drop-core">' +
    `<div class="drop-mark"><svg class="drop-rings" viewBox="0 0 120 120" aria-hidden="true"><circle class="dr-a" cx="60" cy="60" r="56"/><circle class="dr-b" cx="60" cy="60" r="44"/><path class="dr-c" d="M60 4a56 56 0 0 1 48.5 28M116 60a56 56 0 0 1-28 48.5M60 116a56 56 0 0 1-48.5-28M4 60a56 56 0 0 1 28-48.5"/></svg>${icon('upload')}</div>` +
    '<div class="drop-title">Pusti sem.</div>' +
    '<div class="drop-sub">Fotky, dokumenty alebo export tvojich dát.</div>' +
    `<div class="drop-src">${SOURCES_LINE.map((s) => `<span>${s}</span>`).join('')}</div>` +
    '</div>'
  clip.innerHTML = icon('clip')
  hint.textContent = 'Čo s tým mám spraviť?'

  let depth = 0
  let lastOver = 0
  let watchdog = null
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files')
  function show() {
    lastOver = performance.now()
    if (!zone.hidden) return
    zone.hidden = false
    requestAnimationFrame(() => zone.classList.add('is-on'))
    // dragleave is unreliable at the window edge: without a dragover for a while the target goes away.
    watchdog = setInterval(() => performance.now() - lastOver > 900 && hide(), 300)
  }
  function hide() {
    depth = 0
    clearInterval(watchdog)
    if (zone.hidden) return
    zone.classList.remove('is-on')
    zone.hidden = true
  }
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth++
    show()
  })
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    show()
  })
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return
    depth = Math.max(0, depth - 1)
    if (!depth || e.relatedTarget === null) hide()
  })
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    hide()
    takeTransfer(e.dataTransfer)
  })
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])]
    if (!files.length) return
    e.preventDefault()
    addFiles(files.map(namePasted))
  })
  clip.addEventListener('click', () => picker.click())
  picker.addEventListener('change', () => {
    addFiles([...picker.files])
    picker.value = ''
  })
  input.addEventListener('input', renderTray)

  /** A screenshot pasted from the clipboard is always called image.png: give it a name that says when it was taken. */
  function namePasted(file) {
    if (!/^image\.\w+$/i.test(file.name)) return file
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const ext = file.name.split('.').pop().toLowerCase()
    return new File([file], `obrazok ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.${ext}`, { type: file.type })
  }

  /**
   * Desktop app (hud/desktop/main.swift): when a drag from Finder enters the window the app tells
   * the page where those files are. A folder or a very big file is then read by the server in
   * place (POST /api/upload/local) and nothing is copied through the page. When the server cannot
   * reach the path (macOS guards Downloads and Desktop), the ordinary upload takes over.
   */
  let dragPaths = []
  if (desktop) {
    window.__jarvisDrag = (items) => {
      dragPaths = Array.isArray(items) ? items.filter((it) => it && typeof it.path === 'string') : []
    }
  }
  const nfc = (v) => String(v ?? '').normalize('NFC')
  function localOf(paths, name, dir) {
    const i = paths.findIndex((p) => nfc(p.name) === nfc(name) && Boolean(p.dir) === dir)
    return i >= 0 ? paths.splice(i, 1)[0] : null
  }

  /** Entries have to be read during the drop event itself, the transfer is empty afterwards. */
  function takeTransfer(dt) {
    const files = []
    const dirs = []
    const items = [...(dt.items ?? [])].filter((it) => it.kind === 'file')
    if (items.length && typeof items[0].webkitGetAsEntry === 'function') {
      for (const it of items) {
        const entry = it.webkitGetAsEntry()
        if (entry?.isDirectory) dirs.push(entry)
        else {
          const f = it.getAsFile()
          if (f) files.push(f)
        }
      }
    } else files.push(...dt.files)
    const paths = dragPaths
    dragPaths = []
    for (const f of files) {
      const local = f.size >= LOCAL_MIN_BYTES ? localOf(paths, f.name, false) : null
      if (local) addLocal(local, () => addFiles([f]))
      else addFiles([f])
    }
    for (const d of dirs) {
      const local = localOf(paths, d.name, true)
      if (local) addLocal(local, () => addFolder(d))
      else addFolder(d)
    }
  }

  // ── uploads ──
  function enqueue(u) {
    uploads.set(u.uid, u)
    renderTray()
    chain = chain.then(() => run(u)).catch(() => undefined)
  }

  function addFiles(files) {
    for (const file of files) {
      if (!file) continue
      enqueue({ uid: `u${++uidSeq}`, name: file.name || 'súbor', size: file.size, loaded: 0, state: 'wait', folder: false, parts: [{ path: file.name || 'subor', file }] })
    }
  }

  async function walk(dir, prefix, out, stats) {
    const reader = dir.createReader()
    for (;;) {
      const batch = await new Promise((done, failed) => reader.readEntries(done, failed))
      if (!batch.length) return
      for (const e of batch) {
        if (e.name.startsWith('.') || e.name === '__MACOSX') continue
        if (e.isDirectory) {
          await walk(e, `${prefix}${e.name}/`, out, stats)
          continue
        }
        if (SKIP_EXT.has(e.name.split('.').pop().toLowerCase())) {
          stats.skipped++
          continue
        }
        const file = await new Promise((done, failed) => e.file(done, failed))
        out.push({ path: `${prefix}${e.name}`, file })
        stats.bytes += file.size
        if (out.length > 200_000) throw new Error('Priečinok má priveľa súborov.')
      }
    }
  }

  async function addFolder(entry) {
    const u = { uid: `u${++uidSeq}`, name: entry.name, size: 0, loaded: 0, state: 'scan', folder: true, parts: [] }
    uploads.set(u.uid, u)
    renderTray()
    const stats = { bytes: 0, skipped: 0 }
    try {
      await walk(entry, '', u.parts, stats)
      if (!u.parts.length) throw new Error('Priečinok je prázdny.')
    } catch (err) {
      return fail(u, err)
    }
    if (u.cancelled) return
    u.size = stats.bytes
    u.state = 'wait'
    renderTray()
    chain = chain.then(() => run(u)).catch(() => undefined)
  }

  /** A file or folder by its path on this computer. `fallback` runs when the server could not read it there. */
  function addLocal(it, fallback = null) {
    if (!it?.path) return fallback?.()
    const u = { uid: `u${++uidSeq}`, name: it.name || it.path.split('/').pop(), size: NaN, loaded: 0, state: 'detect', folder: Boolean(it.dir), parts: [], local: it.path }
    uploads.set(u.uid, u)
    renderTray()
    api.uploadLocal(it.path).then(
      (res) => {
        uploads.delete(u.uid)
        handleResult(res)
      },
      (err) => {
        if (!fallback) return fail(u, err)
        uploads.delete(u.uid)
        renderTray()
        fallback()
      },
    )
  }

  function fail(u, err) {
    if (u.cancelled || err?.aborted) {
      uploads.delete(u.uid)
      return renderTray()
    }
    u.state = 'error'
    u.error = err?.message || 'Nepodarilo sa'
    renderTray()
    ui.toast(`${esc(u.name)}: ${esc(u.error)}`, { kind: 'warn', iconName: 'upload', ms: 7000 })
    setTimeout(() => {
      uploads.delete(u.uid)
      renderTray()
    }, 7000)
  }

  async function run(u) {
    if (u.cancelled) return
    u.state = 'up'
    renderTray()
    try {
      const begun = await api.uploadBegin(u.name, u.size, u.folder)
      u.id = begun.id
      if (u.cancelled) throw Object.assign(new Error('zrušené'), { aborted: true })
      // A folder is thousands of small files: a few at a time. Progress is the sum of what left the browser.
      const sent = new Array(u.parts.length).fill(0)
      const aborts = new Set()
      u.abort = () => aborts.forEach((fn) => fn())
      let next = 0
      const worker = async () => {
        while (next < u.parts.length) {
          const i = next++
          const part = u.parts[i]
          const req = api.uploadPart(u.id, part.path, part.file, (loaded) => {
            sent[i] = loaded
            u.loaded = sent.reduce((a, b) => a + b, 0)
            paintProgress(u)
          })
          aborts.add(req.abort)
          try {
            await req.promise
          } finally {
            aborts.delete(req.abort)
          }
          sent[i] = part.file.size
        }
      }
      await Promise.all(Array.from({ length: Math.min(u.folder ? PART_POOL : 1, u.parts.length) }, worker))
      u.loaded = u.size
      u.state = 'detect'
      renderTray()
      const res = await api.uploadFinish(u.id)
      uploads.delete(u.uid)
      handleResult(res)
    } catch (err) {
      u.abort?.()
      if (u.id) api.uploadCancel(u.id).catch(() => undefined)
      fail(u, err)
    }
  }

  function cancel(uid) {
    const u = uploads.get(uid)
    if (!u) return
    u.cancelled = true
    u.abort?.()
    if (u.state !== 'up') uploads.delete(uid)
    renderTray()
  }

  function handleResult(res) {
    if (res?.kind === 'export' && res.import) {
      applyImport(res.import)
      ui.toast(`${esc(res.import.label)} · pozerám sa na to`, { iconName: 'archive', ms: 3200 })
    } else if (res?.kind === 'job') {
      // An export in a format nobody prepared for: Jarvis reads it himself in the background.
      ui.toast('Tento formát vidím prvýkrát. Čítam si ho a čo je dôležité, uložím do pamäte.', { iconName: 'memory', ms: 7000 })
    } else if (res?.kind === 'file' && res.attachment) {
      if (attachments.length >= MAX_ATTACH) ui.toast(`Naraz najviac ${MAX_ATTACH} príloh.`, { kind: 'warn', iconName: 'clip' })
      else if (!attachments.some((a) => a.rel === res.attachment.rel)) attachments.push({ rel: res.attachment.rel, name: res.attachment.name, type: res.attachment.type })
      input.focus()
    }
    renderTray()
  }

  // ── tray above the command bar ──
  const thumbUrl = (a) => api.fileUrl(`/api/attachment?path=${encodeURIComponent(a.rel)}`)
  const pct = (u) => (u.size > 0 ? Math.min(100, Math.round((u.loaded / u.size) * 100)) : 0)
  const stateText = (u) => (u.state === 'scan' ? 'prechádzam priečinok' : u.state === 'wait' ? 'čaká' : u.state === 'detect' ? 'pozerám, čo to je' : u.state === 'error' ? u.error : `${pct(u)} %`)

  function uploadChip(u) {
    return (
      `<span class="upl st-${u.state}" data-uid="${u.uid}" style="--p:${u.state === 'up' ? pct(u) : u.state === 'detect' ? 100 : 0}%" title="${esc(u.name)}${Number.isFinite(u.size) && u.size ? ` · ${sizeText(u.size)}` : ''}">` +
      `${icon(u.state === 'error' ? 'alarm' : u.folder ? 'folder' : 'upload')}<span class="upl-n">${esc(u.name)}</span><span class="upl-p">${esc(stateText(u))}</span>` +
      (u.state === 'wait' || u.state === 'scan' || u.state === 'up' ? `<button type="button" class="chip-x" data-cancel="${u.uid}" aria-label="Zrušiť nahrávanie">${icon('close')}</button>` : '') +
      '</span>'
    )
  }
  function attachChip(a, i) {
    const thumb = a.type === 'image' && !a.noThumb
    const visual = thumb ? `<img class="att-img" src="${esc(thumbUrl(a))}" data-i="${i}" alt="" decoding="async">` : icon(TYPE_ICON[a.type] ?? 'note')
    return `<span class="att${thumb ? ' has-img' : ''}" title="${esc(a.name)}">${visual}<span class="att-n">${esc(a.name)}</span><button type="button" class="chip-x" data-remove="${i}" aria-label="Odobrať prílohu">${icon('close')}</button></span>`
  }

  let traySig = ''
  function renderTray() {
    const ups = [...uploads.values()]
    const pills = attachments.length && !input.value.trim() ? PILLS : []
    const sig = JSON.stringify([ups.map((u) => [u.uid, u.state, u.name, u.error]), attachments.map((a) => [a.rel, a.noThumb]), pills.length])
    cmd.classList.toggle('has-attach', attachments.length > 0)
    if (sig === traySig) return
    traySig = sig
    tray.hidden = !ups.length && !attachments.length
    tray.innerHTML =
      (ups.length || attachments.length ? `<div class="tray-row">${ups.map(uploadChip).join('')}${attachments.map(attachChip).join('')}</div>` : '') +
      (pills.length ? `<div class="tray-row tray-pills">${pills.map((p) => `<button type="button" class="sugg" data-say="${esc(p.text)}">${icon(p.icon)}<span>${esc(p.text)}</span></button>`).join('')}</div>` : '')
  }
  /** Progress touches only the chip's own bar and number, the tray is not rebuilt 60 times a second. */
  function paintProgress(u) {
    const el = tray.querySelector(`[data-uid="${u.uid}"]`)
    if (!el) return
    el.style.setProperty('--p', `${pct(u)}%`)
    const p = el.querySelector('.upl-p')
    const text = stateText(u)
    if (p && p.textContent !== text) p.textContent = text
  }
  tray.addEventListener('click', (e) => {
    const x = e.target.closest('[data-cancel]')
    if (x) return cancel(x.dataset.cancel)
    const r = e.target.closest('[data-remove]')
    if (r) {
      attachments.splice(Number(r.dataset.remove), 1)
      return renderTray()
    }
    const say = e.target.closest('[data-say]')
    if (say) onSend?.(`${say.dataset.say}.`, 'text')
  })
  // A button keeps the keyboard focus after a click, then the spacebar would press it instead of talking.
  tray.addEventListener('mouseup', (e) => e.target.closest('button')?.blur())
  // An image the browser cannot draw (HEIC outside Safari) keeps its chip, with an icon instead of a thumbnail.
  tray.addEventListener(
    'error',
    (e) => {
      const a = e.target?.tagName === 'IMG' ? attachments[Number(e.target.dataset.i)] : null
      if (!a) return
      a.noThumb = true
      renderTray()
    },
    true,
  )

  // ── section Importy ──
  const ACTIVE = new Set(['importing', 'review', 'applying'])
  const ST_CLASS = { importing: 'st-running', applying: 'st-running', review: 'st-needs_ok', done: 'st-done', error: 'st-error' }

  function facts(r) {
    if (!r) return ''
    const out = []
    if (r.messages) out.push(`${nf(r.messages)} ${plural(r.messages, 'správa', 'správy', 'správ')}`)
    if (r.threads) out.push(`${nf(r.threads)} ${plural(r.threads, 'konverzácia', 'konverzácie', 'konverzácií')}`)
    const a = yearOf(r.from)
    const b = yearOf(r.to)
    if (a && b) out.push(a === b ? a : `${a} až ${b}`)
    return out.join(' · ')
  }

  /** The call to review people belongs to one row only, however many imports wait. */
  let reviewLead = null

  function importRow(e) {
    const running = e.state === 'importing' || e.state === 'applying'
    const p = Math.round((Number(e.progress) || 0) * 100)
    const lead = e.state === 'review' && e.id === reviewLead
    const step = e.state === 'error' ? e.error || 'Import zlyhal' : lead ? `${nf(pending)} ${plural(pending, 'človek čaká', 'ľudia čakajú', 'ľudí čaká')} na potvrdenie` : running ? e.stage || '' : facts(e.result) || (e.state === 'review' ? 'Čaká na potvrdenie ľudí' : 'Hotovo')
    const warn = !running && e.state !== 'error' && e.result?.warnings?.length ? `<p class="imp-warn" title="${esc(e.result.warnings.join(' '))}">${esc(e.result.warnings[0])}</p>` : ''
    let detail = ''
    if (running) detail = `<div class="imp-bar"><i style="width:${e.state === 'applying' ? 100 : p}%"></i></div>`
    else if (lead) {
      const sum = facts(e.result)
      detail = `<div class="jb-detail imp-detail">${sum ? `<p class="jb-sum">${esc(sum)}</p>` : ''}${warn}<div class="jb-acts"><button type="button" class="jb-btn imp-go" data-act="review">${icon('people')}<span>Potvrdiť ľudí (${nf(pending)})</span></button></div></div>`
    } else if (warn) detail = `<div class="jb-detail imp-detail">${warn}</div>`
    return (
      `<div class="jb-head imp-head${lead ? ' is-lead' : ''}">${stateIcon(e.state)}` +
      `<span class="jb-main"><span class="jb-title" title="${esc(e.detail || e.name || '')}">${esc(e.label || 'Export')}</span><span class="jb-step" title="${esc(e.state === 'error' ? e.error ?? '' : e.name ?? '')}">${esc(step)}</span></span>` +
      `<span class="jb-time">${e.state === 'importing' && e.progress > 0 ? `${p} %` : ''}</span>` +
      (running
        ? `<button type="button" class="imp-x" data-act="dismiss" aria-label="Zastaviť import" title="Zastaviť">${icon('stop')}</button>`
        : `<button type="button" class="imp-x" data-act="dismiss" aria-label="Skryť" title="Skryť">${icon('close')}</button>`) +
      `</div>${detail}`
    )
  }

  const rows = new Map()
  function renderImports() {
    const nowMs = Date.now()
    const shown = [...imports.values()]
      .filter((e) => ACTIVE.has(e.state) || nowMs - (Date.parse(e.endedAt ?? e.createdAt) || nowMs) < DONE_WINDOW_MS)
      .sort((a, b) => ACTIVE.has(b.state) - ACTIVE.has(a.state) || String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 4)
    if (section.hidden !== !shown.length) section.hidden = !shown.length
    reviewLead = pending > 0 ? shown.find((e) => e.state === 'review')?.id ?? null : null
    const keep = new Set(shown.map((e) => e.id))
    for (const [id, row] of rows) {
      if (!keep.has(id)) {
        row.remove()
        rows.delete(id)
      }
    }
    shown.forEach((e, i) => {
      let row = rows.get(e.id)
      if (!row) {
        row = document.createElement('li')
        row.dataset.id = e.id
        rows.set(e.id, row)
      }
      if (list.children[i] !== row) list.insertBefore(row, list.children[i] ?? null)
      const cls = `jb imp ${ST_CLASS[e.state] ?? ''}`
      if (row._cls !== cls) row.className = row._cls = cls
      // While it runs only the bar, the percent and the step change: no rebuild, the bar animates.
      if (row._state === e.state && (e.state === 'importing' || e.state === 'applying')) {
        const p = Math.round((Number(e.progress) || 0) * 100)
        const bar = row.querySelector('.imp-bar i')
        if (bar) bar.style.width = `${e.state === 'applying' ? 100 : p}%`
        const time = row.querySelector('.jb-time')
        if (time) time.textContent = e.state === 'importing' && e.progress > 0 ? `${p} %` : ''
        const step = row.querySelector('.jb-step')
        if (step && step.textContent !== (e.stage || '')) {
          step.textContent = e.stage || ''
          step.classList.remove('step-in')
          void step.offsetWidth
          step.classList.add('step-in')
        }
        return
      }
      const html = importRow(e)
      if (row._html === html) return
      row.innerHTML = row._html = html
      row._state = e.state
    })
    const text = pending > 0 ? `${icon('people')}<span>Importy · <b>${nf(pending)}</b> ${plural(pending, 'človek čaká', 'ľudia čakajú', 'ľudí čaká')} na potvrdenie</span>` : ''
    if (memEntry._html !== text) {
      memEntry.innerHTML = memEntry._html = text
      memEntry.hidden = !text
    }
  }

  /** SSE `import`: one entry changed, an entry went away, or only the number of waiting people. */
  function applyImport(ev) {
    if (!ev) return
    if (Number.isFinite(ev.pending)) pending = ev.pending
    if (ev.removed) imports.delete(ev.id)
    else if (ev.id) imports.set(ev.id, { ...imports.get(ev.id), ...ev })
    renderImports()
  }

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]')
    const row = e.target.closest('.imp')
    if (!btn || !row) return
    if (btn.dataset.act === 'review') return onReview?.()
    btn.disabled = true
    try {
      const res = await api.importDismiss(row.dataset.id)
      if (res?.import?.removed) applyImport({ id: row.dataset.id, removed: true })
    } catch (err) {
      btn.disabled = false
      ui.toast(esc(err.message), { kind: 'warn', iconName: 'archive' })
    }
  })
  list.addEventListener('mouseup', (e) => e.target.closest('button')?.blur())
  memEntry.addEventListener('click', () => onReview?.())

  async function load() {
    try {
      const st = await api.importStatus()
      pending = Number(st.pending) || 0
      for (const e of st.imports ?? []) imports.set(e.id, e)
      renderImports()
    } catch {
      // older server without imports: the section stays hidden
    }
  }

  renderTray()
  renderImports()

  return {
    load,
    applyImport,
    addFiles,
    addFolder,
    addLocal,
    /** Attachments for the message being sent. They leave the tray, restore() puts them back when sending failed. */
    take() {
      const out = attachments
      attachments = []
      renderTray()
      return out
    },
    restore(items = []) {
      attachments = [...items, ...attachments].slice(0, MAX_ATTACH)
      renderTray()
    },
    get attachments() {
      return attachments
    },
    get pending() {
      return pending
    },
  }
}
