// Sekcia Úlohy: agentické úlohy Jarvisa na pozadí (plný Claude Code). Stav ide zo SSE `job`
// a GET /api/jobs. Prekresľuje sa len pri udalosti a raz za sekundu čas behu (pokoj plochy nebrzdí).
//
// job: {id, title, status: queued|running|needs_ok|done|error|stopped, step, steps[], startedAt, endedAt,
//       summary, needsOk, cost: {turns, ms}}
//
// A row shows the current step and has its own stop button. A click on the row opens the job:
// the assignment, the whole feed with times (SSE `job-feed` adds lines while it runs), the result
// and a field to continue in a job that has ended (GET /api/jobs/<id>, POST …/stop, …/reply).

import { icon } from './icons.js'
import { esc, plural } from './format.js'

const WINDOW_MS = 2 * 3600_000
const MAX_ROWS = 4
const ACTIVE = new Set(['queued', 'running', 'needs_ok'])
const APPROVE = 'Schvaľujem, pokračuj presne podľa návrhu.'
const STATUS_TEXT = { queued: 'v poradí', running: 'beží', needs_ok: 'čaká na súhlas', done: 'hotovo', error: 'chyba', stopped: 'zastavená' }

/** Ikona stavu: kruh, ktorý sa točí (beží), jantárový (súhlas), fajka, chyba, stop. */
function statusIcon(status) {
  if (status === 'running' || status === 'queued') {
    return `<svg class="jb-ic jb-run" viewBox="0 0 24 24" aria-hidden="true"><circle class="jb-track" cx="12" cy="12" r="8.6"/><path class="jb-arc" d="M12 3.4a8.6 8.6 0 0 1 8.6 8.6"/><circle class="jb-dot" cx="12" cy="12" r="2.2"/></svg>`
  }
  if (status === 'needs_ok') return icon('hourglass', 'jb-ic jb-ok')
  if (status === 'done') return icon('check', 'jb-ic jb-done')
  if (status === 'error') return icon('alarm', 'jb-ic jb-err')
  return icon('stop', 'jb-ic jb-stop')
}

