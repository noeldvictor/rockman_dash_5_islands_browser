// Optional model replacement: draw Mega Man Legends 2's character models in place of the phone
// game's, driven by the phone game's own animation.
//
// The Legends 2 models are not part of this repo: they are extracted from the user's own disc
// image by tools/mml2/ and installed under web/public/mml2/ (git-ignored). If that folder is
// absent this module does nothing.
//
// How it works. Both games use rigid humanoid rigs. For every phone bone the pose is taken as a
// model-space rotation away from the phone rig's rest pose, R_pose * R_rest^-1. Applying that to
// the matching Legends 2 bone only needs the two rest poses lined up first: an alignment rotation
// per bone turns the Legends 2 bone's rest direction (towards its child) onto the phone bone's.
// The body position follows the phone body bone's displacement from rest.
//
// The phone game draws its player as separate figures (legs, chest with the buster arm, head or
// helmet, right arm or special weapon), so parts drawn with the same model matrix in one batch
// are collected into one character. Cutscene characters are single figures.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { registerTexture } from '../host/texfilter.js';
import { makeLit, makeOutline, computeNormals, cel } from '../host/lighting.js';
import { keyOf } from '../host/contentkey.js';

// Bone tables: [phone bone index, Legends 2 bone name, alignment]
//   alignment omitted        rest poses already agree (trunk, legs, arms hanging down)
//   [phoneChild, l2Child]    align the bone's direction towards that child in both rigs
//   'parent'                 reuse the alignment of the previous entry (hands, feet)
// +x is the character's left in both games.

/** The player during play, split over several phone figures. */
const PLAYER_PARTS = {
  leg: [[1, 'hip'], [2, 'thigh_l'], [3, 'shin_l'], [4, 'foot_l'], [5, 'thigh_r'], [6, 'shin_r'], [7, 'foot_r']],
  chest: [[1, 'body'], [2, 'shoulder_l'], [3, 'arm_l']],
  arm: [[1, 'shoulder_r'], [2, 'arm_r']],
  weapon: [[1, 'shoulder_r'], [2, 'arm_r']],
  head: [[1, 'head']],
  helm: [[1, 'head']],
};
const PLAYER_FILES = {
  'r_leg.mbac': 'leg', 'r_leg_roller.mbac': 'leg', 'r_chest.mbac': 'chest', 'r_head.mbac': 'head',
  'r_helm.mbac': 'helm', 'r_arm.mbac': 'arm', 'r_arm_blade.mbac': 'weapon',
  'r_arm_cannon.mbac': 'weapon', 'r_arm_drill.mbac': 'weapon', 'r_arm_grenade.mbac': 'weapon',
  'r_arm_gun.mbac': 'weapon', 'r_arm_laser.mbac': 'weapon', 'r_arm_missile.mbac': 'weapon',
  'r_arm_spread.mbac': 'weapon',
};

