# Poznámky k verziám

V tomto priečinku je ku každej verzii jeden súbor `<verzia>.md`. Píše ho autor verzie a číta ho Claude, keď u niekoho
robí aktualizáciu (postup je v [`docs/AKTUALIZACIE.md`](../docs/AKTUALIZACIE.md)). Kto preskočí viac verzií naraz,
dostane poznámky všetkých verzií po ceste, od najstaršej.

`CHANGELOG.md` hovorí človeku, čo je nové. Poznámka tu hovorí Claudovi, čo má pri aktualizácii spraviť a na čo si dať pozor.
Súbory spája aktualizácia sama, poznámka je na to, čo zo súborov nevidno.

## Formát

Obyčajný Markdown so štyrmi časťami. Krátko a konkrétne. Ak v niektorej časti nič nie je, napíš „Nič".

```markdown
# Aktualizácia na 1.2.0

## Čo sa zmenilo

Zmeny podľa významu, nie podľa súborov. Čo pribudlo, čo sa správa inak, čo zaniklo.

## Na čo si dať pozor v upravených súboroch

Kde sa zmenil tvar vecí, na ktoré si ľudia často píšu vlastné úpravy: premenovaná funkcia, nový povinný blok
v CLAUDE.md, iný formát rutiny. Čo má Claude skontrolovať v súboroch, ktoré používateľ menil alebo si pridal sám.

## Čo treba spraviť po nahratí

Kroky, ktoré sa samy nestanú: presun alebo premenovanie v `memory/`, nový kľúč v `config/jarvis.json`,
nová registrácia rutín. Presne, s príkazmi. Do pamäte a nastavenia siaha Claude len na základe tejto časti.

## Čo povedať používateľovi

Dve až tri vety o tom, čo nové môže skúsiť.
```

Poznámka je text pre Clauda, nie skript. Nesmie žiadať nič, čo by používateľ neschválil: žiadne mazanie pamäte,
žiadne posielanie dát von.

## `manifests/`

Zoznamy súborov starších verzií, ktoré ešte vlastný `jarvis.manifest.json` nemali (1.0.0). Vďaka nim sa dajú aj tieto
inštalácie aktualizovať so zachovaním úprav. Bežné verzie tu nič nemajú, svoj zoznam nesú v sebe.

## Pre autora: ako vydať novú verziu

```
node scripts/release.mjs minor        # alebo patch, major, presná verzia 1.4.2; s --dry-run nič nezapíše
```

Zdvihne verziu v `package.json`, pridá kostru do `CHANGELOG.md`, založí `updates/<verzia>.md` a vygeneruje
`jarvis.manifest.json`. Potom:

1. Doplň `CHANGELOG.md` a poznámku k verzii (hľadaj `DOPLŇ`).
2. Vygeneruj zoznam súborov nanovo, lebo si práve menil súbory, ktoré pokrýva, a over ho:
   ```
   node scripts/release.mjs --manifest-only
   node scripts/release.mjs --check
   ```
3. Zverejni. Príkazy vypíše `release.mjs` na konci: commit, značka `v<verzia>` a push oboch.

Značka `v<verzia>` je dôležitá: podľa nej si inštalácie dohľadajú čistú podobu súborov, ktoré si používateľ upravil.

`node scripts/release.mjs --check` sa oplatí pustiť pred každým pushom do hlavnej vetvy. Ak zoznam nesedí so súbormi,
aktualizácia u ľudí prebehne, ale nezmenené súbory bude zbytočne považovať za upravené.

Ak sa mení tvar súborov, ktoré si aktualizácia ukladá do `data/update/` (plán, rozrobená aktualizácia), zdvihni
`SCHEMA` v `scripts/update/core.mjs`: `apply` beží ešte v starej verzii skriptov, `finish` už v novej.
