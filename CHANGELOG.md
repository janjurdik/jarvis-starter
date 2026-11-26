# Zoznam zmien

Čo je v ktorej verzii Jarvisa nové. Najnovšia verzia je hore. Ako aktualizovať: [docs/AKTUALIZACIE.md](docs/AKTUALIZACIE.md).

## 1.10.2 (2026-11-26)

- **„Ahoj Jarvis“ namiesto „Hey Jarvis“.** Jarvisa oslovíte po slovensky, „Hey Jarvis“ funguje ďalej. Keď si Jarvis
  nie je istý, či ste ho oslovili, overí si to v prepise a pri planom poplachu nič nerobí.

## 1.10.1 (2026-11-26)

- **Fotky a videá priamo v Jarvisovi.** Čo Jarvis vyrobí alebo ukáže (fotky, videá, zvuk), sa otvorí ako samostatné
  plávajúce karty na obrazovke: video hrá hneď, kartu posuniete kamkoľvek a zavriete krížikom. Nič sa neotvára mimo
  Jarvisa. „Ukáž mi to video" funguje aj hlasom.
- **Úlohy sa dajú upravovať.** Na tabuli úloh je pri každej krížik na zmazanie (s „Vrátiť"), klik úlohu prepíše a
  fajka ju odškrtne.
- **Žiadny terminál.** Prihlásenie do Garminu je karta priamo v rozhovore, heslo ide rovno službe a Jarvis ho nevidí.
  Kde treba okno terminálu, otvorí ho Jarvis sám.
- **Jarvis sa s vami aj baví.** Pozná hudbu, memy a slang, má vlastný názor a pýta sa späť. A už nehovorí to isté
  dvakrát, pred úlohou a po nej.
- **Čistý zvuk v Bluetooth slúchadlách.** Pri Bluetooth slúchadlách Jarvis počúva cez mikrofón počítača, takže
  slúchadlá neprepnú do hovorovej kvality a hlas neznie ako z konzervy.
- **Orby s úplnými dátami.** Orb, ktorý treba naplniť (hry, commity, appky), zbiera Jarvis na pozadí zo všetkých
  zdrojov a výsledok si overí. Príliš dlhé číslo pri orbe sa už neoreže.
- **Anonymné štatistiky** (len čísla, nikdy texty ani mená), vypínajú sa v Nastaveniach, časť Asistent.
- **Bezpečnosť mobilu** po nezávislom audite: silnejšie heslo, vaše zariadenie prejde aj počas útoku na prihlásenie,
  oznámenie o každom novom zariadení a zapnutí tunela, čip „Mobil zapnutý", token cez tunel neplatí.

## 1.10.0 (2026-11-26)

- **Jarvis v mobile.** Na želanie je Jarvis aj v telefóne: rozhovor, hlas, úlohy a schvaľovanie odkiaľkoľvek. Ide cez
  šifrovaný tunel Cloudflare a pustí len toho, kto pozná váš e-mail a heslo. Na počítači heslo netreba. Zapína sa v
  Nastaveniach, časť Mobil (QR kód pre mobil), Jarvis sa naň spýta sám po dokončení nastavenia.
- **Stráže z jednej vety.** „Daj mi vedieť, keď zlacnie let…", „keď mi odpíše Peter", „keď pribudne byt…": Jarvis si
  sám nájde, kde to overiť, kontroluje to na pozadí a ozve sa, len keď sa to naozaj stane. Všetky stráže sú v orbe Stráže.
- **Jarvis vidí, na čo sa pozeráte.** „Čo to je?", „odpíš na toto", „vysvetli mi tento graf": pozrie sa na okno pred
  vami, bez kopírovania.
- **Záznam.** „Počúvaj ma" alebo čip Záznam nahráva mikrofón aj obrazovku, priebežne ukladá a prepisuje, takže sa nič
  nestratí ani pri páde. Jarvis sa s vami medzitým normálne rozpráva. Po skončení zapíše poznámku, úlohy, pripomienky a
  termíny a pripraví správy, ktoré pošle až po vašom áno.
- **Jedna appka Jarvis na Macu.** Na ploche aj vo vlastnom okne je to tá istá appka Jarvis, okno už nespúšťa druhý
  Chrome (ten predtým kradol bežné otváranie Chromu a ukazoval ho neprihlásený). Bez Chromu ide okno v natívnej appke,
  inak v prehliadači, ktorý máte.
- V Nastaveniach je dole, kto Jarvisa vytvoril.

## 1.9.7 (2026-11-23)

- **Rozhovor a výsledky úloh už nezmiznú.** Po načítaní okna znova (aj po reštarte Jarvisa) ostane celý rozhovor
  vrátane kariet s výsledkami úloh, rutín a importov. Doteraz sa výsledky úloh neukladali vôbec a rozhovor neprežil reštart.
- **Zmenu Jarvisa vidíš hneď.** Keď Jarvis (alebo ty) upraví jeho obrazovku, otvorené okno sa načíta znova samo. To isté
  po reštarte a po aktualizácii. Ručne: `node scripts/hud.mjs --reload`.
- **Jarvis je vždy len jeden.** Keď sa popri otvorenom Jarvisovi otvorí ďalšie okno (napríklad adresa v prehliadači),
  hovorí a počúva len to prvé, druhé je na pozeranie a povie to. Úlohy na pozadí si už zmeny neoverujú otváraním
  Jarvisa v Chrome.

## 1.9.6 (2026-11-23)

- **Nové písmo: Mona Sans.** Celý Jarvis (hlavná obrazovka, Nastavenia, vnútro planét, appky aj sprievodca) je
  vysádzaný písmom Mona Sans namiesto Inter Tight. Veľké hodiny majú upravený rozostup čísel, aby sa jednotky nezlievali.

## 1.9.5 (2026-11-23)

- **Reštart už nezabije rozrobenú prácu.** Keď na pozadí beží úloha, reštart Jarvisa počká, kým dobehne, a spraví sa
  potom sám. Doteraz reštart bežiace úlohy prerušil, a keď si ho vyžiadala úloha sama (po úprave Jarvisa), ukončila
  sa v polovici a Jarvis ostal vypnutý.

## 1.9.4 (2026-11-23)

- **Nové správy sa po aktualizácii neskryjú.** Keď sa server Jarvisa reštartoval (napríklad po aktualizácii) a okno
  ostalo otvorené, nové správy sa v Rozhovore neukázali, prepisovali staré riadky. Opravené.
- **Viac úloh naraz vidno naraz.** Každá bežiaca úloha má nad príkazovým riadkom vlastný riadok s bodkami a klik
  otvorí práve ju. Doteraz bolo vidno len jednu.
- **Vnútri planéty sa už nič neprekrýva.** Keď dobehne úloha, jej výsledok stlmí všetko za sebou. Titulky toho, čo
  Jarvis hovorí, aj riadky s úlohami sa zmestia vedľa bočného panela, nie pod neho, a nápoveda im ustúpi.
- **Planéta sa načíta aj po krátkom výpadku.** Keď server chvíľu neodpovedá, vnútro planéty to skúsi znova samo,
  namiesto hlášky „Failed to fetch".

## 1.9.3 (2026-11-23)

- **Jarvis o náročnosti úlohy naozaj mlčí.** Vo verzii 1.9.2 mu to nástroj na spúšťanie úloh stále pripomínal, takže
  to občas spomenul. Pripomienka je preč, model ostáva malým písmom pri úlohe.

## 1.9.2 (2026-11-23)

- **Prepnutie plocha, appka, prehliadač naozaj prepne.** Zmena v Nastaveniach → Plocha vo verzii 1.9 len uložila voľbu
  a stará plocha bežala ďalej. Teraz sa Jarvis presťahuje hneď: nové miesto sa otvorí a staré sa samo zavrie (plocha
  vráti ikony a skončí, okno appky sa zavrie). Jarvis býva vždy len na jednom mieste, aj po zapnutí počítača.
- **Ovládanie rukami funguje aj v okne appky (Mac).** Kamera sa v samostatnom okne zapla, ale nedávala obraz, takže
  ovládanie rukami ostalo visieť. macOS totiž žiadosť o kameru pripísal nesprávnemu programu. Opravené spúšťaním okna.
- **Jarvis už nehovorí, aká je úloha náročná.** Model si vyberá sám a potichu. Pri úlohe je len malým písmom názov
  modelu, ktorý na nej pracuje (v riadku nad príkazovým riadkom a v detaile úlohy).
- **Po aktualizácii treba appku na plochu postaviť znova** (aktualizácia to spraví), inak sa plocha pri sťahovaní sama nezavrie.

## 1.9.1 (2026-11-22)

- **Discord a iné hovory už neprídu o mikrofón (Mac, Jarvis na ploche).** Keď si začal hovoriť s Jarvisom, hovor
  v inej appke stratil mikrofón. Príčina bola v tom, ako mikrofón otvára jadro Safari v appke na ploche: pri každom
  otvorení na chvíľu reštartovalo zvukové zariadenia celého počítača. Mikrofón teraz otvára appka sama, čistým vstupom,
  ktorý sa ostatných appiek nedotkne. **Po aktualizácii treba appku na plochu postaviť znova** (aktualizácia to spraví).
- **Vlna pri hovorení beží hneď.** Pri hovorení sa vlna v príkazovom riadku objavila až po pár sekundách, hoci hlas sa
  už nahrával. Teraz reaguje od prvej chvíle a nahrávka má aj zlomok sekundy spred stlačenia, takže neodsekne prvú slabiku.

## 1.9.0 (2026-11-22)

- **Vidíš, že Jarvis pracuje.** Keď robí niečo dlhšie, nad príkazovým riadkom sú bodky a jedna veta: čo práve robí,
  na čom a ako dlho (napríklad „Čítam web · Plán výletu na víkend · 3:21"). Klik otvorí celý priebeh. Predtým pri
  dlhšej úlohe obrazovka stála a nebolo jasné, či sa niečo deje.
- **Jarvis ako samostatná appka.** Pri `štarte` si vyberáš z troch možností: na pracovnej ploche (Mac), ako samostatná
  appka vo vlastnom okne, alebo ako stránka v prehliadači. Appka má ikonu Jarvis: na Macu v Launchpade a v priečinku
  Aplikácie, na Windows na pracovnej ploche a v ponuke Štart. Klik ju otvorí, alebo vytiahne dopredu okno, ktoré už beží.
  Zmeniť sa to dá kedykoľvek v Nastaveniach → Plocha.
- **Stránka v prehliadači je naozaj len stránka.** Pri tejto voľbe sa Jarvis otvorí ako karta v tvojom prehliadači
  a po zapnutí počítača beží potichu na pozadí, žiadne okno sám neotvára.
- **Nastavenia sa ukladajú.** Prepínače „Model podľa úlohy" (Mozog) a „Kde ma máte" (Plocha) vo verzii 1.8 hlásili
  chybu a zmena sa neuložila. Opravené.

## 1.8.1 (2026-11-22)

- **O novej verzii sa dozvieš do hodiny.** Jarvis sa po novej verzii pozerá každú hodinu, doteraz to bolo raz za pol dňa.
  Stále platí, že sa len ozve a inštaluje až po tvojom áno.

## 1.8.0 (2026-11-21)

- **Jarvis aj na Gemini.** Tretí podporovaný mozog je Google Antigravity (účet Google, modely Gemini). Otvor priečinok
  v Antigravity, napíš `štart` a Jarvis sa pripraví rovnako ako na Claude alebo ChatGPT. Prihlásenie ostáva v Antigravity,
  Jarvis žiadne heslo ani kód nevidí ([docs/MODELY.md](docs/MODELY.md)).
- **Nový vzhľad všetkého za hlavnou obrazovkou.** Nastavenia, vnútro planét, detail položky aj Tvoje appky sú prerobené
  do jazyka hlavnej obrazovky: jedna sklenená doska so svetelnou hranou, veľké tenké nadpisy, čisté riadky namiesto
  kariet v kartách. Nastavenia majú menu vľavo a nové časti **Mozog** a **Plocha**.
- **Nič sa neprekrýva a nič nie je odseknuté.** Tlačidlo Opustiť je súčasťou hlavičky a nemá čo prekryť. Dátum, počasie
  a mesto sa pri dlhšom názve (Bratislava, Banská Bystrica) zalomia, namiesto troch bodiek. Dlhé názvy udalostí a úloh
  majú druhý riadok. Overené na obrazovkách od 1024 po 2560 px.
- **Mail s obsahom.** Klik na mail v orbe Pošta ukáže, čo v ňom naozaj stojí (kto čo chce, do kedy), návrh odpovede
  a tlačidlo, ktorým ju dáš Jarvisovi upraviť. Body vo vnútri planét sú rozložené v pravidelných kruhoch.
- **Rutiny sedia.** Číslo na orbe Rutiny je počet zapnutých rutín a vnútri je prehľadná tabuľka: čo beží dnes, čo inokedy
  a čo je vypnuté, aj s budíkom. Predtým vnútro vyzeralo prázdne a číslo nesedelo.
- **Jarvis ti už neberie mikrofón.** Počas rozhovoru s Jarvisom prestal fungovať mikrofón v Discorde a iných hovoroch.
  Jarvis teraz nahráva surový zvuk bez systémového spracovania hlasu a mikrofón po chvíli vracia.
- **Model podľa úlohy.** Pred každou úlohou Jarvis povie, aká je náročná, a vyberie si model: na pozretie pošty rýchly,
  na tvorbu najsilnejší. Nastavíš to v Nastaveniach → Mozog (Automaticky, Najsilnejší, Najrýchlejší).
- **Odporúča sám.** Na ploche pribudla časť Odporúčam: čo našiel v počítači a ešte nemá pripojené, čo čaká na pripojenie
  a čo si všimol v pošte. Klikneš a spraví to, krížikom to zahodíš.
- **Na ploche, alebo v okne.** Pri `štarte` sa AI spýta, či chceš Jarvisa na pracovnej ploche (odporúčame), alebo ako
  stránku v prehliadači. Appku na plochu si Mac postaví sám. Potom ti vysvetlí, kde čo je: krúžok v lište hore, skratka,
  skrytie ikon na ploche. Tie isté prepínače sú v Nastaveniach → Plocha.
- **Čipy hore sa vysvetlia.** Keď prejdeš myšou na Ruky, Natáčanie alebo Hlas, ukáže sa, čo robia. Menu krúžku v lište
  má zrozumiteľné názvy.
- **Ikonky appiek.** Outlook, Slack, Teams, OneDrive, LinkedIn, Xbox, Canva, EduPage a Seznam mali namiesto ikonky len písmeno.
- **Inštalácia a aktualizácie.** README vedie krok za krokom aj človeka, ktorý nikdy nerozbaľoval ZIP. Aktualizácia
  funguje rovnako zo ZIP-u aj z gitu a už nehlási zbytočný konflikt pri súbore s podpisom.
- **Opravy.** Číslo v karte orbu sa nestratí, keď ho Jarvis zapíše ako číslo. Uloženie výberu appiek už nekončí chybou.

## 1.7.1 (2026-11-18)

- **Pýta sa Jarvis, nie úloha.** Keď práca na pozadí potrebuje od teba informáciu, spýta sa ťa Jarvis sám, hlasom
  a v rozhovore, s najlepším tipom („Na Instagrame som ho nenašiel. Ako sa ten účet volá presne?"). Odpovieš mu
  normálne a on pokračuje. Súhlas pred odoslaním mailu či správy je oddelený od otázok: otázka má pole na odpoveď,
  nie tlačidlo Schváliť.
- **Oslovenie a vykanie platia presne podľa Nastavení.** Stará poznámka v pamäti (napríklad z prvého nastavenia)
  už neprebije, čo si nastavil neskôr, a riadia sa tým aj vety z úloh na pozadí. Meno vždy v tvare z Nastavení,
  nikdy zdrobnenina.
- **HUD sedí na každej obrazovke.** Menšie notebooky (1280 až 1470 px) dostanú celé rozloženie proporčne zmenšené,
  namiesto natlačeného. Počasie už nevyteká z panelu, orby v strede sa neprekrývajú, pole „Povedz Jarvisovi…" sa
  nezúži na pár písmen, na širokých monitoroch je príkazový riadok rozumne široký a v Nastaveniach majú polia
  medzi sebou rovnaké medzery.

## 1.7.0 (2026-11-18)

- **Jarvis sa ozve sám, keď na tom záleží.** Na Nový rok, Štedrý deň, Veľkú noc, na tvoje narodeniny a meniny
  a v deň, keď ste spolu rok. Povie to raz: o polnoci, ak si pri počítači, inak ráno, keď k nemu prídeš, alebo na začiatku
  prvého rozhovoru v ten deň. Narodeniny si nastavíš v Nastaveniach, alebo mu ich povieš.
- **Cíti počítač, v ktorom žije.** Ozve sa, keď batéria klesne na 20, 10 a 5 percent (a poďakuje za nabíjačku),
  keď sa plní disk a keď vypadne a vráti sa internet. Príde to aj ako oznámenie systému.
- **Telefonáty sa nastavujú priamo v Jarvisovi.** V Nastaveniach je časť Telefonáty: štyri údaje z účtu Twilio
  a tlačidlo na skúšobný hovor. Údaje ostávajú v súbore `.env` v tvojom počítači.

## 1.6.3 (2026-11-18)

- **Úlohy a Kalendár stoja na mieste.** Tabuľa sa už nedá odtiahnuť ani priblížiť mimo obrazovky (myšou ani rukami),
  vždy sa zmestí medzi panely a prepočíta sa, keď sa zmení okno. Každý riadok má pri bodke svoj text a každý stĺpec
  nadpis.
- Tlačidlo Opustiť sa ukáže až vnútri planéty, nie počas príletu.

## 1.6.2 (2026-11-18)

- **Výsledky úloh ako oznámenia systému.** Keď úloha na pozadí skončí, čaká na tvoj súhlas alebo zlyhá, príde bežné
  oznámenie (macOS, Windows), aj keď práve robíš niečo iné. V appke na plochu má meno Jarvisa a klik naň otvorí danú
  úlohu. V tichých hodinách príde bez zvuku.

## 1.6.1 (2026-11-18)

- **Ovládanie appiek povie, ktoré povolenie chýba.** `node scripts/control.mjs status` ukáže zvlášť Prístupnosť
  a Nahrávanie obrazovky, `ask` otvorí správnu stránku v Nastaveniach systému.

## 1.6.0 (2026-11-18)

- **Jarvis ovláda prehliadač.** Úlohy na pozadí pracujú v tvojom vlastnom Chrome cez rozšírenie Claude in Chrome: klikajú,
  vypĺňajú a čítajú stránky, kde si prihlásený. Je to zapnuté bez nastavovania (vypneš cez `JARVIS_CHROME=0`).
- **Jarvis ovláda hocijakú appku** (macOS). Pozrie sa na obrazovku, klikne, napíše, stlačí klávesy
  (`scripts/control.mjs`). Raz mu v systéme povolíš Prístupnosť a Nahrávanie obrazovky.
- **Vidíš, čo robí.** Kým pracuje v prehliadači alebo myšou, okolo obrazovky svieti rámik s nápisom, čo práve robí,
  a zameriavač na mieste, kde kliká. V appke na plochu je nad všetkými oknami (`docs/OVLADANIE.md`).

## 1.5.2 (2026-11-18)

- **Ťahanie sa už nezasekne.** Myš a kurzor ruky sú dva samostatné ukazovatele: pohyb jedného už nerozhodí ťahanie
  druhého, takže svet po otáčaní rukou ani myšou neskáče. Štipnutie musí vydržať dva snímky, jeden roztrasený
  snímok kamery už neklikne ani nepustí ťahanie.

## 1.5.1 (2026-11-18)

- **„Ukázať, ako na to" funguje aj v appke na ploche.** Sprievodca, ako získať dáta z appky, sa otvorí priamo v Jarvisovi.
  Ostatné odkazy (napríklad web, ktorý Jarvis postavil) sa z appky na ploche otvoria v prehliadači.

## 1.5.0 (2026-11-18)

- **Ovládanie rukami.** Čip Ruky v lište zapne kameru a kurzor, ktorý ide za tvojou dlaňou. Štipnutím klikneš,
  štipnutím a pohybom otáčaš svet, dvoma rukami približuješ. Okno kamery si položíš, kam chceš. Obraz neopúšťa počítač
  (`docs/RUKY.md`).
- **Veľké tlačidlo Opustiť** vnútri každej planéty.
- **Slovenčina alebo čeština.** Jazyk sa nastaví podľa počítača, Jarvis si ho sám prepne, keď s ním hovoríš tým druhým,
  a prepínač je hore v Nastaveniach.
- **Nastavenia sa zmestia na obrazovku.** Okno už nevychádza pod Dock, obsah sa v ňom posúva.

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
