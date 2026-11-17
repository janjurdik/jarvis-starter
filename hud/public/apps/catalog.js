// What the user can pick on /apps/ ("Tvoje appky") and what Jarvis does with each app.
// Plain data, shared by the page, the 3D world on the desktop and the server (hud/server/apps.mjs),
// so keep it free of DOM code.
//
// app: { id, name, group, icon?, mono?, color?, glyph?, how, connector?, guide?, find?, gives }
//   icon       Simple Icons slug in brands.js; without it the tile shows `glyph` (a small drawing below)
//              or `mono` (one or two letters) in `color`
//   how        connector  Claude connector, live (Nastavenia → Konektory → `connector`)
//              export     a copy of the user's data, walkthrough at /guide/#`guide`
//              beeper     live chats through the Beeper connector
//              auto       Jarvis finds it on the computer by himself (`perm`: macOS asks once)
//              file       the user drops a file into Jarvis (`file` says which)
//              ask        no ready path, Jarvis works one out with the user
//   find       words the computer scan (data/scan/scan.json) uses for this app, to preselect it

export const GROUPS = [
  { id: 'chat', name: 'Správy' },
  { id: 'mail', name: 'Mail a kalendár' },
  { id: 'social', name: 'Sociálne siete' },
  { id: 'work', name: 'Práca a úlohy' },
  { id: 'notes', name: 'Poznámky a súbory' },
  { id: 'apple', name: 'Mac a iPhone' },
  { id: 'ai', name: 'AI' },
  { id: 'school', name: 'Škola' },
  { id: 'health', name: 'Zdravie a šport' },
  { id: 'media', name: 'Hudba, filmy a knihy' },
  { id: 'games', name: 'Hry' },
  { id: 'biz', name: 'Podnikanie a peniaze' },
]