/** 75 s → „1:15", 3725 s → „1:02:05". */
function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** 14:05:09 in local time, for a line of the feed. */
function clockTime(ms) {
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function createJobs({ api, ui = null, onChange, capture = false, clock = () => Date.now() }) {
  const section = document.getElementById('mod-jobs')
  const list = document.getElementById('jobs')
  const more = document.getElementById('jobs-more')
  const jobs = new Map()
  const rows = new Map()
  const view = capture ? null : createView()

  const ts = (v) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : v ? Date.parse(v) : NaN)

  function apply(job) {
    if (!job?.id) return
    const prev = jobs.get(job.id) ?? {}
    jobs.set(job.id, { ...prev, ...job })
    render()
    view?.jobChanged(job.id)
    onChange?.()
  }

  function load(items = []) {
    for (const j of items) if (j?.id) jobs.set(j.id, { ...jobs.get(j.id), ...j })
    render()
    onChange?.()
  }

  /** Úlohy na zobrazenie: aktívne vždy, ostatné z posledných 2 h. Aktívne hore, potom najnovšie. */
  function visible(nowMs) {
    return [...jobs.values()]
      .filter((j) => ACTIVE.has(j.status) || nowMs - (ts(j.endedAt) || ts(j.startedAt) || 0) < WINDOW_MS)
      .sort((a, b) => (ACTIVE.has(b.status) - ACTIVE.has(a.status)) || (ts(b.startedAt) || 0) - (ts(a.startedAt) || 0))
  }

  function rowHtml(j, nowMs) {
    const start = ts(j.startedAt)
    const end = ts(j.endedAt)
    const run = Number.isFinite(start) ? elapsed((Number.isFinite(end) ? end : nowMs) - start) : ''
    const step = j.status === 'needs_ok' ? j.needsOk || j.step || 'Čaká na váš súhlas' : j.step || STATUS_TEXT[j.status] || ''
    const quick = ACTIVE.has(j.status)
      ? '<span class="jb-quick">' +
        (j.status === 'needs_ok' ? `<button type="button" class="jb-q jb-q-ok" data-act="ok" title="Schváliť" aria-label="Schváliť">${icon('check')}</button>` : '') +
        `<button type="button" class="jb-q" data-act="stop" title="Zastaviť úlohu" aria-label="Zastaviť úlohu">${icon('stop')}</button></span>`
      : ''
    return (
      `<button type="button" class="jb-head" data-act="open" title="Otvoriť priebeh úlohy">${statusIcon(j.status)}` +
      `<span class="jb-main"><span class="jb-title">${esc(j.title || 'Úloha')}</span><span class="jb-step" data-step="${esc(step)}">${esc(step)}</span></span>` +
      `<span class="jb-time">${esc(run)}</span></button>${quick}`
    )
  }

  /** Prekreslí sekciu. Pri tikaní času sa mení len text času (žiadny layout okrem neho). */
  function render() {
    const nowMs = clock()
    const all = visible(nowMs)
    if (section.hidden !== !all.length) section.hidden = !all.length
    const shown = all.slice(0, MAX_ROWS)
    const keep = new Set(shown.map((j) => j.id))
    for (const [id, row] of rows) {
      if (!keep.has(id)) {
        row.remove()
        rows.delete(id)
      }
    }
    shown.forEach((j, i) => {
      let row = rows.get(j.id)
      if (!row) {
        row = document.createElement('li')
        row.dataset.id = j.id
        rows.set(j.id, row)
      }
      if (list.children[i] !== row) list.insertBefore(row, list.children[i] ?? null)
      const cls = `jb st-${j.status}${j.status === 'needs_ok' ? ' q2' : ACTIVE.has(j.status) ? ' q1' : ''}`
      if (row._cls !== cls) row.className = row._cls = cls
      const html = rowHtml(j, nowMs)
      if (row._html === html) return
      // Nový krok vpláva (plynulý prechod), ostatné zmeny sa len prepíšu.
      const prevStep = row._step
      row.innerHTML = row._html = html
      const stepEl = row.querySelector('.jb-step')
      row._step = stepEl?.dataset.step
      if (prevStep !== undefined && prevStep !== row._step && !capture) stepEl?.classList.add('step-in')
    })
    const rest = all.length - shown.length
    const text = rest > 0 ? `+ ${rest} ${plural(rest, 'staršia úloha', 'staršie úlohy', 'starších úloh')}` : ''
    if (more.textContent !== text) more.textContent = text
  }

  /** Stop and approve, shared by the row and the open job. */
  async function act(id, what, btn = null) {
    if (btn) btn.disabled = true
    try {
      if (what === 'stop') await api.jobStop(id)
      if (what === 'ok') await api.jobReply(id, APPROVE)
      return true
    } catch (err) {
      ui?.toast(esc(`Nepodarilo sa: ${err?.message ?? err}`), { kind: 'warn', iconName: 'alarm' })
      if (btn) btn.disabled = false
      return false
    }
  }

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]')
    const row = e.target.closest('.jb')
    if (!btn || !row) return
    if (btn.dataset.act === 'open') return view?.open(row.dataset.id)
    act(row.dataset.id, btn.dataset.act, btn)
  })

  // ── an open job ──
  function createView() {
    const root = document.getElementById('job-view')
    if (!root) return null
    let id = null
    /** { task, feed, canReply, film } from the server, null while loading */
    let detail = null
    let error = null
    let pending = []
    let sending = false
    let stick = true

    const job = () => (id ? jobs.get(id) : null)
    const feedKey = (e) => `${e.t}|${e.kind}|${e.text}`

    async function load() {
      const want = id
      try {
        const res = await api.job(want)
        if (id !== want) return
        const feed = res.job?.feed ?? []
        const known = new Set(feed.map(feedKey))
        detail = { ...res.job, feed: [...feed, ...pending.filter((e) => !known.has(feedKey(e)))] }
        error = null
      } catch (err) {
        if (id !== want) return
        // A sample job (?demo=1) lives only in the page: its steps are all there is to show.
        const j = jobs.get(want)
        if (err?.status === 404 && j) detail = { task: null, canReply: false, film: false, feed: (j.steps ?? []).map((text) => ({ t: null, kind: 'step', text })) }
        else error = err?.message ?? String(err)
      }
      pending = []
      render()
    }

    function feedHtml(all) {
      // The assignment has its own place above the feed.
      const feed = all.filter((e) => e.kind !== 'task')
      if (!feed.length) return '<p class="jv-empty">Zatiaľ nič. Úloha čaká, kým na ňu príde rad.</p>'
      return `<ol class="jv-lines">${feed
        .map((e) => `<li class="jv-l k-${esc(e.kind)}"><time>${esc(clockTime(e.t))}</time><span>${esc(e.text)}</span></li>`)
        .join('')}</ol>`
    }

    function headSub(j) {
      const start = ts(j.startedAt)
      const end = ts(j.endedAt)
      const run = Number.isFinite(start) ? elapsed((Number.isFinite(end) ? end : clock()) - start) : ''
      const steps = (detail?.feed ?? []).filter((e) => e.kind === 'step').length
      return [STATUS_TEXT[j.status] ?? j.status, run, steps ? `${steps} ${plural(steps, 'krok', 'kroky', 'krokov')}` : ''].filter(Boolean).join(' · ')
    }

    function render() {
      const j = job()
      if (!j) return
      const active = ACTIVE.has(j.status)
      const typed = root.querySelector('.jv-input')?.value ?? ''
      const hadFocus = document.activeElement?.classList?.contains('jv-input')
      const box = root.querySelector('.jv-feed')
      if (box) stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40
      const task = detail?.film ? '<p class="jv-muted">V režime natáčania je zadanie skryté.</p>' : detail?.task ? `<p>${esc(detail.task)}</p>` : ''
      const canReply = Boolean(detail?.canReply) && !active
      root.innerHTML =
        `<div class="jv-in st-${esc(j.status)}">` +
        `<header class="jv-top">${statusIcon(j.status)}<div class="jv-h"><h2>${esc(j.title || 'Úloha')}</h2><p class="jv-sub">${esc(headSub(j))}</p></div>` +
        '<div class="jv-tools">' +
        (j.status === 'needs_ok' ? `<button type="button" class="pv-btn is-main" data-act="ok">${icon('check')}<span>Schváliť</span></button>` : '') +
        (active ? `<button type="button" class="pv-btn" data-act="stop">${icon('stop')}<span>Zastaviť</span></button>` : '') +
        `<button type="button" class="pv-x" data-act="close" title="Zavrieť (Esc)" aria-label="Zavrieť">${icon('close')}</button></div></header>` +
        (j.status === 'needs_ok' && j.needsOk ? `<p class="jv-ask">${icon('hourglass')}<span>${esc(j.needsOk)}</span></p>` : '') +
        '<div class="jv-body">' +
        (task ? `<section class="jv-task"><h3>Zadanie</h3>${task}</section>` : '') +
        `<section class="jv-feed"><h3>Priebeh</h3>${error ? `<p class="jv-empty">${esc(`Priebeh sa nepodarilo načítať: ${error}`)}</p>` : detail ? feedHtml(detail.feed) : '<p class="jv-empty">Načítavam…</p>'}</section>` +
        '</div>' +
        (canReply
          ? `<form class="jv-reply"><input class="jv-input" type="text" autocomplete="off" maxlength="4000" placeholder="${j.status === 'stopped' ? 'Pokračuj v úlohe: napíš, čo má dorobiť alebo zmeniť' : 'Doplň alebo oprav túto úlohu'}"><button type="submit" class="pv-btn is-main"${sending ? ' disabled' : ''}>${icon('send')}<span>Poslať</span></button></form>`
          : active && j.status !== 'needs_ok'
            ? '<p class="jv-foot">Kým úloha beží, dá sa zastaviť. Zastavenú alebo hotovú vieš odtiaľto doplniť a pustiť ďalej.</p>'
            : '') +
        '</div>'
      const input = root.querySelector('.jv-input')
      if (input) {
        input.value = typed
        if (hadFocus) input.focus()
      }
      const next = root.querySelector('.jv-feed')
      if (next && stick) next.scrollTop = next.scrollHeight
    }

    async function reply() {
      const input = root.querySelector('.jv-input')
      const text = input?.value.trim()
      if (!text || sending || !id) return
      sending = true
      try {
        await api.jobReply(id, text)
        input.value = ''
        if (detail) detail.canReply = false
      } catch (err) {
        ui?.toast(esc(`Nepodarilo sa: ${err?.message ?? err}`), { kind: 'warn', iconName: 'alarm' })
      }
      sending = false
      render()
    }

    root.addEventListener('click', (e) => {
      if (e.target === root) return close()
      const btn = e.target.closest('[data-act]')
      if (!btn || !id) return
      if (btn.dataset.act === 'close') return close()
      act(id, btn.dataset.act, btn)
    })
    root.addEventListener('submit', (e) => {
      e.preventDefault()
      reply()
    })

    /** Capture phase: while a job is open no key reaches the HUD under it (push-to-talk, the command bar). */
    window.addEventListener(
      'keydown',
      (e) => {
        if (!id) return
        e.stopPropagation()
        if (e.key !== 'Escape') return
        e.preventDefault()
        const el = document.activeElement
        if (el?.classList?.contains('jv-input') && el.value) el.value = ''
        else close()
      },
      true,
    )
    window.addEventListener('keyup', (e) => id && e.stopPropagation(), true)

    function open(jobId) {
      if (!jobs.has(jobId)) return
      id = jobId
      detail = null
      error = null
      pending = []
      stick = true
      root.hidden = false
      document.body.classList.add('job-open')
      requestAnimationFrame(() => root.classList.add('is-on'))
      document.activeElement?.blur?.()
      render()
      load()
    }

    function close() {
      if (!id) return
      id = null
      detail = null
      root.classList.remove('is-on')
      root.hidden = true
      root.innerHTML = ''
      document.body.classList.remove('job-open')
    }

    return {
      open,
      close,
      isOpen: () => Boolean(id),
      /** A new line of the feed from the server (SSE `job-feed`). */
      feed(jobId, entry) {
        if (jobId !== id || !entry) return
        if (!detail) return void pending.push(entry)
        if (detail.feed.some((e) => feedKey(e) === feedKey(entry))) return
        detail.feed.push(entry)
        render()
      },
      /** The job changed state: a job that has just ended can be continued, which only the server knows for sure. */
      jobChanged(jobId) {
        if (jobId !== id) return
        const j = job()
        if (detail && j && !ACTIVE.has(j.status) && !detail.canReply) load()
        else render()
      },
      tick() {
        const j = job()
        const sub = root.querySelector('.jv-sub')
        if (j && sub && ACTIVE.has(j.status)) sub.textContent = headSub(j)
      },
    }
  }

  // Čas behu raz za sekundu, len keď niečo beží a stránka je viditeľná.
  if (!capture) {
    setInterval(() => {
      if (document.hidden || !running()) return
      render()
      view?.tick()
    }, 1000)
  }

  const running = () => [...jobs.values()].filter((j) => ACTIVE.has(j.status)).length

  return {
    apply,
    load,
    render,
    /** A line of a job's feed from the server. */
    feed: (id, entry) => view?.feed(id, entry),
    /** Opens a job's detail. Without an id the one that most needs attention: waiting for approval, then running, then the latest. */
    open(id = null) {
      const pick = id ?? visible(clock()).sort((a, b) => (b.status === 'needs_ok') - (a.status === 'needs_ok'))[0]?.id
      if (pick) view?.open(pick)
    },
    isOpen: () => Boolean(view?.isOpen()),
    /** Počet aktívnych úloh (čip v lište, prúd do uzla projekty). */
    get active() {
      return running()
    },
    get waiting() {
      return [...jobs.values()].filter((j) => j.status === 'needs_ok').length
    },
  }
}

