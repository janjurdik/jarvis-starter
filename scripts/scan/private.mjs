/**
 * Probe "private": data that macOS guards with a privacy prompt. Nothing here runs unless the
 * person agreed and the scan was started with --allow <id>. Without it, each source is only listed
 * in `permissions` together with what it would give.
 *
 *   contacts    names, birthdays, how many have a mail or phone (no numbers, no addresses)
 *   calendar    calendar names, accounts, number of events in the next 30 days
 *   reminders   list names and open counts
 *   photos      number of photos, years, album names, named people (no pictures opened)
 *   messages    top 30 chat partners by message count (no message text)
 *   applenotes  note titles and folders (no note bodies)
 *   icloud      names of folders in iCloud Drive
 */
import { join } from 'node:path'
import { IS_MAC, sh } from '../lib.mjs'
import { userFolders } from './index.mjs'
import { icloudPermission } from './notes.mjs'
import { HOME, ago, canSqlite, day, isDenied, list, names, sk, some, withDbCopy } from './util.mjs'

const FULL_DISK = `V Nastaveniach systému → Súkromie a bezpečnosť → Plný prístup k disku zapni Claude (alebo Terminál), zavri ho, otvor znova`

export const PERMISSIONS = {
  contacts: {
    title: 'Kontakty',
    gives: 'Mená ľudí z tvojho adresára, ich narodeniny a koľko z nich má mail alebo telefón. Čísla ani adresy si neukladám.',
    how: 'Spustím sken s --allow contacts. macOS ukáže okno, že chcem pristupovať ku kontaktom. Stačí kliknúť Povoliť.',
  },
  calendar: {
    title: 'Kalendár',
    gives: 'Názvy tvojich kalendárov a účtov a čo ťa čaká najbližších 30 dní.',
    how: 'Spustím sken s --allow calendar. macOS ukáže okno, že chcem pristupovať ku kalendáru. Stačí kliknúť Povoliť.',
  },
  reminders: {
    title: 'Pripomienky',
    gives: 'Zoznamy v appke Pripomienky a koľko otvorených úloh v nich máš.',
    how: 'Spustím sken s --allow reminders. macOS sa spýta, či smiem ovládať appku Pripomienky. Stačí kliknúť Povoliť.',
  },
  photos: {
    title: 'Fotky',
    gives: 'Koľko fotiek máš a z akých rokov, názvy albumov a mená ľudí, ktorých máš vo Fotkách pomenovaných. Samotné fotky neotváram.',
    how: 'Spustím sken s --allow photos. macOS ukáže okno o prístupe k Fotkám. Stačí kliknúť Povoliť.',
  },
  messages: {
    title: 'Správy (iMessage a SMS)',
    gives: 'S kým si píšeš najviac: 30 najčastejších kontaktov a počty správ. Text správ nečítam.',
    how: `Správy chráni macOS najprísnejšie. ${FULL_DISK} a potom spustím sken s --allow messages.`,
  },
}

/** Core Data counts seconds from 2001-01-01. Newer tables use nanoseconds. */
const cocoa = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n === 0) return null
  return ((n > 1e11 ? n / 1e9 : n) + 978_307_200) * 1000
}

/** A system dialog may be waiting for the person: give them time to read it and decide. */
const PATIENCE = 120_000

