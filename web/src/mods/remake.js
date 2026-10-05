// Optional model replacement: draw remade models in place of the phone game's.
//
// The models are made from the phone game's own with the Tripo API (tools/ai/remake.py) and
// installed under web/public/remake/ by tools/ai/install_remake.py: one .glb per phone model
// and a manifest with, for each, the matrix that fits it to the phone model (same bounding box
// and facing, in phone model units). They are derived from the game, so that folder is
// git-ignored and never part of the repository; without it this module does nothing.
//
// The game reuses one model with several textures (one door model is every kind of door, and
// every enemy comes in three colours), so a phone model may have several remade ones, each for
// one texture file; the figure passes the texture it is drawn with. An entry may share
// another's .glb and only bring its own picture (`map`: a recolour made at install time).
//
// Flat panels (`flat` in the manifest: the doors) are drawn inside out, far side only. That is
// how the phone's door panel is drawn, and what hides it once it has slid open: a door stands
// in the plane of its wall, so the half of an open panel nearer the viewer would be in front
// of the wall, while its far side is behind the wall whichever room you stand in.
//
// Models that move in pieces. The phone's enemies, bosses and some objects are rigid pieces,
// each following one bone of an animation. A remade model is a single skin, so the install
// step works out which piece every vertex belongs to (`skin`: the bone whose surface is
// nearest, shared between two near a joint) and here each piece is moved by its phone bone:
// by `pose * rest^-1`, the bone's movement away from the pose the model was made in. That is
// ordinary skinning with the phone's bones, done by three.js in the vertex shader.
// Pieces that could not be seen when the model was made (`hidden`: a pilot under a closed
// hatch) have no counterpart in it; the phone's own triangles are drawn for those.
// A model without `skin` is rigid and simply drawn under the game's model matrix.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { makeLit, makeOutline, computeNormals, cel, isCharacter } from '../host/lighting.js';
import { keyOf } from '../host/contentkey.js';
import { FIGURE_LOCAL } from '../host/conventions.js';
import { frameClock } from '../host/frameclock.js';

const bytesOf = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const IDENTITY = new THREE.Matrix4();

/** One drawn copy of a model that moves in pieces: its own bones, shared geometry. */
class SkinnedCopy {
  constructor(variant) {
    this.root = new THREE.Group();
    this.root.matrixAutoUpdate = false;
    this.root.userData.local = variant.local;
    this.bones = Array.from({ length: variant.bones }, () => {
      const bone = new THREE.Bone();
      bone.matrixAutoUpdate = false;
      return bone;
    });
    const skeleton = new THREE.Skeleton(this.bones, this.bones.map(() => new THREE.Matrix4()));
    this.outlines = [];
    for (const { geometry, material } of variant.meshes) {
      const add = (m) => {
        const mesh = new THREE.SkinnedMesh(geometry, m);
        // the bones are given in phone model space, not placed in the scene
        mesh.bindMode = THREE.DetachedBindMode;
        mesh.bind(skeleton, variant.fit);
        mesh.frustumCulled = false;
        this.root.add(mesh);
        return mesh;
      };
      add(material);
      if (material.userData.outline) this.outlines.push(add(material.userData.outline));
    }
    // this game frame's pose and the previous one's, so in-between pictures can be shown
    this.now = this.bones.map(() => new THREE.Matrix4());
    this.before = this.bones.map(() => new THREE.Matrix4());
    this.frame = -2;
    this.root.userData.tween = (t) => {
      for (let i = 0; i < this.bones.length; i++) {
        const a = this.before[i].elements, b = this.now[i].elements, e = this.bones[i].matrixWorld.elements;
        for (let k = 0; k < 16; k++) e[k] = a[k] + (b[k] - a[k]) * t;
      }
    };
  }

  /**
   * @param {Float32Array} pose         the phone bones now: 3x4 row-major matrices, model space
   * @param {THREE.Matrix4[]} restInverse  the inverse of each bone's rest matrix
   */
  pose(pose, restInverse) {
    const continuous = this.frame === frameClock.frame - 1;
    this.frame = frameClock.frame;
    for (let i = 0; i < this.bones.length; i++) {
      if (continuous) this.before[i].copy(this.now[i]);
      const o = i * 12;
      if (o + 11 < pose.length && restInverse[i]) {
        this.now[i].set(
          pose[o], pose[o + 1], pose[o + 2], pose[o + 3],
          pose[o + 4], pose[o + 5], pose[o + 6], pose[o + 7],
          pose[o + 8], pose[o + 9], pose[o + 10], pose[o + 11],
          0, 0, 0, 1,
        ).multiply(restInverse[i]);
      } else this.now[i].copy(IDENTITY);
      if (!continuous) this.before[i].copy(this.now[i]);
    }
    for (const shell of this.outlines) shell.visible = cel.enabled;
    this.root.userData.tween(1);
  }
}

