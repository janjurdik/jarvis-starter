# Hlas

Jarvis vie hovoriť aj počúvať. Hovorenie a počúvanie sú dve samostatné veci a každá má viac možností.

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

Po inštalácii HUD reštartuj (`node scripts/hud.mjs --restart`). Prvá veta trvá dlhšie,
lebo sa stiahnu súčasti hlasu. Ďalšie vety zaznejú do sekundy.

Iný hlas nastavíš v súbore `.env`:

```
JARVIS_EDGE_VOICE=sk-SK-ViktoriaNeural
```

Slovenské hlasy: `sk-SK-LukasNeural`, `sk-SK-ViktoriaNeural`. České: `cs-CZ-AntoninNeural`, `cs-CZ-VlastaNeural`.
Pre češtinu pridaj aj `JARVIS_LANG=cs`.

## Ako Jarvis počúva

V HUD podrž **medzerník**, povedz vetu a pusti. Na prepis reči na text sú tri možnosti (`JARVIS_STT` v `.env`):

| Možnosť | Kde funguje | Čo treba |
|---|---|---|
| `browser` (predvolené) | okno HUD v Chrome alebo Edge (macOS aj Windows) | nič, len povoliť mikrofón |
| `mlx` | Mac s Apple Silicon, aj v appke na ploche | `uv`, `ffmpeg`, model asi 1,6 GB |
| `faster` | Windows, Linux, starší Mac | `uv`, prepis je pomalší |
| `off` | | hlasové ovládanie vypnuté |

Pri možnosti `browser` reč spracúva služba prehliadača (Google alebo Microsoft). Pri `mlx` a `faster` zvuk
neopustí tvoj počítač.

### Lokálny Whisper na Macu (potrebný pre appku na ploche)

Appka „Jarvis HUD" na ploche Macu beží na jadre Safari, kde rozpoznávanie reči z prehliadača nemusí fungovať. Spoľahlivá cesta je lokálny prepis:

```sh
brew install ffmpeg
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Do `.env` pridaj `JARVIS_STT=mlx` a reštartuj HUD. Pri prvom otvorení HUD sa stiahne model (asi 1,6 GB), potom
prepis trvá necelú sekundu.

### „Hey Jarvis"

Keď beží lokálny prepis (`mlx` alebo `faster`), dá sa zapnúť aj počúvanie na slová „Hey Jarvis": klikni na čip
**Hlas** v hornej lište HUD. Prvé zapnutie stiahne malý model. Je to pokročilá, experimentálna funkcia.
Medzerník funguje vždy.

## Keď hlas nejde

- **Jarvis mlčí:** klikni raz do okna HUD. Prehliadač nepustí zvuk, kým na stránku neklikneš.
- **Medzerník nič nerobí:** klikni najprv mimo textového riadku. Skontroluj povolenie mikrofónu pre `localhost` (ikona zámku v paneli s adresou).
- **„Toto okno nevie rozpoznávať reč":** okno nie je Chrome ani Edge. Otvor HUD cez `node scripts/hud.mjs --browser`, alebo zapni lokálny Whisper.
- **Zlá výslovnosť mien:** skús iný hlas (`JARVIS_EDGE_VOICE`).
