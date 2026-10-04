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
    this.available = { legends2: false };
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

  #slider(key, label) {
    const s = this.settings;
    const value = el('span', { class: 'value' }, `${Math.round(s.get(key) * 100)}%`);
    const range = el('input', {
      type: 'range', min: '0', max: '100', step: '5', value: String(Math.round(s.get(key) * 100)),
      oninput: (e) => {
        // no re-render while dragging: it would replace the slider under the pointer
        this.#rendering = true;
        s.set(key, Number(e.target.value) / 100);
        this.#rendering = false;
        value.textContent = `${e.target.value}%`;
      },
    });
    return this.#row(label, el('span', { class: 'slider' }, range, value));
  }

  // ---- tabs --------------------------------------------------------------------------------

  #video() {
    return [
      this.#check('wide', 'Widescreen', 'Fill the window instead of the phone\'s square screen (F3)'),
      this.#select('resolution', 'Resolution', [
        ['auto', 'Auto (fit the window)'], [1, '240p (original)'], [2, '480p'], [3, '720p'], [4, '960p'],
        [6, '1440p'], [8, '1920p'],
      ], 'F2 switches between Auto and original'),
      this.#select('textureFilter', 'Textures', [['sharp', 'Sharp pixels'], ['smooth', 'Smooth']]),
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
      this.#check('analogMove', 'Direct stick movement',
        'The left stick moves in the direction you push, at the speed you push; off = the game\'s tank controls'),
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
      el('div', { class: 'foot' }, 'The game is paused while this menu is open. F1 or Esc closes it.')));
    this.root.querySelector('.panel').focus();
  }
}
