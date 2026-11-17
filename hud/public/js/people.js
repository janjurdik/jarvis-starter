// People review: after an import Jarvis shows who he found in the conversations and the user says
// who is who. One person at a time on the right (photo, name, where the messages come from, a few
// lines to recognise them, relationship), the whole list on the left. Built for the keyboard:
// Enter confirms and moves on, S skips, arrows walk the list.
//
// Decisions stay in the page (mirrored to localStorage, a reload loses nothing) and are sent in
// one go by "Hotovo": POST /api/import/apply. Opens from the import card, from the Pamäť module
// and with the address #ludia.

import { icon } from './icons.js'
import { esc, nf, plural } from './format.js'

const STORE_KEY = 'jarvis.people.v1'
const HASH = '#ludia'
const BULK_MIN = 200
const STRONG_MATCH = 0.6
const SOURCE_NAME = { instagram: 'Instagram', facebook: 'Messenger', whatsapp: 'WhatsApp', discord: 'Discord', telegram: 'Telegram', chatgpt: 'ChatGPT', claude: 'Claude', takeout: 'Google' }
const SOURCE_ICON = { instagram: 'instagram', chatgpt: 'sparkle', claude: 'sparkle' }
const DEFAULT_RELATIONS = ['rodina', 'partner', 'priateľ', 'kolega', 'klient', 'známy', 'iné']

