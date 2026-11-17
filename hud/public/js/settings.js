// Nastavenia: one sheet over the world where the user shapes their Jarvis. Who the assistant is
// (a man or a woman, the name), the voice with a spoken sample, how the user is addressed, how
// Jarvis listens (local Whisper or the browser), quiet hours and the language.
// Every change is saved at once (POST /api/settings) and applies without a restart; the same
// settings change when the user simply tells Jarvis ("hovor ženským hlasom"), the sheet follows
// over SSE `settings`.
//
//   const settings = createSettings({ onToast })
//   settings.open()   settings.close()   settings.apply(body)   settings.isOpen()

import { icon } from './icons.js'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const num = (v, unit) => Number(String(v ?? '0').replace(unit, '')) || 0
const signed = (n, unit) => `${n >= 0 ? '+' : ''}${n}${unit}`

function injectCss() {
  if (document.getElementById('settings-css')) return
  const link = document.createElement('link')
  link.id = 'settings-css'
  link.rel = 'stylesheet'
  link.href = '/css/settings.css'
  document.head.append(link)
}

const seg = (name, options, value, { disabled = false } = {}) =>
  `<div class="st-seg" role="radiogroup" data-seg="${name}">${options
    .map(([v, label]) => `<button type="button" role="radio" aria-checked="${String(v) === String(value)}" data-value="${esc(v)}"${disabled ? ' disabled' : ''}>${esc(label)}</button>`)
    .join('')}</div>`

