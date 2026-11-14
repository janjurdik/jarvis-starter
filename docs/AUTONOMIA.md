# Samostatnosť: ako Jarvis pracuje sám

Chatbot čaká, kým sa niečo opýtaš. Agent pracuje aj vtedy, keď pri počítači nesedíš. Jarvis je agent vďaka trom veciam:

1. **Rutiny:** v daný čas sa spustí sám a spraví zadanú prácu.
2. **Úlohy na pozadí:** v HUD mu povieš „zisti mi…" alebo „priprav…" a on na tom pracuje, kým ty robíš niečo iné.
3. **Pamäť:** všetko, čo zistí a spraví, si zapíše, takže na druhý deň nadviaže.

## Ako funguje rutina

```
systémový plánovač (launchd / Plánovač úloh)
      │  o 07:30
      ▼
node scripts/routine.mjs ranny-brief
      │  spustí Claude Code bez okna, so zadaním z routines/ranny-brief.md
      ▼
Claude prejde memory/, kalendár, konektory, web
      │
      ▼
výsledok → memory/schranka/2026-01-31-ranny-brief.md
         → karta a hlas v HUD (ak je otvorený)
         → systémové oznámenie
```

Rutina je obyčajný textový súbor so zadaním v priečinku `routines/`. Čo v ňom napíšeš, to Jarvis spraví.
Kedy beží, určuje `config/jarvis.json`:

```json
{ "id": "ranny-brief", "title": "Ranný brief", "time": "07:30", "days": "daily", "enabled": true }
```

`days` môže byť `daily`, `weekdays` (pondelok až piatok), `weekend`, alebo zoznam dní `po,st,pi`.

Po každej zmene časov spusti:

```
node scripts/schedule.mjs install
```

## Príkazy

| Príkaz | Čo robí |
|---|---|
| `node scripts/routine.mjs --list` | zoznam rutín |
| `node scripts/routine.mjs ranny-brief` | spustí rutinu hneď |
| `node scripts/routine.mjs ranny-brief --mock` | skúška doručenia bez Claude |
| `node scripts/schedule.mjs install` | zaregistruje rutiny v systéme |
| `node scripts/schedule.mjs status` | čo je zaregistrované |
| `node scripts/schedule.mjs remove` | všetko odregistruje |

## Vlastná rutina

Najjednoduchšie: otvor priečinok v Claude a povedz „pridaj rutinu, ktorá mi každý piatok o piatej pripraví plán na víkend".
Ručne:

1. Vytvor `routines/vikendovy-plan.md` so zadaním (vzor sú existujúce súbory). V zadaní môžeš použiť `{{dnes}}` (dátum)
   a `{{rozhovor}}` (dnešný rozhovor s Jarvisom v HUD).
2. Pridaj riadok do `routines` v `config/jarvis.json`.
3. Vyskúšaj: `node scripts/routine.mjs vikendovy-plan`.
4. Zaregistruj: `node scripts/schedule.mjs install`.

## Koľko smie Jarvis sám

Nastavuje sa v `.env` ako `JARVIS_AGENT_MODE`. Platí pre rutiny aj pre úlohy z HUD.

| Režim | Smie | Nesmie |
|---|---|---|
| `safe` (predvolené) | čítať a písať súbory v priečinku Jarvisa a v pamäti, hľadať na webe, používať tvoje konektory (kalendár, mail…) | spúšťať príkazy, ktoré niečo menia v počítači |
| `full` | všetko, čo Claude Code, vrátane príkazov v termináli | |

V oboch režimoch má Jarvis v zadaní, že ľuďom nič neposiela sám: pripraví návrh, v HUD ohlási, že čaká na súhlas,
a pošle až keď povieš „pošli to". Pri konektoroch, ktoré vedia posielať (mail), si v nastaveniach Claude môžeš
navyše určiť, čo smú robiť bez potvrdenia.

Režim `full` zapni, len keď rozumieš, čo to znamená: Jarvis vtedy môže na počítači spraviť čokoľvek, čo ty v termináli.

## Čo treba vedieť

- Rutiny bežia, aj keď je Claude zatvorený. Počítač musí byť zapnutý a ty prihlásený.
- Keď počítač v čase rutiny spí, rutina prebehne po zobudení.
- Rutiny míňajú tvoje predplatné Claude rovnako ako bežný rozhovor. Ranný brief je asi ako jeden dlhší rozhovor.
- Konektory (kalendár, mail) si pripoj v nastaveniach Claude. Rutiny ich potom vidia tiež.
- Log každej rutiny je v `data/logs/routine-<id>.log`.
- Claude Code má aj vlastné plánované úlohy v aplikácii. Tie bežia, len keď je aplikácia otvorená, preto Jarvis
  používa plánovač systému.
