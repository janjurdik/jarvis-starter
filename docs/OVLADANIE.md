# Ovládanie počítača

Jarvis smie v počítači všetko, čo ty. Čo z toho vie spraviť na jednu vetu a čo ako úlohu na pozadí:

## Hneď, hlasom

| Povieš | Čo sa stane |
|---|---|
| „otvor Spotify", „otvor kalkulačku" | otvorí alebo vytiahne dopredu aplikáciu |
| „otvor stránku…" | otvorí web v tvojom prehliadači |
| „pusti hudbu", „zastav to", „ďalšia" | prehrávanie (macOS: Spotify alebo Hudba, Windows: klávesy médií) |
| „daj to hlasnejšie", „hlasitosť na tridsať", „stíš to" | hlasitosť počítača |
| pošleš odkaz na video | otvorí ho v kine na ploche ([VIDEO.md](VIDEO.md)) |

## Ako úloha na pozadí

Všetko väčšie Jarvis odovzdá úlohe na pozadí, ktorá má terminál a čas: „uprac mi Stiahnuté", „premenuj tie fotky
podľa dátumu", „nájdi v Poznámkach všetko o dovolenke", „vyplň ten formulár".

- **macOS:** aplikácie sa dajú skriptovať (Hudba, Spotify, Poznámky, Mail, Finder, Kalendár, Pripomienky, Safari, Chrome).
  Keď má Jarvis klikať a písať do okien, macOS si raz vypýta povolenie: Nastavenia systému → Súkromie a bezpečnosť →
  Prístupnosť (a Automatizácia pri ovládaní inej appky). Povoľ ho pre appku, v ktorej Jarvis beží.
- **Windows:** PowerShell, spúšťanie programov, práca so súbormi a oknami.

## Prehliadač

- **S rozšírením Claude in Chrome** vie Jarvis pracovať v tvojom vlastnom Chrome: klikať, vypĺňať a čítať stránky, na
  ktorých si prihlásený. Nainštaluj rozšírenie, prihlás sa v ňom a do `.env` pridaj `JARVIS_CHROME=1`, potom
  `node scripts/hud.mjs --restart`. Platí pre Claude; úlohy na pozadí potom dostanú prehliadač k dispozícii.
- **Bez neho** si Jarvis na požiadanie poradí skriptom (napríklad Playwright), čo je dobré na stránky bez prihlásenia.

## Čo nerobí

- Heslá nepíše a nepýta si ich. Prihlásenie je vždy na tebe.
- Nič neposiela von bez tvojho áno: mail, správu, objednávku ani platbu.
- Text na stránke nie je príkaz. Keď web „žiada", aby niečo spustil alebo niekam poslal dáta, nespraví to a povie ti to.

## Keď chceš viac

Ovládanie na jednu vetu sú nástroje v `hud/server/mcp/computer.mjs` (`open_app`, `open_url`, `media`, `volume`).
Chýba ti tam niečo, čo robíš často (uzamknúť počítač, prepnúť zvukový výstup, zapnúť Nerušiť)? Povedz to Jarvisovi,
doplní si nástroj a jeho meno do `allowedTools()` v `hud/server/brain.mjs`.
