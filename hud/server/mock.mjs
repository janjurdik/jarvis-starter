/**
 * Mock brain: realistic SSE (deltas, tools, cards, focus, voice) without Claude.
 * Used to try the HUD before Claude is connected (JARVIS_MOCK=1 or "mock": true).
 * It does nothing on the computer and reads only the snapshot.
 */
import { DOW_LONG, dowOf, sleep } from './util.mjs'

const fmtMin = (m) => {
  if (!Number.isFinite(m)) return '–'
  const h = Math.floor(m / 60)
  const mm = Math.round(m % 60)
  return `${h} h ${String(mm).padStart(2, '0')} min`
}

const hourWords = ['polnoci', 'jednej', 'druhej', 'tretej', 'štvrtej', 'piatej', 'šiestej', 'siedmej', 'ôsmej', 'deviatej', 'desiatej', 'jedenástej', 'dvanástej', 'jednej', 'druhej', 'tretej', 'štvrtej', 'piatej', 'šiestej', 'siedmej', 'ôsmej', 'deviatej', 'desiatej', 'jedenástej']
const spokenTime = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  if (!Number.isFinite(h)) return hhmm
  if (!m) return `o ${hourWords[h]}`
  if (m === 30) return `o pol ${hourWords[(h + 1) % 24]}`
  return `o ${hhmm}`
}

export function pickScenario(text = '', forced) {
  if (forced) return forced
  const t = text.toLowerCase()
  if (/rozvrh|kalend|dnes|zajtra|program|čaká|caka|udalost/.test(t)) return 'kalendar'
  if (/spal|spánok|spanok|spím|spim|sleep|zdrav/.test(t)) return 'spanok'
  if (/otvor|spusti|pusti|zavri|hlasit|stlm|zapni|vypni/.test(t)) return 'mac'
  if (/pamä|pama|poznám|poznam|vieš o mne|vies o mne/.test(t)) return 'spravy'
  if (/quest|cieľ|ciel/.test(t)) return 'questy'
  return 'default'
}

