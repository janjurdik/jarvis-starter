// Step-by-step content for every source. Click paths, labels, waiting times and gotchas come from the
// verified export research; anything that research marked as unverified is phrased softly or left out.
//
// A guide:  { onPhone, before: { need, time, arrives, file }, watch: [...], note, steps: [Step], variants: [{ id, name, ...guide }] }
// A step:   { t: short title, d: instruction, note, link: { url, hint }, scene }
// Text markup in d / note / watch:  [[Slovak label|English label]] or [[Label]] renders as a button chip.
// Scenes are described in scene.js.

import { row, head, btn, chk, tog, opt, big, field, mail, file, prog, fill, chat, who, apps, sheet, hid } from './scene.js'

// ── shared pieces ───────────────────────────────────────────────────────────

/** A mail arrives, its button gets pressed and the file shows up. */
const mailScene = (from, button, o = {}) => ({
  frame: o.frame ?? 'browser',
  url: 'tvoj mail',
  bar: { title: 'Doručená pošta' },
  items: [hid(mail('m', { from, btn: button ?? true })), hid(file('f', o.file ?? 'Súbor ZIP', o.meta ?? 'stiahnuté', { icon: o.icon })), fill(2)],
  acts: [['show', 'm'], ['wait', 500], ['tap', 'm-btn'], ['show', 'f'], ['hot', 'f']],
})

const password = (id = 'pw') => sheet(id, [field(`${id}-f`, 'Heslo'), btn(`${id}-ok`, null, { icon: 'check', primary: true })], { kind: 'dialog' })

const toFiles = (id, list) => sheet(id, list, { kind: 'sheet' })

// ── Meta (Instagram and Facebook share the Accounts Center flow) ────────────

const M = {
  ac: ['Centrum účtov', 'Accounts Center'],
  info: ['Vaše informácie a povolenia', 'Your information and permissions'],
  exp: ['Exportujte svoje informácie', 'Export your information'],
  create: ['Vytvoriť export', 'Create export'],
  todev: ['Exportovať do zariadenia', 'Export to device'],
  toext: ['Exportovať do externej služby', 'Export to external service'],
  next: ['Ďalej', 'Next'],
  start: ['Začať export', 'Start export'],
  avail: ['Dostupné na stiahnutie', 'Available downloads'],
  range: ['Rozsah dátumov', 'Date range'],
  format: ['Formát', 'Format'],
  quality: ['Kvalita médií', 'Media quality'],
}

const meta = {
  center: { bar: { title: M.ac, back: true }, items: [fill(2), row('info', M.info, { icon: 'shield' }), fill(2)] },
  info: { bar: { title: M.info, back: true }, items: [fill(1), row('exp', M.exp, { icon: 'down' }), fill(3)] },
  exp: { bar: { title: M.exp, back: true }, items: [btn('create', M.create, { primary: true }), fill(2)] },
  profile: (name) => ({ bar: { title: M.create, back: true }, items: [chk('prof', name, false, { sub: 'tvoj profil' }), fill(1), btn('next', M.next, { primary: true })] }),
  where: { bar: { title: M.create, back: true }, items: [row('todev', M.todev, { icon: 'phone' }), row('toext', M.toext, { icon: 'cloud', dim: true })] },
  confirm: (v = {}) => ({
    bar: { title: 'Confirm your export', back: true },
    items: [
      row('custom', 'Customize information'),
      row('range', M.range, { val: v.range ?? 'Last year' }),
      row('format', M.format, { val: v.format ?? 'HTML' }),
      row('quality', M.quality, { val: v.quality ?? 'Medium' }),
      row('notify', 'Notify', { val: 'e-mail' }),
      btn('start', M.start, { primary: true }),
      password(),
    ],
  }),
  range: { bar: { title: M.range, back: true }, items: [opt('r-year', 'Last year', true), fill(1), opt('r-all', 'All time'), btn('r-save', 'Save', { primary: true })] },
  format: { bar: { title: M.format, back: true }, items: [opt('f-html', 'HTML', true), opt('f-json', 'JSON'), btn('f-save', 'Save', { primary: true })] },
  custom: (list) => ({ bar: { title: 'Customize information', back: true }, items: [...list.map(([id, label]) => chk(id, label)), fill(2), btn('c-save', 'Save', { primary: true })] }),
  downloads: { bar: { title: M.exp, back: true }, items: [head(M.avail), file('zip', 'Tvoj export', 'ZIP · 4 dni na stiahnutie', { btn: true })] },
}

const setRange = [['tap', 'range'], ['go', 'range'], ['pick', 'r-all'], ['tap', 'r-save'], ['back', 'confirm'], ['set', 'range', 'All time']]
const setFormat = [['tap', 'format'], ['go', 'format'], ['pick', 'f-json'], ['tap', 'f-save'], ['back', 'confirm'], ['set', 'format', 'JSON']]
const startExport = [['tap', 'start'], ['open', 'pw'], ['tap', 'pw-f'], ['type', 'pw-f', '••••••••'], ['tap', 'pw-ok'], ['close', 'pw'], ['toast', 'Export sa pripravuje']]

const igProfile = {
  bar: { title: 'tvoj_profil', right: [{ id: 'menu', icon: 'menu' }] },
  items: [who('Ty', 'tvoj profil'), fill(3)],
  tabbar: [{ icon: 'home' }, { icon: 'search' }, { icon: 'plus' }, { icon: 'heart' }, { avatar: true, on: true }],
}
const igMenu = { bar: { title: 'Nastavenia', back: true }, items: [row('ac', M.ac, { icon: 'user' }), fill(5)] }

const instagram = {
  onPhone: true,
  before: {
    need: 'Telefón alebo počítač a heslo k Instagramu.',
    time: '5 minút klikania. Potom čakáš, väčšinou do 2 dní. Oficiálne to môže trvať až 30 dní.',
    arrives: 'Príde ti mail aj upozornenie v Instagrame. Súbor si stiahneš priamo v Instagrame.',
    file: 'Jeden súbor ZIP. Pri veľkom účte ich príde viac.',
  },
  note: 'Slovenské názvy sú z oficiálnej nápovede. V appke môžu byť niektoré napísané trochu inak.',
  watch: [
    'Instagram má prednastavený formát HTML a len posledný rok. Bez zmeny na [[JSON]] a [[All time]] dostaneš málo a v tvare, ktorý sa zle číta.',
    'Súbor je na stiahnutie len 4 dni. Potom treba žiadať znova.',
    'Ak ti príde viac ZIP súborov, pretiahni Jarvisovi všetky.',
    'Miznúce správy a fotky na jedno pozretie v exporte nie sú.',
    'Tlačidlá sa môžu volať aj po starom: Stiahnutie svojich informácií, Stiahnuť do zariadenia, Vytvoriť súbory. Cesta je tá istá.',
  ],
  steps: [
    {
      t: 'Otvor ponuku vo svojom profile',
      d: 'V appke Instagram choď na svoj profil a ťukni na ponuku (tri čiarky). Na počítači klikni vľavo dole na [[Viac|More]] a potom na [[Nastavenia|Settings]].',
      link: { url: 'https://accountscenter.instagram.com/', hint: 'Skratka. Otvorí rovno Centrum účtov, potom pokračuj krokom 3.' },
      scene: { frame: 'phone', screens: { profile: igProfile, menu: igMenu }, acts: [['tap', 'menu'], ['go', 'menu'], ['hot', 'ac']] },
    },
    {
      t: 'Ťukni na Centrum účtov',
      d: 'Hneď hore je [[Centrum účtov|Accounts Center]]. U niekoho sa už volá [[Meta Account]]. Je to to isté.',
      scene: { frame: 'phone', screens: { menu: igMenu, center: meta.center }, acts: [['tap', 'ac'], ['go', 'center'], ['hot', 'info']] },
    },
    {
      t: 'Otvor Vaše informácie a povolenia',
      d: 'V Centre účtov ťukni na [[Vaše informácie a povolenia|Your information and permissions]].',
      scene: { frame: 'phone', screens: { center: meta.center, info: meta.info }, acts: [['tap', 'info'], ['go', 'info'], ['hot', 'exp']] },
    },
    {
      t: 'Vytvor nový export',
      d: 'Ťukni na [[Exportujte svoje informácie|Export your information]] a potom na [[Vytvoriť export|Create export]].',
      scene: { frame: 'phone', screens: { info: meta.info, exp: meta.exp }, acts: [['tap', 'exp'], ['go', 'exp'], ['tap', 'create']] },
    },
    {
      t: 'Vyber profil a stiahnutie do zariadenia',
      d: 'Označ svoj instagramový profil a daj [[Ďalej|Next]]. Potom vyber [[Exportovať do zariadenia|Export to device]].',
      scene: { frame: 'phone', screens: { profile: meta.profile('Instagram'), where: meta.where }, acts: [['tick', 'prof'], ['tap', 'next'], ['go', 'where'], ['tap', 'todev']] },
    },
    {
      t: 'Nastav celé obdobie',
      d: 'Toto je najdôležitejší krok. Ťukni na [[Rozsah dátumov|Date range]], vyber [[All time]] (celé obdobie) a ulož cez [[Save]]. Prednastavený je len posledný rok.',
      scene: { frame: 'phone', screens: { confirm: meta.confirm(), range: meta.range }, acts: setRange },
    },
    {
      t: 'Zmeň formát na JSON',
      d: 'Ťukni na [[Formát|Format]], vyber [[JSON]] a ulož. Prednastavené je HTML a to sa Jarvisovi číta horšie.',
      scene: { frame: 'phone', screens: { confirm: meta.confirm({ range: 'All time' }), format: meta.format }, acts: setFormat },
    },
    {
      t: 'Vyber len to dôležité',
      d: 'Nepovinné, ale export príde rýchlejšie. V [[Customize information]] zaškrtni [[Messages]], [[Personal information]] a [[Followers and following]]. Ostatné odškrtni. [[Kvalita médií|Media quality]] stačí Medium alebo Lower.',
      scene: {
        frame: 'phone',
        screens: {
          confirm: meta.confirm({ range: 'All time', format: 'JSON' }),
          custom: meta.custom([['c-msg', 'Messages'], ['c-per', 'Personal information'], ['c-fol', 'Followers and following']]),
        },
        acts: [['tap', 'custom'], ['go', 'custom'], ['tick', 'c-msg'], ['tick', 'c-per'], ['tick', 'c-fol'], ['tap', 'c-save'], ['back', 'confirm'], ['hot', 'custom']],
      },
    },
    {
      t: 'Spusti export',
      d: 'Ťukni na [[Začať export|Start export]]. Ak si Instagram vypýta heslo, zadaj ho. Odteraz už len čakáš.',
      scene: { frame: 'phone', screens: { confirm: meta.confirm({ range: 'All time', format: 'JSON' }) }, acts: startExport },
    },
    {
      t: 'Stiahni súbor, keď príde mail',
      d: 'Keď príde mail alebo upozornenie, vráť sa do [[Exportujte svoje informácie|Export your information]]. V časti [[Dostupné na stiahnutie|Available downloads]] si stiahni ZIP. Máš na to 4 dni.',
      scene: {
        frame: 'phone',
        screens: { mail: { bar: { title: 'Pošta' }, items: [hid(mail('m', { from: 'Instagram', btn: true })), fill(3)] }, dl: meta.downloads },
        acts: [['show', 'm'], ['wait', 400], ['tap', 'm-btn'], ['go', 'dl'], ['tap', 'zip-btn'], ['hot', 'zip'], ['toast', 'Stiahnuté']],
      },
    },
  ],
}

// ── Facebook + Messenger ────────────────────────────────────────────────────

const fbTop = { title: 'Facebook', right: [{ id: 'msg', icon: 'chat' }, { icon: 'bell' }, { id: 'me', avatar: true }] }

