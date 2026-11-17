// Hotová úloha v strede plochy. Namiesto zoznamu úloh v paneli sa výsledok ukáže sám, keď úloha
// skončí: web ako sklenená 3D karta so živým náhľadom, obrázok ako obrázok, inak krátka karta
// s výsledkom. Karta sa nakláňa za kurzorom a cez sklo jej prechádza tekutý odlesk. Sama zmizne,
// klik ju otvorí v detaile úlohy, Esc alebo klik vedľa ju zavrie.

import { icon } from './icons.js'
import { esc } from './format.js'

const STAY_MS = 16000

const sameOrigin = (url) => {
  try {
    return new URL(url, location.href).origin === location.origin
  } catch {
    return true
  }
}

export function createReveal({ onOpen, fileUrl = (u) => u }) {
  const root = document.createElement('div')
  root.className = 'rv'
  root.hidden = true
  root.innerHTML =
    '<svg class="rv-defs" aria-hidden="true"><filter id="rv-liquid" x="-10%" y="-10%" width="120%" height="120%">' +
    '<feTurbulence id="rv-noise" type="fractalNoise" baseFrequency="0.008 0.012" numOctaves="2" seed="3"/>' +
    '<feDisplacementMap in="SourceGraphic" scale="38" xChannelSelector="R" yChannelSelector="G"/></filter></svg>' +
    '<div class="rv-stage"></div>'
  document.body.appendChild(root)
  const stage = root.querySelector('.rv-stage')
  const noise = root.querySelector('#rv-noise')
  const queue = []
  let current = null
  let timer = 0
  let raf = 0

  function cardHtml(job) {
    const arts = job.artifacts ?? []
    const web = arts.find((a) => a.kind === 'web')
    const img = arts.find((a) => a.kind === 'image')
    const waiting = job.status === 'needs_ok'
    const badge = `<span class="rv-badge${waiting ? ' is-wait' : ''}">${icon(waiting ? 'hourglass' : 'check')}<span>${waiting ? 'Čaká na tvoje áno' : 'Hotovo'}</span></span>`
    const text = esc(waiting ? job.needsOk || job.summary || '' : job.summary || '')
    let media = ''
    let kind = 'text'
    if (img) {
      kind = 'image'
      media = `<div class="rv-media"><img src="${esc(fileUrl(img.url))}" alt="${esc(img.name)}" decoding="async"></div>`
    } else if (web) {
      kind = 'web'
      const host = esc(web.name.split('/')[0])
      media =
        `<div class="rv-media rv-web"><div class="rv-bar"><i></i><i></i><i></i><span>${esc(web.name)}</span></div>` +
        `<div class="rv-site"><div class="rv-fallback"><b>${host}</b></div>` +
        // A page of this very origin would run with Jarvis's own rights inside the frame: it is shown as a link only.
        `${sameOrigin(web.url) ? '' : `<iframe src="${esc(web.url)}" title="${host}" loading="eager" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" tabindex="-1"></iframe>`}</div></div>`
    }
    const links = web ? `<a class="rv-btn" href="${esc(web.url)}" target="_blank" rel="noopener">${icon('web')}<span>Otvoriť web</span></a>` : ''
    return {
      kind,
      html:
        `<div class="rv-card k-${kind}${waiting ? ' is-wait' : ''}" role="dialog" aria-label="${esc(job.title || 'Úloha')}">` +
        `<div class="rv-tilt">${media}<div class="rv-body">${badge}<h2>${esc(job.title || 'Úloha')}</h2>${text ? `<p>${text}</p>` : ''}` +
        `<div class="rv-actions">${links}<button type="button" class="rv-btn ghost" data-open>${icon('timeline')}<span>Priebeh</span></button></div></div>` +
        '<div class="rv-sheen"></div><div class="rv-rim"></div></div></div>',
    }
  }

  function play() {
    if (current || !queue.length) return
    current = queue.shift()
    const { html, kind } = cardHtml(current)
    stage.innerHTML = html
    root.hidden = false
    root.dataset.kind = kind
    requestAnimationFrame(() => root.classList.add('is-on'))
    const card = stage.querySelector('.rv-card')
    card.querySelector('[data-open]').addEventListener('click', () => {
      const id = current?.id
      close()
      if (id) onOpen?.(id)
    })
    card.addEventListener('pointerenter', () => clearTimeout(timer))
    card.addEventListener('pointerleave', () => arm())
    arm()
    animate()
  }

  function arm() {
    clearTimeout(timer)
    timer = setTimeout(close, STAY_MS)
  }

  function close() {
    if (!current) return
    clearTimeout(timer)
    root.classList.remove('is-on')
    current = null
    setTimeout(() => {
      if (current) return
      root.hidden = true
      stage.innerHTML = ''
      cancelAnimationFrame(raf)
      play()
    }, 600)
  }

  /** Tekutý odlesk: šum v SVG filtri sa pomaly prelieva, kým je karta na ploche. */
  function animate() {
    cancelAnimationFrame(raf)
    const t0 = performance.now()
    const step = (t) => {
      if (root.hidden) return
      const k = (t - t0) / 1000
      noise.setAttribute('baseFrequency', `${(0.007 + 0.002 * Math.sin(k * 0.7)).toFixed(4)} ${(0.011 + 0.003 * Math.cos(k * 0.5)).toFixed(4)}`)
      noise.setAttribute('seed', String(3 + (Math.floor(k * 6) % 30)))
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
  }

  root.addEventListener('pointermove', (e) => {
    const card = stage.querySelector('.rv-card')
    if (!card) return
    const r = card.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width - 0.5
    const y = (e.clientY - r.top) / r.height - 0.5
    card.style.setProperty('--ry', `${(x * 14).toFixed(2)}deg`)
    card.style.setProperty('--rx', `${(-y * 12).toFixed(2)}deg`)
    card.style.setProperty('--mx', `${((x + 0.5) * 100).toFixed(1)}%`)
    card.style.setProperty('--my', `${((y + 0.5) * 100).toFixed(1)}%`)
  })
  root.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.rv-card')) close()
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current) close()
  })

  return {
    /** Ukáže hotovú úlohu (frontou, jedna po druhej). */
    show(job) {
      if (!job?.id || queue.some((j) => j.id === job.id) || current?.id === job.id) return
      queue.push(job)
      play()
    },
    close,
    isOpen: () => Boolean(current),
  }
}
