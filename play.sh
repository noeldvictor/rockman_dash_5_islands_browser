#!/usr/bin/env bash
# Starts the game and opens it in your browser. Run ./setup_script.sh once first.
# Stop it with Ctrl+C.
set -euo pipefail
cd "$(dirname "$0")"
if ! ls web/public/game/*/game.js > /dev/null 2>&1; then
  echo "The game has not been built yet. Run ./setup_script.sh first."
  exit 1
fi
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ] && ! command -v node > /dev/null; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
fi
cd web
[ -d node_modules ] || npm install --no-audit --no-fund
echo "Starting the game. It opens in your browser; press Ctrl+C here to stop it."
exec npx vite --open
