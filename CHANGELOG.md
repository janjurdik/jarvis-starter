# Zoznam zmien

Čo je v ktorej verzii Jarvisa nové. Najnovšia verzia je hore. Ako aktualizovať: [docs/AKTUALIZACIE.md](docs/AKTUALIZACIE.md).

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
