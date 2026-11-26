#!/bin/sh
# Builds "Jarvis.app", the one Jarvis app for the Mac (on the desktop or in its own window), and
# installs it into ~/Applications (install.sh, which also replaces the apps of older versions).
# macOS only, needs the Xcode command line tools (xcode-select --install).
#   sh hud/desktop/build.sh               build + install, restarts the app if it was running
#   sh hud/desktop/build.sh --open        build + install + launch
#   sh hud/desktop/build.sh --no-install  only build (into hud/desktop/build)
# JARVIS_APP_DIR installs into another folder (tests, a second installation), JARVIS_BUILD_DIR builds elsewhere.
set -eu
cd "$(dirname "$0")"

OUT="${JARVIS_BUILD_DIR:-build}"
APP_NAME="Jarvis.app"
REPO="$(cd ../.. && pwd)"
NODE="$(command -v node || true)"
PORT="${PORT:-4545}"
ARCH="$(uname -m)"
# What the app was built from: scripts/hud.mjs builds it again when this changes (an update of Jarvis).
SOURCE="$(cat main.swift Info.plist | /usr/bin/shasum -a 256 | cut -d' ' -f1)"

if [ -z "$NODE" ]; then echo "node sa nenašiel v PATH"; exit 1; fi
if ! command -v swiftc >/dev/null 2>&1; then echo "chýba swiftc: spusti xcode-select --install"; exit 1; fi

rm -rf "$OUT/$APP_NAME"
mkdir -p "$OUT/$APP_NAME/Contents/MacOS" "$OUT/$APP_NAME/Contents/Resources"
swiftc -O -swift-version 5 -target "$ARCH-apple-macosx14.0" \
  -o "$OUT/$APP_NAME/Contents/MacOS/Jarvis" main.swift
# The app starts the HUD server itself, so it has to know where the Jarvis folder and node are.
# The values go through the plist tool, not through sed: a folder name with & or | would break a substitution.
cp Info.plist "$OUT/$APP_NAME/Contents/Info.plist"
for pair in "__JARVIS_REPO__=$REPO" "__JARVIS_NODE__=$NODE" "__JARVIS_PORT__=$PORT" "__JARVIS_SOURCE__=$SOURCE"; do
  key="${pair%%=*}"; value="${pair#*=}"
  JARVIS_KEY="$key" JARVIS_VALUE="$value" /usr/bin/perl -0pi -e 's/\Q$ENV{JARVIS_KEY}\E/$ENV{JARVIS_VALUE} =~ s{&}{&amp;}gr =~ s{<}{&lt;}gr/ge' "$OUT/$APP_NAME/Contents/Info.plist"
done
cp AppIcon.icns "$OUT/$APP_NAME/Contents/Resources/AppIcon.icns"
# Ad-hoc signature by default. With your own identity (JARVIS_SIGN_IDENTITY) macOS remembers the
# microphone and camera permission across rebuilds.
if [ -n "${JARVIS_SIGN_IDENTITY:-}" ]; then
  codesign --force --timestamp=none --sign "$JARVIS_SIGN_IDENTITY" "$OUT/$APP_NAME"
else
  codesign --force --sign - "$OUT/$APP_NAME"
fi
codesign --verify "$OUT/$APP_NAME"

if [ "${1:-}" = "--no-install" ]; then echo "postavené: $(cd "$OUT" && pwd)/$APP_NAME"; exit 0; fi
exec /bin/sh ./install.sh "$OUT/$APP_NAME" "${1:-}"
