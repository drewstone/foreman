#!/usr/bin/env bash
# Foreman installer and onboarding wizard
# Install: curl -fsSL https://raw.githubusercontent.com/drewstone/foreman/main/install.sh | bash

set -euo pipefail

FOREMAN_HOME="${FOREMAN_HOME:-$HOME/.foreman}"
REPO_DIR="$FOREMAN_HOME/repo"
ENV_FILE="$FOREMAN_HOME/.env"
SERVICE_PORT="${FOREMAN_PORT:-7374}"

AUTO_YES=0
CONFIG_ONLY=0

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log() { echo -e "${GREEN}[foreman]${NC} $1"; }
warn() { echo -e "${YELLOW}[foreman]${NC} $1"; }
err() { echo -e "${RED}[foreman]${NC} $1" >&2; }
info() { echo -e "${BLUE}[foreman]${NC} $1"; }

usage() {
  cat <<'EOF'
Foreman installer

Usage:
  bash install.sh [--yes] [--configure]

Options:
  --yes, -y       Accept recommended defaults
  --configure     Re-run onboarding and service wiring without cloning/updating
  --help, -h      Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)
      AUTO_YES=1
      ;;
    --configure|--reconfigure)
      CONFIG_ONLY=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      err "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
  shift
done

prompt_yes_no() {
  local prompt="$1"
  local default="${2:-Y}"
  local reply=""
  local suffix="[y/N]"
  [ "$default" = "Y" ] && suffix="[Y/n]"

  if [ "$AUTO_YES" -eq 1 ]; then
    [ "$default" = "Y" ]
    return
  fi

  while true; do
    printf "%s %s " "$prompt" "$suffix"
    read -r reply
    reply="${reply:-$default}"
    case "$reply" in
      Y|y|yes|YES) return 0 ;;
      N|n|no|NO) return 1 ;;
      *) warn "Please answer yes or no." ;;
    esac
  done
}

prompt_value() {
  local prompt="$1"
  local default="${2:-}"
  local reply=""

  if [ "$AUTO_YES" -eq 1 ]; then
    printf '%s' "$default"
    return
  fi

  if [ -n "$default" ]; then
    printf "%s [%s] " "$prompt" "$default"
  else
    printf "%s " "$prompt"
  fi
  read -r reply
  printf '%s' "${reply:-$default}"
}

prompt_secret() {
  local prompt="$1"
  local reply=""

  if [ "$AUTO_YES" -eq 1 ]; then
    printf '%s' ""
    return
  fi

  printf "%s " "$prompt"
  stty -echo 2>/dev/null || true
  read -r reply
  stty echo 2>/dev/null || true
  printf '\n' >&2
  printf '%s' "$reply"
}

set_env() {
  local key="$1"
  local value="$2"
  local tmp

  mkdir -p "$FOREMAN_HOME"
  touch "$ENV_FILE"
  tmp="$(mktemp)"
  grep -v "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
}

unset_env() {
  local key="$1"
  local tmp

  [ -f "$ENV_FILE" ] || return 0
  tmp="$(mktemp)"
  grep -v "^${key}=" "$ENV_FILE" > "$tmp" || true
  mv "$tmp" "$ENV_FILE"
}

section() {
  echo ""
  echo -e "${BLUE}$1${NC}"
}

for cmd in node npm git; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "$cmd is required but not installed."
    exit 1
  fi
done

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 22 ]; then
  err "Node.js 22+ required (found $(node -v))"
  exit 1
fi

mkdir -p "$FOREMAN_HOME"
touch "$ENV_FILE"
set -a
. "$ENV_FILE" 2>/dev/null || true
set +a

HAVE_CLAUDE=0
HAVE_TMUX=0
HAVE_GH=0
HAVE_PI=0
HAVE_SYSTEMD=0

command -v claude >/dev/null 2>&1 && HAVE_CLAUDE=1
command -v tmux >/dev/null 2>&1 && HAVE_TMUX=1
command -v gh >/dev/null 2>&1 && HAVE_GH=1
[ -d "$HOME/.pi/agent" ] && HAVE_PI=1
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  HAVE_SYSTEMD=1
fi

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Foreman setup${NC}"
echo "Local control plane for dispatch, telemetry, budgets, and operator workflows."
echo "This wizard asks before enabling each capability and explains why it exists."
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

