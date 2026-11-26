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
import { qrSvg } from '../m/qr.js'

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
  ['mobil', 'mobile', 'Mobil'],
]

const when = (ms) => {
  if (!ms) return ''
  const d = new Date(ms)
  const today = new Date().toDateString() === d.toDateString()
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  return today ? `dnes ${hm}` : `${d.getDate()}. ${d.getMonth() + 1}. ${hm}`
}

/**
 * Mobil: Jarvis on the phone through a Cloudflare tunnel, behind an email and a password (docs/MOBIL.md).
 * Its data comes from /api/remote/status, not from the settings body; only this computer can change it.
 */
function mobileSection(m, port) {
  if (!m) return '<h3>Mobil</h3><p class="st-lead">Načítavam…</p>'
  if (!m.local) return `<h3>Mobil</h3><p class="st-lead">Mobilný prístup sa nastavuje len priamo na počítači, kde bežím.${m.enabled ? ' Teraz je zapnutý, preto ma vidíte aj tu.' : ''}</p>`
  const t = m.tunnel ?? { state: 'off' }
  const ready = Boolean(m.email && m.hasPassword)
  const named = m.mode === 'named'
  const state = !ready
    ? 'Najprv nižšie nastavte e-mail a heslo.'
    : !m.enabled
      ? 'Vypnutý. Som dostupný len z tohto počítača.'
      : t.state === 'running'
        ? 'Zapnutý. Tunel beží a mobil sa ku mne dostane.'
        : t.state === 'error'
          ? `<span class="is-warn">Tunel nejde: ${esc(t.error ?? 'neznáma chyba')}</span>`
          : `<span class="is-busy">${t.installing ? 'Inštalujem cloudflared…' : 'Otváram tunel…'}</span>`
  const qr = m.address
    ? `<div class="st-mob"><div class="st-qr">${qrSvg(m.address, { label: 'QR kód adresy Jarvisa' })}</div><div class="st-mob-t"><b>Naskenujte ma mobilom</b><span class="st-url">${esc(m.address.replace(/^https:\/\//, '').replace(/\/$/, ''))}</span><em>Prihláste sa e-mailom a heslom a pridajte si ma na plochu: na iPhone v Safari Zdieľať a Pridať na plochu, na Androide v Chrome ponuka a Pridať na plochu.</em>${named ? '' : '<em>Táto adresa sa mení pri každom spustení tunela. Trvalú dá vlastný tunel Cloudflare.</em>'}<div class="st-acts is-flat"><button type="button" class="st-btn is-quiet" data-mob-copy="${esc(m.address)}">Kopírovať adresu</button></div></div></div>`
    : ''
  const devices = m.devices ?? []
  // Every device that ever logged in, with when it last logged in; sessions from before 1.10.1 have no known device yet.
  const known = m.known ?? []
  const rows = known.length
    ? known.map((d) => `${esc(d.device)}: naposledy prihlásené ${esc(when(d.lastLogin) || 'neznámo kedy')}${d.active ? '' : ', teraz odhlásené'}`)
    : devices.map((d) => `${esc(d.device)}: prihlásené ${esc(when(d.created) || 'neznámo kedy')}${d.seen ? `, naposledy aktívne ${esc(when(d.seen))}` : ''}`)
  const devList = rows.length ? rows.join('<br>') : 'Zatiaľ žiadne.'
  const lock = m.lock?.until ? `<p class="st-note is-warn">Prihlasovanie z nových zariadení je zatvorené do ${esc(when(m.lock.until))}: prišlo priveľa nesprávnych pokusov z rôznych adries. Zariadenia, ktoré sa už prihlásili, sa dostanú aj tak.</p>` : ''
  return `<h3>Mobil</h3><p class="st-lead">Rozhovor, hlas a úlohy aj v mobile, odkiaľkoľvek. Mobil sa ku mne pripája cez šifrovaný tunel Cloudflare a pustí len toho, kto pozná váš e-mail a heslo. Tu na počítači heslo netreba.</p>
    ${row('Mobilný prístup', toggle('data-mob-on', m.enabled, { disabled: !ready }), state, 'is-tall')}
    ${qr}
    ${row('E-mail', `<input class="st-in" type="email" data-mob="email" maxlength="200" value="${esc(m.email ?? '')}" placeholder="vas@email.sk" spellcheck="false" autocomplete="username">`)}
    ${row('Heslo', `<input class="st-in" type="password" data-mob="password" maxlength="200" placeholder="${m.hasPassword ? 'nastavené, nové napíšte sem' : `aspoň ${m.passwordMin ?? 12} znakov`}" autocomplete="new-password">`, `Aspoň ${m.passwordMin ?? 12} znakov a z toho tri druhy: malé a veľké písmená, číslice, iné znaky. Alebo aspoň ${m.passwordLong ?? 16} znakov, napríklad štyri slová za sebou.`, 'is-tall')}
    ${row('Heslo znova', `<input class="st-in" type="password" data-mob="password2" maxlength="200" placeholder="pre istotu ešte raz" autocomplete="new-password">`)}
    <div class="st-acts"><button type="button" class="st-btn" data-mob-save>Uložiť prihlásenie</button><span class="st-call-msg" data-mob-msg="login" role="status"></span></div>
    ${row('Tunel', seg('mobmode', [['quick', 'Rýchly'], ['named', 'Vlastný Cloudflare']], named ? 'named' : 'quick'), named ? 'Trvalá adresa na vašej doméne cez váš účet Cloudflare.' : 'Bez účtu a bez nastavovania. Adresa sa mení pri každom spustení.', 'is-tall')}
    ${
      named
        ? `${row('Adresa', `<input class="st-in" type="text" data-mob="hostname" maxlength="200" value="${esc(m.hostname ?? '')}" placeholder="jarvis.vasa-domena.sk" spellcheck="false" autocomplete="off">`)}
    ${row('Token tunela', `<input class="st-in" type="password" data-mob="token" placeholder="${m.hasToken ? 'uložený, nový vložte sem' : 'dlhý reťazec z Cloudflare'}" spellcheck="false" autocomplete="off">`, 'Cloudflare, Zero Trust, Networks, Tunnels, nový tunel typu Cloudflared. Token je reťazec za --token v príkaze na inštaláciu.', 'is-tall')}
    <div class="st-acts"><button type="button" class="st-btn" data-mob-tunnel>Uložiť tunel</button><span class="st-call-msg" data-mob-msg="tunnel" role="status"></span></div>
    <p class="st-note">V nastavení tunela pridajte Public hostname s vašou adresou a službou http://localhost:${esc(port)}.</p>`
        : ''
    }
    ${row('Prihlásené zariadenia', `<span class="st-val">${devices.length}</span>`, devList, 'is-tall')}
    ${lock}
    <div class="st-acts"><button type="button" class="st-btn is-quiet" data-mob-logout ${devices.length || known.length ? '' : 'disabled'}>Odhlásiť všetky zariadenia</button><span class="st-call-msg" data-mob-msg="devices" role="status"></span></div>
    <p class="st-note">Kto pozná tento e-mail a heslo, ovláda cez mňa tento počítač: číta vašu pamäť a spúšťa úlohy. Zvoľte silné heslo, ktoré nikde inde nepoužívate. Heslo píšte len sem, nikdy do rozhovoru so mnou.</p>
    <p class="st-note">O každom novom zariadení, zmene hesla a spustení tunela vám dám vedieť oznámením na tomto počítači. Odhlásiť všetky zariadenia zabudne aj tie, ktoré sa už prihlásili: každé sa potom prihlási ako nové.</p>`
}

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
    <div class="st-main"><nav class="st-nav" aria-label="Časti nastavení"></nav><div class="st-body"></div></div>
    <footer class="st-foot"><a class="st-credit" href="https://janjurdik.com" target="_blank" rel="noopener"><img src="/img/autor.jpg" alt="" width="36" height="36"><span>Vytvoril <b>Ján Jurdik</b></span></a></footer></div>`
  document.body.append(root)
  const body = root.querySelector('.st-body')
  const nav = root.querySelector('.st-nav')
  const savedEl = root.querySelector('.st-saved')

  let data = null
  let mobile = null
  let mobileTimer = 0
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

  // ── Mobil: its own data, refreshed while the section is open (the tunnel gets its address after a few seconds) ──
  const typing = () => open && body.contains(document.activeElement) && document.activeElement.matches('input')
  async function loadMobile() {
    try {
      const res = await fetch('/api/remote/status', { cache: 'no-store' })
      const json = await res.json()
      if (!json?.ok || JSON.stringify(json) === JSON.stringify(mobile)) return
      mobile = json
    } catch {
      return
    }
    if (open && tab === 'mobil' && !typing()) render()
  }
  function watchMobile() {
    clearInterval(mobileTimer)
    mobileTimer = 0
    if (!open || tab !== 'mobil') return
    loadMobile()
    mobileTimer = setInterval(loadMobile, 2500)
  }
  async function mobilePost(path, payload, msgKey) {
    const msg = body.querySelector(`[data-mob-msg="${msgKey}"]`)
    if (msg) msg.textContent = 'Ukladám…'
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.ok === false) throw new Error(json.error || 'Nepodarilo sa.')
      mobile = json
      flashSaved()
      render()
      const after = body.querySelector(`[data-mob-msg="${msgKey}"]`)
      if (after) after.textContent = 'Uložené.'
    } catch (err) {
      const now = body.querySelector(`[data-mob-msg="${msgKey}"]`)
      if (now) now.textContent = err.message
      else onToast(err.message)
    }
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
            ? `Model si vyberám sám a potichu. Ľahké veci (pozrieť poštu, kalendár) robím na ${esc(r.light ?? 'rýchlom modeli')}, ${r.normal ? `bežné na ${esc(r.normal)} ` : ''}a tvorbu či dlhú prácu na ${esc(r.heavy ?? 'najsilnejšom modeli')}. Ktorý práve beží, vidno malým písmom pri úlohe.`
            : 'Pri ľahkých veciach premýšľam krátko, pri náročných dôkladne. Vyberám si sám a potichu.'
    const native = desk()?.native && desk().version >= 2
    // A window of the browser instead of the Mac app (a Mac without the developer tools to build it).
    const browserWindow = !native && new URLSearchParams(location.search).get('surface') === 'app'
    const prefs = desk()?.prefs ?? {}
    const mac = d.platform === 'darwin'
    const surface = ['desktop', 'app', 'browser'].includes(d.surface) ? d.surface : mac ? 'desktop' : 'app'
    const onDesk = surface === 'desktop'
    const SURFACE = { desktop: 'Na ploche', app: 'Appka', browser: 'V prehliadači' }
    const surfaceSeg = seg('surface', (d.surfaces ?? (mac ? ['desktop', 'app', 'browser'] : ['app', 'browser'])).map((id) => [id, SURFACE[id]]), surface)
    const surfaceLead = {
      desktop: 'Žijem na vašej ploche namiesto tapety, pod oknami. Keď všetko zavriete, som tam.',
      app: mac
        ? 'Som appka Jarvis vo vlastnom okne, ako každý iný program. Nájdete ma v Docku, v Launchpade a v priečinku Aplikácie.'
        : 'Som samostatná appka vo vlastnom okne. Otvoríte ma ikonou Jarvis ako každý iný program, je na pracovnej ploche a v ponuke Štart.',
      browser: `Som stránka vo vašom prehliadači na adrese ${esc(location.host)}. Hovoriť, zvoniť a pripomínať nahlas viem, len keď ju máte otvorenú.`,
    }[surface]
    const surfaceRow = row('Kde ma máte', surfaceSeg, mac ? 'Presťahujem sa hneď. Na ploche aj v okne som tá istá appka Jarvis, len inak položená.' : 'Presťahujem sa hneď: nové miesto sa otvorí a toto sa samo zavrie.')

    return {
      asistent: `<h3>Asistent</h3><p class="st-lead">Kto s vami hovorí. To isté stačí povedať: „volaj sa Friday", „hovor ženským hlasom".</p>
        ${row('Kto to je', seg('gender', [['male', 'Muž'], ['female', 'Žena']], female ? 'female' : 'male'), female ? 'Komorníčka. Hovorí o sebe v ženskom rode.' : 'Komorník. Hovorí o sebe v mužskom rode.')}
        ${row('Meno', input('data-text="assistant.name"', d.assistant.name, 'Jarvis', { max: 24 }))}
        ${row('Jazyk', seg('language', [['sk', 'Slovenčina'], ['cs', 'Čeština']], lang, { disabled: d.languageLocked }), d.languageLocked ? 'Jazyk drží súbor .env (JARVIS_LANG).' : 'Ktorým hovorím a ktorému rozumiem.')}
        ${row('Anonymné štatistiky', toggle('data-toggle="telemetry"', d.telemetry?.on !== false, { disabled: d.telemetry?.locked }), d.telemetry?.locked ? 'Vypnuté v súbore .env.' : 'Raz denne pošlem autorovi len čísla: verziu, systém a koľkokrát sa čo použilo. Nikdy texty, mená, súbory ani pamäť. <button type="button" class="st-link" data-telemetry-show>Čo presne posielam</button>')}
        <pre class="st-pre" data-telemetry-pre hidden></pre>`,

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
        ${row('Ahoj Jarvis', toggle('data-toggle="wake"', d.wake.on, { disabled: !d.wake.available }), d.wake.available ? 'Stačí ma osloviť, netreba držať medzerník. Mikrofón je vtedy zapnutý stále, zvuk ostáva v počítači.' : 'Potrebuje Whisper v počítači.')}`,

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

      plocha: `<h3>Plocha</h3><p class="st-lead">${surfaceLead}</p>
        ${surfaceRow}
        ${onDesk && native ? row('Ikony na ploche', toggle('data-desk="icons"', prefs.icons !== false), 'Keď ich skryjem, plocha patrí len mne. Súbory ostávajú v priečinku Plocha.') : ''}
        ${onDesk && native ? row('Spúšťať po zapnutí počítača', toggle('data-desk="login"', prefs.login === true), 'Som tu hneď po prihlásení.') : ''}
        ${onDesk && native ? row('Ukázať ma nad oknami', `<span class="st-val"><kbd>${esc(desk().hotkeyLabel ?? '⌃⌥J')}</kbd></span>`, 'Skratka ma vytiahne navrch, Esc ma vráti späť pod okná.') : ''}
        <p class="st-note">${
          onDesk
            ? native
              ? 'V lište úplne hore vpravo je môj krúžok. Cez neho ma vyvoláte, načítate znova alebo vypnete a vrátite si pôvodnú plochu.'
              : 'Na plochu ma položí appka Jarvis, ktorú si Mac postaví sám. Potrebuje na to nástroje pre vývojárov od Apple: povedzte mi „nainštaluj nástroje od Apple“ a inštaláciu vám otvorím.'
            : surface === 'app'
              ? mac
                ? !browserWindow
                  ? 'Zelené tlačidlo okna alebo ⌃⌘F ma dá na celú obrazovku. Keď okno zavriete, bežím ďalej, hovorím aj zvoním, a ikona v Docku ma vráti. Po prihlásení do počítača sa otvorím sám.'
                  : 'Teraz bežím v okne prehliadača. Appku Jarvis si Mac postaví sám, keď bude mať nástroje pre vývojárov od Apple: povedzte mi „nainštaluj nástroje od Apple“ a inštaláciu vám otvorím.'
                : 'Okno je na celú obrazovku, F11 ho prepne na bežné okno a späť. Po prihlásení do počítača sa otvorím sám.'
              : 'Po prihlásení do počítača bežím potichu na pozadí a žiadne okno neotváram.'
        }</p>`,

      mobil: mobileSection(mobile, location.port || '4545'),
    }
  }

  function render() {
    if (!data) return
    const html = sections(data)
    nav.innerHTML = TABS.map(([id, ic, label]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${id === tab}">${icon(ic)}<span>${label}</span></button>`).join('')
    // The same section drawn again (new values) stays put, only a newly opened one slides in.
    const still = body.querySelector(`.st-sec[data-sec="${tab}"]`) !== null
    body.innerHTML = `<section class="st-sec${still ? ' is-still' : ''}" data-sec="${tab}">${html[tab] ?? html.asistent}</section>`
  }

  /** New values from the server (after a save, or because Jarvis changed something himself). */
  function apply(next) {
    if (!next?.assistant) return
    // Do not redraw under the user's fingers: a field being typed in keeps its text.
    const active = document.activeElement
    const typing = open && body.contains(active) && active.matches('input[type="text"], input[type="email"], input[type="range"], input[type="time"], input[type="tel"], input[type="password"], input[type="date"]')
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
      if (name === 'mobmode') return mobilePost('/api/remote/settings', { mode: v }, 'tunnel')
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
    if (t.dataset.toggle === 'telemetry') return save({ telemetry: t.checked })
    if (t.hasAttribute('data-mob-on')) return mobilePost('/api/remote/settings', { enabled: t.checked }, 'login')
    // The two switches of the menu bar icon: the desktop app flips them and reports back.
    if (t.dataset.desk) return desk()?.setPref?.(t.dataset.desk, t.checked)
    if (t.dataset.toggle === 'quiet' || t.dataset.time) {
      const on = body.querySelector('[data-toggle="quiet"]').checked
      const from = body.querySelector('[data-time="from"]').value || '22:30'
      const to = body.querySelector('[data-time="to"]').value || '07:00'
      return save({ quiet: on ? `${from}-${to}` : '' })
    }
  })
  // Anonymous statistics: the exact next ping, as the server would send it.
  body.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-telemetry-show]')) return
    const pre = body.querySelector('[data-telemetry-pre]')
    if (!pre) return
    if (!pre.hidden) return (pre.hidden = true)
    try {
      const d = await (await fetch('/api/telemetry')).json()
      const { id, ...rest } = d.preview ?? {}
      pre.textContent = `${d.on ? 'Ďalší ping' : 'Vypnuté, neposiela sa nič. Takto by vyzeral'} (${d.endpoint}):\n${JSON.stringify({ id, ...rest }, null, 2)}`
    } catch {
      pre.textContent = 'Nepodarilo sa načítať.'
    }
    pre.hidden = false
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
  // Mobil: the password goes from these two fields straight to the server and is never shown again.
  body.addEventListener('click', (e) => {
    const field = (name) => body.querySelector(`[data-mob="${name}"]`)?.value ?? ''
    if (e.target.closest('[data-mob-save]')) {
      const payload = { email: field('email').trim() }
      if (field('password')) Object.assign(payload, { password: field('password'), password2: field('password2') })
      return mobilePost('/api/remote/settings', payload, 'login')
    }
    if (e.target.closest('[data-mob-tunnel]')) {
      const payload = { mode: 'named', hostname: field('hostname').trim() }
      if (field('token').trim()) payload.token = field('token').trim()
      return mobilePost('/api/remote/settings', payload, 'tunnel')
    }
    if (e.target.closest('[data-mob-logout]')) return mobilePost('/api/remote/logout-all', {}, 'devices')
    const copy = e.target.closest('[data-mob-copy]')
    if (copy)
      navigator.clipboard?.writeText(copy.dataset.mobCopy).then(
        () => flashSaved('Skopírované'),
        () => onToast(copy.dataset.mobCopy),
      )
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
    watchMobile()
  })
  // The Mac app: its menu opens this sheet, and the two switches of the desktop are mirrored here.
  window.addEventListener('jarvis-desktop', (e) => {
    if (e.detail?.type === 'settings') openSheet('plocha')
    if (e.detail?.type === 'prefs' && open && tab === 'plocha') render()
  })

  function openSheet(section) {
    if (typeof section === 'string' && TABS.some(([id]) => id === section)) tab = section
    if (open) {
      render()
      return watchMobile()
    }
    open = true
    root.hidden = false
    requestAnimationFrame(() => root.classList.add('is-open'))
    if (data) render()
    load()
    watchMobile()
    setTimeout(() => root.querySelector('.st-x').focus(), 60)
  }

  function close() {
    if (!open) return
    open = false
    stopSample()
    watchMobile()
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
