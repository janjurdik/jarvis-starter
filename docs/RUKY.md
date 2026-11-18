# Ovládanie rukami

Jarvisa vieš ovládať rukami pred kamerou, bez myši. Hore v lište klikni na **Ruky** (ikona kamery).
Objaví sa okno s tvojou kamerou a na obrazovke kurzor, ktorý ide za tvojou dlaňou.

## Gestá

| Gesto | Čo spraví |
|---|---|
| ruka pred kamerou | kurzor ide za dlaňou |
| štipnutie (palec a ukazovák k sebe a od seba) | klik |
| štipnutie a pohyb ruky | ťahanie: otáča svet, posúva okno kamery |
| obe ruky zoštipnuté, od seba alebo k sebe | priblíženie a oddialenie |

Kým držíš štipnutie na mieste, kurzor stojí, takže klik padne tam, kam si mieril. Oblúk okolo kurzora ukazuje,
ako blízko je štipnutie. Vnútri každej planéty je vľavo hore veľké tlačidlo **Opustiť**.

Okno kamery si chyť (myšou alebo štipnutím) a polož, kam chceš. Jarvis si miesto zapamätá. Krížik ovládanie vypne
a kamera zhasne.

## Súkromie

- Obraz z kamery nikam neodchádza a nikde sa neukladá. Spracúva sa v okne Jarvisa, v tvojom počítači.
- Ruky hľadá model MediaPipe Hand Landmarker (Google, licencia Apache 2.0). Súbor modelu (7,8 MB) sa stiahne raz,
  pri prvom zapnutí, a Jarvis overí jeho kontrolný súčet. Potom funguje bez internetu.
- Kamera svieti len vtedy, keď je ovládanie zapnuté.

## Keď to nejde

- **„Kamera je zamietnutá":** povoľ kameru pre appku, v ktorej Jarvis beží. macOS: Nastavenia systému → Súkromie
  a bezpečnosť → Kamera. V prehliadači klikni na ikonu kamery v riadku s adresou.
- **Appka na plochu z verzie pred 1.5.0** kameru nepozná: zostav ju nanovo, `sh hud/desktop/build.sh`.
- **Kurzor skáče alebo ruku stráca:** pomôže svetlo spredu a ruka 40 až 80 cm od kamery, celá v zábere.
- **Klik sa nechytá:** štipni krátko a ruku pri tom nehýb. Dlhší pohyb počas štipnutia je ťahanie.