section "Detected tools"
echo "  Node.js        $(node -v)"
echo "  npm            $(npm -v)"
echo "  git            $(git --version | awk '{print $3}')"
echo "  Claude CLI     $([ "$HAVE_CLAUDE" -eq 1 ] && echo yes || echo no)"
echo "  tmux           $([ "$HAVE_TMUX" -eq 1 ] && echo yes || echo no)"
echo "  gh             $([ "$HAVE_GH" -eq 1 ] && echo yes || echo no)"
echo "  Pi             $([ "$HAVE_PI" -eq 1 ] && echo yes || echo no)"
echo "  systemd user   $([ "$HAVE_SYSTEMD" -eq 1 ] && echo yes || echo no)"

section "Core install"
echo "Foreman stores its state in $FOREMAN_HOME and installs a local CLI in ~/.local/bin."
echo "Required because the service, dashboard, database, logs, and budget state all live there."
if ! prompt_yes_no "Install or update Foreman under $FOREMAN_HOME?" "Y"; then
  warn "Install cancelled."
  exit 0
fi

if [ "$CONFIG_ONLY" -eq 1 ]; then
  if [ ! -d "$REPO_DIR/.git" ]; then
    err "No existing Foreman repo at $REPO_DIR. Run the full installer first."
    exit 1
  fi
  log "Using existing repo at $REPO_DIR"
else
  if [ -d "$REPO_DIR/.git" ]; then
    log "Updating repository..."
    cd "$REPO_DIR"
    git pull --rebase 2>/dev/null || true
  else
    log "Cloning repository..."
    git clone https://github.com/drewstone/foreman.git "$REPO_DIR"
    cd "$REPO_DIR"
  fi
fi

if [ ! -x "$REPO_DIR/node_modules/.bin/tsx" ] || [ "$CONFIG_ONLY" -eq 0 ]; then
  log "Installing dependencies..."
  cd "$REPO_DIR"
  npm install --production >/dev/null
fi

for d in logs worktrees session-homes mcp skill-proposals traces; do
  mkdir -p "$FOREMAN_HOME/$d"
done

section "Core service"
echo "Runs the Foreman API and dashboard on http://127.0.0.1:$SERVICE_PORT."
echo "Needed for status, dispatching, telemetry, budgets, and any chat gateway."
ENABLE_SERVICE=1

section "Telemetry and budgets"
echo "Telemetry tracks every run by harness, provider, model, repo, and cost."
echo "Budget limits are fail-closed: dispatch stops once the daily cap is hit."
DEFAULT_BUDGET="${FOREMAN_MAX_DAILY_COST:-20}"
DAILY_BUDGET="$(prompt_value "Daily spend limit in USD?" "$DEFAULT_BUDGET")"
[ -z "$DAILY_BUDGET" ] && DAILY_BUDGET="$DEFAULT_BUDGET"
set_env "FOREMAN_MAX_DAILY_COST" "$DAILY_BUDGET"

section "Provider wiring"
echo "These are optional credentials for provider-backed features."
echo "Foreman asks separately so you can keep the install minimal."

echo ""
echo "Anthropic API key"
echo "Desirable for direct API features like optimizers and judges."
echo "Not required if you only use local Claude Code auth."
if prompt_yes_no "Configure Anthropic API access?" "$([ -n "${ANTHROPIC_API_KEY:-}" ] && echo Y || echo N)"; then
  ANTHROPIC_KEY="$(prompt_secret "  Anthropic API key (leave empty to keep current):")"
  [ -n "$ANTHROPIC_KEY" ] && set_env "ANTHROPIC_API_KEY" "$ANTHROPIC_KEY"
else
  unset_env "ANTHROPIC_API_KEY"
fi

