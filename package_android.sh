#!/usr/bin/env bash
# Builds an Android app (.apk) of the game for phones and Android handhelds (AYN Thor, Retroid
# Pocket, ...): copy the file to the device, tap it to install, play offline. Android 8 or newer.
# Run ./setup_script.sh first.
#
#   ./package_android.sh            game + both variants + sampled music
#   ./package_android.sh --small    without the sampled music instruments
#   ./package_android.sh --full     also AI textures and Legends 2 models, if you have them
#   ./package_android.sh --install  also install it on the device connected by USB (adb)
#
# Needs the Android SDK (platform + build-tools) and a JDK; no Gradle, no Android Studio project.
# The script looks in $ANDROID_HOME, $ANDROID_SDK_ROOT and ~/Android/Sdk, and offers to download
# the SDK's command-line tools into build/android-sdk if there is none.
#
# The app contains your game files: keep it for yourself.
set -euo pipefail
cd "$(dirname "$0")"

SMALL=0; FULL=0; INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --small) SMALL=1 ;;
    --full) FULL=1 ;;
    --install) INSTALL=1 ;;
    -h | --help) sed -n 2,16p "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)"; exit 2 ;;
  esac
done
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mStopped:\033[0m %s\n' "$*"; exit 1; }

ls web/public/game/*/game.js > /dev/null 2>&1 || fail "the game has not been built yet. Run ./setup_script.sh first."
command -v javac > /dev/null || fail "a JDK is needed (javac). ./setup_script.sh installs one."

# ---- the Android SDK ---------------------------------------------------------------------------
SDK=""
for dir in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk" "$PWD/build/android-sdk"; do
  if [ -n "$dir" ] && ls "$dir"/build-tools/*/aapt2 > /dev/null 2>&1 && ls "$dir"/platforms/*/android.jar > /dev/null 2>&1; then
    SDK=$dir
    break
  fi
done
if [ -z "$SDK" ]; then
  say "No Android SDK found"
  echo "  I can download Google's command-line tools (about 150 MB) into build/android-sdk and"
  echo "  install the two parts needed (platform 34 and build-tools 34, about 150 MB more)."
  echo "  Google's SDK licence will be shown for you to accept."
  read -r -p "  Download them now? [y/N] " reply
  [[ "$reply" =~ ^[Yy] ]] || fail "the Android SDK is needed. Install Android Studio, or set ANDROID_HOME."
  SDK=$PWD/build/android-sdk
  mkdir -p "$SDK/cmdline-tools"
  curl -fL -o "$SDK/tools.zip" https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  unzip -q -o "$SDK/tools.zip" -d "$SDK/cmdline-tools" && mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest"
  rm "$SDK/tools.zip"
  "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" "platforms;android-34" "build-tools;34.0.0" "platform-tools"
fi
BT=$(ls -d "$SDK"/build-tools/*/ | sort -V | tail -1)
PLATFORM=$(ls -d "$SDK"/platforms/android-*/ | sort -V | tail -1)
say "Android SDK: $SDK ($(basename "$BT"), $(basename "$PLATFORM"))"

# ---- the web build -----------------------------------------------------------------------------
say "Building the web app"
(cd web && { [ -d node_modules ] || npm install --no-audit --no-fund; } && npx vite build --logLevel warn)
# work folder: start clean (literal paths only)
rm -rf build/android/assets build/android/gen build/android/classes build/android/res
rm -f build/android/res.zip build/android/unsigned.apk build/android/aligned.apk build/android/classes.dex
mkdir -p build/android/assets/www build/android/gen build/android/classes build/package
cp web/dist/index.html build/android/assets/www/
cp -r web/dist/assets web/dist/game web/dist/data build/android/assets/www/
if [ "$SMALL" = 0 ] && [ -d web/dist/soundfont ]; then cp -r web/dist/soundfont build/android/assets/www/; fi
if [ "$FULL" = 1 ]; then
  for extra in hd mml2; do
    if [ -d "web/dist/$extra" ]; then cp -r "web/dist/$extra" build/android/assets/www/; fi
  done
fi

# ---- the app -----------------------------------------------------------------------------------
say "Packing the app"
A=tools/package/android
# launcher icon: a square cut from one of the project's screenshots
mkdir -p build/android/res/mipmap-xxhdpi build/android/res/values
cp "$A/res/values/strings.xml" build/android/res/values/
python3 - build/android/res/mipmap-xxhdpi/icon.png << 'PY'
import sys
from PIL import Image
im = Image.open('docs/gameplay.jpg').convert('RGB')
w, h = im.size
side = int(h * 0.62)
left, top = int(w * 0.5 - side / 2), int(h * 0.36)
im.crop((left, top, left + side, top + side)).resize((192, 192), Image.LANCZOS).save(sys.argv[1])
PY
"$BT/aapt2" compile --dir build/android/res -o build/android/res.zip
"$BT/aapt2" link -o build/android/unsigned.apk -I "$PLATFORM/android.jar" --manifest "$A/AndroidManifest.xml" \
  -A build/android/assets --java build/android/gen build/android/res.zip
javac -nowarn --release 8 -cp "$PLATFORM/android.jar" -d build/android/classes \
  $(find "$A/src" build/android/gen -name '*.java') 2>&1 \
  | grep -v 'bootstrap class path\|source value 8\|target value 8\|To suppress warnings\|^[0-9]* warning' || true
"$BT/d8" --release --min-api 26 --lib "$PLATFORM/android.jar" --output build/android $(find build/android/classes -name '*.class')
(cd build/android && zip -q -j unsigned.apk classes.dex)
"$BT/zipalign" -f -p 4 build/android/unsigned.apk build/android/aligned.apk
# signed with a key made on this machine: Android needs a signature, and updates need the same one
KEY=build/android/rdash-local.keystore
[ -f "$KEY" ] || keytool -genkeypair -keystore "$KEY" -storepass android -keypass android -alias rdash \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Rockman DASH 5 Islands (local build)" > /dev/null 2>&1
name=Rockman-DASH-5-Islands
[ "$SMALL" = 1 ] && name=$name-small
[ "$FULL" = 1 ] && name=$name-full
OUT=build/package/$name.apk
"$BT/apksigner" sign --ks "$KEY" --ks-pass pass:android --key-pass pass:android --out "$OUT" build/android/aligned.apk
rm -f "$OUT.idsig"
"$BT/apksigner" verify "$OUT" > /dev/null
say "Done: $OUT ($(du -h "$OUT" | cut -f1))"
echo "  Copy it to the device and open it there (allow installing from that app when asked),"
echo "  or connect the device by USB with debugging on and run: ./package_android.sh --install"

if [ "$INSTALL" = 1 ]; then
  ADB="$SDK/platform-tools/adb"
  [ -x "$ADB" ] || ADB=$(command -v adb) || fail "adb not found (the SDK's platform-tools)."
  "$ADB" install -r "$OUT"
  "$ADB" shell am start -n app.rdash/.MainActivity
fi
