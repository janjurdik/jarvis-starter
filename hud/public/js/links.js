// Links that would open a new tab. The desktop app is one window without tabs, where such a link
// does nothing, so the page takes care of it itself:
//
//   the guide to data exports (/guide/…)   opens inside Jarvis, over the world, with a way back
//   any other web address                  opens in the default browser (desktop app), or in a
//                                          new tab the usual way (browser)

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

export function initLinks({ desktop = false, toast = () => {} } = {}) {
  let view = null

  function closeGuide() {
    if (!view) return false
    const v = view
    view = null
    v.classList.remove('is-open')
    setTimeout(() => v.remove(), 220)
    return true
  }

  function openGuide(url) {
    closeGuide()
    const v = document.createElement('div')
    v.className = 'gv'
    v.innerHTML = `<div class="gv-sheet" role="dialog" aria-label="Sprievodca: ako získať svoje dáta">
      <div class="gv-bar"><b>Ako získať svoje dáta</b><button type="button" class="gv-x" aria-label="Zavrieť sprievodcu">Zavrieť</button></div>
      <iframe src="${esc(url.pathname + url.search + url.hash)}" title="Sprievodca"></iframe></div>`
    document.body.append(v)
    view = v
    setTimeout(() => v.classList.add('is-open'), 20)
    v.addEventListener('click', (e) => {
      if (e.target === v || e.target.closest('.gv-x')) closeGuide()
    })
    // Esc closes it also while the guide itself has the keyboard.
    v.querySelector('iframe').addEventListener('load', (e) => {
      try {
        e.target.contentWindow.addEventListener('keydown', (k) => k.key === 'Escape' && closeGuide())
      } catch {
        // not our page: the button closes it
      }
    })
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]')
    if (!a || a.target !== '_blank' || e.defaultPrevented) return
    let url
    try {
      url = new URL(a.getAttribute('href'), location.href)
    } catch {
      return
    }
    if (url.origin === location.origin && url.pathname.startsWith('/guide')) {
      e.preventDefault()
      return openGuide(url)
    }
    if (!desktop || !/^https?:$/.test(url.protocol)) return
    e.preventDefault()
    fetch('/api/open-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: url.href }) })
      .then((r) => (r.ok ? toast('Otváram v prehliadači') : toast('Odkaz sa nepodarilo otvoriť.')))
      .catch(() => toast('Odkaz sa nepodarilo otvoriť.'))
  })
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !view) return
      e.stopImmediatePropagation()
      e.preventDefault()
      closeGuide()
    },
    true,
  )
  return { openGuide, closeGuide, isOpen: () => Boolean(view) }
}
