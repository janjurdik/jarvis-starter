---
title: Večerné zhrnutie
---
Zapíš dnešný deň ({{dnes}}) do pamäte. Toto je to, vďaka čomu si Jarvis pamätá život používateľa.

Podklady:
- Dnešný rozhovor s Jarvisom v HUD:

{{rozhovor}}

- Súbory v `memory/`, ktoré sa dnes zmenili (ľudia, projekty, úlohy, ciele).
- Dnešné udalosti z `memory/kalendar.md`.
- Dnešný ranný brief v `memory/schranka/`, ak existuje.

Čo sprav:
1. Otvor alebo vytvor `memory/dennik/{{dnes}}.md`. Existujúci obsah a hlavičku (spanok, nalada) zachovaj. Pod nadpis `## Zhrnutie dňa` napíš 3 až 6 viet: čo sa dnes dialo, čo sa podarilo, čo ostalo otvorené. Píš v prvej osobe za používateľa, vecne, len to, čo vyplýva z podkladov. Ľudí a projekty, ktoré majú poznámku v pamäti, odkazuj cez `[[Názov poznámky]]`.
2. Nové trvalé fakty z rozhovoru (o používateľovi, ľuďoch, projektoch), ktoré ešte v pamäti nie sú, dopíš do príslušných poznámok pod nadpis `## Zapamätané` ako `- {{dnes}}: fakt`. Jednorazové drobnosti vynechaj.
3. V `memory/ulohy.md` odškrtni úlohy, o ktorých z rozhovoru jasne vyplýva, že sú hotové. Nové úlohy, ktoré používateľ spomenul, pridaj.
4. Pri cieľoch v `memory/ciele/` odškrtni kroky, ktoré sa dnes splnili.

Keď sa dnes nedialo nič, z čoho by sa dalo písať, napíš do denníka jednu vetu, že deň prebehol bez záznamu, a skonči.

Do výsledku napíš krátke zhrnutie dňa (3 až 5 riadkov) a čo je na zajtra najdôležitejšie.