echo ""
echo "OpenAI API key"
echo "Desirable for OpenAI-backed workflows and future Codex/OpenAI integrations."
if prompt_yes_no "Configure OpenAI API access?" "$([ -n "${OPENAI_API_KEY:-}" ] && echo Y || echo N)"; then
  OPENAI_KEY="$(prompt_secret "  OpenAI API key (leave empty to keep current):")"
  [ -n "$OPENAI_KEY" ] && set_env "OPENAI_API_KEY" "$OPENAI_KEY"
else
  unset_env "OPENAI_API_KEY"
fi

echo ""
echo "Tangle sandbox API key"
echo "Optional. Needed only if you want remote sandbox execution instead of local sessions."
if prompt_yes_no "Configure Tangle sandbox access?" "$([ -n "${TANGLE_API_KEY:-}" ] && echo Y || echo N)"; then
  TANGLE_KEY="$(prompt_secret "  TANGLE_API_KEY (leave empty to keep current):")"
  [ -n "$TANGLE_KEY" ] && set_env "TANGLE_API_KEY" "$TANGLE_KEY"
else
  unset_env "TANGLE_API_KEY"
fi

section "Local agent dispatch"
echo "This is the local coding path: Foreman opens Claude Code work sessions in tmux."
echo "Needed for autonomous local code execution."
if [ "$HAVE_CLAUDE" -eq 1 ] && [ "$HAVE_TMUX" -eq 1 ]; then
  log "Claude CLI and tmux detected."
else
  warn "Claude CLI and tmux are not both available."
  echo "     Foreman can still run as an API and telemetry service, but local dispatch will not work yet."
fi

section "Notifications"
echo "Telegram is optional. It gives you lightweight remote visibility and control."
echo "Only enable it if you want chat-based interaction."
ENABLE_TELEGRAM=0
TG_TOKEN=""
TG_USERS=""
if prompt_yes_no "Enable Telegram gateway?" "$([ -n "${TELEGRAM_BOT_TOKEN:-}" ] && echo Y || echo N)"; then
  ENABLE_TELEGRAM=1
  TG_TOKEN="$(prompt_secret "  Telegram bot token (leave empty to keep current):")"
  [ -z "$TG_TOKEN" ] && TG_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
  TG_USERS="$(prompt_value "  Allowed Telegram usernames (comma-separated)" "${TELEGRAM_ALLOWED_USERS:-}")"
  if [ -z "$TG_TOKEN" ] || [ -z "$TG_USERS" ]; then
    warn "Telegram setup incomplete. Skipping gateway."
    ENABLE_TELEGRAM=0
  fi
fi

if [ "$ENABLE_TELEGRAM" -eq 1 ]; then
  set_env "TELEGRAM_BOT_TOKEN" "$TG_TOKEN"
  set_env "TELEGRAM_ALLOWED_USERS" "$TG_USERS"
  set_env "FOREMAN_URL" "http://127.0.0.1:$SERVICE_PORT"
else
  unset_env "TELEGRAM_BOT_TOKEN"
  unset_env "TELEGRAM_ALLOWED_USERS"
fi

section "Pi integration"
echo "Optional. Creates symlinks so Pi can call Foreman with /foreman."
echo "Safe because it does not touch your dotfiles or install anything globally."
ENABLE_PI=0
if [ "$HAVE_PI" -eq 1 ]; then
  if prompt_yes_no "Install or refresh the Pi extension wiring?" "Y"; then
    ENABLE_PI=1
  fi
else
  echo "Pi agent directory not found. Skipping."
fi

section "Service mode"
if [ "$HAVE_SYSTEMD" -eq 1 ]; then
  echo "Recommended. Installs a user service so Foreman starts on login and stays running."
  ENABLE_SYSTEMD=0
  if prompt_yes_no "Install and start the systemd user service?" "Y"; then
    ENABLE_SYSTEMD=1
  fi
else
  ENABLE_SYSTEMD=0
  warn "systemd user services are not available here."
  echo "     You can still run Foreman manually with: cd $REPO_DIR && npm run service"
fi

SYSTEMD_DIR="$HOME/.config/systemd/user"
NODE_BIN="$(command -v node)"
TSX="$REPO_DIR/node_modules/.bin/tsx"
PATH_VAR="$(dirname "$NODE_BIN"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

