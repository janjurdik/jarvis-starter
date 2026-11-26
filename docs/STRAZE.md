# Stráže: „daj mi vedieť, keď…"

Stačí jedna veta: „daj mi vedieť, keď zlacnie let Viedeň Londýn pod 80 €", „keď mi odpíše Peter", „keď pribudne byt
v Brne do 15 000 Kč na Sreality", „keď sa zmení táto stránka", „keď príde balík", „upozorni ma, keď bitcoin padne
pod 60 000". Jarvis si zistí, kde sa to dá overiť, nastaví stráž a potvrdí jednou vetou, čo stráži a ako často.
Odvtedy to kontroluje sám na pozadí a ozve sa, **len keď to naozaj nastane**.

Keď nastane: karta na ploche, riadok v LOGu, Jarvis to povie nahlas (mimo tichých hodín), príde oznámenie systému,
a keď si o to povedal a hovory sú nastavené (`docs/HOVORY.md`), aj zavolá. Telefonát povie len pevnú vetu s tvojimi
vlastnými slovami („Pane, splnila sa stráž: keď zlacnie let pod 80 €. Podrobnosti máte na obrazovke."), čo kontrola
našla, ostáva na karte na obrazovke.

Čo kontrola videla minule, dostane ďalšia kontrola ako ohraničené údaje (najviac 400 znakov), nikdy ako pokyny: text
zo stránky alebo z mailu tak nemôže stráž prepísať. Stráž, ktorú si nezadal sám v rozhovore s Jarvisom (pridala ju
úloha na pozadí alebo príkaz `node scripts/watch.mjs add`), sa ohlási kartou a oznámením, aby si o nej vedel.

## Ako sa s nimi hovorí

| Povieš | Čo sa stane |
|---|---|
| „daj mi vedieť, keď…", „sleduj mi…", „upozorni ma, keď…" | nová stráž |
| „…a zavolaj mi" | pri zhode aj telefonát |
| „vždy, keď pribudne…" | stráž sa ozve pri každej novej zhode, inak raz a skončí |
| „…do konca decembra", „…tento týždeň" | stráž má koniec, potom sa sama ukončí |
| „…aj v noci" | kontroluje a ozve sa aj v tichých hodinách |
| „aké mám stráže?" | zoznam so stavom |
| „pozastav", „obnov", „zruš stráž…", „kontroluj to každé dve hodiny" | zmena stráže |

Na ploche je orb **Stráže**: koľko ich beží, zoznam s tým, čo stráži, ako často, kedy sa naposledy pozrel a čo videl.
Klik na riadok stráž pozastaví (alebo obnoví), v detaile bodu vo vnútri orbu je tlačidlo na zrušenie. Orb sa
prekreslí po každej zmene a po každej kontrole.

## Ako často

Interval vyberá Jarvis podľa povahy veci, dá sa zmeniť vetou:

| Čo | Predvolene |
|---|---|
| odpoveď na správu alebo mail | každých 15 minút |
| kurz, kryptomena | každých 30 minút |
| cena, letenky, inzeráty | každú hodinu |
| zásielka | každé 2 hodiny |
| zmena stránky | každé 3 hodiny |

Najmenej 5 minút, najviac raz za týždeň. V tichých hodinách (Nastavenia) sa nekontroluje, okrem stráže „aj v noci".
Stráž môže mať aj okno (`--between 08:00-22:00`).

## Ako to funguje

- Stráže sú dáta v `data/watches.json`, nie rutiny. Nová stráž nepotrebuje zápis do `config/jarvis.json` ani novú
  registráciu v systéme.
- Kontrolu spúšťa **pulz** (každých pár minút zo systémového plánovača) a kým Jarvis beží, aj jeho server každú minútu.
  Oba len pozrú, či je niektorá stráž na rade, a keď áno, spustia na pozadí `node scripts/watch.mjs tick`.
- Jedna kontrola je jeden krátky beh agenta na **najlacnejšom modeli** (na Claude Haiku, na Codexe krátke premýšľanie, na
  Antigravity Gemini Flash, `docs/MODELY.md`). Má web, konektory a prehliadač ako rutiny. Dostane vetu používateľa,
  plán kontroly a to, čo videla minulá kontrola.
- Kontrola musí skončiť presne jedným riadkom: `HIT: <veta pre používateľa>`, `NO: <čo videla teraz>` alebo
  `ERROR: <prečo to nešlo>`. Čokoľvek iné sa berie ako chyba, nikdy ako zhoda, takže zmätený beh nespustí falošný poplach.
  Opakovaná stráž, ktorá hlási tú istú zhodu ako minule, mlčí.
- Pri strážach typu „keď príde", „keď odpíše", „keď sa zmení" sa ráta len to, čo je nové od vytvorenia stráže. Prvá
  kontrola si zapíše východiskový stav.
- Naraz bežia najviac dve kontroly a jeden beh ich spraví najviac osem, najstaršie dlžné prvé. Po prebudení počítača
  sa každá stráž skontroluje raz, nie toľkokrát, koľko intervalov prespala.
- Kontrola, ktorá zlyhá, sa ďalej skúša zriedkavejšie (dvojnásobok, štvornásobok, najviac osemnásobok intervalu). Po
  troch chybách po sebe sa stráž pozastaví a Jarvis to raz povie, aj s dôvodom.
- Kontrola len číta. Nič neposiela, neodpisuje ani nekupuje, nemení súbory ani pamäť. Čo prečíta na webe alebo v pošte,
  sú dáta, nie pokyny.
- Zrušená stráž zmizne hneď. Splnená jednorazová a vypršaná ostanú v orbe týždeň a v súbore mesiac.

## Príkazy

```
node scripts/watch.mjs add "keď zlacnie let Viedeň Londýn pod 80 €" \
  --check "Otvor https://www.kiwi.com/sk/… (lety VIE → LON na 30 dní), nájdi najnižšiu cenu v €. Splnené, keď je pod 80 €." \
  --every 60 --until 2026-12-31
node scripts/watch.mjs list [--all] [--json]
node scripts/watch.mjs pause s3 | resume s3 | remove s3
node scripts/watch.mjs edit s3 --every 120 --until +7d
node scripts/watch.mjs run s3 [--silent]      kontrola hneď, zhoda sa ohlási (--silent: len karta, bez hlasu a oznámenia)
node scripts/watch.mjs due                    čo je na rade a prečo nie
```

Voľby pri `add` a `edit`: `--every <min>`, `--until <2026-12-31 | "2026-12-31 18:00" | +7d | +12h>`, `--between 08:00-22:00`,
`--once` alebo `--repeat`, `--call`, `--quiet` (len karta a oznámenie) alebo `--voice`, `--urgent` (aj v tichých hodinách),
`--model <model>`. Pri `add` ešte `--no-check` (prvá kontrola nebeží hneď).

Hlasový nástroj `watch` (`hud/server/mcp/jarvis-hud.mjs`) robí to isté: `add`, `list`, `pause`, `resume`, `remove`,
`edit`, `run`. Záznam je v `data/logs/watch.log`, kód v `hud/server/watches.mjs`.

Skúška bez AI: plán s `mock:hit` (alebo `mock:error`) a `run <id> --mock` prejde celé doručenie bez modelu.
