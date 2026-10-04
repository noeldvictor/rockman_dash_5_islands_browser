// Keypad emulation. DoJa reports keys as bit positions in Canvas.getKeypadState() and as
// KEY_PRESSED_EVENT(0)/KEY_RELEASED_EVENT(1) through Canvas.processEvent().

import { wrap180 } from './camera.js';

export const KEY = {
  NUM0: 0, NUM1: 1, NUM2: 2, NUM3: 3, NUM4: 4, NUM5: 5, NUM6: 6, NUM7: 7, NUM8: 8, NUM9: 9,
  ASTERISK: 10, POUND: 11,
  LEFT: 16, UP: 17, RIGHT: 18, DOWN: 19, SELECT: 20, SOFT1: 21, SOFT2: 22,
};

// The game's default bindings (Options > Controls): Jump = 0, Buster/Confirm = 9,
// Special Weapon = 6, Lock-On = 3. Besides the raw keypad, the keyboard and gamepad get
// comfortable aliases for those four.
const JUMP = KEY.NUM0;
const BUSTER = KEY.NUM9;
const SPECIAL = KEY.NUM6;
const LOCK_ON = KEY.NUM3;

/**
 * Everything that can be bound to a keyboard key or a controller button (Settings > Controls).
 *   keys: phone keys the action holds down; host: an action handled by the page instead
 *   kb: default KeyboardEvent.code list; pad: default standard-mapping gamepad button indices
 * The controller defaults are laid out like Mega Man Legends on a PlayStation pad: Cross jump,
 * Square buster, Triangle special weapon, Circle confirm, L1/R1 turn, R2/L2 lock-on. Cross also
 * confirms, since the phone's Select key does nothing during play.
 */
export const ACTIONS = [
  { id: 'up', label: 'Forward / up', keys: [KEY.UP], kb: ['ArrowUp', 'KeyW'], pad: [12] },
  { id: 'down', label: 'Back / down', keys: [KEY.DOWN], kb: ['ArrowDown', 'KeyS'], pad: [13] },
  { id: 'left', label: 'Turn left', keys: [KEY.LEFT], kb: ['ArrowLeft', 'KeyA'], pad: [14, 4] },
  { id: 'right', label: 'Turn right', keys: [KEY.RIGHT], kb: ['ArrowRight', 'KeyD'], pad: [15, 5] },
  { id: 'jump', label: 'Jump', keys: [JUMP], kb: ['Space', 'KeyX'], pad: [0] },
  { id: 'buster', label: 'Buster', keys: [BUSTER], kb: ['KeyZ', 'KeyJ'], pad: [2] },
  { id: 'special', label: 'Special weapon', keys: [SPECIAL], kb: ['KeyC', 'KeyK'], pad: [3] },
  { id: 'lock', label: 'Lock-on', keys: [LOCK_ON], kb: ['ShiftLeft', 'ShiftRight', 'KeyV', 'KeyL'], pad: [6, 7] },
  { id: 'confirm', label: 'Confirm (menus, dialogue)', keys: [KEY.SELECT], kb: ['Enter', 'NumpadEnter'], pad: [0, 1] },
  { id: 'soft1', label: 'Left soft key (Map, Back)', keys: [KEY.SOFT1], kb: ['KeyQ', 'Backspace'], pad: [8] },
  { id: 'soft2', label: 'Right soft key (Items)', keys: [KEY.SOFT2], kb: ['KeyE', 'Escape'], pad: [9] },
  { id: 'recenter', label: 'Re-centre camera', host: true, kb: ['KeyR'], pad: [11] },
  { id: 'fast', label: 'Fast-forward (hold)', host: true, kb: ['Tab'], pad: [10] },
];

/** The phone keypad itself; an action bound to one of these codes takes precedence. */
const KEYPAD = {
  Digit0: KEY.NUM0, Digit1: KEY.NUM1, Digit2: KEY.NUM2, Digit3: KEY.NUM3, Digit4: KEY.NUM4,
  Digit5: KEY.NUM5, Digit6: KEY.NUM6, Digit7: KEY.NUM7, Digit8: KEY.NUM8, Digit9: KEY.NUM9,
  Numpad0: KEY.NUM0, Numpad1: KEY.NUM1, Numpad2: KEY.NUM2, Numpad3: KEY.NUM3, Numpad4: KEY.NUM4,
  Numpad5: KEY.NUM5, Numpad6: KEY.NUM6, Numpad7: KEY.NUM7, Numpad8: KEY.NUM8, Numpad9: KEY.NUM9,
  NumpadMultiply: KEY.ASTERISK, NumpadDivide: KEY.POUND, Minus: KEY.ASTERISK, Equal: KEY.POUND,
};

