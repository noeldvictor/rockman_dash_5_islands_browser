// Character/prop models (MBAC) and their animation tables (MTRA), see formats/mbac.js.

import * as THREE from 'three';
import {
  parseMBAC, parseMTRA, poseModel, getActionPattern, computeBoneMatrices,
} from '../formats/mbac.js';
import { legends2 } from '../mods/legends2.js';
import {
  TYPE, getMaterial, getOutlineMaterial, frameClock, BLEND_NORMAL, BLEND_ALPHA, BLEND_ADD,
} from './g3d.js';
import { cel } from './lighting.js';
import { FIGURE_LOCAL } from './conventions.js';

class ActionTable3D {
  type = TYPE.ACTION_TABLE;

  constructor(bytes) {
    this.table = parseMTRA(bytes);
    this.numActions = this.table.numActions;
  }

  /** 16.16 fixed point: 65536 per keyframe. */
  getMaxFrame(index) {
    const a = this.table.actions[index];
    return a ? a.maxFrame : 0;
  }

  setTime() {}

  dispose() {}
}

class Figure3D {
  type = TYPE.FIGURE;
  blendMode = BLEND_NORMAL;
  transparency = 100;
  pattern = 0;
  used = 0;

  constructor(bytes) {
    // file winding is clockwise-front; three.js wants counter-clockwise
    const model = parseMBAC(bytes, { flipWinding: true });
    for (const w of model.warnings) console.warn('[mbac]', w);
    this.model = model;
    this.numPatterns = model.numPatterns;
    this.textures = [];
    this.action = null;
    this.actionIndex = 0;
    this.time = 0;
    this.posed = new Float32Array(model.numVertices * 3);
    this.instances = [];
    this.uvCache = new Map(); // `${batch}|${w}x${h}` -> BufferAttribute
    this.colorAttributes = model.batches.map((b) => (b.colors
      ? new THREE.BufferAttribute(b.colors, 3, true) : null));
    // optional Legends 2 model replacement (mods/legends2.js): which player part this is, if any
    this.role = legends2.ready ? legends2.roleOf(bytes) : undefined;
    if (this.role) {
      this.restBones = computeBoneMatrices(model, null, 0, new Float32Array(model.numBones * 12));
      this.poseBones = new Float32Array(model.numBones * 12);
      this.alignCache = new Map();
    }
  }

  setTextureCount(n) {
    this.textures.length = n;
  }

  setTextureAt(index, texture) {
    this.textures[index] = texture;
  }

  setAction(action, index) {
    this.action = action;
    this.actionIndex = index;
  }

  /** @param {number} t animation position, 16.16 keyframes */
  setTime(t) {
    this.time = t;
  }