export class Remake {
  enabled = false;
  ready = false;
  /** content key of a phone model -> variants (see #variant) */
  models = new Map();
  /** Counters for diagnostics. */
  stats = { installed: 0, recognised: 0, drawn: 0, skinned: 0 };
  #loader = new GLTFLoader();
  #files = new Map(); // .glb URL -> Promise of the loaded file

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
    await Promise.all(Object.entries(manifest.models ?? {}).map(async ([file, entries]) => {
      const copies = findAll(file);
      if (!copies.length) return;
      const character = isCharacter(keyOf(copies[0])); // cel shading and an outline, like the phone model
      const variants = [];
      for (const info of Array.isArray(entries) ? entries : [entries]) {
        try {
          variants.push(await this.#variant(base, info, findAll, character));
          this.stats.installed++;
        } catch (e) {
          console.warn('[remake] could not load', info.url, e);
        }
      }
      if (variants.length) for (const bytes of copies) this.models.set(keyOf(bytes), variants);
    }));
    this.ready = this.models.size > 0;
    return this.ready;
  }

  /** One manifest entry, loaded: what stands in for a phone model drawn with a certain texture. */
  async #variant(base, info, findAll, character) {
    if (!this.#files.has(info.url)) this.#files.set(info.url, this.#loader.loadAsync(`${base}/${info.url}`));
    const gltf = await this.#files.get(info.url);
    gltf.scene.updateMatrixWorld(true);
    // its own picture on the shared model (a recolour), if it brings one
    let own = null;
    if (info.map) {
      own = await new THREE.TextureLoader().loadAsync(`${base}/${info.map}`);
      own.flipY = false; // as in a .glb
    }
    const prepare = (map) => {
      if (!map) return null;
      map.colorSpace = THREE.NoColorSpace; // colours pass through as they are
      map.anisotropy = 8;
      return map;
    };
    const fit = new THREE.Matrix4().fromArray(info.fit);
    const variant = {
      // the texture file this one stands for (any, if none is named)
      textures: info.texture ? new Set(findAll(info.texture).map(keyOf)) : null,
      // .glb space -> phone model units (the fit) -> world units, as for any figure
      local: new THREE.Matrix4().multiplyMatrices(FIGURE_LOCAL, fit),
      fit,
    };
    const material = (source) => {
      const map = prepare(own ?? source.map);
      // the game is unlit; "lighting" and "cel shading" come in through makeLit
      const m = makeLit(new THREE.MeshBasicMaterial({ map, side: info.flat ? THREE.BackSide : THREE.DoubleSide }),
        { character: character && !!info.skin });
      if (character && info.skin) {
        m.userData.outline = makeOutline(new THREE.MeshBasicMaterial({ color: 0x000000, map, side: THREE.DoubleSide }));
      }
      return m;
    };
    if (!info.skin) {
      // rigid: a copy of the scene with this variant's materials
      const scene = gltf.scene.clone(true);
      scene.traverse((o) => {
        if (!o.isMesh) return;
        o.frustumCulled = false;
        o.material = Array.isArray(o.material) ? o.material.map(material) : material(o.material);
      });
      scene.updateMatrixWorld(true);
      variant.scene = scene;
      return variant;
    }
    // moves in pieces: every mesh brought into the file's root space, with its vertices' bones
    variant.bones = info.bones;
    // phone pieces the remade model has nothing for (figure.js draws those itself)
    variant.hidden = info.hidden?.length ? new Set(info.hidden) : null;
    variant.meshes = [];
    let index = 0;
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const skin = info.skin[index++];
      if (!skin) return;
      const geometry = o.geometry.clone().applyMatrix4(o.matrixWorld);
      const count = geometry.attributes.position.count;
      const bones = bytesOf(skin.bones);
      const weights = bytesOf(skin.weights);
      const skinIndex = new Uint16Array(count * 4);
      const skinWeight = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        skinIndex[i * 4] = bones[i * 2];
        skinIndex[i * 4 + 1] = bones[i * 2 + 1];
        skinWeight[i * 4] = weights[i] / 255;
        skinWeight[i * 4 + 1] = 1 - weights[i] / 255;
      }
      geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
      geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
      // for cel shading: `normal` (hard edges kept) shades, `rdSmooth` widens the outline
      const { shading, smooth } = computeNormals(geometry);
      geometry.setAttribute('normal', shading);
      geometry.setAttribute('rdSmooth', smooth);
      variant.meshes.push({ geometry, material: material(Array.isArray(o.material) ? o.material[0] : o.material) });
    });
    return variant;
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

  /**
   * A drawable copy of a remade model (shares its geometry and materials).
   * @returns {THREE.Object3D & {userData: {copy?: SkinnedCopy}}} for a model that moves in
   *   pieces, `userData.copy.pose(...)` sets its pose before every draw
   */
  instance(variant) {
    if (variant.meshes) {
      const copy = new SkinnedCopy(variant);
      copy.root.userData.copy = copy;
      return copy.root;
    }
    const node = variant.scene.clone(true);
    node.matrixAutoUpdate = false;
    node.userData.local = variant.local;
    return node;
  }
}

/** The one instance shared by the figure loader and the page. */
export const remake = new Remake();
