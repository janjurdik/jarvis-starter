/**
 * Probe "comms": where the person talks to people. For each chat or mail app found it reports
 * where its data lives and the realistic way to get messages into Jarvis. Message stores are
 * never opened here (they are encrypted or guarded by macOS); only names and dates are read.
 */
import { join } from 'node:path'
import { IS_MAC, IS_WIN } from '../lib.mjs'
import { installedApps } from './apps.mjs'
import { userFolders } from './index.mjs'
import { APPDATA, EMAIL_RE, HOME, LOCALAPPDATA, MAC_SUPPORT, ago, day, exists, list, names, readJson, readText, sk, some, statOf, uniq } from './util.mjs'

const dirFor = (mac, win, linux) => (IS_MAC ? mac && join(MAC_SUPPORT, mac) : IS_WIN ? win && join(APPDATA, win) : linux && join(HOME, linux))

/** Chat apps: how to notice them and what to tell the person. */
const CHATS = [
  {
    id: 'whatsapp', name: 'WhatsApp', catalog: ['WhatsApp'], container: /whatsapp/i, pkg: /WhatsAppDesktop/i, weight: 3, action: 'ask',
    detail: 'Správy si WhatsApp drží zašifrované vo vlastnom úložisku, priamo ich čítať neviem.',
    use: 'Rozhovor s človekom alebo skupinou vieš poslať z telefónu: otvor chat → Viac → Exportovať chat → Bez médií. Súbor si načítam.',
  },
  {
    id: 'telegram', name: 'Telegram', catalog: ['Telegram'], dir: dirFor('Telegram Desktop', 'Telegram Desktop', '.local/share/TelegramDesktop'), container: /keepcoder\.Telegram/i, pkg: /TelegramDesktop/i, weight: 3, action: 'ask',
    detail: 'Správy sú zašifrované, ale Telegram má vlastný export.',
    use: 'V Telegram Desktop zvoľ Nastavenia → Rozšírené → Exportovať dáta z Telegramu, formát JSON. Priečinok si načítam.',
  },
  {
    id: 'discord', name: 'Discord', catalog: ['Discord'], dir: dirFor('discord', 'discord', '.config/discord'), weight: 3, action: 'ask',
    detail: 'Správy sú na serveroch Discordu, v počítači nie sú čitateľné.',
    use: 'Discord ti pošle balík všetkých dát: Nastavenia → Dáta a súkromie → Vyžiadať všetky moje dáta. Príde mailom do pár dní.',
  },
  {
    id: 'signal', name: 'Signal', catalog: ['Signal'], dir: dirFor('Signal', 'Signal', '.config/Signal'), weight: 1, action: 'none',
    detail: 'Signal je šifrovaný a správy sa z neho nedajú preniesť.',
    use: 'Viem, že ho používaš. Ľudí, s ktorými si tam píšeš, mi budeš musieť povedať.',
  },
  {
    id: 'messenger', name: 'Messenger', catalog: ['Messenger'], dir: dirFor('Messenger', 'Messenger', null), container: /facebook\.(archon|messenger)/i, pkg: /Messenger/i, weight: 3, action: 'ask',
    detail: 'Správy sú na Facebooku, v počítači nie sú čitateľné.',
    use: 'Správy z Messengera sú súčasťou exportu z Facebooku (Nastavenia → Stiahnuť svoje informácie, formát JSON).',
  },
  {
    id: 'beeper', name: 'Beeper', catalog: ['Beeper'], dir: [dirFor('BeeperTexts', 'BeeperTexts', '.config/BeeperTexts'), dirFor('Beeper', 'Beeper', '.config/Beeper')], weight: 4, action: 'connect',
    detail: 'Beeper spája WhatsApp, Messenger, Instagram a ďalšie chaty na jednom mieste.',
    use: 'Beeper má vlastný konektor pre Claude (Beeper Desktop → Nastavenia → Vývojári). Cez neho viem čítať všetky chaty naraz.',
  },
  {
    id: 'viber', name: 'Viber', catalog: ['Viber'], dir: dirFor('ViberPC', 'ViberPC', '.ViberPC'), weight: 2, action: 'ask',
    detail: 'Viber si správy drží vo vlastnej databáze.',
    use: 'Rozhovor sa dá poslať z telefónu (Viber → Viac → Nastavenia → Hovory a správy → Poslať históriu správ).',
  },
  {
    id: 'teams', name: 'Microsoft Teams', catalog: ['Microsoft Teams'], dir: dirFor('Microsoft/Teams', 'Microsoft\\Teams', '.config/Microsoft/Microsoft Teams'), container: /com\.microsoft\.teams/i, pkg: /^MSTeams/i, weight: 2, action: 'none',
    detail: 'Teams znamená prácu alebo školu v prostredí Microsoftu.',
    use: 'Viem, že časť tvojej komunikácie beží cez Teams. Kalendár a mail z toho istého účtu sa dajú pripojiť ako konektor.',
  },
]