/** Runs a JavaScript-for-Automation script and parses its JSON output. Null when refused or failed. */
async function jxa(script, timeout = PATIENCE) {
  const res = await sh('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout })
  if (res.code !== 0) return null
  try {
    return JSON.parse(res.out)
  } catch {
    return null
  }
}

/** Queries a guarded database copy. Returns { ok, value } and marks `denied` when macOS refused. */
async function guardedDb(file, fn) {
  if (!(await canSqlite())) return { ok: false, denied: false }
  try {
    return { ok: true, value: await withDbCopy(file, fn) }
  } catch (err) {
    return { ok: false, denied: isDenied(err), error: err }
  }
}

const tryRows = async (query, sql) => {
  try {
    return await query(sql)
  } catch {
    return null
  }
}

export async function privateProbe(ctx) {
  if (!IS_MAC) return
  for (const [id, meta] of Object.entries(PERMISSIONS)) if (!ctx.allow.has(id)) ctx.permission({ id, ...meta })
  const refused = (id, how) => ctx.permission({ id, ...PERMISSIONS[id], how })

  // ── contacts ──
  if (ctx.allow.has('contacts')) {
    await ctx.step('contacts', async () => {
      const root = join(HOME, 'Library', 'Application Support', 'AddressBook')
      // the first touch of the address book is where macOS asks; a missing file simply fails below
      const sources = (await list(join(root, 'Sources'), PATIENCE)).entries.map((e) => e.name)
      const files = [...sources.map((s) => join(root, 'Sources', s, 'AddressBook-v22.abcddb')), join(root, 'AddressBook-v22.abcddb')]
      const people = new Map()
      let me = null
      let denied = false
      for (const file of files) {
        const res = await guardedDb(file, async (query) => {
          const base = `r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, r.ZORGANIZATION AS org, r.ZBIRTHDAY AS bday,
            (SELECT COUNT(*) FROM ZABCDEMAILADDRESS e WHERE e.ZOWNER = r.Z_PK) AS emails,
            (SELECT COUNT(*) FROM ZABCDPHONENUMBER p WHERE p.ZOWNER = r.Z_PK) AS phones`
          const where = 'FROM ZABCDRECORD r WHERE r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL OR r.ZORGANIZATION IS NOT NULL LIMIT 5000'
          const rows = (await tryRows(query, `SELECT ${base}, r.ZBIRTHDAYYEARLESS AS bdayNoYear ${where}`)) ?? (await tryRows(query, `SELECT ${base} ${where}`)) ?? []
          const mine = await tryRows(query, 'SELECT r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, r.ZBIRTHDAY AS bday FROM ZABCDRECORD r WHERE r.Z_PK IN (SELECT ZME FROM ZABCDCONTAINER WHERE ZME IS NOT NULL) LIMIT 1')
          return { rows, mine: mine?.[0] ?? null }
        })
        if (!res.ok) {
          denied ||= res.denied
          continue
        }
        me ??= res.value.mine
        for (const r of res.value.rows) {
          const name = [r.first, r.last].filter(Boolean).join(' ') || r.org
          if (!name || people.has(name)) continue
          // a birthday saved without a year is stored with a placeholder year (1604)
          const stamp = cocoa(r.bday) ?? (r.bdayNoYear != null ? cocoa(r.bdayNoYear) : null)
          const iso = stamp != null ? day(stamp) : null
          const birthday = iso && (Number(iso.slice(0, 4)) < 1900 || cocoa(r.bday) == null) ? iso.slice(5) : iso
          people.set(name, { name, org: r.first || r.last ? r.org ?? null : null, birthday, hasEmail: r.emails > 0, hasPhone: r.phones > 0 })
        }
      }
      if (!people.size) {
        // no readable database (or no SQLite reader): ask the Contacts app itself
        const res = await jxa(`const app = Application('Contacts'); const n = app.people.name(); const b = app.people.birthDate();
JSON.stringify(n.slice(0, 3000).map((name, i) => ({ name: name, birthday: b[i] ? b[i].toISOString().slice(0, 10) : null })))`)
        for (const p of res ?? []) if (p?.name) people.set(p.name, { name: p.name, org: null, birthday: p.birthday, hasEmail: null, hasPhone: null })
      }
      if (!people.size) {
        refused('contacts', denied ? 'macOS prístup ku kontaktom odmietol. Povoľ ho v Nastaveniach systému → Súkromie a bezpečnosť → Kontakty a spusti sken znova.' : 'Kontakty sa nepodarilo načítať. Skús to znova a v okne, ktoré macOS ukáže, klikni Povoliť.')
        return
      }
      const all = [...people.values()]
      const withBirthday = all.filter((p) => p.birthday)
      const shown = [...withBirthday, ...all.filter((p) => !p.birthday)].slice(0, 500)
      if (me) ctx.identity({ fullName: [me.first, me.last].filter(Boolean).join(' ') || null, birthday: cocoa(me.bday) ? day(cocoa(me.bday)) : null })
      ctx.finding({
        id: 'contacts.addressbook',
        category: 'contacts',
        title: 'Kontakty',
        detail: `V adresári máš ${sk(all.length, 'kontakt', 'kontakty', 'kontaktov')}, z toho ${withBirthday.length} s narodeninami${withBirthday.length ? ` (${some(withBirthday.map((p) => p.name), 5)})` : ''}.`,
        data: { total: all.length, withBirthday: withBirthday.length, withEmail: all.filter((p) => p.hasEmail).length, people: shown },
        use: 'Z kontaktov s narodeninami viem hneď založiť tvojich ľudí v pamäti a pripomínať ti ich sviatky.',
        action: 'read',
        weight: 5,
      })
    })
  }

  // ── calendar ──
  if (ctx.allow.has('calendar')) {
    await ctx.step('calendar', async () => {
      const files = [join(HOME, 'Library', 'Group Containers', 'group.com.apple.calendar', 'Calendar.sqlitedb'), join(HOME, 'Library', 'Calendars', 'Calendar.sqlitedb')]
      const now = Date.now() / 1000 - 978_307_200
      let out = null
      let denied = false
      for (const file of files) {
        const res = await guardedDb(file, async (query) => {
          const calendars = (await tryRows(query, 'SELECT c.title AS title, s.name AS account, (SELECT COUNT(*) FROM CalendarItem i WHERE i.calendar_id = c.ROWID) AS items FROM Calendar c LEFT JOIN Store s ON s.ROWID = c.store_id ORDER BY items DESC LIMIT 80')) ?? []
          const count = await tryRows(query, `SELECT COUNT(*) AS n FROM OccurrenceCache WHERE occurrence_date >= ${now} AND occurrence_date < ${now + 30 * 86_400}`)
          const next = (await tryRows(query, `SELECT i.summary AS title, o.occurrence_date AS at FROM OccurrenceCache o JOIN CalendarItem i ON i.ROWID = o.event_id WHERE o.occurrence_date >= ${now} AND o.occurrence_date < ${now + 30 * 86_400} ORDER BY o.occurrence_date LIMIT 60`)) ?? []
          return { calendars, upcoming: count?.[0]?.n ?? null, next }
        })
        if (res.ok && res.value.calendars.length) {
          out = res.value
          break
        }
        denied ||= res.denied === true
      }
      if (!out) {
        const res = await jxa(`const app = Application('Calendar'); JSON.stringify(app.calendars.name())`)
        if (Array.isArray(res)) out = { calendars: res.map((title) => ({ title, account: null, items: null })), upcoming: null, next: [] }
      }
      if (!out) {
        refused('calendar', denied ? 'macOS prístup ku kalendáru odmietol. Povoľ ho v Nastaveniach systému → Súkromie a bezpečnosť → Kalendáre a spusti sken znova.' : 'Kalendár sa nepodarilo načítať. Skús to znova a v okne, ktoré macOS ukáže, klikni Povoliť.')
        return
      }
      const used = out.calendars.filter((c) => c.items == null || c.items > 0)
      ctx.finding({
        id: 'calendar.apple',
        category: 'calendar',
        title: 'Kalendár v Macu',
        detail:
          `V appke Kalendár máš ${sk(used.length, 'kalendár', 'kalendáre', 'kalendárov')}: ${some(used.map((c) => c.title), 8)}.` +
          (out.upcoming != null ? ` V najbližších 30 dňoch: ${sk(out.upcoming, 'udalosť', 'udalosti', 'udalostí')}.` : ''),
        data: {
          calendars: out.calendars,
          accounts: [...new Set(out.calendars.map((c) => c.account).filter(Boolean))],
          upcoming30Days: out.upcoming,
          next: out.next.map((e) => ({ title: e.title, at: cocoa(e.at) ? new Date(cocoa(e.at)).toISOString() : null })),
        },
        use: 'Viem, kde máš kalendár. Udalosti si zapíšem do pamäte, aby ich videl aj ranný brief.',
        action: 'read',
        weight: 5,
      })
    })
  }

  // ── reminders ──
  if (ctx.allow.has('reminders')) {
    await ctx.step('reminders', async () => {
      const res = await jxa(`const app = Application('Reminders');
JSON.stringify(app.lists().map(function (l) { var open = null; try { open = l.reminders.whose({ completed: false }).length } catch (e) {} return { name: l.name(), open: open } }))`)
      if (!Array.isArray(res)) {
        refused('reminders', 'Pripomienky sa nepodarilo načítať. Povoľ ovládanie appky Pripomienky v Nastaveniach systému → Súkromie a bezpečnosť → Automatizácia a spusti sken znova.')
        return
      }
      const open = res.reduce((n, l) => n + (l.open ?? 0), 0)
      ctx.finding({
        id: 'calendar.reminders',
        category: 'calendar',
        title: 'Pripomienky',
        detail: `V appke Pripomienky máš ${sk(res.length, 'zoznam', 'zoznamy', 'zoznamov')} (${some(res.map((l) => l.name), 8)}) a v nich ${sk(open, 'otvorenú úlohu', 'otvorené úlohy', 'otvorených úloh')}.`,
        data: { lists: res, open },
        use: 'Viem, že si úlohy píšeš do Pripomienok. Môžem ich prevziať do svojho zoznamu úloh, aby neboli dva systémy vedľa seba.',
        action: 'read',
        weight: open ? 4 : 2,
      })
    })
  }

  // ── photos ──
  if (ctx.allow.has('photos')) {
    await ctx.step('photos', async () => {
      const pictures = (await userFolders()).pictures
      const library = (await names(pictures)).filter((n) => n.endsWith('.photoslibrary')).map((n) => join(pictures, n))[0]
      if (!library) return
      const res = await guardedDb(join(library, 'database', 'Photos.sqlite'), async (query) => {
        const total = (await tryRows(query, 'SELECT COUNT(*) AS n, MIN(ZDATECREATED) AS first, MAX(ZDATECREATED) AS last FROM ZASSET WHERE ZTRASHEDSTATE = 0'))?.[0]
        const kinds = (await tryRows(query, 'SELECT ZKIND AS kind, COUNT(*) AS n FROM ZASSET WHERE ZTRASHEDSTATE = 0 GROUP BY ZKIND')) ?? []
        const years = (await tryRows(query, "SELECT CAST(strftime('%Y', ZDATECREATED + 978307200, 'unixepoch') AS INTEGER) AS year, COUNT(*) AS n FROM ZASSET WHERE ZTRASHEDSTATE = 0 GROUP BY year ORDER BY year")) ?? []
        const people = (await tryRows(query, "SELECT ZFULLNAME AS name, ZFACECOUNT AS faces FROM ZPERSON WHERE ZFULLNAME IS NOT NULL AND ZFULLNAME != '' ORDER BY ZFACECOUNT DESC LIMIT 100")) ?? []
        const albums = (await tryRows(query, 'SELECT ZTITLE AS title, ZCACHEDCOUNT AS n FROM ZGENERICALBUM WHERE ZTITLE IS NOT NULL AND ZTRASHEDSTATE = 0 AND ZKIND = 2 ORDER BY ZCACHEDCOUNT DESC LIMIT 100')) ?? []
        return { total, kinds, years, people, albums }
      })
      if (!res.ok || !res.value.total) {
        refused('photos', res.denied ? 'macOS prístup k Fotkám odmietol. Povoľ ho v Nastaveniach systému → Súkromie a bezpečnosť → Fotky a spusti sken znova.' : 'Knižnicu Fotiek sa nepodarilo prečítať. Skús to znova a v okne, ktoré macOS ukáže, klikni Povoliť.')
        return
      }
      const v = res.value
      const videos = v.kinds.find((k) => k.kind === 1)?.n ?? 0
      ctx.finding({
        id: 'photos.library',
        category: 'photos',
        title: 'Knižnica Fotiek',
        detail:
          `Vo Fotkách máš ${sk(v.total.n - videos, 'fotku', 'fotky', 'fotiek')} a ${sk(videos, 'video', 'videá', 'videí')} z rokov ${day(cocoa(v.total.first))?.slice(0, 4)} až ${day(cocoa(v.total.last))?.slice(0, 4)}.` +
          (v.people.length ? ` Pomenovaní ľudia: ${some(v.people.map((p) => p.name), 8)}.` : '') +
          (v.albums.length ? ` Albumy: ${some(v.albums.map((a) => a.title), 8)}.` : ''),
        path: library,
        data: { photos: v.total.n - videos, videos, first: day(cocoa(v.total.first)), last: day(cocoa(v.total.last)), byYear: v.years.filter((y) => y.year > 1990), people: v.people, albums: v.albums },
        use: 'Ľudia, ktorých máš vo Fotkách pomenovaných, sú tvoji najbližší. Albumy a roky mi ukážu tvoje cesty a dôležité chvíle.',
        action: 'read',
        weight: 5,
      })
    })
  }

  // ── messages ──
  if (ctx.allow.has('messages')) {
    await ctx.step('messages', async () => {
      const res = await guardedDb(join(HOME, 'Library', 'Messages', 'chat.db'), async (query) => {
        const total = (await tryRows(query, 'SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM message'))?.[0]
        const partners = (await tryRows(query, 'SELECT h.id AS handle, COUNT(*) AS n, SUM(m.is_from_me) AS mine, MAX(m.date) AS last FROM message m JOIN handle h ON h.ROWID = m.handle_id GROUP BY h.id ORDER BY n DESC LIMIT 30')) ?? []
        const groups = (await tryRows(query, "SELECT display_name AS name FROM chat WHERE display_name IS NOT NULL AND display_name != '' LIMIT 40")) ?? []
        return { total, partners, groups }
      })
      if (!res.ok || !res.value.total) {
        refused('messages', `macOS prístup k Správam odmietol. ${FULL_DISK} a spusti sken znova.`)
        return
      }
      const v = res.value
      ctx.finding({
        id: 'comms.messages',
        category: 'comms',
        title: 'Správy (iMessage a SMS)',
        detail: `V Správach máš ${sk(v.total.n, 'správu', 'správy', 'správ')} od ${day(cocoa(v.total.first))} do ${day(cocoa(v.total.last))}. Najviac si píšeš s ${sk(v.partners.length, 'kontaktom', 'kontaktmi', 'kontaktmi')}, prvý má ${v.partners[0]?.n ?? 0} správ.`,
        data: {
          total: v.total.n,
          first: day(cocoa(v.total.first)),
          last: day(cocoa(v.total.last)),
          partners: v.partners.map((p) => ({ handle: p.handle, messages: p.n, fromMe: p.mine, last: day(cocoa(p.last)) })),
          groups: v.groups.map((g) => g.name),
        },
        use: 'Podľa počtu správ viem, kto sú tvoji najbližší ľudia. Čísla si spárujem s kontaktmi, text správ nečítam.',
        action: 'read',
        weight: 4,
      })
    })
  }

  // ── Apple Notes ──
  if (ctx.allow.has('applenotes')) {
    await ctx.step('applenotes', async () => {
      let out = null
      const res = await guardedDb(join(HOME, 'Library', 'Group Containers', 'group.com.apple.notes', 'NoteStore.sqlite'), async (query) => {
        const alive = '(ZMARKEDFORDELETION IS NULL OR ZMARKEDFORDELETION = 0)'
        const count = (await tryRows(query, `SELECT COUNT(*) AS n FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE1 IS NOT NULL AND ${alive}`))?.[0]?.n
        const titles = (await tryRows(query, `SELECT ZTITLE1 AS title, ZMODIFICATIONDATE1 AS at FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE1 IS NOT NULL AND ${alive} ORDER BY ZMODIFICATIONDATE1 DESC LIMIT 60`)) ?? []
        const folders = (await tryRows(query, `SELECT ZTITLE2 AS title FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE2 IS NOT NULL AND ${alive} LIMIT 60`)) ?? []
        return { count, titles: titles.map((t) => ({ title: t.title, modified: day(cocoa(t.at)) })), folders: folders.map((f) => f.title) }
      })
      if (res.ok && res.value.count != null) out = res.value
      if (!out) {
        const viaApp = await jxa(`const app = Application('Notes'); const n = app.notes.name(); JSON.stringify({ count: n.length, titles: n.slice(0, 60), folders: app.folders.name() })`)
        if (viaApp) out = { count: viaApp.count, titles: viaApp.titles.map((title) => ({ title, modified: null })), folders: viaApp.folders }
      }
      if (!out) {
        ctx.permission({ id: 'applenotes', title: 'Apple Poznámky', gives: 'Názvy poznámok a priečinkov v appke Poznámky.', how: 'Poznámky sa nepodarilo načítať. Povoľ ovládanie appky Poznámky v Nastaveniach systému → Súkromie a bezpečnosť → Automatizácia a spusti sken znova.' })
        return
      }
      const newest = out.titles[0]?.modified ? Date.parse(out.titles[0].modified) : 0
      ctx.finding({
        id: 'notes.apple',
        category: 'notes',
        title: 'Apple Poznámky',
        detail: `V appke Poznámky máš ${sk(out.count, 'poznámku', 'poznámky', 'poznámok')}${out.folders.length ? ` v priečinkoch ${some([...new Set(out.folders)], 6)}` : ''}${newest ? `, posledná zmena ${ago(newest)}` : ''}. Naposledy: ${some(out.titles.map((t) => t.title), 5)}.`,
        data: { notes: out.count, folders: [...new Set(out.folders)], recent: out.titles },
        use: 'Podľa názvov ti poviem, ktoré poznámky stoja za prenesenie. Ich obsah mi potom stačí skopírovať alebo vyexportovať.',
        action: 'ask',
        weight: out.count >= 20 ? 4 : 2,
      })
    })
  }

  // ── iCloud Drive ──
  if (ctx.allow.has('icloud')) {
    await ctx.step('icloud', async () => {
      const root = join(HOME, 'Library', 'Mobile Documents')
      const drive = await list(join(root, 'com~apple~CloudDocs'), PATIENCE)
      if (!drive.ok) {
        if (drive.denied) ctx.permission({ ...icloudPermission(), how: 'macOS prístup k iCloud Drive odmietol. Povoľ ho v Nastaveniach systému → Súkromie a bezpečnosť → Súbory a priečinky a spusti sken znova.' })
        return
      }
      const folders = drive.entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
      const appFolders = (await names(root)).filter((n) => n !== 'com~apple~CloudDocs' && !n.startsWith('.')).map((n) => n.replace(/^iCloud~/, '').replace(/~/g, '.'))
      ctx.finding({
        id: 'documents.icloud',
        category: 'documents',
        title: 'iCloud Drive',
        detail: `V iCloud Drive máš ${sk(folders.length, 'priečinok', 'priečinky', 'priečinkov')}${folders.length ? `: ${some(folders, 10)}` : ''}. Dáta si tam ukladá ${sk(appFolders.length, 'appka', 'appky', 'appiek')}.`,
        path: join(root, 'com~apple~CloudDocs'),
        data: { folders: folders.slice(0, 80), apps: appFolders.slice(0, 80) },
        use: 'Viem, čo máš uložené v iCloude, a môžem tam hľadať poznámky a dokumenty z telefónu.',
        action: 'read',
        weight: 2,
      })
    })
  }
}

/** Ids that --allow accepts. */
export const ALLOW_IDS = [...Object.keys(PERMISSIONS), 'applenotes', 'icloud', 'safari']
