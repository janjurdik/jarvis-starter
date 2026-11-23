# Jarvis

Osobný AI asistent, ktorý ťa pozná, žije na tvojej ploche, hovorí s tebou a sám sa ti ozýva.
Beží na tvojom počítači a na predplatnom, ktoré už máš: Claude, ChatGPT alebo Gemini cez Antigravity.

![Jarvis HUD](docs/hud.jpg)

**Toto nie je hotový systém. Je to základ, z ktorého si postavíš vlastného Jarvisa.**
Každý dostane to isté jadro: poštu, úlohy, kalendár, pamäť, hlas a budík. Všetko ostatné si povieš.
„Chcem sledovať financie." „Stráž mi termíny v škole." „Napoj sa na moju appku." Jarvis si to pripojí,
doprogramuje a pridá na plochu ako nový orb. Začína s málom a rastie s tebou.

## Ako začať

Netreba vedieť programovať ani poznať terminál. Sú to štyri kroky a trvajú pár minút.

**1. Stiahni Jarvisa.** Hore na tejto stránke klikni na zelené tlačidlo **Code** a potom na **Download ZIP**.
Do počítača sa stiahne súbor `jarvis-starter-main.zip`.

**2. Rozbaľ ho a daj na dobré miesto.** ZIP je zbalený priečinok, tak ako je, sa použiť nedá.
- **Mac:** dvakrát naň klikni. Vedľa neho vznikne priečinok `jarvis-starter-main`. Presuň ho zo Stiahnutých do svojho
  domovského priečinka (vo Finderi *Prejsť → Domov*) a pokojne ho premenuj na `Jarvis`.
- **Windows:** klikni naň pravým tlačidlom, zvoľ *Extrahovať všetko* a ako cieľ daj napríklad `C:\Users\tvoje-meno\Jarvis`.

Dôležité: nenechávaj ho v Stiahnutých, na Ploche ani v Dokumentoch. Mac tam programom na pozadí nedovolí čítať
a budík s rutinami by nefungovali.

**3. Otvor ten priečinok vo svojej AI.** Jarvis nemá vlastnú appku na inštaláciu. Nainštaluje ho AI, ktorú už máš:
- **Claude:** otvor aplikáciu Claude, hore prepni na kartu **Code**, klikni na výber priečinka a vyber priečinok `Jarvis`.
  (V termináli: `cd ~/Jarvis` a `claude`.)
- **ChatGPT:** otvor Codex a vyber v ňom priečinok `Jarvis`. (V termináli: `cd ~/Jarvis` a `codex`.)
- **Gemini:** otvor priečinok `Jarvis` v Antigravity. (V termináli: `cd ~/Jarvis` a `agy`.)

Priečinok sa takto dá mať v Claude otvorený natrvalo: je to obyčajný projekt, do ktorého sa kedykoľvek vrátiš.

**4. Napíš `štart`.** AI sa spýta, kde chceš Jarvisa mať: priamo na pracovnej ploche (na Macu, odporúčame), ako
samostatnú appku s vlastnou ikonou, alebo len ako stránku v prehliadači. Potom pripraví počítač a o pár minút sa Jarvis objaví. **Odvtedy už hovoríš s ním.** Predstaví sa, poobzerá sa
po počítači, aby ťa spoznal, spýta sa na to, čo nenájde, a spolu dotiahnete zvyšok.

### Čo sa po štarte zmení v počítači

Záleží na tom, čo si vyberieš:

- **Plocha (Mac).** Jarvis je namiesto tapety, pod všetkými oknami. Skratka `Control + Option + J` ho vytiahne navrch,
  `Esc` ho vráti späť. V lište hore pribudne malý krúžok, menu Jarvisa: ukázať ho, Nastavenia, skryť alebo zobraziť
  ikony na ploche, spúšťať po zapnutí počítača, vypnúť Jarvisa a vrátiť pôvodnú plochu.
- **Appka (Mac aj Windows).** Jarvis je samostatné okno ako každý iný program. Otvoríš ho ikonou Jarvis: na Macu
  v Launchpade, na Windows na pracovnej ploche a v ponuke Štart.