/** Whole characters drawn as one phone figure (cutscenes, town). */
const CHARACTERS = {
  'rock.mba': {
    model: 'megaman_nohelmet',
    body: 2,
    // bones 5 and 6 are alternative left forearms (buster / hand); the animation scales the one
    // not in use to nothing, so the forearm follows whichever is shown
    forearm: { buster: 5, hand: 6 },
    bones: [
      [1, 'hip'], [2, 'body'], [3, 'head'],
      [4, 'shoulder_l'], [6, 'arm_l'], [7, 'shoulder_r'], [8, 'arm_r'], [9, 'hand_r'],
      [10, 'thigh_r'], [11, 'shin_r'], [12, 'foot_r'], [13, 'thigh_l'], [14, 'shin_l'], [15, 'foot_l'],
    ],
  },
  'roll.mba': {
    model: 'roll',
    body: 3,
    bones: [
      [1, 'hip'], [3, 'body'], [4, 'head'],
      [5, 'shoulder_l', [6, 'arm_l']], [6, 'arm_l', [7, 'hand_l']], [7, 'hand_l', 'parent'],
      [8, 'shoulder_r', [9, 'arm_r']], [9, 'arm_r', [10, 'hand_r']], [10, 'hand_r', 'parent'],
      [14, 'thigh_l', [15, 'shin_l']], [15, 'shin_l', [16, 'foot_l']], [16, 'foot_l', 'parent'],
      [18, 'thigh_r', [19, 'shin_r']], [19, 'shin_r', [20, 'foot_r']], [20, 'foot_r', 'parent'],
    ],
  },
  'toron.mba': {
    model: 'tron',
    body: 11,
    bones: [
      [1, 'hip'], [11, 'body'], [13, 'head'],
      [19, 'shoulder_l', [20, 'arm_l']], [20, 'arm_l', [21, 'hand_l']], [21, 'hand_l', 'parent'],
      [14, 'shoulder_r', [15, 'arm_r']], [15, 'arm_r', [16, 'hand_r']], [16, 'hand_r', 'parent'],
      [3, 'thigh_l', [4, 'shin_l']], [4, 'shin_l', [5, 'foot_l']], [5, 'foot_l', 'parent'],
      [7, 'thigh_r', [8, 'shin_r']], [8, 'shin_r', [9, 'foot_r']], [9, 'foot_r', 'parent'],
    ],
  },
  'tisel.mba': {
    model: 'teisel',
    body: 9,
    bones: [
      [1, 'bone09'], [9, 'bone00'], [11, 'bone01'], [12, 'bone02', 'parent'],
      [13, 'bone03', [14, 'bone04']], [14, 'bone04', [15, 'bone05']], [15, 'bone05', 'parent'],
      [16, 'bone06', [17, 'bone07']], [17, 'bone07', [18, 'bone08']], [18, 'bone08', 'parent'],
      [2, 'bone10', [3, 'bone11']], [3, 'bone11', [4, 'bone12']], [4, 'bone12', 'parent'],
      [5, 'bone13', [6, 'bone14']], [6, 'bone14', [7, 'bone15']], [7, 'bone15', 'parent'],
    ],
  },
  'kobun.mba': {
    // the Legends 2 Servbot has one rigid piece per limb: follow the upper limb bones
    model: 'servbot',
    body: 1,
    bones: [[1, 'bone00'], [8, 'bone01'], [12, 'bone02'], [9, 'bone03'], [5, 'bone04'], [2, 'bone05']],
  },
};

const PHONE_UNIT = 1 / 64; // world units per phone model unit
const PHONE_PLAYER_HEIGHT = 186 * PHONE_UNIT;

const _m = new THREE.Matrix4();
const _a = new THREE.Matrix4();
const _b = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _pq = new THREE.Quaternion();
const IDENTITY = new THREE.Quaternion();

/** Quaternion of R_pose * R_rest^-1 for the 3x4 row-major matrices at offset `o`. */
function deltaRotation(pose, rest, o, out) {
  const rot = (src, dst) => {
    // normalise columns: animation may scale bones
    const c0 = Math.hypot(src[o], src[o + 4], src[o + 8]) || 1;
    const c1 = Math.hypot(src[o + 1], src[o + 5], src[o + 9]) || 1;
    const c2 = Math.hypot(src[o + 2], src[o + 6], src[o + 10]) || 1;
    return dst.set(
      src[o] / c0, src[o + 1] / c1, src[o + 2] / c2, 0,
      src[o + 4] / c0, src[o + 5] / c1, src[o + 6] / c2, 0,
      src[o + 8] / c0, src[o + 9] / c1, src[o + 10] / c2, 0,
      0, 0, 0, 1,
    );
  };
  rot(pose, _a);
  rot(rest, _b).transpose();
  return out.setFromRotationMatrix(_m.multiplyMatrices(_a, _b));
}

