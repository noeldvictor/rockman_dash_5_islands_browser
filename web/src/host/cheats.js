// Cheat state, read once per game frame by Mods.java (through rdash.Host).

const KEY = 'rdash.cheats';

// bit values match Mods.java
const INFINITE_LIFE = 1;
const INFINITE_ENERGY = 2;
const MAX_ZENNY = 4;
const REFILL = 8;

/** Game speed while the fast-forward key is held. */
const FAST_FORWARD = 4;

export class Cheats {
  infiniteLife = false;
  infiniteEnergy = false;
  /** Chosen game speed multiplier: 1 (normal), 2 or 3. */
  baseSpeed = 1;
  /** True while the fast-forward key is held (dialogue, cutscenes, backtracking). */
  fastForward = false;
  #once = 0;

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
      this.infiniteLife = !!saved.infiniteLife;
      this.infiniteEnergy = !!saved.infiniteEnergy;
      this.baseSpeed = [1, 2, 3].includes(saved.speed) ? saved.speed : 1;
    } catch {
      // ignore a corrupt setting
    }
  }

  save() {
    localStorage.setItem(KEY, JSON.stringify({
      infiniteLife: this.infiniteLife, infiniteEnergy: this.infiniteEnergy, speed: this.baseSpeed,
    }));
  }

  /** Game speed multiplier in effect (read by Mods.java every frame). */
  get speed() {
    return this.fastForward ? Math.max(this.baseSpeed, FAST_FORWARD) : this.baseSpeed;
  }

  get active() {
    return this.infiniteLife || this.infiniteEnergy || this.baseSpeed !== 1;
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