const facebookMain = {
  onPhone: false,
  before: {
    need: 'Počítač alebo telefón a heslo k Facebooku.',
    time: '10 minút klikania. Export býva hotový za pár hodín, oficiálne to môže trvať až 30 dní.',
    arrives: 'Mail aj upozornenie na Facebooku. Súbor stiahneš priamo tam.',
    file: 'Jeden alebo viac ZIP súborov. V niektorých sú len fotky a videá z chatov.',
  },
  note: 'Slovenské názvy sú z oficiálnej nápovede. Na tvojom Facebooku môžu byť niektoré napísané trochu inak.',
  watch: [
    'Na celú históriu Messengera treba dve stiahnutia. Novšie šifrované chaty v tomto exporte nie sú, pozri záložku Šifrované chaty.',
    'Prednastavené je HTML a posledný rok. Zmeň to na [[JSON]] a [[All time]].',
    'Súbor je na stiahnutie len 4 dni.',
    'Ak príde viac ZIP súborov, pretiahni Jarvisovi všetky.',
  ],
  steps: [
    {
      t: 'Otvor nastavenia Facebooku',
      d: 'Na facebook.com klikni vpravo hore na svoju profilovú fotku. Vyber [[Nastavenia a súkromie|Settings & privacy]] a potom [[Nastavenia|Settings]].',
      link: { url: 'https://accountscenter.facebook.com/', hint: 'Skratka do Centra účtov. Ak sa otvorí niečo iné, pokračuj podľa krokov.' },
      scene: {
        frame: 'browser',
        url: 'facebook.com',
        bar: fbTop,
        items: [
          fill(5),
          sheet('m1', [row('sp', ['Nastavenia a súkromie', 'Settings & privacy'], { icon: 'gear' }), fill(2)], { kind: 'menu', at: 'tr' }),
          sheet('m2', [row('set', ['Nastavenia', 'Settings'], { icon: 'gear' }), fill(2)], { kind: 'menu', at: 'tr' }),
        ],
        acts: [['tap', 'me'], ['open', 'm1'], ['tap', 'sp'], ['close', 'm1'], ['open', 'm2'], ['tap', 'set']],
      },
    },
    {
      t: 'Choď do Centra účtov',
      d: 'Klikni na [[Centrum účtov|Accounts Center]] (môže sa volať aj [[Meta Account]]). Potom na [[Vaše informácie a povolenia|Your information and permissions]].',
      scene: {
        frame: 'browser',
        url: 'facebook.com',
        screens: { set: { bar: { title: ['Nastavenia', 'Settings'] }, items: [row('ac', M.ac, { icon: 'user' }), fill(4)] }, center: meta.center },
        acts: [['tap', 'ac'], ['go', 'center'], ['tap', 'info']],
      },
    },
    {
      t: 'Vytvor nový export',
      d: 'Klikni na [[Exportujte svoje informácie|Export your information]] a potom na [[Vytvoriť export|Create export]].',
      scene: { frame: 'browser', url: 'facebook.com', screens: { info: meta.info, exp: meta.exp }, acts: [['tap', 'exp'], ['go', 'exp'], ['tap', 'create']] },
    },
    {
      t: 'Vyber profil a stiahnutie do zariadenia',
      d: 'Označ svoj facebookový profil. Potom vyber [[Exportovať do zariadenia|Export to device]].',
      scene: { frame: 'browser', url: 'facebook.com', screens: { profile: meta.profile('Facebook'), where: meta.where }, acts: [['tick', 'prof'], ['tap', 'next'], ['go', 'where'], ['tap', 'todev']] },
    },
    {
      t: 'Nastav JSON a celé obdobie',
      d: 'Zmeň [[Formát|Format]] na [[JSON]] a [[Rozsah dátumov|Date range]] na [[All time]]. Každú zmenu ulož cez [[Save]]. [[Kvalita médií|Media quality]] daj na Lower, inak bude súbor obrovský.',
      scene: { frame: 'browser', url: 'facebook.com', screens: { confirm: meta.confirm(), format: meta.format, range: meta.range }, acts: [...setFormat, ...setRange] },
    },
    {
      t: 'Nechaj správy a profil',
      d: 'V [[Customize information]] nechaj aspoň [[Messages]] a [[Profile information]]. Ak chceš, pridaj priateľov. [[Data logs]] vynechaj, veľmi to spomaľujú.',
      scene: {
        frame: 'browser',
        url: 'facebook.com',
        screens: { confirm: meta.confirm({ range: 'All time', format: 'JSON', quality: 'Lower' }), custom: meta.custom([['c-msg', 'Messages'], ['c-pro', 'Profile information']]) },
        acts: [['tap', 'custom'], ['go', 'custom'], ['tick', 'c-msg'], ['tick', 'c-pro'], ['tap', 'c-save'], ['back', 'confirm'], ['hot', 'custom']],
      },
    },
    {
      t: 'Spusti export',
      d: 'Klikni na [[Začať export|Start export]] a zadaj heslo. Odteraz už len čakáš.',
      scene: { frame: 'browser', url: 'facebook.com', screens: { confirm: meta.confirm({ range: 'All time', format: 'JSON', quality: 'Lower' }) }, acts: startExport },
    },
    {
      t: 'Stiahni súbor, keď príde mail',
      d: 'Keď príde mail alebo upozornenie, otvor [[Dostupné na stiahnutie|Available downloads]] a stiahni všetky ZIP súbory. Máš na to 4 dni.',
      scene: {
        frame: 'browser',
        url: 'facebook.com',
        screens: { mail: { bar: { title: 'Doručená pošta' }, items: [hid(mail('m', { from: 'Facebook', btn: true })), fill(3)] }, dl: meta.downloads },
        acts: [['show', 'm'], ['wait', 400], ['tap', 'm-btn'], ['go', 'dl'], ['tap', 'zip-btn'], ['hot', 'zip'], ['toast', 'Stiahnuté']],
      },
    },
  ],
}

const msgSide = [head('Chats', { id: 'opt', icon: 'dotsh' }), fill(5)]
const msgSet = (on) => [head('Chats'), row('hist', 'Chat history', { chev: false, on }), fill(3)]

const facebookMessenger = {
  onPhone: false,
  before: {
    need: 'Počítač, heslo k Facebooku a PIN k zálohe chatov, ak ho máš nastavený.',
    time: 'Pár minút. Stránku nechaj celý čas otvorenú.',
    arrives: 'Nič nechodí mailom. Súbor sa stiahne rovno v prehliadači.',
    file: 'Jeden ZIP, zvyčajne messages.zip.',
  },
  note: 'Slovenské názvy týchto tlačidiel sa nepodarilo overiť. Ak máš Facebook po slovensky, budú preložené. Poradie je rovnaké.',
  watch: [
    'Bez tohto kroku ti budú chýbať novšie správy. Od decembra 2023 je väčšina chatov šifrovaná a v hlavnom exporte končia dňom prepnutia.',
    'Záloha chatov (bezpečné úložisko s PIN kódom) musí byť zapnutá.',
    'Ide to len na počítači.',
    'Ak to v Safari nejde, skús Chrome.',
  ],
  steps: [
    {
      t: 'Otvor Messenger na počítači',
      d: 'Choď na facebook.com a klikni vpravo hore na ikonu Messengera.',
      link: { url: 'https://www.facebook.com/messages', hint: 'Otvorí správy na Facebooku.' },
      scene: {
        frame: 'browser',
        url: 'facebook.com',
        screens: { home: { bar: fbTop, items: [fill(5)] }, chats: { bar: fbTop, side: msgSide, items: [chat()] } },
        acts: [['tap', 'msg'], ['go', 'chats'], ['hot', 'opt']],
      },
    },
    {
      t: 'Otvor nastavenia chatov',
      d: 'Vedľa nadpisu [[Chats]] klikni na [[Options]] (tri bodky). Otvoria sa nastavenia chatov.',
      scene: {
        frame: 'browser',
        url: 'facebook.com/messages',
        screens: { chats: { bar: fbTop, side: msgSide, items: [chat()] }, set: { bar: fbTop, side: msgSet(false), items: [fill(4)] } },
        acts: [['tap', 'opt'], ['go', 'set'], ['hot', 'hist']],
      },
    },
    {
      t: 'Stiahni zálohu chatov',
      d: 'Klikni na [[Chat history]], potom na [[Last backup]] a nakoniec na [[Download chat backup]].',
      scene: {
        frame: 'browser',
        url: 'facebook.com/messages',
        screens: {
          set: { bar: fbTop, side: msgSet(false), items: [fill(4)] },
          hist: { bar: fbTop, side: msgSet(true), items: [big('Chat history'), row('last', 'Last backup'), fill(2)] },
          last: { bar: fbTop, side: msgSet(true), items: [big('Last backup'), fill(1), btn('dl', 'Download chat backup', { primary: true })] },
        },
        acts: [['tap', 'hist'], ['go', 'hist'], ['tap', 'last'], ['go', 'last'], ['tap', 'dl']],
      },
    },
    {
      t: 'Potvrď a počkaj',
      d: 'Potvrď heslom alebo PIN kódom. Kartu nechaj otvorenú, kým sa ZIP nestiahne. Trvá to pár minút.',
      scene: {
        frame: 'browser',
        url: 'facebook.com/messages',
        bar: fbTop,
        side: msgSet(true),
        items: [big('Last backup'), prog('p', 'Pripravuje sa záloha'), hid(file('f', 'messages.zip', 'stiahnuté')), password()],
        acts: [['open', 'pw'], ['tap', 'pw-f'], ['type', 'pw-f', '••••••'], ['tap', 'pw-ok'], ['close', 'pw'], ['run', 'p'], ['show', 'f'], ['hot', 'f']],
      },
    },
  ],
}

// ── WhatsApp ────────────────────────────────────────────────────────────────

const people = (ids) => ids.map(([id, name]) => chk(id, name))
const waRepeat = {
  frame: 'phone',
  bar: { title: 'Chaty' },
  items: people([['p1', 'Mama'], ['p2', 'Otec'], ['p3', 'Najlepší kamoš'], ['p4', 'Rodina'], ['p5', 'Partia zo školy'], ['p6', 'Kolega']]),
  acts: [['tick', 'p1'], ['tick', 'p2'], ['tick', 'p3'], ['tick', 'p4'], ['tick', 'p5']],
}
const waWatch = [
  'Exportuje sa vždy len jeden chat. Začni 5 až 10 najdôležitejšími ľuďmi.',
  'Pri veľmi dlhých chatoch môže byť v súbore len novšia časť. Bez médií sa toho zmestí viac.',
  'Správy na jedno zobrazenie sa neexportujú.',
  'V skupine sú správy až odo dňa, keď si sa pridal.',
  'Požiadať o informácie o účte nie je to isté. Správy v tom nie sú.',
  'Mail zvládne len malé súbory. Väčšie pošli cez AirDrop, iCloud Drive alebo Disk Google.',
]
const waChat = (right) => ({ bar: { title: 'Mama', back: true, avatar: true, id: 'name', right }, items: [chat()] })
const waInfo = { bar: { title: '', back: true }, items: [who('Mama', 'kontakt'), fill(6), row('exp', ['Exportovanie chatov', 'Export chat'], { icon: 'share', chev: false }), fill(2)] }
const waMediaIos = sheet('media', [row('nomedia', ['Bez médií', 'Without media'], { chev: false }), row('allmedia', ['So všetkými médiami', 'With all media'], { chev: false }), row('somemedia', ['S vybranými médiami…', 'With selected media…'], { chev: false })])

const whatsappIphone = {
  onPhone: true,
  before: {
    need: 'iPhone s WhatsAppom.',
    time: 'Asi minúta na jeden chat. Nič nečakáš.',
    arrives: 'Súbor vznikne hneď v telefóne. Potom si ho pošleš do počítača.',
    file: 'ZIP s textom rozhovoru. V názve býva WhatsApp Chat a meno.',
  },
  watch: waWatch,
  steps: [
    {
      t: 'Otvor chat a ťukni na meno',
      d: 'Otvor rozhovor s človekom alebo skupinou. Ťukni hore na jeho meno.',
      scene: { frame: 'phone', screens: { chat: waChat(), info: waInfo }, acts: [['tap', 'name'], ['go', 'info']] },
    },
    {
      t: 'Zíď dole na export',
      d: 'Posuň sa úplne dole a ťukni na [[Exportovanie chatov|Export chat]].',
      note: 'Môže sa volať aj Exportovať chat.',
      scene: { frame: 'phone', screens: { info: { ...waInfo, items: [...waInfo.items, waMediaIos] } }, acts: [['tap', 'exp'], ['open', 'media'], ['hot', 'nomedia']] },
    },
    {
      t: 'Vyber Bez médií',
      d: 'Ťukni na [[Bez médií|Without media]]. Je to malé, rýchle a siaha ďalej do minulosti. [[So všetkými médiami|With all media]] daj len tam, kde ti záleží na fotkách a hlasovkách.',
      scene: {
        frame: 'phone',
        screens: { info: { bar: { title: '', back: true }, items: [who('Mama', 'kontakt'), fill(4), { ...waMediaIos, open: true }] } },
        acts: [['tap', 'nomedia'], ['close', 'media'], ['toast', 'Pripravuje sa súbor']],
      },
    },
    {
      t: 'Ulož súbor',
      d: 'Ťukni na [[Uložiť do súborov|Save to Files]]. Alebo ho rovno pošli cez AirDrop na Mac.',
      scene: {
        frame: 'phone',
        bar: { title: '', back: true },
        items: [
          who('Mama', 'kontakt'),
          hid(file('f', 'WhatsApp Chat', 'ZIP · uložené v Súboroch')),
          { ...toFiles('share', [row('files', ['Uložiť do súborov', 'Save to Files'], { icon: 'folder', chev: false }), row('air', 'AirDrop', { icon: 'air', chev: false }), row('ml', 'Mail', { icon: 'mail', chev: false })]), open: true },
        ],
        acts: [['tap', 'files'], ['close', 'share'], ['show', 'f'], ['hot', 'f']],
      },
    },
    {
      t: 'Zopakuj pre ďalších ľudí',
      d: 'WhatsApp exportuje vždy len jeden chat. Začni 5 až 10 najdôležitejšími ľuďmi. Ostatných môžeš pridať neskôr.',
      scene: waRepeat,
    },
  ],
}

