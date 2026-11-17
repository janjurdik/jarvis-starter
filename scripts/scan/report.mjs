/**
 * Second phase of the scan: conclusions drawn from everything the probes found.
 *   hints()      school and work signals (folder names, calendar files, teams, mail domains)
 *   missing()    sources worth having that are not on this computer yet
 *   questions()  what the scan could not find out and Jarvis has to ask
 *   markdown()   the report Claude reads and presents (data/scan/scan.md)
 *   summary()    the short text printed to the terminal
 */
import { IS_MAC } from '../lib.mjs'
import { installedApps } from './apps.mjs'
import { SOURCES } from './exports.mjs'
import { ALLOW_IDS } from './private.mjs'
import { HOME, plain, sk, some, tilde, uniq } from './util.mjs'

const SCHOOL_WORDS = new Set(['skola', 'school', 'univerzita', 'university', 'univerzity', 'vysoka', 'fakulta', 'studium', 'semester', 'semestr', 'predmety', 'maturita', 'gymnazium', 'bakalarka', 'diplomovka', 'thesis', 'muni', 'stuba', 'uniba', 'tuke', 'vut', 'cvut', 'euba', 'upjs', 'uniza', 'prednasky', 'cvicenia', 'skripta', 'homework', 'seminarka', 'erasmus', 'college', 'lectures', 'coursework', 'zapocet', 'skuska', 'skusky'])
const WORK_WORDS = new Set(['praca', 'prace', 'work', 'job', 'klienti', 'klient', 'clients', 'client', 'zakaznici', 'firma', 'company', 'business', 'biznis', 'freelance', 'zakazky', 'faktury', 'invoices', 'uctovnictvo', 'accounting', 'agency', 'agentura', 'startup', 'office', 'zamestnanie'])
const FREE_MAIL = /(^|\.)(gmail|googlemail|icloud|me|mac|outlook|hotmail|live|yahoo|azet|centrum|zoznam|post|seznam|email|proton|protonmail|pm|pobox|atlas|gmx|msn|aol)\.[a-z.]+$|noreply/
const SCHOOL_MAIL = /\.edu$|\.edu\.[a-z]{2}$|\.ac\.[a-z]{2}$|(^|\.)(muni|stuba|uniba|tuke|vut|vutbr|cvut|cuni|euba|upjs|ukf|umb|uniza|unipo|truni|vse|student)\.[a-z]{2,3}$/

const words = (name) => plain(name).split(/[^a-z0-9]+/).filter(Boolean)
const byId = (result, id) => result.findings.find((f) => f.id === id)
const anyId = (result, prefix) => result.findings.some((f) => f.id === prefix || f.id.startsWith(`${prefix}.`))

