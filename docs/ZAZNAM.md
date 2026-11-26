# Záznam a pohľad na obrazovku

Dve veci, ktoré má Jarvis od začiatku každý: vidí, na čo sa práve pozeráte, a vie nahrávať.

## Čo je na obrazovke

Stačí povedať „čo to je", „odpíš na toto", „ulož si toto", „vysvetli mi tento graf" alebo „prelož mi to". Nič
nekopírujete. Jarvis si odfotí okno, na ktoré sa pozeráte (predné okno, ktoré nie je on sám), a keď také nie je, celú
obrazovku. Potom odpovie alebo spraví, čo chcete:

- „čo to je", „vysvetli mi tento graf": vysvetlí to,
- „prelož mi to": preloží,
- „ulož si toto": zapíše si to do pamäte,
- „odpíš na toto": pripraví odpoveď a ukáže vám ju. Odošle ju až po vašom „áno", ako všetko, čo ide k iným ľuďom.

Keď hovoríte o označenom texte, Jarvis si na Macu prečíta aj ten: najprv cez Prístupnosť, a keď to appka nedovolí,
cez schránku, ktorej pôvodný obsah hneď vráti. Na Windows zatiaľ vidí len snímku.

Čo treba: na Macu povolenie **Nahrávanie obrazovky a zvuku** pre program, v ktorom Jarvis beží (Jarvis HUD, node alebo
Terminál): Nastavenia systému → Súkromie a bezpečnosť → Nahrávanie obrazovky a zvuku. Príkaz
`node scripts/control.mjs ask` to okno otvorí. Na označený text ešte **Prístupnosť** v tom istom okne. Na Windows nič.

Snímky sú v `data/screen/` na tomto počítači a po dni sa samy zmažú. Snímku číta AI, na ktorej Jarvis beží (Claude,
ChatGPT alebo Gemini), tak ako všetko, o čom sa s ňou rozprávate. Nikam inam nejde.

## Záznam

„Počúvaj ma", „nahrávaj", „zapni záznam", alebo klik na čip **Záznam** hore. Jarvis nahráva mikrofón aj obrazovku a
medzitým s vami normálne hovorí: pýtajte sa, zadávajte mu veci, záznam beží ďalej. Nie je to pomocník na porady, nič
do rozhovoru nevkladá sám. Kým nahráva, čip svieti na červeno s časom (na telefóne malá bodka nad riadkom na písanie).
Keď sa záznam nespustil klikom na tejto obrazovke (hlasom alebo v rozhovore, z mobilu, príkazom), príde na počítači
aj oznámenie „Jarvis nahráva mikrofón a obrazovku" s tým, ako sa spustil.

„Stačí", „ukonči záznam" alebo druhý klik na čip záznam ukončí. Potom Jarvis na pozadí:

1. dokončí prepis,
2. napíše poznámku do `memory/zaznamy/RRRR-MM-DD-<názov>.md`: o čom to bolo, rozhodnutia, úlohy, termíny, otvorené
   otázky, s odkazmi na ľudí a projekty z pamäte (`[[Meno]]`),
3. vaše úlohy zapíše do `memory/ulohy.md`, čo má presný čas, do `memory/pripomienky.md`,
4. stretnutia a termíny do `memory/kalendar.md`, a keď má pripojený váš kalendár, aj tam,
5. pripraví návrhy správ a mailov, ktoré z toho vyplývajú. Pošle ich až po vašom „áno".

Keď je hotovo, povie to a na ploche je karta s tým, čo spravil a čo čaká na vás.

Z príkazového riadku:

```bash
node scripts/record.mjs start "Porada s Petrom"   # začne (názov je voliteľný)
node scripts/record.mjs stop                      # skončí
node scripts/record.mjs status                    # čo beží
node scripts/record.mjs list                      # posledné záznamy a ich stav
node scripts/record.mjs finish 2026-11-26-1432    # spracovanie znova (prerušený alebo nepodarený záznam)
```

### Čo sa nahráva

