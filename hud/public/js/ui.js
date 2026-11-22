// HTML vrstva HUD: horná lišta, dosky Dnes, Rutiny, Pamäť a Log, popisky uzlov,
// titulok Jarvisa a príkazový riadok. Každá metóda render* je funkcia vstupu,
// DOM sa prepisuje len pri zmene (60 snímok za sekundu nesmie hýbať layoutom).

import { botKey, emblem, icon, NODE_ICON } from './icons.js'
import { weatherArt, weatherKind } from './weather.js'
import {
  clamp, clockMinutes, DAYS_SHORT, dayMonth, duration, easeOut, esc, hm, longDate, nf, pad2, parseDay, plural, sameDay, shortDate, smooth, until, wordTimes,
} from './format.js'

const $ = (sel) => document.querySelector(sel)

/** „Rozvrh · 3 položky" → hlavná časť jasne, zvyšok tlmene. */
const splitText = (text) => {
  const i = text.indexOf(' · ')
  return i < 0 ? esc(text) : `${esc(text.slice(0, i))} <span>· ${esc(text.slice(i + 3))}</span>`
}

const KIND_ICON = { school: 'cap', deadline: 'hourglass', routine: 'rutiny', plan: 'flag', allday: 'kalendar', event: 'kalendar', meeting: 'kalendar', birthday: 'gift', travel: 'route', sport: 'heart' }
const WEEKDAYS = ['Ne', 'Po', 'Ut', 'St', 'Št', 'Pi', 'So']