/** One drawable copy of a Legends 2 character. */
class Instance {
  constructor(source) {
    this.root = cloneSkinned(source.scene);
    this.root.matrixAutoUpdate = false;
    this.bones = new Map();
    this.parts = new Map(); // mesh part name ('body', 'arm_l', 'buster', ...) -> node
    this.order = [];
    this.outlines = []; // cel-shading outline shells, one per skinned mesh
    const skinned = [];
    const visit = (o) => {
      if (o.isBone) {
        this.bones.set(o.name, o);
        this.order.push(o);
      } else if (o.isSkinnedMesh) {
        o.frustumCulled = false;
        skinned.push(o);
        // a mesh node is named <archive>_<character>_<part>; multi-material ones are groups
        const node = o.parent !== this.root && !o.parent.isBone ? o.parent : o;
        this.parts.set(node.name.replace(/^[^_]+_[^_]+_/, ''), node);
      }
      for (const c of o.children) visit(c);
    };
    visit(this.root);
    for (const o of skinned) {
      const material = Array.isArray(o.material) ? o.material.map((m) => m.userData.outline) : o.material.userData.outline;
      const shell = new THREE.SkinnedMesh(o.geometry, material);
      shell.bind(o.skeleton, o.bindMatrix);
      shell.frustumCulled = false;
      shell.visible = false;
      o.add(shell); // follows the mesh's transform and visibility
      this.outlines.push(shell);
    }
    this.rest = new Map(this.order.map((b) => [b.name, b.position.clone()]));
    this.world = new Map(); // bone name -> desired model-space rotation
    this.quats = new Map(this.order.map((b) => [b.name, new THREE.Quaternion()]));
  }

  setVisible(part, visible) {
    const node = this.parts.get(part);
    if (node) node.visible = visible;
  }
}

export class Legends2 {
  enabled = false;
  ready = false;
  /** @type {Map<string, {scene: THREE.Object3D, height: number}>} */
  models = new Map();
  /** content key -> { part: role } | { character: spec } */
  roles = new Map();
  /** Counters for diagnostics. */
  stats = { recognised: 0, parts: 0, replaced: 0, incomplete: 0, lastRoles: '' };
  #pools = new Map();
  #used = new Map();
  #assemblies = [];

  /**
   * @param {string} base  URL of the installed asset folder
   * @param {(name: string) => Uint8Array[]} findAll  every copy of a phone game data file
   * @returns {Promise<boolean>} whether the assets are installed
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
    await Promise.all(Object.entries(manifest.models).map(async ([name, info]) => {
      const gltf = await loader.loadAsync(`${base}/${info.url}`);
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const convert = (mat) => {
          if (mat.map) {
            mat.map.colorSpace = THREE.NoColorSpace;
            registerTexture(mat.map);
          }
          // the game is unlit; PlayStation textures are colour-keyed
          const m = makeLit(new THREE.MeshBasicMaterial({ map: mat.map, alphaTest: 0.5, side: THREE.DoubleSide }),
            { character: true });
          // black shell for the cel-shading outline
          m.userData.outline = makeOutline(new THREE.MeshBasicMaterial({
            color: 0x000000, map: mat.map, alphaTest: 0.5, side: THREE.DoubleSide,
          }));
          return m;
        };
        o.material = Array.isArray(o.material) ? o.material.map(convert) : convert(o.material);
        // for cel shading: `normal` (hard edges kept) shades, `rdSmooth` widens the outline
        const { shading, smooth } = computeNormals(o.geometry);
        o.geometry.setAttribute('normal', shading);
        o.geometry.setAttribute('rdSmooth', smooth);
      });
      this.models.set(name, { scene: gltf.scene, height: info.max[1] });
    }));
    if (this.models.has('megaman')) {
      for (const [file, role] of Object.entries(PLAYER_FILES)) {
        for (const bytes of findAll(file)) this.roles.set(keyOf(bytes), { part: role });
      }
    }
    for (const [file, spec] of Object.entries(CHARACTERS)) {
      if (!this.models.has(spec.model)) continue;
      for (const bytes of findAll(file)) this.roles.set(keyOf(bytes), { character: spec });
    }
    this.ready = this.roles.size > 0;
    return this.ready;
  }

  get active() {
    return this.enabled && this.ready;
  }

  /** What a phone model is replaced by, or undefined if it is not one we replace. */
  roleOf(bytes) {
    const role = this.roles.get(keyOf(bytes));
    if (role) this.stats.recognised++;
    return role;
  }

