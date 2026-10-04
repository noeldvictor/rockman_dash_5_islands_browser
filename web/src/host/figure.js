// Character/prop models (MBAC) and their animation tables (MTRA), see formats/mbac.js.

import * as THREE from 'three';
import {
  parseMBAC, parseMTRA, poseModel, getActionPattern, computeBoneMatrices,
} from '../formats/mbac.js';
import { legends2 } from '../mods/legends2.js';
import {
  TYPE, getMaterial, getOutlineMaterial, frameClock, BLEND_NORMAL, BLEND_ALPHA, BLEND_ADD,
} from './g3d.js';
import { cel, isCharacter, CREASE } from './lighting.js';
import { keyOf } from './contentkey.js';
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
    // people and enemies, as opposed to doors, crates and effects: cel shading, shadows
    this.character = isCharacter(keyOf(bytes));
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
      // cel shading (lighting.js): shading normals and outline normals, filled in while it is on
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(b.numCorners * 3), 3));
      g.setAttribute('rdSmooth', new THREE.BufferAttribute(new Float32Array(b.numCorners * 3), 3));
      const mesh = make(g);
      mesh.userData.outline = make(g); // the cel-shading outline shell shares the geometry
      mesh.userData.shown = new Uint8Array(b.numTriangles);
      return mesh;
    });
    meshes.frame = -2; // frame this instance was last drawn in
    return meshes;
  }

  /**
   * Normals of the current pose, for cel shading (see lighting.js).
   * @returns {{smooth: Float32Array, shading: Float32Array, first: number[]}}
   *   smooth: per vertex, the sum of the faces meeting there (for the outline shell);
   *   shading: per corner (all batches in order; `first[batch]` is a batch's first corner), the
   *   sum of the faces at its vertex that are within the crease angle of its own face
   */
  #normals() {
    const model = this.model;
    const p = this.posed;
    let n = this.normalData;
    if (!n) {
      // topology never changes: which faces meet at each vertex
      const first = [];
      let corners = 0;
      for (const b of model.batches) {
        first.push(corners);
        corners += b.numTriangles * 3;
      }
      const around = Array.from({ length: model.numVertices }, () => []);
      let f = 0;
      for (const b of model.batches) {
        for (let c = 0, end = b.numTriangles * 3; c < end; c += 3, f++) {
          for (let k = 0; k < 3; k++) around[b.cornerVertex[c + k]].push(f);
        }
      }
      n = this.normalData = {
        first,
        around,
        face: new Float32Array(f * 3), // area-weighted
        unit: new Float32Array(f * 3),
        smooth: new Float32Array(model.numVertices * 3),
        shading: new Float32Array(corners * 3),
      };
    }
    const { face, unit, smooth, shading, around } = n;
    smooth.fill(0);
    let f = 0;
    for (const b of model.batches) {
      const cv = b.cornerVertex;
      for (let c = 0, end = b.numTriangles * 3; c < end; c += 3, f += 3) {
        const i0 = cv[c] * 3, i1 = cv[c + 1] * 3, i2 = cv[c + 2] * 3;
        const ax = p[i1] - p[i0], ay = p[i1 + 1] - p[i0 + 1], az = p[i1 + 2] - p[i0 + 2];
        const bx = p[i2] - p[i0], by = p[i2 + 1] - p[i0 + 1], bz = p[i2 + 2] - p[i0 + 2];
        const x = ay * bz - az * by, y = az * bx - ax * bz, z = ax * by - ay * bx;
        const len = Math.hypot(x, y, z) || 1;
        face[f] = x;
        face[f + 1] = y;
        face[f + 2] = z;
        unit[f] = x / len;
        unit[f + 1] = y / len;
        unit[f + 2] = z / len;
        for (const i of [i0, i1, i2]) {
          smooth[i] += x;
          smooth[i + 1] += y;
          smooth[i + 2] += z;
        }
      }
    }
    f = 0;
    let o = 0;
    for (const b of model.batches) {
      const cv = b.cornerVertex;
      for (let c = 0, end = b.numTriangles * 3; c < end; c++, o += 3) {
        const own = Math.floor(c / 3) * 3 + f;
        let x = 0, y = 0, z = 0;
        for (const g of around[cv[c]]) {
          const g3 = g * 3;
          if (unit[own] * unit[g3] + unit[own + 1] * unit[g3 + 1] + unit[own + 2] * unit[g3 + 2] > CREASE) {
            x += face[g3];
            y += face[g3 + 1];
            z += face[g3 + 2];
          }
        }
        shading[o] = x;
        shading[o + 1] = y;
        shading[o + 2] = z;
      }
      f += b.numTriangles * 3;
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
    const normals = cel.enabled && this.character ? this.#normals() : null;
    const out = [];
    for (let bi = 0; bi < model.batches.length; bi++) {
      const b = model.batches[bi];
      const mesh = instance[bi];
      const g = mesh.geometry;
      const pos = g.attributes.position.array;
      const prev = g.attributes.rdPrev.array;
      const nrm = g.attributes.normal.array;
      const smo = g.attributes.rdSmooth.array;
      const first = normals ? normals.first[bi] * 3 : 0; // this batch's corners in the figure's arrays
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
              nrm[o] = normals.shading[first + o];
              nrm[o + 1] = normals.shading[first + o + 1];
              nrm[o + 2] = normals.shading[first + o + 2];
              smo[o] = normals.smooth[v];
              smo[o + 1] = normals.smooth[v + 1];
              smo[o + 2] = normals.smooth[v + 2];
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
      if (normals) {
        g.attributes.normal.needsUpdate = true;
        g.attributes.rdSmooth.needsUpdate = true;
      }

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
        character: this.character,
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
