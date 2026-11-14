# Jarvis na Windows

Na Windows beží Jarvis rovnako ako na Macu, len namiesto natívnej appky na ploche používa okno prehliadača
na celú obrazovku. Všetko ostatné (pamäť, hlas, rutiny) funguje rovnako.

## Čo treba

- Windows 10 alebo 11
- Node.js 20 alebo novší: `winget install OpenJS.NodeJS.LTS`
- Claude Code: v PowerShelli `irm https://claude.ai/install.ps1 | iex`, potom `claude` a prihlásenie. Ak si vypýta Git for Windows, nainštaluj ho cez `winget install Git.Git`.
- Microsoft Edge (je vo Windows) alebo Google Chrome
- voliteľne `uv` pre pekný hlas: `irm https://astral.sh/uv/install.ps1 | iex`

Po inštalácii nových programov zavri a znova otvor Claude aj PowerShell, aby ich videli.

## HUD ako plocha

```
node scripts\hud.mjs
```

Spustí server a otvorí HUD v samostatnom okne Edge (alebo Chrome) bez panelov, na celú obrazovku.

- **F11** prepína celú obrazovku, **Alt+F4** okno zavrie.
- Okno si pripni na panel úloh (pravý klik na ikonu → Pripnúť).
- Na druhom monitore: presuň okno tam (Win+Shift+šípka) a stlač F11. HUD potom žije na jednom monitore a pracuješ na druhom.
- Hlas funguje hneď: podrž medzerník a hovor. Pri prvom raze povoľ mikrofón.

Okno používa vlastný profil prehliadača v `data\browser-profile`, takže sa nemieša s tvojím bežným prehliadaním
a povolenie mikrofónu si pamätá.

## Spúšťanie po prihlásení

```
node scripts\autostart.mjs install
```

Do tvojho priečinka Po spustení (`shell:startup`) pridá malý súbor `Jarvis HUD.vbs`, ktorý po prihlásení spustí HUD
bez čierneho okna. Vypnutie: `node scripts\autostart.mjs remove`.

## Rutiny

```
node scripts\schedule.mjs install
```

Zaregistruje rutiny v Plánovači úloh v priečinku `Jarvis`. Uvidíš ich, keď otvoríš „Plánovač úloh" (Task Scheduler).
Bežia pod tvojím účtom, len keď si prihlásený, a zmeškaná rutina sa spustí po zobudení počítača.
Odstránenie: `node scripts\schedule.mjs remove`.

## Časté problémy

- **`npm` hlási chybu o skriptoch v PowerShelli:** použi `npm.cmd install`, alebo príkazy v tvare `node scripts\…`.
- **`claude` sa nenašiel:** zavri a otvor PowerShell. Inštalátor ho dáva do `%USERPROFILE%\.local\bin`.
- **Okno sa neotvorilo:** otvor v Edge adresu `http://localhost:4545` a stlač F11.
- **Windows Defender sa pýta na Node.js a sieť:** HUD beží len na tvojom počítači (localhost), prístup zo siete môžeš zamietnuť.
