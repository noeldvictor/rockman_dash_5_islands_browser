import { Resources } from './host/resources.js';
import { Screen } from './host/screen.js';
import { Img } from './host/g2d.js';
import { g3dFactory } from './host/g3d.js';
import { Input } from './host/input.js';
import { Audio } from './host/audio.js';
import { Net } from './host/net.js';
import { FreeCamera } from './host/camera.js';
import { Cheats } from './host/cheats.js';
import { Settings } from './host/settings.js';
import { SettingsMenu } from './host/menu.js';
import { setSmoothTextures } from './host/texfilter.js';
import { setLighting, setCelShading, shadows, markScenery } from './host/lighting.js';
import { keyOf } from './host/contentkey.js';
import { legends2 } from './mods/legends2.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const MAX_ASPECT = 21 / 9;

/** Display aspect ratio: the window's, capped, when widescreen is on; the phone's 1:1 otherwise. */
function fitAspect(wide) {
  if (params.has('aspect')) return Math.max(1, Number(params.get('aspect')));
  if (!wide) return 1;
  const chrome = document.fullscreenElement ? 48 : 150; // soft-key row, toolbar, status line
  const a = window.innerWidth / Math.max(240, window.innerHeight - chrome);
  return Math.max(1, Math.min(MAX_ASPECT, a));
}

function fitScale() {
  // match the canvas' CSS height (see index.html) in device pixels
  const css = $('screen').getBoundingClientRect().height || (window.innerHeight - 150);
  const size = css * (window.devicePixelRatio || 1);
  return Math.max(1, Math.min(8, Math.floor(size / 240)));
}

