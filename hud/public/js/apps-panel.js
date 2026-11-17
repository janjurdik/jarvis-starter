// Panel planéty „Tvoje appky": stránka /apps/ (vložená ako ?embed=1) nad 3D svetom. Svet ostáva
// za ňou viditeľný, kamera stojí pri orbe. Stránka hlási kroky cez postMessage
// ({ type: 'jarvis-apps', action: close | saved | done | ask | wish | step }).

export function createAppsPanel({ onClose, onSaved, onAsk }) {
  const root = document.createElement('div')
  root.className = 'apv'
  root.hidden = true
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', 'Tvoje appky')
  root.innerHTML = '<div class="apv-glass"><iframe class="apv-frame" title="Tvoje appky"></iframe></div>'
  document.body.appendChild(root)
  const frame = root.querySelector('iframe')
  let open = false
  let closeTimer = 0

  function show(appId = null) {
    clearTimeout(closeTimer)
    const src = `/apps/?embed=1${appId ? `#${encodeURIComponent(appId)}` : ''}`
    // Same page already open: only jump to the app, the user keeps their scroll and step.
    if (open && appId) frame.contentWindow?.location.replace(src)
    else if (!open) frame.src = src
    root.hidden = false
    requestAnimationFrame(() => root.classList.add('is-open'))
    open = true
    setTimeout(() => frame.focus(), 400)
  }

  function hide({ silent = false } = {}) {
    if (!open) return
    open = false
    root.classList.remove('is-open')
    closeTimer = setTimeout(() => {
      root.hidden = true
      frame.removeAttribute('src')
    }, 520)
    if (!silent) onClose?.()
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== frame.contentWindow) return
    const m = e.data
    if (m?.type !== 'jarvis-apps') return
    if (m.action === 'close') hide()
    else if (m.action === 'saved') onSaved?.(m.data)
    else if (m.action === 'done') {
      onSaved?.(m.data)
      setTimeout(() => hide(), 1100)
    } else if (m.action === 'ask' || m.action === 'wish') onAsk?.(m.action, String(m.data ?? ''))
  })
  window.addEventListener(
    'keydown',
    (e) => {
      if (open && e.key === 'Escape') {
        e.stopPropagation()
        hide()
      }
    },
    { capture: true },
  )
  root.addEventListener('pointerdown', (e) => {
    if (e.target === root) hide()
  })

  return { show, hide, isOpen: () => open }
}
