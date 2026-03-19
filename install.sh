#!/usr/bin/env bash
# Install Foreman — autonomous engineering operator
# Usage: curl -fsSL https://raw.githubusercontent.com/drewstone/foreman/main/install.sh | bash
set -euo pipefail

FOREMAN_DIR="${FOREMAN_DIR:-$HOME/.foreman/src}"
FOREMAN_HOME="${FOREMAN_HOME:-$HOME/.foreman}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

echo "Installing Foreman..."

# Clone or update
if [ -d "$FOREMAN_DIR" ]; then
  echo "  Updating $FOREMAN_DIR"
  git -C "$FOREMAN_DIR" pull --ff-only 2>/dev/null || true
else
  echo "  Cloning to $FOREMAN_DIR"
  mkdir -p "$(dirname "$FOREMAN_DIR")"
  git clone --depth 1 https://github.com/drewstone/foreman.git "$FOREMAN_DIR"
fi

# Install dependencies
echo "  Installing dependencies..."
cd "$FOREMAN_DIR"
npm install --silent 2>/dev/null

# Create bin wrapper
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/foreman" << 'WRAPPER'
#!/usr/bin/env bash
FOREMAN_DIR="${FOREMAN_DIR:-$HOME/.foreman/src}"
cd "$FOREMAN_DIR"
exec node --import tsx packages/surfaces/src/init-cli.ts "$@"
WRAPPER
chmod +x "$BIN_DIR/foreman"

# Init if first install
if [ ! -f "$FOREMAN_HOME/config.json" ]; then
  echo "  Running foreman init..."
  "$BIN_DIR/foreman" init
fi

echo ""
echo "Foreman installed."
echo ""
echo "  foreman status      — show session portfolio"
echo "  foreman heartbeat   — scan repos + check CI"
echo "  foreman init        — reconfigure"
echo ""
echo "Make sure $BIN_DIR is in your PATH."
