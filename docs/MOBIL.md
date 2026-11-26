# Mobil: Jarvis aj v telefóne

Jarvis beží na tvojom počítači. S Mobilom ho máš aj v telefóne, odkiaľkoľvek: rozhovor, jeho hlas, podržanie
tlačidla a hovoríš, a úlohy na pozadí, ktoré čakajú na tvoj súhlas. Mobil je ľahká stránka, nie 3D svet z plochy.
Kto chce, otvorí si z nej aj celého Jarvisa.

Telefón sa k počítaču dostane cez šifrovaný tunel Cloudflare. Na počítači ostáva všetko ako predtým, bez hesla.
Zvonka pustí Jarvis len toho, kto sa prihlási tvojím e-mailom a heslom.

## Ako to zapnúť

Najjednoduchšie je povedať Jarvisovi „chcem ťa v mobile". Prevedie ťa tým sám. Ručne:

1. Na ploche otvor Nastavenia (posuvníky hore), časť **Mobil**.
2. Zadaj e-mail a heslo a klikni **Uložiť prihlásenie**. Heslo má aspoň 12 znakov a z toho tri druhy (malé a veľké
   písmená, číslice, iné znaky), alebo aspoň 16 znakov, napríklad štyri slová za sebou. Slovo s rokom na konci
   (`Bratislava2024`) neprejde. Také, ktoré nikde inde nepoužívaš.
   Heslo sa píše len sem, nikdy do rozhovoru s Jarvisom.
3. Zapni **Mobilný prístup**. Prvýkrát si Jarvis doinštaluje program `cloudflared` a o pár sekúnd ukáže adresu a QR kód.
4. Naskenuj QR kód telefónom, prihlás sa a pridaj si Jarvisa na plochu:
   - **iPhone**: v Safari tlačidlo Zdieľať, potom Pridať na plochu.
   - **Android**: v Chrome ponuka (tri bodky), potom Pridať na plochu alebo Inštalovať aplikáciu.

Odvtedy ho otváraš ikonou ako každú appku. Prihlásenie vydrží 30 dní od posledného použitia.

Z príkazového riadku (to isté robí Jarvis):

```bash
node scripts/tunnel.mjs status      # zapnuté, adresa, prihlásené zariadenia
node scripts/tunnel.mjs start       # zapne mobilný prístup a počká na adresu
node scripts/tunnel.mjs stop        # vypne ho, zavrie tunel a odhlási všetky zariadenia
node scripts/tunnel.mjs show        # otvorí na ploche Nastavenia, časť Mobil, s QR kódom
node scripts/tunnel.mjs install     # len doinštaluje cloudflared
```

E-mail a heslo sa príkazom nastaviť nedajú, len v Nastaveniach.

## Rýchly alebo vlastný tunel

**Rýchly** (predvolený) nepotrebuje účet ani nastavovanie. Adresa má tvar `https://nahodne-slova.trycloudflare.com`
a **mení sa pri každom spustení tunela**, teda aj po reštarte Jarvisa. Potom stačí naskenovať nový QR kód.

**Vlastný Cloudflare** dá trvalú adresu na tvojej doméne, napríklad `https://jarvis.mojadomena.sk`. Potrebuješ
účet Cloudflare a doménu v ňom:

1. Cloudflare, **Zero Trust**, **Networks**, **Tunnels**, **Create a tunnel**, typ **Cloudflared**, pomenuj ho.
2. Pri inštalácii ukáže príkaz s dlhým reťazcom za `--token`. Ten reťazec je token tunela. Nič neinštaluj, stačí ho skopírovať.
3. V tuneli pridaj **Public hostname**: tvoja adresa (napríklad `jarvis` a doména `mojadomena.sk`) a služba
   `http://localhost:4545` (port Jarvisa, `node scripts/hud.mjs --info`).
4. V Nastaveniach, časť Mobil, prepni Tunel na **Vlastný Cloudflare**, zadaj adresu a token a klikni Uložiť tunel.

Token sa uloží do `data/brain/tunnel-token` a do stránky sa už nikdy nevráti.

## Bezpečnosť

- Kto pozná e-mail a heslo, ovláda cez Jarvisa tento počítač: číta pamäť a spúšťa úlohy. Preto silné heslo,
  ktoré nikde inde nepoužívaš.
- Heslo sa neukladá. V `data/brain/remote.json` je len jeho odtlačok (scrypt s náhodnou soľou).
- Prihlásenie je náhodný kľúč v cookie, ku ktorej sa stránka ani iný web nedostane (`__Host-`, HttpOnly, Secure,
  SameSite=Strict). Na počítači je z neho uložený len odtlačok.
