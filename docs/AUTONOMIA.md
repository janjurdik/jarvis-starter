# Samostatnosť: ako Jarvis pracuje sám

Chatbot čaká, kým sa niečo opýtaš. Agent pracuje aj vtedy, keď pri počítači nesedíš. Jarvis je agent vďaka šiestim veciam:

0. **Budík:** ráno ťa zobudí a povie ti, ako si spal, čo ťa dnes čaká a čo spravil, kým si spal.
1. **Pulz:** každých päť minút malý program bez AI skontroluje pripomienky, kalendár a termíny. Keď niečo nastáva, Jarvis to povie.
2. **Rutiny:** v daný čas sa spustí sám a spraví zadanú prácu (ranný brief, večerné zhrnutie).
3. **Stráže:** rutiny, ktoré bežia každú hodinu a ozvú sa len vtedy, keď je čo povedať (stráž pošty).
4. **Úlohy na pozadí:** v HUD mu povieš „zisti mi…" alebo „priprav…" a on na tom pracuje, kým ty robíš niečo iné.
5. **Pamäť:** všetko, čo zistí a spraví, si zapíše, takže na druhý deň nadviaže.

## Jeden deň bez teba

| Kedy | Čo sa stane | Čo to spustilo | Stojí to predplatné? |
|---|---|---|---|
| 23:00 | „Cez noc mi priprav ponuku pre Novákovcov." Pustí sa do toho hneď, v noci nič nehovorí | úloha na pozadí | áno |
| 06:10 | Pripraví ranné budenie: spánok, počasie, kalendár, termíny, čo spravil cez noc | rutina `budik` | áno, ako jeden rozhovor |
| 06:30 | Zazvoní a povie ti to nahlas cez reproduktory, aj keď je HUD zatvorený | budík | nie |
| 07:30 | Prejde kalendár, úlohy, ciele, poštu a počasie a povie ti brief (keď nemáš budík) | rutina `ranny-brief` | áno, ako jeden dlhší rozhovor |
| 08:45 | „O pätnásť minút máte poradu." | pulz | nie |
| 09:00 až 21:00, každú hodinu | Pozrie poštu. Ozve sa, len keď píše niekto dôležitý | stráž `straz-posty` | áno, málo (malý model) |
| 15:00 | „Pripomínam: zavolať mame." Pri súrnej pripomienke ti zavolá na mobil | pulz, `memory/pripomienky.md` | nie (hovor stojí pár centov) |
| 17:00 | „Dnes máte ešte termín: poslať faktúru." | pulz, `memory/ulohy.md` | nie |
| kedykoľvek | Prišiel export, ktorý si pretiahol do okna: prečíta rozhovory a doplní ľudí | úloha na pozadí | áno |
| 21:30 | Zapíše deň do denníka, odškrtne hotové, uloží nové fakty | rutina `vecerne-zhrnutie` | áno |
| 22:30 až 07:00 | Tiché hodiny: nič nehovorí nahlas, len zapisuje | `quiet` v konfigurácii | |
| raz za 12 hodín | Pozrie, či vyšla nová verzia Jarvisa, a spýta sa, či ju má nainštalovať | HUD | nie |

Všetko, čo Jarvis povie, ide do HUD na ploche a ako oznámenie systému. Keď okno HUD nie je otvorené, povie to cez
reproduktory počítača (vypneš to v `.env`: `JARVIS_LOCAL_VOICE=0`). Čo nepočká, s tým ti zavolá na mobil (`docs/HOVORY.md`).

## Budík

Povieš „zobuď ma o 6:30 cez týždeň" (v HUD aj v Claude) a ráno sa stane toto:

1. Pár minút pred budíkom (predvolene 20) Claude bez okna pripraví ranné budenie podľa `routines/budik.md`:
   spánok, ak ho vie, počasie, čo ťa dnes čaká, termíny, čo spravil cez noc a čo čaká na tvoj súhlas.
2. V čase budíka zaznie zvonenie a Jarvis ti to povie nahlas cez reproduktory počítača. Nezáleží na tom, či je HUD otvorený.
   V HUD sa ukáže karta a celý text je v `memory/schranka/`.
3. Keď Claude brief nestihne (bez internetu, bez predplatného), Jarvis povie kratší brief priamo z pamäte.
4. S `--call` ti budík aj zavolá na mobil (`docs/HOVORY.md`).
5. Tiché hodiny sa po budíku pre ten deň končia: pripomienky ráno už znova hovoria.

```json
"alarm": { "time": "06:30", "days": "weekdays", "enabled": true, "call": false, "prepare": 20 }
```

| Príkaz | Čo robí |
|---|---|
| `node scripts/alarm.mjs` | ako je budík nastavený |
| `node scripts/alarm.mjs set 06:30 --days weekdays` | nastaví budík a zapíše ho do systému (`daily`, `weekdays`, `weekend`, `po,st,pi`) |
| `node scripts/alarm.mjs off` / `on` | vypne alebo zapne |
| `node scripts/alarm.mjs test` | zazvoní hneď, s briefom od Clauda (asi minúta) |
| `node scripts/alarm.mjs test --quick` | zazvoní hneď s krátkym briefom z pamäte |