if [ "$HAVE_SYSTEMD" -eq 1 ]; then
  log "Writing service units..."
  mkdir -p "$SYSTEMD_DIR"

  cat > "$SYSTEMD_DIR/foreman.service" <<EOF
[Unit]
Description=Foreman service
After=network-online.target

[Service]
ExecStart=$TSX $REPO_DIR/service/index.ts
WorkingDirectory=$REPO_DIR
Restart=always
RestartSec=5
SuccessExitStatus=0 143
Environment=HOME=$HOME
Environment=FOREMAN_HOME=$FOREMAN_HOME
Environment=PATH=$PATH_VAR
EnvironmentFile=-$ENV_FILE

[Install]
WantedBy=default.target
EOF

  cat > "$SYSTEMD_DIR/foreman-telegram.service" <<EOF
[Unit]
Description=Foreman Telegram Gateway
After=foreman.service
Requires=foreman.service

[Service]
ExecStart=$TSX $REPO_DIR/gateway/telegram.ts
WorkingDirectory=$REPO_DIR
Restart=always
RestartSec=10
Environment=HOME=$HOME
Environment=FOREMAN_HOME=$FOREMAN_HOME
Environment=FOREMAN_URL=http://127.0.0.1:$SERVICE_PORT
Environment=PATH=$PATH_VAR
EnvironmentFile=-$ENV_FILE

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload

  if [ "$ENABLE_SYSTEMD" -eq 1 ]; then
    systemctl --user enable --now foreman.service
    if [ "$ENABLE_TELEGRAM" -eq 1 ]; then
      systemctl --user enable --now foreman-telegram.service
    else
      systemctl --user disable --now foreman-telegram.service >/dev/null 2>&1 || true
    fi
  else
    systemctl --user disable --now foreman.service >/dev/null 2>&1 || true
    systemctl --user disable --now foreman-telegram.service >/dev/null 2>&1 || true
  fi
fi

if [ "$ENABLE_PI" -eq 1 ]; then
  log "Installing Pi extension wiring..."
  mkdir -p "$HOME/.pi/agent/extensions" "$HOME/.pi/agent/skills"
  ln -sf "$REPO_DIR/pi-package/extensions/pi-foreman" "$HOME/.pi/agent/extensions/pi-foreman"
  ln -sf "$REPO_DIR/pi-package/skills/foreman" "$HOME/.pi/agent/skills/foreman"
fi

log "Installing CLI..."
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO_DIR/bin/foreman" "$HOME/.local/bin/foreman"

sleep 2
HEALTH="$(curl -s "http://127.0.0.1:$SERVICE_PORT/api/health" 2>/dev/null || true)"

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Foreman setup summary${NC}"
echo "  Home                $FOREMAN_HOME"
echo "  Repo                $REPO_DIR"
echo "  Daily budget        \$$DAILY_BUDGET"
echo "  Systemd service     $([ "$ENABLE_SYSTEMD" -eq 1 ] && echo enabled || echo disabled)"
echo "  Telegram gateway    $([ "$ENABLE_TELEGRAM" -eq 1 ] && echo enabled || echo disabled)"
echo "  Pi integration      $([ "$ENABLE_PI" -eq 1 ] && echo enabled || echo disabled)"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ -n "$HEALTH" ]; then
  echo -e "${GREEN}Foreman is responding at http://127.0.0.1:$SERVICE_PORT${NC}"
else
  if [ "$ENABLE_SYSTEMD" -eq 1 ]; then
    echo -e "${YELLOW}Foreman may still be starting. Check: systemctl --user status foreman.service${NC}"
  else
    echo -e "${YELLOW}Foreman is installed but not running as a background service.${NC}"
    echo "Start it manually with:"
    echo "  cd $REPO_DIR && npm run service"
  fi
fi

echo ""
echo "Commands:"
echo "  foreman status      Show portfolio status"
echo "  foreman setup       Re-run this onboarding flow"
echo "  foreman logs        Follow service logs"
echo "  foreman restart     Restart the service"
echo ""