const waMenu1 = sheet('m1', [fill(3), row('more', ['Viac', 'More'])], { kind: 'menu', at: 'tr' })
const waMenu2 = sheet('m2', [fill(2), row('exp', ['Exportovať chat', 'Export chat'], { chev: false }), fill(1)], { kind: 'menu', at: 'tr' })
const waMediaAnd = sheet('media', [row('nomedia', ['Bez médií', 'Without media'], { chev: false }), row('incl', ['Zahrnúť médiá', 'Include media'], { chev: false })], { kind: 'dialog' })

const whatsappAndroid = {
  onPhone: true,
  before: {
    need: 'Telefón s Androidom a WhatsAppom.',
    time: 'Asi minúta na jeden chat. Nič nečakáš.',
    arrives: 'Súbor vznikne hneď v telefóne. Potom si ho pošleš do počítača.',
    file: 'Textový súbor s rozhovorom. S médiami k nemu pribudnú prílohy.',
  },
  watch: waWatch,
  steps: [
    {
      t: 'Otvor chat a ťukni na tri bodky',
      d: 'Otvor rozhovor s človekom alebo skupinou. Ťukni na tri bodky (ďalšie možnosti).',
      scene: { frame: 'phone', screens: { chat: { ...waChat([{ id: 'dots', icon: 'dots' }]), items: [chat(), waMenu1] } }, acts: [['tap', 'dots'], ['open', 'm1'], ['hot', 'more']] },
    },
    {
      t: 'Viac a Exportovať chat',
      d: 'V ponuke ťukni na [[Viac|More]] a potom na [[Exportovať chat|Export chat]].',
      scene: {
        frame: 'phone',
        screens: { chat: { ...waChat([{ id: 'dots', icon: 'dots' }]), items: [chat(), { ...waMenu1, open: true }, waMenu2] } },
        acts: [['tap', 'more'], ['close', 'm1'], ['open', 'm2'], ['tap', 'exp']],
      },
    },
    {
      t: 'Vyber Bez médií',
      d: 'Ťukni na [[Bez médií|Without media]]. Je to malé a rýchle. [[Zahrnúť médiá|Include media]] daj len tam, kde ti záleží na fotkách a hlasovkách.',
      scene: {
        frame: 'phone',
        screens: { chat: { ...waChat([{ id: 'dots', icon: 'dots' }]), items: [chat(), { ...waMediaAnd, open: true }] } },
        acts: [['tap', 'nomedia'], ['close', 'media'], ['toast', 'Pripravuje sa súbor']],
      },
    },
    {
      t: 'Pošli si súbor',
      d: 'Vyber, kam ho poslať. Najlepší je Disk Google alebo Quick Share. Mail zvládne len malé súbory.',
      scene: {
        frame: 'phone',
        bar: { title: 'Mama', back: true, avatar: true },
        items: [
          chat(),
          hid(file('f', 'WhatsApp Chat', 'textový súbor · na Disku', { icon: 'file' })),
          { ...toFiles('share', [row('drive', 'Drive', { icon: 'cloud', chev: false }), row('quick', 'Quick Share', { icon: 'air', chev: false }), row('gm', 'Gmail', { icon: 'mail', chev: false })]), open: true },
        ],
        acts: [['tap', 'drive'], ['close', 'share'], ['show', 'f'], ['hot', 'f']],
      },
    },
    {
      t: 'Zopakuj pre ďalších ľudí',
      d: 'WhatsApp exportuje vždy len jeden chat. Začni 5 až 10 najdôležitejšími ľuďmi. Ostatných môžeš pridať neskôr.',
      scene: waRepeat,
    },
  ],
}

// ── Discord ─────────────────────────────────────────────────────────────────

const dcSide = (on) => [head('User Settings'), row('acc', 'My Account', { chev: false, on: on === 'acc' }), row('dp', 'Data & Privacy', { chev: false, on: on === 'dp' }), fill(3)]
const dcHome = { side: [fill(6)], sideFoot: { label: 'ty', right: [{ id: 'cog', icon: 'gear' }] }, items: [chat()] }
const dcAccount = { side: dcSide('acc'), items: [big('My Account'), fill(4)] }
const dcPrivacy = (extra = []) => ({ side: dcSide('dp'), items: [big('Data & Privacy'), fill(4), head('Request your data'), btn('req', 'Request Data', { primary: true }), ...extra] })
const dcCats = (on) =>
  sheet(
    'dlg',
    [
      chk('c-acc', 'Account', on),
      chk('c-act', 'Your Activity'),
      chk('c-acts', 'Activities'),
      chk('c-ads', 'Ads'),
      chk('c-msg', 'Messages', on),
      chk('c-prog', 'Programs'),
      chk('c-srv', 'Servers'),
      btn('send', 'Request My Data', { primary: true }),
    ],
    { kind: 'dialog', title: 'Submit Data Request', open: true },
  )
const dcWatch = [
  'V balíku sú len správy, ktoré si napísal ty. Odpovede druhých tam nie sú.',
  'Naraz môže bežať len jedna žiadosť.',
  'Keď účet vypneš alebo zmažeš, žiadosť sa zruší.',
  'Zmazané správy v balíku nie sú. Prílohy sú len odkazy, nie súbory.',
  'Discord ukazujeme po anglicky. V inom jazyku je poradie rovnaké.',
]
const dcBefore = {
  need: 'Počítač alebo telefón. Účet musí mať overený mail.',
  time: '3 minúty. Potom čakáš, často pár dní, najviac 30.',
  arrives: 'Na mail účtu príde odkaz na stiahnutie. Platí 30 dní.',
  file: 'Jeden ZIP, zvyčajne package.zip.',
}

const discordDesktop = {
  onPhone: false,
  before: dcBefore,
  watch: dcWatch,
  steps: [
    {
      t: 'Otvor nastavenia',
      d: 'V Discorde klikni vľavo dole na ozubené koliesko pri svojom mene. Sú to [[User Settings]].',
      scene: { frame: 'app', url: 'Discord', screens: { home: dcHome, acc: dcAccount }, acts: [['tap', 'cog'], ['go', 'acc'], ['hot', 'dp']] },
    },
    {
      t: 'Nájdi Data & Privacy',
      d: 'V ľavom zozname klikni na [[Data & Privacy]]. Zíď dole na časť [[Request your data]] a klikni na [[Request Data]].',
      scene: { frame: 'app', url: 'Discord', screens: { acc: dcAccount, dp: dcPrivacy() }, acts: [['tap', 'dp'], ['go', 'dp'], ['tap', 'req']] },
    },
    {
      t: 'Zaškrtni správy a účet',
      d: 'V okne [[Submit Data Request]] zaškrtni [[Messages]] a [[Account]]. Ak chceš aj zoznam serverov, pridaj [[Servers]]. Ostatné nepotrebuješ, balík bude menší a rýchlejší.',
      scene: { frame: 'app', url: 'Discord', screens: { dp: dcPrivacy([dcCats(false)]) }, acts: [['tick', 'c-msg'], ['tick', 'c-acc']] },
    },
    {
      t: 'Odošli žiadosť',
      d: 'Klikni na [[Request My Data]] a potvrď cez [[Okay]].',
      scene: {
        frame: 'app',
        url: 'Discord',
        screens: { dp: dcPrivacy([dcCats(true), sheet('ok', [prog('okp', 'Žiadosť odoslaná'), btn('okay', 'Okay', { primary: true })], { kind: 'dialog' })]) },
        acts: [['tap', 'send'], ['close', 'dlg'], ['open', 'ok'], ['tap', 'okay'], ['close', 'ok'], ['toast', 'Teraz čakáš na mail']],
      },
    },
    {
      t: 'Stiahni balík z mailu',
      d: 'Keď príde mail od Discordu, klikni v ňom na odkaz a stiahni ZIP.',
      scene: mailScene('Discord', true, { file: 'package.zip' }),
    },
  ],
}

const discordPhone = {
  onPhone: true,
  before: dcBefore,
  watch: [...dcWatch, 'V telefóne sa nedá vybrať, čo chceš. Pýta sa vždy všetko, takže to môže trvať dlhšie.'],
  steps: [
    {
      t: 'Otvor svoj profil',
      d: 'V appke ťukni vpravo dole na svoj avatar. Potom vpravo hore na ozubené koliesko.',
      scene: {
        frame: 'phone',
        screens: {
          home: { bar: { title: 'Discord' }, items: [fill(6)], tabbar: [{ icon: 'home', on: true }, { icon: 'bell' }, { id: 'you', avatar: true }] },
          you: { bar: { title: '', right: [{ id: 'cog', icon: 'gear' }] }, items: [who('Ty', 'tvoj profil'), fill(3)], tabbar: [{ icon: 'home' }, { icon: 'bell' }, { avatar: true, on: true }] },
        },
        acts: [['tap', 'you'], ['go', 'you'], ['tap', 'cog']],
      },
    },
    {
      t: 'Data & Privacy',
      d: 'Ťukni na [[Data & Privacy]] a potom na [[Request all of my data]].',
      scene: {
        frame: 'phone',
        screens: {
          set: { bar: { title: 'Settings', back: true }, items: [fill(3), row('dp', 'Data & Privacy', { icon: 'shield' }), fill(3)] },
          dp: { bar: { title: 'Data & Privacy', back: true }, items: [fill(4), row('all', 'Request all of my data', { icon: 'down' })] },
        },
        acts: [['tap', 'dp'], ['go', 'dp'], ['tap', 'all']],
      },
    },
    {
      t: 'Odošli žiadosť',
      d: 'Ťukni na [[Request My Data]] a potvrď cez [[Okay]].',
      scene: {
        frame: 'phone',
        bar: { title: 'Data & Privacy', back: true },
        items: [
          fill(4),
          sheet('rq', [btn('send', 'Request My Data', { primary: true })], { kind: 'dialog', open: true }),
          sheet('ok', [prog('okp', 'Žiadosť odoslaná'), btn('okay', 'Okay', { primary: true })], { kind: 'dialog' }),
        ],
        acts: [['tap', 'send'], ['close', 'rq'], ['open', 'ok'], ['tap', 'okay'], ['close', 'ok'], ['toast', 'Teraz čakáš na mail']],
      },
    },
    {
      t: 'Stiahni balík z mailu',
      d: 'Keď príde mail od Discordu, klikni v ňom na odkaz a stiahni ZIP. Najlepšie rovno na počítači.',
      scene: mailScene('Discord', true, { file: 'package.zip', frame: 'phone' }),
    },
  ],
}

// ── Telegram ────────────────────────────────────────────────────────────────

const tgHome = { bar: { title: 'Telegram', left: [{ id: 'burger', icon: 'menu' }] }, side: [fill(6)], items: [chat()] }
const tgSettings = { bar: { title: 'Settings', back: true }, items: [fill(3), row('adv', 'Advanced', { icon: 'gear' }), fill(2)] }
const tgAdvanced = { bar: { title: 'Advanced', back: true }, items: [fill(4), row('export', 'Export Telegram data', { icon: 'down' })] }

