# Orby

Každá väčšia vec v živote používateľa je na ploche jeden orb: planéta v 3D svete s číslom na pohľad a s vlastným
vnútrom. Orby nie sú napevno. Pribúdajú, keď je v nich čo ukázať, miznú, keď ich človek nepoužíva, a Jarvis si
pridáva vlastné, keď ho o niečo požiadajú. Na nový prehľad netreba písať žiadnu obrazovku: stačí opísať, čo má
byť vidieť, a obrazovka si to poskladá z hotových dielov.

## Ktoré orby sú na ploche

| Orb | Kedy ho vidno |
|---|---|
| Tvoje appky, Pošta, Kalendár, Úlohy, Rutiny, Ľudia, Poznámky | vždy, je to základ |
| Ciele, Spánok, Denník, Projekty, Rozhovory | keď v nich niečo je |
| Škola, Knihy, Filmy, Hudba, Miesta, Zdroje, Obsah, Hry | keď v pamäti existuje priečinok s tým menom a nie je prázdny |
| vlastné | keď ich Jarvis alebo používateľ pridá |

Ktorýkoľvek orb okrem Tvojich appiek sa dá skryť a vrátiť. Kruh sa po každej zmene sám prerovná.

## Príkazy

```
node scripts/orb.mjs list
node scripts/orb.mjs add financie --label "Financie" --icon chart --color "#9affc8"
node scripts/orb.mjs add navyky --label "Návyky" --moon            malý mesiac pri jadre namiesto planéty
node scripts/orb.mjs add recepty --label "Recepty" --folder recepty   vnútri sú poznámky z memory/recepty/
node scripts/orb.mjs set financie --file obsah.json                čo orb ukazuje
node scripts/orb.mjs clear financie
node scripts/orb.mjs hide spanok
node scripts/orb.mjs show spanok
node scripts/orb.mjs remove financie
node scripts/orb.mjs shapes                                        dostupné hologramy a ikony
```

Na ploche to isté robí Jarvis nástrojom `hud_orb`, keď mu to človek povie („pridaj mi orb na financie",
„školu tam nepotrebujem"). Otvorená plocha sa prekreslí hneď, bez reštartu.

Vlastný orb má `id` (malé písmená, číslice, pomlčky), názov do 24 znakov, ikonu, farbu `#rrggbb` a hologram (`shape`):
`orb`, `posta`, `ludia`, `skola`, `knihy`, `filmy`, `miesta`, `hudba`, `satnik`, `zdroje`, `hry`, `ulohy`, `content`,
`kalendar`, `rutiny`, `projekty`, `questy`, `spravy`, `fotky`, `udalosti`, `spanok`.

## Čo orb ukazuje

Obsah orbu je jeden súbor JSON (`data/orbs/<id>.json`, zapisuje ho `orb.mjs set` alebo `hud_orb` s akciou `content`).
Vlastný obsah môže mať aj vstavaný orb: stráž pošty takto plní Poštu.

```json
{
  "value": "3",
  "sub": "čakajú na odpoveď",
  "alert": true,
  "panel": [
    { "type": "stat", "label": "Pretriedené dnes", "value": "42", "unit": "mailov", "caption": "od rána" },
    { "type": "bars", "title": "Kam išli", "items": [
      { "label": "Čaká na teba", "value": 3, "accent": "amber" },
      { "label": "Počká", "value": 12 },
      { "label": "Šum", "value": 27 }
    ] },
    { "type": "list", "title": "Čaká na teba", "items": [
      { "label": "Ponuka od tlačiarne", "sub": "Peter K., chce odpoveď do piatka", "value": "dnes", "accent": "amber", "say": "Priprav odpoveď na ponuku od tlačiarne." }
    ] },
    { "type": "actions", "items": [ { "label": "Pretrieď znova", "say": "Pretrieď mi poštu." } ] }
  ],
  "items": [
    { "t": "Ponuka od tlačiarne", "s": "Peter K.", "g": "čaká na teba", "imp": 0.9 },
    { "t": "Newsletter", "s": "obchod", "g": "šum", "imp": 0.1 }
  ]
}
```

- `value` a `sub`: číslo a krátky text pri orbe vo svete. `alert: true` znamená, že si pýta pozornosť.
- `panel`: komponenty, ktoré sa ukážu vnútri orbu (najviac 12).
- `items`: body vo vnútornom vesmíre orbu, zoskupené podľa `g`. Každý mail, každá faktúra, každý návyk môže byť
  jedna hviezda; dôležitejšie (`imp` od 0 do 1) sú väčšie a bližšie. Klik na bod ukáže `t`, `s` a voliteľný `text`.
- S `--folder` sa k tomu pridajú poznámky z priečinka v pamäti.

### Komponenty

| `type` | Polia | Na čo |
|---|---|---|
| `stat` | `label`, `value`, `unit?`, `caption?`, `accent?` | jedno veľké číslo |
| `ring` | `label`, `value` (0 až 100), `caption?`, `accent?` | plnenie cieľa v percentách |
| `bars` | `title?`, `items: [{ label, value, accent? }]` | porovnanie pár hodnôt |
| `spark` | `title?`, `series: [{ label, value }]` | vývoj v čase (do 31 bodov) |
| `list` | `title?`, `items: [{ label, sub?, value?, accent?, say? }]` | zoznam vecí, riadok môže byť tlačidlo |
| `steps` | `title?`, `items: [{ text, done }]` | kroky, hotové sú prečiarknuté |
| `text` | `title?`, `text` | krátka poznámka |
| `actions` | `items: [{ label, say }]` | tlačidlá |

`accent` je `ice` (bežné), `amber` (pozornosť), `red` (problém) alebo `green` (v poriadku).
`say` je veta, ktorú klik pošle Jarvisovi, akoby ju človek povedal. Tak sa z panelu stáva malá aplikácia:
riadok „Ponuka od tlačiarne" s `say` je tlačidlo, ktoré spustí prípravu odpovede.

Texty sa skracujú na rozumnú dĺžku a nikdy sa neberú ako značky ani kód. Čomu obrazovka nerozumie, to vynechá.

## Ako z toho postaviť novú vec

1. Orb: `node scripts/orb.mjs add <id> --label "…"`.
2. Kto ho plní: rutina alebo stráž v `routines/<id>.md`, ktorá na konci zapíše obsah (`node scripts/orb.mjs set <id> --file …`),
   a záznam v `config/jarvis.json`. Vzor je `routines/straz-posty.md`.
3. Dôležité veci nech rutina aj povie (riadok `HLAS:`), ostatné stačí ukázať v orbe.

Príklad, triedenie pošty: stráž každú hodinu prejde nové maily, tri dôležité ohlási hlasom a kartou, zvyšok len
spočíta. Orb Pošta ukazuje „3 čakajú", vnútri je počet pretriedených, stĺpce podľa druhu a zoznam toho, čo čaká,
kde každý riadok vie jedným klikom pripraviť odpoveď.
