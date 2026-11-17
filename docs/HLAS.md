# Hlas

Jarvis vie hovoriť aj počúvať. Hovorenie a počúvanie sú dve samostatné veci a každá má viac možností.
Všetko podstatné sa pripraví samo pri prvom spustení, ručne netreba inštalovať nič okrem programu `uv`.

## Ako Jarvis hovorí

| Možnosť | Čo treba | Poznámka |
|---|---|---|
| `edge` (predvolené) | program `uv` | Neurálny hlas od Microsoftu, zadarmo. Slovenčina aj čeština. |
| `browser` | nič | Hlas, ktorý má tvoj prehliadač. Použije sa sám, keď chýba `uv`. |
| `say` | macOS | Systémový hlas Macu, funguje aj bez internetu. |
| `elevenlabs` | vlastný kľúč | Platená služba, nastavuje sa v `.env`. |
| `off` | nič | Jarvis len píše. |

Inštalácia `uv` (jeden príkaz):

- macOS: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- Windows (PowerShell): `irm https://astral.sh/uv/install.ps1 | iex`

### Hlas, meno a rod

Kto Jarvis je a akým hlasom hovorí, sa nastavuje v nastaveniach HUD, alebo mu to stačí povedať:
„hovor ženským hlasom", „hovor pomalšie", „oslovuj ma pani", „tykaj mi", „volaj sa Friday".
Zmena platí hneď, bez reštartu. Ukladá sa do `config/jarvis.json`:

```json
{
  "assistant": { "name": "Jarvis", "gender": "male" },
  "voice": { "id": "sk-SK-LukasNeural", "rate": "+4%", "pitch": "-2Hz" },
  "userGender": "male",
  "language": "sk"
}
```

- `assistant.gender`: `male` alebo `female`. Hlas ide s ním: po zmene rodu sa prepne na hlas toho istého jazyka
  a naopak, keď vyberieš hlas, rod sa nastaví podľa neho.
- `voice.id`: konkrétny hlas. Keď chýba, platí `JARVIS_EDGE_VOICE` z `.env`, a keď nie je ani ten, predvolený hlas
  podľa jazyka a rodu.
- `voice.rate` a `voice.pitch`: rýchlosť reči a výška hlasu (`+10%`, `-5Hz`).
- `userGender`: tvoj rod, aby Jarvis vedel, či si „pripravený" alebo „pripravená". Môže ostať prázdny.
- `language`: `sk` alebo `cs`. Platí pre hlas aj pre rozpoznávanie reči. `JARVIS_LANG` v `.env` má prednosť.

| Jazyk | Mužský hlas | Ženský hlas |
|---|---|---|
| slovenčina | `sk-SK-LukasNeural` (Lukáš) | `sk-SK-ViktoriaNeural` (Viktória) |
| čeština | `cs-CZ-AntoninNeural` (Antonín) | `cs-CZ-VlastaNeural` (Vlasta) |

Na výber sú aj viacjazyčné hlasy (Andrew, Brian, Rémy, Ava, Emma, Vivienne). Po slovensky
a po česky hovoria s ľahkým cudzím prízvukom. V nastaveniach si každý hlas môžeš pred uložením vypočuť.

Každý hlas má vlastné nahrávky v `data/tts/`, takže po zmene hlasu nezaznie nič starým hlasom.

Keď okno HUD nie je otvorené, Jarvis hovorí cez reproduktory počítača tým istým hlasom: budík ráno, pripomienky
a výsledky rutín. Na Macu prehráva `afplay`, na Windows PowerShell. Keď to nechceš (okrem budíka), daj do `.env`
`JARVIS_LOCAL_VOICE=0`.

## Ako Jarvis počúva

V HUD podrž **medzerník**, povedz vetu a pusti.