- Každé prihlásenie nechá v telefóne aj druhú cookie, **známe zariadenie** (400 dní, prežije odhlásenie). Podľa nej
  Jarvis vie, že je to tvoj telefón, a pustí ho, aj keď je prihlasovanie pre ostatných zavreté.
- Zlé heslo: po piatich pokusoch čaká adresa 30 sekúnd, potom zakaždým dvakrát dlhšie, až hodinu. Pri IPv6 sa
  počíta celá sieť /64 ako jedna adresa. Keď prídu zlé pokusy z mnohých adries naraz, prihlasovanie sa zavrie pre
  všetky nové zariadenia, najprv na 10 minút a pri ďalšom útoku v ten istý deň zakaždým na dvojnásobok (najviac 12
  hodín). Známe zariadenia sa prihlásia aj vtedy, s vlastnou brzdou. Na počítači o tom príde oznámenie.
- Nové heslo, vypnutie Mobilu alebo **Odhlásiť všetky zariadenia** (v Nastaveniach) odhlási všetky zariadenia. Nové
  heslo a tlačidlo zabudnú aj známe zariadenia: každé sa potom prihlási ako nové.
- Nič sa nedeje potichu. Na počítači príde oznámenie, riadok v LOGu a karta, keď sa prvýkrát prihlási nové zariadenie
  (aké a kedy), keď sa zmení e-mail alebo heslo, keď sa spustí tunel (s adresou) a keď sa prihlasovanie zavrie. Kým
  tunel beží, je v lište hore čip **Mobil zapnutý**, klik naň otvorí Nastavenia, časť Mobil. Tam je pri každom
  zariadení, kedy sa naposledy prihlásilo.
- Token HUD (`data/brain/token`, pre `HUD_HOST=0.0.0.0` v domácej sieti) cez tunel neplatí. Z internetu sa dá dostať
  dnu len prihlásením.
- Nesprávne prihlásenia sa zapisujú do logu so zariadením a krajinou, z ktorej prišli (ak ju Cloudflare pozná), nikdy s heslom.
- `cloudflared` z GitHubu má Jarvis pripnutý na overenú verziu a pred spustením skontroluje jeho odtlačok SHA-256.
  Homebrew a winget ostávajú, ako boli.
- Zvonka sa nedá zmeniť nič, čo sa týka samotného prístupu (heslo, tunel, zariadenia), ani vnútorné veci, ktoré smú
  len programy na počítači. Nastavenia, časť Mobil, mení len obrazovka na počítači.
- Nič z tunela sa neukladá v medzipamäti Cloudflare.
- Nikdy neotváraj Jarvisa do internetu inak: žiadne presmerovanie portu na routri, žiadny iný tunel bez prihlásenia.

## Hlas v mobile

Kým máš Jarvisa otvoreného v telefóne, hovorí telefón a počítač mlčí. Keď telefón zamkneš alebo stránku zavrieš,
hlas sa vráti na počítač. Podržaním tlačidla mikrofónu hovoríš: s lokálnym Whisperom na počítači ide nahrávka
na prepis tam, inak ju prepíše rozpoznávanie reči v telefóne. Mikrofón v prehliadači funguje len cez https, a to
tunel má.

## Keď niečo nejde

| Príznak | Čo s tým |
|---|---|
| Stránka sa neotvorí | `node scripts/tunnel.mjs status`. Beží Jarvis? Rýchly tunel má po reštarte novú adresu. |
| Tunel nejde | Chyba je v Nastaveniach pri prepínači a celý výpis v `data/logs/tunnel.log`. |
| „Priveľa nesprávnych pokusov" | Počkaj, koľko stránka ukazuje. Heslo si vieš zmeniť na počítači. |
| Zabudnuté heslo | Na počítači v Nastaveniach, časť Mobil, nastav nové. |
| Jarvis v mobile nehovorí | Raz ťukni kamkoľvek na stránku, telefón pustí zvuk až po dotyku. Skontroluj tichý režim. |

## Pre tých, čo Jarvisa stavajú

- `hud/server/remote.mjs`: účet, heslo, prihlásenia, brzdy proti hádaniu hesla a brána pre požiadavky zvonka.
- `hud/server/tunnel.mjs`: hľadanie a inštalácia `cloudflared`, beh tunela ako dieťaťa servera, opätovný štart.
- `hud/server/mobile.mjs`: endpointy `/api/remote/*` a prúd udalostí cez WebSocket. Rýchly tunel Cloudflare
  zadržiava server-sent events, preto stránky otvorené cez tunel čítajú `/api/events` cez `/api/events/ws`
  (`hud/public/js/events.js`), na počítači ostáva EventSource.
- `hud/public/m/`: stránka pre mobil, prihlásenie, manifest a ikony. QR kód robí `hud/public/m/qr.js` priamo v stránke.
- Endpointy sú v `docs/API.md`, časť Mobil.
