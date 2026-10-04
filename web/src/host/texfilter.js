// Texture filtering for everything drawn in 3D: 'sharp' (nearest, like the phone) or 'smooth'
// (bilinear with mipmaps). Textures register here when created so the setting can be changed
// while the game runs.

import * as THREE from 'three';

const textures = new Set();
let smooth = false;

function apply(t) {
  t.magFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter;
  t.minFilter = smooth ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter;
  t.generateMipmaps = smooth;
  t.needsUpdate = true;
}

/** Give a newly created texture the current filtering and keep it in sync with the setting. */
export function registerTexture(t) {
  textures.add(t);
  t.addEventListener('dispose', () => textures.delete(t));
  apply(t);
  return t;
}

export function setSmoothTextures(on) {
  if (smooth === !!on) return;
  smooth = !!on;
  for (const t of textures) apply(t);
}
