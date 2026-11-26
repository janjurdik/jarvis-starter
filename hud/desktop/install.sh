#!/bin/sh
# Installs a built Jarvis.app into ~/Applications and clears away what older versions left there,
# so that the Mac has one Jarvis app and not two:
#   Jarvis HUD.app  the desktop app of 1.9.7 and older (bundle id com.jarvis-starter.hud), with its
#                   own start at login (LaunchAgent com.jarvis-starter.hud-desktop)
#   Jarvis.app      the icon of 1.9.7 and older that opened a Chrome window (com.jarvis-starter.window)
# Old apps go to the Trash, nothing is deleted. An app that did not come from this project (any other
# bundle id) stays exactly where it is.
#   sh hud/desktop/install.sh <built Jarvis.app> [--open | --force]
# build.sh runs it. JARVIS_APP_DIR installs into another folder; the system itself is then left alone
# (no launchctl, no LaunchServices). The tests use that together with JARVIS_TRASH_DIR and JARVIS_AGENTS_DIR.
set -eu

SRC="${1:?cesta k postavenej appke Jarvis.app}"
OPT="${2:-}"
APPS="${JARVIS_APP_DIR:-$HOME/Applications}"
TRASH="${JARVIS_TRASH_DIR:-$HOME/.Trash}"
AGENTS="${JARVIS_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
SYSTEM=1
if [ -n "${JARVIS_APP_DIR:-}" ]; then SYSTEM=0; fi
DEST="$APPS/Jarvis.app"
OLD="$APPS/Jarvis HUD.app"
OLD_LABEL=com.jarvis-starter.hud-desktop
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
STAMP="$(date +%Y-%m-%d-%H%M%S)"

if [ ! -d "$SRC/Contents/MacOS" ]; then echo "Postavená appka chýba: $SRC"; exit 1; fi

bundle_id() { /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null || true; }

# Processes whose program lies inside the given bundle. Only those: another app with the same
# executable name (somebody's own build of Jarvis) is never touched.
pids_in() {
  /bin/ps -axo pid=,command= | /usr/bin/awk -v p="$1/Contents/MacOS/" '{ pid = $1; cmd = $0; sub(/^ *[0-9]+ +/, "", cmd); if (index(cmd, p) == 1) print pid }'
}

stop_in() {
  pids="$(pids_in "$1")"
  [ -n "$pids" ] || return 0
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
  sleep 1
}

to_trash() {
  mkdir -p "$TRASH"
  target="$TRASH/$(basename "$1" .app) $STAMP.app"
  mv "$1" "$target"
  if [ $SYSTEM = 1 ]; then "$LSREGISTER" -u "$target" >/dev/null 2>&1 || true; fi
  echo "do koša: $1"
}

was_running=0
if [ -n "$(pids_in "$DEST")" ] || [ -n "$(pids_in "$OLD")" ]; then was_running=1; fi

# The desktop app of 1.9.7 and older. The new app takes its settings over (desktop icons, start at login).
if [ -d "$OLD" ] && [ "$(bundle_id "$OLD")" = com.jarvis-starter.hud ]; then
  agent="$AGENTS/$OLD_LABEL.plist"
  if [ -f "$agent" ]; then
    prog="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$agent" 2>/dev/null || true)"
    case "$prog" in
      "$OLD"/*)
        # launchd would start the old app again after it is stopped (KeepAlive), and at the next login from the Trash.
        if [ $SYSTEM = 1 ]; then /bin/launchctl bootout "gui/$(id -u)/$OLD_LABEL" 2>/dev/null || true; fi
        mkdir -p "$TRASH"
        mv "$agent" "$TRASH/$OLD_LABEL $STAMP.plist"
        echo "do koša: $agent"
        ;;
    esac
  fi
  stop_in "$OLD"
  to_trash "$OLD"
fi

if [ -d "$DEST" ]; then
  existing="$(bundle_id "$DEST")"
  case "$existing" in
    com.jarvis-starter.app) ;;
    com.jarvis-starter.window) to_trash "$DEST" ;;
    *)
      if [ "$OPT" != "--force" ]; then
        echo "V $DEST už je iná appka s rovnakým názvom ($existing). Nič neprepisujem."
        echo "Postavená appka je tu: $SRC"
        exit 1
      fi
      to_trash "$DEST"
      ;;
  esac
fi

stop_in "$DEST"
mkdir -p "$APPS"
# Our own previous build (a build product, no user data: the settings live in the system, the rest in data/).
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
# Finder, Launchpad and Spotlight learn about the app and its icon right away.
if [ $SYSTEM = 1 ]; then "$LSREGISTER" -f "$DEST" >/dev/null 2>&1 || true; fi
echo "nainštalované: $DEST"
if [ "$OPT" = "--open" ] || [ $was_running = 1 ]; then /usr/bin/open "$DEST"; fi