Predvolene Jarvis počúva **lokálnym Whisperom**: reč sa prepisuje priamo v tvojom počítači, zvuk ho neopustí
a po slovensky aj po česky spravidla rozumie lepšie než rozpoznávanie v prehliadači. Ktorý model dostaneš,
rozhodne Jarvis sám podľa toho, čo tvoj počítač utiahne. Keď je počítač slabý, na disku je málo miesta alebo
chýba `uv`, počúva cez prehliadač (Chrome alebo Edge) a povie ti prečo.

### Čo sa vyberie

| Počítač | Čo dostane | Na disku |
|---|---|---|
| Mac s Apple Silicon, 16 GB pamäte a viac | Whisper `large-v3-turbo` cez MLX, najpresnejší | 1,6 GB model, 1,2 GB súčasti |
| Mac s Apple Silicon, 8 GB pamäte | Whisper `small` cez MLX | 0,5 GB model, 1,2 GB súčasti |
| Windows alebo Linux s grafickou kartou NVIDIA (aspoň 4 GB pamäte karty, 8 GB pamäte počítača) | Whisper `large-v3-turbo` na grafickej karte | 1,6 GB model, 3 GB súčasti |
| Windows, Linux alebo Intel Mac bez takej karty, so 4 a viac jadrami a 8 GB pamäte | Whisper `small` na procesore | 0,5 GB model, 0,5 GB súčasti |
| slabší počítač | rozpoznávanie v prehliadači | nič |

Ďalšie pravidlá:

- **Miesto na disku.** Po stiahnutí musí ostať voľných aspoň 1,5 GB. Keď sa nezmestí veľký model, skúsi sa
  menší, a keď ani ten, počúva prehliadač. Akonáhle sa miesto uvoľní, Jarvis to pri ďalšom spustení skúsi znova.
- **Skúška naostro.** Po stiahnutí Jarvis vysloví skúšobnú vetu a nechá si ju prepísať. Keď prepis jednej vety
  trvá dlhšie ako 4 sekundy, model je na tvoj počítač priveľký a vyberie sa menší (alebo prehliadač).
- **Veľký model len s grafikou.** `large-v3-turbo` potrebuje čip Apple Silicon alebo kartu NVIDIA. Na samotnom
  procesore mu jedna veta trvá okolo ôsmich sekúnd, preto sa tam vyberá `small`.
- **Grafická karta.** Keď sa karta NVIDIA nedá použiť (starý ovládač, chýbajúce knižnice), Whisper pobeží na procesore.
- **Len viacjazyčné modely.** Anglické modely (`small.en`, `distil-…`) po slovensky nevedia, Jarvis ich odmietne.
  Model `base` sa sám nevyberie nikdy: po slovensky pomýli skoro každé druhé slovo.
- **Výber sa nemení.** Čo sa raz pripravilo, platí pri každom spustení. Zapísané je to v `data/voice/stt-plan.json`.

Čo má tvoj počítač a prečo, ukáže:

```sh
node scripts/voice.mjs plan
node scripts/doctor.mjs
```

### Príprava pred prvým spustením

`node scripts/hud.mjs` pred prvým otvorením okna sám spustí prípravu a ukazuje priebeh. Ručne:

```sh
node scripts/voice.mjs prepare
```

Stiahne model (prerušené sťahovanie pokračuje tam, kde skončilo, a každý súbor sa skontroluje podľa odtlačku),
pripraví súčasti hlasu a všetko vyskúša. Dá sa spustiť kedykoľvek znova, čo je hotové, preskočí.
`--force` spraví všetko odznova a vyberie model nanovo (napríklad po pridaní pamäte).

Okno HUD na prípravu čaká najviac 15 minút (`JARVIS_PREPARE_WAIT_S`). Pri pomalom internete sa potom otvorí,
sťahovanie pokračuje na pozadí, Jarvis zatiaľ počúva cez prehliadač a na Whisper sa prepne sám.

Modely sú v `~/.cache/jarvis/models` (Windows: `%LOCALAPPDATA%\Jarvis\models`), mimo priečinka Jarvisa. Iné miesto
nastavíš cez `JARVIS_MODELS_DIR`. Keď už model máš stiahnutý v pamäti Hugging Face (`~/.cache/huggingface`),
použije sa ten a nič sa nesťahuje. Zmazaním priečinka miesto uvoľníš, Jarvis si model v prípade potreby stiahne znova.

