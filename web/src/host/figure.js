// Character/prop models (MBAC) and their animation tables (MTRA), see formats/mbac.js.

import * as THREE from 'three';
import {
  parseMBAC, parseMTRA, poseModel, getActionPattern,
} from '../formats/mbac.js';
import { TYPE, getMaterial, BLEND_NORMAL, BLEND_ALPHA, BLEND_ADD } from './g3d.js';
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
        uv[i] = src[i] / tex.width;
        uv[i + 1] = src[i + 1] / tex.height;
      }
      attr = new THREE.BufferAttribute(uv, 2);
      this.uvCache.set(key, attr);
    }
    return attr;
  }

  #createInstance() {
    return this.model.batches.map((b) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.numCorners * 3), 3));
      const mesh = new THREE.Mesh(g);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.userData.local = FIGURE_LOCAL;
      return mesh;
    });
  }

  /** Snapshot the current pose/pattern/material state into meshes for this flush. */
  build() {
    const model = this.model;
    const table = this.action && this.action.table.actions[this.actionIndex] ? this.action.table : null;
    poseModel(model, table, this.actionIndex, this.time, this.posed);
    const pattern = table ? getActionPattern(table, this.actionIndex, this.time, this.pattern) : this.pattern;
    const instance = this.instances[this.used] || (this.instances[this.used] = this.#createInstance());
    this.used++;
    const posed = this.posed;
    const out = [];
    for (let bi = 0; bi < model.batches.length; bi++) {
      const b = model.batches[bi];
      const mesh = instance[bi];
      const g = mesh.geometry;
      const pos = g.attributes.position.array;
      const cv = b.cornerVertex;
      const filter = b.patternUnion !== 0;
      let visible = 0;
      for (let t = 0, n = b.numTriangles; t < n; t++) {
        const mask = filter ? b.trianglePattern[t] : 0;
        const show = (mask & pattern) === mask;
        for (let c = t * 3; c < t * 3 + 3; c++) {
          if (show) {
            const v = cv[c] * 3;
            pos[c * 3] = posed[v];
            pos[c * 3 + 1] = posed[v + 1];
            pos[c * 3 + 2] = posed[v + 2];
          } else {
            pos[c * 3] = pos[c * 3 + 1] = pos[c * 3 + 2] = 0; // degenerate: not drawn
          }
        }
        if (show) visible++;
      }
      if (!visible) continue;
      g.attributes.position.needsUpdate = true;

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
      // per-polygon blend bits win; otherwise the figure-wide mode set by the game
      let blend = this.blendMode;
      let alpha = this.transparency / 100;
      if (b.blendMode === 1) {
        blend = BLEND_ALPHA;
        alpha *= 0.5;
      } else if (b.blendMode === 2 || b.blendMode === 3) {
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
      });
      out.push(mesh);
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
