// The settings menu: one overlay for video, audio, controls, cheats and extras. It edits the
// Settings store (settings.js) and the cheat state; the modules concerned react to the changes.
// The game is paused while it is open (main.js).

import { ACTIONS, defaultBindings, bindingName } from './input.js';

const TABS = [['video', 'Video'], ['audio', 'Audio'], ['controls', 'Controls'], ['cheats', 'Cheats'], ['extras', 'Extras']];

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node[k] = v;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};

export class SettingsMenu {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root            container element (inside the fullscreen element)
   * @param {import('./settings.js').Settings} o.settings
   * @param {import('./input.js').Input} o.input
   * @param {import('./cheats.js').Cheats} o.cheats
   * @param {() => void} o.onResetData      "Reset saved data" was confirmed
   * @param {(open: boolean) => void} o.onToggle
   */
  constructor({ root, settings, input, cheats, onResetData, onToggle }) {
    this.root = root;
    this.settings = settings;
    this.input = input;
    this.cheats = cheats;
    this.onResetData = onResetData;
    this.onToggle = onToggle;
    this.tab = 'video';
    this.padName = null;
    /** Rows that only apply when something optional is installed: id -> boolean */
    this.available = { legends2: false, remake: false, soundfont: false, texturePack: false, redrawPack: false };
    this.#listening = null;
    root.hidden = true;
    // keys typed in the menu never reach the game or the page shortcuts
    root.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && !this.#listening) this.close();
      if (e.code !== 'F1') e.stopPropagation();
    });
    root.addEventListener('keyup', (e) => e.stopPropagation());
    settings.on('*', () => { if (this.isOpen && !this.#rendering) this.#render(); });
  }

  #listening;
  #rendering = false;
  #navIndex = -1; // control highlighted by the controller, among #controls(); -1 = none yet

  /** Everything in the open tab a controller can move to, in reading order. */
  #navTargets() {
    return [...this.root.querySelectorAll('.body input, .body select, .body button')];
  }

  #highlight(index) {
    const targets = this.#navTargets();
    this.root.querySelector('.navfocus')?.classList.remove('navfocus');
    if (!targets.length) {
      this.#navIndex = -1;
      return null;
    }
    this.#navIndex = Math.max(0, Math.min(targets.length - 1, index));
    const target = targets[this.#navIndex];
    target.classList.add('navfocus');
    target.scrollIntoView({ block: 'nearest' });
    return target;
  }

  /**
   * Controller navigation (see Input.onMenuNav): up/down move between controls, left/right
   * change a slider or a list (and otherwise move too), accept presses or toggles, prev/next
   * switch tabs, back closes.
   */
  nav(command) {
    if (!this.isOpen) return;
    if (command === 'back') {
      if (this.#listening) this.#render();
      else this.close();
      return;
    }
    if (this.#listening) return; // waiting for a key or button to bind
    if (command === 'prev' || command === 'next') {
      const i = TABS.findIndex(([id]) => id === this.tab);
      this.tab = TABS[(i + (command === 'next' ? 1 : TABS.length - 1)) % TABS.length][0];
      this.#navIndex = 0;
      this.#render();
      return;
    }
    const targets = this.#navTargets();
    const target = targets[this.#navIndex];
    if (!target) {
      this.#highlight(0);
      return;
    }
    const step = command === 'down' || command === 'right' ? 1 : -1;
    if (command === 'up' || command === 'down') {
      this.#highlight(this.#navIndex + step);
    } else if (command === 'left' || command === 'right') {
      if (target.type === 'range') {
        if (step > 0) target.stepUp();
        else target.stepDown();
        target.dispatchEvent(new Event('input'));
      } else if (target.tagName === 'SELECT') {
        const next = target.selectedIndex + step;
        if (next < 0 || next >= target.options.length) return;
        target.selectedIndex = next;
        target.dispatchEvent(new Event('change'));
      } else this.#highlight(this.#navIndex + step);
    } else if (command === 'accept') {
      if (target.tagName === 'SELECT') {
        target.selectedIndex = (target.selectedIndex + 1) % target.options.length;
        target.dispatchEvent(new Event('change'));
      } else if (target.type !== 'range') target.click();
    }
  }

  get isOpen() {
    return !this.root.hidden;
  }

  open(tab) {
    if (tab) this.tab = tab;
    const was = this.isOpen;
    this.root.hidden = false;
    this.#render();
    if (!was) this.onToggle?.(true);
  }

  close() {
    if (!this.isOpen) return;
    this.#stopListening();
    this.#navIndex = -1;
    this.root.hidden = true;
    this.onToggle?.(false);
  }

  toggle(tab) {
    if (this.isOpen && (!tab || tab === this.tab)) this.close();
    else this.open(tab);
  }

  setPadName(name) {
    this.padName = name;
    if (this.isOpen && this.tab === 'controls') this.#render();
  }

  // ---- widgets -----------------------------------------------------------------------------

  #row(label, control, hint) {
    return el('label', { class: 'row' }, el('span', { class: 'name' }, label), control,
      hint ? el('small', {}, hint) : null);
  }

  #check(key, label, hint) {
    const s = this.settings;
    return this.#row(label, el('input', {
      type: 'checkbox', checked: !!s.get(key), onchange: (e) => s.set(key, e.target.checked),
    }), hint);
  }

  #select(key, label, options, hint) {
    const s = this.settings;
    const current = String(s.get(key));
    const select = el('select', {
      onchange: (e) => {
        const chosen = options.find(([v]) => String(v) === e.target.value);
        s.set(key, chosen[0]);
      },
    }, ...options.map(([v, text]) => el('option', { value: String(v), selected: String(v) === current }, text)));
    return this.#row(label, select, hint);
  }

  /** `scale`: slider units per setting unit (100 = the setting is a 0..1 fraction shown as %). */
  #slider(key, label, { min = 0, max = 100, step = 5, unit = '%', scale = 100 } = {}, hint) {
    const s = this.settings;
    const value = el('span', { class: 'value' }, `${Math.round(s.get(key) * scale)}${unit}`);
    const range = el('input', {
      type: 'range', min: String(min), max: String(max), step: String(step), value: String(Math.round(s.get(key) * scale)),
      oninput: (e) => {
        // no re-render while dragging: it would replace the slider under the pointer
        this.#rendering = true;
        s.set(key, Number(e.target.value) / scale);
        this.#rendering = false;
        value.textContent = `${e.target.value}${unit}`;
      },
    });
    return this.#row(label, el('span', { class: 'slider' }, range, value), hint);
  }

  // ---- tabs --------------------------------------------------------------------------------

  #video() {
    return [
      this.#check('wide', 'Widescreen', 'Fill the window instead of the phone\'s square screen (F3)'),
      this.#check('sideFill', 'Blurred side bars',
        'In widescreen, fill the bars beside the title and menus with a blurred copy of the picture'),
      this.#select('resolution', 'Resolution', [
        ['auto', 'Auto (fit the window)'], [1, '240p (original)'], [2, '480p'], [3, '720p'], [4, '960p'],
        [6, '1440p'], [8, '1920p'],
      ], 'F2 switches between Auto and original'),
      this.#select('textureFilter', 'Textures', [
        ['sharp', 'Sharp pixels (original)'], ['smooth', 'Smooth'], ['hd', 'HD (upscaled 4×, smooth)'],
        ...(this.available.texturePack ? [['ai', 'AI upscaled 4×']] : []),
        ...(this.available.redrawPack ? [['redraw', 'AI redrawn']] : []),
      ], this.available.texturePack ? 'AI upscaled uses the texture pack made on your image server'
        : 'Smooth and HD also use anisotropic filtering'),
      this.#slider('fov', 'Field of view', { min: 45, max: 100, step: 5, unit: '°', scale: 1 }),
      this.#select('drawDistance', 'Draw distance', [
        [1, 'Original'], [1.5, '1.5x'], [2, '2x'], [3, '3x'], [4, '4x'],
      ], 'How far away enemies and objects appear during missions'),
      this.#select('frameRate', 'Frame rate', [
        [15, '15 fps (original)'], [30, '30 fps'], [60, '60 fps'], [0, 'Display rate'],
      ], 'Above 15, in-between pictures are interpolated; the game itself still steps 15 times a second'),
      this.#check('lighting', 'Lighting', 'Shade models and scenery; the original is unlit'),
      this.#check('celShading', 'Cel shading', 'Two-tone shading and outlines on characters'),
      this.#check('shadows', 'Shadows', 'Drop a shadow under characters'),
    ];
  }

  #audio() {
    return [
      this.#check('muted', 'Mute', 'M'),
      this.#slider('musicVolume', 'Music'),
      this.#slider('effectsVolume', 'Sound effects'),
      this.available.soundfont
        ? this.#select('instruments', 'Music instruments', [['sampled', 'Sampled'], ['fm', 'Synthesised (FM)']],
          'Sampled plays recorded instruments; FM is the simpler built-in synthesis')
        : el('p', { class: 'note' }, 'Sampled instruments are not installed (see tools/soundfont/); music uses the built-in FM synthesis.'),
    ];
  }

  #bindings(device) {
    return { ...defaultBindings(device), ...(this.settings.get(device) ?? {}) };
  }

  #setBinding(device, action, values) {
    this.settings.set(device, { ...this.#bindings(device), [action]: values });
  }

  #stopListening() {
    if (!this.#listening) return;
    this.#listening.cancel();
    this.#listening = null;
  }

  /** Wait for a key or a controller button and add it to the action's bindings. */
  #listen(device, action, button) {
    this.#stopListening();
    button.textContent = device === 'keyboard' ? 'Press a key…' : 'Press a button…';
    button.classList.add('listening');
    const add = (value) => {
      this.#listening = null;
      const list = this.#bindings(device)[action];
      this.#setBinding(device, action, list.includes(value) ? list : [...list, value]);
      this.#render();
    };
    if (device === 'keyboard') {
      const onKey = (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.removeEventListener('keydown', onKey, true);
        if (e.code === 'Escape') {
          this.#listening = null;
          this.#render();
        } else add(e.code);
      };
      window.addEventListener('keydown', onKey, true);
      this.#listening = { cancel: () => window.removeEventListener('keydown', onKey, true) };
    } else {
      this.input.captureButton(add);
      this.#listening = { cancel: () => this.input.captureButton(null) };
    }
  }

  #bindingCell(device, action) {
    const list = this.#bindings(device)[action.id];
    const chips = list.map((value) => el('span', { class: 'chip' }, bindingName(device, value),
      el('button', {
        class: 'x', title: 'Remove', type: 'button',
        onclick: () => this.#setBinding(device, action.id, list.filter((v) => v !== value)),
      }, '×')));
    const add = el('button', { class: 'add', type: 'button', title: 'Add a binding' }, '+');
    add.addEventListener('click', () => this.#listen(device, action.id, add));
    return el('td', {}, ...chips, add);
  }

  #controls() {
    const rows = ACTIONS.map((a) => el('tr', {}, el('td', {}, a.label),
      this.#bindingCell('keyboard', a), this.#bindingCell('gamepad', a)));
    return [
      el('p', { class: `pad ${this.padName ? 'on' : ''}` }, this.padName
        ? `Controller: ${this.padName.replace(/\s*\(.*$/, '')}`
        : 'No controller detected (press a button on it)'),
      this.#check('directStick', 'Dual-stick movement',
        'The left stick moves the way you push it, relative to the camera, and the right stick looks around; off = the game\'s tank controls'),
      this.#check('directKeys', 'Camera-relative keys',
        'The movement keys move relative to the camera too; best together with capturing the mouse'),
      this.#check('mouseLook', 'Capture the mouse',
        'Click the game to look with the mouse: left button buster, right button lock-on, Esc releases. Off = drag to look'),
      this.#slider('lookSensitivity', 'Look sensitivity', { min: 25, max: 250, step: 25 }),
      this.#check('invertY', 'Invert vertical look'),
      this.#slider('cameraDistance', 'Camera distance', { min: 60, max: 200, step: 10 }),
      el('table', { class: 'binds' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Action'), el('th', {}, 'Keyboard'), el('th', {}, 'Controller'))),
        el('tbody', {}, ...rows)),
      el('p', { class: 'note' }, 'Left stick: move. Right stick or mouse drag on the game: look around. '
        + 'The phone keypad is on 0-9, - and =.'),
      el('div', { class: 'buttons' },
        el('button', { type: 'button', onclick: () => this.settings.set('keyboard', null) }, 'Reset keyboard'),
        el('button', { type: 'button', onclick: () => this.settings.set('gamepad', null) }, 'Reset controller')),
    ];
  }

  #cheats() {
    const c = this.cheats;
    const changed = () => { c.save(); this.#render(); this.onCheats?.(); };
    const speed = el('select', { onchange: (e) => { c.baseSpeed = Number(e.target.value); changed(); } },
      ...[[1, '1× (normal)'], [2, '2×'], [3, '3×']].map(([v, text]) => el('option',
        { value: String(v), selected: c.baseSpeed === v }, text)));
    return [
      this.#row('Infinite life', el('input', {
        type: 'checkbox', checked: c.infiniteLife, onchange: (e) => { c.infiniteLife = e.target.checked; changed(); },
      })),
      this.#row('Infinite special weapon energy', el('input', {
        type: 'checkbox', checked: c.infiniteEnergy, onchange: (e) => { c.infiniteEnergy = e.target.checked; changed(); },
      })),
      this.#row('One-hit kills', el('input', {
        type: 'checkbox', checked: c.oneHitKill, onchange: (e) => { c.oneHitKill = e.target.checked; changed(); },
      }), 'Any hit you land on an enemy, boss or not, finishes it'),
      this.#row('Game speed', speed),
      el('div', { class: 'buttons' },
        el('button', { type: 'button', onclick: () => c.refill() }, 'Refill life and energy'),
        el('button', { type: 'button', onclick: () => c.maxZenny() }, 'Max zenny')),
      el('p', { class: 'note' }, 'Refill and max zenny take effect when the game resumes.'),
    ];
  }

  #extras() {
    return [
      this.available.legends2
        ? this.#check('legends2', 'Legends 2 character models', 'Draw characters with the installed Mega Man Legends 2 models')
        : el('p', { class: 'note' }, 'Legends 2 character models are not installed (see tools/mml2/).'),
      this.#select('roomy', 'Roomier areas (experiment)', [
        [1, 'Off'], [1.25, '1.25× wider'], [1.5, '1.5× wider'],
      ], 'Test only: the path to the first ruin on island 1. Takes effect when the area loads'),
      ...(this.available.remake
        ? [this.#check('remake', 'Remade models', 'Draw the AI-remade models that are installed in place of the phone models')]
        : []),
      el('div', { class: 'buttons' },
        el('button', { type: 'button', onclick: () => this.onExportSave?.() }, 'Export save file'),
        el('button', { type: 'button', onclick: () => this.onImportSave?.() }, 'Import save file…')),
      el('p', { class: 'note' }, 'Saves are kept in this browser only. Export one to back it up or move it '
        + 'to another computer; importing replaces what is saved here and restarts the game.'),
      el('div', { class: 'buttons' },
        el('button', { type: 'button', onclick: () => this.settings.resetAll() }, 'Restore default settings'),
        el('button', {
          type: 'button',
          class: 'danger',
          onclick: () => {
            if (confirm('Delete all saved progress for this game in this browser?')) this.onResetData?.();
          },
        }, 'Reset saved data')),
    ];
  }

  #render() {
    this.#stopListening();
    const body = { video: () => this.#video(), audio: () => this.#audio(), controls: () => this.#controls(),
      cheats: () => this.#cheats(), extras: () => this.#extras() }[this.tab]();
    const tabs = TABS.map(([id, label]) => el('button', {
      type: 'button', class: id === this.tab ? 'tab on' : 'tab', onclick: () => { this.tab = id; this.#render(); },
    }, label));
    this.root.replaceChildren(el('div', { class: 'panel', tabIndex: -1 },
      el('div', { class: 'tabs' }, ...tabs,
        el('button', { type: 'button', class: 'close', title: 'Close (Esc)', onclick: () => this.close() }, '×')),
      el('div', { class: `body ${this.tab}` }, ...body),
      el('div', { class: 'foot' }, 'The game is paused while this menu is open. F1 or Esc closes it. '
        + 'Controller: D-pad or stick to move and change, A to select, L1 / R1 for tabs, B to close.')));
    this.root.querySelector('.panel').focus();
    if (this.#navIndex >= 0) this.#highlight(this.#navIndex); // keep the controller's place
  }
}
