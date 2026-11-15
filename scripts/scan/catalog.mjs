/**
 * Catalog of well-known apps: which group an installed app belongs to and what it tells Jarvis.
 * One line per app: `Name | extra names it is installed under | what it is for (Slovak)`.
 * Names are compared lowercase and without diacritics, see normApp().
 */
import { plain } from './util.mjs'

/** Groups of apps: finding category, Slovak title and what Jarvis can do with the group. */
export const GROUPS = {
  notes: { category: 'notes', title: 'Appky na poznámky', use: 'Viem, kde si píšeš poznámky, a môžem si z nich načítať tvoj život a projekty.', weight: 4 },
  ai: { category: 'ai', title: 'AI nástroje', use: 'Vidím, s akými AI nástrojmi už pracuješ, a môžem z nich prevziať pamäť a zvyky.', weight: 4 },
  code: { category: 'code', title: 'Programovanie', use: 'Ak programuješ, viem v čom, a môžem ti pomáhať aj s technickou prácou.', weight: 3 },
  design: { category: 'media', title: 'Dizajn a grafika', use: 'Ak robíš grafiku, môžem ti pripravovať podklady a texty k návrhom.', weight: 3 },
  video: { category: 'media', title: 'Video a streamovanie', use: 'Ak točíš alebo striháš video, môžem ti pomáhať so scenármi a plánom obsahu.', weight: 3 },
  audio: { category: 'music', title: 'Tvorba hudby a zvuku', use: 'Ak tvoríš hudbu alebo zvuk, môžem ti strážiť projekty a nápady.', weight: 3 },
  music: { category: 'music', title: 'Počúvanie hudby', use: 'Viem, kde počúvaš hudbu, a môžem sa z nej naučiť tvoj vkus.', weight: 2 },
  games: { category: 'games', title: 'Hry a herné obchody', use: 'Viem, čo hrávaš, takže poznám aj tvoj oddych.', weight: 2 },
  comms: { category: 'comms', title: 'Komunikácia', use: 'Viem, kde si píšeš s ľuďmi, a poradím, odkiaľ sa dajú stiahnuť správy.', weight: 3 },
  office: { category: 'apps', title: 'Kancelária a dokumenty', use: 'Viem, v čom píšeš dokumenty a tabuľky, a pripravím ti ich v tom istom formáte.', weight: 2 },
  tasks: { category: 'apps', title: 'Úlohy, kalendár a plánovanie', use: 'Viem, kde si vedieš úlohy a čas, a môžem sa na to napojiť namiesto vymýšľania nového systému.', weight: 4 },
  finance: { category: 'apps', title: 'Financie', use: 'Ak riešiš financie alebo účtovníctvo, môžem ti strážiť termíny.', weight: 2 },
  health: { category: 'apps', title: 'Zdravie a šport', use: 'Ak športuješ alebo sleduješ zdravie, môžem to zahrnúť do prehľadov.', weight: 2 },
  browser: { category: 'browser', title: 'Prehliadače', use: 'Viem, cez ktorý prehliadač chodíš na web, a tam hľadám záložky.', weight: 2 },
  passwords: { category: 'apps', title: 'Správca hesiel', use: 'Viem, kde máš heslá. Nikdy ich nečítam, len ťa tam pošlem, keď treba niečo zadať.', weight: 1 },
  cloud: { category: 'apps', title: 'Úložiská a synchronizácia', use: 'Viem, kde môžu byť ďalšie tvoje súbory mimo tohto počítača.', weight: 2 },
  study: { category: 'school', title: 'Škola a učenie', use: 'Ak študuješ alebo sa niečo učíš, môžem ti pomáhať s učivom a termínmi.', weight: 3 },
  reading: { category: 'apps', title: 'Čítanie', use: 'Ak veľa čítaš, môžem si viesť tvoje knihy a poznámky z nich.', weight: 2 },
  d3: { category: 'media', title: '3D, modelovanie a výroba', use: 'Ak modeluješ alebo tlačíš v 3D, môžem ti viesť projekty.', weight: 3 },
  media: { category: 'media', title: 'Fotky, filmy a prehrávače', use: 'Viem, čím pozeráš filmy a spravuješ fotky.', weight: 1 },
  tools: { category: 'apps', title: 'Pomocné nástroje', use: 'Viem, aké pomôcky používaš, a môžem na ne nadviazať.', weight: 1 },
}

