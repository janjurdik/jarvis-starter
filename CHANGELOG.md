# Zoznam zmien

Čo je v ktorej verzii Jarvisa nové. Najnovšia verzia je hore. Ako aktualizovať: [docs/AKTUALIZACIE.md](docs/AKTUALIZACIE.md).

## 1.4.2 (2026-11-18)

- **Klik na appku ju otvorí, neodpojí.** V mape Tvoje appky klik ukáže kartu appky: čo z nej Jarvis má, v akom je stave
  a ďalší krok (pripojiť, ukázať postup, čo s ňou vie). Prvý klik ju zároveň pridá. Odobrať sa dá len na karte cez
  „Už nepoužívam".
- **Úlohy a Kalendár sú usporiadané.** Namiesto rozhádzaných bodov sú vnútri stĺpce s riadkami. Úlohy podľa termínu
  (po termíne, dnes, do týždňa, neskôr), alebo podľa sekcií tvojho zoznamu, keď termíny nepoužívaš. Kalendár ako Dnes,
  Zajtra, Tento týždeň a Neskôr.
- **Hry majú obrázky.** Obal zo Steamu alebo ikona hry priamo z tvojho počítača. Nič sa nesťahuje.

## 1.4.1 (2026-11-18)

- **Dáta z appiek číta Jarvis sám.** Čítačky napísané vopred pre Instagram, Messenger, WhatsApp, Discord, Telegram, ChatGPT,
  Claude, Spotify, Apple Music a Google Takeout sú preč. Pretiahneš do okna kópiu dát z ktorejkoľvek appky, Jarvis si na
  pozadí pozrie jej formát, správy načíta a zvyšok zhrnie do pamäte. Funguje to rovnako pre appku, ktorú nikto nepredvídal,
  aj keď známa appka zmení formát. To, čo si už načítal, ostáva.

## 1.4.0 (2026-11-18)

Jarvis už nie je hotový systém, ale základ, ktorý si každý dostavia po svojom. Základ je pošta, úlohy, kalendár, pamäť,
hlas a budík. Všetko ostatné mu povieš a on si to pripojí alebo doprogramuje.

- **Nastavenie vedie Jarvis.** Napíšeš `štart`, počítač sa pripraví a Jarvis sa objaví na ploche. Odvtedy hovoríš s ním:
  predstaví sa, poobzerá sa po počítači, spýta sa len na to, čo nenájde, a spolu dotiahnete zvyšok. Žiadny dotazník.
- **Funguje aj s ChatGPT.** Jarvis beží na Claude (Claude Code) alebo na ChatGPT (Codex), podľa toho, čo máš. Iný alebo
  lokálny model si vie doprogramovať (`docs/MODELY.md`).
- **Orby pribúdajú a miznú.** Na ploche je len to, čo naozaj používaš. Povieš „chcem sledovať financie" a pribudne orb
  s číslom a s panelom vnútri (počty, stĺpce, graf, zoznam, tlačidlá). Povieš „školu nepotrebujem" a zmizne. Pribudli orby
  Pošta a Úlohy. Slovník komponentov je v `docs/ORBY.md`.
- **Nové menu Tvoje appky.** Namiesto okna s dlaždicami je to mapa vo vnútri orbu: appky plávajú v priestore po skupinách,
  klik ju pridá do Jarvisa a svetelná niť ju spojí s jadrom. Zmestí sa do každého okna. Appku, ktorá v mape nie je,
  stačí napísať a Jarvis si k nej nájde cestu.
- **Whisper je predvolený.** Reč rozpoznáva model priamo v tvojom počítači, vybraný podľa jeho výkonu a voľného miesta
  na disku, a stiahne sa pred prvým spustením. Slabý alebo plný počítač ostane pri prehliadači. `ffmpeg` už netreba.
- **Nastavenia na ploche.** Hlas s ukážkou, či je Jarvis muž alebo žena, jeho meno, ako ťa oslovuje, tykanie, tiché hodiny,
  jazyk a rozpoznávanie reči. To isté stačí povedať: „hovor ženským hlasom", „oslovuj ma pani".
- **Filmový Jarvis.** Hovorí ako z filmu od prvej vety, oslovuje ťa „pane" alebo „pani" a menom, a z nepresného prepisu
  hlasu si domyslí, čo si mal na mysli, namiesto toho, aby sa pýtal.
