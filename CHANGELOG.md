# Zoznam zmien

Čo je v ktorej verzii Jarvisa nové. Najnovšia verzia je hore. Ako aktualizovať: [docs/AKTUALIZACIE.md](docs/AKTUALIZACIE.md).

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