export async function comms(ctx) {
  const apps = await installedApps()
  const containers = IS_MAC ? [...(await names(join(HOME, 'Library', 'Containers'))), ...(await names(join(HOME, 'Library', 'Group Containers')))] : []
  const packages = IS_WIN ? await names(join(LOCALAPPDATA, 'Packages')) : []

  await ctx.step('chats', () => {
    for (const chat of CHATS) {
      const dirs = [chat.dir].flat().filter((d) => exists(d))
      const installed = apps.has(...chat.catalog)
      const boxed = chat.container ? containers.some((n) => chat.container.test(n)) : false
      const store = chat.pkg ? packages.some((n) => chat.pkg.test(n)) : false
      if (!dirs.length && !installed && !boxed && !store) continue
      const used = Math.max(0, ...dirs.map((d) => statOf(d)?.mtimeMs ?? 0))
      ctx.finding({
        id: `comms.${chat.id}`,
        category: 'comms',
        title: chat.name,
        detail: `${chat.name} máš v počítači${used ? ` (naposledy použitý ${ago(used)})` : ''}. ${chat.detail}`,
        path: dirs[0] ?? null,
        data: { app: chat.name, lastUsed: day(used), readable: false },
        use: chat.use,
        action: chat.action,
        weight: chat.weight,
      })
    }
  })

  // ── Messages on macOS ──
  if (IS_MAC && !ctx.allow.has('messages')) {
    ctx.finding({
      id: 'comms.messages',
      category: 'comms',
      title: 'Správy (iMessage a SMS)',
      detail: 'Appka Správy si históriu ukladá v Macu, ale macOS ju chráni. Bez povolenia som sa jej nedotkol.',
      data: { locked: 'messages' },
      use: 'Po povolení zistím, s kým si píšeš najviac (len počty správ, nie ich text).',
      action: 'ask',
      weight: 2,
    })
  }

  // ── Slack ──
  await ctx.step('slack', () => {
    const dir = dirFor('Slack', 'Slack', '.config/Slack')
    const boxed = containers.some((n) => /tinyspeck\.slackmacgap/i.test(n))
    if (!exists(dir) && !boxed && !apps.has('Slack')) return
    const state = readJson(join(dir ?? '', 'storage', 'root-state.json'))
    const teams = Object.values(state?.workspaces ?? state?.teams ?? {})
      .map((t) => ({ name: t?.name ?? t?.team_name ?? null, domain: t?.domain ?? null }))
      .filter((t) => t.name)
    const used = statOf(dir ?? '')?.mtimeMs ?? 0
    ctx.finding({
      id: 'comms.slack',
      category: 'comms',
      title: 'Slack',
      detail: teams.length ? `V Slacku si v ${sk(teams.length, 'tíme', 'tímoch', 'tímoch')}: ${some(teams.map((t) => t.name), 6)}${used ? ` (naposledy ${ago(used)})` : ''}.` : `Slack máš nainštalovaný${used ? `, naposledy použitý ${ago(used)}` : ''}. Názvy tímov z neho neviem prečítať.`,
      path: exists(dir) ? dir : null,
      data: { workspaces: teams, lastUsed: day(used) },
      use: 'Slack sa dá pripojiť ako konektor v nastaveniach Claude. Potom vidím správy naživo a viem ti z nich robiť prehľad.',
      action: 'connect',
      weight: 3,
    })
  })

  // ── Zoom ──
  await ctx.step('zoom', async () => {
    const dir = dirFor('zoom.us', 'Zoom', '.zoom')
    if (!exists(dir) && !apps.has('Zoom')) return
    const recDir = join((await userFolders()).documents, 'Zoom')
    const recordings = (await list(recDir)).entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse()
    ctx.finding({
      id: 'comms.zoom',
      category: 'comms',
      title: 'Zoom',
      detail: `Zoom máš nainštalovaný${exists(dir) ? `, naposledy použitý ${ago(statOf(dir)?.mtimeMs)}` : ''}.${recordings.length ? ` Máš ${sk(recordings.length, 'nahrávku', 'nahrávky', 'nahrávok')} hovorov, najnovšie: ${some(recordings, 3)}.` : ''}`,
      path: recordings.length ? recDir : exists(dir) ? dir : null,
      data: { recordings: recordings.slice(0, 40), lastUsed: day(statOf(dir ?? '')?.mtimeMs) },
      use: recordings.length ? 'Z názvov nahrávok vidím, s kým a kedy máš hovory. Prepis hovoru ti viem zhrnúť.' : 'Viem, že hovory riešiš cez Zoom.',
      action: recordings.length ? 'read' : 'none',
      weight: recordings.length ? 3 : 1,
    })
  })

  // ── mail clients ──
  await ctx.step('mail', async () => {
    const accounts = []
    const clients = []
    // Thunderbird keeps its accounts in a readable preferences file
    const tbRoot = IS_MAC ? join(HOME, 'Library', 'Thunderbird') : IS_WIN ? join(APPDATA, 'Thunderbird') : join(HOME, '.thunderbird')
    const ini = readText(join(tbRoot, 'profiles.ini'), 100_000)
    if (ini) {
      clients.push('Thunderbird')
      for (const m of ini.matchAll(/^Path=(.+)$/gm)) {
        const profile = m[1].trim().startsWith('/') || /^[A-Za-z]:/.test(m[1].trim()) ? m[1].trim() : join(tbRoot, m[1].trim())
        const prefs = readText(join(profile, 'prefs.js'), 3_000_000) ?? ''
        for (const hit of prefs.matchAll(/user_pref\("mail\.identity\.id\d+\.useremail",\s*"([^"]+)"\)/g)) accounts.push(hit[1])
      }
    }
    // Outlook on Windows names its data files after the mail address
    if (IS_WIN) {
      const files = (await names(join(LOCALAPPDATA, 'Microsoft', 'Outlook'))).filter((n) => /\.(ost|pst)$/i.test(n))
      if (files.length) clients.push('Outlook')
      for (const file of files) accounts.push(...(file.match(EMAIL_RE) ?? []))
    }
    if (IS_MAC && containers.some((n) => /UBF8T346G9\.Office/i.test(n)) && apps.has('Microsoft Outlook')) clients.push('Outlook')
    for (const name of ['Spark', 'Mimestream', 'Airmail', 'Superhuman', 'Canary Mail', 'Proton Mail', 'eM Client', 'Mailspring']) if (apps.has(name)) clients.push(name)
    if (IS_MAC) clients.push('Apple Mail')
    const mails = uniq(accounts.map((a) => a.toLowerCase()))
    ctx.identity({ emails: mails })
    if (!clients.length) return
    ctx.finding({
      id: 'comms.mail',
      category: 'comms',
      title: 'Mail',
      detail:
        `Mailové appky v počítači: ${uniq(clients).join(', ')}.` +
        (mails.length ? ` Nastavené adresy: ${some(mails, 5)}.` : '') +
        (IS_MAC ? ' Či a ako používaš Apple Mail, neviem zistiť bez povolenia, lebo macOS poštu chráni.' : ''),
      data: { clients: uniq(clients), accounts: mails },
      use: 'Najjednoduchšie je pripojiť mail ako konektor v nastaveniach Claude (Gmail alebo Outlook). Potom viem, kto ti píše a čo čaká na odpoveď.',
      action: 'connect',
      weight: 3,
    })
  })
}
