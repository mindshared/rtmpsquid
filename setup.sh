#!/usr/bin/env bash
# RTMP Squid — one-command setup for Linux/macOS.
# Idempotent: safe to run again any time. On Linux with systemd this installs a
# managed service by default (auto-start on boot, single instance, clean restart).
# Pass --no-service to skip the service and just configure for manual `npm start`.
# Network: an interactive run asks how to expose the dashboard — loopback-only
# (SSH tunnel), public plain-HTTP (0.0.0.0), or public HTTPS with a self-signed
# certificate the app serves directly (traffic is encrypted; browsers show a
# one-time "proceed" warning). Pick non-interactively with --local / --public /
# --https. For a trusted cert, put your own TLS proxy in front — that's on you.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
die()  { echo -e "${RED}✗ $*${NC}" >&2; exit 1; }
step() { echo -e "\n${BLUE}▶ $*${NC}"; }
# Best-effort public IP (for the dashboard URL and public ALLOWED_ORIGINS).
detect_ip() { curl -fsS --max-time 3 ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_SERVER"; }

# Default ON for Linux+systemd, OFF elsewhere. --no-service overrides; --service
# is kept for backward compatibility (and explicit opt-in on edge cases).
# BIND_MODE: ask (prompt if interactive, else local) | local | public.
WANT_SERVICE=auto
BIND_MODE=ask
for arg in "$@"; do
  case "$arg" in
    --service)                       WANT_SERVICE=1 ;;
    --no-service)                    WANT_SERVICE=0 ;;
    --public)                        BIND_MODE=public ;;
    --local|--localhost|--loopback)  BIND_MODE=local ;;
    --https|--tls)                   BIND_MODE=https ;;
  esac
done

echo "🦑 RTMP Squid setup"
echo "==================="

# --- OS detection ---------------------------------------------------------
OS="linux"; DISTRO="unknown"
case "$OSTYPE" in
  darwin*) OS="macos" ;;
  linux*)  OS="linux"
           if [ -f /etc/debian_version ]; then DISTRO="debian"
           elif [ -f /etc/redhat-release ]; then DISTRO="redhat"
           elif [ -f /etc/arch-release ]; then DISTRO="arch"; fi ;;
esac

# sudo only if not already root
SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"

pkg_install() {
  case "$DISTRO:$OS" in
    debian:*) $SUDO apt-get update -y && $SUDO apt-get install -y "$@" ;;
    redhat:*) $SUDO dnf install -y "$@" ;;
    arch:*)   $SUDO pacman -S --noconfirm "$@" ;;
    *:macos)  command -v brew >/dev/null 2>&1 || die "Homebrew not found — install from https://brew.sh"; brew install "$@" ;;
    *) die "Unsupported distro — install '$*' manually." ;;
  esac
}

# Generate a self-signed cert+key into certs/ (idempotent). Sets CERT and KEY.
# Encrypts traffic so the AUTH_TOKEN isn't sent in the clear; browsers still show
# a one-time "self-signed" warning you click through.
gen_self_signed_cert() {
  local dir="$ROOT/certs" ip="$1"
  CERT="$dir/cert.pem"; KEY="$dir/key.pem"
  if [ -f "$CERT" ] && [ -f "$KEY" ]; then ok "Self-signed cert already present (certs/)"; return 0; fi
  command -v openssl >/dev/null 2>&1 || pkg_install openssl
  mkdir -p "$dir"
  # Prefer a cert with the server IP + localhost as SANs; fall back for old openssl.
  if ! openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout "$KEY" -out "$CERT" -subj "/CN=rtmpsquid" \
        -addext "subjectAltName=IP:$ip,DNS:localhost" >/dev/null 2>&1; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
      -keyout "$KEY" -out "$CERT" -subj "/CN=$ip" >/dev/null 2>&1 \
      || die "openssl failed to generate a self-signed certificate."
  fi
  chmod 600 "$KEY"
  ok "Generated self-signed cert (certs/cert.pem, 10y)"
}

# --- Node.js >= 18 --------------------------------------------------------
step "Checking Node.js (>= 18)"
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -ge 18 ]; then ok "Node $(node -v)"; need_node=0
  else warn "Node $(node -v) is too old (need >= 18)"; fi
else warn "Node.js not found"; fi
if [ "$need_node" -eq 1 ]; then
  if [ "$OS" = "macos" ]; then pkg_install node
  elif [ "$DISTRO" = "debian" ]; then curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - && $SUDO apt-get install -y nodejs
  elif [ "$DISTRO" = "redhat" ]; then curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash - && $SUDO dnf install -y nodejs
  elif [ "$DISTRO" = "arch" ]; then pkg_install nodejs npm
  else die "Install Node.js >= 18 from https://nodejs.org/ and re-run."; fi
  ok "Node $(node -v) installed"
fi