Čo budík potrebuje:

- **Zapnutý počítač.** Mac: nechaj MacBook otvorený a v zásuvke. V hodinách pred budíkom ho Jarvis nenechá uspať
  (displej môže zhasnúť), zatvorené veko ho ale uspí a budík zazvoní až po otvorení. Windows: v zásuvke, zapnutý alebo
  v režime spánku, budík ho zobudí (ak to plán napájania povoľuje, na sieti je to predvolené). Vypnutý počítač nezazvoní.
- **Zvuk.** Na Macu Jarvis stlmený alebo veľmi tichý zvuk na budík zosilní na 50 % a potom vráti (`JARVIS_ALARM_VOLUME`).
  Na Windows nechaj hlasitosť zapnutú.
- **Spánok** povie len vtedy, keď ho vie: z denníka (stačí mu povedať „spal som sedem hodín") alebo z konektora, ktorý
  má dáta z hodiniek. Inak ho vynechá. Jarvis sám spánok nemeria.

## Práca cez noc

„Cez noc mi priprav cenovú ponuku pre Novákovcov" alebo „kým budem spať, prejdi moje poznámky a uprac ich". Jarvis
pustí úlohu na pozadí hneď, v tichých hodinách nič nehovorí nahlas a ráno ti pri budíku (alebo v rannom briefe) povie,
čo je hotové a čo čaká na tvoje „áno". Mail ani správu za teba neodošle, pripraví ich. HUD musí bežať (spúšťa sa po
prihlásení, `node scripts/autostart.mjs install`). Z príkazového riadku: `node scripts/job.mjs "zadanie" --title "Názov"`.

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
| `node scripts/alarm.mjs test --quick` | skúška budíka hneď |
| `node scripts/job.mjs "…"` | úloha na pozadí (aj na noc) |
| `node scripts/schedule.mjs install` | zaregistruje rutiny, stráže, budík a pulz v systéme a overí, že ich systém naozaj spúšťa |
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

## Čo smie Jarvis sám

Všetko, čo ty. Úlohy na pozadí aj rutiny bežia s plným prístupom: súbory kdekoľvek v počítači, príkazy v termináli,
web a tvoje konektory (kalendár, mail…). Na nič sa nepýta, lebo pri tej práci nikto nesedí, kto by odpovedal.
Žiadny obmedzený režim neexistuje a nič sa nenastavuje.

Jedna vec platí vždy: ľuďom nič neposiela sám. Pripraví presné znenie, v HUD ohlási, že čaká na súhlas, a pošle,
až keď povieš „pošli to" alebo klikneš na Schváliť. Pri konektoroch, ktoré vedia posielať (mail), si v nastaveniach
Claude môžeš navyše určiť, čo smú robiť bez potvrdenia.

## Úlohy: nahliadnuť a zastaviť

Každú úlohu, ktorú si Jarvis pustil na pozadí, vidíš v HUD v paneli **Úlohy** (a v lište hore, kým niečo beží).

- **Riadok úlohy** ukazuje, čo práve robí, a ako dlho beží. Tlačidlo so štvorčekom vpravo ju hneď zastaví.
- **Klik na úlohu** ju otvorí: zadanie, ktoré dostala, a priebeh krok po kroku s časmi. Vidíš príkazy, ktoré spustila,
  súbory, ktoré čítala a písala, a čo si pri tom Jarvis poznačil. Kým beží, pribúda to naživo.
- **Zastaviť** úlohu ukončí aj so všetkým, čo spustila. Nič sa nestratí: zastavenú alebo hotovú úlohu vieš
  v tom istom okne doplniť („dorob to, ale len za tento týždeň") a pokračuje tam, kde skončila.
- **Schváliť** sa ukáže, keď úloha pripravila niečo, čo má ísť von, a čaká na teba.
- **Hlasom:** „čo robí tá úloha?", „zruš to", „pošli to".

Podrobný záznam každej úlohy ostáva v `data/jobs/`.

## Čo treba vedieť

- Rutiny bežia, aj keď je Claude zatvorený. Počítač musí byť zapnutý a ty prihlásený.
- Keď počítač v čase rutiny spí, rutina prebehne po zobudení.
- Rutiny míňajú tvoje predplatné Claude rovnako ako bežný rozhovor. Ranný brief je asi ako jeden dlhší rozhovor.
- Konektory (kalendár, mail) si pripoj v nastaveniach Claude. Rutiny ich potom vidia tiež.
- Log každej rutiny je v `data/logs/routine-<id>.log`.
- Claude Code má aj vlastné plánované úlohy v aplikácii. Tie bežia, len keď je aplikácia otvorená, preto Jarvis
  používa plánovač systému.
