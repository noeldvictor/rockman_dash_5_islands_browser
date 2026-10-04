# Rockman DASH: Great Adventure on 5 Islands — browser port

Goal: run the 2008 NTT DoCoMo i-appli (DoJa 5.x Java phone game, with the fan English patch) as a
browser game, by statically recompiling its bytecode to JavaScript and re-implementing the phone
APIs on three.js. No emulator.

## How it works

```
original/<variant>/RockmanDASH.jar ──┐ (via tools/patch_jar.py)
runtime/src/main/java (our DoJa API) ─┴─ TeaVM ──► web/public/game/<variant>/game.js
                                                        │ calls globalThis.DOJA.*
web/src/host/*  (three.js renderer, Canvas2D, input, storage, audio) ◄──┘
```

- **Game code is not rewritten.** The 73 obfuscated classes in the jar are compiled ahead of time
  to one ES module by TeaVM, together with `runtime/` — our Java implementation of the
  `com.nttdocomo.*` / `javax.microedition.io` classes the game uses (142 members; list them with
  `javap` on the jar). `Boot.java` (default package, like the game) starts `RockmanDash_F`.
- **`rdash.Host`** is the only Java↔JS seam: `@JSBody` natives calling `globalThis.DOJA`, which
  `web/src/main.js` assembles before importing `game.js`.
- **The game thread** is a TeaVM coroutine. `Graphics.unlock(true)` presents the frame and then
  suspends until `requestAnimationFrame`; the game paces itself to 15 fps with `Thread.sleep`.
- **Build-time jar patch** (`tools/patch_jar.py`, output in `build/patched/`), four mechanical
  changes and nothing else:
  1. the game's single `Thread.sleep` call (its frame limiter) is redirected to
     `rdash.GameHooks.sleep`, which skips the wait while a loading screen is showing. The host
     recognises loading screens by their "please do not press/push any buttons" line (`g2d.js`),
     so loading takes seconds instead of ~25 s per area;
  2. every field is made public, so our default-package classes can read game state;
  3. classes we override from source are dropped from the jar;
  4. three instance-method calls, each with exactly one call site, become static calls into
     `Mods` with the receiver as first argument (`invokevirtual` -> `invokestatic`, same length):
     `bh.a(Graphics, bn)` (mission HUD) -> `Mods.hud`, `ao.a(Graphics, av, int, int)` (2D sky)
     -> `Mods.sky`, `h.R()` (walk forward) -> `Mods.walk`. Each is the original method's logic
     re-written in `Mods.java` with the port's change marked. Use this for single methods of
     classes that are too big to override from source; the patcher fails if a target is not
     called exactly once.
- **Source overrides of game classes.** A default-package `.java` file in
  `runtime/src/main/java/` named like a game class replaces that class: it is the CFR
  decompilation with changes marked `port:`. Currently only `ax.java` (the camera). Only small
  classes that decompile cleanly are candidates; most of the game does not round-trip through a
  decompiler. `tools/build.sh` works out the list from the file names.
- **`Mods.java`** (default package) runs after every presented frame (`GameHooks.frame`): cheats,
  free-look and direct stick movement support; it also holds the redirected methods above. Game-state map it relies on: `ad` = canvas/root; `ad.u` = state machine
  (`u.f` current state: 2 mission `bp`, 6 title); `ad.i` (`am`) = save data with `m`/`o` max and
  current life, `n`/`p` max and current special energy, `q` zenny; `ad.p.b` = target frame rate;
  `ad.w` (`bp`) = mission, `bp.d` (`bh`) = world, `bh.a` (`av`) = player (`G` transform, `o` =
  "moved" flag that makes the game rebuild its camera, `D` = map mode), `bp.a` (`ax`) = camera,
  `bh.b` (`ao`) = map with collision, `bp.e` (`k`) = mission status/dialog flags.
- **Two variants** of the English patch (`localized`: MegaMan/Servbot/Reaverbot…, `delocalized`:
  Rock/Kobun/Reaverd…) differ in 3 classes and ~100 data files, so each is recompiled separately
  and picked on the start page (`?variant=` skips the menu).

## Layout

