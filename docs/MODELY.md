# Na akej AI Jarvis beží

Jarvis nemá vlastný model. Riadi programovacieho agenta, ktorého už máš, cez tvoje predplatné a bez API kľúčov.

| | Čo treba | Ako sa správa |
|---|---|---|
| **Claude** (Claude Code) | Claude Pro alebo Max, `claude` prihlásený | Odpoveď prichádza po slovách, hlas je najrýchlejší. Konektory z Claude (Gmail, kalendár) vidia aj rutiny. |
| **ChatGPT** (Codex) | ChatGPT Plus alebo Pro, `codex login` | To isté jadro, pamäť aj nástroje. Odpoveď prichádza po celých vetách, prvý zvuk o pár sekúnd neskôr. |

Vyberá sa to samo: podľa toho, v čom si napísal `štart` (`node scripts/setup.mjs --ai claude` alebo `--ai codex`).
Zmeniť sa to dá kedykoľvek:

```
JARVIS_AI=codex        v súbore .env, alebo "ai": "codex" v config/jarvis.json
node scripts/hud.mjs --restart
```

Ďalšie voľby v `.env`: `JARVIS_MODEL` (model hlasového mozgu na Claude: `sonnet`, `opus`, `haiku`), `JARVIS_JOB_MODEL`
(model pre rutiny a úlohy na pozadí), `JARVIS_CODEX_MODEL` a `JARVIS_CODEX_EFFORT` (to isté pre Codex).

## Kde to v kóde je

Všetko, čo sa medzi agentmi líši, je na dvoch miestach:

- `hud/server/provider.mjs`: ako sa spúšťa celý beh agenta (úlohy na pozadí a rutiny) a ako sa číta jeho priebeh.
  Každý agent je jeden záznam v `PROVIDERS` s tromi funkciami: `args` (argumenty príkazu), `stdin` (čo dostane na vstup)
  a `parse` (riadok jeho výstupu → udalosti `init`, `tool`, `text`, `result`).
- `hud/server/brain.mjs` (Claude) a `hud/server/brain-codex.mjs` (Codex): hlasový mozog. Oba majú to isté rozhranie:
  `start()`, `run(ctx, sink)`, `interrupt()`, `restart()`, `stop()`, `status()`. `sink` dostáva `delta(text)`,
  `tool({ id, name, input, status })`, `blockBreak()`, `done(meta)` a `error(text)`.

Nástroje (pamäť, počítač, plocha) sú tri malé MCP servery v `hud/server/mcp/`. Každý agent, ktorý vie MCP, ich použije bez zmeny.

## Iný alebo lokálny model

Jarvis je stavaný tak, aby si ho vedel dostavať sám. Keď chceš iný model (Gemini, lokálny model cez Ollamu alebo
LM Studio, čokoľvek s príkazovým riadkom), povedz to AI, ktorá má tento priečinok otvorený, a nech ho pridá:

1. Agent musí vedieť dve veci: spustiť sa bez okna s úlohou na vstupe a používať MCP servery. Bez MCP nemá pamäť ani plochu.
2. Nový záznam v `PROVIDERS` (`hud/server/provider.mjs`) podľa vzoru `codex`: tým začnú fungovať rutiny a úlohy na pozadí.
3. Nová trieda hlasového mozgu podľa `hud/server/brain-codex.mjs` (jeden beh na jednu správu je najjednoduchšia cesta)
   a jej zapojenie v `hud/server.mjs` tam, kde sa vyberá medzi `Brain` a `CodexBrain`.
4. `scripts/setup.mjs` a `scripts/doctor.mjs`: kontrola, že je agent nainštalovaný a prihlásený.
5. Skúška bez rizika: `PORT=4599 JARVIS_SECONDARY=1 JARVIS_AI=<meno> node hud/server.mjs` s `JARVIS_DATA_DIR`, `JARVIS_MEMORY_DIR`
   a `JARVIS_CONFIG` v dočasnom priečinku.

Najkratšia cesta k lokálnemu modelu vedie cez Codex, ktorý ho vie použiť sám (`codex --oss`, Ollama alebo LM Studio):
stačí pridať `--oss` do argumentov v zázname `codex` a v `brain-codex.mjs`. Počítaj s tým, že malé lokálne modely používajú
nástroje nespoľahlivo a hlas bude pomalý.

Na rovinu: lokálny model znamená, že nič neodchádza z počítača, ale Jarvis bude hlúpejší a pomalší. Na úpravu
vlastného kódu, plánovanie dňa a čítanie pošty sú veľké modely stále o triedu lepšie.