  #uv(batchIndex, tex) {
    const key = `${batchIndex}|${tex.width}x${tex.height}`;
    let attr = this.uvCache.get(key);
    if (!attr) {
      const src = this.model.batches[batchIndex].uvs; // texels, origin top-left
      const uv = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 2) {
        // the engine divides both axes by the texture *width* (textures are square in practice)
        uv[i] = src[i] / tex.width;
        uv[i + 1] = src[i + 1] / tex.width;
      }
      attr = new THREE.BufferAttribute(uv, 2);
      this.uvCache.set(key, attr);
    }
    return attr;
  }

  #createInstance() {
    const make = (g) => {
      const mesh = new THREE.Mesh(g);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.userData.local = FIGURE_LOCAL;
      return mesh;
    };
    const meshes = this.model.batches.map((b) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.numCorners * 3), 3));
      // the vertices as posed in the previous frame, for showing in-between poses (lighting.js)
      g.setAttribute('rdPrev', new THREE.BufferAttribute(new Float32Array(b.numCorners * 3), 3));
      // smooth normals, only filled in while cel shading is on
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(b.numCorners * 3), 3));
      const mesh = make(g);
      mesh.userData.outline = make(g); // the cel-shading outline shell shares the geometry
      mesh.userData.shown = new Uint8Array(b.numTriangles);
      return mesh;
    });
    meshes.frame = -2; // frame this instance was last drawn in
    return meshes;
  }

  /** Smooth normals of the current pose: per vertex, the sum of the faces meeting there. */
  #smoothNormals() {
    const model = this.model;
    const p = this.posed;
    const n = (this.normals ??= new Float32Array(model.numVertices * 3)).fill(0);
    for (const b of model.batches) {
      const cv = b.cornerVertex;
      for (let c = 0, end = b.numTriangles * 3; c < end; c += 3) {
        const i0 = cv[c] * 3, i1 = cv[c + 1] * 3, i2 = cv[c + 2] * 3;
        const ax = p[i1] - p[i0], ay = p[i1 + 1] - p[i0 + 1], az = p[i1 + 2] - p[i0 + 2];
        const bx = p[i2] - p[i0], by = p[i2 + 1] - p[i0 + 1], bz = p[i2 + 2] - p[i0 + 2];
        const x = ay * bz - az * by, y = az * bx - ax * bz, z = ax * by - ay * bx;
        for (const i of [i0, i1, i2]) {
          n[i] += x;
          n[i + 1] += y;
          n[i + 2] += z;
        }
      }
    }
    return n;
  }

  /** Snapshot the current pose/pattern/material state into meshes for this flush. */
  build() {
    const model = this.model;
    const table = this.action && this.action.table.actions[this.actionIndex] ? this.action.table : null;
    poseModel(model, table, this.actionIndex, this.time, this.posed);
    const pattern = table ? getActionPattern(table, this.actionIndex, this.time, this.pattern) : this.pattern;
    const instance = this.instances[this.used] || (this.instances[this.used] = this.#createInstance());
    this.used++;
    // drawn in the previous frame too: keep that pose, so in-between poses can be shown
    const tween = instance.frame === frameClock.frame - 1;
    instance.frame = frameClock.frame;
    const posed = this.posed;
    const normals = cel.enabled ? this.#smoothNormals() : null;
    const out = [];
    for (let bi = 0; bi < model.batches.length; bi++) {
      const b = model.batches[bi];
      const mesh = instance[bi];
      const g = mesh.geometry;
      const pos = g.attributes.position.array;
      const prev = g.attributes.rdPrev.array;
      const nrm = g.attributes.normal.array;
      const shown = mesh.userData.shown;
      const cv = b.cornerVertex;
      const filter = b.patternUnion !== 0;
      let visible = 0;
      if (tween) prev.set(pos);
      for (let t = 0, n = b.numTriangles; t < n; t++) {
        const mask = filter ? b.trianglePattern[t] : 0;
        const show = (mask & pattern) === mask;
        // a triangle that just appeared or disappeared has no previous pose to move from
        const fresh = !tween || shown[t] !== (show ? 1 : 0);
        shown[t] = show ? 1 : 0;
        for (let c = t * 3; c < t * 3 + 3; c++) {
          const o = c * 3;
          if (show) {
            const v = cv[c] * 3;
            pos[o] = posed[v];
            pos[o + 1] = posed[v + 1];
            pos[o + 2] = posed[v + 2];
            if (normals) {
              nrm[o] = normals[v];
              nrm[o + 1] = normals[v + 1];
              nrm[o + 2] = normals[v + 2];
            }
          } else {
            pos[o] = pos[o + 1] = pos[o + 2] = 0; // degenerate: not drawn
          }
          if (fresh) {
            prev[o] = pos[o];
            prev[o + 1] = pos[o + 1];
            prev[o + 2] = pos[o + 2];
          }
        }
        if (show) visible++;
      }
      if (!visible) continue;
      g.attributes.position.needsUpdate = true;
      g.attributes.rdPrev.needsUpdate = true;
      if (normals) g.attributes.normal.needsUpdate = true;

      let map = null;
      let colorKey = false;
      if (b.textured) {
        const tex = this.textures[b.textureIndex] || this.textures[0];
        if (!tex) continue; // the phone draws nothing for a textured polygon without a texture
        g.setAttribute('uv', this.#uv(bi, tex));
        colorKey = b.transparent;
        map = tex.get(colorKey);
      } else if (this.colorAttributes[bi]) {
        g.setAttribute('color', this.colorAttributes[bi]);
      }
      // per-polygon blend bits (1 half, 2 add; the engine draws 3 = subtract as opaque) win;
      // otherwise the figure-wide mode set by the game
      let blend = this.blendMode;
      let alpha = Math.min(1, this.transparency / 100.3 + 0.003); // engine: node alpha = t / 100.3
      if (b.blendMode === 1) {
        blend = BLEND_ALPHA;
        alpha *= 0.5;
      } else if (b.blendMode === 2) {
        blend = BLEND_ADD;
      } else if (blend === BLEND_NORMAL && alpha < 1) {
        blend = BLEND_ALPHA;
      }
      mesh.material = getMaterial({
        map,
        colorKey,
        blend,
        alpha,
        vertexColors: !b.textured,
        doubleSide: b.doubleSided,
        figure: true,
      });
      out.push(mesh);
      if (normals && blend === BLEND_NORMAL) {
        const outline = mesh.userData.outline;
        outline.material = getOutlineMaterial({ map, colorKey });
        out.push(outline);
      }
    }
    if (this.role && legends2.active) {
      // hand the pose to the replacement; it draws these meshes itself if it cannot use them
      const action = table ? table.actions[this.actionIndex] : null;
      const animated = !!action && action.boneTracks.length > 0;
      computeBoneMatrices(model, animated ? action.matrices : null,
        animated ? action.boneTracks.length : 0, this.poseBones);
      return {
        legends2Part: {
          role: this.role,
          bones: this.poseBones.slice(),
          rest: this.restBones,
          height: model.bounds.max[1],
          meshes: out,
          cache: this.alignCache,
        },
      };
    }
    return out;
  }

  dispose() {
    for (const inst of this.instances) for (const mesh of inst) mesh.geometry.dispose();
    this.instances.length = 0;
  }
}

export function createFigure(bytes) {
  return new Figure3D(bytes);
}

export function createActionTable(bytes) {
  return new ActionTable3D(bytes);
}
