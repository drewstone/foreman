#!/usr/bin/env bash
# Foreman — Autonomous Operating System
# Install: curl -fsSL https://raw.githubusercontent.com/drewstone/foreman/main/install.sh | bash
#
# What this does:
#   1. Clones the Foreman repo to ~/.foreman/repo/
#   2. Installs dependencies (npm install)
#   3. Creates ~/.foreman/ directory structure
#   4. Installs systemd user services (foreman + telegram gateway)
#   5. Prompts for API keys
#   6. Starts the service
#
# What this does NOT do:
#   - Modify your ~/.claude/ skills or config
#   - Install anything globally
#   - Modify your dotfiles
#   - Touch any existing repos
#
# Everything lives in ~/.foreman/. Uninstall: rm -rf ~/.foreman && systemctl --user disable foreman

set -euo pipefail

FOREMAN_HOME="${FOREMAN_HOME:-$HOME/.foreman}"
REPO_DIR="$FOREMAN_HOME/repo"
SERVICE_PORT="${FOREMAN_PORT:-7374}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log() { echo -e "${GREEN}[foreman]${NC} $1"; }
warn() { echo -e "${YELLOW}[foreman]${NC} $1"; }
err() { echo -e "${RED}[foreman]${NC} $1" >&2; }

# ─── Preflight ────────────────────────────────────────────────────────

log "Checking requirements..."

for cmd in node npm git tmux; do
  if ! command -v "$cmd" &>/dev/null; then
    err "$cmd is required but not installed."
    exit 1
  fi
done

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 22 ]; then
  err "Node.js 22+ required (found $(node -v))"
  exit 1
fi

command -v claude &>/dev/null || warn "Claude Code CLI not found — dispatches won't work without it"
command -v gh &>/dev/null || warn "GitHub CLI (gh) not found — PRs won't be auto-created"

# ─── Clone / update ──────────────────────────────────────────────────

mkdir -p "$FOREMAN_HOME"

if [ -d "$REPO_DIR/.git" ]; then
  log "Updating..."
  cd "$REPO_DIR" && git pull --rebase 2>/dev/null || true
else
  log "Cloning..."
  git clone https://github.com/drewstone/foreman.git "$REPO_DIR"
  cd "$REPO_DIR"
fi

# ─── Dependencies ────────────────────────────────────────────────────

log "Installing dependencies..."
npm install --production 2>/dev/null

# ─── Directories ─────────────────────────────────────────────────────

for d in logs worktrees session-homes mcp skill-proposals; do
  mkdir -p "$FOREMAN_HOME/$d"
done

# ─── Config ──────────────────────────────────────────────────────────

echo ""
log "Configuration"
echo ""

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ ! -f "$HOME/.claude/credentials.json" ]; then
  echo -n "  Anthropic API key (Enter to skip): "
  read -r API_KEY
  [ -n "$API_KEY" ] && echo "ANTHROPIC_API_KEY=$API_KEY" >> "$FOREMAN_HOME/.env"
else
  log "Claude credentials found"
fi

echo -n "  Telegram bot token (Enter to skip): "
read -r TG_TOKEN
TG_USER=""
if [ -n "$TG_TOKEN" ]; then
  echo -n "  Your Telegram username: "
  read -r TG_USER
fi

# ─── Systemd ─────────────────────────────────────────────────────────

log "Installing services..."

SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"
NODE_BIN=$(which node)
TSX="$REPO_DIR/node_modules/.bin/tsx"
PATH_VAR="$(dirname "$NODE_BIN"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

cat > "$SYSTEMD_DIR/foreman.service" << EOF
[Unit]
Description=Foreman — autonomous portfolio operator
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

[Install]
WantedBy=default.target
EOF

if [ -n "$TG_TOKEN" ]; then
  cat > "$SYSTEMD_DIR/foreman-telegram.service" << EOF
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
Environment=TELEGRAM_BOT_TOKEN=$TG_TOKEN
Environment=TELEGRAM_ALLOWED_USERS=$TG_USER
Environment=FOREMAN_URL=http://127.0.0.1:$SERVICE_PORT
Environment=PATH=$PATH_VAR

[Install]
WantedBy=default.target
EOF
fi

systemctl --user daemon-reload
systemctl --user enable --now foreman.service
[ -n "$TG_TOKEN" ] && systemctl --user enable --now foreman-telegram.service

sleep 3

# ─── Pi extension ────────────────────────────────────────────────────

if [ -d "$HOME/.pi/agent" ]; then
  log "Installing Pi extension..."
  mkdir -p "$HOME/.pi/agent/extensions" "$HOME/.pi/agent/skills"
  ln -sf "$REPO_DIR/pi-package/extensions/pi-foreman" "$HOME/.pi/agent/extensions/pi-foreman"
  ln -sf "$REPO_DIR/pi-package/skills/foreman" "$HOME/.pi/agent/skills/foreman"
fi

# ─── CLI ──────────────────────────────────────────────────────────────

log "Installing CLI..."
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO_DIR/bin/foreman" "$HOME/.local/bin/foreman"

# ─── Done ─────────────────────────────────────────────────────────────

HEALTH=$(curl -s "http://127.0.0.1:$SERVICE_PORT/api/health" 2>/dev/null || echo "")

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [ -n "$HEALTH" ]; then
  echo -e "${GREEN}  ✅ Foreman is running${NC}"
else
  echo -e "${YELLOW}  ⏳ Foreman is starting (check: systemctl --user status foreman)${NC}"
fi
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Service    http://127.0.0.1:$SERVICE_PORT"
echo "  Home       $FOREMAN_HOME"
echo "  Logs       journalctl --user -u foreman -f"
[ -n "$TG_TOKEN" ] && echo "  Telegram   message your bot to get started"
[ -d "$HOME/.pi/agent" ] && echo "  Pi         type /foreman <your goal>"
echo ""
echo "  Usage:"
echo "    foreman status    → curl http://127.0.0.1:$SERVICE_PORT/api/status"
echo "    foreman restart   → systemctl --user restart foreman"
echo "    foreman update    → cd $REPO_DIR && git pull && systemctl --user restart foreman"
echo "    foreman uninstall → systemctl --user disable --now foreman && rm -rf $FOREMAN_HOME"
echo ""