/** Default bindings: action id -> list of key codes / button indices. */
export function defaultBindings(device) {
  return Object.fromEntries(ACTIONS.map((a) => [a.id, [...(device === 'keyboard' ? a.kb : a.pad)]]));
}

const PAD_BUTTON_NAMES = ['A / Cross', 'B / Circle', 'X / Square', 'Y / Triangle', 'L1', 'R1', 'L2', 'R2',
  'Select / Share', 'Start / Options', 'L3', 'R3', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Home'];

/** Display name of a bound key or button. */
export function bindingName(device, value) {
  if (device === 'gamepad') return PAD_BUTTON_NAMES[value] ?? `Button ${value}`;
  return String(value).replace(/^Key|^Digit/, '').replace(/^Arrow(.+)$/, '$1 arrow')
    .replace(/^(Shift|Control|Alt|Meta)(Left|Right)$/, '$2 $1').replace(/^Numpad/, 'Numpad ');
}

const MOVES = new Set(['up', 'down', 'left', 'right']);

const STICK_DEADZONE = 0.45;
// direct stick movement (Settings > Controls)
const ANALOG_DEADZONE = 0.2;
const ANALOG_MIN_SPEED = 0.3;
const LOOK_DEADZONE = 0.2;
const LOOK_YAW_SPEED = 150; // degrees per second at full deflection
const LOOK_PITCH_SPEED = 90;
// Camera-relative steering: the game turns the player in fixed steps, so allow some slack
const AIM_TOLERANCE = 12;
const WALK_CONE = 75;

export class Input {
  /** Set by the game (rdash.Host): (type, key) => void */
  handler = null;
  #state = 0;
  #sources = new Map(); // key -> Set of source ids holding it down
  #padDown = new Set();
  #padActions = new Set();
  #rumbling = false;
  /** Called with the connected pad's name, or null when none is connected. */
  onGamepadChange = null;
  #padName = null;
  /** @type {import('./camera.js').FreeCamera|null} set by main.js */
  camera = null;
  #lastPoll = 0;
  /**
   * Direct movement: during play the left stick, or the movement keys, turn the player to face
   * where they point (relative to the camera) at once, and the stick sets the walking speed
   * (through the camera state, read by Mods.java), instead of pressing the game's turn keys.
   * While locked on the game strafes, so they act as a d-pad there, as in menus and cutscenes.
   */
  analogMove = false;
  #dirs = new Map(); // movement action id -> Set of sources holding it
  #moveKeys = new Set(); // phone keys held for the movement actions
  #keyHeading = NaN; // direct movement from keys: world heading, NaN when not in use
  /** False while the settings menu is open: the game then sees no input at all. */
  #enabled = true;
  /** Called for page-side actions ('recenter', 'fast'): (id, down) => void */
  onAction = null;
  #keyboard = new Map(); // KeyboardEvent.code -> actions
  #gamepad = new Map(); // button index -> actions
  #hostDown = new Map(); // host action id -> Set of sources holding it
  #capture = null; // waiting for a controller button (rebinding)
  #capturePrimed = false;

  constructor(target = window) {
    this.setBindings(null, null);
    target.addEventListener('keydown', (e) => {
      if (!this.#enabled || e.ctrlKey || e.metaKey || e.altKey) return;
      const actions = this.#keyboard.get(e.code);
      if (!actions && KEYPAD[e.code] === undefined) return;
      e.preventDefault();
      if (e.repeat) return;
      const source = `kb:${e.code}`;
      if (actions) for (const a of actions) this.#actionDown(a, source);
      else this.press(KEYPAD[e.code], source);
    });
    target.addEventListener('keyup', (e) => {
      const actions = this.#keyboard.get(e.code);
      if (!actions && KEYPAD[e.code] === undefined) return;
      e.preventDefault();
      const source = `kb:${e.code}`;
      if (actions) for (const a of actions) this.#actionUp(a, source);
      else this.release(KEYPAD[e.code], source);
    });
    target.addEventListener('blur', () => this.releaseAll());
    // Poll controllers every display frame, independently of the game's own frame rate.
    const tick = () => {
      this.pollGamepads();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  state() {
    return this.#state;
  }

  /**
   * @param {Record<string, string[]>|null} keyboard  action id -> key codes (null = defaults)
   * @param {Record<string, number[]>|null} gamepad   action id -> button indices (null = defaults)
   */
  setBindings(keyboard, gamepad) {
    this.releaseAll();
    const build = (bindings, device) => {
      const map = new Map();
      const all = { ...defaultBindings(device), ...(bindings ?? {}) };
      for (const action of ACTIONS) {
        for (const value of all[action.id] ?? []) {
          if (!map.has(value)) map.set(value, []);
          map.get(value).push(action);
        }
      }
      return map;
    };
    this.#keyboard = build(keyboard, 'keyboard');
    this.#gamepad = build(gamepad, 'gamepad');
  }

  /** The game sees no keys while disabled (the settings menu is open). */
  setEnabled(on) {
    this.#enabled = !!on;
    if (on) return;
    this.releaseAll();
    if (this.camera) {
      this.camera.analogHeading = NaN;
      this.camera.analogSpeed = 1;
    }
  }

  /** Report the next controller button pressed (for rebinding) instead of acting on it. */
  captureButton(callback) {
    this.#capture = callback;
    this.#capturePrimed = false;
  }

  /** Hold / let go of an action by id (for inputs the page handles itself, e.g. mouse buttons). */
  actionDown(id, source) {
    const action = ACTIONS.find((a) => a.id === id);
    if (action && this.#enabled) this.#actionDown(action, source);
  }

  actionUp(id, source) {
    const action = ACTIONS.find((a) => a.id === id);
    if (action) this.#actionUp(action, source);
  }

  /**
   * Turn the movement actions being held into phone keys: the plain d-pad keys, or with direct
   * movement during play "walk forward" plus a heading for Mods.java. Called on every change
   * and every display frame, since play / menu / lock-on can change while keys are held.
   */
  #syncMove() {
    const held = (id) => (this.#dirs.get(id)?.size ?? 0) > 0;
    const x = (held('right') ? 1 : 0) - (held('left') ? 1 : 0);
    const y = (held('down') ? 1 : 0) - (held('up') ? 1 : 0);
    const cam = this.camera;
    const lockedOn = (this.#state & (1 << LOCK_ON)) !== 0;
    const want = new Set();
    this.#keyHeading = NaN;
    if (this.analogMove && cam && cam.following && !lockedOn) {
      if (x || y) {
        // up = away from the camera; screen-right is 90 degrees below the camera heading
        this.#keyHeading = cam.worldYaw - (Math.atan2(x, -y) * 180) / Math.PI;
        want.add(KEY.UP);
      }
    } else {
      if (held('up')) want.add(KEY.UP);
      if (held('down')) want.add(KEY.DOWN);
      if (held('left')) want.add(KEY.LEFT);
      if (held('right')) want.add(KEY.RIGHT);
    }
    for (const key of want) if (!this.#moveKeys.has(key)) this.press(key, 'move');
    for (const key of this.#moveKeys) if (!want.has(key)) this.release(key, 'move');
    this.#moveKeys = want;
  }

  #actionDown(action, source) {
    if (MOVES.has(action.id)) {
      let held = this.#dirs.get(action.id);
      if (!held) this.#dirs.set(action.id, (held = new Set()));
      held.add(source);
      this.#syncMove();
      return;
    }
    if (!action.host) {
      for (const k of action.keys) this.press(k, source);
      return;
    }
    let held = this.#hostDown.get(action.id);
    if (!held) this.#hostDown.set(action.id, (held = new Set()));
    const was = held.size > 0;
    held.add(source);
    if (!was) this.onAction?.(action.id, true);
  }

  #actionUp(action, source) {
    if (MOVES.has(action.id)) {
      this.#dirs.get(action.id)?.delete(source);
      this.#syncMove();
      return;
    }
    if (!action.host) {
      for (const k of action.keys) this.release(k, source);
      return;
    }
    const held = this.#hostDown.get(action.id);
    if (held && held.delete(source) && held.size === 0) this.onAction?.(action.id, false);
  }

  press(key, source = 'api') {
    let held = this.#sources.get(key);
    if (!held) this.#sources.set(key, (held = new Set()));
    const was = held.size > 0;
    held.add(source);
    if (was) return;
    this.#state |= 1 << key;
    this.handler?.(0, key);
  }

  release(key, source = 'api') {
    const held = this.#sources.get(key);
    if (!held || !held.delete(source) || held.size > 0) return;
    this.#state &= ~(1 << key);
    this.handler?.(1, key);
  }

  releaseAll() {
    for (const [key, held] of this.#sources) {
      if (held.size === 0) continue;
      held.clear();
      this.#state &= ~(1 << key);
      this.handler?.(1, key);
    }
    for (const [id, held] of this.#hostDown) {
      if (held.size === 0) continue;
      held.clear();
      this.onAction?.(id, false);
    }
    this.#dirs.clear();
    this.#moveKeys.clear();
    this.#keyHeading = NaN;
    this.#padDown.clear();
    this.#padActions.clear();
  }

  pollGamepads() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.#lastPoll) / 1000);
    this.#lastPoll = now;
    const cam = this.camera;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const down = new Set(); // phone keys held through the sticks
    const actions = new Set(); // actions held through buttons
    let name = null;
    let steering = false;
    let analogHeading = NaN;
    let analogSpeed = 1;
    let anyButton = -1;
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      name ??= pad.id;
      pad.buttons.forEach((b, index) => {
        if (!(b.pressed || b.value > 0.5)) return;
        if (anyButton < 0) anyButton = index;
        for (const a of this.#gamepad.get(index) ?? []) actions.add(a);
      });
    }
    if (name !== this.#padName) {
      this.#padName = name;
      this.onGamepadChange?.(name);
    }
    if (this.#capture) {
      // rebinding: wait for all buttons to be released, then take the next one pressed
      if (anyButton < 0) this.#capturePrimed = true;
      else if (this.#capturePrimed) {
        const done = this.#capture;
        this.#capture = null;
        done(anyButton);
      }
      return;
    }
    if (!this.#enabled) return;
    this.#syncMove();
    if (!Number.isNaN(this.#keyHeading)) {
      steering = true;
      analogHeading = this.#keyHeading;
    }
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const [x = 0, y = 0, rx = 0, ry = 0] = pad.axes;
      const following = !!cam && cam.following;
      // right stick: look around (free camera) during play, plain turning otherwise
      if (following) {
        const lx = Math.abs(rx) > LOOK_DEADZONE ? rx : 0;
        const ly = Math.abs(ry) > LOOK_DEADZONE ? ry : 0;
        if (lx || ly) cam.look(lx * LOOK_YAW_SPEED * dt, ly * LOOK_PITCH_SPEED * dt);
      } else {
        if (rx < -STICK_DEADZONE) down.add(KEY.LEFT);
        if (rx > STICK_DEADZONE) down.add(KEY.RIGHT);
      }
      // left stick: steer relative to the camera during play, d-pad otherwise
      const mag = Math.hypot(x, y);
      const lockedOn = (this.#state & (1 << LOCK_ON)) !== 0;
      const direct = this.analogMove && following && !lockedOn;
      if (direct && mag > ANALOG_DEADZONE) {
        steering = true;
        // stick up = away from the camera; screen-right is 90 degrees below the camera heading
        analogHeading = cam.worldYaw - (Math.atan2(x, -y) * 180) / Math.PI;
        analogSpeed = Math.min(1, Math.max(ANALOG_MIN_SPEED, (mag - ANALOG_DEADZONE) / (0.95 - ANALOG_DEADZONE)));
        down.add(KEY.UP);
      } else if (following && !this.analogMove && mag > STICK_DEADZONE) {
        steering = true;
        const want = cam.worldYaw - (Math.atan2(x, -y) * 180) / Math.PI;
        const delta = wrap180(want - cam.playerYaw);
        if (delta > AIM_TOLERANCE) down.add(KEY.LEFT);
        else if (delta < -AIM_TOLERANCE) down.add(KEY.RIGHT);
        if (Math.abs(delta) < WALK_CONE) down.add(KEY.UP);
      } else if (!following || (this.analogMove && lockedOn)) {
        if (x < -STICK_DEADZONE) down.add(KEY.LEFT);
        if (x > STICK_DEADZONE) down.add(KEY.RIGHT);
        if (y < -STICK_DEADZONE) down.add(KEY.UP);
        if (y > STICK_DEADZONE) down.add(KEY.DOWN);
      }
    }
    // while steering with the stick, the camera holds its heading instead of swinging behind
    cam?.setHoldWorld(steering);
    if (cam) {
      cam.analogHeading = analogHeading;
      cam.analogSpeed = analogSpeed;
    }
    for (const key of down) if (!this.#padDown.has(key)) this.press(key, 'stick');
    for (const key of this.#padDown) if (!down.has(key)) this.release(key, 'stick');
    this.#padDown = down;
    for (const a of actions) if (!this.#padActions.has(a)) this.#actionDown(a, 'pad');
    for (const a of this.#padActions) if (!actions.has(a)) this.#actionUp(a, 'pad');
    this.#padActions = actions;
    if (this.#rumbling) this.#pulse();
  }

  /** The phone's vibrator (PhoneSystem DEV_VIBRATOR), mapped to controller rumble. */
  vibrate(on) {
    this.#rumbling = !!on;
    if (on) {
      this.#lastPulse = 0;
      this.#pulse();
      navigator.vibrate?.(400);
    } else {
      for (const pad of navigator.getGamepads?.() ?? []) pad?.vibrationActuator?.reset?.();
      navigator.vibrate?.(0);
    }
  }

  #lastPulse = 0;

  #pulse() {
    const now = performance.now();
    if (now - this.#lastPulse < 150) return;
    this.#lastPulse = now;
    for (const pad of navigator.getGamepads?.() ?? []) {
      pad?.vibrationActuator?.playEffect?.('dual-rumble', {
        duration: 200, strongMagnitude: 0.7, weakMagnitude: 0.4,
      })?.catch?.(() => {});
    }
  }
}
