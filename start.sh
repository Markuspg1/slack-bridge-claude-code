#!/bin/bash
# Claude Slack Bridge — startup script
# Run: bash start.sh
# Or with pm2: pm2 start start.sh --name claude-bridge

set -euo pipefail
cd "$(dirname "$0")"

# Load .env
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Ensure dependencies
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

# Ensure claude CLI is available
if ! command -v claude &> /dev/null; then
  echo "ERROR: 'claude' CLI not found in PATH"
  echo "Install: npm install -g @anthropic-ai/claude-code"
  exit 1
fi

# Copy CLAUDE.md to working dir if not there already
CLAUDE_MD_TARGET="${CLAUDE_WORKING_DIR:-$HOME}/CLAUDE.md"
if [ ! -f "$CLAUDE_MD_TARGET" ]; then
  echo "Copying CLAUDE.md to $CLAUDE_MD_TARGET"
  cp CLAUDE.md "$CLAUDE_MD_TARGET"
fi

echo "Starting Claude Slack Bridge..."
exec node src/index.js