const telegram = {
  onPhone: false,
  before: {
    need: 'Počítač s appkou Telegram Desktop. V telefóne sa to nedá.',
    time: '10 minút. Export potom beží v počítači. Pri veľa fotkách a videách aj dlhšie.',
    arrives: 'Nič nechodí mailom. Export sa uloží do priečinka v počítači.',
    file: 'Priečinok so súborom result.json. Zvyčajne v Stiahnutých súboroch pod Telegram Desktop.',
  },
  note: 'Telegram ukazujeme po anglicky. Názvy políčok v okne exportu sa môžu mierne líšiť.',
  watch: [
    'Tajné chaty (secret chats) sa neexportujú nikdy.',
    'Súbory väčšie ako nastavený limit sa vynechajú.',
    'Jeden chat vieš exportovať aj samostatne: otvor ho, klikni na tri bodky, [[Export chat history]] a vyber JSON.',
  ],
  steps: [
    {
      t: 'Nainštaluj Telegram Desktop',
      d: 'Stiahni si Telegram Desktop a prihlás sa. Appka z App Store na Macu export mať nemusí.',
      link: { url: 'https://desktop.telegram.org/' },
      scene: {
        frame: 'browser',
        url: 'desktop.telegram.org',
        items: [big('Telegram Desktop'), btn('get', null, { icon: 'down', primary: true }), hid(file('app', 'Telegram Desktop', 'appka nainštalovaná', { icon: 'laptop' }))],
        acts: [['tap', 'get'], ['show', 'app'], ['hot', 'app']],
      },
    },
    {
      t: 'Otvor nastavenia',
      d: 'Klikni na ponuku (tri čiarky) a vyber [[Settings]].',
      scene: {
        frame: 'app',
        url: 'Telegram Desktop',
        screens: { home: { ...tgHome, items: [chat(), sheet('menu', [fill(3), row('set', 'Settings', { icon: 'gear', chev: false }), fill(1)], { kind: 'menu', at: 'tl' })] }, set: tgSettings },
        acts: [['tap', 'burger'], ['open', 'menu'], ['tap', 'set'], ['close', 'menu'], ['go', 'set'], ['hot', 'adv']],
      },
    },
    {
      t: 'Advanced a export',
      d: 'Klikni na [[Advanced]] a potom na [[Export Telegram data]].',
      scene: { frame: 'app', url: 'Telegram Desktop', screens: { set: tgSettings, adv: tgAdvanced }, acts: [['tap', 'adv'], ['go', 'adv'], ['tap', 'export']] },
    },
    {
      t: 'Vyber, čo chceš',
      d: 'Zaškrtni [[Personal chats]] a [[Private groups]]. Pokojne aj [[Account information]] a [[Contact list]]. Videá a súbory vypni, inak to potrvá dlho.',
      scene: {
        frame: 'app',
        url: 'Telegram Desktop',
        bar: { title: 'Export Telegram data', back: true },
        items: [chk('i-acc', 'Account information'), chk('i-con', 'Contact list'), chk('i-per', 'Personal chats'), chk('i-bot', 'Bot chats'), chk('i-grp', 'Private groups'), chk('i-ch', 'Public channels'), head('Media'), chk('i-vid', 'Videos', true), chk('i-fil', 'Files', true)],
        acts: [['tick', 'i-per'], ['tick', 'i-grp'], ['tick', 'i-acc'], ['tick', 'i-con'], ['untick', 'i-vid'], ['untick', 'i-fil']],
      },
    },
    {
      t: 'Formát JSON a Export',
      d: 'V časti [[Location and format]] vyber [[Machine-readable JSON]]. Potom klikni na [[Export]].',
      note: 'Telegram môže chcieť potvrdenie z iného zariadenia alebo nechať chvíľu čakať. Potom export spusti znova.',
      scene: {
        frame: 'app',
        url: 'Telegram Desktop',
        bar: { title: 'Export Telegram data', back: true },
        items: [head('Location and format'), opt('f-html', 'HTML', true), opt('f-json', 'Machine-readable JSON'), opt('f-both', 'Both'), btn('go', 'Export', { primary: true }), hid(prog('p', 'Exportuje sa'))],
        acts: [['pick', 'f-json'], ['tap', 'go'], ['show', 'p'], ['run', 'p']],
      },
    },
    {
      t: 'Daj Jarvisovi celý priečinok',
      d: 'Po skončení nájdeš v počítači priečinok s exportom. Pretiahni Jarvisovi celý priečinok, nie len jeden súbor. Ak by to nešlo, zabaľ ho najprv do ZIP.',
      scene: {
        frame: 'app',
        url: 'Stiahnuté súbory',
        items: [fill(2), file('dir', 'Telegram Desktop', 'priečinok s exportom', { icon: 'folder' }), hid(file('res', 'result.json', 'všetky chaty', { icon: 'file' }))],
        acts: [['tap', 'dir'], ['show', 'res'], ['hot', 'dir']],
      },
    },
  ],
}

// ── ChatGPT ─────────────────────────────────────────────────────────────────

const gptHome = (menuOpen) => ({
  side: [fill(7)],
  sideFoot: { id: 'me', label: 'tvoje meno' },
  items: [chat(), sheet('menu', [fill(2), row('set', 'Settings', { icon: 'gear', chev: false }), fill(1)], { kind: 'menu', at: 'bl', open: menuOpen })],
})
const gptSide = (on) => [fill(2), row('pers', 'Personalization', { chev: false, on: on === 'pers' }), row('dc', 'Data controls', { chev: false, on: on === 'dc' }), fill(2)]
const gptData = (extra = []) => ({ bar: { title: 'Settings' }, side: gptSide('dc'), items: [fill(2), row('exp', 'Export data', { val: 'Export', chev: false }), fill(1), ...extra] })

const chatgpt = {
  onPhone: false,
  before: {
    need: 'Počítač alebo telefón a prihlásenie do ChatGPT.',
    time: '2 minúty. Mail príde väčšinou do pár hodín, oficiálne do 7 dní.',
    arrives: 'Mail (niekedy SMS) s odkazom na stiahnutie. Odkaz platí len 24 hodín.',
    file: 'Jeden ZIP so všetkými rozhovormi.',
  },
  note: 'Ak máš ChatGPT po slovensky, tlačidlá budú preložené. Poradie je rovnaké.',
  watch: [
    'Odkaz v maile platí len 24 hodín. Stiahni hneď, ako príde.',
    'Niekedy mail príde až o pár dní. Kým sa jeden export pripravuje, druhý sa spustiť nedá.',
    'Stiahnuť ho musíš v prehliadači, kde si prihlásený do toho istého účtu.',
    'Vo firemných účtoch (Business, Enterprise) export nie je.',
    'Zmazané a dočasné chaty v exporte nie sú.',
  ],
  steps: [
    {
      t: 'Otvor ponuku pri svojom mene',
      d: 'Na chatgpt.com sa prihlás a klikni na svoje meno alebo profilovú fotku.',
      link: { url: 'https://chatgpt.com/#settings/DataControls', hint: 'Skratka rovno do nastavení. Ak sa neotvoria, pokračuj podľa krokov.' },
      scene: { frame: 'browser', url: 'chatgpt.com', screens: { home: gptHome(false) }, acts: [['tap', 'me'], ['open', 'menu'], ['hot', 'set']] },
    },
    {
      t: 'Settings a Data controls',
      d: 'Vyber [[Settings]] a v nich [[Data controls]].',
      scene: {
        frame: 'browser',
        url: 'chatgpt.com',
        screens: { home: gptHome(true), set: { bar: { title: 'Settings' }, side: gptSide(), items: [fill(4)] }, dc: gptData() },
        acts: [['tap', 'set'], ['close', 'menu'], ['go', 'set'], ['tap', 'dc'], ['go', 'dc'], ['hot', 'exp']],
      },
    },
    {
      t: 'Spusti export',
      d: 'Pri [[Export data]] klikni na [[Export]]. Potom potvrď cez [[Confirm export]].',
      scene: {
        frame: 'browser',
        url: 'chatgpt.com',
        screens: { dc: gptData([sheet('cf', [prog('cfp', 'Export data'), btn('ok', 'Confirm export', { primary: true })], { kind: 'dialog' })]) },
        acts: [['tap', 'exp'], ['open', 'cf'], ['tap', 'ok'], ['close', 'cf'], ['hot', 'exp'], ['toast', 'Teraz čakáš na mail']],
      },
    },
    {
      t: 'Stiahni z mailu',
      d: 'Príde ti mail s tlačidlom [[Download data export]]. Klikni naň v prehliadači, kde si prihlásený do toho istého účtu. Sprav to hneď, odkaz platí 24 hodín.',
      scene: mailScene('OpenAI', 'Download data export'),
    },
    {
      t: 'Skopíruj aj pamäť',
      d: 'To, čo si o tebe ChatGPT pamätá, v exporte byť nemusí. Otvor [[Settings]], [[Personalization]], [[Memory]] a [[Manage]]. Text skopíruj a pošli Jarvisovi. Alebo napíš ChatGPT, nech ti doslova vypíše všetky uložené spomienky.',
      scene: {
        frame: 'browser',
        url: 'chatgpt.com',
        screens: {
          dc: { bar: { title: 'Settings' }, side: gptSide('dc'), items: [fill(4)] },
          pers: { bar: { title: 'Settings' }, side: gptSide('pers'), items: [big('Personalization'), fill(1), row('mem', 'Memory', { val: 'Manage', chev: false }), fill(2)] },
        },
        acts: [['tap', 'pers'], ['go', 'pers'], ['tap', 'mem'], ['hot', 'mem']],
      },
    },
  ],
}

// ── Claude ──────────────────────────────────────────────────────────────────

const clSide = (on) => [fill(2), row('priv', 'Privacy', { chev: false, on: on === 'priv' }), row('you', 'Your Claude', { chev: false, on: on === 'you' }), fill(2)]

const claude = {
  onPhone: false,
  before: {
    need: 'Počítač. Z mobilnej appky sa export spustiť nedá.',
    time: '2 minúty. Mail príde zvyčajne o pár minút.',
    arrives: 'Mail od Anthropic s odkazom. Platí 24 hodín a môže fungovať len raz.',
    file: 'Jeden ZIP s rozhovormi a projektmi.',
  },
  watch: [
    'Odkaz platí 24 hodín a môže fungovať len raz. Stiahni hneď.',
    'Pri sťahovaní musíš byť prihlásený.',
    'Súbory, ktoré si do Clauda nahral, v exporte nie sú.',
    'V tímovom účte musí export povoliť majiteľ.',
  ],
  steps: [
    {
      t: 'Otvor Settings a Privacy',
      d: 'Na claude.ai alebo v appke Claude na počítači otvor [[Settings]] a potom [[Privacy]].',
      link: { url: 'https://claude.ai/settings/data-privacy-controls', hint: 'Skratka rovno do nastavení súkromia. Ak sa neotvoria, pokračuj podľa krokov.' },
      scene: {
        frame: 'browser',
        url: 'claude.ai',
        screens: {
          set: { bar: { title: 'Settings' }, side: clSide(), items: [fill(4)] },
          priv: { bar: { title: 'Settings' }, side: clSide('priv'), items: [big('Privacy'), fill(2), btn('exp', 'Export data')] },
        },
        acts: [['tap', 'priv'], ['go', 'priv'], ['hot', 'exp']],
      },
    },
    {
      t: 'Klikni na Export data',
      d: 'Klikni na [[Export data]] a potvrď.',
      scene: {
        frame: 'browser',
        url: 'claude.ai',
        bar: { title: 'Settings' },
        side: clSide('priv'),
        items: [big('Privacy'), fill(2), btn('exp', 'Export data'), sheet('cf', [prog('cfp', 'Export data'), btn('ok', null, { icon: 'check', primary: true })], { kind: 'dialog' })],
        acts: [['tap', 'exp'], ['open', 'cf'], ['tap', 'ok'], ['close', 'cf'], ['toast', 'Teraz čakáš na mail']],
      },
    },
    {
      t: 'Stiahni z mailu',
      d: 'Otvor mail od Anthropic a stiahni ZIP. Musíš byť prihlásený. Sprav to hneď, odkaz platí 24 hodín.',
      scene: mailScene('Anthropic', true),
    },
    {
      t: 'Skopíruj aj pamäť',
      d: 'Otvor [[Settings]], [[Your Claude]] a pri [[Your memory]] klikni na [[Manage]]. Text skopíruj a pošli Jarvisovi. Alebo sa Clauda opýtaj: „Write out your memories of me verbatim, exactly as they appear in your memory.“',
      note: 'V staršom rozložení je pamäť v Settings pod Memory alebo Capabilities.',
      scene: {
        frame: 'browser',
        url: 'claude.ai',
        screens: {
          priv: { bar: { title: 'Settings' }, side: clSide('priv'), items: [big('Privacy'), fill(3)] },
          you: { bar: { title: 'Settings' }, side: clSide('you'), items: [big('Your Claude'), fill(1), row('mem', 'Your memory', { val: 'Manage', chev: false }), fill(2)] },
        },
        acts: [['tap', 'you'], ['go', 'you'], ['tap', 'mem'], ['hot', 'mem']],
      },
    },
  ],
}

// ── Google ──────────────────────────────────────────────────────────────────