const yearOf = (v) => /^(\d{4})/.exec(String(v ?? ''))?.[1] ?? null
const initials = (name) =>
  String(name ?? '')
    .replace(/[@._-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?'
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function createPeople({ api, ui, isFilm = () => false, onApplied }) {
  const root = document.getElementById('people')
  let open = false
  let loading = false
  let error = null
  let sending = false
  /** { candidates, existing, relations, hiddenSmall } */
  let data = null
  let cur = 0
  /** key → { action: new|merge|skip, name, vztah, note, avatar } */
  let decisions = {}
  /** key → what the user changed before deciding: { name, vztah, avatar, note, noSuggest } */
  let drafts = {}
  /** The "Je to…" picker: { q, at } or null */
  let pick = null
  /** Photos the browser could not show (damaged file, a format it does not know): never offered again. */
  const badPhotos = new Set()

  // ── storage ──
  function loadStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}')
      decisions = raw.decisions && typeof raw.decisions === 'object' ? raw.decisions : {}
      drafts = raw.drafts && typeof raw.drafts === 'object' ? raw.drafts : {}
    } catch {
      decisions = {}
      drafts = {}
    }
  }
  function saveStore() {
    try {
      if (!Object.keys(decisions).length && !Object.keys(drafts).length) localStorage.removeItem(STORE_KEY)
      else localStorage.setItem(STORE_KEY, JSON.stringify({ decisions, drafts }))
    } catch {
      // private window or full storage: decisions live only in this page
    }
  }

  // ── model ──
  const people = () => data?.candidates ?? []
  const relations = () => (data?.relations?.length ? data.relations : DEFAULT_RELATIONS)
  const noteTitle = (note) => String(note ?? '').replace(/\\/g, '/').split('/').pop().replace(/\.md$/i, '')
  /** A person already in the memory. The importer names them by title, the list by path: both are accepted. */
  const existingOf = (note) => data?.existing?.find((p) => p.note === note || fold(p.name) === fold(noteTitle(note))) ?? null
  const existingName = (note) => existingOf(note)?.name ?? noteTitle(note)

  /** What would be saved for this person right now (defaults from the importer, then the user's edits). */
  function draftOf(c) {
    const d = drafts[c.key] ?? {}
    const strong = c.suggest && c.suggest.score >= STRONG_MATCH && !d.noSuggest ? c.suggest.note : null
    const note = d.note !== undefined ? d.note : strong
    // Joining someone I already know keeps what their note says, unless the user picks otherwise here.
    const known = note ? existingOf(note) : null
    const guess = relations().includes(c.kindGuess) ? c.kindGuess : 'známy'
    const photos = c.photos.filter((p) => !badPhotos.has(p.rel))
    const picked = d.avatar !== undefined && (d.avatar === null || photos.some((p) => p.rel === d.avatar))
    return {
      name: d.name ?? c.name,
      vztah: d.vztah ?? (known?.vztah && relations().includes(known.vztah) ? known.vztah : guess),
      avatar: picked ? d.avatar : known?.photo ? null : photos[0]?.rel ?? null,
      note,
      known,
      noSuggest: d.noSuggest === true,
    }
  }
  const edit = (c, patch) => {
    drafts[c.key] = { ...drafts[c.key], ...patch }
    // A changed detail of an already decided person changes the decision too.
    const dec = decisions[c.key]
    if (dec && dec.action !== 'skip') decisions[c.key] = decisionOf(c)
    saveStore()
  }
  function decisionOf(c) {
    const d = draftOf(c)
    const name = d.name.trim() || c.name
    if (!d.note) return { action: 'new', name, vztah: d.vztah, avatar: d.avatar }
    // A merge only changes the relationship when the user chose one for it, the note's own stays otherwise.
    return { action: 'merge', note: d.note, name, vztah: drafts[c.key]?.vztah ?? (d.known?.vztah ? undefined : d.vztah), avatar: d.avatar }
  }
  const decidedCount = () => people().filter((c) => decisions[c.key]).length
  const photoUrl = (c, rel) => (badPhotos.has(rel) ? '' : api.fileUrl(c.photos.find((p) => p.rel === rel)?.url ?? ''))

  function nextUndecided(from) {
    const all = people()
    for (let n = 1; n <= all.length; n++) {
      const i = (from + n) % all.length
      if (!decisions[all[i].key]) return i
    }
    return -1
  }

  // ── actions ──
  function go(i) {
    const all = people()
    if (!all.length) return
    cur = Math.min(all.length - 1, Math.max(0, i))
    pick = null
    render()
    root.querySelector('.pv-row.is-cur')?.scrollIntoView({ block: 'nearest' })
  }
  function decide(action) {
    const c = people()[cur]
    if (!c) return
    decisions[c.key] = action === 'skip' ? { action: 'skip' } : decisionOf(c)
    saveStore()
    const next = nextUndecided(cur)
    if (next >= 0) go(next)
    else {
      pick = null
      render()
    }
  }
  function undo() {
    const c = people()[cur]
    if (!c || !decisions[c.key]) return
    delete decisions[c.key]
    saveStore()
    render()
  }
  function bulkAdd() {
    for (const c of people()) if (!decisions[c.key] && c.messages >= BULK_MIN) decisions[c.key] = decisionOf(c)
    saveStore()
    const next = nextUndecided(cur - 1)
    if (next >= 0) go(next)
    else render()
  }
  function bulkSkip() {
    for (const c of people()) if (!decisions[c.key]) decisions[c.key] = { action: 'skip' }
    saveStore()
    render()
  }

  async function done() {
    if (sending) return
    const list = people()
      .filter((c) => decisions[c.key])
      .map((c) => {
        const d = decisions[c.key]
        return d.action === 'skip' ? { key: c.key, action: 'skip' } : { key: c.key, action: d.action, name: d.name, vztah: d.vztah, avatar: d.avatar ?? undefined, note: d.action === 'merge' ? d.note : undefined }
      })
    if (!list.length) return close()
    sending = true
    render()
    try {
      const res = await api.importApply(list)
      for (const d of list) {
        delete decisions[d.key]
        delete drafts[d.key]
      }
      saveStore()
      sending = false
      close()
      onApplied?.(res)
    } catch (err) {
      sending = false
      render()
      ui.toast(`Ľudí sa nepodarilo zapísať: ${esc(err.message)}`, { kind: 'warn', iconName: 'people', ms: 7000 })
    }
  }

  // ── render ──
  function avatar(c, rel, cls) {
    const url = rel ? photoUrl(c, rel) : ''
    return url ? `<span class="${cls} has-img"><img src="${esc(url)}" data-rel="${esc(rel)}" alt="" loading="lazy" decoding="async"></span>` : `<span class="${cls}"><em>${esc(initials(draftOf(c).name))}</em></span>`
  }
  const sourceLine = (c) => [...new Set(c.sources.map((s) => SOURCE_NAME[s.source] ?? s.source))].join(', ')

  function rowHtml(c, i) {
    const dec = decisions[c.key]
    const d = draftOf(c)
    const st = dec ? (dec.action === 'skip' ? icon('skip') : dec.action === 'merge' ? icon('link') : icon('check')) : ''
    return (
      `<button type="button" class="pv-row${i === cur ? ' is-cur' : ''}${dec && ['add', 'merge', 'skip'].includes(dec.action) ? ` st-${dec.action}` : ''}" data-go="${i}">` +
      avatar(c, d.avatar, 'pv-mini') +
      `<span class="pv-rmain"><span class="pv-rname">${esc(d.name || c.name)}</span><span class="pv-rsub">${esc(sourceLine(c))} · ${nf(c.messages)} ${plural(c.messages, 'správa', 'správy', 'správ')}</span></span>` +
      `<span class="pv-rst">${st}</span></button>`
    )
  }

  function statHtml(value, label) {
    return `<div class="pv-stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`
  }

  function mergeHtml(c, d) {
    if (pick) {
      const q = fold(pick.q)
      const hits = (data.existing ?? []).filter((p) => !q || fold(p.name).includes(q)).slice(0, 40)
      pick.hits = hits
      pick.at = Math.min(Math.max(0, pick.at), Math.max(0, hits.length - 1))
      return (
        '<div class="pv-merge is-pick">' +
        `<label class="pv-search">${icon('search')}<input type="text" class="pv-q" value="${esc(pick.q)}" placeholder="Hľadaj medzi ľuďmi, ktorých už poznám" spellcheck="false" aria-label="Hľadať človeka v pamäti"><button type="button" class="pv-undo" data-act="pick-close">Zrušiť</button></label>` +
        (hits.length
          ? `<div class="pv-hits">${hits.map((p, i) => `<button type="button" class="pv-hit${i === pick.at ? ' is-at' : ''}" data-merge="${esc(p.note)}">${icon('person')}<span>${esc(p.name)}</span>${p.vztah ? `<small>${esc(p.vztah)}</small>` : ''}</button>`).join('')}</div>`
          : `<p class="pv-none">${data.existing?.length ? 'Nikoho takého v pamäti nemám.' : 'V pamäti zatiaľ nikoho nemám.'}</p>`) +
        '</div>'
      )
    }
    if (d.note) {
      const strong = c.suggest && c.suggest.note === d.note
      return (
        `<div class="pv-merge is-set">${icon('link')}<div class="pv-mtext"><b>Je to ${esc(existingName(d.note))}${strong ? '?' : '.'}</b>` +
        `<span>${strong ? esc(c.suggest.reason || 'Vyzerá to na človeka, ktorého už poznám.') : 'Správy pripojím k človeku, ktorého už poznám.'}</span></div>` +
        `<div class="pv-mact">${strong ? '<button type="button" class="pv-btn is-on" data-act="merge-yes">Áno</button>' : '<button type="button" class="pv-btn" data-act="pick">Zmeniť</button>'}<button type="button" class="pv-btn" data-act="merge-no">Nie</button></div></div>`
      )
    }
    if (c.suggest && !d.noSuggest) {
      return (
        `<div class="pv-merge">${icon('link')}<div class="pv-mtext"><b>Nie je to ${esc(c.suggest.name)}?</b><span>${esc(c.suggest.reason || 'Podobá sa na človeka, ktorého už poznám.')}</span></div>` +
        `<div class="pv-mact"><button type="button" class="pv-btn" data-merge="${esc(c.suggest.note)}">Áno</button><button type="button" class="pv-btn" data-act="merge-no">Nie</button></div></div>`
      )
    }
    return ''
  }

  function cardHtml(c) {
    const d = draftOf(c)
    const dec = decisions[c.key]
    const a = yearOf(c.first)
    const b = yearOf(c.last)
    const badges = c.sources
      .map((s) => `<span class="pv-badge">${icon(SOURCE_ICON[s.source] ?? 'spravy')}<span>${esc(SOURCE_NAME[s.source] ?? s.source)}</span>${s.handle && fold(s.handle) !== fold(c.name) ? `<b>${esc(s.handle)}</b>` : ''}</span>`)
      .join('')
    const state = dec
      ? `<div class="pv-dec st-${dec.action}">${icon(dec.action === 'skip' ? 'skip' : dec.action === 'merge' ? 'link' : 'check')}<span>${dec.action === 'skip' ? 'Preskočené' : dec.action === 'merge' ? `Je to ${esc(existingName(dec.note))}` : 'Pridám'}</span><button type="button" class="pv-undo" data-act="undo">Vrátiť</button></div>`
      : ''
    const shots = c.photos.filter((p) => !badPhotos.has(p.rel))
    const photos = shots.length
      ? `<section class="pv-sec"><h3>Fotka</h3><div class="pv-photos">${shots
          .map((p) => `<button type="button" class="pv-photo${d.avatar === p.rel ? ' is-on' : ''}" data-photo="${esc(p.rel)}" aria-label="Vybrať fotku"><img src="${esc(api.fileUrl(p.url))}" data-rel="${esc(p.rel)}" alt="" decoding="async"></button>`)
          .join('')}<button type="button" class="pv-photo pv-nophoto${d.avatar ? '' : ' is-on'}" data-photo="">${icon('person')}<span>${d.known?.photo ? 'nechať pôvodnú' : 'bez fotky'}</span></button></div></section>`
      : ''
    const sample = c.sample.length
      ? `<section class="pv-sec"><h3>Z vašich správ</h3><ul class="pv-sample">${c.sample
          .slice(0, 3)
          .map((m) => {
            const mine = /^(ja|me|ty)$/i.test(m.from) || (data.me ?? []).includes(m.from)
            return `<li class="${mine ? 'is-me' : ''}"><span class="pv-who2">${mine ? 'Ty' : esc(m.from.split(' ')[0] || m.from)}</span><span class="pv-line">${esc(m.text)}</span></li>`
          })
          .join('')}</ul></section>`
      : ''
    const rel = `<section class="pv-sec"><h3>Kto je to pre teba</h3><div class="pv-rel">${relations()
      .map((r, i) => `<button type="button" class="pv-pill${d.vztah === r ? ' is-on' : ''}" data-rel="${esc(r)}"><kbd>${i + 1}</kbd>${esc(r)}</button>`)
      .join('')}</div></section>`
    const primary = d.note ? `Áno, je to ${esc(existingName(d.note))}` : 'Áno, pridať'
    return (
      `<div class="pv-who">${avatar(c, d.avatar, 'pv-ava')}` +
      `<div class="pv-id"><input type="text" class="pv-name" value="${esc(d.name)}" maxlength="80" spellcheck="false" autocomplete="off" aria-label="Meno človeka"><div class="pv-badges">${badges}</div></div>${state}</div>` +
      '<div class="pv-stats">' +
      statHtml(nf(c.messages), plural(c.messages, 'správa', 'správy', 'správ')) +
      statHtml(nf(c.mine), plural(c.mine, 'poslaná', 'poslané', 'poslaných')) +
      statHtml(nf(c.theirs), plural(c.theirs, 'prijatá', 'prijaté', 'prijatých')) +
      (a && b ? statHtml(a === b ? a : `${a} až ${b}`, 'obdobie') : '') +
      (c.groupsShared ? statHtml(nf(c.groupsShared), plural(c.groupsShared, 'spoločná skupina', 'spoločné skupiny', 'spoločných skupín')) : '') +
      '</div>' +
      photos +
      sample +
      rel +
      mergeHtml(c, d) +
      // While the picker is open Enter belongs to it, the three actions would only be in the way.
      (pick
        ? ''
        : '<div class="pv-acts">' +
          `<button type="button" class="pv-btn is-main" data-act="yes">${icon(d.note ? 'link' : 'plus')}<span>${primary}</span><kbd>Enter</kbd></button>` +
          `<button type="button" class="pv-btn" data-act="pick">${icon('search')}<span>Je to…</span><kbd>M</kbd></button>` +
          `<button type="button" class="pv-btn is-quiet" data-act="skip">${icon('skip')}<span>Preskočiť</span><kbd>S</kbd></button>` +
          '</div>')
    )
  }

  function render() {
    if (!open) return
    const all = people()
    if (loading || error || !all.length) {
      const body = loading
        ? '<div class="pv-wait"><span class="thinking"><i></i><i></i><i></i></span><p>Prechádzam konverzácie a hľadám v nich ľudí.</p></div>'
        : error
          ? `<div class="pv-wait">${icon('alarm')}<p>${esc(error)}</p><button type="button" class="pv-btn" data-act="reload">Skúsiť znova</button></div>`
          : `<div class="pv-wait">${icon('check')}<p>Nikto nečaká na potvrdenie.</p><button type="button" class="pv-btn" data-act="close">Zavrieť</button></div>`
      root.innerHTML = `<div class="pv-in"><header class="pv-top"><div class="pv-h"><h2>Kto je kto</h2></div><div class="pv-tools"><button type="button" class="pv-x" data-act="close" aria-label="Zavrieť">${icon('close')}</button></div></header>${body}</div>`
      return
    }
    cur = Math.min(cur, all.length - 1)
    const c = all[cur]
    const decided = decidedCount()
    const big = all.filter((p) => !decisions[p.key] && p.messages >= BULK_MIN).length
    const left = all.length - decided
    const keepScroll = root.querySelector('.pv-rows')?.scrollTop ?? 0
    root.innerHTML =
      '<div class="pv-in">' +
      '<header class="pv-top">' +
      `<div class="pv-h"><h2>Kto je kto</h2><p>V konverzáciách som našiel ${nf(all.length)} ${plural(all.length, 'človeka', 'ľudí', 'ľudí')}. Povedz mi, koho si mám zapamätať.</p></div>` +
      '<div class="pv-tools">' +
      (big ? `<button type="button" class="pv-btn" data-act="bulk-add">Pridať všetkých nad ${BULK_MIN} správ (${big})</button>` : '') +
      (left ? '<button type="button" class="pv-btn" data-act="bulk-skip">Zvyšok preskočiť</button>' : '') +
      `<button type="button" class="pv-btn is-main${left ? '' : ' is-ready'}" data-act="done"${sending ? ' disabled' : ''}>${icon('check')}<span>${sending ? 'Zapisujem…' : 'Hotovo'}</span></button>` +
      `<button type="button" class="pv-x" data-act="close" aria-label="Zavrieť">${icon('close')}</button>` +
      '</div></header>' +
      '<div class="pv-body">' +
      '<aside class="pv-list">' +
      `<div class="pv-prog"><span><b>${nf(decided)}</b> z ${nf(all.length)}</span><i class="pv-bar"><i style="width:${(decided / all.length) * 100}%"></i></i></div>` +
      `<div class="pv-rows">${all.map(rowHtml).join('')}${data.hiddenSmall ? `<p class="pv-small">${data.hiddenSmall === 1 ? 'Jedného ďalšieho človeka' : `Ďalších ${nf(data.hiddenSmall)} ľudí`} s pár správami som vynechal.</p>` : ''}</div>` +
      '</aside>' +
      `<section class="pv-card${decisions[c.key] ? ` is-${decisions[c.key].action}` : ''}"><div class="pv-scroll">${cardHtml(c)}</div>` +
      (pick
        ? '<footer class="pv-keys"><span><kbd>↑</kbd><kbd>↓</kbd>prechádzať</span><span><kbd>Enter</kbd>vybrať</span><span><kbd>Esc</kbd>späť</span></footer>'
        : '<footer class="pv-keys"><span><kbd>Enter</kbd>potvrdiť a ďalší</span><span><kbd>S</kbd>preskočiť</span><span><kbd>↑</kbd><kbd>↓</kbd>prechádzať</span><span><kbd>Z</kbd>vrátiť</span><span><kbd>Esc</kbd>zavrieť</span></footer>') +
      '</section>' +
      '</div></div>'
    const rows = root.querySelector('.pv-rows')
    if (rows) rows.scrollTop = keepScroll
    if (pick) {
      const q = root.querySelector('.pv-q')
      q?.focus()
      q?.setSelectionRange(q.value.length, q.value.length)
    }
  }

  // ── events ──
  root.addEventListener('click', (e) => {
    const t = e.target
    const c = people()[cur]
    const goBtn = t.closest('[data-go]')
    if (goBtn) return go(Number(goBtn.dataset.go))
    const photo = t.closest('[data-photo]')
    if (photo && c) {
      edit(c, { avatar: photo.dataset.photo || null })
      return render()
    }
    const rel = t.closest('[data-rel]')
    if (rel && c) {
      edit(c, { vztah: rel.dataset.rel })
      return render()
    }
    const merge = t.closest('[data-merge]')
    if (merge && c) {
      pick = null
      edit(c, { note: merge.dataset.merge, noSuggest: false })
      return render()
    }
    const act = t.closest('[data-act]')?.dataset.act
    if (!act) return
    if (act === 'close') return close()
    if (act === 'reload') return load()
    if (act === 'done') return done()
    if (act === 'bulk-add') return bulkAdd()
    if (act === 'bulk-skip') return bulkSkip()
    if (!c) return
    if (act === 'yes' || act === 'merge-yes') return decide('yes')
    if (act === 'skip') return decide('skip')
    if (act === 'undo') return undo()
    if (act === 'pick') {
      pick = { q: '', at: 0 }
      return render()
    }
    if (act === 'pick-close') {
      pick = null
      return render()
    }
    if (act === 'merge-no') {
      edit(c, { note: null, noSuggest: true })
      return render()
    }
  })
  root.addEventListener('mouseup', (e) => e.target.closest('button')?.blur())
  // A photo that does not load is dropped from the offer and the person falls back to initials.
  let badTimer = null
  root.addEventListener(
    'error',
    (e) => {
      const rel = e.target?.dataset?.rel
      if (e.target?.tagName !== 'IMG' || !rel || badPhotos.has(rel)) return
      badPhotos.add(rel)
      clearTimeout(badTimer)
      badTimer = setTimeout(() => document.activeElement?.tagName !== 'INPUT' && render(), 60)
    },
    true,
  )
  root.addEventListener('input', (e) => {
    const c = people()[cur]
    if (!c) return
    if (e.target.classList.contains('pv-name')) {
      edit(c, { name: e.target.value })
      // Only the list row and the initials follow the typing, the input itself is left alone.
      const row = root.querySelector('.pv-row.is-cur .pv-rname')
      if (row) row.textContent = e.target.value || c.name
      for (const em of root.querySelectorAll('.pv-row.is-cur .pv-mini em, .pv-ava em')) em.textContent = initials(e.target.value || c.name)
    } else if (e.target.classList.contains('pv-q') && pick) {
      pick.q = e.target.value
      pick.at = 0
      render()
    }
  })

  /** Capture phase on the window: while the review is open no key reaches the HUD under it (push-to-talk, focus of the command bar). */
  function onKey(e) {
    if (!open) return
    e.stopPropagation()
    const el = document.activeElement
    const typing = el?.tagName === 'INPUT'
    const k = e.key
    const c = people()[cur]
    if (pick) {
      if (k === 'Escape') {
        pick = null
        render()
      } else if (k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault()
        pick.at += k === 'ArrowDown' ? 1 : -1
        render()
      } else if (k === 'Enter') {
        e.preventDefault()
        const hit = pick.hits?.[pick.at]
        if (hit && c) {
          pick = null
          edit(c, { note: hit.note, noSuggest: false })
          render()
        }
      }
      return
    }
    if (k === 'Escape') {
      e.preventDefault()
      if (typing) el.blur()
      else close()
      return
    }
    if ((e.metaKey || e.ctrlKey) && k === 'Enter') {
      e.preventDefault()
      return done()
    }
    if (e.metaKey || e.ctrlKey || e.altKey || !c) return
    if (k === 'Enter') {
      e.preventDefault()
      if (typing) el.blur()
      return decide('yes')
    }
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault()
      return go(cur + (k === 'ArrowDown' ? 1 : -1))
    }
    if (typing) return
    if (k === 'ArrowRight' || k === 'ArrowLeft') {
      e.preventDefault()
      return go(cur + (k === 'ArrowRight' ? 1 : -1))
    }
    if (k === ' ') return e.preventDefault()
    const low = k.toLowerCase()
    if (low === 's') decide('skip')
    else if (low === 'm') {
      e.preventDefault()
      pick = { q: '', at: 0 }
      render()
    } else if (low === 'z' || k === 'Backspace') undo()
    else if (/^[1-9]$/.test(k) && relations()[Number(k) - 1]) {
      edit(c, { vztah: relations()[Number(k) - 1] })
      render()
    }
  }
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('keyup', (e) => open && e.stopPropagation(), true)

  // ── open and close ──
  async function load() {
    loading = true
    error = null
    render()
    try {
      const res = await api.importPeople()
      data = { ...res, candidates: (res.candidates ?? []).map((c) => ({ ...c, photos: c.photos ?? [], sources: c.sources ?? [], sample: c.sample ?? [] })) }
      // Decisions about people who are no longer waiting are of no use.
      const keys = new Set(data.candidates.map((c) => c.key))
      for (const k of Object.keys(decisions)) if (!keys.has(k)) delete decisions[k]
      for (const k of Object.keys(drafts)) if (!keys.has(k)) delete drafts[k]
      saveStore()
      const first = nextUndecided(-1)
      cur = first >= 0 ? first : 0
    } catch (err) {
      error = err.status === 403 ? err.message : `Ľudí sa nepodarilo načítať: ${err.message}`
    }
    loading = false
    render()
  }

  function show() {
    if (open) return
    if (isFilm()) return ui.toast('V režime natáčania sú ľudia skrytí.', { kind: 'warn', iconName: 'film' })
    open = true
    pick = null
    loadStore()
    root.hidden = false
    document.body.classList.add('people-open')
    requestAnimationFrame(() => root.classList.add('is-on'))
    document.activeElement?.blur?.()
    if (location.hash !== HASH) history.replaceState(null, '', HASH)
    load()
  }

  function close() {
    if (!open) return
    open = false
    root.classList.remove('is-on')
    root.hidden = true
    root.innerHTML = ''
    document.body.classList.remove('people-open')
    if (location.hash === HASH) history.replaceState(null, '', location.pathname + location.search)
    const kept = Object.keys(decisions).length
    if (kept && !sending) ui.toast(`${kept} ${plural(kept, 'rozhodnutie', 'rozhodnutia', 'rozhodnutí')} som si odložil. Zapíšem ich, keď stlačíš Hotovo.`, { iconName: 'people', ms: 5200 })
  }

  window.addEventListener('hashchange', () => (location.hash === HASH ? show() : close()))

  return {
    open: show,
    close,
    isOpen: () => open,
    /** Opens the review when the page was loaded with #ludia. */
    openFromHash() {
      if (location.hash === HASH) show()
    },
  }
}
