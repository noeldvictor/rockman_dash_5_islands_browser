#!/usr/bin/env bash
# Build everything the web app needs:
#   1. redirect the game's frame-limiter sleep (tools/patch_jar.py), then recompile the bytecode
#      + our DoJa runtime to JavaScript (TeaVM), once per variant
#   2. copy the original game data next to it
# Usage: tools/build.sh [localized|delocalized ...]   (default: both)
set -euo pipefail
cd "$(dirname "$0")/.."

variants=("$@")
[ ${#variants[@]} -eq 0 ] && variants=(localized delocalized)

for v in "${variants[@]}"; do
  echo "== recompiling $v"
  mkdir -p "build/patched/$v"
  python3 tools/patch_jar.py "original/$v/RockmanDASH.jar" "build/patched/$v/RockmanDASH.jar"
  (cd runtime && ./mvnw -q -B package -Dvariant="$v")
  mkdir -p "web/public/data/$v"
  cp original/"$v"/RockmanDASH.{jar,jam,sp} "web/public/data/$v/"
done
mkdir -p web/public/data/sdcard
cp original/sdcard/*.BIN web/public/data/sdcard/

[ -d web/node_modules ] || (cd web && npm install --no-audit --no-fund)
echo "done. run: (cd web && npm run dev)"
