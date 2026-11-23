# Na akej AI Jarvis beží

Jarvis nemá vlastný model. Riadi programovacieho agenta, ktorého už máš, cez tvoje predplatné a bez API kľúčov.

| | Čo treba | Ako sa správa |
|---|---|---|
| **Claude** (Claude Code) | Claude Pro alebo Max, `claude` prihlásený | Odpoveď prichádza po slovách, hlas je najrýchlejší. Konektory z Claude (Gmail, kalendár) vidia aj rutiny. |
| **ChatGPT** (Codex) | ChatGPT Plus alebo Pro, `codex login` | To isté jadro, pamäť aj nástroje. Odpoveď prichádza po celých vetách, prvý zvuk o pár sekúnd neskôr. |
| **Gemini** (Antigravity) | Účet Google (ide aj bezplatný plán, s Google AI Pro alebo Ultra vydrží dlhšie), Antigravity prihlásený | To isté jadro, pamäť aj nástroje. Odpoveď prichádza po slovách ako pri Claude, každá začne o dve až päť sekúnd neskôr. MCP servery z Antigravity vidia aj rutiny. |

Vyberá sa to samo: podľa toho, v čom si napísal `štart` (`node scripts/setup.mjs --ai claude`, `--ai codex` alebo
`--ai antigravity`). Keď nie je nič nastavené, Jarvis skúsi Claude, potom Codex a potom Antigravity.
Zmeniť sa to dá kedykoľvek:

```
JARVIS_AI=codex        v súbore .env, alebo "ai": "codex" v config/jarvis.json (rovnako claude alebo antigravity)
node scripts/hud.mjs --restart
```

Ďalšie voľby v `.env`: `JARVIS_MODEL` (model hlasového mozgu na Claude: `sonnet`, `opus`, `haiku`), `JARVIS_JOB_MODEL`
(model pre rutiny a úlohy na pozadí), `JARVIS_CODEX_MODEL` a `JARVIS_CODEX_EFFORT` (to isté pre Codex).

### Antigravity

Jarvis hľadá Antigravity v tomto poradí: cesta z `JARVIS_ANTIGRAVITY_BIN`, potom príkaz `agy` (Antigravity CLI),
potom samostatný server Antigravity, ktorý si stiahla aplikácia T3 Code. Rozpráva sa s ním cez ACP (príkaz `agy acp`),
preto dostane Jarvisove nástroje a osobnosť bez toho, aby Jarvis čokoľvek zapisoval do tvojich nastavení Antigravity.

Prihlásenie patrí Antigravity. Jarvis nikdy nevidí heslo ani kód, len sa agenta spýta, či vie pracovať:

```
node scripts/antigravity.mjs status     je nainštalovaný a prihlásený?
node scripts/antigravity.mjs login      otvorí prihlásenie Google v prehliadači
```

Kto má Antigravity CLI a je v ňom prihlásený, nemusí robiť nič. Kto má len server z inej aplikácie (napríklad
z T3 Code), prihlási sa raz cez `login`: tá aplikácia si svoje prihlásenie drží pre seba. Druhá cesta je riadok
`JARVIS_ANTIGRAVITY_HOME=t3` v `.env`, ktorý použije prihlásenie z T3 Code bez ďalšieho prihlasovania.

Voľby v `.env`:

| Premenná | Na čo je |
|---|---|
| `JARVIS_AI=antigravity` | Jarvis beží na Antigravity |
| `JARVIS_ANTIGRAVITY_MODEL` | model hlasového mozgu, napríklad `gemini-3.8-flash` alebo `gemini-4-neon`. Bez nastavenia predvolený model Antigravity. |
| `JARVIS_ANTIGRAVITY_EFFORT` | úroveň premýšľania hlasového mozgu: `low` (predvolené, najrýchlejšie), `medium`, `high`, pri niektorých modeloch `xhigh` |
| `JARVIS_ANTIGRAVITY_BIN` | cesta k `agy` alebo k serveru `agy_acp_server`, keď ho Jarvis nenájde sám |
| `JARVIS_ANTIGRAVITY_HOME` | iný priečinok profilu Antigravity než `~/.gemini`. Hodnota `t3` použije profil a prihlásenie z aplikácie T3 Code (Jarvis potom píše svoje rozhovory do jej profilu). |

Model, ktorý tvoj účet nemá, Jarvis preskočí a beží na predvolenom. Aké modely máš, ukáže `agy models`.

## Model podľa úlohy

Rozhovor na ploche beží stále na jednom modeli, aby bol rýchly. Úlohy na pozadí si model vyberajú podľa toho, aké sú ťažké:

| Úloha | Príklad | Claude | ChatGPT (Codex) | Gemini (Antigravity) |
|---|---|---|---|---|
| ľahká | pozrieť poštu, kalendár, niečo zistiť, zhrnúť | Haiku | krátke premýšľanie | Gemini 3.8 Flash |
| bežná | všetko medzi tým | Sonnet | bežné premýšľanie | tvoj predvolený model |
| náročná | vytvoriť, napísať, naprogramovať, analyzovať | Opus | dôkladné premýšľanie | Gemini 4 Neon |

Náročnosť určí Jarvis sám a potichu, keď úlohu spúšťa. Nehovorí o nej, pri úlohe je len malým písmom názov modelu, ktorý na nej pracuje (v riadku nad príkazovým riadkom a v detaile úlohy).
Zmeniť sa to dá v Nastaveniach → Mozog (Automaticky, Najsilnejší, Najrýchlejší), alebo v `config/jarvis.json` kľúčom
`"routing": "auto" | "heavy" | "light"`. Riadok `JARVIS_JOB_MODEL=<model>` v `.env` routing vypne a všetko beží na tom jednom modeli.
Rutina s vlastným `model` v `config/jarvis.json` si ho drží. Pravidlá sú v `hud/server/routing.mjs`, modely jednotlivých
agentov v ich zázname v `hud/server/provider.mjs` (`tiers` alebo `efforts`).

## Kde to v kóde je

Všetko, čo sa medzi agentmi líši, je na dvoch miestach:

- `hud/server/provider.mjs`: ako sa spúšťa celý beh agenta (úlohy na pozadí a rutiny) a ako sa číta jeho priebeh.
  Každý agent je jeden záznam v `PROVIDERS` s tromi funkciami: `args` (argumenty príkazu), `stdin` (čo dostane na vstup)
  a `parse` (riadok jeho výstupu → udalosti `init`, `tool`, `text`, `result`).
- `hud/server/brain.mjs` (Claude), `hud/server/brain-codex.mjs` (Codex) a `hud/server/brain-antigravity.mjs` (Antigravity): hlasový mozog. Všetky majú to isté rozhranie:
  `start()`, `run(ctx, sink)`, `interrupt()`, `restart()`, `stop()`, `status()`. `sink` dostáva `delta(text)`,
  `tool({ id, name, input, status })`, `blockBreak()`, `done(meta)` a `error(text)`.

Antigravity sa nespúšťa jedným príkazom s výsledkom, ale rozhovorom cez ACP. Ten rozhovor je v `hud/server/antigravity.mjs`
a pre úlohy na pozadí ho vedie malý skript `hud/server/antigravity-run.mjs`, ktorý vypisuje rovnaké udalosti ako ostatní agenti.

Nástroje (pamäť, počítač, plocha) sú tri malé MCP servery v `hud/server/mcp/`. Každý agent, ktorý vie MCP, ich použije bez zmeny.

## Iný alebo lokálny model

Jarvis je stavaný tak, aby si ho vedel dostavať sám. Keď chceš iný model (lokálny model cez Ollamu alebo
LM Studio, čokoľvek s príkazovým riadkom), povedz to AI, ktorá má tento priečinok otvorený, a nech ho pridá:

1. Agent musí vedieť dve veci: spustiť sa bez okna s úlohou na vstupe a používať MCP servery. Bez MCP nemá pamäť ani plochu.
2. Nový záznam v `PROVIDERS` (`hud/server/provider.mjs`) podľa vzoru `codex`: tým začnú fungovať rutiny a úlohy na pozadí.
3. Nová trieda hlasového mozgu podľa `hud/server/brain-codex.mjs` (jeden beh na jednu správu je najjednoduchšia cesta;
   agent, ktorý vie ACP, môže ísť podľa `brain-antigravity.mjs`)
   a jej zapojenie v `hud/server.mjs` tam, kde sa vyberá medzi `Brain` a `CodexBrain`.
4. `scripts/setup.mjs` a `scripts/doctor.mjs`: kontrola, že je agent nainštalovaný a prihlásený.
5. Skúška bez rizika: `PORT=4599 JARVIS_SECONDARY=1 JARVIS_AI=<meno> node hud/server.mjs` s `JARVIS_DATA_DIR`, `JARVIS_MEMORY_DIR`
   a `JARVIS_CONFIG` v dočasnom priečinku.

Najkratšia cesta k lokálnemu modelu vedie cez Codex, ktorý ho vie použiť sám (`codex --oss`, Ollama alebo LM Studio):
stačí pridať `--oss` do argumentov v zázname `codex` a v `brain-codex.mjs`. Počítaj s tým, že malé lokálne modely používajú
nástroje nespoľahlivo a hlas bude pomalý.

Na rovinu: lokálny model znamená, že nič neodchádza z počítača, ale Jarvis bude hlúpejší a pomalší. Na úpravu
vlastného kódu, plánovanie dňa a čítanie pošty sú veľké modely stále o triedu lepšie.
