# Jarvis na Macu: jedna appka Jarvis

Na Macu je Jarvis jedna appka, `~/Applications/Jarvis.app`. Vie žiť dvoma spôsobmi a prechádza medzi nimi sama:

- **Na ploche** (`"surface": "desktop"`): HUD ako živá tapeta, nad obrázkom plochy, pod všetkými oknami, na všetkých plochách (Spaces). V lište hore má krúžok, v Docku ju nevidno.
- **Vo vlastnom okne** (`"surface": "app"`): obyčajné okno ako každý iný program. Má ikonu v Docku, je v ⌘Tab, zelené tlačidlo alebo `⌃⌘F` ho dá na celú obrazovku a okno si pamätá svoju veľkosť a miesto.

Tretia možnosť, **stránka v prehliadači** (`"surface": "browser"`), appku nepotrebuje. Zdroj appky je jeden súbor `hud/desktop/main.swift` bez závislostí.

## Inštalácia

Pri `štarte` sa appka postaví sama, keď si zvolíš plochu alebo appku (`--surface desktop` alebo `--surface app`). Potrebuje nástroje
Xcode (stačí príkazový riadok): `xcode-select --install`. Ručne:

```sh
sh hud/desktop/build.sh --open
```

Appka sa postaví, skopíruje do `~/Applications/Jarvis.app` a spustí. HUD server si zapne sama, keď nebeží.
`node scripts/hud.mjs` ju postaví znova sám, keď sa po aktualizácii zmení jej kód, keď priečinok Jarvisa presunieš
alebo keď sa zmení port či cesta k Node (všetko to je zapísané v appke, pole `JarvisSource` a ďalšie v `Info.plist`).

### Staršie verzie

Do verzie 1.9.7 boli v Aplikáciách dve appky: `Jarvis HUD.app` (plocha) a `Jarvis.app` (malá ikona, ktorá otvárala okno
v Chrome). Nová appka obe nahradí (`hud/desktop/install.sh`): staré idú do koša, nič sa nemaže. Nastavenia plochy
(skryté ikony, spúšťanie po prihlásení) si nová appka prevezme. Appku s iným identifikátorom (vlastná zostava, iný program
s rovnakým menom) inštalácia nechá tak a nič neprepíše.

Okno v Chrome z 1.9.7 bežalo ako druhý Chrome s vlastným prázdnym profilom (`data/browser-profile`). macOS potom posielal
kliknutia na ikonu Chrome a `⌘N` tomuto druhému Chromu a bežný Chrome sa otváral neprihlásený. Server toto okno zavrie
pri prvom štarte novej verzie. Priečinok `data/browser-profile` na Macu už netreba, môžeš ho zmazať.

## Ovládanie na ploche

| Čo | Ako |
|---|---|
| Písať Jarvisovi | klik na plochu, Enter alebo / |
| Hovoriť | podrž medzerník (keď je HUD aktívny) |
| Vyvolať Jarvisa nad všetky okná | ⌃⌥J: podržať = hovoriť, ťuknúť = písať |
| Vrátiť HUD na plochu | Esc alebo znova ⌃⌥J |
| Ponuka | ikona Jarvisa v lište hore |

V ponuke (malý krúžok v lište hore) nájdeš: Ukázať Jarvisa nad oknami, Nastavenia Jarvisa, Zobrazovať ikony na ploche (zap/vyp),
Spúšťať po zapnutí počítača (zap/vyp), Načítať Jarvisa znova, Otvoriť ako stránku v prehliadači, Vypnúť Jarvisa a vrátiť pôvodnú plochu.
Tie isté dva prepínače sú aj v Nastaveniach Jarvisa v časti Plocha.

## Vlastné okno

| Čo | Ako |
|---|---|
| Celá obrazovka | zelené tlačidlo okna, `⌃⌘F` alebo kláves F |
| Zavrieť okno | červené tlačidlo alebo `⌘W`: okno zmizne, Jarvis beží ďalej, hovorí, zvoní a pripomína |
| Otvoriť znova | ikona Jarvis v Docku, v Launchpade alebo v priečinku Aplikácie |
| Vytiahnuť dopredu | ⌃⌥J: podržať = hovoriť, ťuknúť = písať; ťuknutie, keď je okno vpredu, ho schová |
| Nastavenia | `⌘,` |
| Ukončiť appku | `⌘Q` (HUD server beží ďalej, pripomienky a rutiny tiež) |

