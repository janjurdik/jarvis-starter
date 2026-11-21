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
/** One row of a section: what it is on the left (with an optional line of explanation), the control on the right. */
const row = (label, control, hint = '', cls = '') => `<div class="st-r${cls ? ` ${cls}` : ''}"><div class="st-rl"><b>${label}</b>${hint ? `<em>${hint}</em>` : ''}</div><div class="st-rc">${control}</div></div>`
const toggle = (attr, on, { disabled = false } = {}) => `<label class="st-switch${disabled ? ' is-off' : ''}"><input type="checkbox" ${attr} ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''}><i></i></label>`

/** The sections, in the order of the menu. `plocha` is added for the Mac, where Jarvis can live on the desktop. */
const TABS = [
  ['asistent', 'jarvis', 'Asistent'],
  ['vy', 'person', 'Vy'],
  ['hlas', 'speaker', 'Hlas'],
  ['pocuvanie', 'mic', 'Počúvanie'],
  ['mozog', 'model', 'Mozog'],
  ['pokoj', 'spanok', 'Pokoj'],
  ['hovory', 'phone', 'Telefonáty'],
  ['plocha', 'app', 'Plocha'],
]

export function createSettings({ onToast = () => {} } = {}) {
  injectCss()
  const desk = () => window.__jarvisDesktop ?? null
  const root = document.createElement('div')
  root.className = 'st'
  root.hidden = true
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', 'Nastavenia')
  root.innerHTML = `<div class="st-sheet">
    <header class="st-head"><h2>Nastavenia</h2><span class="st-saved" aria-live="polite"></span><button type="button" class="st-x" aria-label="Zavrieť">Zavrieť<kbd>Esc</kbd></button></header>
    <div class="st-main"><nav class="st-nav" aria-label="Časti nastavení"></nav><div class="st-body"></div></div></div>`
  document.body.append(root)
  const body = root.querySelector('.st-body')
  const nav = root.querySelector('.st-nav')
  const savedEl = root.querySelector('.st-saved')

  let data = null
  let open = false
  let tab = 'asistent'
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
  function sections(d) {
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
        : `Whisper beží v tomto počítači${stt.model ? `, model ${esc(stt.model)}` : ''}. Nič z toho, čo poviete, neodchádza von.`
    const alarm = d.alarm?.enabled ? `Budík zvoní o ${esc(d.alarm.time)}.` : 'Budík je vypnutý.'
    const call = d.call ?? { ready: false, has: {}, from: null, to: null }
    const input = (attr, value, placeholder, { type = 'text', max = 60 } = {}) => `<input class="st-in" type="${type}" ${attr} ${type === 'text' ? `maxlength="${max}"` : ''} value="${esc(value ?? '')}" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off">`
    const r = d.brain?.routing ?? { mode: 'auto' }
    const routeHint = r.locked
      ? `Model drží súbor .env (JARVIS_JOB_MODEL): všetko robím na ${esc(r.fixed)}.`
      : r.mode === 'heavy'
        ? 'Každú úlohu robím najsilnejším modelom. Najlepší výsledok, najviac to míňa z predplatného.'
        : r.mode === 'light'
          ? 'Každú úlohu robím najrýchlejším modelom. Šetrí predplatné, na zložité veci je slabší.'
          : r.models
            ? `Pred každou úlohou poviem, aká je. Ľahké veci (pozrieť poštu, kalendár) robím na ${esc(r.light ?? 'rýchlom modeli')}, ${r.normal ? `bežné na ${esc(r.normal)} ` : ''}a tvorbu či dlhú prácu na ${esc(r.heavy ?? 'najsilnejšom modeli')}.`
            : 'Pred každou úlohou poviem, aká je. Pri ľahkých veciach premýšľam krátko, pri náročných dôkladne.'
    const native = desk()?.native && desk().version >= 2
    const prefs = desk()?.prefs ?? {}
    const mac = d.platform === 'darwin'
    const onDesk = d.surface !== 'web'

    return {
      asistent: `<h3>Asistent</h3><p class="st-lead">Kto s vami hovorí. To isté stačí povedať: „volaj sa Friday", „hovor ženským hlasom".</p>
        ${row('Kto to je', seg('gender', [['male', 'Muž'], ['female', 'Žena']], female ? 'female' : 'male'), female ? 'Komorníčka. Hovorí o sebe v ženskom rode.' : 'Komorník. Hovorí o sebe v mužskom rode.')}
        ${row('Meno', input('data-text="assistant.name"', d.assistant.name, 'Jarvis', { max: 24 }))}
        ${row('Jazyk', seg('language', [['sk', 'Slovenčina'], ['cs', 'Čeština']], lang, { disabled: d.languageLocked }), d.languageLocked ? 'Jazyk drží súbor .env (JARVIS_LANG).' : 'Ktorým hovorím a ktorému rozumiem.')}`,

      vy: `<h3>Vy</h3><p class="st-lead">Ako vás volám a čo o vás potrebujem vedieť.</p>
        ${row('Meno', input('data-text="user.name"', d.user.name, 'Ako sa voláte'))}
        ${row('Oslovenie', `<div class="st-chips" data-chips="address">${presets.map((p) => `<button type="button" data-value="${esc(p)}" aria-pressed="${addr === p}">${esc(p)}</button>`).join('')}<button type="button" data-value="" aria-pressed="${addr === ''}">žiadne</button></div>${input('data-text="user.address"', custom ? addr : '', 'alebo vlastné', { max: 40 })}`, '', 'is-tall')}
        ${row('Ako s vami hovorím', seg('formal', [['true', 'Vykám'], ['false', 'Tykám']], String(d.user.formal)))}
        ${row('Mesto', input('data-text="user.city"', d.user.city, 'napríklad Bratislava'), 'Kvôli počasiu.')}
        ${row('Narodeniny', `<input class="st-in" type="date" data-date="user.birthday" value="${/^\d{4}-/.test(d.user.birthday ?? '') ? esc(d.user.birthday) : ''}">`, 'V ten deň sa ozvem sám.')}`,

      hlas: `<h3>Hlas</h3><p class="st-lead">${edge ? 'Klik na meno hlas vyberie, trojuholník ho prehrá.' : 'Prirodzené hlasy potrebujú program uv a internet. Teraz hovorí náhradný hlas počítača.'}</p>
        <div class="st-voice-list" role="radiogroup" aria-label="Hlas">${voices
          .map(
            (v) =>
              `<div class="st-voice${v.id === d.voice.id ? ' is-on' : ''}" data-voice="${esc(v.id)}"><button type="button" class="st-play" aria-label="Prehrať ukážku: ${esc(v.label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="st-tri" d="M9 6.8v10.4l8.4-5.2Z"/><g class="st-eq"><path d="M7 9v6M12 6v12M17 10v4"/></g></svg></button><button type="button" class="st-pick" role="radio" aria-checked="${v.id === d.voice.id}"><b>${esc(v.label)}</b><em>${v.lang === 'sk' ? 'slovenčina' : v.lang === 'cs' ? 'čeština' : 'viac jazykov'}</em></button><i class="st-tick" aria-hidden="true"></i></div>`,
          )
          .join('')}</div>
        ${row('Tempo', `<label class="st-range"><input type="range" data-range="rate" min="-20" max="40" step="2" value="${num(d.voice.rate, '%')}"><output>${esc(signed(num(d.voice.rate, '%'), ' %'))}</output></label>`)}
        ${row('Výška', `<label class="st-range"><input type="range" data-range="pitch" min="-20" max="20" step="1" value="${num(d.voice.pitch, 'Hz')}"><output>${esc(signed(num(d.voice.pitch, 'Hz'), ' Hz'))}</output></label>`)}`,

      pocuvanie: `<h3>Počúvanie</h3><p class="st-lead">Podržte medzerník a hovorte. Mikrofón si beriem len vtedy a hneď ho vraciam, takže hovor v inej appke ostáva nerušený.</p>
        ${row('Rozpoznávanie reči', seg('stt', [['auto', 'Automaticky'], ['whisper', 'Whisper'], ['browser', 'Prehliadač']], stt.choice ?? 'auto', { disabled: stt.locked }), `<span class="${prep ? 'is-busy' : ''}">${sttLine}</span>${stt.locked ? ' Voľbu drží súbor .env (JARVIS_STT).' : ''}${prep && Number.isFinite(prep.pct) ? `<span class="st-progress"><i style="width:${Math.max(2, Math.min(100, prep.pct))}%"></i></span>` : ''}`, 'is-tall')}
        ${row('Hey Jarvis', toggle('data-toggle="wake"', d.wake.on, { disabled: !d.wake.available }), d.wake.available ? 'Stačí ma osloviť, netreba držať medzerník. Mikrofón je vtedy zapnutý stále, zvuk ostáva v počítači.' : 'Potrebuje Whisper v počítači.')}`,

      mozog: `<h3>Mozog</h3><p class="st-lead">Nemám vlastný model. Myslím cez predplatné, ktoré už máte.</p>
        ${row('Bežím na', `<span class="st-val">${esc(d.brain?.name ?? 'Claude')}</span>`, esc(d.brain?.plan ? `${d.brain.product}, ${d.brain.plan}.` : ''))}
        ${row('Model podľa úlohy', seg('routing', [['auto', 'Automaticky'], ['heavy', 'Najsilnejší'], ['light', 'Najrýchlejší']], r.mode, { disabled: r.locked }), routeHint, 'is-tall')}`,

      pokoj: `<h3>Pokoj</h3><p class="st-lead">Kedy mám byť ticho.</p>
        ${row('Tiché hodiny', toggle('data-toggle="quiet"', quietOn), 'Vtedy sám od seba nehovorím nahlas.')}
        ${row('Od', `<input class="st-in is-time" type="time" data-time="from" value="${esc(q1)}" ${quietOn ? '' : 'disabled'}>`, '', quietOn ? '' : 'is-dim')}
        ${row('Do', `<input class="st-in is-time" type="time" data-time="to" value="${esc(q2)}" ${quietOn ? '' : 'disabled'}>`, '', quietOn ? '' : 'is-dim')}
        <p class="st-note">${alarm} Stačí povedať „zobuď ma o šiestej" alebo mi pretiahnuť skladbu, ktorou vás mám budiť.</p>`,

      hovory: `<h3>Telefonáty</h3><p class="st-lead">${call.ready ? `Keď je niečo súrne a nie ste pri počítači, zavolám vám na ${esc(call.to ?? 'mobil')}.` : 'Viem vám zavolať na mobil cez Twilio (twilio.com). Stačia štyri údaje z vášho účtu, ostanú v tomto počítači.'}</p>
        ${row('Account SID', `<input class="st-in" type="text" data-call="sid" placeholder="${call.has.sid ? 'uložené' : 'AC…'}" spellcheck="false" autocomplete="off">`)}
        ${row('Auth Token', `<input class="st-in" type="password" data-call="token" placeholder="${call.has.token ? 'uložené' : 'z konzoly Twilia'}" spellcheck="false" autocomplete="off">`)}
        ${row('Číslo v Twiliu', `<input class="st-in" type="tel" data-call="from" placeholder="${call.from ? esc(call.from) : '+1…'}" spellcheck="false" autocomplete="off">`)}
        ${row('Váš mobil', `<input class="st-in" type="tel" data-call="to" placeholder="${call.to ? esc(call.to) : '+421…'}" spellcheck="false" autocomplete="off">`)}
        <div class="st-acts"><button type="button" class="st-btn" data-call-save>Uložiť</button><button type="button" class="st-btn is-quiet" data-call-test ${call.ready ? '' : 'disabled'}>Zavolať na skúšku</button><span class="st-call-msg" role="status"></span></div>`,

      plocha: mac
        ? `<h3>Plocha</h3><p class="st-lead">${onDesk ? 'Žijem na vašej ploche namiesto tapety, pod oknami. Keď všetko zavriete, som tam.' : 'Bežím v okne prehliadača. Na ploche namiesto tapety by som bol stále poruke.'}</p>
        ${row('Kde ma máte', seg('surface', [['desktop', 'Na ploche'], ['web', 'V okne']], onDesk ? 'desktop' : 'web'), 'Zmena platí od ďalšieho spustenia.')}
        ${native ? row('Ikony na ploche', toggle('data-desk="icons"', prefs.icons !== false), 'Keď ich skryjem, plocha patrí len mne. Súbory ostávajú v priečinku Plocha.') : ''}
        ${native ? row('Spúšťať po zapnutí počítača', toggle('data-desk="login"', prefs.login === true), 'Som tu hneď po prihlásení.') : ''}
        ${native ? row('Ukázať ma nad oknami', `<span class="st-val"><kbd>${esc(desk().hotkeyLabel ?? '⌃⌥J')}</kbd></span>`, 'Skratka ma vytiahne navrch, Esc ma vráti späť pod okná.') : ''}
        <p class="st-note">${native ? 'V lište úplne hore vpravo je môj krúžok. Cez neho ma vyvoláte, načítate znova alebo vypnete a vrátite si pôvodnú plochu.' : 'Na plochu ma položí príkaz sh hud/desktop/build.sh --open v priečinku Jarvisa, alebo to povedzte AI, ktorá má ten priečinok otvorený.'}</p>`
        : `<h3>Plocha</h3><p class="st-lead">Bežím v okne na celú obrazovku. F11 ho prepne na okno a späť.</p>
        <p class="st-note">Zapínam sa sám po prihlásení do počítača. Vypnúť to vie príkaz node scripts/autostart.mjs remove v priečinku Jarvisa.</p>`,
    }
  }

  function render() {
    if (!data) return
    const html = sections(data)
    nav.innerHTML = TABS.map(([id, ic, label]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${id === tab}">${icon(ic)}<span>${label}</span></button>`).join('')
    body.innerHTML = `<section class="st-sec" data-sec="${tab}">${html[tab] ?? html.asistent}</section>`
  }

  /** New values from the server (after a save, or because Jarvis changed something himself). */
  function apply(next) {
    if (!next?.assistant) return
    // Do not redraw under the user's fingers: a field being typed in keeps its text.
    const active = document.activeElement
    const typing = open && body.contains(active) && active.matches('input[type="text"], input[type="range"], input[type="time"], input[type="tel"], input[type="password"], input[type="date"]')
    data = next
    if (!open) return
    if (!typing) return render()
    const prog = body.querySelector('.st-progress i')
    if (prog && Number.isFinite(next.stt?.prepare?.pct)) prog.style.width = `${next.stt.prepare.pct}%`
  }

  // ── input ──
  body.addEventListener('click', (e) => {
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
      if (segBtn.getAttribute('aria-checked') === 'true') return
      if (name === 'gender') {
        stopSample()
        // A new gender brings its own default voice: the chosen voice is cleared so the server picks it.
        return save({ assistant: { gender: v }, voice: { id: null } })
      }
      if (name === 'routing') return save({ routing: v })
      if (name === 'surface') return save({ surface: v })
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
    if (t.dataset.date === 'user.birthday') return save({ user: { birthday: t.value || null } })
    if (t.dataset.toggle === 'wake') return save({ wake: t.checked })
    // The two switches of the menu bar icon: the desktop app flips them and reports back.
    if (t.dataset.desk) return desk()?.setPref?.(t.dataset.desk, t.checked)
    if (t.dataset.toggle === 'quiet' || t.dataset.time) {
      const on = body.querySelector('[data-toggle="quiet"]').checked
      const from = body.querySelector('[data-time="from"]').value || '22:30'
      const to = body.querySelector('[data-time="to"]').value || '07:00'
      return save({ quiet: on ? `${from}-${to}` : '' })
    }
  })
  // Phone calls: the four values are sent once and never come back to the page.
  body.addEventListener('click', async (e) => {
    const saveBtn = e.target.closest('[data-call-save]')
    const testBtn = e.target.closest('[data-call-test]')
    if (!saveBtn && !testBtn) return
    const msg = body.querySelector('.st-call-msg')
    const post = async (path, payload) => {
      const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      const out = await res.json().catch(() => ({}))
      if (!res.ok || out.ok === false) throw new Error(out.error || 'Nepodarilo sa.')
      return out
    }
    try {
      if (saveBtn) {
        const payload = {}
        for (const input of body.querySelectorAll('[data-call]')) if (input.value.trim()) payload[input.dataset.call] = input.value.trim()
        if (!Object.keys(payload).length) return (msg.textContent = 'Vyplňte aspoň jedno pole.')
        msg.textContent = 'Ukladám…'
        await post('/api/settings/call', payload)
        await load()
        body.querySelector('.st-call-msg').textContent = 'Uložené.'
      } else {
        msg.textContent = 'Volám…'
        await post('/api/settings/call/test', {})
        msg.textContent = 'Telefón by mal o chvíľu zvoniť.'
      }
    } catch (err) {
      msg.textContent = err.message
    }
  })
  // Typing in the sheet must not reach the HUD shortcuts (space is push-to-talk there).
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      return close()
    }
    if (e.target.matches('input')) e.stopPropagation()
    if (e.code === 'Space') e.stopPropagation()
  })
  root.addEventListener('keyup', (e) => e.stopPropagation())
  root.addEventListener('pointerdown', (e) => {
    if (e.target === root) close()
  })
  root.querySelector('.st-x').addEventListener('click', () => close())
  nav.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]')
    if (!b || b.dataset.tab === tab) return
    stopSample()
    tab = b.dataset.tab
    render()
    body.scrollTop = 0
  })
  // The desktop app: its menu opens this sheet, and its two switches are mirrored here.
  window.addEventListener('jarvis-desktop', (e) => {
    if (e.detail?.type === 'settings') openSheet('plocha')
    if (e.detail?.type === 'prefs' && open && tab === 'plocha') render()
  })

  function openSheet(section) {
    if (typeof section === 'string' && TABS.some(([id]) => id === section)) tab = section
    if (open) return render()
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
