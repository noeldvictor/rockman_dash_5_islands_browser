// Free-look camera state.
//
// The game's own camera is rigidly fixed behind the player. During normal gameplay the camera
// override on the Java side (runtime/src/main/java/ax.java, driven by Mods.java) swings it around
// the player by the yaw/pitch offsets kept here, and reports the player's heading each frame so
// the left stick can steer relative to the camera (see Input).

const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

export class FreeCamera {
  /** Offsets in degrees from the game's follow camera (read by rdash.Host.cameraYaw/Pitch). */
  yaw = 0;
  pitch = 0;
  /** Player heading in degrees (atan2 of the forward vector's x and z), from the game. */
  playerYaw = 0;
  /** during play: the game's Select key would open, examine or continue something */
  interact = false;
  /** While true the camera keeps its world heading when the player turns. */
  holdWorld = false;
  /**
   * Direct stick movement (read by Mods.java): the world heading the left stick points at, NaN
   * when not in use, and the walking speed as a fraction of the game's.
   */
  analogHeading = NaN;
  analogSpeed = 1;
  /** Settings > Controls: look speed factor, and whether pushing up looks down. */
  sensitivity = 1;
  invertY = false;
  #distance = 1;

  /** Factor on the follow camera's distance from the player (read by ax.java). */
  get distance() {
    return this.#distance;
  }

  set distance(value) {
    this.#distance = value;
    this.#changed = true;
  }

  /** Look input from a stick or the mouse, with the user's sensitivity and inversion applied. */
  look(dYaw, dPitch) {
    this.rotate(dYaw * this.sensitivity, dPitch * this.sensitivity * (this.invertY ? -1 : 1));
  }
  #world = 0;
  #lastReport = -1e9;
  #changed = false;

  /** True once after the offsets changed (the game is then asked to rebuild its camera). */
  consumeChanged() {
    const c = this.#changed;
    this.#changed = false;
    return c;
  }

  /** True while the game's follow camera is on screen (not in cutscenes, menus or the map). */
  get following() {
    return performance.now() - this.#lastReport < 250;
  }

  /** Camera heading in world space. */
  get worldYaw() {
    return this.holdWorld ? this.#world : this.playerYaw + this.yaw;
  }

  /** Called by the game every frame it builds its camera. */
  report(follow, playerYaw, interact = false) {
    if (!follow) return;
    this.#lastReport = performance.now();
    this.interact = !!interact;
    this.playerYaw = playerYaw;
    if (this.holdWorld) {
      const yaw = wrap180(this.#world - playerYaw);
      if (yaw !== this.yaw) this.#changed = true;
      this.yaw = yaw;
    } else {
      this.#world = playerYaw + this.yaw;
    }
  }

  setHoldWorld(hold) {
    if (hold && !this.holdWorld) this.#world = this.playerYaw + this.yaw;
    this.holdWorld = hold;
  }

  /** @param {number} dYaw degrees to turn the view right  @param {number} dPitch degrees to tilt it down */
  rotate(dYaw, dPitch) {
    // turning the view right lowers the heading angle
    if (this.holdWorld) {
      this.#world -= dYaw;
      this.yaw = wrap180(this.#world - this.playerYaw);
    } else {
      this.yaw = wrap180(this.yaw - dYaw);
    }
    this.pitch = Math.max(-45, Math.min(70, this.pitch + dPitch));
    this.#changed = true;
  }

  /** Save states (savestate.js): the offsets belong to the picture the game had built. */
  snapshot() {
    return { yaw: this.yaw, pitch: this.pitch, playerYaw: this.playerYaw, world: this.#world, holdWorld: this.holdWorld };
  }

  restore(saved) {
    this.yaw = saved.yaw;
    this.pitch = saved.pitch;
    this.playerYaw = saved.playerYaw;
    this.#world = saved.world;
    this.holdWorld = saved.holdWorld;
    this.#changed = true;
  }

  recenter() {
    this.yaw = 0;
    this.pitch = 0;
    this.#world = this.playerYaw;
    this.#changed = true;
  }
}

export { wrap180 };
