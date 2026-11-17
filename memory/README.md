# Pamäť Jarvisa

Tento priečinok je všetko, čo o tebe Jarvis vie. Sú to obyčajné textové súbory (markdown) na tvojom počítači.
Môžeš ich čítať, upravovať aj mazať v ľubovoľnom editore, napríklad v Obsidiane. Súbory ostávajú u teba a do gitu sa
tento priečinok neukladá. To, s čím Jarvis práve pracuje, číta AI, na ktorej beží (Claude alebo ChatGPT), rovnako ako keď jej píšeš sám.

Pamäť sa napĺňa štyrmi spôsobmi: pri úvodnom nastavení (Jarvis si prejde tvoj počítač), z kópií tvojich
dát z aplikácií (sprievodca je v HUD na adrese `/guide/`), počas rozhovorov (Jarvis si zapisuje, čo sa dozvie)
a večernou rutinou, ktorá zapíše deň do denníka.

## Čo kde je

| Súbor alebo priečinok | Čo obsahuje |
|---|---|
| `ja.md` | Kto si: čo robíš, čo chceš, ako funguješ. Jarvis to číta pri každom štarte. |
| `ludia/Meno Priezvisko.md` | Jeden človek = jedna poznámka. |
| `projekty/Názov.md` | Jeden projekt = jedna poznámka. |
| `ciele/Názov.md` | Cieľ a jeho kroky. |
| `dennik/RRRR-MM-DD.md` | Jeden deň = jedna poznámka. |
| `poznamky/` | Všetko ostatné: nápady, zápisky, importované poznámky. |
| `ulohy.md` | Zoznam úloh. |
| `kalendar.md` | Udalosti. |
| `schranka/` | Výstupy rutín: ranné briefy, večerné zhrnutia. |
| `pripomienky.md` | Pripomienky s časom. Jarvis ich v danú minútu povie sám. |
| `prilohy/` | Súbory, ktoré si Jarvisovi pretiahol do okna (fotky, dokumenty). |
| `archiv/` | Naimportované rozhovory z tvojich exportov (Instagram, WhatsApp, ChatGPT…). Jarvis v nich vie hľadať. |
| `ludia/_fotky/` | Fotky ľudí, vybrané z tvojich exportov. |

Ďalšie priečinky si môžeš pridať sám. Priečinky `knihy`, `filmy`, `miesta`, `hudba`, `skola`, `zdroje` a `content`
dostanú v 3D svete HUD vlastný mesiac.

## Formáty

Hlavička medzi `---` na začiatku poznámky je voliteľná. Jarvis z nej číta pár polí.

**Človek** (`ludia/Jana Nováková.md`)

```markdown
---
vztah: rodina
narodeniny: 1990-05-12
---
# Jana Nováková

Sestra. Býva v Žiline, učí na gymnáziu.

## Zapamätané

- 2026-01-15: Má rada turistiku.
```

`vztah` je ľubovoľné slovo (rodina, priateľ, kolega, klient). `narodeniny` môžu byť aj bez roku: `05-12`.

**Projekt** (`projekty/Nový web.md`): pole `stav` má hodnotu `aktívny`, `pozastavený`, `hotový` alebo `nápad`.

**Cieľ** (`ciele/Zabehnúť polmaratón.md`)

```markdown
---
stav: aktívny
---
# Zabehnúť polmaratón

Do jari zabehnúť 21 km pod dve hodiny.

- [x] Kúpiť bežecké topánky
- [ ] Zabehnúť 15 km
- [ ] Prihlásiť sa na preteky
```

**Denník** (`dennik/2026-01-31.md`)

```markdown
---
spanok: 7.5
nalada: 4
---
- Dokončil som návrh loga.

## Zhrnutie dňa

Ráno som mal hovor s klientom, popoludní som pracoval na webe.
```

`spanok` sú hodiny (7.5 alebo 7:30), `nalada` je číslo 1 až 5. Stačí Jarvisovi povedať „spal som sedem hodín" a zapíše to.
S pripojenými hodinkami Garmin (`docs/GARMIN.md`) pribudnú v hlavičke dňa polia `spanok_zdroj: garmin`, `spanok_skore`, `spanok_fazy`, `zaspal`, `vstal`, `hrv`, `tep_pokoj`, `bateria`, `bateria_rano`, `kroky`, `stres`, `pripravenost` a tréningy pod nadpisom `## Tréning`. Spánok, ktorý povieš alebo prepíšeš sám, Garmin neprepíše.

**Úlohy** (`ulohy.md`)

```markdown
# Úlohy

## Práca
- [ ] Poslať faktúru (do 2026-02-05)
- [x] Zavolať účtovníčke
```

Termín je voliteľný, píše sa ako `(do RRRR-MM-DD)`.

**Kalendár** (`kalendar.md`)

```markdown
# Kalendár

## Udalosti

- 2026-02-03 14:00-15:00 Zubár @ Poliklinika
- 2026-02-14 Výročie
- po 10:00-11:30 Angličtina
```

Riadok začína dátumom alebo dňom v týždni (`po ut st št pi so ne`, opakuje sa každý týždeň). Čas a miesto za `@` sú voliteľné.
Kalendár z Googlu alebo iCloudu sa dá pripojiť aj priamo cez tajnú adresu iCal v súbore `.env` (`CALENDAR_ICS_URL`).

**Pripomienky** (`pripomienky.md`)

```markdown
# Pripomienky

- [ ] 2026-02-03 15:00 Zavolať mame
- [x] 2026-02-01 09:00 Zaplatiť nájom
```

Riadok má dátum, čas a text. Keď čas nastane, Jarvis to povie nahlas a riadok odškrtne. Výkričník pred textom
(`!Lekár`) znamená, že ti v ten čas aj zavolá na mobil, ak máš nastavené hovory (`docs/HOVORY.md`).
Stačí mu povedať „pripomeň mi zajtra o tretej zavolať mame".

**Človek s rozhovormi.** Po importe exportov pribudne ľuďom v hlavičke `zdroje` (odkiaľ sú ich rozhovory)
a `fotka`, a v poznámke odsek „Kto to je" a sekcia `## Konverzácie`. Samotné správy sú v `archiv/`
a do poznámok sa neprepisujú.

## Prepojenia

Keď v texte napíšeš `[[Jana Nováková]]` alebo `[[Nový web]]`, Jarvis vie, že poznámky spolu súvisia.
V 3D svete sa medzi nimi nakreslí spojnica.