const gList = (on = {}) => [
  chk('g-cal', 'Calendar', on.all ?? on.pick),
  chk('g-chr', 'Chrome', on.all ?? on.pick),
  chk('g-con', 'Contacts', on.all ?? on.pick),
  chk('g-drv', 'Drive', on.all ?? false),
  chk('g-keep', 'Keep', on.all ?? on.pick),
  chk('g-act', 'My Activity', on.all ?? on.pick),
  chk('g-pho', 'Google Photos', on.all ?? false),
  chk('g-yt', 'YouTube and YouTube Music', on.all ?? on.pick),
]
const gFormats = (id, label) => sheet(id, [row(`${id}-row`, label, { val: 'HTML', chev: false }), btn(`${id}-ok`, 'OK', { primary: true })], { kind: 'dialog', title: 'Multiple formats' })

const googleTakeout = {
  onPhone: false,
  before: {
    need: 'Počítač a heslo ku Google účtu.',
    time: '10 minút. Odkaz príde väčšinou ešte v ten deň, niekedy o pár dní.',
    arrives: 'Mail s odkazom na stiahnutie. Pri sťahovaní zadáš heslo znova.',
    file: 'ZIP, v názve je takeout. Väčší export príde vo viacerých častiach.',
  },
  note: 'Takeout sa prekladá podľa jazyka účtu. Tlačidlá môžeš mať po slovensky, poradie je rovnaké.',
  watch: [
    'Prepnutie na [[JSON]] sa robí pri každej službe zvlášť. Ľahko sa prehliadne.',
    'História polohy z Máp už v Takeoute nie je. Exportuje sa z telefónu, pozri záložku História polohy.',
    'Fotky, Disk a Gmail export poriadne spomalia. Vynechaj ich, ak ich nechceš.',
  ],
  steps: [
    {
      t: 'Otvor Takeout a zruš výber',
      d: 'Otvor takeout.google.com. Klikni na [[Deselect all]] (zrušiť výber všetkých), aby si nesťahoval celý Google.',
      link: { url: 'https://takeout.google.com/' },
      scene: { frame: 'browser', url: 'takeout.google.com', items: [big('Google Takeout'), btn('des', 'Deselect all', { small: true }), ...gList({ all: true })], acts: [['tap', 'des'], ['clear']] },
    },
    {
      t: 'Zaškrtni len to dôležité',
      d: 'Zaškrtni [[YouTube and YouTube Music]], [[My Activity]], [[Chrome]], [[Calendar]], [[Contacts]] a [[Keep]]. Fotky, Disk a Gmail vynechaj, sú obrovské.',
      scene: {
        frame: 'browser',
        url: 'takeout.google.com',
        items: [big('Google Takeout'), btn('des', 'Deselect all', { small: true }), ...gList({ all: false })],
        acts: [['tick', 'g-cal'], ['tick', 'g-chr'], ['tick', 'g-con'], ['tick', 'g-keep'], ['tick', 'g-act'], ['tick', 'g-yt']],
      },
    },
    {
      t: 'YouTube prepni na JSON',
      d: 'Pri YouTube klikni na [[Multiple formats]]. Riadok [[History]] zmeň z HTML na [[JSON]]. Cez [[All YouTube data included]] môžeš nechať len históriu.',
      scene: {
        frame: 'browser',
        url: 'takeout.google.com',
        items: [chk('g-act', 'My Activity', true), chk('g-yt', 'YouTube and YouTube Music', true), btn('yt-f', 'Multiple formats', { small: true }), btn('yt-d', 'All YouTube data included', { small: true }), fill(1), gFormats('yf', 'History')],
        acts: [['tap', 'yt-f'], ['open', 'yf'], ['tap', 'yf-row'], ['set', 'yf-row', 'JSON'], ['tap', 'yf-ok'], ['close', 'yf']],
      },
    },
    {
      t: 'Moju aktivitu tiež na JSON',
      d: 'Pri [[My Activity]] klikni na [[Multiple formats]] a riadok [[Activity records]] zmeň na [[JSON]].',
      scene: {
        frame: 'browser',
        url: 'takeout.google.com',
        items: [chk('g-keep', 'Keep', true), chk('g-act', 'My Activity', true), btn('ac-f', 'Multiple formats', { small: true }), fill(2), gFormats('af', 'Activity records')],
        acts: [['tap', 'ac-f'], ['open', 'af'], ['tap', 'af-row'], ['set', 'af-row', 'JSON'], ['tap', 'af-ok'], ['close', 'af']],
      },
    },
    {
      t: 'Nastav doručenie',
      d: 'Klikni na [[Next step]]. Nechaj odkaz mailom, jednorazový export a typ [[.zip]]. Veľkosť daj aspoň 4 GB, nech nepríde veľa kúskov. Potom klikni na [[Create export]].',
      scene: {
        frame: 'browser',
        url: 'takeout.google.com',
        screens: {
          list: { items: [chk('g-yt', 'YouTube and YouTube Music', true), fill(1), btn('next', 'Next step', { primary: true })] },
          how: {
            items: [
              row('del', 'Delivery method', { val: 'Send download link via email', chev: false }),
              row('freq', 'Export type', { val: 'One-time archive', chev: false }),
              row('type', 'File type', { val: '.zip', chev: false }),
              row('size', 'Archive size', { val: '2 GB', chev: false }),
              btn('make', 'Create export', { primary: true }),
            ],
          },
        },
        acts: [['tap', 'next'], ['go', 'how'], ['tap', 'size'], ['set', 'size', '4 GB'], ['tap', 'make'], ['toast', 'Teraz čakáš na mail']],
      },
    },
    {
      t: 'Stiahni z mailu',
      d: 'V maile od Google klikni na [[Download archive]] a zadaj heslo.',
      scene: mailScene('Google', 'Download archive', { file: 'takeout.zip' }),
    },
  ],
}

const googleLocation = {
  onPhone: true,
  before: {
    need: 'Telefón, na ktorom máš v Mapách Google zapnutú časovú os.',
    time: '3 minúty. Nič nečakáš.',
    arrives: 'Súbor sa uloží v telefóne. Potom si ho pošleš do počítača.',
    file: 'Jeden súbor s históriou polohy.',
  },
  note: 'Návod je pre Android a v angličtine. Na iPhone to má byť v appke Mapy Google: profilová fotka, [[Settings]], [[Personal content]] a [[Export Timeline data]].',
  watch: ['Každý telefón má len svoju vlastnú históriu. Ak máš dva telefóny, exportuj z oboch.', 'Na webe ani v Takeoute už táto história nie je.'],
  steps: [
    {
      t: 'Otvor nastavenia polohy',
      d: 'Na Androide otvor appku Nastavenia. Ťukni na [[Location]] a potom na [[Location services]].',
      scene: {
        frame: 'phone',
        screens: {
          set: { bar: { title: 'Settings' }, items: [fill(3), row('loc', 'Location', { icon: 'pin' }), fill(3)] },
          loc: { bar: { title: 'Location', back: true }, items: [fill(2), row('svc', 'Location services'), fill(2)] },
        },
        acts: [['tap', 'loc'], ['go', 'loc'], ['tap', 'svc']],
      },
    },
    {
      t: 'Časová os',
      d: 'Ťukni na [[Timeline]] a potom na [[Export Timeline data]].',
      scene: {
        frame: 'phone',
        screens: {
          svc: { bar: { title: 'Location services', back: true }, items: [fill(2), row('tl', 'Timeline'), fill(3)] },
          tl: { bar: { title: 'Timeline', back: true }, items: [fill(3), row('exp', 'Export Timeline data', { icon: 'down' })] },
        },
        acts: [['tap', 'tl'], ['go', 'tl'], ['tap', 'exp']],
      },
    },
    {
      t: 'Ulož súbor',
      d: 'Ťukni na [[Continue]], vyber priečinok a daj [[Save]].',
      scene: {
        frame: 'phone',
        bar: { title: 'Timeline', back: true },
        items: [fill(2), hid(file('f', 'História polohy', 'uložené v telefóne', { icon: 'pin' })), sheet('c', [btn('cont', 'Continue', { primary: true })], { kind: 'dialog', open: true }), sheet('s', [row('dirx', 'Download', { icon: 'folder', chev: false }), btn('save', 'Save', { primary: true })], { kind: 'sheet' })],
        acts: [['tap', 'cont'], ['close', 'c'], ['open', 's'], ['tap', 'save'], ['close', 's'], ['show', 'f'], ['hot', 'f']],
      },
    },
  ],
}

// ── Spotify ─────────────────────────────────────────────────────────────────

const spPacks = (on) => [chk('s-acc', 'Account data', on), chk('s-ext', 'Extended streaming history', on), chk('s-tech', 'Technical log information')]

const spotify = {
  onPhone: false,
  before: {
    need: 'Prehliadač a prihlásenie do Spotify.',
    time: '3 minúty. Základné dáta prídu asi o 5 dní, celá história počúvania do 30 dní.',
    arrives: 'Najprv potvrdzovací mail. Neskôr mail s odkazom, pre každý balík zvlášť.',
    file: 'ZIP súbory. Každý balík má vlastný.',
  },
  watch: [
    'Žiadosť musíš potvrdiť v maile. Inak Spotify nič nepripraví.',
    'Celá história počúvania je len v balíku [[Extended streaming history]]. Ten trvá najdlhšie.',
    'Balíky prídu v rôzne dni. Pretiahni Jarvisovi oba.',
  ],
  steps: [
    {
      t: 'Otvor súkromie účtu',
      d: 'Otvor stránku [[Account privacy]] vo svojom Spotify účte a zíď dole na [[Download your data]].',
      link: { url: 'https://www.spotify.com/account/privacy/' },
      scene: { frame: 'browser', url: 'spotify.com/account/privacy', items: [big('Account privacy'), fill(5), head('Download your data'), ...spPacks(false)], acts: [['scroll', 's-tech'], ['hot', 's-acc'], ['hot', 's-ext']] },
    },
    {
      t: 'Zaškrtni dva balíky',
      d: 'Zaškrtni [[Account data]] a [[Extended streaming history]]. [[Technical log information]] nepotrebuješ.',
      scene: { frame: 'browser', url: 'spotify.com/account/privacy', items: [head('Download your data'), ...spPacks(false), btn('req', 'Request data', { primary: true })], acts: [['tick', 's-acc'], ['tick', 's-ext']] },
    },
    {
      t: 'Požiadaj o dáta',
      d: 'Klikni na [[Request data]].',
      scene: { frame: 'browser', url: 'spotify.com/account/privacy', items: [head('Download your data'), ...spPacks(true), btn('req', 'Request data', { primary: true })], acts: [['tap', 'req'], ['toast', 'Pozri si mail']] },
    },
    {
      t: 'Potvrď v maile',
      d: 'Spotify ti hneď pošle potvrdzovací mail. Klikni v ňom na odkaz. Bez toho sa nič nestane.',
      scene: {
        frame: 'browser',
        url: 'tvoj mail',
        bar: { title: 'Doručená pošta' },
        items: [hid(mail('m', { from: 'Spotify', btn: true })), fill(3)],
        acts: [['show', 'm'], ['wait', 400], ['tap', 'm-btn'], ['toast', 'Potvrdené. Teraz čakáš.']],
      },
    },
    {
      t: 'Stiahni, keď prídu',
      d: 'Keď príde mail, že dáta sú pripravené, klikni na [[Download]] a prihlás sa. Balíky prídu v rôzne dni.',
      scene: {
        frame: 'browser',
        url: 'tvoj mail',
        bar: { title: 'Doručená pošta' },
        items: [hid(mail('m', { from: 'Spotify', btn: 'Download' })), hid(file('f1', 'Account data', 'ZIP · stiahnuté')), hid(file('f2', 'Extended streaming history', 'ZIP · príde neskôr')), fill(1)],
        acts: [['show', 'm'], ['wait', 400], ['tap', 'm-btn'], ['show', 'f1'], ['hot', 'f1'], ['show', 'f2']],
      },
    },
  ],
}

// ── Apple ───────────────────────────────────────────────────────────────────

const apCats = (on) => [
  chk('a-media', 'Apple Media Services information', on),
  chk('a-con', 'iCloud Contacts', on),
  chk('a-cal', 'iCloud Calendars and Reminders', on),
  chk('a-notes', 'iCloud Notes', on),
  chk('a-photos', 'iCloud Photos'),
  chk('a-drive', 'iCloud Drive'),
]