# --- FFmpeg (must support H.264 output) -----------------------------------
# NB: capture output into vars and pattern-match — piping into `grep -q` would
# SIGPIPE ffmpeg and trip `set -o pipefail` with a false negative.
step "Checking FFmpeg (needs libx264)"
if ! command -v ffmpeg >/dev/null 2>&1; then warn "FFmpeg not found"; pkg_install ffmpeg; fi
command -v ffmpeg >/dev/null 2>&1 || die "FFmpeg still not available."
ENC="$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"
DEC="$(ffmpeg -hide_banner -decoders 2>/dev/null || true)"
VER="$(ffmpeg -version 2>/dev/null | sed -n '1s/.*version \([^ ]*\).*/\1/p' || true)"
case "$ENC" in *libx264*) ok "FFmpeg ${VER:-?} with libx264" ;;
  *) die "Your FFmpeg lacks libx264 (required to stream H.264). Install a full build." ;; esac
case "$DEC" in *av1*|*AV1*) ok "AV1 decoding available" ;;
  *) warn "No AV1 decoder — AV1 source files won't play (H.264/others still fine)" ;; esac
FILT="$(ffmpeg -hide_banner -filters 2>/dev/null || true)"
case "$FILT" in *" subtitles "*) ok "Subtitle burn-in available (libass)" ;;
  *) warn "No libass 'subtitles' filter — per-title subtitles won't burn in (everything else works). Install a full FFmpeg build for subtitle support." ;; esac

# --- dependencies + build -------------------------------------------------
step "Installing dependencies"
npm install --no-audit --no-fund
( cd client && npm install --no-audit --no-fund )
ok "Dependencies installed"

step "Building the web client"
npm run build >/dev/null
[ -f client/dist/index.html ] || die "Client build did not produce client/dist/index.html"
ok "Client built"

# --- .env (persistent config) --------------------------------------------
step "Configuration (.env)"
if [ -f .env ]; then
  ok ".env already exists — leaving it untouched"
else
  TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
  MEDIA_ROOT_DEFAULT="${MEDIA_ROOT:-$ROOT/media}"
  PORT_VAL="${PORT:-3001}"

  # Resolve how the dashboard binds. Prompt only when interactive and not preset
  # via --local/--public/--https; non-interactive runs default to safe loopback.
  if [ "$BIND_MODE" = "ask" ]; then
    if [ -t 0 ]; then
      echo
      echo "How should the dashboard be reachable?"
      echo "  1) Loopback only (127.0.0.1) — reach it over an SSH tunnel        [default, most secure]"
      echo "  2) Public, plain HTTP on this server's IP (0.0.0.0)"
      echo "  3) Public, self-signed HTTPS on this server's IP (encrypted; browser warning)"
      printf "Choose [1/2/3] (default 1): "
      read -r ans </dev/tty 2>/dev/null || ans=""
      case "$ans" in 2) BIND_MODE=public ;; 3) BIND_MODE=https ;; *) BIND_MODE=local ;; esac
    else
      BIND_MODE=local
    fi
  fi

  TLS_CERT_LINE=""; TLS_KEY_LINE=""
  case "$BIND_MODE" in
    public)
      HOST_VAL=0.0.0.0; PUB_IP="$(detect_ip)"
      ORIGINS_LINE="ALLOWED_ORIGINS=http://$PUB_IP:$PORT_VAL,http://localhost:$PORT_VAL,http://127.0.0.1:$PORT_VAL" ;;
    https)
      HOST_VAL=0.0.0.0; PUB_IP="$(detect_ip)"
      gen_self_signed_cert "$PUB_IP"
      ORIGINS_LINE="ALLOWED_ORIGINS=https://$PUB_IP:$PORT_VAL,https://localhost:$PORT_VAL"
      TLS_CERT_LINE="TLS_CERT=$CERT"; TLS_KEY_LINE="TLS_KEY=$KEY" ;;
    *)
      HOST_VAL=127.0.0.1; ORIGINS_LINE="" ;;  # omit ALLOWED_ORIGINS -> loopback default
  esac

  {
    echo "# RTMP Squid configuration (generated by setup.sh — edit freely, then restart)"
    echo "AUTH_TOKEN=$TOKEN"
    echo "HOST=$HOST_VAL"
    echo "PORT=$PORT_VAL"
    if [ -n "$ORIGINS_LINE" ]; then echo "$ORIGINS_LINE"; fi
    if [ -n "$TLS_CERT_LINE" ]; then echo "$TLS_CERT_LINE"; fi
    if [ -n "$TLS_KEY_LINE" ]; then echo "$TLS_KEY_LINE"; fi
    echo "MEDIA_ROOT=$MEDIA_ROOT_DEFAULT"
    echo "LIBRARY_DIR=$MEDIA_ROOT_DEFAULT"
    echo "MIN_MOVIE_MB=5"
  } > .env
  chmod 600 .env
  ok "Wrote .env with a fresh AUTH_TOKEN (bind $HOST_VAL)"
  if [ "$BIND_MODE" = "public" ]; then
    warn "Public bind — http://$PUB_IP:$PORT_VAL (open the firewall for $PORT_VAL)."
    warn "Plain HTTP: the AUTH_TOKEN travels unencrypted. Use a trusted network/VPN,"
    warn "or re-run with --https for an encrypted self-signed connection."
  elif [ "$BIND_MODE" = "https" ]; then
    warn "Self-signed HTTPS — https://$PUB_IP:$PORT_VAL (open the firewall for $PORT_VAL)."
    warn "Your browser will show a one-time 'not private / self-signed' warning — click"
    warn "through it; the connection is still encrypted. Put a real TLS proxy in front"
    warn "if you want a trusted certificate."
  fi
