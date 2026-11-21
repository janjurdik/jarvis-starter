# JARVIS

Tento priečinok je Jarvis, osobný AI asistent. Všetko, čo potrebuješ vedieť (kto si, ako sa Jarvis nastavuje,
ako rastie a ako s používateľom hovoriť), je v súbore `AGENTS.md`. Prečítaj si ho celý a riaď sa ním. Platí pre
každú AI, ktorá tento priečinok otvorí.

## Pre Antigravity

Ak si Antigravity (Antigravity CLI `agy` alebo aplikácia Antigravity), Jarvis ťa pozná ako svoj mozog, rovnako ako
Claude a ChatGPT. Spoznáš to aj podľa toho, že príkazy, ktoré spúšťaš, majú v prostredí premennú `ANTIGRAVITY_AGENT`.

- Keď používateľ napíše `štart`, postupuj podľa `AGENTS.md` a v príkaze prípravy (`node scripts/setup.mjs`) použi
  `--ai antigravity`.
- Prihlásenie je tvoje vlastné. Používateľ je v Antigravity prihlásený účtom Google a Jarvis toto prihlásenie len
  použije, sám žiadne heslo ani kód nevidí. Keď príprava napíše, že Antigravity nie je prihlásený, spusti
  `node scripts/antigravity.mjs login`: otvorí sa prehliadač s prihlásením Google, používateľ sa prihlási a potvrdí
  prístup. Heslo ani kód si do rozhovoru nikdy nepýtaj.
- Či je všetko v poriadku, povie `node scripts/antigravity.mjs status`.
- Mail a kalendár sa pripájajú ako MCP servery: príkaz `/mcp` alebo súbor `~/.gemini/config/mcp_config.json`.
  Čo je pripojené tam, vidia aj rutiny a úlohy na pozadí.
- Model a úroveň premýšľania sa dajú zmeniť v `.env` (`docs/MODELY.md`).

## Iný agent z rodiny Gemini

Ak nie si Antigravity (napríklad Gemini CLI), hotovú podporu pre teba Jarvis nemá. Povedz to používateľovi na
rovinu a ponúkni mu dve cesty: nainštalovať si Antigravity CLI (https://antigravity.google), alebo si podporu
postaviť podľa `docs/MODELY.md` (jeden záznam v `hud/server/provider.mjs`).
