# Garmin: spánok a telo naživo z hodiniek

Keď máš hodinky Garmin, Jarvis si vie sám sťahovať, ako si spal a ako je na tom tvoje telo: dĺžku a skóre spánku,
kedy si zaspal a vstal, HRV, pokojový tep, body battery, kroky, stres, pripravenosť na tréning a tréningy.
Ráno to povie v briefe, a keď sa spýtaš „ako som spal?", odpovie číslami z hodiniek.

## Na rovinu, ako to funguje

- Garmin nemá pre bežných ľudí oficiálne napojenie. Jarvis preto používa **tvoje vlastné prihlásenie do Garmin Connect**
  cez neoficiálnu knižnicu [python-garminconnect](https://github.com/cyberjunky/python-garminconnect). Robí to isté,
  čo appka Garmin Connect v mobile: prihlási sa ako ty a prečíta tvoje dáta. Nič v Garmine nemení.
- **Heslo píšeš len do terminálu na svojom počítači.** Ide rovno Garminu. Jarvis si ho neukladá, nezapisuje do žiadneho
  súboru ani záznamu a Claude ho nikdy nevidí. Preto prihlásenie spúšťaš ty, nie Jarvis.
- Uloží sa iba **prihlásenie tohto počítača** (tokeny) do súboru `data/garmin/garmin_tokens.json`, čitateľného len pre teba.
  Kto má tento súbor, vie čítať tvoje dáta z Garminu, kým ho neodpojíš. Nikam ho neposielaj. Priečinok `data/` sa do gitu neukladá.
- Dáta z hodiniek ostávajú u teba: v denníku (`memory/dennik/`) a v `data/garmin/days.json`.
- **Garmin to môže kedykoľvek pokaziť.** Keď zmení prihlasovanie, pripojenie prestane fungovať, kým knižnicu niekto
  neopraví. Vtedy stále funguje export dát z Garminu (sprievodca v HUD na `/guide/#garmin`) a to, čo Jarvisovi povieš sám.

## Pripojenie (2 minúty)

Potrebuješ program `uv` (ten istý, cez ktorý Jarvis hovorí). Ak chýba, `node scripts/doctor.mjs` povie, ako ho doinštalovať.

1. Otvor Terminál (macOS: Cmd+Medzerník, napíš „Terminál") alebo PowerShell (Windows) a prejdi do priečinka Jarvisa.
   Presný riadok pre tvoj počítač vypíše `node scripts/garmin.mjs status`, vyzerá takto:

   ```
   cd "cesta k priečinku Jarvisa"
   node scripts/garmin.mjs login
   ```

2. Zadaj e-mail a heslo ku Garmin účtu. Heslo sa pri písaní nezobrazuje, to je v poriadku.
3. Ak máš zapnuté dvojfázové overenie, Garmin ti pošle kód e-mailom alebo SMS. Opíš ho do terminálu.
   Kód platí len pár minút. Keď vyprší, spusti prihlásenie znova a príde nový.
4. Jarvis hneď stiahne posledných 14 dní a zapíše ich do denníka.

Prihlásenie sa obnovuje samo, heslo už zadávať nemusíš. Ako dlho vydrží, určuje Garmin. Keď ho zruší, Jarvis ti to
oznámi a prihlásiš sa rovnakým príkazom znova.

Keď prihlásenie nejde: skontroluj heslo na [connect.garmin.com](https://connect.garmin.com). Po viacerých pokusoch
za sebou Garmin prihlásenia na chvíľu blokuje. Počkaj aspoň hodinu, neskúšaj to dookola.

## Čo sa deje potom

- Jarvis si dáta sťahuje sám na pozadí, zhruba každé tri hodiny a pred ranným budíkom.
- **Dnešnú noc hodinky pošlú až po zobudení**, keď sa zosynchronizujú s mobilom. Ak ťa budí Jarvis, v tej chvíli ju
  ešte nemá. Ráno ju preto pár hodín vyzerá častejšie, a keď dorazí, doplní ju: po budíku ju povie nahlas,
  inak ju len ukáže na ploche.
- Ručne: `node scripts/garmin.mjs sync` (posledných 14 dní), stav: `node scripts/garmin.mjs status`.
- Čo sa zapisuje do denníka: v hlavičke dňa polia `spanok`, `spanok_skore`, `spanok_fazy`, `zaspal`, `vstal`, `hrv`,
  `tep_pokoj`, `bateria`, `bateria_rano`, `kroky`, `stres`, `pripravenost`, a tréningy pod nadpisom `## Tréning`.
  Tvoj text ostáva nedotknutý.
- **Tvoje slovo má prednosť.** Keď Jarvisovi povieš „spal som šesť hodín" alebo si spánok v poznámke prepíšeš,
  Garmin ho už neprepíše. Čo zapísal Garmin, spoznáš podľa riadku `spanok_zdroj: garmin`.

Nastavenia v `config/jarvis.json` (nepovinné):

```json
"garmin": { "auto": true, "every": 180, "announce": true }
```

`auto: false` vypne sťahovanie na pozadí, `every` je počet minút medzi sťahovaniami (najmenej 30),
`announce: false` vypne ranné doplnenie spánku.

## Odpojenie

```
node scripts/garmin.mjs logout
```

Zmaže uložené prihlásenie z tohto počítača a Jarvis prestane sťahovať. Čo je už v denníku, ostáva. Ak chceš preč
aj kópiu dát z hodiniek, zmaž priečinok `data/garmin`. Odhlásenie sa týka len tohto počítača, na strane Garminu ho knižnica zrušiť nevie. Ak si myslíš, že sa súbor
s prihlásením dostal k niekomu inému, zmeň si heslo ku Garmin účtu (či tým Garmin zruší aj staré prihlásenia, overené nemáme).

## Keď niečo nejde

Záznam každého sťahovania je v `data/logs/garmin.log` (bez hesiel a tokenov).

| Čo vidíš | Čo s tým |
|---|---|
| „Garmin nie je pripojený" | Spusti prihlásenie podľa postupu vyššie. |
| „Prihlásenie vypršalo" | Prihlás sa znova tým istým príkazom. |
| „Garmin dočasne odmieta požiadavky" | Garmin pribrzdil. Jarvis to o hodinu skúsi sám. |
| Chýba HRV, body battery alebo pripravenosť | Staršie hodinky ich nemerajú. Jarvis zapíše to, čo hodinky majú. |
| Chýba dnešný spánok | Otvor v mobile appku Garmin Connect, nech sa hodinky zosynchronizujú, a potom `node scripts/garmin.mjs sync`. |
| Nič z toho nepomáha | Garmin asi zmenil prihlasovanie. Skús `node scripts/update.mjs`, či už je oprava, a dovtedy použi export z Garminu. |
