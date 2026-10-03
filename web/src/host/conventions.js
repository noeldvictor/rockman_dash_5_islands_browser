// Coordinate conventions of the DoJa 3D engine, kept in one place.
//
// The game's world is right-handed with y up. View space (what Transform.lookAt produces) is
// right-handed with x right, y down and +z into the screen.

import * as THREE from 'three';

/**
 * Model-space correction applied to map data (.d4d, an M3G scene: right-handed, y up) before the
 * game's model matrix. The game's world is y-up too, so none is needed.
 */
export const MODEL_FLIP = new THREE.Matrix4();

/**
 * World units per MBAC model unit. Models are stored in integers (the player is 186 units tall)
 * while map geometry and the game's float transforms use units where a room is 24-60 high.
 * ASSUMED from proportions (player shadow and marker quads are ~2 units wide); not yet confirmed
 * against the engine.
 */
export const FIGURE_SCALE = 1 / 64;

export const FIGURE_LOCAL = new THREE.Matrix4().makeScale(FIGURE_SCALE, FIGURE_SCALE, FIGURE_SCALE);
