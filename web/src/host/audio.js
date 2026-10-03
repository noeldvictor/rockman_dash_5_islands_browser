// Sound (MFi / .mld). Silent stand-in: tracks play state so the game's listeners still fire.

export class Audio {
  /** Set by the game (rdash.Host): (port, event, param) => void */
  handler = null;
  ports = new Map();

  createSound(data, len) {
    return { bytes: new Uint8Array(data.buffer, data.byteOffset, len).slice() };
  }

  setSound(port, sound) {
    this.ports.set(port, { sound, attrs: {} });
  }

  play() {}

  stop() {}

  setAttribute() {}
}