## Prepínanie

V Nastaveniach Jarvisa, časť Plocha, sa volí, kde Jarvis býva (`surface` v `config/jarvis.json`). Staršia hodnota `web`
znamená vlastné okno. Zmena platí hneď a nikdy neostanú dve okná:

- Appka sa každé 3 sekundy pýta servera (`GET /api/health`, pole `surface`), kde Jarvis býva, a sama sa presunie
  z plochy do okna alebo naopak. O presune sa dozvie aj od stránky (udalosť `surface`). Kontrola servera je tu preto,
  lebo plochu zakrytú oknom na celú obrazovku systém uspí a stránka by to nepočula.
- Pri presune z plochy vráti ikony na ploche, ak ich skryla.
- Pri voľbe stránka v prehliadači vráti plochu, vypne si spúšťanie po prihlásení a skončí. Keď ju potom niekto otvorí
  ikonou, otvorí namiesto seba stránku v prehliadači.

## Bez nástrojov pre vývojárov

Kým Mac appku postaviť nevie, beží Jarvis vo vlastnom okne prehliadača bez kariet, v Chrome, Edge, Brave, Chromiu
alebo Vivaldi, vždy v bežnom profile používateľa, nikdy ako druhý prehliadač s vlastným profilom. Keď prehliadač nebeží,
spustí ho systém (`open -a`, vtedy sa o kameru a mikrofón pýta prehliadač sám, nie Node), keď beží, okno mu odovzdá
jeho vlastný program s `--app`. V Aplikáciách je vtedy malý `Jarvis.app` (`scripts/launcher.mjs`), ktorý toto okno
otvorí alebo vytiahne dopredu. Prvé postavenie skutočnej appky ho nahradí.

Bez Chromu, Edge aj Brave sa Jarvis otvorí ako karta v predvolenom prehliadači (Safari, Firefox) a príkaz to povie.

## Poznámky

- **Ikony na ploche.** Aby kliky išli priamo do HUD, dajú sa skryť ikony plochy (appka prepne nastavenie Findera).
  Súbory ostávajú v priečinku Plocha, len ich nevidno na tapete. Appka to nikdy nespraví sama, len keď to zapneš v ponuke.
  Vrátenie bez appky: `defaults write com.apple.finder CreateDesktop -bool true && killall Finder`
- **Hlas.** Appka používa jadro Safari, kde rozpoznávanie reči z prehliadača nemusí fungovať. Jarvis preto počúva
  lokálnym Whisperom, ktorý sa pripraví sám pri prvom spustení (`docs/HLAS.md`). Ak medzerník ohlási, že okno nevie
  rozpoznávať reč, Whisper sa nepripravil: `node scripts/voice.mjs plan` povie prečo. Dovtedy Jarvis v appke hovorí a ty píšeš.
- **Mikrofón a kamera.** Pri prvom použití sa macOS spýta na povolenie, na ploche aj v okne rovnako. Po každom novom builde
  sa môže spýtať znova (appka je podpísaná len lokálne, s vlastnou identitou v `JARVIS_SIGN_IDENTITY` si povolenie pamätá).
  Mikrofón otvára appka sama, obyčajným systémovým vstupom bez spracovania hlasu
  (`NativeMic` v `main.swift`, na stránke `hud/public/js/native-mic.js`), nie jadro Safari. Zachytávanie cez jadro
  Safari pri každom otvorení mikrofónu na chvíľu reštartuje zvukové zariadenia celého počítača a hovor v inej appke
  (Discord) pri tom príde o mikrofón. Natívny vstup sa dotkne len mikrofónu a vlna pri hovorení beží od prvej chvíle.
  Kameru na ovládanie rukami dostane len stránka Jarvisa a až po kliknutí na jej čip.

## Ladenie

- Log appky: `~/Library/Logs/jarvis-app.log`, log servera, keď ho spustila appka: `~/Library/Logs/jarvis-server.log`
- Obnovenie stránky: `kill -USR2 $(pgrep -f Jarvis.app/Contents/MacOS/Jarvis)`
- Len postaviť, bez inštalácie: `sh hud/desktop/build.sh --no-install`. Do iného priečinka: `JARVIS_APP_DIR=<priečinok>`.
- Odinštalovanie: na ploche v ponuke „Vypnúť Jarvisa a vrátiť pôvodnú plochu", v okne `⌘Q`, potom presuň `~/Applications/Jarvis.app` do koša.
