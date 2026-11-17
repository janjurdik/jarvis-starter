#!/bin/sh
# Builds "Jarvis HUD.app" (the HUD as the desktop wallpaper) and installs it into ~/Applications.
# macOS only, needs the Xcode command line tools (xcode-select --install).
#   sh hud/desktop/build.sh          build + install, restarts the app if it was running
#   sh hud/desktop/build.sh --open   build + install + launch
set -eu
cd "$(dirname "$0")"

OUT=build
APP_NAME="Jarvis HUD.app"
DEST="$HOME/Applications/$APP_NAME"
REPO="$(cd ../.. && pwd)"
NODE="$(command -v node || true)"
PORT="${PORT:-4545}"
ARCH="$(uname -m)"

if [ -z "$NODE" ]; then echo "node sa nenašiel v PATH"; exit 1; fi
if ! command -v swiftc >/dev/null 2>&1; then echo "chýba swiftc: spusti xcode-select --install"; exit 1; fi

rm -rf "$OUT"
mkdir -p "$OUT/$APP_NAME/Contents/MacOS" "$OUT/$APP_NAME/Contents/Resources"
swiftc -O -swift-version 5 -target "$ARCH-apple-macosx14.0" \
  -o "$OUT/$APP_NAME/Contents/MacOS/JarvisHUD" main.swift
# The app starts the HUD server itself, so it has to know where the Jarvis folder and node are.
# The values go through the plist tool, not through sed: a folder name with & or | would break a substitution.
cp Info.plist "$OUT/$APP_NAME/Contents/Info.plist"
for pair in "__JARVIS_REPO__=$REPO" "__JARVIS_NODE__=$NODE" "__JARVIS_PORT__=$PORT"; do
  key="${pair%%=*}"; value="${pair#*=}"
  JARVIS_KEY="$key" JARVIS_VALUE="$value" /usr/bin/perl -0pi -e 's/\Q$ENV{JARVIS_KEY}\E/$ENV{JARVIS_VALUE} =~ s{&}{&amp;}gr =~ s{<}{&lt;}gr/ge' "$OUT/$APP_NAME/Contents/Info.plist"
done
cp AppIcon.icns "$OUT/$APP_NAME/Contents/Resources/AppIcon.icns"
# Ad-hoc signature by default. With your own identity (JARVIS_SIGN_IDENTITY) macOS remembers the
# microphone permission across rebuilds.
if [ -n "${JARVIS_SIGN_IDENTITY:-}" ]; then
  codesign --force --timestamp=none --sign "$JARVIS_SIGN_IDENTITY" "$OUT/$APP_NAME"
else
  codesign --force --sign - "$OUT/$APP_NAME"
fi
codesign --verify "$OUT/$APP_NAME"

if [ "${1:-}" = "--no-install" ]; then echo "postavené: $PWD/$OUT/$APP_NAME"; exit 0; fi

# Never replace an app of the same name that did not come from this project.
if [ -d "$DEST" ]; then
  existing="$(/usr/bin/defaults read "$DEST/Contents/Info" CFBundleIdentifier 2>/dev/null || true)"
  if [ "$existing" != "com.jarvis-starter.hud" ] && [ "${1:-}" != "--force" ]; then
    echo "V $DEST už je iná appka s rovnakým názvom ($existing). Nič neprepisujem."
    echo "Postavená appka je tu: $PWD/$OUT/$APP_NAME"
    exit 1
  fi
fi

was_running=0
if pgrep -x JarvisHUD >/dev/null 2>&1; then was_running=1; pkill -x JarvisHUD || true; sleep 1; fi
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
cp -R "$OUT/$APP_NAME" "$DEST"
echo "nainštalované: $DEST"
if [ "${1:-}" = "--open" ] || [ $was_running = 1 ]; then open "$DEST"; fi