`ffmpeg` netreba inštalovať: zvuk z mikrofónu číta program, ktorý sa stiahne spolu so súčasťami Whispera.

### Ako to zmeniť

V nastaveniach HUD: automaticky, v prehliadači, alebo lokálny Whisper (`"stt"` v `config/jarvis.json`:
`auto`, `browser`, `whisper`). V `.env` sa dá nastaviť presnejšie a `.env` má prednosť:

| `JARVIS_STT` | Čo spraví |
|---|---|
| `auto` (predvolené) | lokálny Whisper, keď ho počítač utiahne, inak prehliadač |
| `whisper` | lokálny Whisper aj na slabšom počítači (najmenej model `small`) |
| `mlx` | Whisper cez MLX, Mac s Apple Silicon |
| `faster` | Whisper cez faster-whisper: Windows, Linux, Intel Mac |
| `browser` | rozpoznávanie v prehliadači, nič sa nesťahuje. Reč spracúva služba prehliadača (Google alebo Microsoft). |
| `off` | hlasové ovládanie vypnuté |

- `JARVIS_WHISPER_MODEL`: konkrétny model namiesto automatického výberu. `large-v3-turbo` (1,6 GB), `medium` (1,5 GB),
  `small` (0,5 GB), `base` (0,15 GB), alebo vlastný model z Hugging Face (napríklad `mlx-community/whisper-large-v3-mlx`).
- `JARVIS_WHISPER_DEVICE=cpu`: nepoužívať grafickú kartu.

Po zmene v `.env` spusti `node scripts/hud.mjs --restart`.

### Appka na ploche Macu

Appka „Jarvis HUD" beží na jadre Safari, kde rozpoznávanie reči z prehliadača nemusí fungovať. S lokálnym
Whisperom (predvolené) to nevadí. Keď medzerník ohlási, že okno nevie rozpoznávať reč, pozri
`node scripts/voice.mjs plan`: povie, prečo sa Whisper nepripravil.

### „Hey Jarvis"

Keď beží lokálny Whisper, dá sa zapnúť aj počúvanie na slová „Hey Jarvis": klikni na čip
**Hlas** v hornej lište HUD. Prvé zapnutie stiahne malý model. Je to pokročilá, experimentálna funkcia.
Medzerník funguje vždy.

## Keď hlas nejde

- **Jarvis mlčí:** klikni raz do okna HUD. Prehliadač nepustí zvuk, kým na stránku neklikneš.
- **Medzerník nič nerobí:** klikni najprv mimo textového riadku. Skontroluj povolenie mikrofónu pre `localhost` (ikona zámku v paneli s adresou).
- **„Toto okno nevie rozpoznávať reč":** okno nie je Chrome ani Edge a lokálny Whisper nie je pripravený. Spusti `node scripts/voice.mjs prepare`, alebo otvor HUD cez `node scripts/hud.mjs --browser`.
- **Jarvis zle rozumie:** `node scripts/voice.mjs plan` ukáže, čím počúva. Model `small` robí viac chýb než `large-v3-turbo`. Na Macu s Apple Silicon alebo s kartou NVIDIA skús `JARVIS_WHISPER_MODEL=large-v3-turbo` a `node scripts/voice.mjs prepare --force`. Na počítači bez grafiky býva presnejšie rozpoznávanie v prehliadači (`JARVIS_STT=browser`).
- **Prepis trvá dlho:** skús menší model (`JARVIS_WHISPER_MODEL=small`) alebo `JARVIS_STT=browser`.
- **Príprava zlyhala:** dôvod je v `node scripts/voice.mjs plan` a v `data/logs/voice-prepare.log`. Pri výpadku internetu to Jarvis po pár hodinách skúsi znova sám, hneď to spravíš cez `node scripts/voice.mjs prepare`.
- **Zlá výslovnosť mien:** skús iný hlas v nastaveniach.
