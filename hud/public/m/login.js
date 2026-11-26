// The login of Jarvis on the phone. The email and the password go only to this server (POST
// /api/remote/login), which answers with a session cookie the page itself cannot read.

const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const next = /^\/(?![/\\])[^\s]*$/.test(params.get('next') ?? '') ? params.get('next') : '/'

// Already logged in (a cookie the opening link did not carry): straight on.
fetch('/api/remote/session', { cache: 'no-store' })
  .then((r) => r.json())
  .then((s) => {
    if (s?.loggedIn) location.replace(next)
    else if (s && s.enabled === false) $('lead').textContent = 'Mobilný prístup je teraz vypnutý. Zapína sa na počítači v Nastaveniach Jarvisa, časť Mobil.'
  })
  .catch(() => {})

let waitTimer = 0
function wait(seconds) {
  const go = $('go')
  clearInterval(waitTimer)
  let left = seconds
  go.disabled = true
  const tick = () => {
    if (left <= 0) {
      clearInterval(waitTimer)
      go.disabled = false
      go.textContent = 'Prihlásiť sa'
      return
    }
    go.textContent = `Skúste znova o ${left > 90 ? `${Math.ceil(left / 60)} min` : `${left} s`}`
    left--
  }
  tick()
  waitTimer = setInterval(tick, 1000)
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const email = $('email').value.trim()
  const password = $('password').value
  if (!email || !password) return ($('err').textContent = 'Vyplňte e-mail aj heslo.')
  $('err').textContent = ''
  $('go').disabled = true
  try {
    const res = await fetch('/api/remote/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, next }), cache: 'no-store' })
    const out = await res.json().catch(() => ({}))
    if (res.ok && out.ok) return location.replace(out.next || next)
    $('password').value = ''
    $('err').textContent = out.error || 'Prihlásenie sa nepodarilo.'
    if (res.status === 429 && out.retryAfter) return wait(Number(out.retryAfter))
  } catch {
    $('err').textContent = 'Jarvis neodpovedá. Beží počítač a je zapnutý mobilný prístup?'
  }
  $('go').disabled = false
})
