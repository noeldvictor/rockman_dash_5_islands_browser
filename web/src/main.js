import { Resources } from './host/resources.js';
import { Screen } from './host/screen.js';
import { Img } from './host/g2d.js';
import { g3dFactory } from './host/g3d.js';
import { Input, CONTROLS } from './host/input.js';
import { Audio } from './host/audio.js';
import { Net } from './host/net.js';
import { FreeCamera } from './host/camera.js';
import { Cheats } from './host/cheats.js';

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

function fitScale(hires) {
  if (!hires) return 1;
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

  let hires = localStorage.getItem('rdash.hires') !== '0';
  if (params.has('scale')) hires = params.get('scale') !== '1';
  let wide = localStorage.getItem('rdash.wide') === '1';
  const screen = new Screen($('screen'));
  const applyScale = () => {
    const aspect = fitAspect(wide);
    $('stage').style.setProperty('--aspect', String(aspect));
    screen.setLayout(params.has('scale') ? Number(params.get('scale')) : fitScale(hires), aspect);
    $('screen').classList.toggle('pixelated', !hires);
    $('soft').style.width = `${$('screen').getBoundingClientRect().width}px`;
  };
  applyScale();
  window.addEventListener('resize', applyScale);
  document.addEventListener('fullscreenchange', applyScale);

  const input = new Input(window);
  const camera = new FreeCamera();
  input.camera = camera;
  const cheats = new Cheats();
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
  const net = new Net(resources);

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
    },
    camera,
    cheats,
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
      onFrame: (cb) => requestAnimationFrame(cb),
    },
    screenObject: screen,
  };

  // controller indicator + controls reference
  input.onGamepadChange = (name) => {
    $('pad').textContent = name ? `Controller: ${name.replace(/\s*\(.*$/, '')}` : 'No controller detected (press a button on it)';
    $('pad').classList.toggle('on', !!name);
  };
  input.onGamepadChange(null);
  $('controls-body').innerHTML = CONTROLS
    .map(([what, keys, pad]) => `<tr><td>${what}</td><td>${keys}</td><td>${pad}</td></tr>`).join('');
  $('btn-controls').addEventListener('click', () => {
    $('controls').hidden = !$('controls').hidden;
  });

  // page controls
  let muted = localStorage.getItem('rdash.muted') === '1';
  const refreshBar = () => {
    $('btn-res').textContent = hires ? 'Original resolution' : 'High resolution';
    $('btn-wide').textContent = wide ? 'Original 1:1' : 'Widescreen';
    $('btn-mute').textContent = muted ? 'Unmute' : 'Mute';
    $('btn-cheats').classList.toggle('on', cheats.active);
  };
  const toggleWide = () => {
    wide = !wide;
    localStorage.setItem('rdash.wide', wide ? '1' : '0');
    applyScale();
    refreshBar();
  };

  // cheat menu
  const syncCheats = () => {
    $('cheat-life').checked = cheats.infiniteLife;
    $('cheat-energy').checked = cheats.infiniteEnergy;
    $('cheat-speed').value = String(cheats.speed);
    cheats.save();
    refreshBar();
  };
  $('cheat-life').addEventListener('change', (e) => { cheats.infiniteLife = e.target.checked; syncCheats(); });
  $('cheat-energy').addEventListener('change', (e) => { cheats.infiniteEnergy = e.target.checked; syncCheats(); });
  $('cheat-speed').addEventListener('change', (e) => { cheats.speed = Number(e.target.value); syncCheats(); });
  $('cheat-zenny').addEventListener('click', () => cheats.maxZenny());
  $('cheat-refill').addEventListener('click', () => cheats.refill());
  const toggleCheats = () => { $('cheats').hidden = !$('cheats').hidden; };
  $('btn-cheats').addEventListener('click', toggleCheats);
  for (const el of document.querySelectorAll('#cheats input, #cheats select, #cheats button')) {
    el.addEventListener('keydown', (e) => e.stopPropagation());
    el.addEventListener('change', () => el.blur());
    el.addEventListener('click', () => { if (el.tagName === 'BUTTON') el.blur(); });
  }
  const toggleRes = () => {
    hires = !hires;
    localStorage.setItem('rdash.hires', hires ? '1' : '0');
    applyScale();
    refreshBar();
  };
  const toggleMute = () => {
    muted = !muted;
    localStorage.setItem('rdash.muted', muted ? '1' : '0');
    audio.setMuted?.(muted);
    refreshBar();
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('stage').requestFullscreen?.();
  };
  audio.setMuted?.(muted);
  syncCheats();
  $('btn-res').addEventListener('click', toggleRes);
  $('btn-wide').addEventListener('click', toggleWide);
  $('btn-mute').addEventListener('click', toggleMute);
  $('btn-full').addEventListener('click', toggleFullscreen);
  $('btn-reset').addEventListener('click', async () => {
    if (!confirm('Delete all saved progress and settings for this game in this browser?')) return;
    await resources.reset();
    localStorage.removeItem('rdash.backup');
    location.reload();
  });
  for (const b of document.querySelectorAll('#bar button')) {
    b.addEventListener('keydown', (e) => e.preventDefault()); // keep Space/Enter for the game
    b.addEventListener('click', () => b.blur());
  }
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'F2') toggleRes();
    else if (e.code === 'F3') toggleWide();
    else if (e.code === 'F4') toggleCheats();
    else if (e.code === 'KeyR') camera.recenter();
    else if (e.code === 'KeyM') toggleMute();
    else if (e.code === 'KeyF') toggleFullscreen();
    else return;
    e.preventDefault();
  });

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
