# Hovory: keď Jarvis niečo potrebuje, zavolá

Jarvis ti vie zavolať na mobil. Je to skutočný telefonát: zazvoní ti telefón, zdvihneš a Jarvis povie, čo treba.
Potom môžeš odpovedať hlasom. Keď zložíš, Jarvis si odpoveď vypočuje a zariadi sa podľa nej.

Hodí sa na veci, ktoré nesmú zapadnúť medzi oznámeniami: pripomienka, ktorú nesmieš zmeškať, mail, na ktorý niekto
čaká do hodiny, alebo ranný brief do auta.

## Kedy volá

| Kedy | Ako to zapneš |
|---|---|
| Súrna pripomienka | Povedz „zavolaj mi zajtra o tretej a pripomeň lekára". V `memory/pripomienky.md` je to riadok s výkričníkom: `- [ ] 2026-02-03 15:00 !Lekár`. |
| Udalosť v kalendári, ktorú nesmieš zmeškať | Názov udalosti začni výkričníkom: `- 2026-02-03 14:00 !Štátnice`. Zavolá pár minút pred ňou. |
| Stráž niečo našla | Stráž pošty a ďalšie rutiny samy rozhodnú, či vec počká. Ak nie, zavolajú. |
| Rutina telefonátom | V `config/jarvis.json` pridaj rutine `"call": true`. Ranný brief ti potom príde ako hovor. |
| Na požiadanie | „Jarvis, zavolaj mi." alebo `node scripts/call.mjs "text"`. |

Počas tichých hodín (`quiet` v `config/jarvis.json`) Jarvis nevolá. Bežné veci bez výkričníka povie len na ploche a v oznámení.

## Nastavenie (15 minút)

Najjednoduchšie je napísať Jarvisovi v Claude „nastav hovory", prevedie ťa tým. Ručne:

1. Založ si účet na [twilio.com](https://www.twilio.com/try-twilio). Skúšobný účet má kredit zadarmo a pri registrácii si overíš svoje mobilné číslo.
2. V Twiliu si vezmi telefónne číslo (Phone Numbers → Buy a number). Stačí americké, stojí asi dolár mesačne. Z neho ti Jarvis bude volať.
3. Povoľ volania na Slovensko alebo do Česka: Voice → Settings → Geo permissions.
4. Do súboru `.env` v priečinku Jarvisa napíš (hodnoty sú na úvodnej stránke Twilio konzoly):

   ```
   TWILIO_ACCOUNT_SID=AC…
   TWILIO_AUTH_TOKEN=…
   TWILIO_FROM=+1…
   JARVIS_CALL_TO=+421…
   ```

5. Vyskúšaj: `node scripts/call.mjs --test`. Má ti zazvoniť telefón.

Kontrola bez volania: `node scripts/call.mjs --status`.

## Čo treba vedieť

- **Cena.** Platíš Twiliu za minúty, hovor na slovenský mobil stojí rádovo desiatky centov za minútu. Bežná pripomienka trvá pár sekúnd. Presný cenník je na stránke Twilia.
- **Skúšobný účet** volá len na overené čísla a na začiatku hovoru prehrá krátku vetu od Twilia. Po dobití kreditu zmizne. Skúšobný účet časom vyprší, potom treba v Twiliu kliknúť Upgrade a dobiť pár dolárov.
- **Hlas.** V telefóne hovorí slovenský hlas od Googlu (`Google.sk-SK-Wavenet-B`), nie hlas z plochy. Zmeníš ho cez `JARVIS_CALL_VOICE` v `.env`. Pri češtine (`JARVIS_LANG=cs`) sa použije český.
- **Odpoveď hlasom.** Po správe máš asi 25 sekúnd na odpoveď, potom zlož. Nahráva sa len tvoja strana hovoru. Jarvis si nahrávku stiahne do počítača, v Twiliu ju zmaže a prepíše ju. Na prepis potrebuje lokálne rozpoznávanie reči (`docs/HLAS.md`) a spustený HUD. Bez nich zavolá a povie, ale odpoveď nespracuje. Vypnutie odpovedí: `JARVIS_CALL_REPLY=0`.
- **Nie je to rozhovor naživo.** Jarvis povie, ty odpovieš, on koná. Ak treba, zavolá znova. Plynulý rozhovor by vyžadoval otvoriť tvoj počítač do internetu, a to Jarvis nerobí.
- **Volať Jarvisovi** (ty jemu) zatiaľ nejde, z rovnakého dôvodu.
- **Poistka.** Jarvis zavolá najviac 12-krát za deň, aby chyba v rutine neminula kredit. Zmeníš cez `JARVIS_CALL_MAX_PER_DAY`.
- **Záznam.** Čo a kedy volal, je v `data/calls/log.jsonl`.

## Bezpečnosť

- Kľúče k Twiliu sú len v tvojom `.env`. Nikomu ich neposielaj a nedávaj ich do pamäte.
- Jarvis volá len na jedno číslo, to tvoje (`JARVIS_CALL_TO`). Iným ľuďom nevolá.
- Text hovoru ide do Twilia, aby ho mal kto povedať. Neposielaj telefonátom veci, ktoré by si nepovedal nahlas v električke.