- **Budík so skladbou.** Budí ťa Highway to Hell. Vlastnú skladbu mu stačí pretiahnuť alebo poslať odkaz.
- **Video z odkazu.** Pošleš odkaz a video sa otvorí v kine na ploche s prepisom a kapitolami. Jarvis v ňom vie skákať
  na čas, hľadať a zhrnúť ho (`docs/VIDEO.md`).
- **Denník z toho, čo si naozaj robil.** Raz za minútu si Jarvis zapíše, ktorá appka je v popredí (nič viac), a večer z toho
  píše denník. Vie odpovedať na „čo som dnes robil" a „koľko som hral". Vypneš to jednou vetou (`docs/AKTIVITA.md`).
- **Hry z každého launchera.** Steam, Epic, GOG, Battle.net, Riot, EA, Ubisoft, Xbox, Minecraft a ďalšie.
- **Garmin naživo.** Spánok, tep, body battery a tréningy z hodiniek. Prihlásiš sa raz v termináli, heslo Jarvis nevidí
  (`docs/GARMIN.md`).
- **Import čohokoľvek.** Kópiu dát z appky, ktorú Jarvis nepozná, si prečíta sám: zistí formát a načíta ju.
- **Ovláda počítač.** Hudba a hlasitosť na jednu vetu, všetko väčšie ako úloha na pozadí, prehliadač cez Claude in Chrome
  (`docs/OVLADANIE.md`).
- **Užšie okná.** V malom okne sa bočné panely zložia a svet dostane celú šírku.
- **Bezpečnosť.** Opravená chyba, cez ktorú mohla pozvánka do kalendára spustiť kód na ploche. Aktualizácie sú podpísané
  autorom, pribudli ochranné hlavičky, tajné údaje sa nedostanú k pomocným programom, pamäť a dáta číta len tvoj účet
  a Jarvis vie, že text v mailoch, na weboch a v exportoch nie sú príkazy.
- **Banner AI Superčlovek** v mape appiek: kurz od autorov Jarvisa.

## 1.3.0 (2026-11-17)

- **Budík.** Povieš „zobuď ma o 6:30" a ráno Jarvis zazvoní a nahlas ti povie, ako si spal (keď to vie), aké je počasie,
  čo ťa dnes čaká a čo spravil, kým si spal. Hovorí cez reproduktory počítača, aj keď je jeho okno zatvorené. Na Macu ho
  pred budíkom nenechá zaspať, na Windows ho zobudí. Keď chceš, aj ti zavolá na mobil. Skúška: `node scripts/alarm.mjs test`.
- **Práca cez noc.** „Cez noc mi priprav…" Jarvis sa do toho pustí hneď, v noci je ticho a ráno ti povie, čo je hotové
  a čo čaká na tvoje „áno". To isté platí pre ranný brief.
- **Jarvis prehovorí aj bez okna.** Pripomienky a výsledky rutín povie cez reproduktory, keď HUD nie je otvorený.
  Úlohy, ktoré skončia v tichých hodinách, už v noci nehovoria nahlas.
- **Rýchlejší prvý dojem.** Pri nastavení ti Jarvis do pár minút povie nahlas, čo o tebe zistil, a hneď pre teba spraví
  prvú užitočnú vec podľa toho, čo robíš (maily a ponuky, škola, obsah, papiere). Veľké poznámky dočíta na pozadí.
- **Kontrola, že rutiny naozaj bežia.** Po zapnutí rutín Jarvis overí, že ich systém spúšťa, a povie, keď nie
  (na Macu typicky priečinok v Stiahnutých). Kontrola počítača ukáže aj bezplatný účet Claude, s ktorým Jarvis nefunguje.
- **Oprava.** Pulz a rutiny čítajú pamäť z priečinka nastaveného v `.env` (`JARVIS_MEMORY_DIR`), predtým ho mohli prehliadnuť.

## 1.2.0 (2026-11-15)

- **Jarvis smie všetko, čo ty.** Obmedzený režim je preč. Úlohy na pozadí, rutiny aj hlasový Jarvis pracujú so súbormi kdekoľvek
  v počítači a spúšťajú príkazy bez pýtania. Jediné, čo stále čaká na tvoje „áno", je to, čo má ísť von k iným ľuďom.
