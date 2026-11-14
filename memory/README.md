# Pamäť Jarvisa

Tento priečinok je všetko, čo o tebe Jarvis vie. Sú to obyčajné textové súbory (markdown) na tvojom počítači.
Môžeš ich čítať, upravovať aj mazať v ľubovoľnom editore, napríklad v Obsidiane. Nič z toho neodchádza na žiadny server,
a do gitu sa tento priečinok neukladá.

Pamäť sa napĺňa tromi spôsobmi: pri úvodnom nastavení (`štart`), počas rozhovorov (Jarvis si zapisuje, čo sa dozvie)
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

## Prepojenia

Keď v texte napíšeš `[[Jana Nováková]]` alebo `[[Nový web]]`, Jarvis vie, že poznámky spolu súvisia.
V 3D svete sa medzi nimi nakreslí spojnica.