const apple = {
  onPhone: false,
  before: {
    need: 'Prehliadač a prihlásenie k Apple účtu.',
    time: '5 minút. Apple najprv overí, že si to ty. Potom to trvá do 7 dní.',
    arrives: 'Mail, že je to pripravené. Súbory stiahneš na stránke Apple. Sú tam 14 dní.',
    file: 'Viac ZIP súborov, pre každú službu zvlášť.',
  },
  note: 'Stránka môže byť po slovensky. Poradie krokov je rovnaké.',
  watch: [
    'Správy z iMessage v exporte nie sú nikdy.',
    'Stiahni všetky časti. Žiadnu nevynechaj.',
    'Zdravotné dáta je jednoduchšie vytiahnuť priamo z iPhonu. Pozri návod Apple Zdravie.',
    'V niektorých krajinách táto možnosť nie je.',
  ],
  steps: [
    {
      t: 'Prihlás sa na stránke Apple',
      d: 'Otvor privacy.apple.com a prihlás sa svojím Apple účtom.',
      link: { url: 'https://privacy.apple.com/' },
      scene: {
        frame: 'browser',
        url: 'privacy.apple.com',
        screens: { login: { items: [big('Data & Privacy'), field('acc', 'Apple Account'), btn('in', null, { icon: 'right', primary: true })] }, home: { items: [big('Data & Privacy'), row('copy', 'Request a copy of your data', { icon: 'down' }), fill(3)] } },
        acts: [['tap', 'acc'], ['type', 'acc', 'ty@mail.sk'], ['tap', 'in'], ['go', 'home'], ['hot', 'copy']],
      },
    },
    {
      t: 'Požiadaj o kópiu dát',
      d: 'Klikni na [[Request a copy of your data]].',
      scene: {
        frame: 'browser',
        url: 'privacy.apple.com',
        screens: { home: { items: [big('Data & Privacy'), row('copy', 'Request a copy of your data', { icon: 'down' }), fill(3)] }, cats: { items: [big('Request a copy of your data'), ...apCats(false)] } },
        acts: [['tap', 'copy'], ['go', 'cats']],
      },
    },
    {
      t: 'Vyber, čo chceš',
      d: 'Pre hudbu zaškrtni [[Apple Media Services information]]. Pridať môžeš [[iCloud Contacts]], [[iCloud Calendars and Reminders]] a [[iCloud Notes]]. [[iCloud Photos]] a [[iCloud Drive]] nechaj vypnuté, sú veľmi veľké. Potom klikni na [[Continue]].',
      scene: {
        frame: 'browser',
        url: 'privacy.apple.com',
        items: [big('Request a copy of your data'), ...apCats(false), btn('cont', 'Continue', { primary: true })],
        acts: [['tick', 'a-media'], ['tick', 'a-con'], ['tick', 'a-cal'], ['tick', 'a-notes'], ['tap', 'cont']],
      },
    },
    {
      t: 'Dokonči žiadosť',
      d: 'Veľkosť súboru nechaj tak, ako je. Klikni na [[Complete request]].',
      scene: {
        frame: 'browser',
        url: 'privacy.apple.com',
        items: [big('Request a copy of your data'), row('size', 'Maximum file size', { val: '1 GB', chev: false }), btn('done', 'Complete request', { primary: true })],
        acts: [['hot', 'size'], ['tap', 'done'], ['toast', 'Teraz čakáš na mail']],
      },
    },
    {
      t: 'Stiahni všetky časti',
      d: 'Keď príde mail, otvor privacy.apple.com/account a stiahni každý ZIP. Žiadny nevynechaj.',
      scene: {
        frame: 'browser',
        url: 'privacy.apple.com/account',
        items: [big('Data & Privacy'), file('z1', 'Apple Media Services', 'ZIP', { btn: true }), file('z2', 'iCloud Contacts', 'ZIP', { btn: true }), file('z3', 'iCloud Notes', 'ZIP', { btn: true })],
        acts: [['tap', 'z1-btn'], ['hot', 'z1'], ['tap', 'z2-btn'], ['hot', 'z2'], ['tap', 'z3-btn'], ['hot', 'z3']],
      },
    },
  ],
}

// ── Apple Health ────────────────────────────────────────────────────────────

const hTabs = (on) => [{ id: 'sum', icon: 'heart', label: 'Summary', on }, { icon: 'search' }]
const hProfile = (extra = []) => ({ bar: { title: '', back: true }, items: [who('Ty', 'tvoj profil'), fill(7), row('exp', 'Export All Health Data', { chev: false }), ...extra] })

const health = {
  onPhone: true,
  before: {
    need: 'iPhone s appkou Zdravie.',
    time: 'Pár minút. Ak máš dáta za veľa rokov, súbor sa pripravuje aj 10 minút.',
    arrives: 'Súbor vznikne v telefóne. Potom si ho pošleš do počítača.',
    file: 'Jeden ZIP, zvyčajne export.zip. Býva veľký.',
  },
  note: 'Ukazujeme anglické názvy. Na slovenskom iPhone sú po slovensky, hľadaj to isté miesto.',
  watch: ['Súbor je na mail priveľký. Použi AirDrop alebo Súbory (iCloud Drive).', 'Príprava môže trvať niekoľko minút. Appku medzitým nezatváraj.'],
  steps: [
    {
      t: 'Otvor appku Zdravie',
      d: 'Na iPhone otvor appku Zdravie (Health).',
      scene: {
        frame: 'phone',
        screens: {
          home: { items: [apps([{}, {}, {}, {}, {}, { id: 'app', icon: 'heart', label: 'Zdravie' }, {}, {}, {}, {}, {}, {}])] },
          sum: { bar: { title: 'Summary', right: [{ id: 'me', avatar: true }] }, items: [fill(6)], tabbar: hTabs(true) },
        },
        acts: [['tap', 'app'], ['go', 'sum']],
      },
    },
    {
      t: 'Ťukni na svoju fotku',
      d: 'Ťukni na [[Summary]] (prehľad). Potom vpravo hore na svoju fotku alebo iniciály.',
      scene: {
        frame: 'phone',
        screens: { sum: { bar: { title: 'Summary', right: [{ id: 'me', avatar: true }] }, items: [fill(6)], tabbar: hTabs(false) }, me: hProfile() },
        acts: [['tap', 'sum'], ['tap', 'me'], ['go', 'me']],
      },
    },
    {
      t: 'Exportuj všetky dáta',
      d: 'Zíď úplne dole a ťukni na [[Export All Health Data]] (exportovať všetky zdravotné dáta). Potvrď cez [[Export]].',
      scene: {
        frame: 'phone',
        screens: { me: hProfile([sheet('cf', [btn('ok', 'Export', { primary: true })], { kind: 'dialog' })]) },
        acts: [['tap', 'exp'], ['open', 'cf'], ['tap', 'ok'], ['close', 'cf'], ['toast', 'Preparing export…']],
      },
    },
    {
      t: 'Počkaj a pošli si súbor',
      d: 'Chvíľu sa to pripravuje. Potom vyber AirDrop na Mac alebo [[Save to Files]] (uložiť do súborov).',
      scene: {
        frame: 'phone',
        bar: { title: '', back: true },
        items: [
          who('Ty', 'tvoj profil'),
          prog('p', 'Preparing export…'),
          hid(file('f', 'export.zip', 'poslané cez AirDrop')),
          toFiles('share', [row('air', 'AirDrop', { icon: 'air', chev: false }), row('files', 'Save to Files', { icon: 'folder', chev: false }), row('ml', 'Mail', { icon: 'mail', chev: false, dim: true })]),
        ],
        acts: [['run', 'p'], ['open', 'share'], ['tap', 'air'], ['close', 'share'], ['show', 'f'], ['hot', 'f']],
      },
    },
  ],
}

// ── Steam ───────────────────────────────────────────────────────────────────

const steam = {
  onPhone: false,
  before: {
    need: 'Steam nainštalovaný na tomto počítači.',
    time: 'Nič. Jarvis to spraví sám.',
    arrives: 'Nič sa nesťahuje a nič nečakáš.',
    file: 'Žiadny súbor netreba.',
  },
  watch: ['Jarvis uvidí hry nainštalované a hrané na tomto počítači. Hry z iných počítačov nie.', 'Predtým Steam zavri, nech sú údaje čerstvé.'],
  steps: [
    {
      t: 'Nič netreba exportovať',
      d: 'Steam si zoznam hier ukladá priamo v počítači. Jarvis si ho vie nájsť a prečítať sám.',
      scene: {
        frame: 'app',
        url: 'Tento počítač',
        items: [file('dir', 'Steam', 'priečinok v počítači', { icon: 'folder' }), hid(file('a', 'Tvoje hry', 'čo máš nainštalované', { icon: 'file' })), hid(file('b', 'Posledné hranie', 'kedy si čo hral', { icon: 'clock' }))],
        acts: [['tap', 'dir'], ['show', 'a'], ['show', 'b'], ['hot', 'a'], ['hot', 'b']],
      },
    },
    {
      t: 'Povedz to Jarvisovi',
      d: 'Napíš Jarvisovi: „Pozri si moje hry v Steame.“ To je celé.',
      scene: {
        frame: 'app',
        url: 'Jarvis',
        items: [field('msg', 'Správa pre Jarvisa'), btn('send', null, { icon: 'right', primary: true }), hid(file('ok', 'Hry zo Steamu', 'pridané do pamäte', { icon: 'check' }))],
        acts: [['tap', 'msg'], ['type', 'msg', 'Pozri si moje hry v Steame.'], ['tap', 'send'], ['show', 'ok'], ['hot', 'ok']],
      },
    },
  ],
}

// ── long tail: shorter guides ───────────────────────────────────────────────

const x = {
  onPhone: true,
  before: {
    need: 'Počítač alebo telefón, heslo a overovací kód.',
    time: '3 minúty. Archív býva hotový asi do dňa, niekedy o pár dní.',
    arrives: 'Mail alebo upozornenie. Súbor stiahneš na tej istej stránke.',
    file: 'Jeden ZIP.',
  },
  watch: ['Zmazané príspevky v archíve nie sú.', 'Odkaz na stiahnutie po čase prestane platiť. Stiahni čím skôr.'],
  steps: [
    {
      t: 'Otvor stránku s archívom',
      d: 'Klikni na [[More]], [[Settings and privacy]], [[Your account]] a [[Download an archive of your data]].',
      link: { url: 'https://x.com/settings/download_your_data', hint: 'Skratka rovno na túto stránku. Ak sa neotvorí, pokračuj podľa krokov.' },
      scene: {
        frame: 'browser',
        url: 'x.com/settings',
        screens: {
          set: { side: [fill(4), row('more', 'More', { chev: false })], items: [big('Settings and privacy'), row('acc', 'Your account'), fill(3)] },
          acc: { side: [fill(4), row('more', 'More', { chev: false })], items: [big('Your account'), fill(2), row('arch', 'Download an archive of your data', { icon: 'down' })] },
        },
        acts: [['tap', 'acc'], ['go', 'acc'], ['tap', 'arch']],
      },
    },
    {
      t: 'Potvrď, že si to ty',
      d: 'Zadaj heslo a overovací kód, ktorý ti príde.',
      scene: { frame: 'browser', url: 'x.com/settings', items: [big('Verify it\'s you'), field('pw-f', 'Heslo'), field('code', 'Overovací kód'), btn('ok', null, { icon: 'right', primary: true })], acts: [['tap', 'pw-f'], ['type', 'pw-f', '••••••••'], ['tap', 'code'], ['type', 'code', '482 913'], ['tap', 'ok']] },
    },
    {
      t: 'Požiadaj o archív',
      d: 'Klikni na [[Request archive]].',
      scene: { frame: 'browser', url: 'x.com/settings', items: [big('Download an archive of your data'), fill(1), btn('req', 'Request archive', { primary: true })], acts: [['tap', 'req'], ['toast', 'Teraz čakáš na mail']] },
    },
    {
      t: 'Stiahni archív',
      d: 'Keď príde mail alebo upozornenie, vráť sa na tú istú stránku a klikni na [[Download archive]].',
      scene: {
        frame: 'browser',
        url: 'x.com/settings',
        items: [big('Download an archive of your data'), btn('dl', 'Download archive', { primary: true }), hid(file('f', 'Súbor ZIP', 'stiahnuté'))],
        acts: [['tap', 'dl'], ['show', 'f'], ['hot', 'f']],
      },
    },
  ],
}

