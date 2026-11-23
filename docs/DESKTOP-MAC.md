# Jarvis ako plocha Macu

Appka „Jarvis HUD" ukazuje HUD ako živú tapetu: nad obrázkom plochy, pod všetkými oknami, na všetkých plochách (Spaces).
Zdroj je jeden súbor `hud/desktop/main.swift` bez závislostí.

## Inštalácia

Pri `štarte` sa appka postaví sama, keď si zvolíš, že chceš Jarvisa na ploche (`--surface desktop`, na Macu predvolené).
Ručne: potrebuješ nástroje Xcode (stačí príkazový riadok): `xcode-select --install`. Potom:

```sh
sh hud/desktop/build.sh --open
```

Appka sa postaví, skopíruje do `~/Applications/Jarvis HUD.app` a spustí. HUD server si zapne sama.
Keď priečinok Jarvisa presunieš alebo zmeníš verziu Node, spusti build znova (cesty sú zapísané v appke).

## Ovládanie

| Čo | Ako |
|---|---|
| Písať Jarvisovi | klik na plochu, Enter alebo / |
| Hovoriť | podrž medzerník (keď je HUD aktívny) |
| Vyvolať Jarvisa nad všetky okná | ⌃⌥J: podržať = hovoriť, ťuknúť = písať |
| Vrátiť HUD na plochu | Esc alebo znova ⌃⌥J |
| Ponuka | ikona Jarvisa v lište hore |

V ponuke (malý krúžok v lište hore) nájdeš: Ukázať Jarvisa nad oknami, Nastavenia Jarvisa, Zobrazovať ikony na ploche (zap/vyp),
Spúšťať po zapnutí počítača (zap/vyp), Načítať Jarvisa znova, Otvoriť ako stránku v prehliadači, Vypnúť Jarvisa a vrátiť pôvodnú plochu.
Tie isté dva prepínače sú aj v Nastaveniach Jarvisa v časti Plocha. Tam sa dá zvoliť aj to, kde má Jarvis bývať
(`surface` v `config/jarvis.json`): na ploche (`desktop`), ako samostatná appka vo vlastnom okne s ikonou Jarvis
v Launchpade (`app`), alebo ako stránka v prehliadači (`browser`). Staršia hodnota `web` znamená okno ako doteraz.
Zmena v Nastaveniach platí hneď: nové miesto sa otvorí a staré sa zavrie. Appka na ploche sa o sťahovaní dozvie od stránky
aj z vlastnej kontroly servera každé 3 sekundy (plochu zakrytú oknom na celú obrazovku systém uspí a stránka by to nepočula),
vráti ikony plochy, vypne si spúšťanie po prihlásení a skončí.

Ikonu samostatnej appky (`~/Applications/Jarvis.app`) vytvára `node scripts/launcher.mjs install` a `scripts/hud.mjs`
ju pri voľbe `app` obnoví pri každom štarte. Nepotrebuje nástroje Xcode: je to malý balík, ktorý spustí okno Jarvisa
v Chrome, Edge, Brave alebo Arcu. Okno sa spúšťa cez systém (`open -n -a`), nie priamo z Node: inak by macOS žiadosť
o kameru pripísal Node, ktorý ju dostať nemôže, a ovládanie rukami by ostalo visieť na zapínaní kamery.

- **Ikony na ploche.** Aby kliky išli priamo do HUD, dajú sa skryť ikony plochy (appka prepne nastavenie Findera).
  Súbory ostávajú v priečinku Plocha, len ich nevidno na tapete. Appka to nikdy nespraví sama, len keď to zapneš v ponuke.
  Vrátenie bez appky: `defaults write com.apple.finder CreateDesktop -bool true && killall Finder`
- **Hlas.** Appka používa jadro Safari, kde rozpoznávanie reči z prehliadača nemusí fungovať. Jarvis preto počúva
  lokálnym Whisperom, ktorý sa pripraví sám pri prvom spustení (`docs/HLAS.md`). Ak medzerník ohlási, že okno nevie
  rozpoznávať reč, Whisper sa nepripravil: `node scripts/voice.mjs plan` povie prečo. Dovtedy Jarvis v appke hovorí a ty píšeš.
- **Mikrofón.** Pri prvom použití sa macOS spýta na povolenie. Po každom novom builde sa môže spýtať znova
  (appka je podpísaná len lokálne). Mikrofón otvára appka sama, obyčajným systémovým vstupom bez spracovania hlasu
  (`NativeMic` v `main.swift`, na stránke `hud/public/js/native-mic.js`), nie jadro Safari. Zachytávanie cez jadro
  Safari pri každom otvorení mikrofónu na chvíľu reštartuje zvukové zariadenia celého počítača a hovor v inej appke
  (Discord) pri tom príde o mikrofón. Natívny vstup sa dotkne len mikrofónu a vlna pri hovorení beží od prvej chvíle.
  Staršia appka (pred 1.9.1) túto cestu nemá a stránka v nej počúva po starom, kým appku nepostavíš znova.

## Ladenie

- Log appky: `~/Library/Logs/jarvis-hud-desktop.log`, log servera: `~/Library/Logs/jarvis-hud-server.log`
- Obnovenie stránky: `kill -USR2 $(pgrep -x JarvisHUD)`
- Odinštalovanie: v ponuke „Ukončiť a vrátiť plochu", potom zmaž `~/Applications/Jarvis HUD.app`.
