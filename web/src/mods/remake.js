// Optional model replacement: draw remade models in place of the phone game's.
//
// The models are made from the phone game's own with the Tripo API (tools/ai/remake.py) and
// installed under web/public/remake/ by tools/ai/install_remake.py: one .glb per phone model
// and a manifest with, for each, the matrix that fits it to the phone model (same bounding box
// and facing, in phone model units). They are derived from the game, so that folder is
// git-ignored and never part of the repository; without it this module does nothing.
//
// The game reuses one model with several textures (one door model is every kind of door), so a
// phone model may have several remade ones, each for one texture file; the figure passes the
// texture it is drawn with.
//
// Only rigid models so far: a figure whose phone model has a single bone is drawn as the remade
// model under the same model matrix (figure.js asks instance()). Models that bend follow the
// phone animation bone by bone and are not handled here yet.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { makeLit } from '../host/lighting.js';
import { keyOf } from '../host/contentkey.js';
import { FIGURE_LOCAL } from '../host/conventions.js';

export class Remake {
  enabled = false;
  ready = false;
  /** content key of a phone model -> variants: { textures: Set<key>|null, scene, local: Matrix4 }[] */
  models = new Map();
  /** Counters for diagnostics. */
  stats = { installed: 0, recognised: 0, drawn: 0 };

  /**
   * @param {string} base  URL of the installed folder
   * @param {(name: string) => Uint8Array[]} findAll  every copy of a phone game data file
   * @returns {Promise<boolean>} whether any remade model is installed
   */
  async load(base, findAll) {
    let manifest;
    try {
      const r = await fetch(`${base}/manifest.json`);
      if (!r.ok) return false;
      manifest = await r.json();
    } catch {
      return false;
    }
    const loader = new GLTFLoader();
    await Promise.all(Object.entries(manifest.models ?? {}).map(async ([file, entries]) => {
      const copies = findAll(file);
      if (!copies.length) return;
      const variants = [];
      for (const info of Array.isArray(entries) ? entries : [entries]) {
        let gltf;
        try {
          gltf = await loader.loadAsync(`${base}/${info.url}`);
        } catch (e) {
          console.warn('[remake] could not load', info.url, e);
          continue;
        }
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          o.frustumCulled = false;
          const convert = (mat) => {
            if (mat.map) {
              mat.map.colorSpace = THREE.NoColorSpace; // colours pass through as they are
              mat.map.anisotropy = 8;
            }
            // the game is unlit; the "lighting" option shades scenery through makeLit
            return makeLit(new THREE.MeshBasicMaterial({ map: mat.map, side: THREE.DoubleSide }));
          };
          o.material = Array.isArray(o.material) ? o.material.map(convert) : convert(o.material);
        });
        gltf.scene.updateMatrixWorld(true);
        variants.push({
          // the texture file this one stands for (any, if none is named)
          textures: info.texture ? new Set(findAll(info.texture).map(keyOf)) : null,
          scene: gltf.scene,
          // .glb space -> phone model units (the fit) -> world units, as for any figure
          local: new THREE.Matrix4().multiplyMatrices(FIGURE_LOCAL, new THREE.Matrix4().fromArray(info.fit)),
        });
        this.stats.installed++;
      }
      if (variants.length) for (const bytes of copies) this.models.set(keyOf(bytes), variants);
    }));
    this.ready = this.models.size > 0;
    return this.ready;
  }

  get active() {
    return this.enabled && this.ready;
  }

  /** The remade models (one per texture) for a phone model's bytes, if any are installed. */
  find(bytes) {
    const variants = this.models.get(keyOf(bytes));
    if (variants) this.stats.recognised++;
    return variants;
  }

  /** Of a phone model's remade ones, the one for the texture it is drawn with (or undefined). */
  pick(variants, textureKey) {
    return variants.find((v) => v.textures === null || v.textures.has(textureKey));
  }

  /** A drawable copy of a remade model (shares its geometry and materials). */
  instance(model) {
    const node = model.scene.clone(true);
    node.matrixAutoUpdate = false;
    node.userData.local = model.local;
    return node;
  }
}

/** The one instance shared by the figure loader and the page. */
export const remake = new Remake();
