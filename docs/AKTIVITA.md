# Záznam aktivity: z čoho Jarvis píše denník

Aby Jarvis večer vedel napísať, čo si cez deň naozaj robil, a aby vedel odpovedať na „čo som dnes robil" alebo
„koľko som dnes hral", zapisuje si raz za minútu jednu vec: **ktorá appka je práve v popredí**. Nič viac.

Všetko ostáva v tvojom počítači, v priečinku `data/activity/`. Do gitu sa to neukladá a nikam sa to neposiela.

## Čo sa zapisuje

Jedna vzorka je jeden riadok:

```json
{"t":1794955662,"o":60,"src":"hud","d":60,"st":"active","idle":1,"app":"Visual Studio Code","id":"com.microsoft.VSCode"}
```

| Pole | Čo znamená |
|---|---|
| `t`, `o` | čas vzorky (sekundy) a časové pásmo |
| `src`, `d` | kto vzorku zapísal (`hud` raz za minútu, `pulse` raz za pár minút) a koľko sekúnd za ňu smie počítať |
| `st` | `active` (píšeš alebo hýbeš myšou), `passive` (nič nestláčaš, ale beží film, hovor alebo hra), `idle` (bez vstupu dlhšie ako 5 minút), `locked` (zamknutá obrazovka) |
| `idle` | sekundy od posledného stlačenia klávesu alebo pohybu myši |
| `app`, `id` | názov appky v popredí a jej identifikátor |
| `game` | názov hry, keď je appka v popredí hra, ktorú Jarvis pozná |
| `priv` | v popredí bola súkromná appka. Jej názov sa nezapíše |

## Čo sa nezapisuje nikdy

- obsah okien, text, ktorý píšeš, stlačené klávesy,
- snímky obrazovky, schránka,
- adresy stránok ani názvy kariet v prehliadači,
- názvy okien (pokiaľ si ich sám nezapneš, pozri nižšie),
- názvy súkromných appiek: správcovia hesiel (1Password, Bitwarden, KeePass, Kľúčenka…) sú na zozname vždy, ďalšie si pridáš.

Jarvis teda vie, že si bol tri hodiny vo VS Code. Nevie, čo si tam písal. Čo presne sa robilo, skladá večer z ďalších
vecí, ktoré má aj tak v počítači: commity z dnešného dňa (číta ich z priečinka `.git`, git nespúšťa), názvy súborov
zmenených dnes na Ploche, v Dokumentoch a v Stiahnutých (len názvy, obsah nie), rozhovor s Jarvisom a kalendár.

## Kto zapisuje

- **HUD** každú minútu, kým beží (spúšťa sa po prihlásení).
- **Pulz** raz za pár minút, aj keď je HUD zatvorený. Keď HUD beží, pulz nezapisuje nič, aby sa čas nepočítal dvakrát.
  Minúty známe len z pulzu sú v prehľade označené ako odhad.
- Keď počítač spí alebo je vypnutý, nezapisuje nikto. V prehľade je to „bez záznamu", Jarvis si ten čas nedomýšľa.

Na Macu sa appka v popredí číta zo systému (`lsappinfo`, `ioreg`), bez povolenia Prístupnosť aj bez Nahrávania
obrazovky, a okno, v ktorom pracuješ, sa pri tom nijako neruší. Na Windows beží na pozadí malý skrytý pomocník
(`hud/server/activity-helper.ps1`). Na Linuxe to funguje len s X11 a nástrojmi `xdotool` a `xprintidle`.

Pred úvodným nastavením (`štart`) sa nezapisuje nič.

## Čo z toho vznikne

- **Denník.** Večerná rutina si pustí `node scripts/activity.mjs today --json` a z prehľadu, rozhovoru, kalendára
  a zmien v pamäti napíše `memory/dennik/RRRR-MM-DD.md`. Odhady píše ako odhady a súkromné appky nespomína.
- **Odpovede.** V HUD sa opýtaj „čo som dnes robil?", „koľko som dnes hral?", „kedy som dnes začal?".

