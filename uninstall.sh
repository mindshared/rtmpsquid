#!/usr/bin/env bash
# RTMP Squid — generic clean uninstall for Linux/macOS. Reverses setup.sh.
# Works no matter where it was installed: it discovers the real install dir,
# .env, and media path from the installed systemd service, and otherwise falls
# back to the directory this script is run from. Idempotent — safe to re-run.
#
#   ./uninstall.sh            stop the app + remove the systemd service (keeps files + media)
#   ./uninstall.sh --purge    also delete generated files: node_modules, client build, .env
#   ./uninstall.sh --media    also delete the media library at MEDIA_ROOT
#   ./uninstall.sh --purge --media --yes
set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
die()  { echo -e "${RED}✗ $*${NC}" >&2; exit 1; }
step() { echo -e "\n${BLUE}▶ $*${NC}"; }

usage() {
  cat <<EOF
RTMP Squid uninstall
  ./uninstall.sh [--purge] [--media] [--yes]

  (no flags)   Stop the app and remove the systemd service. Leaves files + media intact.
  --purge      Also delete generated files: node_modules, client build, and .env (asks first).
  --media      Also delete the media library at MEDIA_ROOT (asks first).
  -y, --yes    Don't prompt for confirmation on destructive steps.
EOF
}

PURGE=0; MEDIA=0; ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --purge)   PURGE=1 ;;
    --media)   MEDIA=1 ;;
    -y|--yes)  ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $arg (try --help)" ;;
  esac
done

confirm() { # confirm "question"  -> returns 0 on yes
  [ "$ASSUME_YES" -eq 1 ] && return 0
  printf "%b" "${YELLOW}? $1 [y/N] ${NC}"
  read -r reply </dev/tty 2>/dev/null || reply=""
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

echo "🦑 RTMP Squid uninstall"
echo "======================="

OS="linux"; case "$OSTYPE" in darwin*) OS="macos" ;; esac
SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"

SERVICE=rtmpsquid
UNIT=/etc/systemd/system/${SERVICE}.service
unit_field() { [ -f "$UNIT" ] && awk -F= -v k="$1" '$1==k{v=$2} END{if(v)print v}' "$UNIT" || true; }

# --- Discover the install location (generic, not hardcoded) ---------------
# Priority: the dir THIS script sits in (normal case: shipped in the repo) →
# the service's WorkingDirectory (script run standalone) → current directory.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/server/index.js" ]; then APP_DIR="$SCRIPT_DIR"
elif [ -n "$(unit_field WorkingDirectory)" ]; then APP_DIR="$(unit_field WorkingDirectory)"
else APP_DIR="$PWD"; fi

# Find the .env (service's EnvironmentFile if set, else inside the install dir)
ENVFILE="$(unit_field EnvironmentFile)"; [ -n "$ENVFILE" ] || ENVFILE="$APP_DIR/.env"

# Resolve MEDIA_ROOT now, before --purge can delete the .env we read it from.
MEDIA_ROOT="${MEDIA_ROOT:-}"
if [ -z "$MEDIA_ROOT" ] && [ -f "$ENVFILE" ]; then
  MEDIA_ROOT="$(grep -E '^MEDIA_ROOT=' "$ENVFILE" | tail -n1 | cut -d= -f2- || true)"
fi
[ -z "$MEDIA_ROOT" ] && MEDIA_ROOT="$APP_DIR/media"

SVC_USER="$(unit_field User)"; [ -n "$SVC_USER" ] || SVC_USER="root"
step "Detected install"
echo "  app dir:    $APP_DIR"
echo "  .env:       $ENVFILE"
echo "  media root: $MEDIA_ROOT"
[ "$OS" = "linux" ] && echo "  run-as:     $SVC_USER"

