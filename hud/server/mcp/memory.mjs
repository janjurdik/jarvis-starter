#!/usr/bin/env node
/**
 * MCP server `memory` for the Jarvis HUD brain: reads and writes the local memory folder
 * (markdown notes about the user's life). Everything stays on the user's computer.
 *
 * Read tools send their data to the HUD as well, which turns them into a card and a camera
 * focus on its own (server/autocards.mjs), so Jarvis only has to talk.
 */
import '../env.mjs'
import { addEvent, calendarRange } from '../memory/calendar.mjs'
import { FILES, FOLDERS, addTodo, appendUnder, completeTodo, dayStats, findNote, getIndex, goals, logDay, search, slugify, stats, todos, writeNote } from '../memory/index.mjs'
import { DOW_LONG, addDays, dowOf, isoDay } from '../util.mjs'
import { READ_ONLY, serveMcp } from './stdio.mjs'
import { formatHits, search as searchMessages, thread as readThread } from '../../../scripts/import/search.mjs'

const dayArg = (v, fallback) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : fallback)
const fmtMin = (m) => (m === null || m === undefined ? '–' : `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min`)
const label = (day) => {
  const today = isoDay()
  const diff = Math.round((new Date(`${day}T12:00:00`) - new Date(`${today}T12:00:00`)) / 86_400_000)
  const rel = diff === 0 ? 'dnes' : diff === 1 ? 'zajtra' : diff === -1 ? 'včera' : diff === 2 ? 'pozajtra' : null
  return `${day} ${DOW_LONG[dowOf(day)]}${rel ? ` (${rel})` : ''}`
}

const HUD = (process.env.HUD_URL || '').replace(/\/$/, '')
const HUD_TOKEN = process.env.HUD_BRAIN_TOKEN || ''

/** Data for the automatic card and focus in the HUD. A HUD error never fails the tool. */
async function auto(tool, data) {
  if (!HUD || !HUD_TOKEN) return
  try {
    await fetch(`${HUD}/api/brain/hud`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-brain-token': HUD_TOKEN },
      body: JSON.stringify({ action: 'auto', tool, data }),
      signal: AbortSignal.timeout(1500),
    })
  } catch {
    // HUD is not running or the turn has ended
  }
}

