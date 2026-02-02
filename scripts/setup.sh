#!/usr/bin/env bash
# bsv-overlay skill — first-run setup
#
# Ensures the @a2a-bsv/core library is accessible and the wallet is initialized.
# Safe to run multiple times (idempotent).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
A2A_BSV_ROOT="${A2A_BSV_ROOT:-/home/dylan/a2a-bsv}"
CORE_PKG="$A2A_BSV_ROOT/packages/core"

echo "🔧 bsv-overlay setup"
echo "   Skill dir:  $SKILL_DIR"
echo "   Core lib:   $CORE_PKG"
echo ""

# 1. Verify the core library exists
if [ ! -f "$CORE_PKG/dist/index.js" ]; then
  echo "❌ @a2a-bsv/core not found at $CORE_PKG/dist/index.js"
  echo "   Build it first: cd $A2A_BSV_ROOT/packages/core && npm run build"
  exit 1
fi

# 2. Create node_modules symlink for @a2a-bsv/core resolution
SKILL_NM="$SKILL_DIR/node_modules/@a2a-bsv"
if [ ! -L "$SKILL_NM/core" ]; then
  mkdir -p "$SKILL_NM"
  ln -sf "$CORE_PKG" "$SKILL_NM/core"
  echo "✅ Symlinked @a2a-bsv/core → $CORE_PKG"
else
  echo "✅ @a2a-bsv/core symlink already exists"
fi

# 3. Symlink @bsv/sdk so the CLI can import it
BSV_SDK="$CORE_PKG/node_modules/@bsv/sdk"
BSV_SDK_LINK="$SKILL_DIR/node_modules/@bsv/sdk"
if [ ! -L "$BSV_SDK_LINK" ] && [ -d "$BSV_SDK" ]; then
  mkdir -p "$SKILL_DIR/node_modules/@bsv"
  ln -sf "$BSV_SDK" "$BSV_SDK_LINK"
  echo "✅ Symlinked @bsv/sdk"
fi

# 4. Symlink knex + better-sqlite3 (needed by wallet-toolbox)
for dep in knex better-sqlite3; do
  DEP_PATH="$CORE_PKG/node_modules/$dep"
  DEP_LINK="$SKILL_DIR/node_modules/$dep"
  if [ ! -L "$DEP_LINK" ] && [ -d "$DEP_PATH" ]; then
    ln -sf "$DEP_PATH" "$DEP_LINK"
    echo "✅ Symlinked $dep"
  fi
done

# 5. Symlink @bsv/wallet-toolbox
WT_PATH="$CORE_PKG/node_modules/@bsv/wallet-toolbox"
WT_LINK="$SKILL_DIR/node_modules/@bsv/wallet-toolbox"
if [ ! -L "$WT_LINK" ] && [ -d "$WT_PATH" ]; then
  mkdir -p "$SKILL_DIR/node_modules/@bsv"
  ln -sf "$WT_PATH" "$WT_LINK"
  echo "✅ Symlinked @bsv/wallet-toolbox"
fi

# 6. Install ws for WebSocket connect command
WS_LINK="$SKILL_DIR/node_modules/ws"
if [ ! -d "$WS_LINK" ] && [ ! -L "$WS_LINK" ]; then
  echo "📦 Installing ws for WebSocket support..."
  cd "$SKILL_DIR" && npm install ws --no-save 2>/dev/null || true
  echo "✅ ws installed"
else
  echo "✅ ws already available"
fi

echo ""

# 6. Initialize the wallet if it doesn't exist
CLI="$SCRIPT_DIR/overlay-cli.mjs"
if [ -f "$CLI" ]; then
  echo "🔑 Initializing wallet..."
  node "$CLI" setup 2>&1 || true
  # Issue #8: Restrict permissions on wallet identity (contains private key)
  WALLET_IDENTITY="${BSV_WALLET_DIR:-$HOME/.clawdbot/bsv-wallet}/wallet-identity.json"
  [ -f "$WALLET_IDENTITY" ] && chmod 600 "$WALLET_IDENTITY" && echo "🔒 Set 0600 on wallet-identity.json"
  echo ""
  echo "📬 Wallet address:"
  node "$CLI" address 2>&1 || true
  echo ""
  echo "✅ Setup complete!"
  echo ""
  echo "Next steps:"
  echo "  1. Fund the wallet address above with a small amount of BSV"
  echo "  2. Import the funding tx:  node $CLI import <txid> [vout]"
  echo "  3. Register on overlay:    node $CLI register"
else
  echo "⚠️  overlay-cli.mjs not found — skipping wallet init"
fi