/** Probe group "hints": runs after the others and may look at their findings. */
export async function hints(ctx) {
  const index = await ctx.index()
  const apps = await installedApps()
  const result = ctx.result

  const folderHint = (id, wordSet, title, use) => {
    const hits = [...index.dirs.values()]
      .filter((d) => d.depth >= 1 && d.depth <= 3 && d.path !== HOME && words(d.name).some((w) => wordSet.has(w)))
      .sort((a, b) => a.depth - b.depth || b.sub + b.files - (a.sub + a.files))
    if (!hits.length) return null
    // folders inside an already reported folder add nothing
    const top = hits.filter((d, i) => !hits.slice(0, i).some((p) => d.path.startsWith(`${p.path}/`) || d.path.startsWith(`${p.path}\\`))).slice(0, 12)
    const best = top[0]
    const inside = [...index.dirs.values()].filter((d) => d.parent === best.path).map((d) => d.name).slice(0, 40)
    ctx.finding({
      id,
      category: id.split('.')[0],
      title,
      detail: `Priečinky: ${some(top.map((d) => tilde(d.path)), 5)}.${inside.length ? ` V priečinku ${best.name} je: ${some(inside, 10)}.` : ''}`,
      path: best.path,
      data: { folders: top.map((d) => ({ path: d.path, subfolders: d.sub, files: d.files })), inside: { folder: best.path, names: inside } },
      use,
      action: 'ask',
      weight: 4,
    })
    return top
  }

  await ctx.step('school', () => {
    folderHint('school.folders', SCHOOL_WORDS, 'Priečinky, ktoré vyzerajú ako škola', 'Vyzerá to, že študuješ. Z priečinkov viem vyčítať predmety a pomáhať ti s učivom a termínmi.')
    const mails = (result.identity.emails ?? []).filter((m) => SCHOOL_MAIL.test(m.split('@')[1] ?? ''))
    const tools = ['Anki', 'Zotero', 'Mendeley', 'MATLAB', 'GeoGebra', 'RStudio', 'Mathematica'].filter((n) => apps.has(n))
    if (mails.length) {
      ctx.finding({
        id: 'school.account',
        category: 'school',
        title: 'Školský účet',
        detail: `Máš školskú mailovú adresu: ${mails.join(', ')}.${tools.length ? ` K tomu študijné appky: ${tools.join(', ')}.` : ''}`,
        data: { emails: mails, apps: tools },
        use: 'Podľa adresy viem, kde študuješ. Školský kalendár a mail sa dajú pripojiť, aby som strážil termíny.',
        action: 'ask',
        weight: 4,
      })
    }
  })

  await ctx.step('work', () => {
    folderHint('work.folders', WORK_WORDS, 'Priečinky, ktoré vyzerajú ako práca', 'Z priečinkov viem vyčítať klientov a zákazky a založiť ich ako projekty v pamäti.')
    const orgs = (byId(result, 'code.repos')?.data.orgs ?? []).filter((o) => o.count >= 2).map((o) => o.org)
    const slack = (byId(result, 'comms.slack')?.data.workspaces ?? []).map((w) => w.name)
    const mails = (result.identity.emails ?? []).filter((m) => {
      const domain = m.split('@')[1] ?? ''
      return domain && !FREE_MAIL.test(domain) && !SCHOOL_MAIL.test(domain)
    })
    const teamTools = ['Asana', 'Linear', 'Jira', 'ClickUp', 'Trello', 'monday.com', 'Basecamp', 'Microsoft Teams'].filter((n) => apps.has(n))
    if (!orgs.length && !slack.length && !mails.length && !teamTools.length) return
    const parts = []
    if (slack.length) parts.push(`tímy v Slacku: ${some(slack, 5)}`)
    if (orgs.length) parts.push(`kód pod: ${some(orgs, 4)}`)
    if (mails.length) parts.push(`adresy na vlastnej alebo firemnej doméne: ${some(mails, 4)}`)
    if (teamTools.length) parts.push(`tímové nástroje: ${teamTools.join(', ')}`)
    ctx.finding({
      id: 'work.signals',
      category: 'work',
      title: 'Stopy práce',
      detail: `${parts.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()),
      data: { slack, orgs, emails: mails, tools: teamTools },
      use: 'Z toho tuším, pre koho a s kým pracuješ. Potvrď mi to a založím si firmy, klientov a kolegov v pamäti.',
      action: 'ask',
      weight: 4,
    })
  })

  await ctx.step('files', () => {
    const ics = index.special.filter((s) => s.kind === 'ics')
    if (ics.length) {
      ctx.finding({
        id: 'calendar.ics',
        category: 'calendar',
        title: 'Súbory kalendára',
        detail: `Našiel som ${sk(ics.length, 'súbor kalendára', 'súbory kalendára', 'súborov kalendára')} (.ics): ${some(ics.map((s) => s.name), 5)}.`,
        path: ics[0].path,
        data: { files: ics.slice(0, 40).map((s) => s.path) },
        use: 'Súbor kalendára viem načítať do pamäte, napríklad školský rozvrh alebo pozvánky.',
        action: 'import-file',
        weight: 3,
      })
    }
    const vcf = index.special.filter((s) => s.kind === 'vcf')
    if (vcf.length) {
      ctx.finding({
        id: 'contacts.vcf',
        category: 'contacts',
        title: 'Súbory s kontaktmi',
        detail: `Našiel som ${sk(vcf.length, 'súbor s kontaktmi', 'súbory s kontaktmi', 'súborov s kontaktmi')} (.vcf): ${some(vcf.map((s) => s.name), 5)}.`,
        path: vcf[0].path,
        data: { files: vcf.slice(0, 40).map((s) => s.path) },
        use: 'Z takého súboru viem načítať ľudí aj s narodeninami bez toho, aby som siahal do chráneného adresára.',
        action: 'import-file',
        weight: 4,
      })
    }
  })
}

/** Sources worth having that were not found. `guide` ids are fixed (the setup has a how-to for each). */
export function missing(result) {
  const out = []
  const add = (id, title, why, guide = id) => out.push({ id, title, why, guide })
  const hasExport = (source) => result.exports.some((e) => e.source === source && e.confidence >= 0.5)
  const kinds = new Set(byId(result, 'connectors.list')?.data.kinds ?? [])
  const emails = result.identity.emails ?? []
  const domains = (byId(result, 'browser.history')?.data.domains ?? []).map((d) => d.host)
  const visits = (re) => domains.some((h) => re.test(h))
  const google = emails.some((m) => /@(gmail|googlemail)\./.test(m)) || kinds.has('mail')

  const hasNotes = result.findings.some((f) => f.action === 'import-notes') || ['notes.joplin', 'notes.bear', 'notes.notion'].some((id) => byId(result, id)) || (byId(result, 'notes.apple')?.data.notes ?? 0) > 0
  if (!hasNotes) add('notes', 'Poznámky', 'Nenašiel som žiadne tvoje poznámky. Ak si niečo píšeš (do telefónu, do Poznámok, do zošita v cloude), ukáž mi kde. Je to najlepší zdroj.')
  if (!kinds.has('calendar') && !anyId(result, 'calendar.apple') && !anyId(result, 'calendar.ics')) add('calendar', 'Kalendár', 'Kalendár nemám pripojený a v počítači som nenašiel ani jeho súbor. Bez neho neviem, čo ťa čaká.')
  if (!kinds.has('mail')) add('mail', 'Mail', 'Mail nemám pripojený, takže neviem, kto ti píše a čo čaká na odpoveď.')
  if (!anyId(result, 'contacts'))
    add('contacts', 'Kontakty', IS_MAC ? 'Adresár je chránený, bez povolenia som sa ho nedotkol. Sú v ňom mená a narodeniny tvojich ľudí.' : 'Zoznam kontaktov v počítači nie je. Dá sa stiahnuť z Googlu alebo iCloudu ako súbor .vcf.')
  if (!hasExport('chatgpt'))
    add('chatgpt', 'Rozhovory s ChatGPT', byId(result, 'ai.chatgpt') || visits(/chatgpt\.com|chat\.openai\.com/) ? 'ChatGPT používaš, ale stiahnuté rozhovory som nenašiel. Býva v nich najviac kontextu o tom, čo riešiš.' : 'Ak používaš ChatGPT, jeho export rozhovorov je najrýchlejšia cesta k rokom kontextu o tebe.')
  if (!hasExport('instagram')) add('instagram', 'Instagram správy', visits(/instagram\.com/) ? 'Na Instagram chodíš, ale export z neho som nenašiel. Sú v ňom správy a ľudia, s ktorými si píšeš.' : 'Export z Instagramu som nenašiel. Sú v ňom správy a ľudia, s ktorými si píšeš.')
  if (!hasExport('whatsapp')) add('whatsapp', 'WhatsApp rozhovory', byId(result, 'comms.whatsapp') ? 'WhatsApp máš aj v počítači, ale žiadny exportovaný rozhovor som nenašiel. Stačí poslať chaty s najbližšími ľuďmi.' : 'Exportovaný rozhovor z WhatsAppu som nenašiel. Stačí poslať z telefónu chaty s najbližšími ľuďmi.')
  if (!hasExport('facebook')) add('facebook', 'Facebook a Messenger', byId(result, 'comms.messenger') || visits(/facebook\.com|messenger\.com/) ? 'Messenger používaš, ale export z Facebooku som nenašiel. Sú v ňom správy, priatelia a udalosti.' : 'Export z Facebooku som nenašiel. Ak ho používaš, sú v ňom správy z Messengera, priatelia a udalosti.')
  if (google && !hasExport('takeout')) add('google', 'Dáta z Googlu', 'Máš účet Google, ale jeho export (Takeout) som nenašiel. Dá z neho kalendár, kontakty, YouTube aj mapy naraz.')
  if (byId(result, 'comms.discord') && !hasExport('discord')) add('discord', 'Discord správy', 'Discord máš nainštalovaný, ale balík dát z neho som nenašiel.')
  if (byId(result, 'comms.telegram') && !hasExport('telegram')) add('telegram', 'Telegram správy', 'Telegram máš nainštalovaný, ale export z neho som nenašiel.')
  if ((byId(result, 'music.spotify') || visits(/spotify\.com/)) && !hasExport('spotify')) add('spotify', 'História zo Spotify', 'Spotify používaš, ale stiahnutú históriu počúvania som nenašiel.')
  if (!hasExport('claude')) add('claude', 'Staršie rozhovory s Claude', 'Export rozhovorov z claude.ai som nenašiel. Ak Claude používaš dlhšie, oplatí sa ho stiahnuť.')
  if (result.identity.appleId && !hasExport('apple')) add('apple', 'Dáta z Apple účtu', 'Máš Apple účet, ale export z privacy.apple.com som nenašiel. Hodí sa hlavne kvôli hudbe a nákupom.')
  if (result.identity.appleId && !hasExport('health')) add('health', 'Zdravie z iPhonu', 'Ak máš iPhone alebo Apple Watch, appka Zdravie vie vyexportovať kroky, spánok a tréningy. V počítači som taký export nenašiel.')
  if (IS_MAC && !(byId(result, 'photos.library')?.data.photos > 0)) add('photos', 'Fotky', 'Knižnica Fotiek je chránená, bez povolenia som ju neotváral. Sú v nej pomenovaní ľudia a albumy z ciest.')
  const plays = result.findings.some((f) => f.category === 'games')
  if (plays && !byId(result, 'games.steam')) add('steam', 'Hry zo Steamu', 'Vidím, že hrávaš, ale Steam v tomto počítači nie je. Ak ho máš inde, zoznam hier a hodín sa dá stiahnuť z profilu.')
  return out
}

/** Questions for what no file can answer. At most eight, the most useful first. */
export function questions(result) {
  const q = []
  const id = result.identity
  const school = anyId(result, 'school')
  const work = anyId(result, 'work') || byId(result, 'code.repos')
  if (!id.fullName) q.push('Ako sa voláš?')
  q.push(`Ako ťa mám oslovovať${id.fullName ? ` (${id.fullName.split(' ')[0]}, alebo inak)` : ''} a mám ti tykať, alebo vykať?`)
  q.push('V akom meste žiješ?')
  if (school && work) q.push('Vidím stopy školy aj práce. Čo z toho je teraz tvoje hlavné a čo popri tom?')
  else if (school) q.push('Vyzerá to, že študuješ. Čo a kde?')
  else if (work) q.push('Čím sa živíš a pre koho pracuješ?')
  else q.push('Čo robíš: škola, práca, vlastné projekty?')
  q.push('Kedy zvyčajne vstávaš a kedy chodíš spať? Podľa toho nastavím ranný brief a večerné zhrnutie.')
  if (!anyId(result, 'contacts')) q.push('Kto sú tvoji najdôležitejší ľudia (rodina, partner, priatelia, kolegovia)?')
  q.push('Čo chceš dosiahnuť v najbližších mesiacoch?')
  const kinds = new Set(byId(result, 'connectors.list')?.data.kinds ?? [])
  if (!kinds.has('calendar') && !anyId(result, 'calendar')) q.push('Kde si vedieš kalendár (Google, Apple, Outlook, papier)?')
  if (!id.birthday) q.push('Kedy máš narodeniny?')
  return q.slice(0, 8)
}

// ── report ──
const CATEGORIES = [
  ['notes', 'Poznámky'],
  ['exports', 'Stiahnuté dáta z iných služieb'],
  ['ai', 'AI nástroje'],
  ['connectors', 'Pripojené služby'],
  ['work', 'Práca'],
  ['school', 'Škola'],
  ['code', 'Programovanie'],
  ['documents', 'Dokumenty'],
  ['comms', 'Komunikácia'],
  ['contacts', 'Kontakty'],
  ['calendar', 'Kalendár a úlohy'],
  ['browser', 'Prehliadač'],
  ['photos', 'Fotky'],
  ['music', 'Hudba'],
  ['media', 'Tvorba a médiá'],
  ['games', 'Hry'],
  ['apps', 'Appky'],
  ['system', 'Počítač'],
]
const ACTIONS = { 'import-notes': 'dá sa načítať do pamäte', 'import-export': 'dá sa importovať', 'import-file': 'dá sa načítať', connect: 'dá sa pripojiť', read: 'môžem si to prečítať', ask: 'treba sa dohodnúť', none: '' }

function identityLines(result) {
  const id = result.identity
  const lines = []
  if (id.fullName) lines.push(`- Meno: ${id.fullName}`)
  if (id.username) lines.push(`- Meno účtu v počítači: ${id.username}`)
  if (id.emails?.length) lines.push(`- Mailové adresy: ${id.emails.join(', ')}`)
  if (id.gitName || id.gitEmail) lines.push(`- V gite vystupuješ ako: ${[id.gitName, id.gitEmail].filter(Boolean).join(', ')}`)
  if (id.locale || id.languages?.length) lines.push(`- Jazyk: ${uniq([id.locale, ...(id.languages ?? [])]).join(', ')}${id.keyboard?.length ? ` (klávesnica: ${id.keyboard.join(', ')})` : ''}`)
  if (id.timezone) lines.push(`- Časové pásmo: ${id.timezone}`)
  if (id.appleId) lines.push(`- Apple účet: ${id.appleId}`)
  if (id.birthday) lines.push(`- Narodeniny: ${id.birthday}`)
  if (id.avatarPath) lines.push(`- Profilový obrázok: ${tilde(id.avatarPath)}`)
  return lines
}

export function markdown(result, { deep }) {
  const when = new Date(result.at).toLocaleString('sk-SK', { dateStyle: 'long', timeStyle: 'short' })
  const md = ['# Čo som o tebe našiel', '']
  md.push(`${deep ? 'Hĺbkový sken' : 'Rýchly sken'} počítača, ${when}, trval ${Math.round(result.ms / 1000)} s. Sken sám nikam nič neposiela, výsledok je v tomto priečinku. Prečíta si ho AI, na ktorej Jarvis beží, aby ťa spoznal. Úplné dáta sú v \`data/scan/scan.json\`.`, '')
  md.push('## Kto si', '', ...(identityLines(result).length ? identityLines(result) : ['- Meno som nezistil.']), '')
  const h = result.host
  md.push('## Počítač', '', `- ${[h.model, h.os, h.name].filter(Boolean).join(', ')}`, `- ${h.laptop ? 'Notebook' : 'Stolný počítač'}${h.screens ? `, ${sk(h.screens, 'obrazovka', 'obrazovky', 'obrazoviek')}` : ''}${h.diskFreeGB != null ? `, voľných ${h.diskFreeGB} GB` : ''}`)
  if (h.alwaysOn) md.push(`- Rutiny: ${h.alwaysOn}`)
  md.push('')
  for (const [category, title] of CATEGORIES) {
    const items = result.findings.filter((f) => f.category === category && f.id !== 'system.host').sort((a, b) => b.weight - a.weight)
    if (!items.length) continue
    md.push(`## ${title}`, '')
    for (const f of items) {
      const tail = [ACTIONS[f.action], f.path ? `\`${tilde(f.path)}\`` : ''].filter(Boolean).join(', ')
      md.push(`- **${f.title}** (dôležitosť ${f.weight}/5): ${f.detail}`, `  - Čo s tým: ${f.use}${tail ? ` (${tail})` : ''}`)
    }
    md.push('')
  }
  md.push('## Čo nemám', '')
  if (result.missing.length) for (const m of result.missing) md.push(`- **${m.title}**: ${m.why} (návod: \`${m.guide}\`)`)
  else md.push('- Nič dôležité nechýba.')
  md.push('', '## Čo potrebuje povolenie', '')
  if (result.permissions.length) for (const p of result.permissions) md.push(`- **${p.title}**${ALLOW_IDS.includes(p.id) ? ` (\`--allow ${p.id}\`)` : ''}: ${p.gives}`, `  - Ako: ${p.how}`)
  else md.push('- Nič. Všetko, čo sa dalo prečítať, som prečítal.')
  md.push('', '## Na čo sa ešte musím opýtať', '')
  for (const question of result.questions) md.push(`- ${question}`)
  if (result.stats.errors.length) {
    md.push('', '## Čo sa nepodarilo prečítať', '')
    for (const e of result.stats.errors) md.push(`- ${e.probe}: ${e.error}`)
  }
  md.push('')
  return md.join('\n')
}

export function summary(result, { deep, files }) {
  const out = ['', `  Jarvis: ${deep ? 'hĺbkový' : 'rýchly'} sken počítača (${Math.round(result.ms / 1000)} s)`, '']
  const id = result.identity
  if (id.fullName || id.username) out.push(`  Kto si: ${id.fullName ?? 'meno som nezistil'}${id.username ? ` (${id.username})` : ''}${id.emails?.length ? `, ${sk(id.emails.length, 'mailová adresa', 'mailové adresy', 'mailových adries')}` : ''}`)
  if (result.host.model || result.host.os) out.push(`  Počítač: ${[result.host.model, result.host.os].filter(Boolean).join(', ')}`)
  out.push('', `  Čo som našiel (${sk(result.findings.length, 'vec', 'veci', 'vecí')}):`)
  for (const [category, title] of CATEGORIES) {
    const items = result.findings.filter((f) => f.category === category && f.id !== 'system.host').sort((a, b) => b.weight - a.weight)
    if (items.length) out.push(`    ${title}: ${some(items.map((f) => f.title), 5)}`)
  }
  if (result.exports.length) out.push('', `  Stiahnuté dáta: ${uniq(result.exports.map((e) => e.note ?? SOURCES[e.source]?.label ?? e.source)).join(', ')}`)
  if (result.missing.length) out.push('', `  Čo nemám: ${result.missing.map((m) => m.title).join(', ')}`)
  if (result.permissions.length) {
    const ids = result.permissions.map((p) => p.id).filter((id) => ALLOW_IDS.includes(id))
    out.push('', `  Potrebuje povolenie: ${result.permissions.map((p) => p.title).join(', ')}`)
    if (ids.length) out.push(`    (napríklad: node scripts/scan.mjs --allow ${ids.slice(0, 2).join(',')})`)
  }
  const failed = result.stats.errors.filter((e) => e.probe !== 'scan').map((e) => e.probe)
  if (failed.length) out.push('', `  Nepodarilo sa prečítať: ${failed.join(', ')}`)
  for (const e of result.stats.errors.filter((x) => x.probe === 'scan')) out.push('', `  Pozor: ${e.error}`)
  if (files) out.push('', `  Celý výsledok: ${files.md}`, `  Dáta pre Jarvisa: ${files.json}`)
  out.push('')
  return out.join('\n')
}