| Path | What |
|---|---|
| `setup_script.sh`, `play.sh`, `easy_setup_guide.md` | One-step Linux setup for players: checks/installs tools (asks first), sorts the files dropped in `gamefiles/` into `original/`, runs `tools/build.sh`, starts Vite and opens the browser; `--files-only` stops after sorting (used to test it) |
| `gamefiles/` | Drop folder for the setup script; only its note file is committed |
| `package_android.sh`, `tools/package/android/` | Android app: `vite build`, the web build copied into the APK's `assets/www/`, one `MainActivity` (Java, no libraries) with a full-screen WebView. Built without Gradle: `aapt2` compile/link, `javac --release 8`, `d8`, `zipalign`, `apksigner` with a locally generated key; SDK looked up in `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, `~/Android/Sdk` (offers to download the command-line tools). The page is served from the assets through `shouldInterceptRequest` under `https://rdash.app/`, a secure origin, so IndexedDB, module scripts and the audio worklet work as in a browser; no permissions. It loads `index.html?app&touch`: `app` (body class) fills the screen and turns widescreen on by default, `touch` shows the on-screen controls, which hide while a gamepad is connected (`has-pad`). minSdk 26. Sizes: 6 MB `--small`, 27 MB default, 99 MB `--full`. Verified in the SDK emulator (Android 14, WebView 113) through the WebView's DevTools socket: runs at the game's 15 fps with worklet audio; `adb shell input keyevent` needs `--longpress` (an instant tap is shorter than a game frame) and delivers keys with an empty `code`, which `codeOf` in `input.js` maps from `key` |
| `package_html.sh`, `tools/package/single_html.mjs` | Single-file build: `vite build`, then every file the page would fetch is embedded as base64 in `<script type="application/x-rdash-file" data-path>` elements and the app module is inlined. A shim answers `fetch()` for those paths from the page (anything else under the page's folder is a 404, which is how optional packs read as absent) and defines `rdashResolve(url, inline)`: a `blob:` URL for the game's `import()`, a `data:` URL for the audio worklet (a page opened from disk has an opaque origin and worklets refuse `blob:` there). Sizes: 13 MB `--small`, 41 MB default (with the SoundFont set), 139 MB `--full` (AI textures + Legends 2). Verified from `file://` in headless Chrome |
| `original/` | Game inputs, **not in the repository** (git-ignored; supply your own dump): `<variant>/RockmanDASH.jar`, `.jam`, `.sp` (scratchpad) for `localized` and `delocalized`, and `sdcard/RDDATA*.BIN` |
| `runtime/` | Maven project: DoJa API reimplementation + TeaVM build (`./mvnw`, JDK 11+) |
| `web/` | Vite app. `src/host/` = host services, `src/formats/` = file-format parsers (no three.js imports), `src/mods/` = optional asset replacement |
| `tools/build.sh` | Patch + recompile both variants and copy data into `web/public/` |
| `tools/patch_jar.py` | Build-time jar patch: `Thread.sleep` -> `rdash.GameHooks.sleep`, three calls -> `Mods.hud`/`sky`/`walk`, public fields, dropped overridden classes |
| `tools/extract_assets.py` | Unpack jar / scratchpad / SD data into `build/assets/` for inspection |
| `tools/play.mjs` | Headless Chrome driver: key presses, screenshots and canvas video recording (`build/shots/`) |
| `tools/trailer/` | `record.sh` records gameplay clips with `play.mjs` (scripted keys, a simulated controller, settings switched per clip); `edit.sh` cuts them with stills from `docs/`, captions and the title music into `build/trailer/trailer.mp4` |
| `tools/d4d/`, `tools/mbac/`, `tools/mfi/` | Dump/validate scripts for the map, model and sound formats (`check_all.mjs` in each; `tools/mfi/render.mjs` renders a `.mld` to WAV, `verify.mjs` self-checks the synth) |
| `tools/soundfont/` | `extract.mjs`: cut the instruments the music uses out of a General MIDI SoundFont into `web/public/soundfont/` |
| `tools/ai/` | Optional AI helpers that run on a ComfyUI server (`comfy.py`, address in `$COMFY`): `textures.py` builds the AI-upscaled texture pack, `music.py` + `mfi_abc.mjs` have YuE 2 perform a tune from its score (experimental) |
| `tools/mml2/` | Mega Man Legends 2 (PSX) disc extraction: models, textures, music, sound (formats documented in each script's header); `install.py` copies what the host uses into `web/public/mml2/` |
| `docs/` | Screenshots used by `README.md` |
| `build/` | Scratch output, git-ignored |

`web/public/game/`, `web/public/data/` and `web/public/soundfont/` are generated by
`tools/build.sh` and git-ignored; so is `web/public/hd/` (the AI texture pack).
`web/public/mml2/` (installed Legends 2 assets) and the disc image (`*.chd`) are git-ignored too:
nothing derived from the Legends 2 disc is ever committed.
The Windows launcher bundle the game shipped in (`rockmanlegendsof5islands*`) is git-ignored; it is
only useful as reference (it contains NTT's DoJa 5.1 SDK: API stubs in
`data/tools/iDKDoJa5.1/lib/doja_classes.zip`, native 3D engine `bin/micro3d_d4.dll`).

## Commands

```bash
tools/build.sh                 # recompile + copy data (both variants; pass one name to build just it)
cd web && npm run dev          # http://localhost:5173/  (?variant=localized&scale=2)
node tools/play.mjs wait:3500 key:Enter wait:3000 key:Enter wait:2500 key:Enter wait:5000 shot:ingame
                               # Continue -> island map -> enter area; needs the dev server running
python3 tools/extract_assets.py                      # -> build/assets/
node tools/d4d/check_all.mjs                         # parse every map (also tools/mbac, tools/mfi)
node tools/soundfont/extract.mjs                     # sampled instruments (build.sh does this too)
node tools/mfi/render.mjs <file.mld> out.wav --soundfont web/public/soundfont   # omit for FM
python3 tools/ai/textures.py                         # AI texture pack -> web/public/hd/ (resumable)
python3 tools/ai/music.py bgmtitle --seed 1          # YuE 2 performance -> build/ai/music/
```

The two `tools/ai/` commands need a ComfyUI server (`COMFY=http://host:8188`; the user's is at
`192.168.1.44:8188`, an RTX 5090 that also runs the user's own jobs, so a run may sit in its
queue) and the unpacked game data (`tools/extract_assets.py`).

Optional Legends 2 assets, from the user's own disc image (`S` = any scratch directory):

```bash
chdman extractcd -i 'Mega Man Legends 2 (USA).chd' -o $S/mml2.cue -ob $S/mml2.bin
python3 tools/mml2/iso.py extract $S/mml2.bin $S/disc
python3 tools/mml2/models.py $S/disc build/mml2/models      # about 7 min; 1,711 .glb + index.json
python3 tools/mml2/textures.py $S/disc build/mml2/textures
python3 tools/mml2/bank.py $S/disc build/mml2/sfx
python3 tools/mml2/staff.py $S/disc build/mml2/music        # before music.py, so it is merged into the index
python3 tools/mml2/music.py $S/disc build/mml2/music        # needs node
python3 tools/mml2/xa.py $S/disc build/mml2/xa
python3 tools/mml2/contact.py build/mml2/models 8           # contact sheets, to identify models by eye
python3 tools/mml2/install.py                               # build/mml2/ -> web/public/mml2/
```

After changing anything under `runtime/`, re-run `tools/build.sh <variant>`; the web host reloads
on its own. To read the game's logic, decompile the jar with CFR (`java -jar cfr.jar
original/localized/RockmanDASH.jar --outputdir build/decomp`); class and method names are
obfuscated (`a`…`bt`).

## Game data

- **Jar** (`resource:///name`): classes, UI art (GIF), character models, scripts (`.rde` events,
  `.rfc`), translated text (`X*` files and `.csv` override the Japanese ones in the data zips).
- **Scratchpad** (`.sp`, `scratchpad:///<segment>;pos=,length=`): 64-byte header of LE int32
  segment sizes, then 4 segments — 0: `[int32 len][zip]` data for the current island, 1: save
  data, 2: last membership check (year*100+month), 3: `[int32 len][zip]` of the `.mld` sounds.
- **SD card** (`RDDATA<i><n>.BIN`): five chunks per island that concatenate to that island's data
  zip; `RDDATA<i>.BIN` holds the chunk count. Originally downloaded from Capcom's server.
- The game also talks HTTP to its (dead) server: `dataget.php` (data download) and `isr.php`
  (server-side save). `web/src/host/net.js` answers those.
- Writes to the scratchpad and SD card are mirrored to IndexedDB (`rdash`); the server-side save
  backup lives in `localStorage['rdash.backup']`.
- At boot the host stamps the current year*100+month into scratchpad segment 2, so the game sees
  a current subscription check and starts at the title (otherwise the patched game re-asks where
  to store data on every launch).
- The dumped scratchpad already contains a save near the end of the game (island 5), which is
  what "Continue" loads; "New Game" starts on island 1.

## File formats

| Ext | Format | Parser |
|---|---|---|
| `.d4d` | Map scene: M3G 1.0 (JSR-184) object stream behind a 10-byte `D4` header. Textures are external BMPs (`<first 3 chars of map name><Image2D.userID>.bmp`) that the game splices into the stream before loading; alpha lives in the BMP palette's 4th byte. UV scroll animation only. | `web/src/formats/d4d.js` (documented in its header) |
| `.mba`/`.mbac`, `.mtr`/`.mtra` | MascotCapsule MBAC v5 models / MTRA v5 animations | `web/src/formats/mbac.js` |
| `.bmp` | 8-bit paletted textures; palette index 0 is the colour key for models/primitives | `web/src/formats/bmp.js` |
| `.mld` | MFi 5 (i-melody) music and sound effects: note events for an FM/wavetable chip, plus embedded G.726 ADPCM samples in most effects | `web/src/formats/mfi.js` (documented in its header) |

## DoJa conventions that matter

Items marked (DLL) were confirmed by disassembling NTT's reference engine `micro3d_d4.dll`.

- Display is 240x240. Fonts are fixed-pitch: `SIZE_TINY` = 12 px, `SIZE_SMALL` = 16 px (half-width
  glyphs are size/2 wide); `drawString` y is the baseline. Game strings carry trailing NULs, which
  have no glyph and no width.
- Controllers (Gamepad API) are polled every display frame in `input.js`. Each pad is first
  brought to the standard layout by `standardPad`: a pad the browser reports with an empty
  `mapping` and six or more axes is read in the Linux driver (evdev) order — left stick, left
  trigger, right stick, right trigger, d-pad hat on axes; A, B, X, Y, LB, RB, Back, Start, Guide,
  L3, R3 on buttons — otherwise its right stick would be read from a trigger axis. Defaults: A jump+confirm, X buster, Y special, B confirm, L1/R1 turn, L2/R2 lock-on,
  Select/Start soft keys, R3 re-centre camera, L3 fast-forward, L3+R3 settings menu, left
  stick = d-pad. Keyboard and
  controller bindings are per action (`ACTIONS` in `input.js`) and user-editable. The phone
  vibrator (`PhoneSystem` attribute 1) drives rumble.
- Key state is a bit mask by key code: 0–9 digits, 10 `*`, 11 `#`, 16 left, 17 up, 18 right,
  19 down, 20 select, 21/22 soft keys. Default bindings (Options > Controls): jump 0, buster 9,
  special weapon 6, lock-on 3.
- `util3d.Transform` is a 4x4 **row-major** float matrix (translation in elements 3, 7, 11);
  every operation post-multiplies; angles are **degrees** everywhere (`FastMath` too).
- The world is right-handed, **y up**. View space is right-handed with x right, **y down**, +z
  forward: `lookAt(position, lookPoint, up)` builds `z = normalize(look - position)`,
  `x = z × up`, `y = z × x` (DLL). The engine then applies diag(1,-1,-1) to reach GL camera space.
- `Vector3D.normalize()` throws `ArithmeticException` on a zero vector and `lookAt` throws on
  degenerate input; the game catches these on purpose (e.g. the top-down Map camera).
- Projection always spans the whole 240x240 surface; `setClipRectFor3D` is only a scissor (DLL).
  `setPerspectiveView(near, far, angle)`: angle = full vertical FOV. `setParallelView(w, h)`:
  visible world units, depth 0..32768.
- Each `flushBuffer` clears depth only and draws queued objects in call order with a Z-buffer;
  blended geometry does not write depth (DLL).
- Blend modes: 0 opaque, 32 `src·a + dst·(1−a)`, 64 `src·a + dst`. `setTransparency` takes
  opacity in percent (100 = opaque) (DLL).
- `Primitive`: vertex int 1 == 1.0 world unit; texture coords are texels divided by (size − 1);
  colours 0xRRGGBB; never culled; flag 16 = colour key on palette index 0 (DLL).
- Figures (MBAC) are drawn at 1/64 world unit per model unit; their texture coords are texels
  divided by the texture width on both axes; front faces are clockwise in the file (DLL).
- Game logic keeps positions in 20.12 fixed point and divides by 4096 before calling the 3D API.
- `Collision.isHit(shape, sphere, dest, true)` sweeps the sphere from its transform's translation
  to the absolute point `dest` and reports the fraction travelled through `CollisionObserver`
  (semantics inferred from how the game uses the result).
- `new String(byte[])` decodes UTF-8 here but Shift_JIS on the phone. The English patch's data is
  ASCII, so this only matters if Japanese data files are ever shown.

## Port features beyond the original

- **Widescreen** (F3, `screen.js`/`g3d.js`): the canvas becomes wider than 240 logical pixels.
  Full-screen 3D keeps its vertical field of view and fills the width; the game's 2D stays in the
  centred 240x240 area (dialogue and the boss gauge centred, 2D-only screens pillarboxed), except
  the backdrop drawn before full-screen 3D (the sky), which is stretched across, and the mission
  HUD: `Mods.hud` draws the life gauge at the left screen edge and the special-weapon gauge at
  the right one (`Host.hudBegin` lifts the 240-wide clip for it). Inset 3D views (map screen,
  model viewers) keep the square projection. The camera override widens the game's own
  culling frustum to match (`Host.aspect()`), otherwise objects pop out at the sides.
- **Free-look camera** (right stick, mouse drag, R/R3 to re-centre; `camera.js`, `ax.java`,
  `Mods.java`): during normal gameplay the follow camera is swung around a point above the player
  by host-held yaw/pitch offsets, keeping the game's camera distance and stopping at walls with
  the game's own map collision. The game only rebuilds its camera when the player moves, so
  `Mods` sets the player's "moved" flag when the offsets change. While the left stick is used the
  camera holds its world heading and the stick steers relative to it by pressing the game's own
  turn/forward keys (the game itself only has tank controls). `Mods.sky` adds the yaw offset to
  the 2D sky's scroll position (and wraps it; the original leaves gaps for negative headings).
- **Dual-stick / direct movement** (Settings > Controls; `input.js`, `camera.js`, `Mods.java`):
  two settings, `directStick` (on by default: left stick moves, right stick looks) and
  `directKeys` (off by default: the movement keys/d-pad do the same, for use with mouse look).
  The direction pushed, relative to the camera, becomes the player's heading at once (`Mods.camera` rotates the player with the game's
  own turn calls); stick deflection scales the walking speed (`Mods.walk`). While lock-on is held
  the game strafes, so they act as a d-pad there. The four movement actions never press phone
  keys directly: `Input.#syncMove` turns them into keys every time they change and every display
  frame, because play / menu / lock-on can change while they are held.