export const APPS = [
  // Správy
  { id: 'whatsapp', name: 'WhatsApp', group: 'chat', icon: 'whatsapp', how: 'export', guide: 'whatsapp', find: ['whatsapp'], gives: 'Rozhovory s ľuďmi, na ktorých ti záleží.' },
  { id: 'messenger', name: 'Messenger', group: 'chat', icon: 'messenger', how: 'export', guide: 'facebook', find: ['messenger', 'facebook'], gives: 'Roky správ s kamarátmi a rodinou.' },
  { id: 'discord', name: 'Discord', group: 'chat', icon: 'discord', how: 'export', guide: 'discord', find: ['discord'], gives: 'Servery a rozhovory s partiou.' },
  { id: 'telegram', name: 'Telegram', group: 'chat', icon: 'telegram', how: 'export', guide: 'telegram', find: ['telegram'], gives: 'Rozhovory a skupiny.' },
  { id: 'signal', name: 'Signal', group: 'chat', icon: 'signal', how: 'beeper', find: ['signal'], gives: 'Správy naživo, keď máš Beeper.' },
  { id: 'imessage', name: 'iMessage a SMS', group: 'chat', icon: 'imessage', how: 'auto', perm: 'messages', find: ['imessage', 'správy (imessage'], gives: 'S kým si píšeš najviac (len počty, nie text).' },
  { id: 'slack', name: 'Slack', group: 'chat', mono: 'S', color: '#E01E5A', how: 'connector', connector: 'Slack', find: ['slack'], gives: 'Pracovné kanály naživo a ranný prehľad z nich.' },
  { id: 'teams', name: 'Microsoft Teams', group: 'chat', mono: 'T', color: '#6264A7', how: 'connector', connector: 'Microsoft 365', find: ['teams'], gives: 'Správy a porady z práce alebo školy.' },
  { id: 'snapchat', name: 'Snapchat', group: 'chat', icon: 'snapchat', how: 'export', guide: 'snapchat', find: ['snapchat'], gives: 'Priatelia a spomienky.' },
  { id: 'viber', name: 'Viber', group: 'chat', icon: 'viber', how: 'ask', find: ['viber'], gives: 'Rozhovory s rodinou.' },

  // Mail a kalendár
  { id: 'gmail', name: 'Gmail', group: 'mail', icon: 'gmail', how: 'connector', connector: 'Gmail', find: ['gmail', '@gmail.com'], gives: 'Kto čaká na odpoveď, návrhy odpovedí, stráž pošty.' },
  { id: 'googlecalendar', name: 'Google Kalendár', group: 'mail', icon: 'googlecalendar', how: 'connector', connector: 'Google Calendar', find: ['google calendar', 'calendar.google.com'], gives: 'Čo ťa čaká, pripomienky pred stretnutiami, budík vie tvoj deň.' },
  { id: 'outlook', name: 'Outlook', group: 'mail', mono: 'O', color: '#0F78D4', how: 'connector', connector: 'Microsoft 365', find: ['outlook'], gives: 'Pošta a kalendár z práce alebo školy.' },
  { id: 'applecalendar', name: 'Kalendár na Macu', group: 'mail', glyph: 'calendar', color: '#FF3B30', how: 'auto', perm: 'calendar', find: [], gives: 'Udalosti na 30 dní dopredu.' },
  { id: 'icloudmail', name: 'iCloud Mail', group: 'mail', icon: 'icloud', how: 'ask', find: ['apple mail'], gives: 'Pošta z Apple účtu.' },
  { id: 'seznam', name: 'Seznam Email', group: 'mail', mono: 'S', color: '#CC0000', how: 'ask', find: ['seznam'], gives: 'Pošta zo Seznamu.' },
  { id: 'protonmail', name: 'Proton Mail', group: 'mail', icon: 'protonmail', how: 'ask', find: ['proton'], gives: 'Šifrovaná pošta.' },

  // Sociálne siete
  { id: 'instagram', name: 'Instagram', group: 'social', icon: 'instagram', how: 'export', guide: 'instagram', find: ['instagram'], gives: 'Správy, ľudia a tvoje príspevky. Nápady na obsah z toho, čo funguje.' },
  { id: 'facebook', name: 'Facebook', group: 'social', icon: 'facebook', how: 'export', guide: 'facebook', find: ['facebook'], gives: 'Priatelia, udalosti, narodeniny a príspevky.' },
  { id: 'tiktok', name: 'TikTok', group: 'social', icon: 'tiktok', how: 'export', guide: 'tiktok', find: ['tiktok'], gives: 'Čo pozeráš a čo tvoríš.' },
  { id: 'youtube', name: 'YouTube', group: 'social', icon: 'youtube', how: 'export', guide: 'google', find: ['youtube'], gives: 'Čo ťa baví a čo sa učíš.' },
  { id: 'linkedin', name: 'LinkedIn', group: 'social', mono: 'in', color: '#0A66C2', how: 'export', guide: 'linkedin', find: ['linkedin'], gives: 'Kariéra a pracovné kontakty.' },
  { id: 'x', name: 'X', group: 'social', icon: 'x', how: 'export', guide: 'x', find: ['twitter'], gives: 'Tvoje príspevky a koho sleduješ.' },
  { id: 'threads', name: 'Threads', group: 'social', icon: 'threads', how: 'export', guide: 'instagram', find: ['threads'], gives: 'Príde spolu s Instagramom.' },
  { id: 'reddit', name: 'Reddit', group: 'social', icon: 'reddit', how: 'ask', find: ['reddit'], gives: 'Komunity a témy, ktoré ťa zaujímajú.' },
  { id: 'pinterest', name: 'Pinterest', group: 'social', icon: 'pinterest', how: 'ask', find: ['pinterest'], gives: 'Nápady a vkus.' },
  { id: 'twitch', name: 'Twitch', group: 'social', icon: 'twitch', how: 'ask', find: ['twitch'], gives: 'Koho pozeráš alebo kedy streamuješ.' },
  { id: 'bereal', name: 'BeReal', group: 'social', icon: 'bereal', how: 'ask', find: ['bereal'], gives: 'Denné spomienky.' },

  // Práca a úlohy
  { id: 'notion', name: 'Notion', group: 'work', icon: 'notion', how: 'connector', connector: 'Notion', find: ['notion'], gives: 'Tvoje stránky, databázy a úlohy naživo.' },
  { id: 'googledrive', name: 'Google Disk', group: 'work', icon: 'googledrive', how: 'connector', connector: 'Google Drive', find: ['google drive', 'google disk'], gives: 'Dokumenty, tabuľky a súbory v cloude.' },
  { id: 'googlesheets', name: 'Google Tabuľky', group: 'work', icon: 'googlesheets', how: 'connector', connector: 'Google Drive', find: [], gives: 'Evidencie a tabuľky, ktoré ti Jarvis vedie a dopĺňa.' },
  { id: 'googledocs', name: 'Google Dokumenty', group: 'work', icon: 'googledocs', how: 'connector', connector: 'Google Drive', find: [], gives: 'Texty, ktoré píšeš a zdieľaš.' },
  { id: 'onedrive', name: 'OneDrive a Office', group: 'work', mono: 'O', color: '#0364B8', how: 'connector', connector: 'Microsoft 365', find: ['onedrive', 'microsoft word', 'microsoft excel'], gives: 'Word, Excel a súbory z OneDrivu.' },
  { id: 'asana', name: 'Asana', group: 'work', icon: 'asana', how: 'connector', connector: 'Asana', find: ['asana'], gives: 'Úlohy tímu a termíny v rannom briefe.' },
  { id: 'clickup', name: 'ClickUp', group: 'work', icon: 'clickup', how: 'connector', connector: 'ClickUp', find: ['clickup'], gives: 'Úlohy a projekty.' },
  { id: 'linear', name: 'Linear', group: 'work', icon: 'linear', how: 'connector', connector: 'Linear', find: ['linear'], gives: 'Issues a cykly tímu.' },
  { id: 'trello', name: 'Trello', group: 'work', icon: 'trello', how: 'ask', find: ['trello'], gives: 'Nástenky a karty.' },
  { id: 'todoist', name: 'Todoist', group: 'work', icon: 'todoist', how: 'ask', find: ['todoist'], gives: 'Tvoje úlohy na jednom mieste s Jarvisom.' },
  { id: 'figma', name: 'Figma', group: 'work', icon: 'figma', how: 'connector', connector: 'Figma', find: ['figma'], gives: 'Návrhy a dizajn.' },
  { id: 'canva', name: 'Canva', group: 'work', mono: 'C', color: '#00C4CC', how: 'connector', connector: 'Canva', find: ['canva'], gives: 'Grafiky a príspevky.' },
  { id: 'github', name: 'GitHub', group: 'work', icon: 'github', how: 'connector', connector: 'GitHub', find: ['github'], gives: 'Na čom programuješ a čo čaká na review.' },
  { id: 'airtable', name: 'Airtable', group: 'work', icon: 'airtable', how: 'ask', find: ['airtable'], gives: 'Databázy a evidencie.' },
  { id: 'dropbox', name: 'Dropbox', group: 'work', icon: 'dropbox', how: 'ask', find: ['dropbox'], gives: 'Súbory v cloude.' },
  { id: 'zoom', name: 'Zoom', group: 'work', icon: 'zoom', how: 'ask', find: ['zoom'], gives: 'Porady a ich zápisy.' },

  // Poznámky a súbory
  { id: 'obsidian', name: 'Obsidian', group: 'notes', icon: 'obsidian', how: 'auto', find: ['obsidian'], gives: 'Tvoje poznámky, ľudia a projekty rovno do pamäte.' },
  { id: 'evernote', name: 'Evernote', group: 'notes', icon: 'evernote', how: 'ask', find: ['evernote'], gives: 'Staré poznámky do pamäte.' },
  { id: 'googlekeep', name: 'Google Keep', group: 'notes', icon: 'googlekeep', how: 'export', guide: 'google', find: ['google keep'], gives: 'Rýchle poznámky a zoznamy.' },
  { id: 'things', name: 'Things', group: 'notes', icon: 'things', how: 'ask', find: ['things'], gives: 'Úlohy z Things.' },
  { id: 'ticktick', name: 'TickTick', group: 'notes', icon: 'ticktick', how: 'ask', find: ['ticktick'], gives: 'Úlohy a návyky.' },

  // Mac a iPhone
  { id: 'applenotes', name: 'Poznámky', group: 'apple', glyph: 'note', color: '#FFCC00', how: 'auto', perm: 'applenotes', find: ['apple poznámky'], gives: 'Čo si zapisuješ do telefónu.' },
  { id: 'applereminders', name: 'Pripomienky', group: 'apple', glyph: 'check', color: '#FF9500', how: 'auto', perm: 'reminders', find: [], gives: 'Tvoje otvorené úlohy.' },
  { id: 'applecontacts', name: 'Kontakty', group: 'apple', glyph: 'person', color: '#8E8E93', how: 'auto', perm: 'contacts', find: [], gives: 'Ľudia a ich narodeniny.' },
  { id: 'applephotos', name: 'Fotky', group: 'apple', glyph: 'flower', color: '#FF2D55', how: 'auto', perm: 'photos', find: ['knižnica fotiek', 'photos library'], gives: 'Albumy, výlety a ľudia na fotkách.' },
  { id: 'icloud', name: 'iCloud', group: 'apple', icon: 'icloud', how: 'export', guide: 'apple', find: ['icloud'], gives: 'Kópia dát z Apple účtu.' },

  // AI
  { id: 'chatgpt', name: 'ChatGPT', group: 'ai', glyph: 'knot', color: '#10A37F', how: 'export', guide: 'chatgpt', find: ['chatgpt'], gives: 'Roky rozhovorov: čo riešiš a ako premýšľaš.' },
  { id: 'claude', name: 'Claude', group: 'ai', icon: 'claude', how: 'export', guide: 'claude', find: ['claude'], gives: 'Staršie rozhovory s Claude.' },
  { id: 'gemini', name: 'Gemini', group: 'ai', icon: 'googlegemini', how: 'ask', find: ['gemini'], gives: 'Rozhovory s Gemini.' },
  { id: 'perplexity', name: 'Perplexity', group: 'ai', icon: 'perplexity', how: 'ask', find: ['perplexity'], gives: 'Čo si vyhľadávaš.' },

  // Škola
  { id: 'edupage', name: 'EduPage', group: 'school', mono: 'E', color: '#E85A2B', how: 'ask', find: ['edupage'], gives: 'Rozvrh, známky a domáce úlohy.' },
  { id: 'googleclassroom', name: 'Google Classroom', group: 'school', icon: 'googleclassroom', how: 'ask', find: ['classroom'], gives: 'Zadania a termíny.' },
  { id: 'moodle', name: 'Moodle', group: 'school', icon: 'moodle', how: 'ask', find: ['moodle'], gives: 'Kurzy a odovzdávky.' },
  { id: 'unisystem', name: 'Univerzitný systém (IS, AIS)', group: 'school', glyph: 'school', color: '#7FF3FF', how: 'file', file: 'rozvrh alebo kalendár (.ics) zo systému školy', find: ['muni', 'rozvrh', 'is.muni', 'ais2'], gives: 'Rozvrh, skúšky a termíny odovzdávok.' },
  { id: 'duolingo', name: 'Duolingo', group: 'school', icon: 'duolingo', how: 'ask', find: ['duolingo'], gives: 'Jazyk, ktorý sa učíš, a tvoja séria.' },

  // Zdravie a šport
  { id: 'applehealth', name: 'Zdravie na iPhone', group: 'health', glyph: 'heart', color: '#FF2D55', how: 'export', guide: 'health', find: [], gives: 'Spánok, kroky a tréningy pre ranný brief.' },
  { id: 'garmin', name: 'Garmin', group: 'health', icon: 'garmin', how: 'export', guide: 'garmin', find: ['garmin'], gives: 'Spánok, tréningy a záťaž.' },
  { id: 'strava', name: 'Strava', group: 'health', icon: 'strava', how: 'export', guide: 'strava', find: ['strava'], gives: 'Behy, bicykel a pokroky.' },
  { id: 'fitbit', name: 'Fitbit', group: 'health', icon: 'fitbit', how: 'ask', find: ['fitbit'], gives: 'Spánok a pohyb.' },
  { id: 'samsunghealth', name: 'Samsung Health', group: 'health', icon: 'samsung', how: 'ask', find: ['samsung health'], gives: 'Spánok a pohyb.' },
  { id: 'gym', name: 'Fitko', group: 'health', glyph: 'dumbbell', color: '#7FF3FF', how: 'ask', find: [], gives: 'Plán tréningu a jedálniček podľa tvojho cieľa.' },

  // Hudba, filmy a knihy
  { id: 'spotify', name: 'Spotify', group: 'media', icon: 'spotify', how: 'export', guide: 'spotify', find: ['spotify'], gives: 'Tvoj hudobný vkus a čo počúvaš pri čom.' },
  { id: 'applemusic', name: 'Apple Music', group: 'media', icon: 'applemusic', how: 'export', guide: 'apple', find: ['apple music'], gives: 'Čo počúvaš.' },
  { id: 'youtubemusic', name: 'YouTube Music', group: 'media', icon: 'youtubemusic', how: 'export', guide: 'google', find: ['youtube music'], gives: 'Čo počúvaš.' },
  { id: 'netflix', name: 'Netflix', group: 'media', icon: 'netflix', how: 'export', guide: 'netflix', find: ['netflix'], gives: 'Čo pozeráš a čo ti odporučiť.' },
  { id: 'hbomax', name: 'HBO Max', group: 'media', icon: 'hbomax', how: 'ask', find: ['hbo'], gives: 'Seriály, ktoré pozeráš.' },
  { id: 'applepodcasts', name: 'Podcasty', group: 'media', icon: 'applepodcasts', how: 'ask', find: ['podcast'], gives: 'Čo počúvaš a čo sa učíš.' },
  { id: 'kindle', name: 'Kindle', group: 'media', glyph: 'book', color: '#FF9900', how: 'export', guide: 'kindle', find: ['kindle'], gives: 'Knihy a podčiarknuté pasáže.' },
  { id: 'goodreads', name: 'Goodreads', group: 'media', icon: 'goodreads', how: 'export', guide: 'goodreads', find: ['goodreads'], gives: 'Prečítané knihy a hodnotenia.' },
  { id: 'letterboxd', name: 'Letterboxd', group: 'media', icon: 'letterboxd', how: 'export', guide: 'letterboxd', find: ['letterboxd'], gives: 'Filmy, ktoré si videl.' },

  // Hry
  { id: 'steam', name: 'Steam', group: 'games', icon: 'steam', how: 'auto', find: ['steam'], gives: 'Tvoje hry a koľko ich hráš.' },
  { id: 'minecraft', name: 'Minecraft', group: 'games', glyph: 'cube', color: '#62B47A', how: 'auto', find: ['minecraft'], gives: 'Svety a servery, kde hráš.' },
  { id: 'playstation', name: 'PlayStation', group: 'games', icon: 'playstation', how: 'ask', find: ['playstation'], gives: 'Hry a trofeje.' },
  { id: 'xbox', name: 'Xbox', group: 'games', mono: 'X', color: '#107C10', how: 'ask', find: ['xbox'], gives: 'Hry a úspechy.' },
  { id: 'epicgames', name: 'Epic Games', group: 'games', icon: 'epicgames', how: 'ask', find: ['epic games'], gives: 'Tvoje hry.' },

  // Podnikanie a peniaze
  { id: 'shopify', name: 'Shopify', group: 'biz', icon: 'shopify', how: 'ask', find: ['shopify'], gives: 'Objednávky a predaje.' },
  { id: 'woocommerce', name: 'WooCommerce', group: 'biz', icon: 'woocommerce', how: 'ask', find: ['woocommerce'], gives: 'Objednávky z e-shopu.' },
  { id: 'wordpress', name: 'WordPress', group: 'biz', icon: 'wordpress', how: 'ask', find: ['wordpress'], gives: 'Tvoj web a jeho obsah.' },
  { id: 'stripe', name: 'Stripe', group: 'biz', icon: 'stripe', how: 'connector', connector: 'Stripe', find: ['stripe'], gives: 'Platby a predaje naživo.' },
  { id: 'googleads', name: 'Google Ads', group: 'biz', icon: 'googleads', how: 'ask', find: ['google ads'], gives: 'Ako idú reklamy.' },
  { id: 'metaads', name: 'Meta reklamy', group: 'biz', icon: 'meta', how: 'ask', find: ['meta ads', 'business suite'], gives: 'Reklamy na Instagrame a Facebooku.' },
  { id: 'invoices', name: 'Faktúry', group: 'biz', glyph: 'doc', color: '#7FF3FF', how: 'file', file: 'faktúry a cenové ponuky (PDF)', find: ['faktúr'], gives: 'Splatnosti, cenové ponuky v tvojom štýle.' },
  { id: 'revolut', name: 'Revolut', group: 'biz', icon: 'revolut', how: 'file', file: 'výpis z účtu (CSV)', find: ['revolut'], gives: 'Na čo míňaš a koľko ti ostáva.' },
  { id: 'bank', name: 'Banka', group: 'biz', glyph: 'bank', color: '#7FF3FF', how: 'file', file: 'výpis z účtu (CSV alebo PDF)', find: [], gives: 'Prehľad výdavkov a predplatných.' },
]