/** Prehrá jeden mock turn do `sink`. `ctx.snapshot` je aktuálny (v natáčaní očistený) snapshot. */
export async function runMock(sink, { text, scenario, snapshot }) {
  const kind = pickScenario(text, scenario)
  let toolSeq = 0
  const wait = async (ms) => {
    await sleep(ms)
    if (sink.cancelled()) throw new Error('mock-cancelled')
  }
  const say = async (sentence, perWord = 38) => {
    // Tokeny ako od Clauda: slovo aj s medzerou pred ním.
    const words = sentence.match(/\s*\S+/g) ?? []
    for (const w of words) {
      sink.delta(w)
      await wait(perWord + Math.round(Math.random() * 20))
    }
  }
  const tool = async (name, input, ms = 850, ok = true) => {
    const id = `mock_${Date.now().toString(36)}_${++toolSeq}`
    sink.tool({ id, name, input: null, status: 'run' })
    await wait(120)
    sink.tool({ id, name, input, status: 'run' })
    await wait(ms)
    sink.tool({ id, name, input, status: ok ? 'ok' : 'error' })
  }

  try {
    await wait(450)
    if (kind === 'kalendar') {
      await say('Pozriem kalendár.')
      await tool('mcp__memory__calendar_list', { from: snapshot.schedule?.day })
      const items = snapshot.schedule?.items ?? []
      sink.focus('kalendar', 'Dnešný program')
      const day = snapshot.schedule?.day
      sink.card({
        kind: 'list',
        title: day ? `Dnes, ${DOW_LONG[dowOf(day)]}` : 'Dnes',
        icon: 'calendar',
        node: 'kalendar',
        items: items.slice(0, 6).map((it) => ({ label: it.title, value: it.time, sub: it.place ?? null })),
        caption: snapshot.schedule?.nameDays?.length ? `Meniny: ${snapshot.schedule.nameDays.join(', ')}` : null,
        accent: 'amber',
      })
      await wait(200)
      if (!items.length) await say(' Dnes máte voľný deň, v kalendári nič nie je.')
      else {
        const first = items[0]
        const rest = items.length - 1
        await say(` Prvá vec je ${first.title}${first.time ? ` ${spokenTime(first.time)}` : ''}${first.place ? `, ${first.place}` : ''}.`)
        if (rest > 0) await say(` Potom ešte ${rest} ${rest === 1 ? 'položka' : rest < 5 ? 'položky' : 'položiek'}, detaily máte na karte.`)
      }
    } else if (kind === 'spanok') {
      await say('Pozriem to.')
      await tool('mcp__memory__get_health', { days: 7 }, 900)
      const week = snapshot.health?.week ?? []
      const valid = week.filter((d) => Number.isFinite(d.sleepMin))
      const avg = valid.length ? valid.reduce((s, d) => s + d.sleepMin, 0) / valid.length : NaN
      const worst = valid.reduce((a, d) => (!a || d.sleepMin < a.sleepMin ? d : a), null)
      const avgScore = valid.length ? Math.round(valid.reduce((s, d) => s + (d.score ?? 0), 0) / valid.length) : null
      if (!valid.length) {
        await say(' V denníku zatiaľ nemám žiadny spánok. Stačí mi ráno povedať, koľko ste spali, a zapíšem to.')
        return sink.done({ mock: true })
      }
      sink.focus('spanok', 'Spánok, posledných 7 dní')
      sink.card({
        kind: 'chart',
        title: 'Spánok tento týždeň',
        icon: 'moon',
        node: 'spanok',
        value: fmtMin(avg),
        caption: avgScore ? `priemer, skóre ${avgScore}` : 'priemer',
        series: valid.map((d) => ({ label: d.dow ?? d.day.slice(8), value: Math.round(d.sleepMin) })),
        accent: 'ice',
      })
      await wait(150)
      await say(` V priemere ste spali ${Math.floor(avg / 60)} hodín ${Math.round(avg % 60)} minút.`)
      if (worst) await say(` Najkratšia bola noc na ${DOW_LONG[dowOf(worst.day)]}, odporúčam to dnes dohnať.`)
    } else if (kind === 'mac') {
      const app = /spotify/i.test(text) ? 'Spotify' : /chrome/i.test(text) ? 'Chrome' : 'appku'
      await say('Hneď to bude.')
      await tool('mcp__computer__open_app', { name: app }, 1300)
      sink.log({ type: 'action', icon: app === 'Spotify' ? 'music' : 'bolt', text: `${app} · otvorené (mock)` })
      await say(' Hotovo.')
    } else if (kind === 'spravy') {
      await say('Pozriem pamäť.')
      await tool('mcp__memory__memory_stats', {}, 700)
      const m = snapshot.memory ?? {}
      sink.focus('fotky', 'Pamäť')
      sink.card({
        kind: 'stat',
        title: 'Pamäť',
        icon: 'memory',
        node: 'fotky',
        value: Number(m.notes ?? 0).toLocaleString('sk-SK'),
        unit: 'poznámok',
        caption: `${Number(m.words ?? 0).toLocaleString('sk-SK')} slov`,
        items: (m.sources ?? []).slice(0, 5).map((s) => ({ label: s.name, value: Number(s.count).toLocaleString('sk-SK') })),
      })
      await say(` V pamäti mám ${m.notes ?? 0} poznámok, z toho ${m.people ?? 0} o ľuďoch a ${m.projects ?? 0} o projektoch.`)
    } else if (kind === 'questy') {
      await say('Pozriem ciele.')
      await tool('mcp__memory__list_goals', {}, 600)
      const q = snapshot.quests ?? {}
      sink.focus('questy', 'Aktívne ciele')
      sink.card({
        kind: 'list',
        title: 'Aktívne ciele',
        icon: 'quest',
        node: 'questy',
        items: (q.names?.length ? q.names : ['Zatiaľ žiadny cieľ']).slice(0, 6).map((n) => ({ label: n })),
        caption: `${q.active ?? 0} aktívnych, ${q.paused ?? 0} v pauze`,
      })
      await say(` Aktívnych cieľov máte ${q.active ?? 0}.`)
    } else if (kind === 'chyba') {
      await say('Pozriem to.')
      await tool('mcp__memory__get_health', { days: 7 }, 700, false)
      return sink.error('Pamäť neodpovedá (mock chyba).')
    } else if (kind === 'dlha') {
      await say('Zhrniem vám celý deň. Ráno boli dve stretnutia a potom hodina sústredenej práce. ')
      await say('Popoludní ostal čas na rozpracovaný projekt a na vybavenie pošty. Večer je v pláne šport. ')
      await say('Spánok bol včera pod priemerom, takže odporúčam ísť spať pred polnocou. Zajtra je deň voľnejší.')
    } else {
      await say('Som tu.')
      sink.card({ kind: 'text', title: 'Mock odpoveď', icon: 'info', text: `Na „${String(text).slice(0, 120)}" by som odpovedal naostro cez Claude. Toto je mock bez predplatného.` })
      await say(' Toto je skúšobná odpoveď bez Claude. Naostro odpovedám, keď je pripojený Claude Code.')
    }
    sink.done({ mock: true })
  } catch (err) {
    if (err instanceof Error && err.message === 'mock-cancelled') return
    sink.error(err instanceof Error ? err.message : String(err))
  }
}