fi
# shellcheck disable=SC1091
set -a; . ./.env; set +a
mkdir -p "$MEDIA_ROOT"; ok "Media root ready: $MEDIA_ROOT"

# --- service install / single-instance enforcement -----------------------
# Resolve auto: Linux with systemd => install, otherwise skip.
if [ "$WANT_SERVICE" = "auto" ]; then
  if [ "$OS" = "linux" ] && command -v systemctl >/dev/null 2>&1; then WANT_SERVICE=1
  else WANT_SERVICE=0; fi
fi

if [ "$WANT_SERVICE" -eq 1 ]; then
  step "Installing systemd service (single instance, auto-start, auto-restart)"
  [ "$OS" = "linux" ] || die "--service is Linux-only."
  command -v systemctl >/dev/null 2>&1 || die "systemd not available."
  NODE_BIN="$(command -v node)"
  UNIT=/etc/systemd/system/rtmpsquid.service

  # Kill any stray node started by hand (npm start, nohup, etc) so the service
  # has exclusive ownership of :$PORT. systemd's own instance (in the unit's
  # cgroup) is left alone. Pattern matches both absolute paths and bare argv.
  STRAYS=""
  for pid in $(pgrep -f 'node .*server/index.js' 2>/dev/null || true); do
    # Skip the systemd-managed instance.
    if grep -q 'rtmpsquid.service' "/proc/$pid/cgroup" 2>/dev/null; then continue; fi
    # Only kill if cwd or argv actually points at THIS repo (avoid killing other
    # node apps that happen to match the loose pattern).
    cwd="$(readlink -f /proc/$pid/cwd 2>/dev/null || true)"
    if [ "$cwd" = "$ROOT" ] || grep -q "$ROOT/server/index.js" "/proc/$pid/cmdline" 2>/dev/null; then
      STRAYS="$STRAYS $pid"
    fi
  done
  if [ -n "$STRAYS" ]; then
    for pid in $STRAYS; do kill -TERM "$pid" 2>/dev/null || true; done
    sleep 1
    for pid in $STRAYS; do kill -KILL "$pid" 2>/dev/null || true; done
    ok "Cleared stray manual node processes:$STRAYS"
  fi

  $SUDO tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=RTMP Squid
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
EnvironmentFile=$ROOT/.env
ExecStart=$NODE_BIN $ROOT/server/index.js
# Graceful stop: SIGTERM gives the server time to drain ffmpeg cleanly (matches
# the in-app feeder shutdown path), then SIGKILL as a backstop.
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=10
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable rtmpsquid >/dev/null 2>&1 || true
  # Restart (not just start) so re-running setup picks up code/unit changes
  # and replaces any running instance — single source of truth.
  $SUDO systemctl restart rtmpsquid
  ok "Service 'rtmpsquid' active (systemctl status rtmpsquid)"
fi

# --- done -----------------------------------------------------------------
TOKEN_NOW="$(grep -E '^AUTH_TOKEN=' .env | cut -d= -f2-)"
IP="$(detect_ip)"
echo -e "\n${GREEN}✓ Setup complete${NC}"
echo "─────────────────────────────────────────────"
if [ "$WANT_SERVICE" -eq 1 ]; then
  echo "Running as a service. Manage with: systemctl {status,restart,stop} rtmpsquid"
  echo "Logs:            journalctl -u rtmpsquid -f"
else
  echo "Start it with:   npm start"
fi
echo "Access token:    $TOKEN_NOW"
if grep -q '^TLS_CERT=' .env 2>/dev/null; then
  echo "Open the UI:     https://${IP}:${PORT}   (self-signed — accept the browser warning; open the firewall for ${PORT})"
elif [ "${HOST:-127.0.0.1}" = "0.0.0.0" ] || [ "${HOST:-}" = "::" ]; then
  echo "Open the UI:     http://${IP}:${PORT}   (public bind — open the firewall for ${PORT}; plain HTTP, prefer a TLS proxy)"
else
  echo "Open the UI:     ssh -L ${PORT}:127.0.0.1:${PORT} $(whoami)@${IP}   then http://localhost:${PORT}"
fi
echo "Put movies in:   $MEDIA_ROOT   (or set LIBRARY_DIR in .env)"
echo "─────────────────────────────────────────────"
