// Coordinate conventions of the DoJa 3D engine, kept in one place.

import * as THREE from 'three';

/**
 * Model-space correction applied to map data (.d4d, an M3G scene: right-handed, y up) before the
 * game's model matrix. The game's world is y-up too, so none is needed.
 */
export const MODEL_FLIP = new THREE.Matrix4();
