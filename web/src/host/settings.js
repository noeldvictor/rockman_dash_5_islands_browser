// User settings: one object persisted in localStorage, with change notification.
//
// Everything the settings menu (menu.js) edits lives here; the modules that act on a setting
// subscribe with on(). Cheats are transient game-state tweaks and keep their own store (cheats.js).

const KEY = 'rdash.settings';

export const DEFAULTS = {
  // video
  wide: false,
  /** widescreen: fill the bars beside 2D screens with a blurred copy of the picture */
  sideFill: true,
  /** 'auto' (fit the window), or canvas pixels per phone pixel: 1 = the phone's 240p */
  resolution: 'auto',
  /** 'sharp' (nearest, like the phone), 'smooth' (filtered) or 'hd' (enlarged 4x, then filtered) */
  textureFilter: 'sharp',
  /** vertical field of view of full-screen 3D, degrees; the game's own is 60 */
  fov: 60,
  /** factor on how far away the mission draws enemies, objects (the game's is 1) and scenery */
  drawDistance: 1,
  lighting: false,
  shadows: false,
  /**
   * Pictures per second: 15 = the game's own rate; 30, 60 or 0 (the display's rate) show
   * interpolated in-between pictures. The game logic always runs at 15 steps per second.
   */
  frameRate: 15,
  /** two-tone shading and outlines on characters */
  celShading: false,
  // audio
  muted: false,
  musicVolume: 1,
  effectsVolume: 1,
  /** 'sampled' (recorded instruments, if the set has been generated) or 'fm' (phone-style synthesis) */
  instruments: 'sampled',
  // controls
  /** version of the action list the bindings below belong to (2: separate play and menu sets) */
  bindings: 2,
  /** action id -> KeyboardEvent.code[]; null = the defaults in input.js */
  keyboard: null,
  /** action id -> gamepad button index[]; null = the defaults in input.js */
  gamepad: null,
  /** dual-stick: the left stick moves relative to the camera, the right stick looks */
  directStick: true,
  /** the movement keys move relative to the camera (for use with mouse look) */
  directKeys: false,
  /** click the game to capture the mouse: move to look, left button buster, right button lock-on */
  mouseLook: false,
  /** look speed factor for the right stick and the mouse */
  lookSensitivity: 1,
  invertY: false,
  /** factor on the follow camera's distance from the player */
  cameraDistance: 1,
  // extras
  legends2: true,
  /** experiment: horizontal stretch of the test areas (roomy.js); 1 = off */
  roomy: 1,
  /** draw the remade models where they are installed (web/public/remake/) */
  remake: true,
};

export class Settings {
  #values = { ...DEFAULTS };
  #listeners = new Map(); // key or '*' -> Set of callbacks

  constructor() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch {
      // ignore a corrupt setting
    }
    if (saved && typeof saved === 'object') {
      for (const k of Object.keys(DEFAULTS)) if (k in saved) this.#values[k] = saved[k];
      if (saved.bindings !== DEFAULTS.bindings) {
        // bound under an older action list: the same button would now do two things in a menu
        this.#values.keyboard = null;
        this.#values.gamepad = null;
        this.#values.bindings = DEFAULTS.bindings;
      }
      if (saved.smoothMotion && !('frameRate' in saved)) this.#values.frameRate = 0; // older name
      if (saved.analogMove && !('directKeys' in saved)) this.#values.directKeys = true; // older name
    } else {
      // first run with this store: pick up the older one-key-per-setting values
      const old = (k) => localStorage.getItem(`rdash.${k}`);
      if (old('wide') === '1') this.#values.wide = true;
      if (old('hires') === '0') this.#values.resolution = 1;
      if (old('muted') === '1') this.#values.muted = true;
      if (old('legends2') === '0') this.#values.legends2 = false;
    }
  }

  get(key) {
    return this.#values[key];
  }

  /** Change a setting, persist it and notify. `persist: false` is for URL overrides. */
  set(key, value, { persist = true } = {}) {
    if (!(key in DEFAULTS)) throw new Error(`unknown setting ${key}`);
    if (this.#values[key] === value) return;
    this.#values[key] = value;
    if (persist) localStorage.setItem(KEY, JSON.stringify(this.#values));
    for (const k of [key, '*']) for (const fn of this.#listeners.get(k) ?? []) fn(value, key);
  }

  /** Call `fn(value, key)` whenever `key` ('*' = any setting) changes. */
  on(key, fn) {
    let set = this.#listeners.get(key);
    if (!set) this.#listeners.set(key, (set = new Set()));
    set.add(fn);
  }

  /** Like on(), and also calls `fn` now with the current value. */
  bind(key, fn) {
    this.on(key, fn);
    fn(this.#values[key], key);
  }

  resetAll() {
    for (const [k, v] of Object.entries(DEFAULTS)) this.set(k, v);
  }
}