- **Zvuk**: mikrofón, ktorý používa okno Jarvisa (rovnaký ako pri medzerníku). Nahráva ho okno, takže okno Jarvisa
  musí byť otvorené. Keď je otvorených viac okien, nahráva len jedno.
- **Obrazovka**: v Chrome a Edge sa po kliku na čip spýta, čo zdieľať, a nahráva video. Inde (appka Jarvis HUD, Safari,
  spustenie hlasom, alebo keď zdieľanie odmietnete) si Jarvis každých pár sekúnd odfotí okno, na ktoré sa pozeráte.
  Rovnaké snímky sa neukladajú dvakrát.
- **Prepis**: lokálny Whisper (`docs/HLAS.md`) prepisuje priebežne po polminútach, nič z toho neodchádza z počítača.
  Kým hovoríte s Jarvisom cez medzerník, prepis záznamu počká. Miesta, kde ste hovorili s Jarvisom, sú v prepise
  označené. Bez lokálneho Whispera sa zvuk uloží, ale prepis nebude.

### Nič sa nestratí

Všetko sa ukladá hneď, po kúskoch zhruba päť sekúnd. Keď spadne prehliadač, zavrie sa okno alebo vypadne prúd,
chýba najviac posledný kúsok. Okno, ktoré sa znova otvorí, nahráva ďalej do toho istého záznamu. Keď sa Jarvis
reštartuje uprostred záznamu, počká, či okno pokračuje; keď nie, záznam ukončí ako prerušený a spracuje, čo sa uložilo.
Keď je okno Jarvisa zavreté dvadsať minút a nič neprichádza, záznam sa ukončí sám.

Disk: stav ukazuje veľkosť. Pod 2 GB voľného miesta Jarvis upozorní, pod 0,5 GB prestane nahrávať obrazovku a pod
0,2 GB záznam ukončí. Hodina zvuku zaberie počas nahrávania okolo 115 MB a po skončení sa zbalí na okolo 20 MB, video
obrazovky najviac okolo 200 MB za hodinu.

### Kde to je

Všetko je v `data/recordings/<začiatok>/` na tomto počítači:

| Súbor | Čo je v ňom |
|---|---|
| `transcript.md` | Prepis s časmi. |
| `zvuk.m4a` | Celý zvuk (po skončení, keď je k dispozícii ffmpeg; inak ostanú kúsky v `audio/`). |
| `screen/video-1.webm` | Video obrazovky z Chrome alebo Edge. |
| `screen/shots/` | Snímky obrazovky, keď video nie je. Názov je čas od začiatku v milisekundách. |
| `frames/` | Pár snímok z videa pre spracovanie. |
| `session.json`, `chunks.jsonl` | Stav záznamu. |

Nič z toho neodchádza z počítača. Po skončení dostane AI, na ktorej Jarvis beží, prepis a pár snímok, aby z nich
napísala poznámku, rovnako ako pri každom rozhovore s ňou. Záznam zmažete tak, že zmažete jeho priečinok.

## Pre toho, kto Jarvisa stavia

- Snímka obrazovky: `hud/server/screen.mjs` (macOS `screencapture`, okno podľa `CGWindowList`, Windows PowerShell
  s .NET a `PrintWindow`). Hlasový nástroj `screen_look` je v `hud/server/mcp/computer.mjs` a vracia obrázok aj cestu.
- Záznam: server `hud/server/record.mjs`, stránka `hud/public/js/record.js`, hlasové nástroje `record_start`,
  `record_stop`, `record_status` v `hud/server/mcp/jarvis-hud.mjs`. Rozhranie je v `docs/API.md`, časť Record mode.
- Spracovanie po konci je obyčajná úloha na pozadí; jej zadanie skladá `afterActionsPrompt()` v `record.mjs`. Dlhý
  prepis dostane po častiach (`prepis-1.md`, `prepis-2.md` …).
- `.env`: `JARVIS_RECORD_SHOT_MS` (ako často snímka obrazovky, predvolene 8000), `JARVIS_RECORD_RECOVER_MS` (ako dlho
  po reštarte čakať na okno, predvolene 45000), `JARVIS_RECORD_KEEP_WAV=1` (nechať kúsky zvuku aj po skončení).
