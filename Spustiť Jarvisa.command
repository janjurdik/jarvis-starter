#!/bin/sh
# Dvojklik na Macu: pripraví počítač a položí Jarvisa na plochu.
# Ak macOS súbor neotvorí, klikni naň pravým tlačidlom a zvoľ Otvoriť.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Jarvis potrebuje Node.js. Stiahni verziu LTS z https://nodejs.org, nainštaluj ju a spusti tento súbor znova."
  open "https://nodejs.org" 2>/dev/null
  printf "Stlač Enter na zavretie."; read -r _
  exit 1
fi
node scripts/setup.mjs
printf "\nToto okno môžeš zavrieť. Stlač Enter."; read -r _