/** Sample jobs for ?demo=1: one runs and moves on, one waits for approval, one is done. */
export function demoJobs(apply, { capture = false } = {}) {
  const t0 = Date.now()
  const steps = ['Čítam zadanie', 'Hľadám: ceny leteniek', 'Čítam web', 'Porovnávam možnosti', 'Píšem zhrnutie.md']
  apply({ id: 'demo-done', title: 'Rešerš: darčeky na Vianoce', status: 'done', step: 'Hotovo', steps: ['Hľadám zdroje', 'Čítam 12 článkov', 'Píšem zhrnutie do pamäte'], startedAt: t0 - 46 * 60_000, endedAt: t0 - 31 * 60_000, summary: 'Zhrnutie je v pamäti, 5 tipov a 3 odporúčania.', cost: { turns: 18, ms: 900_000 } })
  apply({ id: 'demo-ok', title: 'Mail prenajímateľovi', status: 'needs_ok', step: 'Návrh je pripravený', needsOk: 'Poslať pripravený mail?', steps: ['Čítam poznámky', 'Píšem návrh mailu'], startedAt: t0 - 7 * 60_000, summary: 'Návrh mailu je pripravený, čaká na schválenie.', cost: { turns: 9, ms: 420_000 } })
  let i = 2
  const run = { id: 'demo-run', title: 'Plán výletu na víkend', status: 'running', step: steps[i], steps: steps.slice(0, i + 1), startedAt: t0 - 3 * 60_000 - 12_000, cost: { turns: 6, ms: 192_000 } }
  apply(run)
  if (capture) return
  setInterval(() => {
    i = (i + 1) % steps.length
    apply({ ...run, step: steps[i], steps: steps.slice(0, i + 1) })
  }, 3200)
}