- **Stránka v prehliadači.** Jarvis je karta na adrese `http://localhost:4545`. Hovoriť a zvoniť vie, len keď ju máš otvorenú.
- **Nič sa nemaže.** Skryté ikony ostávajú v priečinku Plocha a tou istou voľbou sa vrátia. Jarvisa vypneš jedným klikom.

### Aktualizácie

Nové verzie si Jarvis všimne sám a opýta sa, či ich má nainštalovať. Stačí povedať „aktualizuj sa". Funguje to
rovnako, či si priečinok stiahol ako ZIP, alebo cez git: Jarvis si novú verziu stiahne, overí jej podpis a spojí ju
s tvojimi úpravami. Nič nesťahuješ znova a o pamäť ani nastavenia neprídeš ([docs/AKTUALIZACIE.md](docs/AKTUALIZACIE.md)).

## Čo má každý Jarvis

- **Hlas.** Podržíš medzerník a hovoríš, odpovedá nahlas. Reč rozpoznáva Whisper priamo v tvojom počítači (vyberie sa podľa jeho výkonu). Hlas, meno aj to, či je to on alebo ona, si nastavíš jednou vetou.
- **Ruky.** Zapneš kameru a ovládaš ho rukami: kurzor ide za dlaňou, štipnutím klikneš. Obraz neopúšťa počítač ([docs/RUKY.md](docs/RUKY.md)).
- **Je živý.** Ozve sa sám na Nový rok, Vianoce a tvoje narodeniny, dá vedieť, keď dochádza batéria, a keď treba, zavolá ti na mobil.
- **Budík.** „Zobuď ma o pol siedmej." Ráno zazvoní skladbou (môžeš mu dať vlastnú) a povie ti, ako si spal, aké je počasie, čo ťa čaká a čo spravil, kým si spal.
- **Pamäť.** Obyčajné textové súbory v priečinku `memory/`: kto si, tvoji ľudia, projekty, ciele, denník. Zapisuje si sám, ty ich vieš kedykoľvek otvoriť.
- **Pošta, kalendár, úlohy.** Triedi poštu a ozve sa len pri dôležitom, upozorní pred stretnutím, stráži termíny a pripomienky.
- **3D svet na ploche.** Každá väčšia vec v tvojom živote je orb. Pribúdajú a miznú podľa toho, čo naozaj používaš.
- **Pracuje sám.** „Cez noc mi priprav…" a ráno to máš. Vidíš, čo práve robí, a vieš ho zastaviť. Čo má ísť von k ľuďom, vždy čaká na tvoje áno.
- **Šetrí tvoje predplatné.** Model si pre každú úlohu vyberie sám a potichu: na pozretie pošty rýchly, na tvorbu najsilnejší. Ktorý práve beží, vidno malým písmom pri úlohe.
- **Odporúča sám.** Podľa toho, čo máš v počítači a v pošte, navrhne, čo sa oplatí pridať ďalej. Klikneš a spraví to.

## Čo si vieš pridať

Čokoľvek, čo mu povieš. Pár príkladov toho, čo si ľudia stavajú:

- vlastný orb s prehľadom (financie, tréning, návyky, čítanie, škola, objednávky),
- stráž, ktorá sa ozve, len keď sa niečo stane,
- napojenie na appku, ktorú používaš (konektor, API alebo kópia dát: formát si zistí sám),
- hodinky Garmin naživo: spánok, tep, tréningy,
- video z odkazu: otvorí ho na ploche, spraví prepis a skočí tam, kde sa hovorí o tom, čo hľadáš,
- hovor na mobil, keď niečo nepočká,
- denník z toho, čo si naozaj robil na počítači.

Na úpravy, pri ktorých chceš vidieť každý krok, otvor tento priečinok v Claude Code, Codexe alebo Antigravity a povedz, čo chceš zmeniť.

## Čo potrebuješ