- **Camera options** (Settings > Controls): look sensitivity and vertical inversion
  (`FreeCamera.look`), camera distance (`ax.portFreeLook` scales the follow distance; the wall
  sweep still applies), and mouse capture: click the game to lock the pointer, move to look, left
  button buster, right button lock-on, Esc releases (default is drag to look).
- **Save export / import** (Settings > Extras; `Resources.exportSaves` / `importSaves`): a JSON
  file with everything persisted in IndexedDB (scratchpad segments, SD writes) plus the server
  backup. Note the scratchpad's data segment is in it, i.e. the current island's game data.
- **Settings menu** (F1 or the Settings button; `settings.js`, `menu.js`): one overlay with
  Video, Audio, Controls, Cheats and Extras tabs. `Settings` is a single persisted object
  (`localStorage['rdash.settings']`) with change listeners; modules subscribe in `main.js`. The
  game is paused while the menu is open (the game thread's per-frame wake-up is withheld) and
  sees no input. F2/F3/M/F/F4 remain as shortcuts. `?scale=` and `?legends2=` override settings
  without saving them. A controller opens it with both sticks pressed in (or the Guide button,
  the rebindable `menu` action) and drives it: while input is disabled `Input.#pollMenu` turns
  the d-pad / left stick, A, B / Start and L1 / R1 into `onMenuNav` commands with key repeat, and
  `SettingsMenu.nav` moves a highlight (`.navfocus`) over the open tab's controls, steps sliders
  and lists, clicks buttons and switches tabs. After the menu opens or closes, controller
  buttons are ignored until all are released, so the closing press does not reach the game.
- **Rebindable controls**: any number of keys/buttons per action, edited in the menu.
- **On-screen controls** (`touch.js`, markup in `index.html`): on touch devices (or `?touch`) a
  virtual stick and action buttons sit over the bottom corners of the game. The stick feeds
  `Input.setStick`, which the gamepad poll treats as a controller's left stick; dragging a
  finger on the game turns the camera. The HUD gauges then stay in the centred 240 area
  (`Screen.edgeHud`). The soft-key labels under the game are clickable for everyone. A small
  toolbar over the game (fast-forward, settings, fullscreen) shows on touch devices and, in
  fullscreen, while the pointer is moving (the button row below the game is hidden there).
  While a controller is connected the stick and buttons are hidden and the gauges return to the
  screen edges.
- **Fast-forward** (hold Tab or L3, or toggle with the Fast-forward button under the game / the
  ▶▶ touch button): 4x game speed through the same frame-limiter mechanism as the speed cheat,
  for dialogue and cutscenes.
- **Video options**: resolution (auto or a fixed multiple of 240p); texture filter
  (`texfilter.js`; textures register on creation): sharp (nearest), smooth (trilinear +
  anisotropic) or HD (the game's textures enlarged 4x with Scale2x applied twice, then filtered);
  in the filtered modes transparent texels take their opaque neighbours' colour so cut-outs get
  no colour-key fringe. A fourth mode, AI upscaled, appears when the optional texture pack is
  installed: `tools/ai/textures.py` sends every distinct 8-bit BMP texture of the game (132
  pictures across the jar and all islands) through a 4x upscaling model (`4x-AnimeSharp`) on a
  ComfyUI server, each with a border of its own wrapped pixels so tiling stays seamless, plus a
  second version with the colour key filled in for textures drawn with cut-outs. The host finds
  a texture's picture by `<width>x<height>:<crc32 of its RGB pixels>` and loads it on demand
  (`loadFromPack`), keeping the game's own alpha, enlarged; until it arrives the HD version shows.
  The textures embedded in the installed Legends 2 models are in the pack too, listed by model
  name and image index; `legends2.js` registers each with that name and the picture is swapped
  whole (`loadNamed`). Field of view (`G3D.fovScale` scales the angle of full-screen perspective
  views; `ax.java` widens its culling frustum to match through `Host.fov`). Blurred side bars
  (`Screen.#fillSideBars`: in widescreen, 2D-only screens get an enlarged, blurred, dimmed copy
  of the picture in the bars instead of black). Frame rate (see Rendering model). And three
  effects in `lighting.js`, all off by default:
  - lighting: flat shading from screen-space derivatives on opaque model and map materials;
  - cel shading (characters only): two flat tones, plus a black outline: each opaque mesh is
    drawn again as a shell pushed 0.12 units away from the camera and widened in screen space
    along its normals. Two normal sets: `normal` keeps hard edges (faces more than 55 degrees
    apart are not averaged) and shades; `rdSmooth` averages everything and widens the shell.
    Figure normals are recomputed from the posed vertices every frame (`figure.js`); Legends 2
    normals are computed at load and pointed outwards by the sign of the mesh volume (their
    winding is clockwise). The cel light follows the camera (world up plus above-left-front of
    the view), so the side facing the viewer is lit; the "lighting" option's light is fixed in
    the world;
  - shadows: a soft disc under every character, placed by a ray cast down onto the map meshes of
    the same batch.
  "Character" means any figure not marked as scenery: at start `main.js` marks every model file
  named `o*` (doors, crates, objects), `ef_*` (effects) or `flater` (the Flutter) by content key
  (`contentkey.js`: length + CRC32; `Resources.files` lists data files across the jar and zips).
  Materials are hooked with `makeLit`/`makeOutline` (`onBeforeCompile` on `MeshBasicMaterial`),
  driven by shared uniforms, so toggling needs no recompile.
- **Audio options**: separate music and effects volume (`audio.js`: a sound that loops or is
  longer than 6 s counts as music).
- **Cheats** (F4, `cheats.js`, `Mods.java`): infinite life, infinite special energy, refill, max
  zenny, 2x/3x game speed (raises the frame limiter's target; the logic is per-frame), and
  one-hit kills. Enemies are class `bk` (reached as `world.o[i].i()`, `world.p` of them): a hit
  sets the flag `z` and the damage `T` (`bk.a(int, int, int)`), the enemy subtracts `T` from its
  life `k` in its next update and dies whenever `k` is 0. `Mods.oneHitKill` raises a pending
  hit's `T` to the maximum, and zeroes the life of any enemy that lost life since the last frame
  without dying. `DOJA.cheats.kills` counts the hits it made lethal.
- **Legends 2 models** (optional; page button, `?legends2=0|1`, `mods/legends2.js`): if
  `web/public/mml2/manifest.json` exists, the phone game's characters are drawn as Mega Man
  Legends 2 models posed by the phone game's own animation. Without that folder the module does
  nothing and the button stays hidden.
  - Phone models are recognised by content (`contentkey.js`: length + CRC32 of the `.mba`/`.mbac`
    bytes, looked up in the jar, the scratchpad zip and every SD-card island zip via
    `Resources.findAll`), because the game loads figures from byte arrays, not names.
  - `figure.js` returns a `legends2Part` (posed and rest bone matrices plus the phone meshes)
    instead of meshes for a recognised figure; `g3d.js` hands it to `legends2.add` and resolves
    everything at `flush`, falling back to the phone meshes for anything not assembled.
  - Retargeting: per phone bone, the model-space rotation away from the rest pose
    (`R_pose * R_rest^-1`) is applied to the mapped Legends 2 bone, after an alignment rotation
    that lines up the two rest poses (bone-to-child directions). The root follows the phone body
    bone's displacement. Bone tables are at the top of `legends2.js`.
  - The player during play is several phone figures (`r_leg`, `r_chest`, `r_head`/`r_helm`,
    `r_arm` or a special-weapon arm) drawn with the same model matrix; they are grouped into one
    character. A special weapon keeps its phone model in place of the right arm. Cutscene
    characters are single figures: `rock.mba`, `roll.mba`, `toron.mba` (Tron), `tisel.mba`
    (Teisel), `kobun.mba` (Servbot). `rock.mba` has two alternative left forearms, bone 5 (buster)
    and bone 6 (hand); the animation scales the unused one to nothing, and the Legends 2 forearm
    follows whichever is shown.
  - Diagnostics: `DOJA.legends2.stats` (recognised / parts / replaced / incomplete).

## Sound

`web/src/host/audio.js` implements the four `AudioPresenter` ports on a synthesiser running in an
AudioWorklet (`web/src/host/audio/synth.js`: pure JS, no imports — it is loaded as a worklet
module, so keep it import-free). The game's music addresses General MIDI program numbers. Two
instrument sets:

- **Sampled** (default when present): `tools/soundfont/extract.mjs` scans the game's `.mld` files
  for the programs, key ranges and drum notes they use (20 programs, 17 drum notes) and cuts
  those zones out of a General MIDI SoundFont (default `/usr/share/sounds/sf2/FluidR3_GM.sf2`,
  MIT licence, Debian package `fluid-soundfont-gm`) into `web/public/soundfont/gm.json` + `gm.bin`
  (about 21 MB, generated, git-ignored; `tools/build.sh` runs it when the SoundFont exists).
  `SfVoice` plays a zone with its key range, loop and volume envelope; one velocity layer, no
  filters or modulators.
- **FM** (fallback, and selectable under Settings > Audio): two-operator FM patches chosen by GM
  program number plus synthesised drums.

An experiment, not wired into the game: `tools/ai/music.py` has the YuE 2 music model perform a
tune from its score. `mfi_abc.mjs` writes the score in YuE 2's ABC dialect (L:1/32, a resting
"Vocal" voice carrying one chord per bar, an "Ins" voice with the lead melody: the monophonic
mid-to-high channel that sounds longest; rhythm tidied to the 1/16 grid), the style names the
tune's own General MIDI instruments and tempo, and the result is cut into a loop whose length is
measured from the audio. Results go to `build/ai/music/` for listening. ACE-Step "cover" and
"remix" of the synthesised recording were tried first and rejected by ear.

Sampled effects embedded in the files are decoded from G.726 either way. None of this is the
phone's own sound source, and it has only been checked numerically (timing, pitch, levels; the
two sets render within about 2 dB of each other), not by ear.

- The game only calls `setSound`, `play`, `stop` and `setAttribute(SET_VOLUME)`, and relies on the
  AUDIO_COMPLETE event: some screens (e.g. "MISSION START") wait for a jingle to finish, so
  completions must fire even when audio is muted or not yet unlocked by a user gesture.
- Files with a "repeat forever" loop point (all BGM, some effects) loop inside the synth and never
  complete; `?audio=gameloops` makes them play once and lets the game restart them instead.

## Rendering model

`Screen` (web/src/host/screen.js) owns one WebGL canvas. A game frame is recorded as a list of
steps and replayed when the game presents it: 2D calls draw into a Canvas2D layer; whenever 3D is
flushed the pending layer becomes a step and a fresh layer is started, then the 3D batch becomes a
step (objects, their matrices, view, projection, clip), drawn with a fresh depth buffer, so 2D/3D
ordering matches the phone. The back buffer is preserved between frames. Drawing instances
(figure meshes, primitives, Legends 2 models, shadow discs) are reused per frame, not per flush,
because a recorded frame may be replayed several times. Surfaces are `scale`× the phone's 240 px
(F2 toggles 1× "original" mode); decoded art stays native resolution with nearest filtering.

**Frame rate** (15 by default; 30, 60 or the display's rate): the game logic always steps 15
times a second, with every speed and timer counted in those steps, so higher rates are produced
by interpolation, as in other recompiled console ports. When two consecutive frames have the same
3D batches, at least one of them full-screen, and the camera did not cut (`G3D.link`), the newer
frame is replayed on display frames with the camera and each object's model matrix interpolated
from the previous frame's (`G3D.draw`), so the picture runs one game frame behind the game.
Objects are matched by drawing instance; anything that moved more than 6 units in a frame snaps.
Figures also blend their vertices from the previous frame's pose (`rdPrev` attribute, `uRdTween`
uniform), and Legends 2 models slerp their bones from the previous frame's pose
(`Instance.capture` / `root.userData.tween`, called by `G3D.draw`). A flattened model matrix
(zero-scale axis: the game's shot and effect sprites) cannot be decomposed, so those are blended
element by element. Texture scrolling and all 2D still change 15 times a second, and input is
still read 15 times a second.

## Status

Keep this section current.

- Port extras (all optional, see "Port features beyond the original"): widescreen with
  edge-pinned HUD and blurred side bars; resolution, texture filter (sharp / smooth / HD), field
  of view; 30/60 fps by interpolation; lighting, cel shading, shadows; free-look camera with
  sensitivity, inversion, distance and mouse capture; direct movement from the stick or the
  keys; controller support with rumble, rebindable controls, a controller-driven settings menu;
  touch stick, buttons and swipe-look; fast-forward; sampled music instruments and separate
  music/effects volume; save export/import; cheats; fast loading; Legends 2 character models.
- Working: recompilation of both variants, boot, title/menus, save loading from the dumped
  scratchpad, SD-card island data, 2D UI and dialogue, 3D maps, character models and animation,
  effects, collision, keyboard/gamepad/touch input, save persistence (IndexedDB), the game-server
  stand-in (data download, save backup), hi-res and original-resolution modes (F2), fullscreen (F),
  mute (M), fast loading screens, music and sound effects.
- Known gaps: only what the game uses is implemented — it never adds lights or fog, only draws
  quad `Primitive`s, and never overrides blend/transparency on a `Group`, so lit materials,
  point/line/sprite primitives and those overrides are absent. The game logic runs at its native
  15 fps; higher frame rates are interpolated, and the 2D layer and input still step at 15.
  Free-look pitch does not move the 2D sky.
- How it was checked: everything above was verified with screenshots, numeric checks and
  simulated input (keyboard, a fake gamepad, synthetic touch events) in headless Chrome. Not yet
  checked by a person: how the music sounds, how interpolated motion looks, mouse capture and
  real fullscreen (headless Chrome can do neither), touch on a real device, and a play-through
  from start to finish.
- Legends 2 replacement: MegaMan, Roll, Tron and Teisel are replaced in the New Game intro
  cutscenes and the in-game player (assembled from parts) is replaced during play; poses match
  the phone models' at the same frame. The Servbot mapping has not been seen in a test. The
  phone models' face patterns (closed eyes, expressions) have no Legends 2 counterpart. Only
  models are hooked up; the extracted Legends 2 textures, music and sound effects
  (`build/mml2/`) are unused: the effects are unnamed samples, so mapping them to the phone's 25
  effects (`se00`–`se24`) has to be done by ear.
- Git: `origin` is `git@github.com:noeldvictor/rockman_dash_5_islands_browser.git` (SSH), a
  public repository. Work happens on `main`, whose history contains no game files. The local
  branch `web-port` is the older history that still has `original/` and the data zip in it:
  never push it.
