#!/usr/bin/env node
/**
 * MCP server jarvis-hud: Jarvis shows things in the HUD. Calls the loopback API of the HUD server
 * (POST /api/brain/hud with a token), which turns it into SSE `world`, `chat card` and `hud`.
 *
 *   hud_focus(node, caption?)   the camera of the 3D world flies to a node
 *   hud_card(kind, title, …)    a rich card in the chat
 *   hud_log(text, icon?, type?) a line in the LOG
 *   show_media(paths, title?)  photos, videos, audio as floating cards on the screen (server/shown-media.mjs)
 *   weather(place?, days?)      weather (Open-Meteo through the HUD server)
 *   agent_task / agent_jobs / agent_reply / agent_stop   background jobs (full Claude Code)
 *   set_alarm(time?, days?, call?, off?)   the alarm clock (scripts/alarm.mjs)
 *   watch(action, …)            stráže, „daj mi vedieť, keď…" (scripts/watch.mjs, docs/STRAZE.md)
 *   settings(set?)              voice, assistant's name and gender, how the user is addressed (server/settings.mjs)
 *   video_open / video_seek / video_transcript / video_info / video_control / video_close, set_alarm_sound   (video-tools.mjs)
 *   record_start(title?) / record_stop / record_status   record mode (server/record.mjs)
 */
import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { READ_ONLY, serveMcp } from './stdio.mjs'
import { videoTools } from './video-tools.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Runs scripts/alarm.mjs with --json and returns its answer. */
function alarmScript(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(REPO, 'scripts', 'alarm.mjs'), ...args, '--json'], { cwd: REPO, timeout: 120_000, windowsHide: true }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1)))
      } catch {
        resolve({ ok: false, summary: `Budík sa nepodarilo nastaviť: ${String(err?.message ?? stdout).slice(0, 200)}` })
      }
    })
  })
}

const HUD = (process.env.HUD_URL || 'http://127.0.0.1:4545').replace(/\/$/, '')
/** The port of this HUD, so scripts/watch.mjs reports to the same instance. */
const HUD_PORT = (/:(\d+)$/.exec(HUD) ?? [])[1] ?? null
const hudEnv = () => ({ ...process.env, ...(HUD_PORT ? { PORT: HUD_PORT } : {}) })

/** Runs scripts/watch.mjs with --json against this HUD and returns its answer. */
function watchScript(args) {
  return new Promise((resolve) => {
    // --json right after the command: everything after a `--` is the sentence.
    execFile(process.execPath, [join(REPO, 'scripts', 'watch.mjs'), args[0], '--json', ...args.slice(1)], { cwd: REPO, timeout: 60_000, windowsHide: true, env: hudEnv() }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1)))
      } catch {
        resolve({ ok: false, error: String(err?.message ?? stdout).slice(0, 200) })
      }
    })
  })
}
// The token comes in the environment (Claude) or in a file only this user can read (Codex: its MCP settings are process arguments).
function brainToken() {
  if (process.env.HUD_BRAIN_TOKEN) return process.env.HUD_BRAIN_TOKEN
  try {
    return process.env.HUD_BRAIN_TOKEN_FILE ? readFileSync(process.env.HUD_BRAIN_TOKEN_FILE, 'utf8').trim() : ''
  } catch {
    return ''
  }
}
const TOKEN = brainToken()
const NODES = ['ludia', 'projekty', 'questy', 'kalendar', 'rutiny', 'udalosti', 'spravy', 'fotky', 'spanok', 'ulohy', 'posta', 'appky']
const ICONS = ['calendar', 'moon', 'heart', 'message', 'photo', 'check', 'quest', 'search', 'book', 'globe', 'bolt', 'music', 'volume', 'chart', 'memory', 'eye', 'info', 'alarm', 'gift', 'routine', 'cloud', 'sun', 'code', 'wave', 'shield']

async function hud(action, body) {
  const res = await fetch(`${HUD}/api/brain/hud`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-brain-token': TOKEN },
    body: JSON.stringify({ action, ...body }),
    signal: AbortSignal.timeout(5000),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json.ok) return { text: `HUD odmietol: ${json.error ?? res.status}`, isError: true }
  return json
}