const RAW = {
  notes: `
Obsidian||poznámky v obyčajných súboroch, ktoré viem čítať priamo
Notion||poznámky, databázy a plány v cloude
Bear||poznámky na Macu a iPhone
Logseq||poznámky a denník v súboroch
Evernote||poznámky a výstrižky
Joplin||poznámky s vlastnou databázou
Craft|craft - docs and notes editor|dokumenty a poznámky
Microsoft OneNote|onenote|zošity s poznámkami
Simplenote||jednoduché textové poznámky
Standard Notes||šifrované poznámky
Roam Research||prepojené poznámky
Anytype||poznámky a databázy v počítači
Notesnook||šifrované poznámky
Reflect||prepojené poznámky s kalendárom
Capacities||poznámky podľa typov vecí
Heptabase||poznámky na vizuálnych tabuliach
Tana||poznámky s databázami
Day One||osobný denník
UpNote||poznámky
Typora||písanie v markdowne
iA Writer||písanie textov
Ulysses||písanie dlhších textov
Scrivener|scrivener 3|písanie kníh a prác
Drafts||rýchle zápisky
Goodnotes|goodnotes 5,goodnotes 6|ručne písané poznámky
Notability||ručne písané poznámky
Zettlr||poznámky a akademické písanie
`,
  ai: `
Claude||AI asistent, v ktorom práve si
ChatGPT|chatgpt atlas|AI asistent, dá sa z neho stiahnuť história rozhovorov
Cursor||programovanie s AI
Codex||AI na programovanie od OpenAI
Windsurf||programovanie s AI
Antigravity||programovanie s AI od Googlu
Ollama||AI modely bežiace priamo v počítači
LM Studio||AI modely bežiace priamo v počítači
Jan||AI modely bežiace priamo v počítači
Msty||AI modely bežiace priamo v počítači
Perplexity|perplexity- ask anything|hľadanie na webe s AI
Copilot|microsoft copilot|AI asistent od Microsoftu
Gemini|google gemini|AI asistent od Googlu
Grok||AI asistent od xAI
Poe||viac AI modelov v jednej appke
superwhisper||diktovanie hlasom
MacWhisper||prepis nahrávok na text
Wispr Flow||diktovanie hlasom
Granola||zápisy z meetingov
Fireflies|fireflies.ai|zápisy z meetingov
Otter|otter.ai|zápisy z meetingov
DiffusionBee||tvorba obrázkov v počítači
Draw Things|draw things- ai generation|tvorba obrázkov v počítači
ComfyUI||tvorba obrázkov a videa v počítači
Krisp||odstránenie šumu a zápisy z hovorov
`,
  code: `
Visual Studio Code|code,vscode,visual studio code - insiders|editor kódu
Xcode||vývoj pre iPhone a Mac
Android Studio||vývoj pre Android
IntelliJ IDEA|intellij idea ce,intellij idea ultimate,intellij idea community edition|vývoj v Jave a Kotline
PyCharm|pycharm ce,pycharm community edition,pycharm professional|vývoj v Pythone
WebStorm||vývoj webu
PhpStorm||vývoj v PHP
CLion||vývoj v C a C++
Rider|jetbrains rider|vývoj v C#
GoLand||vývoj v Go
DataGrip||práca s databázami
Visual Studio|visual studio 2022,visual studio 2019|vývoj pre Windows
Sublime Text||editor kódu
Zed||editor kódu
Nova||editor kódu
Notepad++||editor textu a kódu
iTerm|iterm2|terminál
Warp||terminál
Ghostty||terminál
Windows Terminal|terminal|terminál
Docker|docker desktop|kontajnery
OrbStack||kontajnery
Postman||testovanie API
Insomnia||testovanie API
TablePlus||práca s databázami
DBeaver|dbeaver community|práca s databázami
Sequel Ace||práca s databázami
pgAdmin 4||práca s databázami
GitHub Desktop||git
Sourcetree||git
Tower||git
Fork||git
GitKraken||git
Unity Hub|unity|tvorba hier
Godot|godot engine|tvorba hier
Unreal Engine||tvorba hier
Arduino IDE|arduino|programovanie elektroniky
Proxyman||sledovanie sieťovej komunikácie
Ghidra||reverzné inžinierstvo
Hopper Disassembler||reverzné inžinierstvo
UTM||virtuálne počítače
Parallels Desktop||Windows na Macu
VMware Fusion||virtuálne počítače
VirtualBox|oracle virtualbox,oracle vm virtualbox|virtuálne počítače
Termius||pripojenie na servery
Cyberduck||prenos súborov na servery
FileZilla||prenos súborov na servery
Transmit||prenos súborov na servery
PuTTY||pripojenie na servery
WinSCP||prenos súborov na servery
`,
  design: `
Figma|figma beta|návrh webov a appiek
Sketch||návrh webov a appiek
Adobe Photoshop|photoshop|úprava fotiek a grafika
Adobe Illustrator|illustrator|vektorová grafika
Adobe InDesign|indesign|sadzba a tlačoviny
Adobe Lightroom|adobe lightroom classic,lightroom|úprava fotiek
Adobe XD||návrh webov a appiek
Affinity|affinity photo,affinity photo 2,affinity designer,affinity designer 2,affinity publisher,affinity publisher 2|grafika a úprava fotiek
Canva||rýchla grafika a príspevky
Pixelmator Pro||úprava fotiek a grafika
GIMP||úprava fotiek
Inkscape||vektorová grafika
Krita||digitálna maľba
Framer||návrh a tvorba webov
Spline||3D pre web
Rive||animácie
Aseprite||pixel art
Paint.NET|paint.net|úprava obrázkov
Capture One||úprava fotiek
darktable||úprava fotiek
Luminar Neo||úprava fotiek
Creative Cloud|adobe creative cloud|balík Adobe
`,
  video: `
Final Cut Pro||strih videa
Adobe Premiere Pro|premiere pro|strih videa
Adobe After Effects|after effects|animácie a efekty
DaVinci Resolve||strih videa a farby
CapCut||strih krátkych videí
iMovie||strih videa
OBS|obs studio|nahrávanie obrazovky a streamovanie
Streamlabs|streamlabs desktop,streamlabs obs|streamovanie
ScreenFlow||nahrávanie obrazovky
Camtasia||nahrávanie obrazovky
Screen Studio||nahrávanie obrazovky
Loom||nahrávanie krátkych videí
HandBrake||prevod videa
Descript||strih videa a podcastov cez text
Motion||animovaná grafika
Compressor||export videa
Adobe Media Encoder||export videa
Shotcut||strih videa
Kdenlive||strih videa
Clipchamp|microsoft clipchamp|strih videa
Topaz Video AI||vylepšovanie videa
Riverside||nahrávanie rozhovorov
`,
  audio: `
Logic Pro||tvorba hudby
GarageBand||tvorba hudby
Ableton Live||tvorba hudby
FL Studio||tvorba hudby
Audacity||úprava zvuku
Adobe Audition||úprava zvuku
Pro Tools||nahrávanie a mix
REAPER||nahrávanie a mix
Cubase||tvorba hudby
Studio One||tvorba hudby
Bitwig Studio||tvorba hudby
Serato DJ Pro|serato dj lite|DJ
rekordbox||DJ
Traktor Pro|traktor|DJ
MuseScore|musescore 3,musescore 4,musescore studio|notový zápis
Audio Hijack||nahrávanie zvuku
`,
  music: `
Spotify|spotifymusic|počúvanie hudby, dá sa stiahnuť história počúvania
TIDAL||počúvanie hudby
Deezer||počúvanie hudby
YouTube Music||počúvanie hudby
iTunes||hudobná knižnica
foobar2000||prehrávač hudby
Winamp||prehrávač hudby
Plexamp||prehrávač hudby
Shazam||rozpoznávanie skladieb
`,
  games: `
Steam||herný obchod, vidím nainštalované hry a odohrané hodiny
Epic Games Launcher||herný obchod
GOG Galaxy|gog galaxy 2.0|herný obchod
Battle.net||hry od Blizzardu
Riot Client||hry od Riotu
League of Legends||hra
VALORANT||hra
Minecraft|minecraft launcher,minecraft java edition|hra, vidím svety a servery
Roblox|robloxplayer,roblox player|hra
RobloxStudio|roblox studio|tvorba hier v Robloxe
EA app|ea,origin|hry od EA
Ubisoft Connect||hry od Ubisoftu
Xbox|gamingapp|hry od Microsoftu
GeForce NOW|nvidia geforce now|hranie cez cloud
Prism Launcher|prismlauncher|spúšťač Minecraftu s modmi
CurseForge||mody do hier
Lunar Client||spúšťač Minecraftu
Badlion Client||spúšťač Minecraftu
Modrinth App||mody do Minecraftu
osu!|osu!(lazer)|rytmická hra
itch||nezávislé hry
Heroic|heroic games launcher|spúšťač hier
Whisky||Windows hry na Macu
CrossOver||Windows programy na Macu
RetroArch||emulátor starých hier
OpenEmu||emulátor starých hier
Dolphin||emulátor starých hier
FACEIT||súťažné hranie
Overwolf||doplnky k hrám
Medal||klipy z hier
Rockstar Games Launcher||hry od Rockstaru
`,
  comms: `
Slack||pracovný chat
Discord|discord canary,discord ptb|chat a komunity
WhatsApp|whatsapp desktop,whatsappdesktop,whatsapp messenger|správy
Telegram|telegram desktop,telegram lite|správy
Signal||správy
Messenger||správy z Facebooku
Microsoft Teams|teams,microsoft teams classic,microsoft teams (work or school),msteams|pracovný chat a hovory
Zoom|zoom.us,zoom workplace|videohovory
Skype||hovory
Beeper|beeper desktop,beeper texts|všetky chaty na jednom mieste
Viber|rakuten viber|správy
WeChat||správy
LINE||správy
Element||chat cez Matrix
Webex|cisco webex meetings|videohovory
Microsoft Outlook|outlook,outlook (classic),outlook (new),new outlook|mail a kalendár
Thunderbird|mozilla thunderbird|mail
Spark|spark - email app by readdle,spark desktop,spark mail|mail
Airmail|airmail 5|mail
Mimestream||mail pre Gmail
Superhuman||mail
Canary Mail||mail
Proton Mail|proton mail bridge|mail
eM Client||mail
Mailspring||mail
TeamSpeak|teamspeak 3,teamspeak 3 client|hlasový chat
Guilded||chat a komunity
`,
  office: `
Microsoft Word|word|dokumenty
Microsoft Excel|excel|tabuľky
Microsoft PowerPoint|powerpoint|prezentácie
Pages||dokumenty
Numbers||tabuľky
Keynote||prezentácie
LibreOffice|libreoffice writer,libreoffice calc|dokumenty a tabuľky
OpenOffice|openoffice writer|dokumenty a tabuľky
Adobe Acrobat|adobe acrobat reader,adobe acrobat dc,acrobat reader,adobe acrobat reader dc|PDF
PDF Expert|pdf expert – edit, sign pdfs|PDF
ONLYOFFICE|onlyoffice desktop editors|dokumenty a tabuľky
WPS Office||dokumenty a tabuľky
Foxit PDF Reader|foxit reader,foxit pdf editor|PDF
PDFgear||PDF
Skim||PDF a poznámky v ňom
`,
  tasks: `
Things|things3|zoznam úloh
Todoist||zoznam úloh
TickTick||úlohy a návyky
OmniFocus|omnifocus 3,omnifocus 4|zoznam úloh
Microsoft To Do|to do,todos|zoznam úloh
Fantastical|fantastical - calendar & tasks|kalendár
Notion Calendar|cron|kalendár
BusyCal||kalendár
Asana||tímové úlohy
Trello||nástenky s úlohami
Linear||úlohy pre vývojárov
ClickUp||tímové úlohy
monday.com|monday|tímové úlohy
Basecamp|basecamp 3|tímová práca
Sunsama||denné plánovanie
Akiflow||denné plánovanie
Amie||kalendár a úlohy
Toggl Track||meranie času
Clockify|clockify desktop|meranie času
Harvest||meranie času
RescueTime||meranie času pri počítači
Timing||meranie času pri počítači
Session|session - pomodoro focus timer|sústredenie
Forest||sústredenie
Structured|structured - daily planner|denný plán
Miro||tabule na premýšľanie
Airtable||tabuľky a databázy
Coda||dokumenty a tabuľky
Jira||tímové úlohy
`,
  finance: `
YNAB||rozpočet
MoneyMoney||prehľad účtov
Quicken||osobné financie
QuickBooks||účtovníctvo
Revolut||banka
Ledger Live||kryptomeny
Trezor Suite||kryptomeny
Exodus||kryptomeny
Binance||kryptomeny
TradingView||grafy a obchodovanie
MetaTrader|metatrader 4,metatrader 5|obchodovanie
Trader Workstation||obchodovanie
xStation|xtb xstation 5,xstation5|obchodovanie
POHODA||účtovníctvo
Money S3||účtovníctvo
KROS|olymp,alfa plus,omega|účtovníctvo a mzdy
`,
  health: `
Garmin Express||hodinky Garmin, tréningy a spánok
Garmin BaseCamp||plánovanie trás
Zwift||tréning na bicykli
Polar FlowSync||hodinky Polar
TrainerRoad||tréning na bicykli
Strava||šport
Headspace||meditácia
Calm||meditácia
`,
  browser: `
Google Chrome|chrome|prehliadač
Safari||prehliadač
Firefox|mozilla firefox,firefox developer edition|prehliadač
Microsoft Edge|edge|prehliadač
Brave Browser|brave|prehliadač
Arc||prehliadač
Opera|opera gx,opera browser|prehliadač
Vivaldi||prehliadač
Tor Browser||anonymný prehliadač
DuckDuckGo||prehliadač
Zen|zen browser|prehliadač
Dia||prehliadač s AI
Comet||prehliadač s AI
Orion||prehliadač
Chromium||prehliadač
LibreWolf||prehliadač
`,
  passwords: `
1Password|1password 7 - password manager,1password for safari|správca hesiel
Bitwarden||správca hesiel
LastPass||správca hesiel
Dashlane||správca hesiel
KeePassXC||správca hesiel
KeePass|keepass 2|správca hesiel
Enpass||správca hesiel
NordPass||správca hesiel
Proton Pass||správca hesiel
Keeper Password Manager|keeper|správca hesiel
`,
  cloud: `
Dropbox||súbory v cloude
Google Drive|google drive for desktop|súbory v cloude
OneDrive|microsoft onedrive|súbory v cloude
iCloud|icloud drive|súbory a fotky z Apple zariadení
MEGAsync|mega|súbory v cloude
pCloud Drive|pcloud|súbory v cloude
Box|box drive|súbory v cloude
Synology Drive Client|synology drive|vlastné úložisko doma
Nextcloud||vlastné úložisko
Backblaze||záloha počítača
Resilio Sync||synchronizácia medzi zariadeniami
Syncthing||synchronizácia medzi zariadeniami
Proton Drive||súbory v cloude
`,
  study: `
Anki||kartičky na učenie
Zotero||zdroje a citácie
Mendeley|mendeley desktop,mendeley reference manager|zdroje a citácie
MATLAB||výpočty
GeoGebra|geogebra classic,geogebra classic 6,geogebra calculator suite|matematika
Duolingo||jazyky
RStudio||štatistika
JupyterLab|jupyterlab desktop|výpočty a dáta
Mathematica|wolfram mathematica|matematika
EndNote||zdroje a citácie
TeXShop||písanie v LaTeXe
TeXstudio||písanie v LaTeXe
Texmaker||písanie v LaTeXe
Logisim|logisim-evolution|logické obvody
Wireshark||analýza sietí
Cisco Packet Tracer||siete
Scratch|scratch 3,scratch desktop|učenie programovania
IBM SPSS Statistics|spss|štatistika
`,
  reading: `
Kindle|amazon kindle,kindle classic|e-knihy
calibre||knižnica e-kníh
Reeder|reeder 5.|čítačka článkov
NetNewsWire||čítačka článkov
Pocket||uložené články
Instapaper||uložené články
Audible||audioknihy
Readwise|readwise reader|uložené články a zvýraznenia
Adobe Digital Editions||e-knihy
`,
  d3: `
Blender||3D modelovanie a animácia
Autodesk Fusion|fusion,autodesk fusion 360,fusion 360|modelovanie súčiastok
AutoCAD||technické výkresy
SketchUp||3D modelovanie
Cinema 4D||3D animácia
ZBrush||3D sochárstvo
Houdini||3D efekty
Maya|autodesk maya|3D animácia
SolidWorks||modelovanie súčiastok
UltiMaker Cura|cura,ultimaker-cura|príprava 3D tlače
PrusaSlicer||príprava 3D tlače
Bambu Studio|bambustudio|príprava 3D tlače
OrcaSlicer||príprava 3D tlače
FreeCAD||modelovanie súčiastok
Rhino|rhino 7,rhino 8,rhinoceros|3D modelovanie
KiCad||návrh elektroniky
Shapr3D||modelovanie súčiastok
LightBurn||laserové rezanie
`,
  media: `
VLC|vlc media player|prehrávač videa
IINA||prehrávač videa
mpv||prehrávač videa
Plex|plex media server,plex htpc|domáca knižnica filmov
Infuse|infuse 7,infuse 8|prehrávač filmov
Kodi||domáce kino
PotPlayer||prehrávač videa
Stremio||filmy a seriály
Jellyfin|jellyfin media player|domáca knižnica filmov
Adobe Bridge||správa fotiek
digiKam||správa fotiek
Topaz Photo AI||vylepšovanie fotiek
Netflix||filmy a seriály
ImageOptim||zmenšovanie obrázkov
`,
  tools: `
Raycast||rýchle spúšťanie a skratky
Alfred||rýchle spúšťanie a skratky
Rectangle|rectangle pro|usporiadanie okien
Magnet||usporiadanie okien
BetterTouchTool||vlastné gestá a skratky
Karabiner-Elements||úprava klávesnice
Bartender|bartender 4,bartender 5|poriadok v lište
CleanMyMac|cleanmymac x|čistenie Macu
The Unarchiver||rozbaľovanie archívov
Keka||archívy
7-Zip|7-zip file manager|archívy
WinRAR||archívy
Amphetamine||počítač nezaspí
TeamViewer||vzdialená plocha
AnyDesk||vzdialená plocha
RustDesk||vzdialená plocha
Tailscale||súkromná sieť medzi zariadeniami
NordVPN||VPN
ExpressVPN||VPN
Proton VPN|protonvpn|VPN
Mullvad VPN||VPN
WireGuard||VPN
Surfshark||VPN
Little Snitch||kontrola sieťových spojení
CleanShot X||snímky obrazovky
Shottr||snímky obrazovky
ShareX||snímky obrazovky
Greenshot||snímky obrazovky
PowerToys|powertoys (preview)|vylepšenia Windows
AutoHotkey||automatizácia klávesnice
Everything||hľadanie súborov
Logi Options+|logi options,logioptionsplus|myš a klávesnica Logitech
Hammerspoon||automatizácia Macu
Maccy||história schránky
Paste||história schránky
TextExpander||textové skratky
Elgato Stream Deck|stream deck|tlačidlá Stream Deck
Keyboard Maestro||automatizácia Macu
Hazel||automatické triedenie súborov
Carbon Copy Cloner||záloha disku
balenaEtcher||zápis na USB
Raspberry Pi Imager||príprava Raspberry Pi
qBittorrent||torrenty
Transmission||torrenty
Downie||sťahovanie videí
Parsec||vzdialené hranie a plocha
iMazing||záloha iPhonu
Android File Transfer||súbory z Androidu
Windows App|microsoft remote desktop|vzdialená plocha
Setapp||predplatné appiek
Homebrew||inštalátor programov
`,
}

