# Jarvis

Osobný AI asistent, ktorý ťa pozná, žije na tvojej ploche a sám sa ti ozýva. Postavený na Claude, beží na tvojom počítači.

![Jarvis HUD](docs/hud.jpg)

## Ako začať

1. **Stiahni** tento priečinok (zelené tlačidlo *Code* → *Download ZIP*) a rozbaľ ho. Najlepšie do domovského priečinka, nie do Stiahnutých.
2. **Otvor ho v Claude.** V aplikácii Claude zvoľ kartu *Code* a vyber priečinok. Alebo v termináli: `cd jarvis-starter` a `claude`.
3. **Napíš `štart`.**

To je všetko. Claude ťa prevedie zvyškom: skontroluje počítač, spozná ťa, zapne ti Jarvisa na ploche a naučí ho pracovať samostatne.
Trvá to asi pol hodiny a nemusíš vedieť programovať.

## Čo Jarvis robí

- **Pozná ťa.** Pri nastavení sa ťa opýta, kto si, na čom robíš a čo chceš. S tvojím súhlasom si prejde aj poznámky a kalendár, ktoré už máš. Všetko si zapíše do priečinka `memory/` ako obyčajné textové súbory, ktoré vieš kedykoľvek otvoriť a upraviť.
- **Žije na ploche.** HUD je obrazovka s 3D svetom tvojej pamäte: ľudia, projekty, ciele, kalendár, denník. Píšeš mu alebo podržíš medzerník a hovoríš. Odpovedá hlasom.
- **Pamätá si.** Povieš „zapamätaj si, že sestra má v máji narodeniny" a o pol roka ti to pripomenie. Večer si sám zapíše, čo sa cez deň dialo.
- **Pracuje sám.** Ráno ti pripraví prehľad dňa. Večer zhrnie deň do denníka. Keď mu povieš „zisti mi…", pracuje na pozadí a ozve sa, keď je hotový.
- **Je tvoj.** Žiadny server, žiadna databáza v cloude, žiadne API kľúče. Beží na tvojom predplatnom Claude a tvoje dáta ostávajú u teba.

## Čo potrebuješ

- Mac alebo počítač s Windows 10/11
- Predplatné Claude (Pro alebo Max)
- [Claude Code](https://claude.com/claude-code) a [Node.js](https://nodejs.org) 20 alebo novší. Ak ich nemáš, `štart` ti ich pomôže nainštalovať.
- Chrome alebo Edge na hlasové ovládanie

## Čo je v priečinku

| | |
|---|---|
| `CLAUDE.md` | Návod pre Clauda: celé nastavenie krok za krokom a ako sa má Jarvis správať. |
| `memory/` | Tvoja pamäť. Formáty sú v [`memory/README.md`](memory/README.md). |
| `hud/` | HUD: server, obrazovka a appka na plochu pre macOS. |
| `routines/` | Zadania rutín: ranný brief, večerné zhrnutie, týždenný prehľad. |
| `scripts/` | Pomocné príkazy: kontrola počítača, štart HUD, rutiny, plánovanie. |
| `docs/` | [Hlas](docs/HLAS.md), [Windows](docs/WINDOWS.md), [plocha Macu](docs/DESKTOP-MAC.md), [samostatnosť](docs/AUTONOMIA.md), [API](docs/API.md). |

## Príkazy, keby si ich chcel spustiť sám

```
node scripts/doctor.mjs             skontroluje, čo počítaču chýba
node scripts/hud.mjs                spustí Jarvisa na obrazovke
node scripts/routine.mjs --list     zoznam rutín
node scripts/schedule.mjs install   zapne rutiny v systéme
node scripts/schedule.mjs remove    vypne ich
```

## Súkromie

Pamäť, nastavenia a záznam rozhovorov sú len vo tvojom počítači a do gitu sa neukladajú. Von idú iba tieto veci:
tvoje správy Claudovi (cez tvoje predplatné, rovnako ako keď píšeš v Claude), text viet na syntézu hlasu (Microsoft Edge TTS),
dopyt na počasie pre tvoje mesto (Open-Meteo) a pri predvolenom rozpoznávaní reči zvuk z mikrofónu do služby prehliadača.
Hlas aj rozpoznávanie sa dajú prepnúť na čisto lokálne, pozri [docs/HLAS.md](docs/HLAS.md).

## Licencia

MIT. Rob si s tým, čo chceš.

---

## English

Jarvis is a personal AI assistant built on Claude Code. It runs on your own computer and your own Claude subscription:

- **Memory**: a local folder of markdown notes about your life (people, projects, goals, daily log), built during a guided interview and kept up to date by Jarvis itself.
- **HUD**: a full-screen desktop interface with a 3D world of that memory, voice in and out, and a chat with Claude.
- **Routines**: scheduled headless Claude Code runs (launchd on macOS, Task Scheduler on Windows), such as a morning brief and an evening summary that writes the day into memory.

### Quick start

1. Download this folder.
2. Open it in Claude (the *Code* tab of the Claude app, or run `claude` in the folder).
3. Type `štart` (or `start`).

Claude walks you through the whole setup: prerequisites, the interview that builds your memory, the desktop HUD and the scheduled routines. The onboarding dialogue and the UI are in Slovak; ask Claude to continue in your language if you prefer.

### Requirements

macOS or Windows 10/11, a paid Claude plan (Pro or Max), Claude Code, Node.js 20+. Chrome or Edge for voice input. Optional: [`uv`](https://docs.astral.sh/uv/) for the neural voice.

### For developers

```
npm install
npm start                 # HUD server on http://localhost:4545
JARVIS_MOCK=1 npm start   # without Claude, mock answers
npm run doctor            # environment check
```

No build step, no database, no API keys. The server is plain Node (`hud/server.mjs`), the front end is vanilla JS with Three.js, the brain is a warm `claude -p` process with three small MCP servers (`hud/server/mcp/`). See [docs/API.md](docs/API.md).

License: MIT.