export function createSettings({ onToast = () => {} } = {}) {
  injectCss()
  const root = document.createElement('div')
  root.className = 'st'
  root.hidden = true
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', 'Nastavenia')
  root.innerHTML = `<div class="st-sheet"><i class="st-corner tl"></i><i class="st-corner tr"></i><i class="st-corner bl"></i><i class="st-corner br"></i>
    <header class="st-head"><div><h2>Nastavenia</h2><p class="st-lead">Zmeny platia hneď. To isté stačí Jarvisovi povedať.</p></div><span class="st-saved" aria-live="polite"></span><button type="button" class="st-x" aria-label="Zavrieť">×</button></header>
    <div class="st-body"></div></div>`
  document.body.append(root)
  const body = root.querySelector('.st-body')
  const savedEl = root.querySelector('.st-saved')

  let data = null
  let open = false
  let audio = null
  let playing = null
  let savedTimer = 0
  const timers = new Map()

  // ── server ──
  async function load() {
    try {
      const res = await fetch('/api/settings', { cache: 'no-store' })
      const json = await res.json()
      if (json?.ok) apply(json)
    } catch {
      body.innerHTML = '<p class="st-error">Nastavenia sa nepodarilo načítať. Beží Jarvis?</p>'
    }
  }

  function flashSaved(text = 'Uložené') {
    savedEl.textContent = text
    savedEl.classList.add('is-on')
    clearTimeout(savedTimer)
    savedTimer = setTimeout(() => savedEl.classList.remove('is-on'), 1600)
  }

  async function save(patch) {
    try {
      const res = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
      const json = await res.json()
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? `chyba ${res.status}`)
      flashSaved()
      if (json.assistant) apply(json)
      else load()
    } catch (err) {
      onToast(`Nastavenie sa neuložilo: ${err.message}`)
      load()
    }
  }

  /** Text fields and sliders save a moment after the last change, not on every keystroke. */
  function later(key, patch, ms = 500) {
    clearTimeout(timers.get(key)?.timer)
    timers.set(key, {
      patch,
      timer: setTimeout(() => {
        timers.delete(key)
        save(patch)
      }, ms),
    })
  }

  // ── the voice sample ──
  function stopSample() {
    audio?.pause()
    audio = null
    playing = null
    for (const b of body.querySelectorAll('.st-voice.is-playing')) b.classList.remove('is-playing', 'is-loading')
  }

  async function sample(id, row) {
    if (playing === id) return stopSample()
    stopSample()
    playing = id
    row.classList.add('is-playing', 'is-loading')
    try {
      const rate = body.querySelector('[data-range="rate"]')
      const pitch = body.querySelector('[data-range="pitch"]')
      const res = await fetch('/api/settings/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voice: id, ...(rate ? { rate: signed(Number(rate.value), '%') } : {}), ...(pitch ? { pitch: signed(Number(pitch.value), 'Hz') } : {}) }),
      })
      const json = await res.json()
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? 'ukážka nie je k dispozícii')
      if (playing !== id) return
      row.classList.remove('is-loading')
      audio = new Audio(json.url)
      audio.addEventListener('ended', stopSample)
      audio.addEventListener('error', stopSample)
      await audio.play()
    } catch (err) {
      stopSample()
      onToast(err.message)
    }
  }

  // ── drawing ──
  function render() {
    if (!data) return
    const d = data
    const female = d.assistant.gender === 'female'
    const lang = d.language === 'cs' ? 'cs' : 'sk'
    // Voices of the chosen gender: the user's language first, then the multilingual ones.
    const voices = d.voices.filter((v) => v.gender === d.assistant.gender).sort((a, b) => (a.lang === lang ? 0 : a.lang === 'multi' ? 1 : 2) - (b.lang === lang ? 0 : b.lang === 'multi' ? 1 : 2))
    const edge = d.voice.provider === 'edge'
    const addr = d.user.address ?? ''
    const first = (d.user.name ?? '').trim().split(/\s+/)[0] ?? ''
    const presets = [...new Set(['pane', 'pani', 'šéfe', 'šéfka', first].filter(Boolean))]
    const custom = addr && !presets.includes(addr)
    const quietOn = Boolean(d.quiet)
    const [q1, q2] = quietOn ? d.quiet.split('-') : ['22:30', '07:00']
    const stt = d.stt
    const prep = stt.prepare
    const sttLine = prep
      ? `${esc(prep.text || 'Pripravujem rozpoznávanie reči')}${Number.isFinite(prep.pct) ? ` · ${Math.round(prep.pct)} %` : ''}`
      : stt.engine === 'browser'
        ? `Reč teraz rozpoznáva prehliadač.${stt.plan?.reason ? ` ${esc(stt.plan.reason)}` : ''}`
        : `Whisper beží v tomto počítači${stt.model ? ` · model ${esc(stt.model)}` : ''}${stt.plan?.sizeMb ? ` · ${stt.plan.sizeMb >= 1000 ? `${(stt.plan.sizeMb / 1000).toFixed(1).replace('.', ',')} GB` : `${stt.plan.sizeMb} MB`}` : ''}. Nič z toho, čo poviete, neodchádza von.`
    const alarm = d.alarm?.enabled ? `Budík zvoní o ${esc(d.alarm.time)}.` : 'Budík je vypnutý.'

    body.innerHTML = `
      <section class="st-sec st-who">
        <h3>${icon('jarvis')}Váš asistent</h3>
        <div class="st-pair">
          <button type="button" class="st-persona${female ? '' : ' is-on'}" data-gender="male" aria-pressed="${!female}"><span class="st-face is-m" aria-hidden="true"><i></i><i></i><i></i></span><b>Muž</b><em>komorník</em></button>
          <button type="button" class="st-persona${female ? ' is-on' : ''}" data-gender="female" aria-pressed="${female}"><span class="st-face is-f" aria-hidden="true"><i></i><i></i><i></i></span><b>Žena</b><em>komorníčka</em></button>
        </div>
        <label class="st-field"><span>Meno</span><input type="text" data-text="assistant.name" maxlength="24" value="${esc(d.assistant.name)}" placeholder="Jarvis" spellcheck="false" autocomplete="off"></label>
      </section>

      <section class="st-sec st-voices">
        <h3>${icon('speaker')}Hlas</h3>
        ${edge ? '' : '<p class="st-note is-warn">Prirodzené hlasy potrebujú program uv a internet. Teraz hovorí náhradný hlas počítača.</p>'}
        <div class="st-voice-list" role="radiogroup" aria-label="Hlas">${voices
          .map(
            (v) =>
              `<div class="st-voice${v.id === d.voice.id ? ' is-on' : ''}" data-voice="${esc(v.id)}"><button type="button" class="st-play" aria-label="Prehrať ukážku: ${esc(v.label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="st-tri" d="M9 6.8v10.4l8.4-5.2Z"/><g class="st-eq"><path d="M7 9v6M12 6v12M17 10v4"/></g></svg></button><button type="button" class="st-pick" role="radio" aria-checked="${v.id === d.voice.id}"><b>${esc(v.label)}</b><em>${v.lang === 'sk' ? 'slovenčina' : v.lang === 'cs' ? 'čeština' : 'hovorí viac jazykmi'}</em></button></div>`,
          )
          .join('')}</div>
        <div class="st-ranges">
          <label class="st-range"><span>Tempo</span><input type="range" data-range="rate" min="-20" max="40" step="2" value="${num(d.voice.rate, '%')}"><output>${esc(signed(num(d.voice.rate, '%'), ' %'))}</output></label>
          <label class="st-range"><span>Výška</span><input type="range" data-range="pitch" min="-20" max="20" step="1" value="${num(d.voice.pitch, 'Hz')}"><output>${esc(signed(num(d.voice.pitch, 'Hz'), ' Hz'))}</output></label>
        </div>
      </section>

      <section class="st-sec">
        <h3>${icon('person')}Vy</h3>
        <label class="st-field"><span>Meno</span><input type="text" data-text="user.name" maxlength="60" value="${esc(d.user.name)}" placeholder="Ako sa voláte" spellcheck="false" autocomplete="off"></label>
        <div class="st-field"><span>Oslovenie</span>
          <div class="st-chips" data-chips="address">${presets.map((p) => `<button type="button" data-value="${esc(p)}" aria-pressed="${addr === p}">${esc(p)}</button>`).join('')}<button type="button" data-value="" aria-pressed="${addr === ''}">bez oslovenia</button></div>
          <input type="text" class="st-inline" data-text="user.address" maxlength="40" value="${custom ? esc(addr) : ''}" placeholder="alebo vlastné" spellcheck="false" autocomplete="off">
        </div>
        <div class="st-field"><span>Ako s vami hovorí</span>${seg('formal', [['true', 'Vyká'], ['false', 'Tyká']], String(d.user.formal))}</div>
        <label class="st-field"><span>Mesto</span><input type="text" data-text="user.city" maxlength="60" value="${esc(d.user.city)}" placeholder="kvôli počasiu" spellcheck="false" autocomplete="off"></label>
      </section>

      <section class="st-sec">
        <h3>${icon('mic')}Počúvanie</h3>
        <div class="st-field"><span>Rozpoznávanie reči</span>${seg('stt', [['auto', 'Automaticky'], ['whisper', 'Whisper'], ['browser', 'Prehliadač']], stt.choice ?? 'auto', { disabled: stt.locked })}</div>
        <p class="st-note${prep ? ' is-busy' : ''}">${sttLine}${stt.locked ? ' Voľbu drží súbor .env (JARVIS_STT).' : ''}</p>
        ${prep && Number.isFinite(prep.pct) ? `<div class="st-progress"><i style="width:${Math.max(2, Math.min(100, prep.pct))}%"></i></div>` : ''}
        <label class="st-switch${d.wake.available ? '' : ' is-off'}"><input type="checkbox" data-toggle="wake" ${d.wake.on ? 'checked' : ''} ${d.wake.available ? '' : 'disabled'}><i></i><span><b>Hey Jarvis</b><em>${d.wake.available ? 'Stačí ho osloviť, netreba držať medzerník.' : 'Potrebuje Whisper v počítači.'}</em></span></label>
        <div class="st-field"><span>Jazyk</span>${seg('language', [['sk', 'Slovenčina'], ['cs', 'Čeština']], lang, { disabled: d.languageLocked })}</div>
      </section>

      <section class="st-sec st-quiet">
        <h3>${icon('spanok')}Pokoj</h3>
        <label class="st-switch"><input type="checkbox" data-toggle="quiet" ${quietOn ? 'checked' : ''}><i></i><span><b>Tiché hodiny</b><em>Vtedy sám od seba nehovorím nahlas.</em></span></label>
        <div class="st-times${quietOn ? '' : ' is-off'}"><label>od<input type="time" data-time="from" value="${esc(q1)}" ${quietOn ? '' : 'disabled'}></label><label>do<input type="time" data-time="to" value="${esc(q2)}" ${quietOn ? '' : 'disabled'}></label></div>
        <p class="st-note">${alarm} Stačí povedať „zobuď ma o šiestej" alebo mi pretiahnuť skladbu, ktorou vás mám budiť.</p>
      </section>`
  }

  /** New values from the server (after a save, or because Jarvis changed something himself). */
  function apply(next) {
    if (!next?.assistant) return
    // Do not redraw under the user's fingers: a field being typed in keeps its text.
    const active = document.activeElement
    const typing = open && body.contains(active) && (active.matches('input[type="text"]') || active.matches('input[type="range"]') || active.matches('input[type="time"]'))
    data = next
    if (!open) return
    if (!typing) return render()
    const prog = body.querySelector('.st-progress i')
    if (prog && Number.isFinite(next.stt?.prepare?.pct)) prog.style.width = `${next.stt.prepare.pct}%`
  }

  // ── input ──
  body.addEventListener('click', (e) => {
    const persona = e.target.closest('.st-persona')
    if (persona) {
      if (persona.dataset.gender === data.assistant.gender) return
      stopSample()
      // A new gender brings its own default voice: the chosen voice is cleared so the server picks it.
      return save({ assistant: { gender: persona.dataset.gender }, voice: { id: null } })
    }
    const play = e.target.closest('.st-play')
    if (play) {
      const row = play.closest('.st-voice')
      return sample(row.dataset.voice, row)
    }
    const pick = e.target.closest('.st-pick')
    if (pick) {
      const row = pick.closest('.st-voice')
      if (row.dataset.voice === data.voice.id) return sample(row.dataset.voice, row)
      save({ voice: { id: row.dataset.voice } })
      return sample(row.dataset.voice, row)
    }
    const chip = e.target.closest('[data-chips="address"] button')
    if (chip) return save({ user: { address: chip.dataset.value } })
    const segBtn = e.target.closest('.st-seg button')
    if (segBtn && !segBtn.disabled) {
      const name = segBtn.parentElement.dataset.seg
      const v = segBtn.dataset.value
      if (name === 'formal') return save({ user: { formal: v === 'true' } })
      if (name === 'stt') return save({ stt: v })
      if (name === 'language') return save({ language: v })
    }
  })
  body.addEventListener('input', (e) => {
    const t = e.target
    if (t.dataset.text) {
      const [scope, key] = t.dataset.text.split('.')
      const value = t.value.replace(/\s+/g, ' ').trim()
      // Names may not be empty (the address may: "bez oslovenia").
      if (!value && t.dataset.text !== 'user.address') return
      return later(t.dataset.text, { [scope]: { [key]: value } }, 700)
    }
    if (t.dataset.range) {
      const unit = t.dataset.range === 'rate' ? '%' : 'Hz'
      t.nextElementSibling.textContent = signed(Number(t.value), ` ${unit}`)
      return later(t.dataset.range, { voice: { [t.dataset.range]: signed(Number(t.value), unit) } }, 400)
    }
  })
  body.addEventListener('change', (e) => {
    const t = e.target
    if (t.dataset.toggle === 'wake') return save({ wake: t.checked })
    if (t.dataset.toggle === 'quiet' || t.dataset.time) {
      const on = body.querySelector('[data-toggle="quiet"]').checked
      const from = body.querySelector('[data-time="from"]').value || '22:30'
      const to = body.querySelector('[data-time="to"]').value || '07:00'
      return save({ quiet: on ? `${from}-${to}` : '' })
    }
  })
  // Typing in the sheet must not reach the HUD shortcuts (space is push-to-talk there).
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      return close()
    }
    if (e.target.matches('input')) e.stopPropagation()
    if (e.code === 'Space' && !e.target.matches('input[type="text"]')) e.stopPropagation()
  })
  root.addEventListener('keyup', (e) => e.stopPropagation())
  root.addEventListener('pointerdown', (e) => {
    if (e.target === root) close()
  })
  root.querySelector('.st-x').addEventListener('click', () => close())

  function openSheet() {
    if (open) return
    open = true
    root.hidden = false
    requestAnimationFrame(() => root.classList.add('is-open'))
    if (data) render()
    load()
    setTimeout(() => root.querySelector('.st-x').focus(), 60)
  }

  function close() {
    if (!open) return
    open = false
    stopSample()
    // Whatever was still waiting to be saved is saved now.
    for (const [key, t] of timers) {
      clearTimeout(t.timer)
      timers.delete(key)
      save(t.patch)
    }
    root.classList.remove('is-open')
    setTimeout(() => {
      if (!open) root.hidden = true
    }, 360)
  }

  return { open: openSheet, close, apply, isOpen: () => open }
}
