---
title: Večerné zhrnutie
---
Zapíš dnešný deň ({{dnes}}) do pamäte. Toto je to, vďaka čomu si Jarvis pamätá život používateľa.

Najprv spusti `node scripts/activity.mjs today --json`. Je to záznam toho, čo sa dnes na počítači naozaj dialo:
čas v appkách a podľa druhu práce (`apps`, `categories`), dlhšie úseky s časom od do (`sessions`), hry (`games`),
prestávky (`gaps`), commity (`signals.git`), súbory zmenené dnes, len názvy (`signals.files`), čo robil Jarvis
(`signals.jarvis`) a úlohy (`signals.todos`). Pole `notes` hovorí, čo je odhad a čo záznam nevie.
Záznam vidí len to, ktorá appka bola v popredí, nie čo sa v nej dialo. Keď príkaz zlyhá alebo je `samples` 0,
píš len z ostatných podkladov a žiadne časy pri počítači do denníka nedávaj.

Podklady:
- Záznam aktivity z príkazu vyššie.
- Dnešný rozhovor s Jarvisom v HUD:

{{rozhovor}}

- Súbory v `memory/`, ktoré sa dnes zmenili (ľudia, projekty, úlohy, ciele).
- Dnešné udalosti z `memory/kalendar.md` a z kalendárového konektora, ak ho máš.
- Pošta, ak máš mailový konektor: len to, čo dnes používateľ sám odoslal alebo vybavil. Nič neodosielaj.
- Dnešný ranný brief v `memory/schranka/`, ak existuje.

Čo sprav:
1. Otvor alebo vytvor `memory/dennik/{{dnes}}.md`. Existujúci obsah a hlavičku (spanok, nalada) zachovaj. Pod nadpis `## Zhrnutie dňa` napíš 4 až 8 viet v prvej osobe za používateľa: čo som dnes naozaj robil, čo sa podarilo, čo ostalo otvorené. Ak tam zhrnutie už je, prepíš ho, nepridávaj druhé.
   - Píš ľudsky, nie ako výpis z tabuľky: „Doobeda som asi tri hodiny programoval na projekte X vo VS Code, poobede hodinu a pol Valorant, večer YouTube." Časy zaokrúhli na štvrťhodiny.
   - Appku spoj s tým, čo sa v nej robilo, len keď to máš z čoho: projekt podľa commitov a názvov súborov, tému podľa rozhovoru, stretnutie podľa kalendára. Keď to nevieš, napíš len appku alebo druh práce („dve hodiny v prehliadači") a nevymýšľaj, čo sa v nej dialo.
   - Čo je odhad (`estimated`, `passiveMin`, `estimatedMin`, poznámky v `notes`), napíš ako odhad: „asi", „približne".
   - Čas v súkromných appkách (`privateMin`) nespomínaj vôbec, ani to, že nejaké boli.
   - Systémové appky a drobnosti pod desať minút vynechaj. Hry a oddych zapíš tak, ako boli, bez hodnotenia.
   - Len to, čo vyplýva z podkladov. Ľudí a projekty, ktoré majú poznámku v pamäti, odkazuj cez `[[Názov poznámky]]`.
2. Nové trvalé fakty z rozhovoru (o používateľovi, ľuďoch, projektoch), ktoré ešte v pamäti nie sú, dopíš do príslušných poznámok pod nadpis `## Zapamätané` ako `- {{dnes}}: fakt`. Jednorazové drobnosti vynechaj. Zo záznamu aktivity fakty nevyvodzuj (to, že dnes hral, nie je trvalý fakt).
3. V `memory/ulohy.md` odškrtni úlohy, o ktorých z rozhovoru alebo z commitov jasne vyplýva, že sú hotové. Nové úlohy, ktoré používateľ spomenul, pridaj.
4. Pri cieľoch v `memory/ciele/` odškrtni kroky, ktoré sa dnes splnili.

Keď sa dnes nedialo nič, z čoho by sa dalo písať (žiadna aktivita, žiadny rozhovor, žiadne zmeny), napíš do denníka jednu vetu, že deň prebehol bez záznamu, a skonči.

Do výsledku napíš krátke zhrnutie dňa (3 až 5 riadkov) a čo je na zajtra najdôležitejšie.