const linkedin = {
  onPhone: false,
  before: {
    need: 'Počítač a prihlásenie do LinkedInu.',
    time: '3 minúty. Vybrané časti prídu o pár minút, celý archív do dňa.',
    arrives: 'Mail s odkazom. Platí 72 hodín.',
    file: 'Jeden ZIP s tabuľkami.',
  },
  watch: ['Odkaz platí len 72 hodín.', 'Maily kontaktov uvidíš len pri ľuďoch, ktorí to povolili.'],
  steps: [
    {
      t: 'Otvor nastavenia',
      d: 'Klikni hore na ikonu [[Me]] a vyber [[Settings & Privacy]].',
      link: { url: 'https://www.linkedin.com/mypreferences/d/download-my-data', hint: 'Skratka rovno na stiahnutie dát. Ak sa neotvorí, pokračuj podľa krokov.' },
      scene: {
        frame: 'browser',
        url: 'linkedin.com',
        bar: { title: 'LinkedIn', right: [{ icon: 'bell' }, { id: 'me', avatar: true }] },
        items: [fill(5), sheet('m', [row('sp', 'Settings & Privacy', { icon: 'gear', chev: false }), fill(2)], { kind: 'menu', at: 'tr' })],
        acts: [['tap', 'me'], ['open', 'm'], ['tap', 'sp']],
      },
    },
    {
      t: 'Data privacy',
      d: 'Vľavo klikni na [[Data privacy]]. Potom na [[Get a copy of your data]].',
      scene: {
        frame: 'browser',
        url: 'linkedin.com',
        screens: {
          a: { side: [fill(2), row('dp', 'Data privacy', { chev: false }), fill(2)], items: [fill(5)] },
          b: { side: [fill(2), row('dp', 'Data privacy', { chev: false, on: true }), fill(2)], items: [head('How LinkedIn uses your data'), row('copy', 'Get a copy of your data', { icon: 'down' }), fill(3)] },
        },
        acts: [['tap', 'dp'], ['go', 'b'], ['tap', 'copy']],
      },
    },
    {
      t: 'Vyber a požiadaj',
      d: 'Nechaj celý archív. Ak to chceš rýchlo, vyber len [[Messages]], [[Connections]] a [[Profile]]. Klikni na [[Request archive]].',
      scene: {
        frame: 'browser',
        url: 'linkedin.com',
        items: [head('Get a copy of your data'), chk('c1', 'Messages'), chk('c2', 'Connections'), chk('c3', 'Profile'), fill(1), btn('req', 'Request archive', { primary: true })],
        acts: [['tick', 'c1'], ['tick', 'c2'], ['tick', 'c3'], ['tap', 'req'], ['toast', 'Teraz čakáš na mail']],
      },
    },
    { t: 'Stiahni z mailu', d: 'Keď príde mail od LinkedInu, klikni na odkaz a stiahni ZIP. Máš na to 72 hodín.', scene: mailScene('LinkedIn', true) },
  ],
}

const tiktok = {
  onPhone: true,
  before: {
    need: 'Telefón s appkou TikTok.',
    time: '3 minúty. Potom pár dní čakania.',
    arrives: 'Upozornenie v appke. Súbor stiahneš na tej istej obrazovke. Je tam najviac 4 dni.',
    file: 'Jeden ZIP.',
  },
  watch: ['Súbor je na stiahnutie najviac 4 dni.', 'Posledné 1 až 2 dni v exporte môžu chýbať.', 'Videá sú v exporte len ako odkazy.'],
  steps: [
    {
      t: 'Otvor nastavenia',
      d: 'V appke ťukni na [[Profile]], potom na ponuku (tri čiarky) a na [[Settings and privacy]].',
      scene: {
        frame: 'phone',
        screens: {
          p: { bar: { title: 'Profile', right: [{ id: 'menu', icon: 'menu' }] }, items: [who('Ty', 'tvoj profil'), fill(3), sheet('m', [row('sp', 'Settings and privacy', { icon: 'gear', chev: false }), fill(1)])] },
        },
        acts: [['tap', 'menu'], ['open', 'm'], ['tap', 'sp']],
      },
    },
    {
      t: 'Download your data',
      d: 'Ťukni na [[Account]] a potom na [[Download your data]].',
      scene: {
        frame: 'phone',
        screens: {
          s: { bar: { title: 'Settings and privacy', back: true }, items: [row('acc', 'Account', { icon: 'user' }), fill(5)] },
          a: { bar: { title: 'Account', back: true }, items: [fill(3), row('dl', 'Download your data', { icon: 'down' }), fill(1)] },
        },
        acts: [['tap', 'acc'], ['go', 'a'], ['tap', 'dl']],
      },
    },
    {
      t: 'Vyber JSON a požiadaj',
      d: 'Vyber, čo chceš dostať, a formát [[JSON]]. Ťukni na [[Request data]].',
      scene: {
        frame: 'phone',
        bar: { title: 'Download your data', back: true },
        items: [head('File format'), opt('txt', 'TXT', true), opt('json', 'JSON'), btn('req', 'Request data', { primary: true })],
        acts: [['pick', 'json'], ['tap', 'req'], ['toast', 'Teraz čakáš pár dní']],
      },
    },
    {
      t: 'Stiahni súbor',
      d: 'O pár dní na tej istej obrazovke otvor záložku [[Download data]] a ťukni na [[Download]].',
      scene: {
        frame: 'phone',
        bar: { title: 'Download your data', back: true },
        items: [head('Download data'), file('z', 'Tvoje dáta', 'ZIP · 4 dni na stiahnutie', { btn: 'Download' })],
        acts: [['tap', 'z-btn'], ['hot', 'z'], ['toast', 'Stiahnuté']],
      },
    },
  ],
}

const snapchat = {
  onPhone: true,
  before: {
    need: 'Počítač alebo telefón a prihlásenie do Snapchatu.',
    time: '5 minút. Malý export príde o pár hodín, inak do 7 dní.',
    arrives: 'Mail s odkazom. Odkazy fungujú asi týždeň.',
    file: 'Jeden alebo viac ZIP súborov.',
  },
  watch: ['V exporte sú len uložené správy. Neuložené sú preč.', 'Spomienky a médiá z chatov robia export veľký. Príde vo viacerých súboroch.'],
  steps: [
    {
      t: 'Otvor My Data',
      d: 'Prihlás sa na accounts.snapchat.com a klikni na [[My Data]]. V appke je to v nastaveniach, tiež pod [[My Data]].',
      link: { url: 'https://accounts.snapchat.com/accounts/downloadmydata', hint: 'Skratka rovno na My Data. Ak sa neotvorí, pokračuj podľa krokov.' },
      scene: { frame: 'browser', url: 'accounts.snapchat.com', items: [big('Account'), fill(2), row('my', 'My Data', { icon: 'down' }), fill(2)], acts: [['tap', 'my']] },
    },
    {
      t: 'Zapni JSON',
      d: 'Zapni [[Export JSON Files]]. [[Export your Memories]] a [[Export Chat Media]] zapni, len ak chceš aj fotky a videá. Výber dátumov vypni, nech príde všetko.',
      scene: {
        frame: 'browser',
        url: 'accounts.snapchat.com',
        items: [big('My Data'), tog('json', 'Export JSON Files'), tog('mem', 'Export your Memories'), tog('media', 'Export Chat Media'), tog('range', 'Date range', true)],
        acts: [['tick', 'json'], ['untick', 'range']],
      },
    },
    {
      t: 'Odošli žiadosť',
      d: 'Potvrď svoj mail a klikni na [[Submit]].',
      scene: { frame: 'browser', url: 'accounts.snapchat.com', items: [big('My Data'), field('em', 'E-mail', 'ty@mail.sk'), btn('sub', 'Submit', { primary: true })], acts: [['hot', 'em'], ['tap', 'sub'], ['toast', 'Teraz čakáš na mail']] },
    },
    { t: 'Stiahni z mailu', d: 'V maile klikni na [[See exports]] a potom na [[Download]].', scene: mailScene('Snapchat', 'See exports') },
  ],
}

const netflix = {
  onPhone: false,
  before: {
    need: 'Prehliadač. V mobilnej appke to nie je.',
    time: '2 minúty. Súbor máš hneď.',
    arrives: 'Stiahne sa rovno v prehliadači.',
    file: 'Tabuľka CSV s tým, čo si pozeral.',
  },
  watch: [
    'Každý profil sa sťahuje zvlášť.',
    'V tomto súbore sú len názvy a dátumy. Ak chceš aj časy a dĺžku pozerania, požiadaj o celé dáta na netflix.com/account/getmyinfo. To trvá až 30 dní.',
  ],
  steps: [
    {
      t: 'Otvor svoj profil v účte',
      d: 'V prehliadači otvor stránku účtu ([[Account]]). Klikni na [[Profiles]] a vyber svoj profil.',
      link: { url: 'https://www.netflix.com/viewingactivity', hint: 'Skratka rovno na históriu pozerania. Ak sa neotvorí, pokračuj podľa krokov.' },
      scene: {
        frame: 'browser',
        url: 'netflix.com/account',
        screens: { acc: { side: [fill(2), row('prof', 'Profiles', { chev: false }), fill(2)], items: [big('Account'), fill(4)] }, prof: { side: [fill(2), row('prof', 'Profiles', { chev: false, on: true }), fill(2)], items: [big('Profiles'), row('me', 'Tvoj profil', { icon: 'user' }), fill(2)] } },
        acts: [['tap', 'prof'], ['go', 'prof'], ['tap', 'me']],
      },
    },
    {
      t: 'Viewing activity',
      d: 'V profile otvor [[Viewing activity]].',
      scene: { frame: 'browser', url: 'netflix.com/account', items: [big('Tvoj profil'), fill(2), row('va', 'Viewing activity', { icon: 'clock' }), fill(2)], acts: [['tap', 'va']] },
    },
    {
      t: 'Stiahni všetko',
      d: 'Zíď úplne dole a klikni na [[Download all]].',
      scene: {
        frame: 'browser',
        url: 'netflix.com/viewingactivity',
        items: [big('Viewing activity'), fill(7), btn('dl', 'Download all', { small: true }), hid(file('f', 'História pozerania', 'CSV · stiahnuté', { icon: 'file' }))],
        acts: [['tap', 'dl'], ['show', 'f'], ['hot', 'f']],
      },
    },
  ],
}

const notion = {
  onPhone: false,
  before: {
    need: 'Počítač. Musíš byť majiteľ alebo admin pracovného priestoru.',
    time: '3 minúty. Veľký priestor sa pripravuje dlhšie.',
    arrives: 'Mail s odkazom. Platí 7 dní.',
    file: 'Jeden ZIP s poznámkami.',
  },
  watch: [
    'Jednu stránku vieš exportovať aj cez tri bodky vpravo hore a [[Export]]. Zapni [[Include subpages]].',
    'Pri veľmi veľkom priestore môže export zlyhať. Vtedy exportuj hlavné stránky po jednej.',
  ],
  steps: [
    {
      t: 'Otvor nastavenia',
      d: 'V bočnom paneli klikni na [[Settings]] a potom na [[General]].',
      scene: {
        frame: 'app',
        url: 'Notion',
        screens: { home: { side: [row('set', 'Settings', { icon: 'gear', chev: false }), fill(5)], items: [fill(5)] }, set: { side: [row('gen', 'General', { chev: false }), fill(4)], items: [fill(5)] } },
        acts: [['tap', 'set'], ['go', 'set'], ['tap', 'gen']],
      },
    },
    {
      t: 'Export celého priestoru',
      d: 'Klikni na [[Export all workspace content]].',
      scene: { frame: 'app', url: 'Notion', side: [row('gen', 'General', { chev: false, on: true }), fill(4)], items: [big('General'), fill(4), btn('exp', 'Export all workspace content')], acts: [['tap', 'exp']] },
    },
    {
      t: 'Vyber Markdown',
      d: 'Formát daj [[Markdown & CSV]] a obsah [[Everything]]. Klikni na [[Export]].',
      scene: {
        frame: 'app',
        url: 'Notion',
        items: [fill(3), sheet('d', [row('fmt', 'Export format', { val: 'HTML', chev: false }), row('inc', 'Include content', { val: 'Everything', chev: false }), btn('go', 'Export', { primary: true })], { kind: 'dialog', open: true })],
        acts: [['tap', 'fmt'], ['set', 'fmt', 'Markdown & CSV'], ['hot', 'inc'], ['tap', 'go'], ['close', 'd'], ['toast', 'Teraz čakáš na mail']],
      },
    },
    { t: 'Stiahni z mailu', d: 'Otvor mail od Notionu a stiahni ZIP. Odkaz platí 7 dní.', scene: mailScene('Notion', true) },
  ],
}