/** 227 425 → „227k", 7 007 → „7k", 3 877 → „3,9k" (zdroje správ v Pamäti). */
const compact = (n) => (n >= 9950 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',').replace(',0', '')}k` : String(n))

/** „claude-opus-5-5" → „Opus 5.5". */
export function modelName(id) {
  if (!id) return null
  const m = /(opus|sonnet|haiku|fable)[-_ ]?(\d+)(?:[-_.](\d+))?/i.exec(id)
  if (!m) return id
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

export function createUI({ capture }) {
  const el = {
    clockHm: $('#clock-hm'),
    clockS: $('#clock-s'),
    clockDate: $('#clock-date'),
    chips: $('#chips'),
    heroHm: $('#hero-hm'),
    todayDate: $('#today-date'),
    wxArt: $('#wx-art'),
    wxTemp: $('#wx-temp'),
    wxText: $('#wx-text'),
    sleep: $('#sleep'),
    agenda: $('#agenda'),
    foot: $('#today-foot'),
    routines: $('#routines'),
    memTotal: $('#mem-total'),
    memUnit: $('#mem-unit'),
    memSrc: $('#mem-src'),
    memMore: $('#mem-more'),
    log: $('#log'),
    labels: $('#labels'),
    subtitle: $('#subtitle'),
    wave: $('#wave'),
    work: $('#work'),
    cmd: $('#cmd'),
    input: $('#cmd-input'),
    cmdWave: $('#cmd-wave'),
    live: $('#cmd-live'),
    keys: $('#keys'),
    orb: $('#orb'),
    toast: $('#toast'),
  }
  const cache = new Map()
  const set = (key, node, value, prop = 'textContent') => {
    if (cache.get(key) === value) return false
    cache.set(key, value)
    node[prop] = value
    return true
  }

  // Mikrofón v orbe.
  el.orb.querySelector('.o-mic').outerHTML = `<g class="o-mic" transform="translate(14.4 14.4) scale(0.8)">${icon('mic').replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g>`
  const orb = {
    core: el.orb.querySelector('.o-core'),
    seg: el.orb.querySelector('.o-seg'),
    ring: el.orb.querySelector('.o-ring'),
    waves: [...el.orb.querySelectorAll('.o-wave')],
  }

  // ── dosky: scroll s prechodom do tmy len tým smerom, kde je ešte obsah ──
  const scrollers = [document.getElementById('scroll-l'), document.getElementById('scroll-r')].filter(Boolean)
  function updateFade(sc) {
    if (capture) sc.scrollTop = 0
    // The panes scroll only up and down. Focus or a trackpad swipe could shift a clipped pane sideways
    // and cut off the start of the clock and the date.
    if (sc.scrollLeft) sc.scrollLeft = 0
    const up = sc.scrollTop > 2
    const down = sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2
    if (sc._up !== up) sc.classList.toggle('can-up', (sc._up = up))
    if (sc._down !== down) sc.classList.toggle('can-down', (sc._down = down))
  }
  const fadeObserver = new ResizeObserver((entries) => {
    for (const e of entries) updateFade(e.target.closest('.pane-scroll') ?? e.target)
  })
  for (const sc of scrollers) {
    sc.addEventListener('scroll', () => updateFade(sc), { passive: true })
    // Koliesko nad doskou patrí doske, nikdy 3D svetu (zoom kamery).
    sc.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true })
    fadeObserver.observe(sc)
    for (const mod of sc.children) fadeObserver.observe(mod)
  }

  // ── stavové čipy ──
  el.chips.innerHTML = [
    `<span class="chip chip-brain" id="chip-brain" data-tip="Mozog|AI, cez ktorú myslím. Beží na vašom predplatnom, nič navyše neplatíte.">${icon('claude')}<span>Claude</span></span>`,
    `<span class="chip chip-model" id="chip-model" data-tip="Model|Ktorým modelom práve odpovedám v rozhovore.">${icon('model')}<span></span></span>`,
    `<button type="button" class="chip chip-wake" id="chip-voice" data-tip="Hlas a počúvanie|Akým hlasom hovorím. Klik zapne Hey Jarvis: stačí ma osloviť a netreba držať medzerník.">${icon('speaker')}<span>Hlas</span></button>`,
    `<span class="chip chip-life" id="chip-life" data-tip="Pamäť|Poznámky o vás, z ktorých čerpám. Sú len vo vašom počítači, v priečinku memory.">${icon('pamat')}<span>Pamäť</span></span>`,
    `<button type="button" class="chip chip-hands is-off" id="chip-hands" data-tip="Ovládanie rukami|Zapne kameru. Kurzor ide za dlaňou a štipnutím prstov kliknete. Obraz neopúšťa počítač." aria-label="Ovládanie rukami" aria-pressed="false">${icon('kamera')}<span>Ruky</span></button>`,
    `<button type="button" class="chip chip-film" id="chip-film" data-tip="Režim natáčania|Skryjem súkromné veci (mená, správy, obsah pamäte), aby ste mohli nahrávať alebo zdieľať obrazovku. Klávesa N.">${icon('film')}<span>Natáčanie</span></button>`,
    `<button type="button" class="chip chip-set" id="chip-set" data-tip="Nastavenia|Hlas, oslovenie, počúvanie, mozog a plocha." aria-label="Nastavenia">${icon('sliders')}</button>`,
    `<button type="button" class="chip chip-jobs" id="chip-jobs" data-tip="Úlohy na pozadí|Na čom práve pracujem sám. Klik ich ukáže." hidden>${icon('projekty')}<span></span></button>`,
    `<span class="chip chip-app" id="chip-app" hidden>${icon('app')}<span></span></span>`,
  ].join('')
  // A chip explains itself: a small pane under it with its name and one sentence on what it does.
  const tipEl = document.createElement('div')
  tipEl.className = 'tip'
  tipEl.hidden = true
  document.body.append(tipEl)
  let tipTimer = 0
  const hideTip = () => {
    clearTimeout(tipTimer)
    tipEl.classList.remove('is-on')
    tipEl.hidden = true
  }
  const showTip = (target) => {
    const [name, text] = String(target.dataset.tip ?? '').split('|')
    if (!name) return
    tipEl.innerHTML = `<b>${esc(name)}</b>${text ? `<span>${esc(text)}</span>` : ''}`
    tipEl.hidden = false
    const r = target.getBoundingClientRect()
    const w = tipEl.offsetWidth
    const x = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2))
    tipEl.style.transform = `translate3d(${x.toFixed(0)}px,${(r.bottom + 10).toFixed(0)}px,0)`
    requestAnimationFrame(() => tipEl.classList.add('is-on'))
  }
  el.chips.addEventListener('pointerover', (e) => {
    const target = e.target.closest('[data-tip]')
    if (!target || target.contains(e.relatedTarget)) return
    clearTimeout(tipTimer)
    tipTimer = setTimeout(() => showTip(target), 350)
  })
  el.chips.addEventListener('pointerout', (e) => {
    const target = e.target.closest('[data-tip]')
    if (target && !target.contains(e.relatedTarget)) hideTip()
  })
  el.chips.addEventListener('focusin', (e) => e.target.closest('[data-tip]') && e.target.matches(':focus-visible') && showTip(e.target.closest('[data-tip]')))
  el.chips.addEventListener('focusout', hideTip)
  el.chips.addEventListener('pointerdown', hideTip)
  const chip = {
    brain: $('#chip-brain'),
    model: $('#chip-model'),
    voice: $('#chip-voice'),
    life: $('#chip-life'),
    film: $('#chip-film'),
    app: $('#chip-app'),
    jobs: $('#chip-jobs'),
  }
  const setChip = (key, node, { cls, html, hidden = false, title }) => {
    set(`${key}:cls`, node, `chip ${node.dataset.base ?? (node.dataset.base = node.className.replace(/\s*is-\w+/g, '').replace(/^chip\s*/, ''))}${cls ? ` ${cls}` : ''}`, 'className')
    if (html !== undefined) set(`${key}:html`, node, html, 'innerHTML')
    if (node.hidden !== hidden) node.hidden = hidden
    // What a chip reports right now goes into its own explanation (the pane under it), not into a second,
    // native tooltip: the name stays, the live sentence is added after what the chip is for.
    if (title !== undefined && cache.get(`${key}:tip`) !== title) {
      cache.set(`${key}:tip`, title)
      const [name, about = ''] = String(node.dataset.tipBase ?? (node.dataset.tipBase = node.dataset.tip ?? '')).split('|')
      node.dataset.tip = name ? `${name}|${[about, title === name || about.includes(title) ? '' : title].filter(Boolean).join(' ')}` : `${title}|`
    }
  }

  // ── stav dát zo snapshotu ──
  let snap = null
  let nodes = []
  let labelEls = new Map()
  let routineRows = []
  let routinesModel = []
  let wxKind = null

  function setSnapshot(snapshot, nodeList) {
    snap = snapshot
    nodes = nodeList
    cache.delete('minute')
    wxKind = null
    renderMemory()
    renderRoutineRows()
    renderLabelsStatic()
    renderSleep()
  }

  // ── Dnes: spánok ──
  function renderSleep() {
    const h = snap.health ?? {}
    if (!h.sleepMin) {
      el.sleep.innerHTML = ''
      return
    }
    const score = clamp((h.sleepScore ?? 0) / 100)
    const r = 27
    const circ = 2 * Math.PI * r
    const a = score * Math.PI * 2
    const dx = 32 + Math.cos(a) * r
    const dy = 32 + Math.sin(a) * r
    const week = (h.week ?? []).slice(-7)
    const max = Math.max(...week.map((d) => d.sleepMin), 1)
    const min = Math.min(...week.map((d) => d.sleepMin), max - 1)
    const lastDay = week.length ? week[week.length - 1].day : null
    const bars = week
      .map((d) => {
        const day = parseDay(d.day)
        const height = Math.round(18 + ((d.sleepMin - min) / Math.max(1, max - min)) * 82)
        return `<span class="wk${d.day === (h.day ?? lastDay) ? ' today' : ''}" title="${esc(duration(d.sleepMin))}"><i class="${d.score < 60 ? 'low' : ''}" style="height:${height}%"></i><em>${day ? DAYS_SHORT[day.getDay()] : ''}</em></span>`
      })
      .join('')
    const sub = [h.hrvMs ? `HRV ${h.hrvMs} ms` : null, h.restingHr ? `tep ${h.restingHr}` : null].filter(Boolean).join(' · ')
    el.sleep.innerHTML =
      `<div class="ring${(h.sleepScore ?? 100) < 60 ? ' low' : ''}"><svg viewBox="0 0 64 64">` +
      `<circle class="r-ticks" cx="32" cy="32" r="31" stroke-dasharray="0.8 3.07"/>` +
      `<circle class="r-track" cx="32" cy="32" r="${r}"/>` +
      `<circle class="r-val" cx="32" cy="32" r="${r}" stroke-dasharray="${(circ * score).toFixed(2)} ${circ.toFixed(2)}" style="--len:${(circ * score).toFixed(2)}"/>` +
      `<circle class="r-dot" cx="${dx.toFixed(2)}" cy="${dy.toFixed(2)}" r="2.4"/></svg>` +
      `<div class="ring-num"><b>${h.sleepScore ?? '–'}</b><span>skóre</span></div></div>` +
      `<div><div class="sleep-dur">${esc(duration(h.sleepMin))}</div><div class="sleep-sub">Spánok${sub ? ` · ${esc(sub)}` : ''}</div><div class="week">${bars}</div></div>`
  }

  // ── Dnes: najbližšie udalosti ──
  function agendaDays() {
    const days = []
    const push = (day, items, nameDays) => {
      const d = parseDay(day)
      if (d && Array.isArray(items)) days.push({ day: d, items, nameDays })
    }
    const s = snap.schedule
    if (s) push(s.day, s.items, s.nameDays)
    for (const extra of [s?.tomorrow, snap.agenda, snap.schedules].flat().filter(Boolean)) push(extra.day, extra.items, extra.nameDays)
    const seen = new Set()
    return days.filter((d) => {
      const k = d.day.toDateString()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }

  function renderAgenda(now) {
    const nowMin = now.getHours() * 60 + now.getMinutes()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const list = []
    for (const { day, items } of agendaDays()) {
      if (day < today) continue
      const isToday = sameDay(day, now)
      for (const it of items) {
        if (it.kind === 'routine') continue
        const m = clockMinutes(it.time)
        const end = clockMinutes(it.end) ?? (m !== null ? m + (it.kind === 'deadline' ? 0 : 45) : null)
        // Termín (deadline) zmizne v čase termínu, ostatné po skončení.
        if (isToday && end !== null && end < nowMin) continue
        if (isToday && m === null && it.kind !== 'allday') continue
        list.push({ ...it, day, isToday, m, end, sort: day.getTime() + (m ?? -1) * 60_000 })
      }
    }
    list.sort((a, b) => a.sort - b.sort)
    const shown = list.slice(0, 3)
    if (!shown.length) {
      set('agenda', el.agenda, '<li class="agenda-empty">Dnes už nič v kalendári.</li>', 'innerHTML')
      return
    }
    const html = shown
      .map((it, i) => {
        const next = i === 0
        let when = ''
        if (!it.isToday) {
          const tomorrow = new Date(today.getTime() + 86_400_000)
          when = sameDay(it.day, tomorrow) ? 'zajtra' : shortDate(it.day)
        } else if (it.m !== null) {
          when = it.m <= nowMin ? (it.end !== null && it.end > nowMin ? `ešte ${duration(it.end - nowMin)}` : 'práve teraz') : until(it.m - nowMin)
        }
        // Celodenná udalosť: v stĺpci času deň (dnes, zajtra, ut 10.), „celý deň" ide do podtitulku.
        const allDay = !it.time
        const dayLabel = it.isToday ? 'dnes' : when
        if (allDay) when = 'celý deň'
        // Everything here comes from the calendar (titles and places can be written by whoever sent an invitation): escaped, always.
        const sub = [it.place ? esc(it.place) : null, when ? (next ? `<b>${esc(when)}</b>` : esc(when)) : null].filter(Boolean)
        return (
          `<li class="ev${next ? ' next' : ''}${it.isToday ? '' : ' other-day'}">${icon(KIND_ICON[it.kind] ?? 'kalendar')}` +
          `<span class="ev-time${allDay ? ' allday' : ''}">${esc(allDay ? dayLabel : it.time)}</span>` +
          `<span class="ev-body"><span class="ev-title">${esc(it.title)}</span>${sub.length ? `<span class="ev-sub">${sub.join(' · ')}</span>` : ''}</span></li>`
        )
      })
      .join('')
    set('agenda', el.agenda, html, 'innerHTML')
  }

  // ── Dnes: počasie ──
  function renderWeather(now) {
    const w = snap.weather
    if (!w) return
    const kind = weatherKind(w, now)
    if (kind !== wxKind) {
      wxKind = kind
      el.wxArt.innerHTML = weatherArt(kind)
    }
    set('wxTemp', el.wxTemp, Number.isFinite(w.tempC) ? `${Math.round(w.tempC)}<sup>°C</sup>` : '', 'innerHTML')
    set('wxText', el.wxText, [w.text, w.place].filter(Boolean).join(' · '))
  }

  // ── Rutiny ──
  function classifyRoutine(r) {
    const weekly = /^(Ne|Po|Ut|St|Št|Pi|So)\s+(\d{1,2}:\d{2})$/.exec(r.time ?? '')
    if (weekly) return { kind: 'weekly', wd: WEEKDAYS.indexOf(weekly[1]), m: clockMinutes(weekly[2]) }
    if (/každ/.test(r.time ?? '')) return { kind: 'live', every: /(\d+)/.exec(r.time)?.[1] }
    const m = clockMinutes(r.time)
    return m === null ? { kind: 'other' } : { kind: 'daily', m }
  }

  function renderRoutineRows() {
    const all = (snap.routines ?? []).map((r) => ({ ...r, ...classifyRoutine(r) }))
    const daily = all.filter((r) => r.kind === 'daily').sort((a, b) => a.m - b.m)
    const extra = all.filter((r) => r.kind !== 'daily')
    routinesModel = { daily, extra }
    const row = (r, cls = '') =>
      `<li class="tl-row ${cls}">${emblem(botKey(r.bot))}` +
      `<span class="tl-t">${esc(r.kind === 'live' ? `${r.every ?? ''} min` : r.time)}</span>` +
      `<span class="tl-n">${esc(r.name)}<small>${esc(r.bot)}</small></span><span class="tl-s"></span></li>`
    el.routines.innerHTML =
      daily.map((r) => row(r)).join('') +
      '<li class="tl-now" id="tl-now"><span></span></li>' +
      (extra.length ? `<li class="tl-sep" aria-hidden="true"></li>${extra.map((r) => row(r, 'extra')).join('')}` : '')
    routineRows = [...el.routines.querySelectorAll('.tl-row')]
  }

  function renderRoutines(now) {
    const { daily, extra } = routinesModel
    if (!daily) return
    const nowMin = now.getHours() * 60 + now.getMinutes()
    const nowEl = el.routines.querySelector('#tl-now')
    let nextIndex = daily.findIndex((r) => r.m > nowMin)
    daily.forEach((r, i) => {
      const rowEl = routineRows[i]
      const past = r.m <= nowMin
      const next = i === nextIndex
      rowEl.className = `tl-row${past ? ' past' : ''}${next ? ' next' : ''}`
      rowEl.querySelector('.tl-s').textContent = next ? `${until(r.m - nowMin)} · ${r.bot}` : ''
      const em = rowEl.querySelector('.em')
      em.classList.toggle('amber', next)
    })
    // Značka „teraz" medzi minulými a budúcimi.
    const anchor = nextIndex === -1 ? routineRows[daily.length - 1]?.nextSibling : routineRows[nextIndex]
    if (anchor && nowEl.nextSibling !== anchor && anchor !== nowEl) el.routines.insertBefore(nowEl, anchor)
    nowEl.firstChild.textContent = `teraz ${hm(now)}`
    extra.forEach((r, i) => {
      const rowEl = routineRows[daily.length + i]
      let status = ''
      if (r.kind === 'live') status = 'beží'
      else if (r.kind === 'weekly') {
        const daysTo = (r.wd - now.getDay() + 7) % 7
        if (daysTo === 0 && r.m > nowMin) status = until(r.m - nowMin)
        else status = daysTo === 0 ? 'o 7 dní' : daysTo === 1 ? 'zajtra' : `o ${daysTo} ${plural(daysTo, 'deň', 'dni', 'dní')}`
      }
      rowEl.className = `tl-row extra${r.kind === 'live' ? ' live' : ''}`
      rowEl.querySelector('.tl-s').textContent = status
    })
    // Os: svetlá časť po „teraz".
    const listH = el.routines.offsetHeight || 1
    const pct = clamp((nowEl.offsetTop + nowEl.offsetHeight / 2) / listH) * 100
    el.routines.style.setProperty('--now', `${pct.toFixed(1)}%`)
    const label = labelEls.get('rutiny')?.querySelector('.nl-s')
    if (label) set('rutinyLabel', label, nextIndex >= 0 ? `ďalšia ${daily[nextIndex].time}` : 'na dnes hotovo')
  }

  // ── Pamäť ──
  function renderMemory() {
    const m = snap.memory ?? {}
    el.memTotal.textContent = nf(m.notes ?? 0)
    const since = parseDay(m.since)
    el.memUnit.textContent = `${plural(m.notes ?? 0, 'poznámka', 'poznámky', 'poznámok')}${since ? ` od ${since.getDate()}. ${since.getMonth() + 1}. ${since.getFullYear()}` : ''}`
    const sources = [...(m.sources ?? [])].sort((a, b) => b.count - a.count).slice(0, 8)
    const max = Math.max(...sources.map((s) => s.count), 1)
    el.memSrc.innerHTML = sources
      .map((s) => {
        const d = 0.38 + Math.sqrt(s.count / max) * 1.12
        return `<li class="ms" title="${esc(s.name)} · ${nf(s.count)}"><i class="ms-b" style="width:${d.toFixed(2)}rem;height:${d.toFixed(2)}rem"></i><span class="ms-n">${esc(s.name)}</span><span class="ms-c">${compact(s.count)}</span></li>`
      })
      .join('')
    el.memMore.innerHTML = [
      ['person', m.people, 'ľudí'],
      ['projekty', m.projects, 'projektov'],
      ['questy', m.goals, 'cieľov'],
      ['spravy', m.chatMessages, 'správ s Jarvisom'],
    ]
      .filter(([, v]) => Number.isFinite(v) && v > 0)
      .map(([i, v, k]) => `<span class="mm" title="${nf(v)} ${k}">${icon(i)}<b>${nf(v)}</b></span>`)
      .join('')
  }

  // ── hodiny a minútové prepočty ──
  function renderClock(now) {
    set('clockHm', el.clockHm, hm(now))
    set('clockS', el.clockS, pad2(now.getSeconds()))
    set('clockDate', el.clockDate, `${shortDate(now)} ${now.getFullYear()}`)
    set('heroHm', el.heroHm, `${pad2(now.getHours())}<span class="colon">:</span>${pad2(now.getMinutes())}`, 'innerHTML')
    set('todayDate', el.todayDate, longDate(now))
    if (!snap) return
    const minute = `${now.toDateString()} ${now.getHours()}:${now.getMinutes()}`
    if (cache.get('minute') === minute) return
    cache.set('minute', minute)
    renderWeather(now)
    renderAgenda(now)
    renderRoutines(now)
    renderFoot(now, cache.get('stateObj') ?? {})
  }

  // ── stav: meniny ──
  function renderFoot(now, state) {
    const parts = []
    const s = snap?.schedule
    const day = parseDay(s?.day)
    // Meniny: len krstné meno (kontakty z kalendára ako počet, nie celé mená, HUD sa natáča).
    const todayPeople = (snap?.celebrations ?? []).filter((c) => c.kind === 'nameday' && c.daysUntil === 0)
    const first = [...new Set([...(s?.nameDays ?? []), ...todayPeople.map((c) => String(c.name ?? '').split(/\s+/)[0])].filter(Boolean))]
    const known = todayPeople.filter((c) => /\s/.test(String(c.name ?? '').trim())).length
    if (first.length) {
      const label = todayPeople.length || (day && sameDay(day, now)) ? 'Meniny má' : `Meniny ${day ? dayMonth(day) : ''}`
      const extra = known ? ` · ${known} ${plural(known, 'známy', 'známi', 'známych')}` : ''
      parts.push(`<span class="tf">${icon('gift')}<span>${label} <b>${esc(first.join(', '))}</b>${extra}</span></span>`)
    }
    set('foot', el.foot, parts.join(''), 'innerHTML')
  }

  function renderState(state, now) {
    const key = `${state.app}|${state.host}`
    if (cache.get('state') !== key) {
      cache.set('state', key)
      cache.set('stateObj', state)
      if (snap) renderFoot(now, state)
    }
    const app = state.app ? `${state.app}${state.host && state.host !== 'web' ? ` · ${state.host}` : ''}` : null
    if (cache.get('appText') === app) return
    cache.set('appText', app)
    setChip('app', chip.app, { hidden: !app, html: app ? `${icon('app')}<span><span class="pre">Aktívne</span> ${esc(app)}</span>` : undefined, title: 'Aktívne okno (ActivityWatch)' })
  }

  // ── čipy: mozog, model, hlas, pamäť, natáčanie ──
  /** „sk-SK-LukasNeural" → „Lukas". */
  const voiceName = (status) => {
    const v = /-([A-Z][a-z]+)Neural/.exec(status?.voice ?? '')?.[1]
    if (v) return v
    return { edge: 'Edge', elevenlabs: 'ElevenLabs', say: 'systémový', browser: 'prehliadač' }[status?.tts] ?? null
  }
  function renderStatus(status, { film, snapshotAge, connected, micState = null }) {
    const brain = status?.brain ?? null
    const ok = brain === 'ready' || brain === 'busy'
    const starting = brain === 'starting'
    const mock = brain === 'mock' || status?.mock === true
    // Týždenné využitie predplatného (brainInfo.limit), farba až pri blížiacom sa limite.
    const limit = status?.brainInfo?.limit
    const util = Number.isFinite(limit?.utilization) ? limit.utilization : null
    const blocked = limit?.status && limit.status !== 'allowed' && limit.status !== 'allowed_warning'
    const pct = util !== null && !mock ? ` <span class="pre">${Math.round(util * 100)} %</span>` : ''
    // The name of the agent Jarvis runs on (Claude or ChatGPT) comes from the server, never from page content.
    // The name of the AI Jarvis runs on, as the server says it (Claude, ChatGPT, Gemini).
    const ai = ['ChatGPT', 'Gemini'].includes(status?.aiName) ? status.aiName : 'Claude'
    const brainText = !connected ? 'Server nedostupný' : mock ? `${ai} <b>mock</b>` : brain === 'busy' ? `${ai} pracuje` : ok ? `${ai} online` : starting ? `${ai} štartuje` : brain === 'error' ? `${ai} chyba` : status ? `${ai} offline` : `${ai} nepripojený`
    const resets = Number.isFinite(limit?.resetsAt) ? new Date(limit.resetsAt * (limit.resetsAt < 1e12 ? 1000 : 1)) : null
    setChip('brain', chip.brain, {
      cls: !(ok || mock) ? (starting ? 'is-warn' : 'is-err') : blocked || (util ?? 0) >= 0.95 ? 'is-err' : (util ?? 0) >= 0.8 ? 'is-warn' : '',
      html: `${icon('claude')}<span>${brainText}${pct}</span>`,
      title: util !== null ? `Týždenné využitie predplatného ${Math.round(util * 100)} %${resets ? `, obnova ${shortDate(resets)} ${hm(resets)}` : ''}` : '',
    })
    const model = modelName(status?.model)
    setChip('model', chip.model, { hidden: !model || mock, html: `${icon('model')}<span>${esc(model ?? '')}</span>` })
    // Hey Jarvis poctivo: stav streamu z prehliadača (wake.js), inak uši servera (no-mic = nefunguje).
    const wake = status?.wake === true
    const name = voiceName(status)
    let voiceCls = name ? '' : 'is-off'
    let voiceHtml = `${icon('speaker')}<span>Hlas${name ? ` <b>${esc(name)}</b>` : ''}</span>`
    let voiceTitle = status?.wakeAvailable ? 'Hlas Jarvisa. Klik zapne Hey Jarvis, hovoriť sa dá vždy cez medzerník.' : 'Hlas Jarvisa. Hovor cez medzerník.'
    const wakeChip = (cls, text, title) => {
      voiceCls = cls
      voiceHtml = `${icon('wake')}<span>${text}</span>`
      if (title) voiceTitle = title
    }
    const MIC = {
      streaming: ['is-on', 'Počúvam <b>Hey Jarvis</b>', 'Hey Jarvis počúva. Klik ho vypne.'],
      connecting: ['is-warn', 'Hey Jarvis sa pripája'],
      reconnecting: ['is-warn', 'Hey Jarvis sa pripája'],
      suspended: ['is-warn', 'Hey Jarvis čaká na klik', 'Prehliadač pustí mikrofón až po kliknutí alebo klávese.'],
      blocked: ['is-err', 'Mikrofón zamietnutý', 'Povoľte mikrofón pre localhost, potom kliknite na čip.'],
      replaced: ['is-off', 'Hey Jarvis počúva inde', 'Mikrofón má iné okno HUD (napríklad appka na ploche).'],
      paused: ['is-off', 'Hey Jarvis pozastavený', 'Okno je skryté, mikrofón je uvoľnený.'],
      error: ['is-err', 'Hey Jarvis nefunguje', 'Stream mikrofónu zlyhal, skúša sa znova.'],
    }
    if (wake && MIC[micState]) wakeChip(...MIC[micState])
    else if (wake) wakeChip('is-warn', 'Hey Jarvis štartuje', 'Mikrofón pre Hey Jarvis sa pripája. Hovoriť sa dá cez medzerník.')
    setChip('voice', chip.voice, { cls: voiceCls, html: voiceHtml, title: voiceTitle })
    const mem = status?.memory
    const stale = snapshotAge !== null && snapshotAge > 45 * 60
    const memBad = mem && mem.ok === false && !mem.at
    const memEmpty = mem && (mem.notes ?? 0) === 0
    setChip('life', chip.life, {
      cls: memBad ? 'is-err' : stale || memEmpty ? 'is-warn' : '',
      html: `${icon('pamat')}<span>Pamäť${memEmpty ? ' <span class="pre">prázdna</span>' : ''}</span>`,
      title: memBad ? 'Pamäť sa nedá načítať' : memEmpty ? 'Pamäť je prázdna. Otvor priečinok Jarvisa v Claude a napíš „štart".' : stale ? 'Pamäť: údaje sú staršie ako 45 min' : 'Pamäť pripojená',
    })
    setChip('film', chip.film, { cls: film ? 'is-on' : 'is-off', html: `${icon('film')}<span>Natáčanie</span>` })
  }

  /**
   * Čip „2 úlohy bežia" v lište, jantárový keď Jarvis na niečo čaká. Úlohy sú jeho ruky:
   * keď treba odpoveď alebo súhlas, pýta sa on („Mám otázku", „Čakám na súhlas").
   */
  function renderJobsChip(active, waiting, asking = 0) {
    const text = asking
      ? asking > 1 ? `Mám ${asking} ${plural(asking, 'otázku', 'otázky', 'otázok')}` : 'Mám otázku'
      : waiting
        ? 'Čakám na súhlas'
        : `${active} ${plural(active, 'úloha beží', 'úlohy bežia', 'úloh beží')}`
    setChip('jobs', chip.jobs, { hidden: !active, cls: waiting ? 'is-warn' : 'is-busy', html: `${icon(asking ? 'info' : waiting ? 'hourglass' : 'projekty')}<span>${text}</span>`, title: 'Úlohy Jarvisa na pozadí, klik otvorí priebeh' })
  }

  // ── LOG ──
  const logRows = new Map()
  const MAX_LOG = 6
  function renderLog(entries, t) {
    const visible = entries.slice(0, MAX_LOG)
    const keep = new Set(visible.map((e) => e.key))
    for (const [key, row] of logRows) {
      if (!keep.has(key)) {
        row.remove()
        logRows.delete(key)
      }
    }
    visible.forEach((e, index) => {
      let row = logRows.get(e.key)
      if (!row) {
        row = document.createElement('li')
        row.className = `t-${e.type}`
        row.innerHTML = `<span class="le-t">${pad2(e.when.getHours())}:${pad2(e.when.getMinutes())}:${pad2(e.when.getSeconds())}</span><span class="le-i">${icon(e.icon || 'info')}</span><span class="le-x">${splitText(e.text ?? '')}</span><span class="le-flash"></span>`
        row._flash = row.querySelector('.le-flash')
        logRows.set(e.key, row)
      }
      if (el.log.children[index] !== row) el.log.insertBefore(row, el.log.children[index] ?? null)
      const age = t - e.at
      const p = easeOut(age / 0.7)
      const fadeOld = index >= 3 ? 1 - (index - 2) * 0.22 : 1
      const transform = p < 1 ? `translate3d(${((1 - p) * 1.8).toFixed(3)}rem,0,0)` : 'none'
      if (row._tf !== transform) row.style.transform = row._tf = transform
      const opacity = (clamp(age / 0.35) * clamp(fadeOld)).toFixed(3)
      if (row._op !== opacity) row.style.opacity = row._op = opacity
      const flash = 1 - smooth(age / 1.8)
      const color = e.type === 'alert' ? '255,178,92' : '127,243,255'
      const bg = flash > 0.002 ? `linear-gradient(90deg, rgba(${color},${(0.2 * flash).toFixed(3)}), rgba(${color},0) 80%)` : 'none'
      if (row._bg !== bg) row._flash.style.background = row._bg = bg
    })
  }

  // ── popisky uzlov ──
  function renderLabelsStatic() {
    el.labels.innerHTML = nodes
      .map(
        (n) =>
          `<div class="nl" data-node="${n.id}" data-side="${n.side}"${n.minor ? ' data-minor="1"' : ''}><div class="nl-in" data-node="${n.id}"><div class="nl-k">${icon(NODE_ICON[n.id] ?? n.icon ?? 'info')}<span>${esc(n.label)}</span></div><div class="nl-v">${esc(n.value)}</div><div class="nl-s">${esc(n.sub)}</div><div class="nl-cap"></div></div></div>`,
      )
      .join('')
    // Many planets on the ring: the labels keep only the name and the number, the detail line shows on hover.
    el.labels.classList.toggle('is-dense', nodes.filter((n) => !n.minor).length > 8)
    labelEls = new Map([...el.labels.children].map((node) => [node.dataset.node, node]))
    for (const node of labelEls.values()) node._cap = node.querySelector('.nl-cap')
    cache.delete('rutinyLabel')
    cache.delete('minute')
  }

  /** points z core.project(): [{id, x, y, cx?, cy?, r?, visible?, focus?, side?}] v CSS px. */
  function renderLabels(points, { flares = {}, focus = null, toolNodes = {}, caption = null, hover = null, bounds = null } = {}) {
    for (const p of points) {
      const node = labelEls.get(p.id)
      if (!node) continue
      node._pref ??= node.dataset.side
      // Kotva: stred objektu (cx, cy) a odstup o jeho polomer, nezávisle od toho, či svet posúva y.
      const x = Number.isFinite(p.cx) ? p.cx : p.x
      const y = Number.isFinite(p.cy) ? p.cy : p.y
      const off = Number.isFinite(p.r) && p.r > 0 ? Math.round(Math.max(16, p.r * 0.9 + 8)) : null
      if (off !== null && node._off !== off) {
        node._off = off
        node.style.setProperty('--off', `${off}px`)
      }
      // Popisok sa otočí na druhú stranu objektu, keď by vošiel pod lištu alebo do titulku.
      let side = p.side ?? node._pref
      let shift = 0
      if (bounds && off !== null && side !== 'left' && side !== 'right') {
        node._h ??= node.firstElementChild.offsetHeight || 64
        const cur = node._side ?? side
        const roomAbove = y - off - node._h - bounds.top
        const roomBelow = bounds.bottom - (y + off + node._h)
        const hyst = (s) => (cur === s ? 0 : 8)
        if (side === 'above' && roomAbove < hyst('above') && roomBelow > roomAbove) side = 'below'
        else if (side === 'below' && roomBelow < hyst('below') && roomAbove > roomBelow) side = 'above'
        // Veľký objekt (fokus): popisok ostane pod lištou a nad titulkom.
        if (side === 'above' && y - off - node._h < bounds.top) shift = bounds.top - (y - off - node._h)
        if (side === 'below' && y + off + node._h > bounds.bottom) shift = bounds.bottom - (y + off + node._h)
      }
      if (node._side !== side) node.dataset.side = node._side = side
      const tf = `translate3d(${x.toFixed(1)}px,${(y + shift).toFixed(1)}px,0)`
      if (node._tf !== tf) node.style.transform = node._tf = tf
      const hot = (flares[p.id]?.f ?? 0) > 0.22
      const isFocus = Number.isFinite(p.focus) ? p.focus > 0.5 : focus?.node === p.id
      const busy = Boolean(toolNodes[p.id])
      const anyFocus = Number.isFinite(p.focus) ? points.some((q) => q.focus > 0.5) : Boolean(focus)
      const dim = anyFocus && !isFocus
      // Mimo voľnej plochy (pod lištou, v titulku) popisok zmizne, pri fokuse ostatné stíchnu.
      const outside = bounds && !isFocus && (y < bounds.top || y > bounds.bottom)
      const op = (p.visible === false || outside ? 0 : dim ? 0.28 : 1).toFixed(2)
      if (node._op !== op) node.style.opacity = node._op = op
      const cls = `nl${hot || busy ? ' is-hot' : ''}${busy ? ' is-busy' : ''}${isFocus ? ' is-focus' : ''}${hover === p.id ? ' is-hover' : ''}${node._crowd ? ' is-crowded' : ''}`
      if (node._cls !== cls) {
        node.className = node._cls = cls
        node._h = undefined
      }
      const cap = isFocus ? caption ?? '' : ''
      if (node._capText !== cap) node._cap.textContent = node._capText = cap
    }
    // A few times a second: the label of a moon that lands on a planet's label steps back (it shows on hover).
    if (++crowdTick % 20 === 0) markCrowded()
  }

  let crowdTick = 0
  function markCrowded() {
    const boxes = []
    for (const node of labelEls.values()) {
      if (node.dataset.minor || node._op === '0.00') continue
      const r = node.firstElementChild?.getBoundingClientRect()
      if (r?.width) boxes.push(r)
    }
    for (const node of labelEls.values()) {
      if (!node.dataset.minor) continue
      const r = node.firstElementChild?.getBoundingClientRect()
      const hit = Boolean(r?.width) && boxes.some((b) => r.left < b.right + 6 && r.right > b.left - 6 && r.top < b.bottom + 4 && r.bottom > b.top - 4)
      node._crowd = hit
    }
  }

  // ── titulok Jarvisa: slovo po slove, max 2 riadky, dlhé vety po stránkach ──
  const measure = document.createElement('canvas').getContext('2d')
  let sub = { key: null, words: [], pages: [], page: -1 }
  function layoutPages(words, long) {
    const style = getComputedStyle(el.subtitle)
    const size = parseFloat(style.fontSize) * (long ? 1 : 1)
    measure.font = `500 ${size}px ${style.fontFamily}`
    const width = el.subtitle.clientWidth * 0.94 || 600
    const space = measure.measureText(' ').width
    const lines = []
    let line = []
    let w = 0
    words.forEach((x, i) => {
      const ww = measure.measureText(x.w).width
      if (line.length && w + space + ww > width) {
        lines.push(line)
        line = []
        w = 0
      }
      line.push(i)
      w += (line.length > 1 ? space : 0) + ww
    })
    if (line.length) lines.push(line)
    const pages = []
    for (let i = 0; i < lines.length; i += 2) pages.push(lines.slice(i, i + 2))
    return pages
  }

  /** cue: {key, text, t, end}; t: aktuálny čas v osi cue. */
  function renderSubtitle(cue, t) {
    if (!cue) {
      if (sub.key !== null) {
        el.subtitle.innerHTML = ''
        sub = { key: null, words: [], pages: [], page: -1 }
      }
      return
    }
    if (cue.key !== sub.key) {
      const words = wordTimes(cue.text, cue.t, cue.end)
      const long = cue.text.length > 70
      el.subtitle.classList.toggle('is-long', long)
      sub = { key: cue.key, words, pages: layoutPages(words, long), page: -1, cue }
    }
    let current = -1
    for (let i = 0; i < sub.words.length; i++) if (t >= sub.words[i].start - 0.04) current = i
    const page = Math.max(0, sub.pages.findIndex((pg) => pg.flat().includes(Math.max(0, current))))
    if (page !== sub.page) {
      sub.page = page
      const lines = sub.pages[page] ?? []
      el.subtitle.innerHTML = lines
        .map((line) => `<span class="line">${line.map((i) => `<span class="w" data-i="${i}">${esc(sub.words[i].w)}</span>`).join(' ')}</span>`)
        .join('')
      for (const x of sub.words) {
        x.node = null
        x.on = undefined
        x.cur = undefined
      }
      for (const node of el.subtitle.querySelectorAll('.w')) sub.words[Number(node.dataset.i)].node = node
    }
    const cue2 = sub.cue
    sub.words.forEach((x, i) => {
      if (!x.node) return
      const on = i <= current
      if (x.on !== on) {
        x.on = on
        x.node.classList.toggle('on', on)
      }
      const cur = i === current && t < cue2.end
      if (x.cur !== cur) {
        x.cur = cur
        x.node.classList.toggle('cur', cur)
      }
    })
    const fade = t < cue.t + 0.2 ? clamp((t - cue.t) / 0.2) : 1 - clamp((t - cue.end - 0.7) / 0.45)
    const opacity = fade.toFixed(3)
    if (el.subtitle._op !== opacity) el.subtitle.style.opacity = el.subtitle._op = opacity
  }

  // ── príkazový riadok ──
  const PLACEHOLDER = {
    idle: 'Povedz Jarvisovi…',
    listening: 'Počúvam…',
    transcribing: 'Prepisujem…',
    thinking: 'Jarvis premýšľa…',
    speaking: 'Jarvis hovorí…',
    offline: 'Jarvis nie je pripojený',
    wake: 'Povedzte „Hey Jarvis"…',
  }
  function renderPlaceholder(state) {
    set('ph', el.input, PLACEHOLDER[state] ?? PLACEHOLDER.idle, 'placeholder')
  }

  /** Živý text v riadku (prepis hlasu, scéna). html=null skryje. */
  function renderLive(html) {
    const value = html ?? ''
    if (set('live', el.live, value, 'innerHTML')) el.cmd.classList.toggle('has-live', Boolean(value))
  }

  /** Scéna: veta používateľa sa píše do riadku ako živý prepis (ako v1). */
  function renderPromptCue(cue, t) {
    const active = cue && t >= cue.t && t < cue.end + 0.9
    if (!active) return renderLive(null)
    const typeDur = Math.max(0.35, Math.min(cue.end - cue.t - 0.15, cue.text.length / 17 + 0.25))
    const shown = Math.floor(clamp((t - cue.t) / typeDur) * cue.text.length)
    const typing = t < cue.end + 0.25
    renderLive(`${esc(cue.text.slice(0, shown))}${typing ? '<i class="caret"></i>' : ''}`)
  }

  const KEYSETS = {
    idle: [['Medzerník', 'hovoriť'], ['Enter', 'písať']],
    typing: [['Enter', 'poslať'], ['Esc', 'zrušiť']],
    listening: [['Esc', 'zrušiť']],
    busy: [['Esc', 'stop', 'stop'], ['Enter', 'písať']],
    scene: [['Medzerník', 'štart'], ['Esc', 'stop']],
  }
  function renderKeys(mode) {
    if (cache.get('keys') === mode) return
    cache.set('keys', mode)
    el.keys.innerHTML = (mode === 'none' ? [] : KEYSETS[mode] ?? KEYSETS.idle).map(([k, label, cls]) => `<span class="key${cls ? ` ${cls}` : ''}"><kbd>${k}</kbd>${label}</span>`).join('')
  }

  // ── what Jarvis is doing right now, above the command bar ──
  let workOff = null
  /**
   * work: null (nothing runs) or { label, sub, since (ms), job (id or null) }. Dots, what he does,
   * what it belongs to and how long it has taken. The line fades out before it is removed.
   */
  function renderWork(work, nowMs) {
    const node = el.work
    if (!node) return
    if (!work) {
      if (cache.get('work') === null) return
      cache.set('work', null)
      node.classList.remove('is-on')
      clearTimeout(workOff)
      workOff = setTimeout(() => (node.hidden = true), 380)
      return
    }
    const s = Number.isFinite(work.since) ? Math.max(0, Math.floor((nowMs - work.since) / 1000)) : null
    const time = s === null || s < (work.job ? 1 : 5) ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    const key = `${work.job ?? ''}|${work.label ?? ''}|${work.sub ?? ''}|${time}`
    if (cache.get('work') === key) return
    const fresh = cache.get('work') === null || cache.get('work') === undefined
    cache.set('work', key)
    clearTimeout(workOff)
    node.hidden = false
    node.classList.toggle('is-job', Boolean(work.job))
    node.dataset.job = work.job ?? ''
    node.setAttribute('aria-label', work.job ? 'Jarvis pracuje, klik otvorí priebeh' : 'Jarvis pracuje')
    node.innerHTML =
      '<span class="thinking" aria-hidden="true"><i></i><i></i><i></i></span>' +
      (work.label ? `<span class="wk-t">${esc(work.label)}</span>` : '') +
      (work.sub ? `<span class="wk-s">${esc(work.sub)}</span>` : '') +
      (time ? `<span class="wk-c">${time}</span>` : '')
    // One frame hidden, so the fade in has something to start from.
    if (fresh) requestAnimationFrame(() => node.classList.add('is-on'))
    else node.classList.add('is-on')
  }

  // ── orb: v pokoji statický (žiadne zápisy), pri reči a počúvaní pulzuje s hlasitosťou ──
  function renderOrb(state, level, T) {
    const active = state === 'speaking' || state === 'listening' || state === 'wake'
    const v = active ? clamp(level) : 0
    const coreScale = active && state !== 'wake' ? (1 + 0.16 * v).toFixed(2) : '1'
    if (orb._cs !== coreScale) {
      orb._cs = coreScale
      if (coreScale === '1') orb.core.removeAttribute('transform')
      else orb.core.setAttribute('transform', `translate(24 24) scale(${coreScale}) translate(-24 -24)`)
    }
    orb.waves.forEach((w, i) => {
      let s = 1
      let o = 0
      if (state === 'listening' || state === 'speaking') {
        const ph = (T * (state === 'listening' ? 0.9 : 0.6) + i * 0.5) % 1
        s = 0.72 + ph * 0.55
        o = (1 - ph) * (0.25 + 0.75 * v) * 0.8
      } else if (state === 'wake') {
        const ph = (T * 0.35 + i * 0.5) % 1
        s = 0.8 + ph * 0.4
        o = (1 - ph) * 0.25
      }
      const key = o < 0.01 ? 'off' : `${s.toFixed(2)}|${o.toFixed(2)}`
      if (w._k !== key) {
        w._k = key
        w.style.transform = key === 'off' ? '' : `scale(${s.toFixed(2)})`
        w.style.opacity = key === 'off' ? '0' : o.toFixed(2)
      }
    })
    const ringOp = active ? '0.8' : '0.45'
    if (orb._ro !== ringOp) orb.ring.style.opacity = orb._ro = ringOp
    const lvl = state === 'speaking' ? (Math.round(v * 20) / 20).toFixed(2) : '0'
    if (orb._lvl !== lvl) el.cmd.style.setProperty('--lvl', (orb._lvl = lvl))
  }

  // ── vlny: hlas Jarvisa nad riadkom, mikrofón v riadku ──
  const waveCtx = el.wave.getContext('2d')
  const micCtx = el.cmdWave.getContext('2d')
  let waveSize = { w: 0, h: 0, dpr: 1 }
  let micSize = { w: 0, h: 0, dpr: 1 }
  const micHistory = new Float32Array(72)
  function sizeCanvases() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    for (const [canvas, setSize] of [
      [el.wave, (s) => (waveSize = s)],
      [el.cmdWave, (s) => (micSize = s)],
    ]) {
      const rect = canvas.getBoundingClientRect()
      setSize({ w: rect.width, h: rect.height, dpr })
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
    }
    cache.delete('ph')
    waveIdle = false
    micDrawn = true
    // Nová veľkosť okna: prepočítaj minútové veci (karty, os) pri ďalšej snímke.
    cache.delete('minute')
  }

  /** Hlas Jarvisa nad riadkom. Kreslí sa len počas reči, v pokoji ostane jedna statická čiara. */
  let waveIdle = false
  let waveGrad = null
  function renderWave(wave, level, T) {
    const { w, h, dpr } = waveSize
    if (!w) return
    const idle = !wave && level < 0.004
    if (idle && waveIdle) return
    waveIdle = idle
    const ctx = waveCtx
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (!waveGrad || waveGrad._w !== w) {
      waveGrad = ctx.createLinearGradient(0, 0, w, 0)
      waveGrad.addColorStop(0, 'rgba(127,243,255,0)')
      waveGrad.addColorStop(0.2, 'rgba(127,243,255,0.95)')
      waveGrad.addColorStop(0.8, 'rgba(127,243,255,0.95)')
      waveGrad.addColorStop(1, 'rgba(127,243,255,0)')
      waveGrad._w = w
    }
    const mid = h / 2
    const n = wave?.length ?? 0
    const pts = idle ? 2 : 120
    ctx.beginPath()
    for (let i = 0; i <= pts; i++) {
      const u = i / pts
      const env = Math.sin(Math.PI * u)
      const sample = n ? wave[Math.floor(u * (n - 1))] : 0
      const y = mid - sample * 0.9 * env * (h * 0.46)
      if (i === 0) ctx.moveTo(u * w, y)
      else ctx.lineTo(u * w, y)
    }
    ctx.strokeStyle = waveGrad
    ctx.globalAlpha = idle ? 0.28 : 0.4 + 0.6 * clamp(level * 1.6)
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.globalAlpha = 1
    void T
  }

  /** Živá vlna mikrofónu: história hlasitosti ako stĺpce, kreslí sa len počas počúvania. */
  let micDrawn = false
  function renderMicWave(level, active, T) {
    const { w, h, dpr } = micSize
    if (!w) return
    if (!active) {
      if (micDrawn) {
        micCtx.setTransform(1, 0, 0, 1, 0, 0)
        micCtx.clearRect(0, 0, micCtx.canvas.width, micCtx.canvas.height)
        micHistory.fill(0)
        micDrawn = false
      }
      return
    }
    micDrawn = true
    micHistory.copyWithin(0, 1)
    micHistory[micHistory.length - 1] = clamp(level)
    const ctx = micCtx
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const n = micHistory.length
    const gap = w / n
    const bw = Math.max(2, gap * 0.42)
    const mid = h / 2
    ctx.fillStyle = '#7ff3ff'
    for (let i = 0; i < n; i++) {
      const idle = 0.05 + 0.03 * Math.sin(i * 0.7 + T * 3)
      const amp = Math.max(idle, micHistory[i]) * (h * 0.46)
      ctx.globalAlpha = 0.25 + 0.75 * Math.pow(i / n, 0.6)
      ctx.beginPath()
      ctx.roundRect(i * gap + (gap - bw) / 2, mid - amp, bw, amp * 2, bw / 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }

  // ── toast ──
  let toastTimer = null
  function toast(html, { kind = 'info', ms = 4200, iconName = 'info' } = {}) {
    if (capture || (html && document.hidden)) return
    clearTimeout(toastTimer)
    if (!html) {
      el.toast.hidden = true
      return
    }
    el.toast.className = `toast${kind === 'warn' ? ' is-warn' : ''}`
    el.toast.innerHTML = `${icon(iconName)}<span>${html}</span>`
    el.toast.hidden = false
    if (ms) toastTimer = setTimeout(() => (el.toast.hidden = true), ms)
  }

  return {
    setSnapshot,
    renderClock,
    renderState,
    renderStatus,
    renderJobsChip,
    renderLog,
    renderLabels,
    renderSubtitle,
    renderPlaceholder,
    renderLive,
    renderPromptCue,
    renderKeys,
    renderOrb,
    renderWork,
    renderWave,
    renderMicWave,
    sizeCanvases,
    toast,
    el,
  }
}