/** Matching is exact for short names and by prefix for longer ones ("adobe photoshop 2025"). */
const exact = new Map()
const prefixes = []
export const CATALOG = []

for (const [group, block] of Object.entries(RAW)) {
  for (const line of block.split('\n')) {
    if (!line.trim()) continue
    const [name, aliases, use] = line.split('|').map((s) => s.trim())
    const app = { name, group, use }
    CATALOG.push(app)
    for (const key of [name, ...aliases.split(',')].map(normApp).filter(Boolean)) {
      if (!exact.has(key)) exact.set(key, app)
      if (key.length >= 6 || key.includes(' ')) prefixes.push([key, app])
    }
  }
}
prefixes.sort((a, b) => b[0].length - a[0].length)

/** "Adobe Photoshop 2025.app" → "adobe photoshop". */
export function normApp(name) {
  return plain(name)
    .replace(/\.(app|lnk|exe|desktop|appref-ms|url)$/, '')
    .replace(/[®™©]/g, '')
    .replace(/\((beta|preview|x64|x86|64-bit|32-bit|64 bit|user|system|arm64)\)/g, '')
    .replace(/\s+v?\d+(\.\d+)*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Catalog entry for an installed app name, or null when the app is not in the catalog. */
export function matchApp(rawName) {
  const key = normApp(rawName)
  if (!key) return null
  const hit = exact.get(key) ?? exact.get(key.replace(/\s+\d+$/, ''))
  if (hit) return hit
  for (const [prefix, app] of prefixes) if (key.startsWith(`${prefix} `)) return app
  return null
}
