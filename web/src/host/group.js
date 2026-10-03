// Map scenes (D4D). Placeholder until the format module lands.

import { TYPE } from './g3d.js';

class GroupPlaceholder {
  type = TYPE.GROUP;
  blendMode = 0;
  transparency = 100;
  add() {}
  removeAt() {}
  setTransform() {}
  setTime() {}
  build() { return null; }
  dispose() {}
}

export function createGroup() {
  return new GroupPlaceholder();
}