  /**
   * Called for every recognised phone figure as the game draws it.
   * @param {object} part  { role, bones, rest: model-space 3x4 matrices per bone (posed / bind),
   *                         height: bind-pose height in phone units, meshes: the phone meshes
   *                         built for this draw, cache: per-figure Map for alignment data }
   * @param {THREE.Matrix4} matrix  the game's model matrix for the draw
   */
  add(part, matrix) {
    this.stats.parts++;
    if (part.role.character) {
      this.#assemblies.push({ matrix: matrix.clone(), character: part });
      return;
    }
    const e = matrix.elements;
    const name = part.role.part;
    let a = this.#assemblies.find((x) => x.parts && Math.abs(x.x - e[12]) < 0.01
      && Math.abs(x.y - e[13]) < 0.01 && Math.abs(x.z - e[14]) < 0.01 && !x.parts.has(name));
    if (!a) {
      a = { x: e[12], y: e[13], z: e[14], matrix: matrix.clone(), parts: new Map() };
      this.#assemblies.push(a);
    }
    a.parts.set(name, part);
  }

  #instance(name) {
    const pool = this.#pools.get(name) || this.#pools.set(name, []).get(name);
    const used = this.#used.get(name) || 0;
    this.#used.set(name, used + 1);
    return pool[used] || (pool[used] = new Instance(this.models.get(name)));
  }

  /**
   * Turn the figures collected since the last call into drawables.
   * @returns {{nodes: THREE.Object3D[], meshes: {mesh: THREE.Mesh, matrix: THREE.Matrix4}[]}}
   *   `nodes` are posed Legends 2 models (world matrices set); `meshes` are phone meshes to
   *   draw as usual (parts we could not assemble into a character, and special weapon arms)
   */
  finish() {
    const nodes = [];
    const meshes = [];
    for (const a of this.#assemblies) {
      if (a.character) {
        const part = a.character;
        const spec = part.role.character;
        const model = this.models.get(spec.model);
        const inst = this.#instance(spec.model);
        const scale = (part.height * PHONE_UNIT) / model.height;
        inst.world.clear();
        let table = spec.bones;
        if (spec.forearm) {
          const o = spec.forearm.buster * 12;
          const buster = Math.hypot(part.bones[o], part.bones[o + 4], part.bones[o + 8]) > 0.5;
          if (buster) {
            table = spec.busterBones ??= spec.bones.map((e) => (e[0] === spec.forearm.hand
              ? [spec.forearm.buster, ...e.slice(1)] : e));
          }
          inst.setVisible('buster', buster);
          inst.setVisible('arm_l', !buster);
        }
        this.#apply(inst, part, table);
        this.#solve(inst, part, spec.body, scale);
        this.#place(inst, a.matrix, scale);
        nodes.push(inst.root);
        this.stats.replaced++;
        continue;
      }
      this.stats.lastRoles = [...a.parts.keys()].join('+');
      if (!(a.parts.has('leg') && a.parts.has('chest'))) {
        for (const p of a.parts.values()) for (const m of p.meshes) meshes.push({ mesh: m, matrix: a.matrix });
        this.stats.incomplete++;
        continue;
      }
      const name = a.parts.has('helm') || !this.models.has('megaman_nohelmet') ? 'megaman' : 'megaman_nohelmet';
      const model = this.models.get(name);
      const inst = this.#instance(name);
      const scale = PHONE_PLAYER_HEIGHT / model.height;
      inst.world.clear();
      for (const [role, part] of a.parts) this.#apply(inst, part, PLAYER_PARTS[role]);
      this.#solve(inst, a.parts.get('chest'), 1, scale);
      // the special weapon replaces the right arm: keep the phone's weapon model for it
      const weapon = a.parts.get('weapon');
      inst.setVisible('arm_r', !weapon);
      if (weapon) for (const m of weapon.meshes) meshes.push({ mesh: m, matrix: a.matrix });
      // during play the left arm is the buster
      inst.setVisible('arm_l', false);
      inst.setVisible('buster', true);
      this.#place(inst, a.matrix, scale);
      nodes.push(inst.root);
      this.stats.replaced++;
    }
    this.#assemblies.length = 0;
    return { nodes, meshes };
  }

  /** Call once the frame has been presented, so pooled instances can be reused for the next. */
  endFlush() {
    this.#used.clear();
  }

  /** Rest-pose alignment for one bone table entry, cached per phone figure. */
  #alignment(inst, part, table, i) {
    const [index, name, how] = table[i];
    let q = part.cache.get(name);
    if (q) return q;
    q = IDENTITY;
    if (how === 'parent') {
      if (i > 0) q = this.#alignment(inst, part, table, i - 1);
    } else if (how) {
      const [phoneChild, l2Child] = how;
      const r = part.rest;
      const phoneDir = new THREE.Vector3(
        r[phoneChild * 12 + 3] - r[index * 12 + 3],
        r[phoneChild * 12 + 7] - r[index * 12 + 7],
        r[phoneChild * 12 + 11] - r[index * 12 + 11],
      );
      // rotations in the Legends 2 rest pose are identity, so a child's offset is its direction
      const child = inst.rest.get(l2Child);
      if (child && phoneDir.lengthSq() > 0 && child.lengthSq() > 0) {
        q = new THREE.Quaternion().setFromUnitVectors(child.clone().normalize(), phoneDir.normalize());
      }
    }
    part.cache.set(name, q);
    return q;
  }

  /** Record the model-space rotation each mapped Legends 2 bone should have. */
  #apply(inst, part, table) {
    if (!table) return;
    for (let i = 0; i < table.length; i++) {
      const [index, name] = table[i];
      const o = index * 12;
      const q = inst.quats.get(name);
      if (!q || o + 12 > part.bones.length) continue;
      deltaRotation(part.bones, part.rest, o, q).multiply(this.#alignment(inst, part, table, i));
      inst.world.set(name, q);
    }
  }

  /** Turn the desired model-space rotations into local bone rotations; place the body. */
  #solve(inst, bodyPart, bodyIndex, scale) {
    for (const bone of inst.order) {
      const parent = bone.parent && bone.parent.isBone ? inst.world.get(bone.parent.name) : null;
      const want = inst.world.get(bone.name);
      if (!want) {
        // nothing drives this bone: keep its rest orientation relative to the parent
        inst.world.set(bone.name, parent || IDENTITY);
        bone.quaternion.identity();
      } else if (parent) {
        bone.quaternion.copy(_pq.copy(parent).invert()).multiply(want);
      } else {
        bone.quaternion.copy(want);
      }
    }
    const root = inst.order[0];
    root.position.copy(inst.rest.get(root.name));
    if (bodyPart) {
      // the phone body bone's displacement from rest, in this model's units
      const o = bodyIndex * 12;
      const k = PHONE_UNIT / scale;
      root.position.x += (bodyPart.bones[o + 3] - bodyPart.rest[o + 3]) * k;
      root.position.y += (bodyPart.bones[o + 7] - bodyPart.rest[o + 7]) * k;
      root.position.z += (bodyPart.bones[o + 11] - bodyPart.rest[o + 11]) * k;
    }
  }

  #place(inst, matrix, scale) {
    for (const shell of inst.outlines) shell.visible = cel.enabled;
    inst.root.matrix.copy(matrix).scale(_v.set(scale, scale, scale));
    inst.root.matrixWorld.copy(inst.root.matrix);
    for (const c of inst.root.children) c.updateMatrixWorld(true);
  }
}

/** The one instance shared by the figure loader and the renderer. */
export const legends2 = new Legends2();
