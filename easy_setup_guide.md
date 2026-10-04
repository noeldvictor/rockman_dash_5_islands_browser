# Easy setup guide (Linux)

Four steps. You do not need to know anything about programming.

> You need **your own copy of the game**. It is not included here and this guide cannot tell you
> where to download it. For how the game was recovered and translated, see
> [Rockman Corner](https://www.rockman-corner.com/2025/03/rockman-dash-great-adventure-on-5.html).

## 1. Get this project

Open a terminal and run:

```bash
git clone https://github.com/noeldvictor/rockman_dash_5_islands_browser.git
cd rockman_dash_5_islands_browser
```

No `git`? On the project's GitHub page press **Code > Download ZIP**, unpack it, and open a
terminal in the unpacked folder.

## 2. Put your game files in the `gamefiles` folder

Copy what you have into the `gamefiles` folder inside the project. **Zips are fine, and you do
not need to rename or sort anything**; the setup script finds what it needs. It is looking for
two things:

| What | What it looks like |
|---|---|
| The **English patch** of the game | A folder (or zip) containing `Localized` and/or `Delocalized`, each with one `.jar`, one `.jam` and one `.sp` file |
| The game's **SD-card data** | 30 files named `RDDATA0.BIN`, `RDDATA00.BIN` … `RDDATA44.BIN` (or a zip of them) |

"Localized" uses the English names (MegaMan, Servbot, Reaverbot); "Delocalized" keeps the
Japanese ones (Rock, Kobun, Reaverd). You only need one of the two; with both you can choose
when the game starts.

## 3. Run the setup script

```bash
./setup_script.sh
```

It tells you what it is doing at each step:

1. **Checks your tools.** It needs Java, Node.js and Python. If one is missing it shows the
   command it would run and asks before installing anything (it may ask for your password).
2. **Sorts your game files** from `gamefiles` into place. If something is missing it says
   exactly what, and you can add it and run the script again.
3. **Builds the game.** The first time this downloads some build tools and takes a few minutes.
4. **Starts the game** and opens it in your browser.

## 4. Play

The game opens at <http://localhost:5173/>. Pick a variant, then:

- **F1** opens the settings menu: widescreen, 60 fps, cel shading, controls and so on.
- A controller works straight away: left stick moves, right stick looks, press both sticks in
  for the settings menu.
- Keyboard: arrows or WASD to move, Space jump, Z shoot, Enter confirm, Q and E for the two
  phone soft keys (Map and Items).

Next time, just run:

```bash
./play.sh
```

Press **Ctrl+C** in the terminal to stop the game. Your saves are kept in your browser; the
settings menu's Extras tab can export them to a file.

## Take it with you: one file

Once the game is set up you can pack it into a single file that plays on its own:

```bash
./package_html.sh
```

That writes `build/package/Rockman-DASH-5-Islands.html` (about 40 MB). Copy it to another
computer, a Steam Deck or a phone, or keep it as an archive, and open it in a browser: no
installation and no internet needed. `./package_html.sh --small` leaves out the recorded music
instruments (about 12 MB); `--full` adds the AI textures and Legends 2 models if you have them
(about 140 MB, better kept for desktops).

Two things to know: the file contains your game files, so keep it to yourself; and saves live
in the browser of the device you play on (the settings menu's Extras tab can export them). On
Android, open the file with Chrome; saves there may not survive between sessions, so export
them if they matter.

## Play it on Android: an app

For an Android phone or an Android handheld (AYN Thor, Retroid Pocket and the like), build an
app you install once and then play offline:

```bash
./package_android.sh
```

That writes `build/package/Rockman-DASH-5-Islands.apk` (about 27 MB). Then either:

- copy the file to the device, open it there and allow the install when Android asks
  ("install unknown apps"), or
- connect the device by USB with USB debugging switched on and run
  `./package_android.sh --install`.

The app runs full screen in landscape, in widescreen. A built-in or Bluetooth controller works
straight away (left stick moves, right stick looks, both sticks pressed in opens the settings);
without one, a stick and buttons appear on the screen. Saves stay inside the app. It needs
Android 8 or newer.

`--small` leaves out the recorded music instruments (6 MB); `--full` adds the AI textures and
Legends 2 models if you have them (about 100 MB).

The script needs the Android SDK. If you have Android Studio installed it is found
automatically; if not, the script offers to download the two parts it needs (about 300 MB).
As with the single file: the app contains your game files, so keep it to yourself.

## If something goes wrong

| What you see | What to do |
|---|---|
| `game files are missing` | Read the list the script printed, add those files to `gamefiles`, run `./setup_script.sh` again |
| `Node.js 18+ is needed` | Say yes when the script offers to install it, or install Node.js 18 or newer yourself |
| The build stops with a Java error | Check `java -version` says 11 or newer; if not, install a newer JDK and run the script again |
| The browser shows a blank page | Wait a few seconds and reload; if it stays blank, run `./setup_script.sh` again and read its last lines |
| `Permission denied` running the script | Run `chmod +x setup_script.sh play.sh` once |

Not on Linux? The script is written for Linux only. On Windows the simplest route is WSL (a
Linux inside Windows); on a Mac the manual steps in the [README](README.md#building-and-running)
work if you install Java, Node.js and Python yourself.

## Optional extras

None of these are needed to play.

- **Better music**: on Debian or Ubuntu the script offers to install the `fluid-soundfont-gm`
  package, so the music plays on recorded instruments.
- **Mega Man Legends 2 character models**: needs a disc image of that game; see `CLAUDE.md`,
  "Commands".
- **AI-upscaled textures**: needs your own ComfyUI server; see `tools/ai/textures.py`.
