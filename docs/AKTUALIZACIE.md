# Aktualizácie

Jarvis sa vyvíja ďalej a nové verzie vychádzajú na GitHube. Zároveň je tvoj: môžeš si v ňom s Claudom meniť,
čo chceš. Aktualizácia je spravená tak, aby si dostal novinky a neprišiel pri tom o nič svoje.

Je jedno, či si Jarvisa stiahol ako ZIP alebo cez git. Novú verziu si Jarvis stiahne z GitHubu sám, overí jej podpis
a porovná ju so zoznamom súborov, ktorý prišiel s tvojou verziou (`jarvis.manifest.json`). Git na to netreba.

## Ako to funguje

1. **Jarvis si všimne novú verziu.** Keď beží HUD, dve minúty po štarte a potom každú hodinu sa pozrie, či nevyšla
   novšia verzia. Ak áno, povie ti to a opýta sa. Sám nič neinštaluje.
2. **Povieš áno.** Napíš alebo povedz `aktualizuj Jarvisa`. Ísť to dá kedykoľvek, aj bez toho, aby sa Jarvis ozval.
3. **Claude stiahne novú verziu a porovná ju s tvojou.** Pri každom súbore vie tri veci: ako vyzeral, keď si
   Jarvisa dostal, ako vyzerá u teba teraz a ako vyzerá v novej verzii. Podľa toho rozhodne:
   - súbor si nemenil → nahradí ho novým,
   - zmenil si ho len ty → nechá ho tak,
   - zmenil si ho ty aj nová verzia, každý na inom mieste → spojí to automaticky,
   - zmenili ste to isté miesto → Claude si prečíta obe verzie a napíše súbor, v ktorom je tvoja úprava aj novinka.
4. **Overí, že všetko funguje.** Skontroluje skripty, pustí kontrolu počítača a na skúšku naštartuje HUD.
5. **Povie ti, čo je nové.** A keby čokoľvek nesedelo, jedným príkazom sa vrátiš späť.

## Čoho sa aktualizácia nikdy nedotkne

| | |
|---|---|
| `memory/` | Tvoja pamäť: všetko, čo si Jarvis o tebe zapísal. |
| `config/jarvis.json` | Tvoje nastavenie (meno, mesto, rutiny). |
| `.env` a ďalšie `.env.*` | Tvoje voľby a prípadné kľúče. |
| `data/` | Rozhovory, logy, zálohy. |
| `node_modules/`, `hud/desktop/build/` | Veci, ktoré si počítač vyrába sám. |

Jediná výnimka v pamäti je návod `memory/README.md`. Ten je súčasťou Jarvisa (popisuje formát poznámok), takže sa
aktualizuje ako každý iný súbor. Tvoje poznámky nie.

Súbory, ktoré si si vytvoril sám (vlastné rutiny, skripty, poznámky mimo pamäte), aktualizácia nevidí a nechá ich na mieste.

## Čo sa stane s mojimi úpravami

Ostanú. Či už si upravil `CLAUDE.md`, rutinu alebo vzhľad HUD, aktualizácia tvoju verziu neprepíše. Ak sa tvoja úprava
a novinka stretnú na tom istom mieste, Claude ich spojí ručne a povie ti, ako to vyriešil.

Pred každou zmenou sa pôvodný súbor odloží do `data/update/backup/`. Odkladá sa posledných päť aktualizácií.

Čo všetko máš oproti pôvodnej verzii zmenené, ukáže:

```
node scripts/update.mjs customizations
```

## Keď sa niečo pokazí

```
node scripts/update.mjs rollback
```

Vráti všetky súbory do stavu pred poslednou aktualizáciou a zmaže to, čo aktualizácia pridala. Funguje aj uprostred
rozrobenej aktualizácie. Potom reštartuj HUD: `node scripts/hud.mjs --restart`.

## Ako vypnúť kontrolu nových verzií

Do `.env` pridaj riadok `JARVIS_UPDATE_CHECK=0` a reštartuj HUD. Alebo do `config/jarvis.json`:

```json
"update": { "check": false }
```

Aktualizovať sa dá ďalej, len sa Jarvis prestane sám ozývať.

## Príkazy

Všetko spúšťa Claude za teba. Keby si chcel sám:

| Príkaz | Čo robí |
|---|---|
| `node scripts/update.mjs check` | Je vonku novšia verzia? Nič nemení. |
| `node scripts/update.mjs plan` | Stiahne novú verziu a vypíše, čo by sa zmenilo. Nič nemení. |
| `node scripts/update.mjs apply` | Zálohuje a nahrá všetko bezpečné. Sporné súbory odloží bokom. |
| `node scripts/update.mjs resolve <súbor>` | Potvrdí vyriešený sporný súbor. S `--take local` nechá tvoju verziu, s `--take incoming` vezme novú. |
| `node scripts/update.mjs finish` | Overí, že Jarvis funguje, a aktualizáciu uzavrie. |
| `node scripts/update.mjs rollback` | Vráti stav pred aktualizáciou. |
| `node scripts/update.mjs status` | V akom stave je aktualizácia a aké zálohy existujú. |
| `node scripts/update.mjs customizations` | Čo si oproti pôvodnej verzii zmenil. |

Ku každému príkazu ide `--json`.

## Mám vlastnú verziu Jarvisa (fork)

Ak si Jarvisa na GitHube skopíroval a rozvíjaš ho po svojom, alebo ho dostávaš od niekoho iného, povedz mu, odkiaľ
má brať nové verzie. V `config/jarvis.json`:

```json
"update": { "repo": "meno/moj-jarvis", "branch": "main" }
```

Alebo v `.env`: `JARVIS_UPDATE_REPO=meno/moj-jarvis` a `JARVIS_UPDATE_BRANCH=main`.

Kto chce z vlastnej verzie vydávať aktualizácie pre iných, nájde postup v [`updates/README.md`](../updates/README.md).

## Stiahol som Jarvisa cez git

Funguje to rovnako. Aktualizácia nerobí `git pull`, pracuje so súbormi, takže tvoje commity ostanú, ako sú. Po nej
budú nové súbory v pracovnom priečinku ako necommitnuté zmeny. Claude ti navrhne, aby si ich uložil
(`git add -A` a `git commit`).

## Mám starú verziu, ktorá aktualizácie nepozná

Verzia 1.0.0 príkaz `scripts/update.mjs` ešte nemala. Stačí Claudovi napísať `aktualizuj Jarvisa` a poslať mu odkaz
na túto stránku. Claude si aktualizačné skripty stiahne týmto príkazom a ďalej pokračuje bežným postupom nižšie:

```
node -e '(async()=>{const fs=require(`fs`);const r=`https://raw.githubusercontent.com/janjurdik/jarvis-starter/main/`;const m=await(await fetch(r+`jarvis.manifest.json`)).json();for(const p of Object.keys(m.files).filter(p=>p.startsWith(`scripts/update`))){fs.mkdirSync(p.slice(0,p.lastIndexOf(`/`)),{recursive:true});fs.writeFileSync(p,Buffer.from(await(await fetch(r+p)).arrayBuffer()));console.log(p)}})()'
```

Tvoje úpravy sa zachovajú aj tu: zoznam súborov starej verzie je uložený v `updates/manifests/`.

---

## Pre Clauda: ako spraviť aktualizáciu

Tento postup platí, keď používateľ povie „aktualizuj Jarvisa", „je nová verzia?", alebo keď na novú verziu upozorní HUD.
Príkazy spúšťaj s `--json` a čítaj polia, ktoré sú tu vymenované. Používateľovi hovor ľudsky, bez názvov príkazov.

**1. Zisti, či je čo aktualizovať.** `node scripts/update.mjs check --json`
- `ok: false` → povedz dôvod zo `summary` (najčastejšie chýba internet) a skonči.
- `available: false` → povedz, že má najnovšiu verziu, a skonči.
- `inProgress: true` → aktualizácia je rozrobená: `node scripts/update.mjs status --json` a pokračuj tam, kde skončila.

**2. Povedz, čo je nové, a opýtaj sa.** Z `changelog` vyber dve až tri veci, ktoré používateľ pocíti. Spomeň, koľko
vlastných úprav má (`customized`) a že ostanú. Bez jasného áno nepokračuj.

**3. Naplánuj.** `node scripts/update.mjs plan --json`. Nič sa ešte nemení. Dvoma až troma vetami vysvetli, čo sa stane:
koľko súborov sa vymení (`update`, `add`, `remove`), ktoré jeho úpravy ostávajú (`keep`), ktoré spojíš (`conflict`).
Prečítaj `warnings`. Ak je `baseline: "none"`, povedz narovinu, že pôvodná verzia chýba a súbory budeš spájať ručne.

**4. Nahraj.** `node scripts/update.mjs apply --json`. Záloha vznikne sama. Bezpečné zmeny sú hneď na mieste,
automaticky spojené súbory sú v `merged` (pozri sa na ne, či dávajú zmysel).

**5. Vyrieš konflikty.** Pre každú položku v `conflicts`:
- prečítaj `files.base` (pôvodná verzia), `files.local` (verzia používateľa) a `files.incoming` (nová verzia);
  `files.merged` ukazuje sporné miesta medzi značkami `tvoje`, `pôvodné` a `nové`,
- pochop, čo chcel používateľ dosiahnuť svojou úpravou a čo prináša nová verzia,
- zapíš výsledok na pôvodné miesto súboru tak, aby platilo oboje: úmysel používateľa aj nová funkcia. Nie jedno
  na úkor druhého. Žiadne značky konfliktu vo výsledku,
- potvrď: `node scripts/update.mjs resolve <cesta>`.

  Keď sa spojiť nedá alebo to nedáva zmysel: `resolve <cesta> --take local` (ostáva verzia používateľa) alebo
  `--take incoming` (nová verzia). Pri binárnych súboroch (obrázky) a pri zmazaných súboroch je to jediná cesta, `hint`
  povie, čo zvážiť. Ak si nie si istý, čo používateľ svojou úpravou myslel, opýtaj sa ho. Pri kóde over, že výsledok
  sedí s ostatnými novými súbormi (názvy funkcií, importy).

**6. Sprav, čo píše autor.** V `notes.migrations` (v pláne aj vo výstupe z apply) sú poznámky k verziám, po nahratí ich
nájdeš aj v `updates/<verzia>.md`. Sú písané pre teba: čo sa zmenilo významovo, čo skontrolovať v upravených súboroch,
čo premigrovať v pamäti alebo nastavení. Sprav všetko, čo tam je. Do `memory/` a `config/jarvis.json` siahaj len vtedy,
keď to poznámka výslovne žiada, a opatrne.

**7. Dokonči.** `node scripts/update.mjs finish --json`. Nainštaluje balíčky, ak sa zmenili, a overí inštaláciu
(`checks`: skripty, kontrola počítača, skúšobný štart HUD).
- `ok: true` → sprav všetko z `followups` (reštart HUD, nová registrácia rutín, zostavenie appky na plochu). Nové
  nastavenia z `followups` používateľovi ponúkni, nezapínaj ich bez neho.
- `ok: false` → pozri `checks`, chybu oprav a spusti `finish` znova. Ak ju opraviť nevieš na pár pokusov:
  `node scripts/update.mjs rollback`, používateľovi povedz, že ostal na pôvodnej verzii, a čo presne zlyhalo.

**8. Povedz, čo je nové.** Ľudsky, pár viet: čo nové môže skúsiť, že jeho úpravy ostali (a ak si niektorú spájal ručne,
ako si to vyriešil) a že sa dá vrátiť späť.

Pravidlá:
- Nikdy nerob `git pull`, `git reset` ani ručné kopírovanie súborov z novej verzie. Vždy cez `scripts/update.mjs`.
- Nepoužívaj `plan --force`, pokiaľ si to používateľ výslovne nevyžiada (vnúti porovnanie aj so staršou verziou).
- Medzi `plan` a `apply` nič v priečinku nemeň, inak plán prestane platiť a treba ho spraviť znova.
- Aktualizáciu nenechávaj rozrobenú. Buď `finish`, alebo `rollback`.

## Kde čo leží

| | |
|---|---|
| `jarvis.manifest.json` | Zoznam súborov tejto verzie a odtlačok každého z nich. Podľa neho sa pozná, čo si menil. |
| `CHANGELOG.md` | Čo je v ktorej verzii nové. |
| `updates/` | Poznámky autora pre Clauda ku každej verzii. |
| `data/update/base/` | Čistá kópia verzie, ktorú máš nainštalovanú. Potrebná na trojstranné porovnanie. |
| `data/update/backup/` | Zálohy pred aktualizáciami. |
| `data/update/conflicts/` | Verzie sporných súborov počas rozrobenej aktualizácie. |