serveMcp({
  name: 'jarvis-hud',
  instructions: 'Nástroje HUD: focus 3D sveta, karty v chate, LOG, počasie, úlohy na pozadí.',
  tools: [
    {
      name: 'hud_focus',
      description:
        'Presunie kameru 3D sveta HUD k uzlu, o ktorom práve hovoríš (napr. pri ľuďoch ludia, pri kalendári kalendar). Volaj raz za odpoveď, keď sa odpoveď týka jedného uzla. node=null vráti kameru do autopilota.',
      inputSchema: {
        type: 'object',
        properties: {
          node: { type: ['string', 'null'], enum: [...NODES, null], description: 'ludia, projekty, questy (ciele), kalendar, rutiny, udalosti (denník), spravy (rozhovory), fotky (poznámky), spanok, ulohy, posta, appky (Tvoje appky)' },
          caption: { type: 'string', description: 'Krátky popis pri uzle, max 60 znakov, bez mien ľudí v režime natáčania.' },
        },
        required: ['node'],
      },
      handler: async ({ node, caption }) => {
        const r = await hud('focus', { node: node ?? null, caption })
        return r.isError ? r : 'OK'
      },
    },
    {
      name: 'hud_card',
      description:
        'Ukáže bohatú kartu v chate HUD. Presné čísla, časy a zoznamy patria SEM, hovorená odpoveď ich len zhrnie. kind: stat (veľké value + unit + caption), list (items: label, value, sub), chart (series: label + číselná value, napr. minúty spánku po dňoch), text (text do 400 znakov). Max 8 items, 14 series.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['stat', 'list', 'chart', 'text'] },
          title: { type: 'string', description: 'Nadpis karty, veta, nie verzálky, max 60 znakov.' },
          icon: { type: 'string', enum: ICONS },
          node: { type: 'string', enum: NODES, description: 'Uzol 3D sveta, ku ktorému karta patrí.' },
          value: { type: 'string', description: 'Hlavné číslo (stat), napr. "6 h 20 min" alebo "42".' },
          unit: { type: 'string' },
          caption: { type: 'string', description: 'Podnadpis, max 80 znakov.' },
          items: {
            type: 'array',
            maxItems: 8,
            items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' }, sub: { type: 'string' } }, required: ['label'] },
          },
          series: {
            type: 'array',
            maxItems: 14,
            items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } }, required: ['label', 'value'] },
          },
          accent: { type: 'string', enum: ['ice', 'amber', 'red'], description: 'ice = bežné, amber = pozornosť / najbližšia vec, red = problém.' },
          text: { type: 'string', description: 'Len pre kind=text.' },
        },
        required: ['kind', 'title'],
      },
      handler: async (card) => {
        const r = await hud('card', { card })
        return r.isError ? r : 'Karta je na obrazovke. Ak si odpoveď už povedal, skonči bez ďalšieho textu, nič neopakuj.'
      },
    },
    {
      name: 'show_media',
      description:
        'Ukáže fotky, videá a zvuk na obrazovke Jarvisa: každý súbor ako vlastnú plávajúcu kartu (video hrá hneď, bez zvuku, klik zapne zvuk) a v rozhovore ako náhľady. Viac súborov naraz je v poriadku (najviac 24). Na „ukáž mi…", „pusti mi to video", a vždy, keď je výsledkom fotka, video alebo zvuk: cestu k súboru vtedy nečítaj ani nepíš, stačí jedna veta o tom, čo ukazuješ. paths = plné cesty k súborom (aj ~/…), title = krátky nadpis.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', minItems: 1, maxItems: 24, items: { type: 'string' }, description: 'Plné cesty k fotkám (png, jpg, heic, gif, webp), videám (mp4, mov, m4v, webm) alebo zvuku (mp3, m4a, wav).' },
          title: { type: 'string', description: 'Krátky nadpis, napríklad „Reel pre Instagram", max 60 znakov.' },
        },
        required: ['paths'],
      },
      handler: async ({ paths, title }) => {
        const r = await hud('media', { paths: Array.isArray(paths) ? paths : [paths], title })
        if (r.isError) return r
        const kinds = { image: 0, video: 0, audio: 0 }
        for (const x of r.shown ?? []) kinds[x.kind] = (kinds[x.kind] ?? 0) + 1
        const what = [kinds.video && `${kinds.video} video`, kinds.image && `${kinds.image} fotky`, kinds.audio && `${kinds.audio} zvuk`].filter(Boolean).join(', ')
        return `Na obrazovke: ${what}.${r.skipped?.length ? ` Neukázal som: ${r.skipped.join(', ')}.` : ''} Cesty k súborom nehovor, povedz len jednu vetu o tom, čo ukazuješ.`
      },
    },
    {
      name: 'hud_log',
      description: 'Pridá krátky záznam do LOGu v HUD (napr. čo si práve spravil). Max 140 znakov.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          icon: { type: 'string', enum: ICONS },
          type: { type: 'string', enum: ['info', 'action', 'alert', 'done'] },
          node: { type: 'string', enum: NODES },
        },
        required: ['text'],
      },
      handler: async (body) => {
        const r = await hud('log', body)
        return r.isError ? r : 'Zapísané v LOGu.'
      },
    },
    {
      name: 'agent_task',
      description:
        'Spustí úlohu na pozadí: plnohodnotný Claude Code v priečinku Jarvisa (súbory a pamäť, web, pripojené konektory ako mail a kalendár). Na všetko, čo je reálna práca na viac krokov: rešerš, dokument, upratanie poznámok, príprava mailu. Vráti hneď id, výsledok HUD ohlási sám. task = úplné zadanie v jednej až pár vetách (čo, kde, kedy je hotovo), title = 2 až 5 slov, weight = aká je úloha ťažká (podľa toho sa vyberie model).',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          title: { type: 'string', description: 'Krátky názov, 2 až 5 slov.' },
          weight: { type: 'string', enum: ['light', 'normal', 'heavy'], description: 'light = pozrieť, zistiť, skontrolovať, zhrnúť (rýchly model). heavy = vytvoriť, napísať, naprogramovať, analyzovať, naplánovať (najsilnejší model). normal = všetko medzi tým.' },
        },
        required: ['task', 'title', 'weight'],
      },
      handler: async ({ task, title, weight }) => {
        const r = await hud('job_task', { task, title, weight })
        return r.isError ? r : `Úloha ${r.job.id} „${r.job.title}" ${r.job.status === 'queued' ? 'čaká vo fronte' : 'beží'}. Povedz jednu vetu, že si sa do toho pustil, a skonči. O náročnosti úlohy ani o modeli nehovor, používateľ ich vidí pri úlohe sám. Výsledok HUD ohlási sám.`
      },
    },
    {
      name: 'call_user',
      description:
        'Zavolá používateľovi na mobil a povie mu text (skutočný telefonát). Len keď o to sám požiada („zavolaj mi", „povedz mi to do telefónu") alebo keď ide o niečo súrne a pri počítači nie je. text sú jedna až tri vety, ako by si ich povedal nahlas.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      handler: async ({ text }) => {
        const r = await hud('call', { text })
        return r.isError ? r : 'Volám. Povedz jednu vetu a skonči.'
      },
    },
    {
      name: 'agent_jobs',
      description: 'Zoznam úloh na pozadí so stavom (queued, running, needs_ok, done, error, stopped), aktuálnym krokom a zhrnutím.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const r = await hud('job_list', {})
        if (r.isError) return r
        return r.jobs.length
          ? r.jobs.slice(0, 12).map((j) => `${j.id} „${j.title}" ${j.status} · ${j.step ?? ''}${j.needsOk ? ` · ${j.wait === 'question' ? 'čaká na odpoveď na otázku' : 'čaká na súhlas'}: ${j.needsOk}` : ''}${j.summary ? ` · ${j.summary.slice(0, 200)}` : ''}`).join('\n')
          : 'Žiadne úlohy.'
      },
    },
    {
      name: 'agent_reply',
      description: 'Pokračuje v skončenej úlohe tou istou session: odpoveď na jej otázku, doplnenie, oprava alebo schválenie. Keď čaká na odpoveď na otázku, pošli používateľovu odpoveď celú, s tým, čo z rozhovoru vyplýva (napr. "Používateľ odpovedal: účet sa volá @kaviaren.sk."). Keď čaká na súhlas a používateľ povie „pošli to" alebo „súhlasím", pošli jasné schválenie, napr. "Schválené: pošli presne pripravené znenie." Keď chce zmenu, pošli tú zmenu.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
      handler: async ({ id, text }) => {
        const r = await hud('job_reply', { id, text })
        return r.isError ? r : `Úloha ${id} pokračuje.`
      },
    },
    {
      name: 'agent_stop',
      description: 'Zastaví bežiacu alebo čakajúcu úlohu.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async ({ id }) => {
        const r = await hud('job_stop', { id })
        return r.isError ? r : `Úloha ${id} zastavená.`
      },
    },
    {
      name: 'setup_note',
      description:
        'Zapíše, kde je úvodné nastavenie. Volaj hneď, keď je krok hotový alebo niečo čaká na používateľa. done: hotové kroky (sken, oslovenie, ciel, appky, posta, kalendar, ulohy, budik, samostatnost, prva-vec). waiting: veci, ktoré musí spraviť on (napr. "pripojiť Gmail v Claude"). resolved: čo z čakajúcich už vybavil. goal: jeho odpoveď na otázku, čo máš robiť ako prvé. finished: true, keď je základ hotový. Bez parametrov vráti stav.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'array', items: { type: 'string' } },
          waiting: { type: 'array', items: { type: 'string' } },
          resolved: { type: 'array', items: { type: 'string' } },
          goal: { type: 'string' },
          finished: { type: 'boolean' },
        },
      },
      handler: async (note) => {
        const r = await hud('setup', { note })
        if (r.isError) return r
        const s = r.setup
        return s.done ? 'Nastavenie je uzavreté.' : `Hotové: ${s.hotove.join(', ') || 'nič'}. Ďalší krok: ${s.next ?? 'ukončiť nastavenie (finished: true)'}.${s.caka.length ? ` Čaká na neho: ${s.caka.join('; ')}.` : ''}`
      },
    },
    {
      name: 'suggest',
      description:
        'Tvoj zoznam odporúčaní: čo by sa používateľovi oplatilo pridať, podľa toho, čo si si všimol (v pošte chodia faktúry, na počítači je appka, ktorú nemáš pripojenú, opakuje sa mu rovnaká práca). Odporúčanie sa ukáže na ploche a on naň stačí kliknúť. Pridaj ho, keď si niečo také všimneš, aj keď sa na to nepýtal: title = čo pridať (2 až 5 slov), why = jedna veta, z čoho to vidíš, say = veta, ktorou ti to zadá. Keď je vec hotová alebo ju nechce, pošli done s jej id.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Čo pridať, 2 až 5 slov, napríklad Orb Financie.' },
          why: { type: 'string', description: 'Jedna veta: z čoho to vidíš a čo mu to dá.' },
          say: { type: 'string', description: 'Veta, ktorú ti má povedať, aby si to spravil, napríklad: Sprav mi orb Financie z faktúr v pošte.' },
          done: { type: 'string', description: 'Id odporúčania, ktoré je vybavené alebo ho nechce.' },
        },
      },
      handler: async ({ title, why, say, done }) => {
        const r = await hud('suggest', done ? { done } : { idea: { title, why, say } })
        return r.isError ? r : `Na zozname je ${r.items.length} odporúčaní: ${r.items.map((i) => `${i.title} (${i.id})`).join(', ') || 'nič'}.`
      },
    },
    {
      name: 'hud_orb',
      description:
        'Mení orby 3D sveta, teda tvoje vlastné rozhranie. Keď používateľ chce sledovať niečo nové (financie, návyky, tréning, čítanie, objednávky), pridaj mu na to orb a naplň ho. action: add (nový orb: id, label, voliteľne icon, color, shape, kind, folder), content (čo orb ukazuje: content je objekt { value, sub, items, panel }), hide a show (skryť alebo vrátiť ktorýkoľvek orb, aj vstavaný: posta, kalendar, ulohy, rutiny, questy, spanok, ludia, udalosti, fotky, projekty, spravy), remove (zmazať vlastný orb), clear (zmazať obsah). panel je zoznam hotových komponentov: { type: "stat", label, value, unit?, caption? }, { type: "ring", label, value 0-100 }, { type: "bars", title?, items: [{ label, value }] }, { type: "spark", title?, series: [{ label, value }] }, { type: "list", title?, items: [{ label, sub?, value?, say? }] }, { type: "steps", title?, items: [{ text, done }] }, { type: "text", title?, text }, { type: "actions", items: [{ label, say }] }. say je veta, ktorú klik pošle tebe. accent: ice, amber, red, green. Celý slovník je v docs/ORBY.md.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'update', 'content', 'hide', 'show', 'remove', 'clear'] },
          id: { type: 'string', description: 'Krátke id bez diakritiky, malé písmená a pomlčky, napr. "financie".' },
          label: { type: 'string', description: 'Názov pri orbe, najviac 24 znakov.' },
          icon: { type: 'string', description: 'info, mail, todo, kalendar, people, heart, chart, book, music, film, globe, code, note, folder, bell, flag, sparkle, bolt, shield, search, phone, card, coffee, cap, pin, news, gift, play, app, laptop, route, hourglass, check, alarm, sun, cloud, memory, eye, target, link, archive' },
          color: { type: 'string', description: 'Farba ako #rrggbb. Bez zadania ľadová modrá.' },
          shape: { type: 'string', description: 'Hologram orbu: orb, posta, ludia, skola, knihy, filmy, miesta, hudba, satnik, zdroje, hry, ulohy, content, kalendar, rutiny, projekty, questy, spravy, fotky, udalosti, spanok.' },
          kind: { type: 'string', enum: ['planet', 'moon'], description: 'planet = veľký orb na vonkajšom kruhu (predvolené), moon = malý pri jadre.' },
          folder: { type: 'string', description: 'Priečinok v pamäti (memory/<folder>/), ktorého poznámky sa ukážu vnútri orbu.' },
          content: { type: 'object', description: '{ value?, sub?, alert?, items?: [{ t, s?, g?, imp? }], groups?, panel?: [komponenty] }' },
        },
        required: ['action', 'id'],
      },
      handler: async (orb) => {
        const r = await hud('orb', { orb })
        return r.isError ? r : `${r.summary} Povedz to jednou vetou.`
      },
    },
    {
      name: 'watch',
      description:
        'Stráže: „daj mi vedieť, keď…", „sleduj mi…", „upozorni ma, keď…". Stráž sama kontroluje na pozadí a ozve sa len vtedy, keď podmienka naozaj nastane (karta, hlas, oznámenie, pri call aj telefonát). action add: najprv sám zisti, kde sa to dá overiť (konkrétna stránka s adresou, konektor ako Gmail, vyhľadávanie), a do check napíš presný plán: odkiaľ, čo tam nájsť a kedy je podmienka splnená (napríklad „Otvor https://www.kiwi.com/sk/…, lety Viedeň Londýn na najbližších 30 dní, najnižšia cena v €; splnené, keď je pod 80 €"). what je jeho veta. every v minútach podľa povahy veci (odpoveď na správu 15, kurz 30, cena alebo inzeráty 60, zásielka 120, zmena stránky 180). until, keď to má koniec (2026-12-31 alebo +7d). once false pri „vždy, keď…". call true, keď chce aj zavolať. urgent true, len keď to má strážiť aj v noci. list: zoznam s id a stavom. pause, resume, remove a run (kontrola hneď) potrebujú id. edit: id a len to, čo sa mení.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'pause', 'resume', 'remove', 'edit', 'run'] },
          id: { type: 'string', description: 'Id stráže zo zoznamu, napríklad "s3".' },
          what: { type: 'string', description: 'Čo stráži, jeho vetou: „keď zlacnie let Viedeň Londýn pod 80 €".' },
          check: { type: 'string', description: 'Konkrétny plán kontroly: zdroj (adresa, konektor, hľadanie), čo tam čítať a kedy je splnené.' },
          every: { type: 'integer', minimum: 5, description: 'Ako často kontrolovať, v minútach.' },
          until: { type: 'string', description: 'Dokedy stráži: 2026-12-31, "2026-12-31 18:00" alebo +7d, +12h. Prázdne = bez konca.' },
          between: { type: 'string', description: 'Len v tomto okne, napríklad "08:00-22:00". Prázdne = celý deň.' },
          once: { type: 'boolean', description: 'true = ozve sa raz a skončí (predvolené), false = pri každej novej zhode.' },
          call: { type: 'boolean', description: 'true = pri zhode aj zavolá na mobil (keď sú hovory nastavené).' },
          quiet: { type: 'boolean', description: 'true = len karta a oznámenie, bez hlasu.' },
          urgent: { type: 'boolean', description: 'true = kontroluje a ozve sa aj v tichých hodinách.' },
        },
        required: ['action'],
      },
      handler: async ({ action, id, what, check, every, until, between, once, call, quiet, urgent }) => {
        if (action === 'list') {
          const r = await watchScript(['list'])
          if (!r.ok) return { text: r.error ?? 'Stráže sa nepodarilo načítať.', isError: true }
          return r.watches.length
            ? r.watches.map((w) => `${w.id} „${w.what}" ${w.status}, každých ${w.every} min${w.state?.lastHit ? `, zhoda: ${w.state.lastHit}` : w.state?.observation ? `, naposledy: ${w.state.observation}` : ''}${w.state?.lastError ? `, chyba: ${w.state.lastError}` : ''}`).join('\n')
            : 'Žiadne stráže.'
        }
        if (action === 'run') {
          if (!id) return { text: 'run potrebuje id stráže.', isError: true }
          // A check takes a while: it runs on its own and a hit is announced like any other.
          spawn(process.execPath, [join(REPO, 'scripts', 'watch.mjs'), 'run', String(id)], { cwd: REPO, detached: true, stdio: 'ignore', windowsHide: true, env: hudEnv() }).on('error', () => {}).unref()
          return 'Kontrola beží. Povedz jednu vetu: keď to nastalo, ohlási sa to samo, inak je výsledok v orbe Stráže.'
        }
        const opt = [
          ...(what !== undefined && action === 'edit' ? ['--what', String(what)] : []),
          ...(check !== undefined ? ['--check', String(check)] : []),
          ...(every !== undefined ? ['--every', String(every)] : []),
          ...(until !== undefined ? ['--until', String(until) || 'nie'] : []),
          ...(between !== undefined ? ['--between', String(between) || 'nie'] : []),
          ...(once === true ? ['--once'] : once === false ? ['--repeat'] : []),
          ...(call === true ? ['--call'] : quiet === true ? ['--quiet'] : call === false || quiet === false ? ['--voice'] : []),
          ...(urgent === true ? ['--urgent'] : urgent === false && action === 'edit' ? ['--not-urgent'] : []),
        ]
        // add: was it the user's own request in the HUD (then the brain confirms it aloud), or Jarvis on his own (then it is announced)?
        const from = action === 'add' && (await hud('turn', {}).catch(() => null))?.user === true ? ['--from', 'hud'] : []
        // The sentence goes after `--`: words starting with -- stay words, never flags.
        const args = action === 'add' ? ['add', ...opt, ...from, '--', String(what ?? '')] : action === 'edit' ? ['edit', String(id ?? ''), ...opt] : [String(action), '--', String(id ?? '')]
        const r = await watchScript(args)
        if (!r.ok) return { text: r.error ?? 'Stráž sa nepodarilo zmeniť.', isError: true }
        return action === 'add' ? `${r.summary} Potvrď jednou vetou, čo strážiš a ako často. Plán kontroly ani model nahlas nečítaj.` : `${r.summary} Povedz to jednou vetou.`
      },
    },
    {
      name: 'set_alarm',
      description:
        'Budík: ráno v daný čas Jarvis zazvoní a povie nahlas ranný brief (spánok, ak je známy, počasie, kalendár, termíny, čo spravil cez noc), aj keď je HUD zatvorený. Na „zobuď ma o…", „budík na…", „zruš budík". Bez parametrov povie, ako je nastavený.',
      inputSchema: {
        type: 'object',
        properties: {
          time: { type: 'string', description: 'Čas HH:MM v 24-hodinovom tvare, napr. "06:30".' },
          days: { type: 'string', description: 'daily (každý deň), weekdays (pondelok až piatok), weekend, alebo zoznam po,ut,st,št,pi,so,ne. Bez zadania ostane, ako bolo.' },
          call: { type: 'boolean', description: 'true = budík mu aj zavolá na mobil (ak má nastavené hovory).' },
          off: { type: 'boolean', description: 'true = vypnúť budík.' },
        },
      },
      handler: async ({ time, days, call, off }) => {
        const args = off ? ['off'] : time ? ['set', String(time), ...(days ? ['--days', String(days)] : []), ...(call === true ? ['--call'] : call === false ? ['--no-call'] : [])] : ['status']
        const r = await alarmScript(args)
        await hud('memory_changed', {}).catch(() => null)
        const text = [r.summary, r.problem ? `Problém: ${r.problem}` : '', ...(r.notes ?? [])].filter(Boolean).join(' ')
        return r.ok === false ? { text, isError: true } : `${text} Povedz to jednou až dvoma vetami, hlavne čas a že počítač má ostať zapnutý.`
      },
    },
    {
      name: 'settings',
      description:
        'Nastavenia Jarvisa. Bez set vráti, čo je nastavené, a zoznam hlasov. So set zmení len to, čo pošleš, a platí to hneď. Na „hovor ženským hlasom" pošli assistant.gender female (hlas sa prepne sám), na „hovor mužským hlasom" male. Na „oslovuj ma pani" alebo „volaj ma šéfe" user.address, na „tykaj mi" user.formal false, na „vykaj mi" true. Na „volaj sa Friday" assistant.name. Konkrétny hlas podľa mena cez voice.id zo zoznamu voices. Po zmene hlasu odpovedz jednou krátkou vetou, zaznie už novým hlasom.',
      inputSchema: {
        type: 'object',
        properties: {
          set: {
            type: 'object',
            description: 'Len kľúče, ktoré sa majú zmeniť.',
            properties: {
              assistant: {
                type: 'object',
                properties: { name: { type: 'string', description: 'Meno asistenta, najviac 24 znakov.' }, gender: { type: 'string', enum: ['male', 'female'], description: 'Či Jarvis hovorí ako muž alebo žena.' } },
              },
              voice: {
                type: 'object',
                properties: {
                  id: { type: ['string', 'null'], description: 'Id hlasu zo zoznamu voices. null = predvolený hlas podľa jazyka a rodu.' },
                  rate: { type: ['string', 'null'], description: 'Rýchlosť reči, napríklad "+10%" (rýchlejšie) alebo "-10%".' },
                  pitch: { type: ['string', 'null'], description: 'Výška hlasu, napríklad "-5Hz" (hlbší) alebo "+5Hz".' },
                },
              },
              user: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  address: { type: 'string', description: 'Oslovenie: "pane", "pani", "šéfe", alebo prázdny text bez oslovenia.' },
                  formal: { type: 'boolean', description: 'true = vykať, false = tykať.' },
                  gender: { type: ['string', 'null'], enum: ['male', 'female', null], description: 'Rod používateľa pre tvary slov (pripravený, pripravená).' },
                  city: { type: 'string' },
                  birthday: { type: ['string', 'null'], description: 'Narodeniny používateľa, 1990-05-12 alebo bez roku 05-12. V ten deň mu sám zablahoželáš.' },
                },
              },
              quiet: { type: 'string', description: 'Tiché hodiny "22:30-07:00", prázdny text ich vypne.' },
              language: { type: 'string', enum: ['sk', 'cs'] },
              stt: { type: 'string', enum: ['auto', 'browser', 'whisper'], description: 'Rozpoznávanie reči: auto, v prehliadači, alebo lokálny Whisper.' },
              wake: { type: 'boolean', description: 'Počúvanie na slová „Hey Jarvis". Ide len s lokálnym Whisperom.' },
              telemetry: { type: 'boolean', description: 'false vypne anonymné štatistiky. Zapnúť ich vie len používateľ sám v Nastaveniach, časť Asistent.' },
            },
          },
        },
      },
      handler: async ({ set }) => {
        const r = await hud('settings', set && Object.keys(set).length ? { set } : {})
        if (r.isError) return r
        const now = { assistant: r.assistant, voice: r.voice, user: r.user, quiet: r.quiet, language: r.language, stt: r.stt, wake: r.wake }
        return r.changed.length ? { zmenene: r.changed, teraz: now } : { teraz: now, hlasy: r.voices }
      },
    },
    {
      name: 'weather',
      description: 'Počasie teraz, dnes a na pár dní (Open-Meteo). Bez place = mesto používateľa z nastavení. Kartu ukáže samo.',
      inputSchema: {
        type: 'object',
        properties: { place: { type: 'string', description: 'Mesto, default mesto používateľa.' }, days: { type: 'integer', minimum: 1, maximum: 7 } },
      },
      handler: async ({ place, days }) => {
        const url = new URL(`${HUD}/api/weather`)
        if (place) url.searchParams.set('place', place)
        if (days) url.searchParams.set('days', String(days))
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
        const json = await res.json()
        if (!res.ok) return { text: `Počasie nedostupné: ${json.error ?? res.status}`, isError: true }
        await hud('auto', { tool: 'weather', data: json }).catch(() => null)
        return json
      },
    },
    ...videoTools({ hudUrl: HUD, repo: REPO }),
    // Record mode (server/record.mjs, docs/ZAZNAM.md): the microphone and the screen, saved as they come.
    {
      name: 'record_start',
      description:
        'Zapne záznam: nahráva mikrofón aj obrazovku a priebežne všetko ukladá, ty medzitým normálne odpovedáš. Na „počúvaj ma", „nahrávaj", „zapni záznam", „nahraj tento hovor". title je krátky názov, keď ho povedal (napr. „Porada s Petrom"), inak ho vynechaj.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
      handler: async ({ title } = {}) => {
        const r = await hud('record', { op: 'start', title })
        return r.isError ? r : r.summary
      },
    },
    {
      name: 'record_stop',
      description:
        'Ukončí záznam. Prepis sa dokončí a na pozadí z neho vznikne poznámka, úlohy, pripomienky, termíny a návrhy správ (tie čakajú na jeho áno). Na „stačí", „ukonči záznam", „koniec nahrávania".',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const r = await hud('record', { op: 'stop' })
        return r.isError ? r : r.summary
      },
    },
    {
      name: 'record_status',
      description: 'Či beží záznam, odkedy a koľko je nahrané, plus posledné záznamy a ich stav.',
      inputSchema: { type: 'object', properties: {} },
      annotations: READ_ONLY,
      handler: async () => {
        const r = await hud('record', { op: 'status' })
        if (r.isError) return r
        const recent = (r.recent ?? []).slice(0, 5).map((x) => `${x.id} ${x.title} (${x.status}${x.job ? `, úloha ${x.job}` : ''})`)
        return [r.summary, recent.length ? `Posledné: ${recent.join('; ')}` : ''].filter(Boolean).join('\n')
      },
    },
  ],
})
