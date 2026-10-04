// Cheat state, read once per game frame by Mods.java (through rdash.Host).

const KEY = 'rdash.cheats';

// bit values match Mods.java
const INFINITE_LIFE = 1;
const INFINITE_ENERGY = 2;
const MAX_ZENNY = 4;
const REFILL = 8;

export class Cheats {
  infiniteLife = false;
  infiniteEnergy = false;
  /** Game speed multiplier: 1 (normal), 2 or 3. */
  speed = 1;
  #once = 0;

  constructor() {
    try {
      Object.assign(this, JSON.parse(localStorage.getItem(KEY) || '{}'));
    } catch {
      // ignore a corrupt setting
    }
    this.speed = [1, 2, 3].includes(this.speed) ? this.speed : 1;
  }

  save() {
    localStorage.setItem(KEY, JSON.stringify({
      infiniteLife: this.infiniteLife, infiniteEnergy: this.infiniteEnergy, speed: this.speed,
    }));
  }

  get active() {
    return this.infiniteLife || this.infiniteEnergy || this.speed !== 1;
  }

  maxZenny() {
    this.#once |= MAX_ZENNY;
  }

  refill() {
    this.#once |= REFILL;
  }

  /** Current flag set; one-shot actions are reported once. */
  flags() {
    const f = (this.infiniteLife ? INFINITE_LIFE : 0) | (this.infiniteEnergy ? INFINITE_ENERGY : 0) | this.#once;
    this.#once = 0;
    return f;
  }
}
