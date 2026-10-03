// Keypad emulation. DoJa reports keys as bit positions in Canvas.getKeypadState() and as
// KEY_PRESSED_EVENT(0)/KEY_RELEASED_EVENT(1) through Canvas.processEvent().

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

// KeyboardEvent.code -> phone key
const KEYBOARD = {
  ArrowLeft: KEY.LEFT, ArrowUp: KEY.UP, ArrowRight: KEY.RIGHT, ArrowDown: KEY.DOWN,
  KeyA: KEY.LEFT, KeyW: KEY.UP, KeyD: KEY.RIGHT, KeyS: KEY.DOWN,
  Enter: KEY.SELECT, NumpadEnter: KEY.SELECT,
  Space: JUMP, KeyX: JUMP,
  KeyZ: BUSTER, KeyJ: BUSTER,
  KeyC: SPECIAL, KeyK: SPECIAL,
  ShiftLeft: LOCK_ON, ShiftRight: LOCK_ON, KeyV: LOCK_ON, KeyL: LOCK_ON,
  KeyQ: KEY.SOFT1, Backspace: KEY.SOFT1, KeyE: KEY.SOFT2, Escape: KEY.SOFT2,
  Digit0: KEY.NUM0, Digit1: KEY.NUM1, Digit2: KEY.NUM2, Digit3: KEY.NUM3, Digit4: KEY.NUM4,
  Digit5: KEY.NUM5, Digit6: KEY.NUM6, Digit7: KEY.NUM7, Digit8: KEY.NUM8, Digit9: KEY.NUM9,
  Numpad0: KEY.NUM0, Numpad1: KEY.NUM1, Numpad2: KEY.NUM2, Numpad3: KEY.NUM3, Numpad4: KEY.NUM4,
  Numpad5: KEY.NUM5, Numpad6: KEY.NUM6, Numpad7: KEY.NUM7, Numpad8: KEY.NUM8, Numpad9: KEY.NUM9,
  NumpadMultiply: KEY.ASTERISK, NumpadDivide: KEY.POUND, Minus: KEY.ASTERISK, Equal: KEY.POUND,
};

// Standard-mapping gamepad button index -> phone key
const GAMEPAD = {
  12: KEY.UP, 13: KEY.DOWN, 14: KEY.LEFT, 15: KEY.RIGHT,
  0: JUMP, 2: BUSTER, 3: SPECIAL, 5: LOCK_ON, 7: LOCK_ON,
  1: KEY.SELECT, 9: KEY.SELECT, 4: KEY.SOFT1, 8: KEY.SOFT2,
};

export class Input {
  /** Set by the game (rdash.Host): (type, key) => void */
  handler = null;
  #state = 0;
  #sources = new Map(); // key -> Set of source ids holding it down
  #padDown = new Set();

  constructor(target = window) {
    target.addEventListener('keydown', (e) => {
      const k = KEYBOARD[e.code];
      if (k === undefined || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      if (!e.repeat) this.press(k, `kb:${e.code}`);
    });
    target.addEventListener('keyup', (e) => {
      const k = KEYBOARD[e.code];
      if (k === undefined) return;
      e.preventDefault();
      this.release(k, `kb:${e.code}`);
    });
    target.addEventListener('blur', () => this.releaseAll());
  }

  state() {
    return this.#state;
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
    this.#padDown.clear();
  }

  /** Call once per frame. */
  pollGamepads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const down = new Set();
    for (const pad of pads) {
      if (!pad) continue;
      for (const [index, key] of Object.entries(GAMEPAD)) {
        if (pad.buttons[index]?.pressed) down.add(key);
      }
      const [x = 0, y = 0] = pad.axes;
      if (x < -0.5) down.add(KEY.LEFT);
      if (x > 0.5) down.add(KEY.RIGHT);
      if (y < -0.5) down.add(KEY.UP);
      if (y > 0.5) down.add(KEY.DOWN);
    }
    for (const key of down) if (!this.#padDown.has(key)) this.press(key, 'pad');
    for (const key of this.#padDown) if (!down.has(key)) this.release(key, 'pad');
    this.#padDown = down;
  }
}
