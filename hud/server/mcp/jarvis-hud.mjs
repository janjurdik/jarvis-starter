#!/usr/bin/env node
/**
 * MCP server jarvis-hud: Jarvis shows things in the HUD. Calls the loopback API of the HUD server
 * (POST /api/brain/hud with a token), which turns it into SSE `world`, `chat card` and `hud`.
 *
 *   hud_focus(node, caption?)   the camera of the 3D world flies to a node
 *   hud_card(kind, title, …)    a rich card in the chat
 *   hud_log(text, icon?, type?) a line in the LOG
 *   weather(place?, days?)      weather (Open-Meteo through the HUD server)
 *   agent_task / agent_jobs / agent_reply / agent_stop   background jobs (full Claude Code)
 *   set_alarm(time?, days?, call?, off?)   the alarm clock (scripts/alarm.mjs)
 */
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveMcp } from './stdio.mjs'

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
const TOKEN = process.env.HUD_BRAIN_TOKEN || ''
const NODES = ['ludia', 'projekty', 'questy', 'kalendar', 'rutiny', 'udalosti', 'spravy', 'fotky', 'spanok']
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
          node: { type: ['string', 'null'], enum: [...NODES, null], description: 'ludia, projekty, questy (ciele), kalendar, rutiny, udalosti (denník), spravy (rozhovory), fotky (poznámky), spanok' },
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
        'Spustí úlohu na pozadí: plnohodnotný Claude Code v priečinku Jarvisa (súbory a pamäť, web, pripojené konektory ako mail a kalendár). Na všetko, čo je reálna práca na viac krokov: rešerš, dokument, upratanie poznámok, príprava mailu. Vráti hneď id, výsledok HUD ohlási sám. task = úplné zadanie v jednej až pár vetách (čo, kde, kedy je hotovo), title = 2 až 5 slov.',
      inputSchema: {
        type: 'object',
        properties: { task: { type: 'string' }, title: { type: 'string', description: 'Krátky názov, 2 až 5 slov.' } },
        required: ['task', 'title'],
      },
      handler: async ({ task, title }) => {
        const r = await hud('job_task', { task, title })
        return r.isError ? r : `Úloha ${r.job.id} „${r.job.title}" ${r.job.status === 'queued' ? 'čaká vo fronte' : 'beží'}. Povedz jednu vetu a skonči, výsledok HUD ohlási sám.`
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
          ? r.jobs.slice(0, 12).map((j) => `${j.id} „${j.title}" ${j.status} · ${j.step ?? ''}${j.needsOk ? ` · čaká na súhlas: ${j.needsOk}` : ''}${j.summary ? ` · ${j.summary.slice(0, 200)}` : ''}`).join('\n')
          : 'Žiadne úlohy.'
      },
    },
    {
      name: 'agent_reply',
      description: 'Pokračuje v skončenej úlohe tou istou session: doplnenie, oprava alebo schválenie. Keď úloha čaká na súhlas (needs_ok) a používateľ povie „pošli to" alebo „súhlasím", pošli jasné schválenie, napr. "Schválené: pošli presne pripravené znenie."',
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
  ],
})
