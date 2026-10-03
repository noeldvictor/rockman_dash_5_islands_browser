// Character models (MBAC) and their animations (MTRA). Placeholder until the format module lands.

import { TYPE } from './g3d.js';

class Placeholder {
  constructor(type) {
    this.type = type;
    this.blendMode = 0;
    this.transparency = 100;
    this.numPatterns = 0;
    this.numActions = 0;
  }
  setTextureCount() {}
  setTextureAt() {}
  setAction() {}
  setTime() {}
  getMaxFrame() { return 0; }
  build() { return null; }
  dispose() {}
}

export function createFigure() {
  return new Placeholder(TYPE.FIGURE);
}

export function createActionTable() {
  return new Placeholder(TYPE.ACTION_TABLE);
}
