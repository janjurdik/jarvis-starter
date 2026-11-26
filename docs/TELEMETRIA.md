# Anonymné štatistiky

Raz denne pošle Jarvis autorovi niekoľko čísel, aby vedel, koľko ľudí Jarvisa používa, na akom systéme a ktoré
veci naozaj používajú. Podľa toho vie, čo opraviť a čo zlepšiť ako prvé.

## Čo ide von

Len čísla a voľby, nič, čo ste napísali, povedali alebo uložili:

| Pole | Príklad | Čo to je |
|---|---|---|
| `id` | `3f9c…` (32 znakov) | Náhodné číslo tejto inštalácie, vznikne pri prvom štarte. Nie je odvodené od počítača, účtu ani mena. |
| `version`, `os`, `osVersion`, `arch`, `node` | `1.10.1`, `darwin`, `26`, `arm64`, `22` | Verzia Jarvisa, systém a jeho hlavná verzia, procesor, verzia Node. |
| `ai`, `surface`, `lang`, `stt`, `tts` | `claude`, `app`, `sk`, `whisper`, `edge` | Na akej AI beží, kde býva, jazyk, rozpoznávanie a hlas. |
| `setup` | `done` alebo `budik` | Či je nastavenie hotové, alebo ktorý krok je na rade. |
| `notes` | `50-199` | Približný počet poznámok v pamäti, len v pásme. |
| `counts` | `{ text: 12, voice: 5, jobs: 2, recordings: 0, screen: 1, watchHits: 0 }` | Koľko správ ste napísali a povedali, koľko úloh na pozadí, záznamov, pohľadov na obrazovku a splnených stráží od posledného pingu. |
| `state` | `{ watches: 2, routines: 3, orbs: 1, apps: 9 }` | Koľko stráží, zapnutých rutín, vlastných orbov a vybraných appiek. |
| `flags` | `{ mobile: false, wake: true, calls: false, alarm: true, activity: true }` | Či je zapnutý mobil, Hey Jarvis, hovory, budík a záznam aktivity. |

Server k tomu pridá krajinu, ktorú Cloudflare určí z adresy (napríklad `SK`). Samotná IP adresa sa nikde neukladá
a server nemá zapnuté logy požiadaviek.

Nikdy nejde: text správ, prepisy, mená, e-maily, mesto, súbory, pamäť, názvy appiek, adresy stránok, obsah
obrazovky, záznamy ani nič z `.env`.

Presne to, čo pôjde von nabudúce, ukáže Nastavenia → Asistent → „Čo presne posielam", alebo
`curl -s http://127.0.0.1:4545/api/telemetry`. Kód je v `hud/server/telemetry.mjs`.

## Kam

`https://jarvis-telemetry.janjurdik.com/v1/ping`, Cloudflare Worker autora s databázou v EÚ. Údaje vidí len autor.

## Vypnutie

- Nastavenia → Asistent → Anonymné štatistiky (zapíše `"telemetry": false` do `config/jarvis.json`).
- Alebo v `.env`: `JARVIS_TELEMETRY=0`, prípadne `DO_NOT_TRACK=1`.

Vypnuté znamená, že neodíde nič, ani správa o vypnutí. Vedľajšia inštancia (`JARVIS_SECONDARY=1`), skúšobný mozog
(`JARVIS_MOCK=1`) a testy neposielajú nikdy.
