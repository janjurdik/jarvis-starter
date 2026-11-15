# Samostatnosť: ako Jarvis pracuje sám

Chatbot čaká, kým sa niečo opýtaš. Agent pracuje aj vtedy, keď pri počítači nesedíš. Jarvis je agent vďaka piatim veciam:

1. **Pulz:** každých päť minút malý program bez AI skontroluje pripomienky, kalendár a termíny. Keď niečo nastáva, Jarvis to povie.
2. **Rutiny:** v daný čas sa spustí sám a spraví zadanú prácu (ranný brief, večerné zhrnutie).
3. **Stráže:** rutiny, ktoré bežia každú hodinu a ozvú sa len vtedy, keď je čo povedať (stráž pošty).
4. **Úlohy na pozadí:** v HUD mu povieš „zisti mi…" alebo „priprav…" a on na tom pracuje, kým ty robíš niečo iné.
5. **Pamäť:** všetko, čo zistí a spraví, si zapíše, takže na druhý deň nadviaže.

## Jeden deň bez teba

| Kedy | Čo sa stane | Čo to spustilo | Stojí to predplatné? |
|---|---|---|---|
| 07:30 | Prejde kalendár, úlohy, ciele, poštu a počasie a povie ti brief | rutina `ranny-brief` | áno, ako jeden dlhší rozhovor |
| 08:45 | „O pätnásť minút máte poradu." | pulz | nie |
| 09:00 až 21:00, každú hodinu | Pozrie poštu. Ozve sa, len keď píše niekto dôležitý | stráž `straz-posty` | áno, málo (malý model) |
| 15:00 | „Pripomínam: zavolať mame." Pri súrnej pripomienke ti zavolá na mobil | pulz, `memory/pripomienky.md` | nie (hovor stojí pár centov) |
| 17:00 | „Dnes máte ešte termín: poslať faktúru." | pulz, `memory/ulohy.md` | nie |
| kedykoľvek | Prišiel export, ktorý si pretiahol do okna: prečíta rozhovory a doplní ľudí | úloha na pozadí | áno |
| 21:30 | Zapíše deň do denníka, odškrtne hotové, uloží nové fakty | rutina `vecerne-zhrnutie` | áno |
| 22:30 až 07:00 | Tiché hodiny: nič nehovorí nahlas, len zapisuje | `quiet` v konfigurácii | |
| raz za 12 hodín | Pozrie, či vyšla nová verzia Jarvisa, a spýta sa, či ju má nainštalovať | HUD | nie |

Všetko, čo Jarvis povie, ide do HUD na ploche a ako oznámenie systému. Čo nepočká, s tým ti zavolá na mobil (`docs/HOVORY.md`).

## Ako funguje pulz

```
systémový plánovač, každých 5 minút
      ▼
node scripts/pulse.mjs        (žiadna AI, trvá zlomok sekundy)
      │  pripomienky.md: nastal čas?
      │  kalendár: začína niečo do 15 minút?
      │  ulohy.md: je po 17:00 a termín je dnes?
      ▼
nič → skončí          niečo → hlas v HUD + oznámenie, súrne (!) aj hovor na mobil
```

Nastavenie je v `config/jarvis.json`:

```json
"quiet": "22:30-07:00",
"pulse": { "enabled": true, "every": 5, "eventLead": 15, "dueAt": "17:00" }
```

Skúška: `node scripts/pulse.mjs --dry-run` vypíše, čo by teraz povedal.

## Stráže

Stráž je rutina s `every` (minúty) namiesto času:

```json
{ "id": "straz-posty", "title": "Stráž pošty", "every": 60, "between": "08:00-21:00", "model": "haiku", "enabled": true }
```

V zadaní má napísané, kedy sa má ozvať. Keď nie je čo povedať, odpovie jediným slovom `NIČ` a nič sa neukáže.
Vlastnú stráž si vypýtaš vetou: „každé dve hodiny pozri, či nepribudlo niečo v školskom systéme, a ozvi sa len keď áno".

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
| `node scripts/pulse.mjs --dry-run` | čo by pulz teraz ohlásil |
| `node scripts/schedule.mjs install` | zaregistruje rutiny, stráže a pulz v systéme |
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
| `safe` (predvolené) | čítať a písať súbory v priečinku Jarvisa a v pamäti, hľadať na webe, používať tvoje konektory (kalendár, mail…), spúšťať vlastné skripty Jarvisa (import, hľadanie v správach, aktualizácia) | spúšťať iné príkazy v počítači |
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