- Mac alebo počítač s Windows 10/11
- Predplatné Claude (Pro alebo Max) s [Claude Code](https://claude.com/claude-code), alebo ChatGPT (Plus alebo Pro) s Codexom, alebo účet Google s [Antigravity](https://antigravity.google)
- [Node.js](https://nodejs.org) 20 alebo novší. Ak ho nemáš, `štart` ti ho pomôže nainštalovať.
- Na Macu pre Jarvisa na ploche nástroje pre vývojárov od Apple (zadarmo). Keď chýbajú, `štart` povie, ako ich pridať jedným príkazom, a Jarvis zatiaľ beží v okne.

## Čo je v priečinku

| | |
|---|---|
| `AGENTS.md` | Návod pre AI: ako Jarvisa spustiť, ako sa správa a ako ho rozširovať. `CLAUDE.md` naň odkazuje. |
| `memory/` | Tvoja pamäť. Formáty sú v [`memory/README.md`](memory/README.md). |
| `hud/` | Obrazovka, server a appka na plochu pre macOS. |
| `routines/` | Zadania rutín: budík, ranný brief, večerný denník, stráž pošty. |
| `scripts/` | Príkazy: štart, orby, odporúčania, budík, video, import dát, aktualizácie. |
| `docs/` | [Orby](docs/ORBY.md), [hlas](docs/HLAS.md), [video](docs/VIDEO.md), [aktivita](docs/AKTIVITA.md), [Garmin](docs/GARMIN.md), [ovládanie počítača](docs/OVLADANIE.md), [iné modely](docs/MODELY.md), [samostatnosť](docs/AUTONOMIA.md), [hovory](docs/HOVORY.md), [aktualizácie](docs/AKTUALIZACIE.md), [Windows](docs/WINDOWS.md), [plocha Macu](docs/DESKTOP-MAC.md), [API](docs/API.md). |

## Súkromie a bezpečnosť

- Pamäť, nastavenia, záznam rozhovorov a záznam aktivity sú súbory v tvojom počítači. Do gitu sa neukladajú a Jarvis nemá žiadny vlastný server.
- To, s čím Jarvis práve pracuje (tvoja správa, kus pamäte, obsah súboru), ide na spracovanie do AI, na ktorej beží, cez tvoje predplatné. Rovnako ako keď jej píšeš sám.
- Von idú ešte: text viet na syntézu hlasu (Microsoft Edge), dopyt na počasie pre tvoje mesto (Open-Meteo), kontrola novej verzie (GitHub) a pri videu stiahnutie zo stránky, ktorú si mu poslal. Rozpoznávanie reči beží v tvojom počítači.
- Jarvis počúva len na tvojom počítači. Z iného zariadenia ani z cudzej webovej stránky sa k nemu nedá dostať.
- Jarvis smie v počítači všetko, čo ty. Preto ho nikdy neotváraj do internetu a ber ho ako asistenta, ktorému dôveruješ.
- Aktualizácie sú podpísané autorom. Nepodpísanú alebo pozmenenú verziu Jarvis nenainštaluje.

Našiel si bezpečnostnú chybu? Napíš ju prosím súkromne cez GitHub (Security → Report a vulnerability), nie do verejného issue.

## Licencia

MIT. Rob si s tým, čo chceš.

---

## English

Jarvis is a personal AI assistant that lives on your desktop: a 3D HUD, a local markdown memory, voice in and out,
an alarm clock, scheduled routines and background work. It runs on your own computer and on the subscription you
already have (Claude Code, Codex or Google Antigravity), with no API keys and no server.

It is a base, not a finished product. Everyone gets the same core (mail, tasks, calendar, memory, voice, alarm) and
tells Jarvis what else they need. He connects it, writes the code and adds it to the desktop as a new orb.

Quick start: download the folder, open it in Claude Code, Codex or Antigravity and type `štart` (or `start`). The assistant prepares
the computer and puts Jarvis on the desktop; from there Jarvis leads the setup himself, by voice. The dialogue and the
UI are in Slovak; ask it to continue in your language if you prefer.

For developers: `npm install`, `npm start` (HUD on http://localhost:4545), `JARVIS_MOCK=1 npm start` without an AI,
`npm test`. No build step and no database. The server is plain Node (`hud/server.mjs`), the front end is vanilla JS
with Three.js, the brain is the user's own coding agent with three small MCP servers (`hud/server/mcp/`).
See [docs/API.md](docs/API.md) and [docs/MODELY.md](docs/MODELY.md).

License: MIT.