- **Do úlohy sa dá nahliadnuť.** Klikni na úlohu v paneli Úlohy a uvidíš jej zadanie a priebeh krok po kroku, naživo a s časmi.
- **Úloha sa dá zastaviť jedným klikom.** Priamo na riadku alebo v otvorenej úlohe. Zastavenú alebo hotovú úlohu vieš
  doplniť a pustiť ďalej. Hlasom: „čo robí tá úloha?" a „zruš to".

## 1.1.2 (2026-11-15)

- **Jarvis má povahu.** Suchý humor, sarkazmus a občas odvráva, ako vo filmoch. Prácu spraví vždy, len si k nej niečo povie.

## 1.1.1 (2026-11-15)

- **Úlohy na pozadí hovoria krátko.** Keď Jarvis dokončí úlohu, povie jednu až dve vety a nie celý výsledok. Ten nájdeš na karte a v súbore.
- **Hlas už nečíta značky.** Hviezdičky, mriežky a tabuľky z textu sa do reči nedostanú.

## 1.1.0 (2026-11-15)

- **Aktualizácie bez straty úprav.** Jarvis ti povie, keď vyjde nová verzia. Stačí napísať „aktualizuj Jarvisa" a dostaneš
  novinky bez toho, aby si prišiel o vlastné úpravy, pamäť alebo nastavenie. Keby niečo nesedelo, jedným príkazom sa vrátiš späť.
- **Nastavenie, ktoré sa nepýta.** Po `štart` si Jarvis sám prejde počítač (poznámky, projekty, dokumenty, appky, hudbu, hry) a povie ti,
  čo o tebe zistil. Ty len opravíš, čo nesedí. Sken iba číta a nič nikam neposiela.
- **Tvoje dáta z aplikácií.** Sprievodca s animovaným postupom ti ukáže, ako si stiahnuť dáta z Instagramu, Facebooku, WhatsAppu,
  Discordu, Telegramu, ChatGPT, Claude, Spotify a ďalších. Nájdeš ho v HUD na adrese `/guide/`.
- **Import a „kto je kto".** Export pretiahneš do okna Jarvisa. Prečíta rozhovory, navrhne ľudí aj s fotkami a ty potvrdíš, kto je kto.
  Potom vie odpovedať na otázky typu „čo sme si písali s Janou o dovolenke?".
- **Súbory priamo na ploche.** Fotku alebo dokument pretiahneš do okna, vložíš zo schránky alebo pridáš cez sponku. Jarvis si ho pozrie.
- **Pulz.** Každých pár minút Jarvis sám skontroluje pripomienky, kalendár a termíny a ozve sa: „O desať minút máš zubára."
  Nové sú aj pripomienky („pripomeň mi zajtra o tretej…"), stráže (napríklad stráž pošty, ktorá sa ozve, len keď je čo povedať) a tiché hodiny.
- **Hovory.** Keď niečo nepočká, Jarvis ti zavolá na mobil a povie to. Odpovieš hlasom a on to zariadi. Stačí vlastný účet na Twilio,
  postup je v `docs/HOVORY.md`. „Zavolaj mi zajtra o tretej a pripomeň lekára."
- **Opravené oznámenia na macOS.** Diakritika v oznámeniach rutín sa už nerozsype.
- **Bezpečnosť.** Jarvis odpovedá len tvojmu počítaču. Z iného zariadenia ani z cudzej webovej stránky sa k nemu nedá dostať.
- **Oprava (Windows).** Text v paneli Rozhovor sa už neorezáva zľava.

## 1.0.0 (2026-11-14)

Prvé vydanie.

- **HUD.** Obrazovka na ploche s 3D svetom tvojej pamäte, chatom a hlasom.
- **Pamäť.** Obyčajné textové poznámky v priečinku `memory/`, ktoré si Jarvis píše sám a ty ich vieš kedykoľvek otvoriť.
- **Rutiny.** Ranný brief, večerné zhrnutie a týždenný prehľad, ktoré bežia samy podľa času.
- **Nastavenie cez `štart`.** Claude ťa prevedie celým nastavením, nemusíš vedieť programovať.
