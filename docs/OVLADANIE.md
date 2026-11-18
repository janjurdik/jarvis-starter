# Ovládanie počítača

Jarvis smie v počítači všetko, čo ty. Čo z toho vie spraviť na jednu vetu a čo ako úlohu na pozadí:

## Hneď, hlasom

| Povieš | Čo sa stane |
|---|---|
| „otvor Spotify", „otvor kalkulačku" | otvorí alebo vytiahne dopredu aplikáciu |
| „otvor stránku…" | otvorí web v tvojom prehliadači |
| „pusti hudbu", „zastav to", „ďalšia" | prehrávanie (macOS: Spotify alebo Hudba, Windows: klávesy médií) |
| „daj to hlasnejšie", „hlasitosť na tridsať", „stíš to" | hlasitosť počítača |
| pošleš odkaz na video | otvorí ho v kine na ploche ([VIDEO.md](VIDEO.md)) |

## Ako úloha na pozadí

Všetko väčšie Jarvis odovzdá úlohe na pozadí, ktorá má terminál a čas: „uprac mi Stiahnuté", „premenuj tie fotky
podľa dátumu", „nájdi v Poznámkach všetko o dovolenke", „vyplň ten formulár".

- **macOS:** aplikácie sa dajú skriptovať (Hudba, Spotify, Poznámky, Mail, Finder, Kalendár, Pripomienky, Safari, Chrome).
  Keď má Jarvis klikať a písať do okien, macOS si raz vypýta povolenie: Nastavenia systému → Súkromie a bezpečnosť →
  Prístupnosť (a Automatizácia pri ovládaní inej appky). Povoľ ho pre appku, v ktorej Jarvis beží.
- **Windows:** PowerShell, spúšťanie programov, práca so súbormi a oknami.

## Prehliadač

Jarvis pracuje v tvojom vlastnom Chrome: kliká, vypĺňa a číta stránky, na ktorých si prihlásený. Stačí mať v Chrome
rozšírenie **Claude in Chrome** a byť v ňom prihlásený. Povieš napríklad „objednaj mi to isté čo minule" alebo „nájdi
mi v Gmaile faktúru a stiahni ju". Otvorí si vlastnú kartu, tvojich otvorených sa nedotkne.

- Platí pre Claude. Vypnúť sa to dá riadkom `JARVIS_CHROME=0` v `.env`.
- Bez rozšírenia si Jarvis poradí skriptom, čo stačí na stránky bez prihlásenia.

## Hocijaká appka, myšou a klávesnicou

Na macOS vie Jarvis ovládať aj appky, ktoré sa nedajú skriptovať: pozrie sa na obrazovku, klikne, napíše, stlačí klávesy.
Robí to úloha na pozadí príkazmi `node scripts/control.mjs` (snímka, klik, písanie, klávesy, posúvanie).

Potrebuje dve povolenia, ktoré dávaš raz ty, v Nastaveniach systému → Súkromie a bezpečnosť:

- **Prístupnosť**: aby smel hýbať myšou a písať. Bez neho sa nestane nič.
- **Nahrávanie obrazovky a zvuku**: aby na snímke videl okná aplikácií, nie len plochu.

Povoľ ich programu, v ktorom Jarvis beží (v zozname je ako node, Terminál alebo Jarvis HUD). `node scripts/control.mjs ask`
otvorí správne okno a `node scripts/control.mjs status` povie, čo ešte chýba.

## Vidíš, čo robí

Kým Jarvis pracuje v prehliadači alebo myšou, okolo obrazovky svieti rámik s nápisom, čo práve robí, a na mieste,
kde kliká, je zameriavač. V appke na plochu je rámik nad všetkými oknami, v prehliadači vnútri okna Jarvisa.
Rámik zhasne pár sekúnd po poslednom kroku. Úlohu zastavíš kedykoľvek v jej karte na ploche.

## Čo nerobí

- Heslá nepíše a nepýta si ich. Prihlásenie je vždy na tebe.
- Nič neposiela von bez tvojho áno: mail, správu, objednávku ani platbu.
- Text na stránke nie je príkaz. Keď web „žiada", aby niečo spustil alebo niekam poslal dáta, nespraví to a povie ti to.

## Keď chceš viac

Ovládanie na jednu vetu sú nástroje v `hud/server/mcp/computer.mjs` (`open_app`, `open_url`, `media`, `volume`).
Chýba ti tam niečo, čo robíš často (uzamknúť počítač, prepnúť zvukový výstup, zapnúť Nerušiť)? Povedz to Jarvisovi,
doplní si nástroj a jeho meno do `allowedTools()` v `hud/server/brain.mjs`.