async function start(variant) {
  $('menu').hidden = true;
  $('status').hidden = false;
  $('status').textContent = 'Loading…';
  localStorage.setItem('rdash.variant', variant);

  const resources = await Resources.load(variant, 'data', (done, total) => {
    $('status').textContent = `Loading… ${done}/${total}`;
  });

  // Models that are scenery or effects, not characters (no cel shading, no shadow): by file
  // name, o* = doors, crates and other objects, ef_* = effects, flater = the Flutter airship.
  for (const [name, bytes] of resources.files(/\.mbac?$/i)) {
    if (/^(o\d|ef_|flater)/i.test(name.replace(/^.*\//, ''))) markScenery(keyOf(bytes));
  }

  const settings = new Settings();
  // URL overrides (for testing); not saved
  if (params.has('scale')) settings.set('resolution', Number(params.get('scale')), { persist: false });
  if (params.has('legends2')) settings.set('legends2', params.get('legends2') !== '0', { persist: false });
  const screen = new Screen($('screen'));
  const applyScale = () => {
    const aspect = fitAspect(settings.get('wide'));
    $('stage').style.setProperty('--aspect', String(aspect));
    const resolution = settings.get('resolution');
    screen.setLayout(resolution === 'auto' ? fitScale() : resolution, aspect);
    $('screen').classList.toggle('pixelated', resolution !== 'auto');
    $('soft').style.width = `${$('screen').getBoundingClientRect().width}px`;
  };
  applyScale();
  window.addEventListener('resize', applyScale);
  document.addEventListener('fullscreenchange', applyScale);
  settings.on('wide', applyScale);
  settings.on('resolution', applyScale);
  settings.bind('textureFilter', (v) => setSmoothTextures(v === 'smooth'));
  settings.bind('frameRate', (v) => { screen.frameRate = v; });
  settings.bind('lighting', setLighting);
  settings.bind('celShading', setCelShading);
  settings.bind('shadows', (v) => { shadows.enabled = v; });

  const input = new Input(window);
  const camera = new FreeCamera();
  input.camera = camera;
  const cheats = new Cheats();
  const applyBindings = () => input.setBindings(settings.get('keyboard'), settings.get('gamepad'));
  applyBindings();
  settings.bind('analogMove', (v) => { input.analogMove = v; });
  settings.on('keyboard', applyBindings);
  settings.on('gamepad', applyBindings);
  input.onAction = (id, down) => {
    if (id === 'recenter' && down) camera.recenter();
    else if (id === 'fast') cheats.fastForward = down;
  };
  // mouse free-look: drag on the game
  {
    const canvas = $('screen');
    let dragging = false;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (dragging && camera.following) camera.rotate(e.movementX * 0.35, e.movementY * 0.25);
    });
    const stop = () => { dragging = false; };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
  }
  // on-screen buttons for touch devices
  if (window.matchMedia('(pointer: coarse)').matches || params.has('touch')) {
    document.body.classList.add('touch');
  }
  for (const button of document.querySelectorAll('#touch [data-key]')) {
    const key = Number(button.dataset.key);
    const source = `touch:${key}`;
    const up = () => {
      button.classList.remove('down');
      input.release(key, source);
    };
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      button.setPointerCapture(e.pointerId);
      button.classList.add('down');
      input.press(key, source);
    });
    button.addEventListener('pointerup', up);
    button.addEventListener('pointercancel', up);
    button.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  const audio = new Audio();
  settings.bind('muted', (v) => audio.setMuted(v));
  const applyVolumes = () => audio.setCategoryVolumes(settings.get('musicVolume'), settings.get('effectsVolume'));
  applyVolumes();
  settings.on('musicVolume', applyVolumes);
  settings.on('effectsVolume', applyVolumes);
  const net = new Net(resources);
  let paused = false;
  const heldFrames = [];

  globalThis.DOJA = {
    // performance.now() deadline: frame pacing is skipped until then (set while a loading
    // screen is being drawn, read by rdash.GameHooks.sleep)
    loadingUntil: 0,
    res: resources,
    input,
    audio,
    net,
    g3d: g3dFactory,
    gfx: {
      screen: () => screen.graphics,
      createImage: (w, h) => screen.createImage(w, h),
      decodeImage: (data, len) => Img.decode(new Uint8Array(data.buffer, data.byteOffset, len)),
      aspect: () => screen.aspect,
      hudBegin: () => screen.hudBegin(),
      hudEnd: () => screen.graphics.setWide(false),
    },
    camera,
    cheats,
    legends2,
    settings,
    shadows,
    app: {
      param: (name) => resources.jam[name] ?? null,
      terminate: () => {
        $('status').hidden = false;
        $('status').textContent = 'The game has exited. Reload the page to play again.';
      },
      softLabel: (key, label) => {
        $(key === 0 ? 'soft1' : 'soft2').textContent = label || '';
      },
      log: (msg) => console.info('[game]', msg),
      onFrame: (cb) => {
        // the game thread waits here once per frame; while paused it simply is not woken
        if (paused) heldFrames.push(cb);
        else requestAnimationFrame(cb);
      },
    },
    screenObject: screen,
  };

  // settings menu (pauses the game while open)
  const menu = new SettingsMenu({
    root: $('settings'),
    settings,
    input,
    cheats,
    onResetData: async () => {
      await resources.reset();
      localStorage.removeItem('rdash.backup');
      location.reload();
    },
    onToggle: (open) => {
      paused = open;
      input.setEnabled(!open);
      if (!open) for (const cb of heldFrames.splice(0)) requestAnimationFrame(cb);
    },
  });
  input.onGamepadChange = (name) => {
    $('pad').textContent = name ? `Controller: ${name.replace(/\s*\(.*$/, '')}` : '';
    $('pad').classList.toggle('on', !!name);
    menu.setPadName(name);
  };

  // page controls
  const refreshBar = () => {
    $('btn-wide').textContent = settings.get('wide') ? 'Original 1:1' : 'Widescreen';
    $('btn-mute').textContent = settings.get('muted') ? 'Unmute' : 'Mute';
    $('btn-settings').classList.toggle('on', cheats.active);
  };
  menu.onCheats = refreshBar;
  settings.on('*', refreshBar);
  refreshBar();
  const toggle = (key) => settings.set(key, !settings.get(key));
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('stage').requestFullscreen?.();
  };
  $('btn-settings').addEventListener('click', () => menu.toggle());
  $('btn-wide').addEventListener('click', () => toggle('wide'));
  $('btn-mute').addEventListener('click', () => toggle('muted'));
  $('btn-full').addEventListener('click', toggleFullscreen);
  for (const b of document.querySelectorAll('#bar button')) {
    b.addEventListener('keydown', (e) => e.preventDefault()); // keep Space/Enter for the game
    b.addEventListener('click', () => b.blur());
  }
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'F1') menu.toggle();
    else if (menu.isOpen) return;
    else if (e.code === 'F2') settings.set('resolution', settings.get('resolution') === 'auto' ? 1 : 'auto');
    else if (e.code === 'F3') toggle('wide');
    else if (e.code === 'F4') menu.open('cheats');
    else if (e.code === 'KeyM') toggle('muted');
    else if (e.code === 'KeyF') toggleFullscreen();
    else return;
    e.preventDefault();
  });

  // optional Legends 2 models (only if the user installed them; see tools/mml2/)
  if (await legends2.load('mml2', (name) => resources.findAll(name))) {
    menu.available.legends2 = true;
    settings.bind('legends2', (v) => { legends2.enabled = v; });
  }

  const game = await import(/* @vite-ignore */ new URL(`game/${variant}/game.js`, document.baseURI).href);
  $('status').hidden = true;
  $('stage').hidden = false;
  game.main([], (err) => {
    if (err) console.error('game terminated with an error', err);
  });
}

for (const button of document.querySelectorAll('[data-variant]')) {
  button.addEventListener('click', () => start(button.dataset.variant));
}
if (params.has('variant')) start(params.get('variant'));