/** Tells the HUD that memory changed, so panels and the 3D world refresh right away. */
async function changed() {
  if (!HUD || !HUD_TOKEN) return
  try {
    await fetch(`${HUD}/api/brain/hud`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-brain-token': HUD_TOKEN }, body: JSON.stringify({ action: 'memory_changed' }), signal: AbortSignal.timeout(1500) })
  } catch {
    // the next periodic refresh picks it up
  }
}

serveMcp({
  name: 'memory',
  version: '1.0.0',
  instructions: 'Osobná pamäť používateľa: priečinok markdown poznámok na jeho počítači (ľudia, projekty, ciele, denník, úlohy, kalendár). Čítanie aj zápis.',
  tools: [
    {
      name: 'calendar_list',
      description: 'Kalendár používateľa v rozsahu dní (udalosti z pamäte a pripojených iCal kalendárov, narodeniny a meniny jeho ľudí). Default dnes a zajtra. Časy sú miestne.',
      annotations: READ_ONLY,
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'YYYY-MM-DD, default dnes' },
          to: { type: 'string', description: 'YYYY-MM-DD vrátane, default from + 1 deň, max 62 dní' },
        },
      },
      handler: async (args) => {
        const from = dayArg(args.from, isoDay())
        let to = dayArg(args.to, addDays(from, 1))
        if (to < from) to = from
        if (to > addDays(from, 62)) to = addDays(from, 62)
        const events = await calendarRange(from, to)
        await auto('calendar_list', { from, to, events })
        if (!events.length) return `V kalendári od ${from} do ${to} nič nie je.`
        const lines = []
        let cur = null
        for (const e of events) {
          if (e.day !== cur) {
            cur = e.day
            lines.push(`\n## ${label(e.day)}`)
          }
          const when = e.allDay ? 'celý deň' : `${e.time}${e.end ? `–${e.end}` : ''}`
          lines.push(`- ${when} · ${e.title}${e.place ? ` · ${e.place}` : ''}${e.age ? ` (${e.age} r.)` : ''} [${e.kind}]`)
        }
        return lines.join('\n').trim()
      },
    },
    {
      name: 'upcoming_celebrations',
      description: 'Najbližšie narodeniny a meniny ľudí z pamäte (priečinok ludia). Default 30 dní dopredu.',
      annotations: READ_ONLY,
      inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 120 } } },
      handler: async ({ days }) => {
        const from = isoDay()
        const to = addDays(from, Math.min(120, Math.max(1, Number(days) || 30)))
        const events = (await calendarRange(from, to))
          .filter((e) => e.kind === 'birthday' || e.kind === 'nameday')
          .map((e) => {
            const diff = Math.round((new Date(`${e.day}T12:00:00`) - new Date(`${from}T12:00:00`)) / 86_400_000)
            return { ...e, when: diff === 0 ? 'dnes' : diff === 1 ? 'zajtra' : `o ${diff} dní` }
          })
        await auto('upcoming_celebrations', { events })
        if (!events.length) return 'V najbližších dňoch nikto z ľudí v pamäti neoslavuje. (Narodeniny sa berú z poľa narodeniny v poznámke človeka.)'
        return events.map((e) => `- ${e.day} (${e.when}) · ${e.person} · ${e.kind === 'birthday' ? `narodeniny${e.age ? `, ${e.age} r.` : ''}` : 'meniny'}`).join('\n')
      },
    },
    {
      name: 'view_todo',
      description: 'Otvorené úlohy používateľa (súbor ulohy.md), s termínmi a skupinami.',
      annotations: READ_ONLY,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const open = (await todos()).filter((t) => !t.done)
        const today = isoDay()
        const byGroup = new Map()
        for (const t of open) byGroup.set(t.group ?? 'Úlohy', [...(byGroup.get(t.group ?? 'Úlohy') ?? []), t])
        await auto('view_todo', { total: open.length, groups: [...byGroup].map(([name, list]) => ({ name, count: list.length })), items: open.slice(0, 8) })
        if (!open.length) return 'Žiadne otvorené úlohy.'
        return [...byGroup]
          .map(([name, list]) => `## ${name}\n${list.map((t) => `- ${t.text}${t.due ? ` (do ${t.due}${t.due < today ? ', PO TERMÍNE' : t.due === today ? ', DNES' : ''})` : ''}`).join('\n')}`)
          .join('\n\n')
      },
    },
    {
      name: 'list_goals',
      description: 'Ciele používateľa (priečinok ciele) so stavom a krokmi. status: active (default), all.',
      annotations: READ_ONLY,
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['active', 'all'] } } },
      handler: async ({ status }) => {
        const all = goals(await getIndex())
        const list = status === 'all' ? all : all.filter((g) => g.status === 'active')
        await auto('list_goals', { status: status ?? 'active', quests: list })
        if (!list.length) return 'V pamäti nie sú žiadne ciele. Nový cieľ vznikne ako poznámka v priečinku ciele (write_note).'
        return list.map((g) => `- ${g.name} [${g.status}] ${g.stepsDone}/${g.stepsTotal} krokov${g.nextStep ? ` · ďalší krok: ${g.nextStep}` : ''}${g.goal ? ` · ${g.goal}` : ''} (${g.rel})`).join('\n')
      },
    },
    {
      name: 'get_health',
      description: 'Spánok a nálada z denníka za posledné dni (používateľ ich hovorí Jarvisovi, zapisujú sa cez log_day). Default 7 dní.',
      annotations: READ_ONLY,
      inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 60 } } },
      handler: async ({ days }) => {
        const n = Math.min(60, Math.max(1, Number(days) || 7))
        const list = dayStats(await getIndex(), { since: addDays(isoDay(), -n) })
        await auto('get_health', { days: list.map((d) => ({ day: d.day, sleepMin: d.sleepMin, score: d.sleepMin ? Math.round(Math.min(1, d.sleepMin / 480) * 100) : null })) })
        const withData = list.filter((d) => d.sleepMin || d.mood)
        if (!withData.length) return 'V denníku zatiaľ nie je spánok ani nálada. Zapíšu sa, keď používateľ povie, ako spal (log_day so sleepHours) alebo akú má náladu (mood 1 až 5).'
        return withData.map((d) => `- ${label(d.day)} · spánok ${fmtMin(d.sleepMin)}${d.mood ? ` · nálada ${d.mood}/5` : ''}`).join('\n')
      },
    },
    {
      name: 'memory_stats',
      description: 'Koľko toho je v pamäti: počet poznámok, ľudí, projektov, cieľov, dní v denníku, slov.',
      annotations: READ_ONLY,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const s = stats(await getIndex())
        await auto('memory_stats', s)
        return `Poznámok ${s.notes} (${s.words} slov), ľudí ${s.people}, projektov ${s.projects}, cieľov ${s.goals}, dní v denníku ${s.days}, ostatných poznámok ${s.other}. Najstaršia z ${s.since ?? '–'}.`
      },
    },
    {
      name: 'search_notes',
      description: 'Hľadá v celej pamäti (názvy aj text poznámok): ľudia, projekty, ciele, denník, poznámky. Vráti najlepšie zhody s úryvkom a cestou pre read_note.',
      annotations: READ_ONLY,
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'] },
      handler: async ({ query, limit }) => {
        const hits = search(await getIndex(), String(query ?? ''), { limit: Math.min(20, Number(limit) || 8) })
        if (!hits.length) return `V pamäti som k „${query}" nič nenašiel.`
        return hits.map((h) => `- ${h.title} [${h.kind}] (${h.rel})\n  ${h.snippet}`).join('\n')
      },
    },
    {
      name: 'read_note',
      description: 'Prečíta jednu poznámku z pamäte. path je cesta (napr. ludia/Meno Priezvisko.md, dennik/2026-01-31.md, ja.md) alebo názov poznámky.',
      annotations: READ_ONLY,
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async ({ path }) => {
        const ix = await getIndex()
        const note = findNote(ix, String(path ?? ''))
        if (!note) return { text: `Poznámku „${path}" v pamäti nemám. Skús search_notes.`, isError: true }
        const meta = Object.entries(note.fm).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ')
        return `# ${note.title} (${note.rel})${meta ? `\n${meta}` : ''}\n\n${note.body.slice(0, 6000)}${note.body.length > 6000 ? '\n… (skrátené)' : ''}`
      },
    },
    {
      name: 'search_messages',
      description:
        'Hľadá v importovaných konverzáciách používateľa (Instagram, Messenger, WhatsApp, Discord, Telegram, rozhovory s ChatGPT a Claude). Nezáleží na veľkosti písmen ani na diakritike. query = hľadaný text (môže byť prázdny, ak je zadaná person: vtedy vráti jej najnovšie správy). person = meno človeka, source = len jeden zdroj, from a to = dátumy YYYY-MM-DD. Vráti najnovšie zhody s dvoma správami pred a po a s id vlákna pre read_thread.',
      annotations: READ_ONLY,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          person: { type: 'string' },
          source: { type: 'string', enum: ['instagram', 'facebook', 'whatsapp', 'discord', 'telegram', 'chatgpt', 'claude'] },
          from: { type: 'string', description: 'YYYY-MM-DD' },
          to: { type: 'string', description: 'YYYY-MM-DD' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
      handler: async ({ query, person, source, from, to, limit }) => {
        const opts = { person: person || null, source: source || null, from: dayArg(from, null), to: dayArg(to, null), limit: Math.min(50, Number(limit) || 10) }
        const q = String(query ?? '').trim()
        let res = await searchMessages(q, opts)
        let note = ''
        // Slovak words change their endings ("Žilina", "v Žiline"): one word without its last vowel finds them all
        const stem = /^\S{5,}$/.test(q) ? q.replace(/[aáeéiíoóuúyý]+$/i, '') : q
        if (!res.hits.length && stem !== q && stem.length >= 4) {
          res = await searchMessages(stem, opts)
          note = ` (hľadal som aj iné tvary slova: „${stem}")`
        }
        if (!res.hits.length) return `V importovaných konverzáciách som k „${q || person || ''}" nič nenašiel. Skús kratší výraz alebo len koreň slova.`
        return `Zhôd spolu: ${res.total}, ukazujem ${res.hits.length} najnovších${note}.\n\n${formatHits(res)}`
      },
    },
    {
      name: 'read_thread',
      description:
        'Prečíta časť jednej importovanej konverzácie. source a thread sú z výsledku search_messages (thread je id vlákna). around = dátum alebo čas (YYYY-MM-DD alebo ISO), okolo ktorého má čítať; bez neho vráti najnovšie správy. limit = počet správ, default 60.',
      annotations: READ_ONLY,
      inputSchema: {
        type: 'object',
        properties: { source: { type: 'string' }, thread: { type: 'string' }, around: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
        required: ['source', 'thread'],
      },
      handler: async ({ source, thread, around, limit }) => {
        const res = await readThread(String(source ?? ''), String(thread ?? ''), { around: around || null, limit: Math.min(200, Number(limit) || 60) })
        const local = (t) => new Date(t).toLocaleString('sv-SE').slice(0, 16)
        const lines = res.messages.map((m) => `${local(m.t)} ${m.from || 'systém'}: ${(m.text || `[${m.type}]`).slice(0, 1500)}`)
        return `# ${res.title} (${res.source}, ${res.kind}, spolu ${res.total} správ, ukazujem ${res.messages.length})\n\n${lines.join('\n')}`
      },
    },
    {
      name: 'remember',
      description:
        'Zapíše nový trvalý fakt do pamäte. about = koho alebo čoho sa týka: prázdne alebo "ja" = používateľ sám (ja.md), meno človeka = jeho poznámka v ludia (vytvorí sa, ak nie je), názov projektu = poznámka v projekty. fact = jedna veta. Pre nového človeka pridaj relation (napr. rodina, priateľ, kolega, klient) a ak vieš, birthday (YYYY-MM-DD alebo MM-DD).',
      inputSchema: {
        type: 'object',
        properties: { fact: { type: 'string' }, about: { type: 'string' }, kind: { type: 'string', enum: ['me', 'person', 'project'] }, relation: { type: 'string' }, birthday: { type: 'string' } },
        required: ['fact'],
      },
      handler: async ({ fact, about, kind, relation, birthday }) => {
        const line = `- ${isoDay()}: ${String(fact).trim()}`
        const target = String(about ?? '').trim()
        if (!target || /^(ja|me|používateľ|pouzivatel)$/i.test(target) || kind === 'me') {
          await appendUnder(FILES.me, 'Zapamätané', line)
          await changed()
          return 'Zapísané do ja.md.'
        }
        const ix = await getIndex()
        const hit = findNote(ix, target) ?? ix.list.find((n) => (n.kind === 'person' || n.kind === 'project') && slugify(n.title).includes(slugify(target)))
        if (hit) {
          await appendUnder(hit.rel, 'Zapamätané', line)
          await changed()
          return `Zapísané do ${hit.rel}.`
        }
        const isProject = kind === 'project'
        const rel = `${isProject ? FOLDERS.projects : FOLDERS.people}/${target.replace(/[\\/:*?"<>|]/g, ' ').trim()}.md`
        const fm = isProject ? ['stav: aktívny'] : [relation ? `vztah: ${relation}` : null, birthday ? `narodeniny: ${birthday}` : null].filter(Boolean)
        await writeNote(rel, `${fm.length ? `---\n${fm.join('\n')}\n---\n` : ''}# ${target}\n\n## Zapamätané\n\n${line}`, { mode: 'create' })
        await changed()
        return `Vytvoril som ${rel} a zapísal fakt.`
      },
    },
    {
      name: 'add_todo',
      description: 'Pridá úlohu do ulohy.md. due je voliteľný termín YYYY-MM-DD.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' }, due: { type: 'string' } }, required: ['text'] },
      handler: async ({ text, due }) => {
        const line = await addTodo(String(text), dayArg(due, null))
        await changed()
        return `Pridané: ${line}`
      },
    },
    {
      name: 'remind',
      description:
        'Nastaví pripomienku: v daný deň a čas ju Jarvis sám povie nahlas, bez toho, aby sa používateľ pýtal. Použi na „pripomeň mi…". day YYYY-MM-DD, time HH:MM (24 h). call: true, keď mu máš v ten čas aj zavolať na mobil („zavolaj mi o tretej a pripomeň…", alebo keď to nesmie zmeškať). Na udalosti s trvaním použi add_event.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' }, day: { type: 'string' }, time: { type: 'string' }, call: { type: 'boolean' } }, required: ['text', 'day', 'time'] },
      handler: async ({ text, day, time, call }) => {
        const d = dayArg(day, null)
        const t = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(time ?? '')) ? String(time).padStart(5, '0') : null
        const what = String(text ?? '').replace(/\s+/g, ' ').trim()
        if (!d || !t || !what) return { text: 'Pripomienka potrebuje text, deň (YYYY-MM-DD) a čas (HH:MM).', isError: true }
        await appendUnder('pripomienky.md', 'Pripomienky', `- [ ] ${d} ${t} ${call === true ? '!' : ''}${what.replace(/^!+\s*/, '')}`)
        await changed()
        return `Pripomeniem ${label(d)} o ${t}${call === true ? ' aj telefonátom' : ''}: ${what}`
      },
    },
    {
      name: 'complete_todo',
      description: 'Odškrtne otvorenú úlohu, ktorej text obsahuje match.',
      inputSchema: { type: 'object', properties: { match: { type: 'string' } }, required: ['match'] },
      handler: async ({ match }) => {
        const done = await completeTodo(String(match ?? ''))
        if (!done) return { text: `Otvorenú úlohu s „${match}" som nenašiel.`, isError: true }
        await changed()
        return `Hotovo: ${done}`
      },
    },
    {
      name: 'add_event',
      description: 'Pridá udalosť do kalendára v pamäti (kalendar.md). day YYYY-MM-DD, time a end HH:MM sú voliteľné (bez času = celý deň).',
      inputSchema: {
        type: 'object',
        properties: { day: { type: 'string' }, time: { type: 'string' }, end: { type: 'string' }, title: { type: 'string' }, place: { type: 'string' } },
        required: ['day', 'title'],
      },
      handler: async ({ day, time, end, title, place }) => {
        const d = dayArg(day, null)
        if (!d) return { text: 'day musí byť YYYY-MM-DD', isError: true }
        const hm = (v) => (/^\d{1,2}:\d{2}$/.test(String(v ?? '')) ? String(v).padStart(5, '0') : null)
        const line = await addEvent({ day: d, time: hm(time), end: hm(end), title, place })
        await changed()
        return `Pridané do kalendára: ${line}`
      },
    },
    {
      name: 'log_day',
      description: 'Zapíše do denníka (dennik/YYYY-MM-DD.md): text = čo sa stalo (jedna veta), sleepHours = koľko hodín spal (napr. 7.5), mood = nálada 1 až 5. Všetko voliteľné, default dnešný deň.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, sleepHours: { type: 'number' }, mood: { type: 'number' }, day: { type: 'string' } },
      },
      handler: async ({ text, sleepHours, mood, day }) => {
        const rel = await logDay({ day: dayArg(day, isoDay()), text: String(text ?? ''), sleepHours: sleepHours ?? null, mood: mood ?? null })
        await changed()
        return `Zapísané do ${rel}.`
      },
    },
    {
      name: 'write_note',
      description: 'Vytvorí alebo doplní poznámku v pamäti. path napr. poznamky/Nápad na appku.md, ciele/Zabehnúť polmaratón.md (kroky ako "- [ ] krok"), projekty/Názov.md. mode: append (default, pridá na koniec), create (nová), replace (prepíše celú).',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' }, mode: { type: 'string', enum: ['append', 'create', 'replace'] } },
        required: ['path', 'content'],
      },
      handler: async ({ path, content, mode }) => {
        const rel = await writeNote(String(path), String(content ?? ''), { mode: mode ?? 'append' })
        await changed()
        return `Uložené: ${rel}`
      },
    },
  ],
})

