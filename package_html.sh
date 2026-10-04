#!/usr/bin/env bash
# Builds ONE self-contained HTML file of the game: copy it to any device, archive it, and open it
# in a browser to play. No server, no installation. Run ./setup_script.sh first.
#
#   ./package_html.sh            game + both variants + sampled music   (about 40 MB)
#   ./package_html.sh --small    without the sampled music instruments  (about 12 MB)
#   ./package_html.sh --full     also AI textures and Legends 2 models, if you have them
#
# The file contains your game files: keep it for yourself.
set -euo pipefail
cd "$(dirname "$0")"
if ! ls web/public/game/*/game.js > /dev/null 2>&1; then
  echo "The game has not been built yet. Run ./setup_script.sh first."
  exit 1
fi
name=Rockman-DASH-5-Islands
case " $* " in
  *" --small "*) name=$name-small ;;
  *" --full "*) name=$name-full ;;
esac
(cd web && { [ -d node_modules ] || npm install --no-audit --no-fund; } && npx vite build --logLevel warn)
node tools/package/single_html.mjs --out "build/package/$name.html" "$@"
echo "Open it with a double-click, or copy it to another device and open it in a browser there."