Pri večernej rutine a pri týchto otázkach číta prehľad dňa (súčty po appkách, nie surové vzorky) Claude, rovnako
ako číta tvoju pamäť. Surový záznam z počítača neodchádza.

## Príkazy

| Príkaz | Čo robí |
|---|---|
| `node scripts/activity.mjs status` | či je záznam zapnutý, koľko dní je uložených, čo by zapísal práve teraz |
| `node scripts/activity.mjs today` | dnešok: appky, druhy práce, dlhšie úseky, hry, prestávky, commity, súbory |
| `node scripts/activity.mjs yesterday` / `day 2026-11-16` | iný deň |
| `node scripts/activity.mjs off` / `on` | vypne alebo zapne zapisovanie |
| `node scripts/activity.mjs purge all` | zmaže všetko, čo je uložené |
| `node scripts/activity.mjs purge 2026-11-16` | zmaže jeden deň |
| `node scripts/activity.mjs purge --older 30` | zmaže dni staršie ako 30 dní |
| `node scripts/activity.mjs games` | hry nájdené v počítači zo všetkých obchodov, s odohraným časom, kde ho obchod ukladá |

Každý príkaz vie aj `--json`.

## Ako to vypnúť alebo zmazať

Povedz Jarvisovi „vypni záznam aktivity" (v HUD alebo v Claude). Alebo sám: `node scripts/activity.mjs off`.
Uložené dni tým ostanú. Zmažeš ich príkazom `node scripts/activity.mjs purge all`, alebo to povedz Jarvisovi v Claude („zmaž záznam aktivity").
Môžeš aj jednoducho zmazať súbory v `data/activity/`, sú to obyčajné textové súbory.

## Nastavenie

V `config/jarvis.json`:

```json
"activity": { "enabled": true, "titles": false, "retentionDays": 90, "idleMinutes": 5, "ignore": ["Moja banka"] }
```

| Kľúč | Čo robí |
|---|---|
| `enabled` | `false` zapisovanie vypne |
| `retentionDays` | po koľkých dňoch sa staré dni samy zmažú (predvolene 90) |
| `idleMinutes` | po koľkých minútach bez klávesnice a myši sa čas počíta ako prestávka (predvolene 5) |
| `ignore` | appky, ktorých názov sa nemá zapisovať. Stačí názov, ako ho vidíš v systéme. Platí aj spätne: v prehľadoch sa neukážu ani staršie záznamy |
| `titles` | `true` pridá názvy okien, len pri prehliadačoch a editoroch a len na Windows. Názvy okien obsahujú súkromné veci (predmet mailu, názov stránky), preto je to vypnuté. Na Macu sa názov okna bez ďalších povolení zistiť nedá, takže sa tam nezapisuje |

Záznam sa dá vypnúť aj premennou `JARVIS_ACTIVITY=0` v súbore `.env`.

## Hry

Aby Jarvis vedel, že appka v popredí je hra, raz denne si prejde herné obchody v počítači: Steam (všetky knižnice),
Epic Games, GOG Galaxy, Battle.net, Riot (League of Legends, Valorant), EA app, Ubisoft Connect, Xbox, itch.io,
Rockstar, Heroic, Minecraft (aj Prism, MultiMC, CurseForge, Modrinth, ATLauncher), Roblox a známe hry nainštalované
samostatne. Odohraný čas si v počítači ukladajú len Steam, GOG Galaxy, itch, Heroic, Prism a Modrinth. Pri ostatných
(Epic, Riot, Battle.net, EA, Ubisoft, Xbox, Rockstar) ho meria až tento záznam, odo dňa, keď beží.

## Čo záznam nevie

- Čo si v appke robil. Vidí len jej názov.
- Či si pri počítači bol, keď si päť minút nič nestlačil a nebežal film, hovor ani hra. Počíta to ako prestávku.
- Čas pred tým, než si Jarvisa nainštaloval, a čas, keď HUD ani pulz nebežali.
- Čo si robil na mobile alebo inom počítači.
- Ktoré úlohy si odškrtol ručne. Súbor `ulohy.md` nemá dátum dokončenia, Jarvis vie len o tých, ktoré odškrtol sám.
