// The ringing alarm on the screen. While the alarm sound plays (scripts/alarm.mjs ring), Jarvis
// covers the screen with the time, "Dobré ráno" and one button: it stops the sound and the
// morning brief starts at once. Nobody presses it: the sound plays to its end, the brief follows
// by itself and the cover goes away.
//
//   const ring = createAlarmRing({ api, raise, lower })
//       raise() brings the Jarvis app forward and returns true when it was not in front before,
//       lower() puts it back (both only in the native app, main.js)
//   ring.apply({ ring })                 the SSE event `alarm`: { ring } starts it, { ring: null } ends it
//
// The sound and the voice come from the alarm script through the computer's speakers, not from
// this page: the page only shows the state and sends the stop (POST /api/alarm/stop).

import { esc } from './format.js'

const two = (n) => String(n).padStart(2, '0')

export function createAlarmRing({ api, raise = null, lower = null }) {
  let el = null
  let current = null
  let tick = null
  let gone = null
  /** The Jarvis app was brought above the other windows for this alarm and goes back when it is over. */
  let lifted = false

  function close() {
    clearInterval(tick)
    clearTimeout(gone)
    tick = null
    current = null
    if (!el) return
    const old = el
    el = null
    old.classList.add('is-leaving')
    setTimeout(() => old.remove(), 420)
    window.removeEventListener('keydown', onKey, true)
    if (lifted) {
      lifted = false
      lower?.()
    }
  }

  async function stop() {
    if (!current) return
    const id = current.id
    // The cover goes at once: the click is the answer, the sound stops a moment later.
    close()
    try {
      await api.alarmStop(id)
    } catch {
      // the alarm script may be gone already: the sound has stopped anyway
    }
  }

  function onKey(e) {
    if (!current) return
    // While the alarm rings every key belongs to it: no push-to-talk, no typing into the command line.
    e.stopPropagation()
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
      e.preventDefault()
      stop()
    }
  }

  function open(ring) {
    if (current?.id === ring.id) return
    close()
    current = ring
    const started = Date.parse(ring.at)
    const total = Math.max(1, Number(ring.seconds) || 45)
    const left = Math.max(0, total - (Date.now() - (Number.isFinite(started) ? started : Date.now())) / 1000)
    const you = ring.formal === false ? 'ti' : 'vám'
    const line = ring.sound ? `Hrá ${ring.sound}. Keď dohrá, poviem ${you}, čo je dnes na programe.` : `O chvíľu ${you} poviem, čo je dnes na programe.`
    el = document.createElement('div')
    el.className = 'alarm-ring'
    el.setAttribute('role', 'alertdialog')
    el.setAttribute('aria-modal', 'true')
    el.setAttribute('aria-label', 'Budík zvoní')
    el.innerHTML =
      `<div class="ar-in">` +
      `<div class="ar-clock" aria-hidden="true"></div>` +
      `<h2 class="ar-hello">${esc(ring.greeting || 'Dobré ráno')}</h2>` +
      `<p class="ar-line">${esc(line)}</p>` +
      `<button type="button" class="ar-stop">Zastaviť budík</button>` +
      `<p class="ar-hint">Zastaví zvonenie a ranný prehľad zaznie hneď.</p>` +
      `<div class="ar-left" aria-hidden="true"><i style="animation-duration:${total}s;animation-delay:-${(total - left).toFixed(1)}s"></i></div>` +
      `</div>`
    const clock = el.querySelector('.ar-clock')
    const paint = () => {
      const d = new Date()
      clock.textContent = `${two(d.getHours())}:${two(d.getMinutes())}`
    }
    paint()
    tick = setInterval(paint, 1000)
    el.querySelector('.ar-stop').addEventListener('click', stop)
    document.body.append(el)
    // In the Jarvis app the window comes forward (on the desktop it rises above the other windows), so the button can be seen.
    try {
      lifted = raise?.() === true
    } catch {
      lifted = false
    }
    window.addEventListener('keydown', onKey, true)
    el.querySelector('.ar-stop').focus({ preventScroll: true })
    // The script says when the sound is over. Should that word get lost, the cover still leaves on its own.
    gone = setTimeout(close, (left + 20) * 1000)
  }

  function apply(msg) {
    if (msg?.ring?.id) open(msg.ring)
    else if (!msg?.id || msg.id === current?.id) close()
  }

  // A window that opens (or reloads) while the alarm rings shows it too.
  api.alarm().then((r) => r?.ring && apply({ ring: r.ring })).catch(() => {})

  return { apply, close, get ringing() { return Boolean(current) } }
}
