// User settings: one object persisted in localStorage, with change notification.
//
// Everything the settings menu (menu.js) edits lives here; the modules that act on a setting
// subscribe with on(). Cheats are transient game-state tweaks and keep their own store (cheats.js).

const KEY = 'rdash.settings';

export const DEFAULTS = {
  // video
  wide: false,
  /** 'auto' (fit the window), or canvas pixels per phone pixel: 1 = the phone's 240p */
  resolution: 'auto',
  /** 'sharp' (nearest, like the phone) or 'smooth' (bilinear + mipmaps) */
  textureFilter: 'sharp',
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
  // controls
  /** action id -> KeyboardEvent.code[]; null = the defaults in input.js */
  keyboard: null,
  /** action id -> gamepad button index[]; null = the defaults in input.js */
  gamepad: null,
  analogMove: false,
  // extras
  legends2: true,
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
      if (saved.smoothMotion && !('frameRate' in saved)) this.#values.frameRate = 0; // older name
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
