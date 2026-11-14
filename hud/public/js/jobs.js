// Sekcia Úlohy: agentické úlohy Jarvisa na pozadí (plný Claude Code). Stav ide zo SSE `job`
// a GET /api/jobs. Prekresľuje sa len pri udalosti a raz za sekundu čas behu (pokoj plochy nebrzdí).
//
// job: {id, title, status: queued|running|needs_ok|done|error|stopped, step, steps[], startedAt, endedAt,
//       summary, needsOk, cost: {turns, ms}}

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

export function createJobs({ api, onChange, capture = false, clock = () => Date.now() }) {
  const section = document.getElementById('mod-jobs')
  const list = document.getElementById('jobs')
  const more = document.getElementById('jobs-more')
  const jobs = new Map()
  const rows = new Map()
  let open = null

  const ts = (v) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : v ? Date.parse(v) : NaN)

  function apply(job) {
    if (!job?.id) return
    const prev = jobs.get(job.id) ?? {}
    jobs.set(job.id, { ...prev, ...job })
    render()
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
    const isOpen = open === j.id
    let detail = ''
    if (isOpen) {
      const steps = (j.steps ?? []).slice(-6)
      detail =
        '<div class="jb-detail">' +
        (steps.length ? `<ol class="jb-steps">${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : '') +
        (j.summary ? `<p class="jb-sum">${esc(j.summary)}</p>` : '') +
        (ACTIVE.has(j.status)
          ? `<div class="jb-acts">${j.status === 'needs_ok' ? `<button type="button" class="jb-btn jb-approve" data-act="ok">${icon('check')}<span>Schváliť</span></button>` : ''}<button type="button" class="jb-btn" data-act="stop">${icon('stop')}<span>Zastaviť</span></button></div>`
          : '') +
        '</div>'
    }
    return (
      `<button type="button" class="jb-head" data-act="toggle">${statusIcon(j.status)}` +
      `<span class="jb-main"><span class="jb-title">${esc(j.title || 'Úloha')}</span><span class="jb-step" data-step="${esc(step)}">${esc(step)}</span></span>` +
      `<span class="jb-time">${esc(run)}</span></button>${detail}`
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
      const cls = `jb st-${j.status}${open === j.id ? ' is-open' : ''}`
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

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]')
    const row = e.target.closest('.jb')
    if (!btn || !row) return
    const id = row.dataset.id
    const act = btn.dataset.act
    if (act === 'toggle') {
      open = open === id ? null : id
      return render()
    }
    btn.disabled = true
    try {
      if (act === 'stop') await api.jobStop(id)
      if (act === 'ok') await api.jobReply(id, APPROVE)
    } catch (err) {
      console.warn('úloha:', err?.message ?? err)
      btn.disabled = false
    }
  })

  // Čas behu raz za sekundu, len keď niečo beží a stránka je viditeľná.
  if (!capture) {
    setInterval(() => {
      if (document.hidden || !running()) return
      render()
    }, 1000)
  }

  const running = () => [...jobs.values()].filter((j) => ACTIVE.has(j.status)).length

  return {
    apply,
    load,
    render,
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
