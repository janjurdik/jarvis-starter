# Videá a zvuk budíka

Jarvis vie stiahnuť video z YouTube a z väčšiny stránok s videom, ukázať ho na ploche, preskakovať v ňom a čítať
jeho prepis. Tým istým nástrojom si pri nastavení stiahne pesničku na budík. Nič sa neinštaluje ručne: nástroj
yt-dlp aj ffmpeg si Jarvis berie sám cez `uv`, ktoré už má kvôli hlasu.

## Čo to robí

Pošli Jarvisovi odkaz na video (napíš ho, vlož, alebo povedz „pusti mi toto video"). Na ploche sa otvorí kino:

1. Jarvis prečíta údaje o videu (názov, autor, dĺžka, kapitoly).
2. Stiahne titulky a spraví z nich prepis s časmi. Berie titulky písané ľuďmi v tvojom jazyku, potom v jazyku
   videa, a až potom automatické.
3. Stiahne video (najviac 720p) a zmeria jeho zvuk, z toho je vlna pod obrazom.

Potom sa video pustí. Pod obrazom je lišta s kapitolami, vlnou zvuku a miestami, kde sa hovorí. Vpravo beží prepis,
klik na riadok tam preskočí a v prepise sa dá hľadať. Jarvisovi stačí povedať:

- „preskoč na 12:40", „vráť to o 30 sekúnd", „zastav to", „pusti to rýchlejšie",
- „o čom je to video?", „kde hovorí o cenách?", „zhrň mi prvých desať minút",
- „zavri video".

Klávesy fungujú, keď do kina klikneš: medzerník pustí a zastaví, šípky vľavo a vpravo skočia o 5 sekúnd (so Shiftom
o 30), šípky hore a dole menia hlasitosť, M stlmí zvuk, lomka skočí do hľadania, Esc kino zavrie. Keď píšeš
Jarvisovi dole do riadku, medzerník píše medzeru a mimo kina ním hovoríš ako vždy. Kým Jarvis počúva alebo hovorí,
video sa samo stíši.

Z príkazového riadku:

```bash
node scripts/media.mjs video "<odkaz>"        # otvorí video v kine (keď HUD nebeží, len ho stiahne)
node scripts/media.mjs transcript "<odkaz>"   # prepis s časmi, bez sťahovania videa
node scripts/media.mjs audio "<odkaz>"        # zvuk ako mp3
node scripts/media.mjs info "<odkaz>"         # názov, dĺžka, kapitoly
```

## Obmedzenia

- Video môže mať najviac 180 minút a 1500 MB. Živé vysielania, videá len pre prihlásených a videá s vekovým
  obmedzením sa stiahnuť nedajú, Jarvis povie prečo.
- Prepis je z titulkov. Video bez titulkov prepíše Jarvis sám len vtedy, keď máš zapnutý lokálny prepis reči
  (`docs/HLAS.md`), najviac do 60 minút a v jazyku, v ktorom s ním hovoríš. Inak ostane bez prepisu.
- Na disku ostáva posledných 6 videí (najviac 6 GB), staršie sa mažú samy.
- Jarvis používa overenú verziu yt-dlp. Keď niektorá stránka zmení pravidlá a tá verzia prestane stačiť, skúsi raz
  najnovšiu a dva týždne ju používa.
- Všetky čísla sa dajú zmeniť v `.env` (vzor je v `.env.example`, časť Videá), potom `node scripts/hud.mjs --restart`.
- Sťahuj len to, na čo máš právo. Videá ostávajú v tvojom počítači, Jarvis ich nikam neposiela.

## Kde sú súbory

| Kde | Čo |
|---|---|
| `data/video/<id>/` | jedno video: `video.mp4`, náhľad, `transcript.json` (prepis), `peaks.json` (vlna), `meta.json` |
| `data/alarm/sound-default.mp3` | pesnička na budík stiahnutá pri nastavení (Highway to Hell) |
| `data/alarm/sound-stay.mp3` | druhá pesnička z ponuky (Should I Stay or Should I Go) |
| `data/alarm/sound-custom.*` | tvoj vlastný zvuk budíka |
| `data/alarm/ring-*.mp3` | úsek, ktorý naozaj hrá: začiatok zvuku s plynulým nábehom |

Priečinok `data/` sa neukladá do gitu a pri aktualizácii sa nemení.

## Zvuk budíka

Pri nastavení Jarvis spustí `node scripts/media.mjs prepare`. Ten pripraví yt-dlp a stiahne dve pesničky na budík:
Highway to Hell (adresa je v `.env` ako `JARVIS_ALARM_SONG_URL`) a Should I Stay or Should I Go. Pesničky nie sú
súčasťou Jarvisa, každá sa stiahne raz do tvojho počítača. Keď sa to nepodarí, nastavenie pokračuje a budík zvoní
pôvodným zvonením Jarvisa.

Ktorou ťa má budiť, si vyberieš klikom na karte budíka v rozhovore (Jarvis ju ukáže pri nastavení, neskôr stačí
povedať „zmeň mi skladbu na budík"). Pri každej je ukážka.

Ráno pesnička hrá 45 sekúnd s plynulým nábehom a potom Jarvis povie ranný brief. Kým hrá, na obrazovke je „Dobré
ráno" s tlačidlom Zastaviť budík: zvonenie stíchne a brief zaznie hneď. Vlastný zvuk:

- **V HUD:** pretiahni do okna súbor mp3, wav alebo m4a a povedz „toto chcem ako budík". Alebo pošli odkaz na video
  a povedz „toto mi daj ako budík".
- **Príkazom:**

```bash
node scripts/alarm.mjs sound                      # čo je nastavené
node scripts/alarm.mjs sound "~/Music/rano.mp3"   # vlastný súbor
node scripts/alarm.mjs sound "<odkaz na video>"   # zvuk z videa
node scripts/alarm.mjs songs                      # skladby z ponuky
node scripts/alarm.mjs sound default              # späť na stiahnutú pesničku (Highway to Hell)
node scripts/alarm.mjs sound stay                 # druhá z ponuky (Should I Stay or Should I Go)
node scripts/alarm.mjs card 06:30                 # karta budíka na obrazovke: čas a výber skladby klikom
node scripts/alarm.mjs sound builtin              # späť na zvonenie Jarvisa
node scripts/alarm.mjs sound default --seconds 60 # ako dlho hrá, kým začne hovoriť
node scripts/alarm.mjs test --quick               # vyskúšať hneď
```

Voľba je v `config/jarvis.json` pod `alarm.sound` (`default`, `stay`, `builtin` alebo názov súboru v `data/alarm`) a dĺžka pod
`alarm.soundSeconds`. Keď vybraný súbor chýba alebo sa nedá prehrať, zazvoní pôvodné zvonenie. Budík nikdy neostane
ticho.