# --- 1. systemd service ---------------------------------------------------
if [ "$OS" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
  if [ -f "$UNIT" ] || systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE}\.service"; then
    step "Removing systemd service '${SERVICE}'"
    $SUDO systemctl stop "$SERVICE"    2>/dev/null || true
    $SUDO systemctl disable "$SERVICE" 2>/dev/null || true
    $SUDO rm -f "$UNIT"
    $SUDO systemctl daemon-reload
    $SUDO systemctl reset-failed "$SERVICE" 2>/dev/null || true
    ok "Service stopped, disabled, and unit removed"
  else
    warn "No '${SERVICE}' systemd service found — nothing to remove"
  fi
fi

# --- 2. stray hand-started processes (npm start / nohup / etc) -------------
step "Stopping any running server process for this install"
STRAYS=""
for pid in $(pgrep -f 'node .*server/index.js' 2>/dev/null || true); do
  if [ -d "/proc/$pid" ]; then
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    if [ "$cwd" = "$APP_DIR" ] || grep -q "$APP_DIR/server/index.js" "/proc/$pid/cmdline" 2>/dev/null; then
      STRAYS="$STRAYS $pid"
    fi
  elif ps -p "$pid" -o command= 2>/dev/null | grep -q "$APP_DIR/server/index.js"; then
    STRAYS="$STRAYS $pid"   # macOS fallback (no /proc)
  fi
done
if [ -n "$STRAYS" ]; then
  for pid in $STRAYS; do $SUDO kill -TERM "$pid" 2>/dev/null || true; done
  sleep 1
  for pid in $STRAYS; do $SUDO kill -KILL "$pid" 2>/dev/null || true; done
  ok "Stopped:$STRAYS"
else
  ok "No stray processes running"
fi

# --- 3. generated files (--purge) -----------------------------------------
if [ "$PURGE" -eq 1 ]; then
  step "Purging generated files in $APP_DIR"
  $SUDO rm -rf "$APP_DIR/node_modules" "$APP_DIR/client/node_modules" "$APP_DIR/client/dist"
  ok "Removed node_modules + client build"
  if [ -f "$ENVFILE" ]; then
    if confirm "$ENVFILE holds your AUTH_TOKEN — delete it too?"; then
      $SUDO rm -f "$ENVFILE"; ok "Removed $ENVFILE"
    else
      warn "Kept $ENVFILE"
    fi
  fi
fi

# --- 4. media library (--media, guarded) ----------------------------------
if [ "$MEDIA" -eq 1 ]; then
  step "Removing media library"
  case "$MEDIA_ROOT" in
    ""|"/"|"$HOME"|"/root"|"/home"|"/usr"|"/etc"|"/var"|"/opt")
      die "Refusing to delete unsafe MEDIA_ROOT: '$MEDIA_ROOT'" ;;
  esac
  [ "${MEDIA_ROOT#/}" = "$MEDIA_ROOT" ] && die "MEDIA_ROOT is not an absolute path: '$MEDIA_ROOT'"
  if [ -d "$MEDIA_ROOT" ]; then
    warn "This permanently deletes EVERYTHING under: $MEDIA_ROOT"
    if confirm "Delete the media library?"; then
      $SUDO rm -rf "$MEDIA_ROOT"; ok "Removed $MEDIA_ROOT"
    else
      warn "Kept $MEDIA_ROOT"
    fi
  else
    warn "Media dir not found: $MEDIA_ROOT"
  fi
fi

# --- done -----------------------------------------------------------------
echo -e "\n${GREEN}✓ Uninstall complete${NC}"
echo "─────────────────────────────────────────────"
echo "Service:  removed (if it had been installed)"
if [ "$PURGE" -eq 1 ]; then echo "Files:    node_modules + client build removed"
else echo "Files:    left in $APP_DIR — run ./setup.sh to reinstall, or rm -rf it"; fi
if [ "$MEDIA" -eq 1 ]; then echo "Media:    removed"
else echo "Media:    untouched ($MEDIA_ROOT)"; fi
echo "─────────────────────────────────────────────"
