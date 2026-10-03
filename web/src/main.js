import { Resources } from './host/resources.js';
import { Screen } from './host/screen.js';
import { Img } from './host/g2d.js';
import { g3dFactory } from './host/g3d.js';
import { Input } from './host/input.js';
import { Audio } from './host/audio.js';
import { Net } from './host/net.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

function fitScale(hires) {
  if (!hires) return 1;
  // match the canvas' CSS size (see index.html) in device pixels
  const css = $('screen').getBoundingClientRect().width
    || Math.min(window.innerWidth, window.innerHeight - 56);
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
  const screen = new Screen($('screen'));
  const applyScale = () => {
    screen.setScale(params.has('scale') ? Number(params.get('scale')) : fitScale(hires));
    $('screen').classList.toggle('pixelated', !hires);
  };
  applyScale();
  window.addEventListener('resize', applyScale);
  document.addEventListener('fullscreenchange', applyScale);

  const input = new Input(window);
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
    },
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
      onFrame: (cb) => requestAnimationFrame(() => {
        input.pollGamepads();
        cb();
      }),
    },
    screenObject: screen,
  };

  // page controls
  let muted = localStorage.getItem('rdash.muted') === '1';
  const refreshBar = () => {
    $('btn-res').textContent = hires ? 'Original resolution' : 'High resolution';
    $('btn-mute').textContent = muted ? 'Unmute' : 'Mute';
  };
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
  refreshBar();
  $('btn-res').addEventListener('click', toggleRes);
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