const strava = {
  onPhone: false,
  before: {
    need: 'Počítač. V appke to nejde.',
    time: '3 minúty. Mail príde zvyčajne do pár hodín.',
    arrives: 'Mail s odkazom na stiahnutie.',
    file: 'Jeden ZIP so všetkými aktivitami.',
  },
  watch: ['Tá istá stránka slúži aj na zmazanie účtu. Skonči pri kroku 2 a ďalej neklikaj.', 'Názvy tlačidiel máme zo starších návodov. Môžu sa trochu líšiť.'],
  steps: [
    {
      t: 'Otvor nastavenia',
      d: 'Na strava.com prejdi myšou na svoju profilovú fotku a klikni na [[Settings]].',
      scene: {
        frame: 'browser',
        url: 'strava.com',
        bar: { title: 'Strava', right: [{ id: 'me', avatar: true }] },
        items: [fill(5), sheet('m', [fill(1), row('set', 'Settings', { icon: 'gear', chev: false })], { kind: 'menu', at: 'tr' })],
        acts: [['tap', 'me'], ['open', 'm'], ['tap', 'set']],
      },
    },
    {
      t: 'My Account',
      d: 'Otvor [[My Account]]. Pri [[Download or Delete Your Account]] klikni na [[Get Started]].',
      scene: {
        frame: 'browser',
        url: 'strava.com/settings',
        side: [row('acc', 'My Account', { chev: false }), fill(4)],
        items: [big('My Account'), fill(4), head('Download or Delete Your Account'), btn('gs', 'Get Started', { small: true })],
        acts: [['tap', 'acc'], ['tap', 'gs']],
      },
    },
    {
      t: 'Požiadaj o archív',
      d: 'V kroku 2 s názvom [[Download Request]] klikni na [[Request Your Archive]]. Ďalej už nepokračuj, krok 3 je zmazanie účtu.',
      scene: {
        frame: 'browser',
        url: 'strava.com',
        items: [big('Download or Delete Your Account'), head('2 · Download Request'), btn('req', 'Request Your Archive', { primary: true }), head('3'), fill(1)],
        acts: [['tap', 'req'], ['toast', 'Hotovo. Tu skonči.']],
      },
    },
    { t: 'Stiahni z mailu', d: 'Keď príde mail od Stravy, klikni na odkaz a stiahni ZIP.', scene: mailScene('Strava', true) },
  ],
}

const garmin = {
  onPhone: false,
  before: {
    need: 'Prehliadač a prihlásenie do Garmin účtu.',
    time: '3 minúty. Zvyčajne to trvá asi 2 dni, najviac 30.',
    arrives: 'Mail s odkazom na stiahnutie.',
    file: 'Jeden ZIP.',
  },
  watch: ['Rýchla cesta len pre aktivity: v Garmin Connect otvor [[Activities]], [[All Activities]] a [[Export CSV]]. Najprv zroluj zoznam až dole. Exportuje sa len to, čo je načítané.'],
  steps: [
    {
      t: 'Otvor správu dát',
      d: 'Otvor stránku Garmin [[Account Data Management]] a prihlás sa.',
      link: { url: 'https://www.garmin.com/account/datamanagement/', hint: 'Ak sa stránka neotvorí, hľadaj v Garmin účte časť Data Management.' },
      scene: {
        frame: 'browser',
        url: 'garmin.com/account',
        screens: { login: { items: [big('Garmin'), field('em', 'E-mail'), btn('in', null, { icon: 'right', primary: true })] }, dm: { items: [big('Data Management'), row('exp', 'Export Your Data', { icon: 'down' }), fill(2)] } },
        acts: [['tap', 'em'], ['type', 'em', 'ty@mail.sk'], ['tap', 'in'], ['go', 'dm'], ['hot', 'exp']],
      },
    },
    {
      t: 'Požiadaj o export',
      d: 'Klikni na [[Export Your Data]] a potom na [[Request Data Export]].',
      scene: {
        frame: 'browser',
        url: 'garmin.com/account',
        screens: { dm: { items: [big('Data Management'), row('exp', 'Export Your Data', { icon: 'down' }), fill(2)] }, ex: { items: [big('Export Your Data'), fill(1), btn('req', 'Request Data Export', { primary: true })] } },
        acts: [['tap', 'exp'], ['go', 'ex'], ['tap', 'req'], ['toast', 'Teraz čakáš na mail']],
      },
    },
    { t: 'Stiahni z mailu', d: 'Keď príde mail od Garminu, klikni na odkaz a stiahni ZIP.', scene: mailScene('Garmin', true) },
  ],
}

const goodreads = {
  onPhone: false,
  before: {
    need: 'Počítač. V mobilnej appke to nie je.',
    time: '2 minúty. Súbor je hotový do pár minút.',
    arrives: 'Odkaz sa objaví na tej istej stránke.',
    file: 'Tabuľka CSV so všetkými knihami.',
  },
  watch: ['V telefóne si v prehliadači zapni verziu pre počítač.', 'Pri každej knihe je len posledný dátum prečítania.'],
  steps: [
    {
      t: 'Otvor My Books',
      d: 'Na webe Goodreads sa prihlás a otvor [[My Books]].',
      link: { url: 'https://www.goodreads.com/review/import', hint: 'Skratka rovno na stránku Import and export.' },
      scene: { frame: 'browser', url: 'goodreads.com', bar: { title: 'Goodreads', right: [{ id: 'books', icon: 'book' }, { avatar: true }] }, items: [fill(5)], acts: [['tap', 'books']] },
    },
    {
      t: 'Import and export',
      d: 'Vľavo v časti [[Tools]] klikni na [[Import and export]].',
      scene: { frame: 'browser', url: 'goodreads.com', side: [fill(3), head('Tools'), row('ie', 'Import and export', { chev: false })], items: [big('My Books'), fill(5)], acts: [['tap', 'ie']] },
    },
    {
      t: 'Export Library',
      d: 'Klikni na [[Export Library]]. Chvíľu počkaj, kým sa objaví odkaz [[Your export from…]]. Kliknutím naň stiahneš súbor.',
      scene: {
        frame: 'browser',
        url: 'goodreads.com/review/import',
        items: [big('Import and export'), btn('exp', 'Export Library', { small: true }), hid(prog('p', 'Pripravuje sa')), hid(row('link', 'Your export from…', { icon: 'down', chev: false })), hid(file('f', 'Tvoje knihy', 'CSV · stiahnuté', { icon: 'file' }))],
        acts: [['tap', 'exp'], ['show', 'p'], ['run', 'p'], ['show', 'link'], ['tap', 'link'], ['show', 'f'], ['hot', 'f']],
      },
    },
  ],
}

const letterboxd = {
  onPhone: false,
  before: {
    need: 'Prehliadač a prihlásenie do Letterboxd.',
    time: 'Minúta. Súbor máš hneď.',
    arrives: 'Stiahne sa rovno v prehliadači.',
    file: 'Jeden ZIP s tabuľkami.',
  },
  watch: ['Postup máme z neoficiálnych návodov. Ak tlačidlo nevidíš, hľadaj v nastaveniach slovo Data alebo Export.'],
  steps: [
    {
      t: 'Otvor nastavenia',
      d: 'Na letterboxd.com otvor ponuku pri svojom profile a klikni na [[Settings]].',
      link: { url: 'https://letterboxd.com/settings/data/', hint: 'Skratka rovno na záložku Data. Ak sa neotvorí, pokračuj podľa krokov.' },
      scene: {
        frame: 'browser',
        url: 'letterboxd.com',
        bar: { title: 'Letterboxd', right: [{ id: 'me', avatar: true }] },
        items: [fill(5), sheet('m', [fill(1), row('set', 'Settings', { icon: 'gear', chev: false })], { kind: 'menu', at: 'tr' })],
        acts: [['tap', 'me'], ['open', 'm'], ['tap', 'set']],
      },
    },
    {
      t: 'Záložka Data',
      d: 'V nastaveniach otvor záložku [[Data]].',
      scene: { frame: 'browser', url: 'letterboxd.com/settings', side: [fill(3), row('data', 'Data', { chev: false })], items: [big('Settings'), fill(4)], acts: [['tap', 'data']] },
    },
    {
      t: 'Exportuj',
      d: 'Klikni na [[Export Your Data]] a potvrď. ZIP sa stiahne hneď.',
      scene: {
        frame: 'browser',
        url: 'letterboxd.com/settings/data',
        side: [fill(3), row('data', 'Data', { chev: false, on: true })],
        items: [big('Data'), btn('exp', 'Export Your Data', { primary: true }), hid(file('f', 'Tvoje filmy', 'ZIP · stiahnuté'))],
        acts: [['tap', 'exp'], ['show', 'f'], ['hot', 'f']],
      },
    },
  ],
}

const kindle = {
  onPhone: false,
  before: {
    need: 'Čítačka Kindle, USB kábel a počítač.',
    time: '5 minút. Nič nečakáš.',
    arrives: 'Súbor si skopíruješ rovno z čítačky.',
    file: 'Textový súbor My Clippings.txt.',
  },
  watch: [
    'V súbore sú len zvýraznenia z tejto jednej čítačky.',
    'Web ukáže len knihy kúpené na Amazone a dlhé zvýraznenia môže skrátiť.',
    'Novšie čítačky sa na Macu nemusia zobraziť ako disk. Vtedy použi web.',
  ],
  steps: [
    {
      t: 'Pripoj Kindle káblom',
      d: 'Pripoj čítačku k počítaču cez USB kábel. Objaví sa ako disk.',
      scene: { frame: 'app', url: 'Tento počítač', items: [fill(2), hid(file('k', 'Kindle', 'pripojený disk', { icon: 'cable' }))], acts: [['show', 'k'], ['tap', 'k'], ['hot', 'k']] },
    },
    {
      t: 'Skopíruj My Clippings',
      d: 'Otvor disk Kindle a v ňom priečinok [[documents]]. Skopíruj súbor [[My Clippings.txt]] do počítača.',
      scene: {
        frame: 'app',
        url: 'Kindle',
        screens: { root: { items: [file('doc', 'documents', 'priečinok', { icon: 'folder' }), fill(2)] }, doc: { bar: { title: 'documents', back: true }, items: [fill(2), file('clip', 'My Clippings.txt', 'tvoje zvýraznenia', { icon: 'file' }), fill(1)] } },
        acts: [['tap', 'doc'], ['go', 'doc'], ['tap', 'clip'], ['hot', 'clip']],
      },
    },
    {
      t: 'Alebo cez web',
      d: 'Bez kábla: otvor read.amazon.com/notebook, vyber knihu a zvýraznenia skopíruj.',
      link: { url: 'https://read.amazon.com/notebook' },
      scene: {
        frame: 'browser',
        url: 'read.amazon.com/notebook',
        side: [row('b1', 'Kniha 1', { icon: 'book', chev: false }), row('b2', 'Kniha 2', { icon: 'book', chev: false }), row('b3', 'Kniha 3', { icon: 'book', chev: false })],
        items: [big('Notebook'), fill(4)],
        acts: [['tap', 'b1'], ['tap', 'b2']],
      },
    },
  ],
}

// ── export ──────────────────────────────────────────────────────────────────

export const GUIDES = {
  instagram,
  facebook: {
    variants: [
      { id: 'export', name: 'Facebook a staršie správy', ...facebookMain },
      { id: 'messenger', name: 'Šifrované chaty Messengera', ...facebookMessenger },
    ],
  },
  whatsapp: {
    variants: [
      { id: 'iphone', name: 'iPhone', ...whatsappIphone },
      { id: 'android', name: 'Android', ...whatsappAndroid },
    ],
  },
  discord: {
    variants: [
      { id: 'pocitac', name: 'Počítač', ...discordDesktop },
      { id: 'telefon', name: 'Telefón', ...discordPhone },
    ],
  },
  telegram,
  chatgpt,
  claude,
  google: {
    variants: [
      { id: 'takeout', name: 'Takeout (počítač)', ...googleTakeout },
      { id: 'poloha', name: 'História polohy (telefón)', ...googleLocation },
    ],
  },
  spotify,
  apple,
  health,
  steam,
  x,
  linkedin,
  tiktok,
  snapchat,
  netflix,
  notion,
  strava,
  garmin,
  goodreads,
  letterboxd,
  kindle,
}

/** What Jarvis does with the file, by group. A guide can override it with its own `after` list. */
export const AFTER = {
  ludia: ['Prečíta tvoje rozhovory.', 'Opýta sa ťa, kto je kto.', 'Pridá fotky k ľuďom a spomienkam.'],
  ai: ['Prečíta, čo si s AI riešil.', 'Vytiahne z toho tvoje projekty, plány a záujmy.', 'Opýta sa, čo z toho ešte platí.'],
  zabava: ['Zistí, čo počúvaš, pozeráš a hráš.', 'Zapamätá si tvoj vkus.'],
  zivot: ['Poskladá, kde si bol a čo si robil.', 'Pridá to k tvojim dňom a spomienkam.'],
  citanie: ['Prečíta tvoje poznámky a zvýraznenia.', 'Zapamätá si, čo si čítal a pozeral.'],
  ostatne: ['Prečíta tvoje príspevky a správy.', 'Opýta sa ťa, čo z toho je dôležité.'],
}