/** What the user wants Jarvis for. Drawn from what people wrote back to the waitlist. */
export const WANTS = [
  { id: 'budik', name: 'Budiť ma a povedať, čo ma čaká', icon: 'alarm' },
  { id: 'pripomienky', name: 'Pripomínať veci, nech nič nezabudnem', icon: 'deadline' },
  { id: 'den', name: 'Plánovať deň a priority', icon: 'timeline' },
  { id: 'posta', name: 'Strážiť maily a kalendár', icon: 'message' },
  { id: 'klienti', name: 'Odpovedať klientom a na dopyty', icon: 'action' },
  { id: 'ponuky', name: 'Cenové ponuky a faktúry', icon: 'project' },
  { id: 'obsah', name: 'Obsah na Instagram a TikTok', icon: 'photo' },
  { id: 'skola', name: 'Škola: termíny a učenie', icon: 'school' },
  { id: 'fitko', name: 'Tréning a jedálniček', icon: 'health' },
  { id: 'tabulky', name: 'Viesť evidenciu v tabuľkách', icon: 'calendar' },
  { id: 'papiere', name: 'Papiere a byrokracia', icon: 'guard' },
  { id: 'ludia', name: 'Pamätať si ľudí a čo sme riešili', icon: 'brain' },
  { id: 'vysvetlit', name: 'Vysvetľovať veci, keď niečomu nerozumiem', icon: 'compass' },
  { id: 'web', name: 'Web a reklama pre firmu', icon: 'web' },
]

export const HOW = {
  connector: { name: 'Pripojíš naživo', tone: 'live' },
  beeper: { name: 'Naživo cez Beeper', tone: 'live' },
  export: { name: 'Pošleš mi kópiu dát', tone: 'export' },
  auto: { name: 'Vidím sám', tone: 'auto' },
  file: { name: 'Pošleš mi súbor', tone: 'file' },
  ask: { name: 'Vymyslíme spolu', tone: 'ask' },
}

export const APP_BY_ID = new Map(APPS.map((a) => [a.id, a]))
