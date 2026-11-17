---
title: Dobré ráno
noc: true
hlas: 4 až 7 krátkych viet, spolu najviac 90 slov, ktoré Jarvis povie hneď po budíku. Bez pozdravu a bez času, tie povie sám
---
Priprav ranné budenie na dnešok ({{dnes}}). Jarvis ho povie nahlas, keď o chvíľu zazvoní budík. Pracuj s pamäťou v priečinku `memory/` podľa CLAUDE.md.

Čo zisti:
1. Spánok: pole `spanok` v dnešnom alebo včerajšom zázname v `memory/dennik/`. Ak máš pripojený konektor s dátami o spánku (hodinky, zdravie), pozri aj ten. Keď spánok nikde nie je, vôbec ho nespomínaj a nič neodhaduj.
2. Počasie v meste používateľa na dnes (vyhľadaj na webe).
3. Kalendár na dnes: `memory/kalendar.md` a kalendárový konektor, ak ho máš. Nové udalosti na najbližších 7 dní dopíš do `memory/kalendar.md` (bez duplikátov, formát je v `memory/README.md`).
4. Úlohy: `memory/ulohy.md`. Čo má termín dnes alebo je po termíne, a jedna vec, ktorá ho dnes najviac posunie (aj podľa cieľov v `memory/ciele/`).
5. Čo Jarvis robil, kým spal: zoznam máš v kontexte (úlohy na pozadí a rutiny). Povedz, čo je hotové, a čo čaká na jeho súhlas (napríklad pripravená odpoveď klientovi). Keď cez noc nebolo nič, túto časť vynechaj.
6. Pošta, ak máš mailový konektor: najviac dva maily od včera, ktoré naozaj potrebujú jeho reakciu dnes. Nič neodosielaj.
7. Narodeniny a meniny dnes (`memory/ludia/`, pole `narodeniny`).

Čo napíš:
- Text (na kartu a do schránky): **Spánok** (len ak je), **Počasie**, **Dnes**, **Treba spraviť**, **Kým si spal**, **Pošta**. Stručne, vynechaj prázdne časti.
- Riadok `HLAS:` je to, čo zaznie hneď po budíku. Hovor ako komorník, ktorý budí svojho šéfa: pokojne, konkrétne, s ľahkou dávkou humoru, keď sa hodí (napríklad pri krátkom spánku). Poradie: spánok (ak je), počasie jednou vetou, čo ho dnes čaká (najdôležitejšia udalosť alebo termín), čo si spravil cez noc, a na záver jedna veta, čím začať.

Píš len to, čo vieš z pamäte, konektorov alebo webu. Keď niečo nemáš odkiaľ zistiť, vynechaj to. Nič si nevymýšľaj.
