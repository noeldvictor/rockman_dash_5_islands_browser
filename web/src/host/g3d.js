// DoJa 5 "graphics3d" on three.js.
//
// The game issues immediate-mode calls between Graphics.lock()/unlock():
//   setTransform(view) / setPerspectiveView / setClipRectFor3D, then renderObject3D(obj, model)
//   for each object, then flushBuffer(). renderObject3D only queues; flushBuffer draws the queue.
//
// Conventions (see Transform.java): matrices arrive row-major with the translation in elements
// 3/7/11; view space is x right, y up, +z into the screen. three.js matrices are column-major
// and its clip space expects -z forward, so the projection built here takes care of that instead
// of a three.js camera class.

import * as THREE from 'three';
import { decodeBMP8 } from '../formats/bmp.js';
import { createFigure, createActionTable } from './figure.js';
import { createGroup } from './group.js';

export const TYPE = {
  ACTION_TABLE: 1, FIGURE: 2, TEXTURE: 3, PRIMITIVE: 6, GROUP: 7,
};
export const BLEND_NORMAL = 0;
export const BLEND_ALPHA = 32;
export const BLEND_ADD = 64;

const TEXTURE_COLORKEY = 16;

/** Row-major float[16] -> THREE.Matrix4 (which takes its arguments in row-major order too). */
export function setMatrix(dst, m) {
  return dst.set(
    m[0], m[1], m[2], m[3],
    m[4], m[5], m[6], m[7],
    m[8], m[9], m[10], m[11],
    m[12], m[13], m[14], m[15],
  );
}

// ---- resources ---------------------------------------------------------------------------------

export class Texture3D {
  type = TYPE.TEXTURE;
  envMode = 0;
  envMap = false;

  constructor(bytes) {
    const bmp = decodeBMP8(bytes);
    this.width = bmp.width;
    this.height = bmp.height;
    this.bmp = bmp;
    this.textures = new Map(); // colorKey flag -> THREE.DataTexture
  }

  /** @param {boolean} colorKey treat palette index 0 as transparent */
  get(colorKey) {
    let t = this.textures.get(colorKey);
    if (!t) {
      const { width, height, palette, indices } = this.bmp;
      const rgba = new Uint8Array(width * height * 4);
      for (let i = 0, n = width * height; i < n; i++) {
        const c = indices[i];
        rgba[i * 4] = palette[c * 4];
        rgba[i * 4 + 1] = palette[c * 4 + 1];
        rgba[i * 4 + 2] = palette[c * 4 + 2];
        rgba[i * 4 + 3] = colorKey && c === 0 ? 0 : 255;
      }
      t = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
      t.colorSpace = THREE.NoColorSpace;
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.flipY = false; // row 0 of the data is the top of the image; v grows downwards
      t.needsUpdate = true;
      this.textures.set(colorKey, t);
    }
    return t;
  }

  setTime() {}

  dispose() {
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
  }
}

/**
 * Shared material factory. `transparency` is the DoJa value: opacity in percent (100 = opaque).
 */
const materialCache = new Map();
export function getMaterial({ map = null, colorKey = false, blend = BLEND_NORMAL, alpha = 1,
  vertexColors = false, doubleSide = true, color = 0xffffff }) {
  const key = `${map ? map.id : 0}|${colorKey ? 1 : 0}|${blend}|${alpha.toFixed(3)}|${vertexColors ? 1 : 0}|${doubleSide ? 1 : 0}|${color}`;
  let m = materialCache.get(key);
  if (!m) {
    const blended = blend !== BLEND_NORMAL;
    m = new THREE.MeshBasicMaterial({
      map,
      color,
      vertexColors,
      side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
      alphaTest: colorKey ? 0.5 : 0,
      transparent: blended,
      opacity: blended ? alpha : 1,
      blending: blend === BLEND_ADD ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: !blended,
    });
    materialCache.set(key, m);
  }
  return m;
}

/** Immediate-mode geometry whose arrays the game rewrites freely between draws. */
export class Primitive3D {
  type = TYPE.PRIMITIVE;
  blendMode = BLEND_NORMAL;
  transparency = 100;
  texture = null;

  constructor(kind, param, count) {
    this.kind = kind; // 1 points, 2 lines, 3 triangles, 4 quads, 5 point sprites
    this.param = param;
    this.count = count;
    this.pool = [];
    this.used = 0;
  }

  // vertices / normals / colors / texCoords are assigned by the game right after construction:
  // Int32Array views onto the very arrays it later writes into.
  vertices = null;
  colors = null;
  texCoords = null;

  setTime() {}

  dispose() {
    for (const mesh of this.pool) mesh.geometry.dispose();
    this.pool.length = 0;
  }

  /** Snapshot the current arrays into a mesh (the game may change them before the flush). */
  build() {
    const perFace = this.kind === 4 ? 4 : 3;
    if (this.kind !== 3 && this.kind !== 4) return null;
    const faces = this.count;
    const triVerts = faces * (perFace === 4 ? 6 : 3);
    let mesh = this.pool[this.used];
    if (!mesh) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(triVerts * 3), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(triVerts * 2), 2));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(triVerts * 3), 3));
      mesh = new THREE.Mesh(g);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      this.pool.push(mesh);
    }
    this.used++;
    const pos = mesh.geometry.attributes.position;
    const uv = mesh.geometry.attributes.uv;
    const col = mesh.geometry.attributes.color;
    const v = this.vertices;
    const t = this.texCoords;
    const tex = this.texture;
    const tw = tex ? tex.width : 1;
    const th = tex ? tex.height : 1;
    const colorMode = this.param & 0xc00;
    const order = perFace === 4 ? [0, 1, 2, 0, 2, 3] : [0, 1, 2];
    let o = 0;
    for (let f = 0; f < faces; f++) {
      let r = 1;
      let g = 1;
      let b = 1;
      if (this.colors && colorMode) {
        const c = this.colors[colorMode === 0x400 ? 0 : f];
        r = ((c >> 16) & 255) / 255;
        g = ((c >> 8) & 255) / 255;
        b = (c & 255) / 255;
      }
      for (const k of order) {
        const i = f * perFace + k;
        pos.array[o * 3] = v[i * 3];
        pos.array[o * 3 + 1] = v[i * 3 + 1];
        pos.array[o * 3 + 2] = v[i * 3 + 2];
        if (t) {
          uv.array[o * 2] = (t[i * 2] + 0.5) / tw;
          uv.array[o * 2 + 1] = (t[i * 2 + 1] + 0.5) / th;
        }
        col.array[o * 3] = r;
        col.array[o * 3 + 1] = g;
        col.array[o * 3 + 2] = b;
        o++;
      }
    }
    pos.needsUpdate = true;
    uv.needsUpdate = true;
    col.needsUpdate = true;
    const colorKey = (this.param & TEXTURE_COLORKEY) !== 0;
    mesh.material = getMaterial({
      map: tex && t ? tex.get(colorKey) : null,
      colorKey: !!(tex && t) && colorKey,
      blend: this.blendMode,
      alpha: this.transparency / 100,
      vertexColors: true,
    });
    return mesh;
  }
}

// ---- renderer ----------------------------------------------------------------------------------

export class G3D {
  /** @param {import('./screen.js').Screen} screen */
  constructor(screen) {
    this.screen = screen;
    this.scene = new THREE.Scene();
    this.scene.matrixAutoUpdate = false;
    this.camera = new THREE.Camera();
    this.camera.matrixAutoUpdate = false;
    this.clip = [0, 0, 240, 240];
    this.view = new THREE.Matrix4();
    this.projection = { kind: 'perspective', near: 1, far: 1000, angle: 60, w: 240, h: 240 };
    this.queue = [];
    this.touched = new Set();
  }

  setClipRect(x, y, w, h) {
    this.clip = [x, y, w, h];
  }

  setParallelView(w, h) {
    this.projection = { kind: 'parallel', w, h };
  }

  setPerspectiveFov(near, far, angle) {
    this.projection = { kind: 'perspective', near, far, angle };
  }

  setPerspectiveSize(near, far, w, h) {
    this.projection = { kind: 'frustum', near, far, w, h };
  }

  setViewTransform(m) {
    if (m) setMatrix(this.view, m);
    else this.view.identity();
  }

  /** Queue an object with its model matrix; state is captured now, drawing happens in flush(). */
  render(obj, m) {
    if (!obj || !obj.build) return;
    const built = obj.build();
    if (!built) return;
    const matrix = new THREE.Matrix4();
    if (m) setMatrix(matrix, m);
    for (const mesh of Array.isArray(built) ? built : [built]) {
      // a built node may carry its own local transform (groups)
      if (mesh.userData.local) mesh.matrix.multiplyMatrices(matrix, mesh.userData.local);
      else mesh.matrix.copy(matrix);
      mesh.matrixWorld.copy(mesh.matrix);
      this.queue.push(mesh);
    }
    this.touched.add(obj);
  }

  #updateProjection() {
    const p = this.projection;
    const [, , cw, ch] = this.clip;
    const e = this.camera.projectionMatrix.elements;
    e.fill(0);
    if (p.kind === 'parallel') {
      // p.w x p.h world units fill the clip rectangle; depth range is generous and symmetric
      const depth = 32768;
      e[0] = 2 / p.w;
      e[5] = 2 / p.h;
      e[10] = 1 / depth;
      e[15] = 1;
    } else {
      let fx;
      let fy;
      if (p.kind === 'perspective') {
        // `angle` is the horizontal field of view
        fx = 1 / Math.tan((p.angle * Math.PI) / 360);
        fy = (fx * cw) / ch;
      } else {
        fx = (2 * p.near) / p.w;
        fy = (2 * p.near) / p.h;
      }
      const { near, far } = p;
      e[0] = fx;
      e[5] = fy;
      e[10] = (far + near) / (far - near);
      e[11] = 1; // w = +z (view space looks down +z)
      e[14] = (-2 * far * near) / (far - near);
    }
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.camera.matrixWorldInverse.copy(this.view);
    this.camera.matrixWorld.copy(this.view).invert();
  }

  flush() {
    if (this.queue.length === 0) return;
    const screen = this.screen;
    screen.flush2D();
    const r = screen.renderer;
    const k = screen.scale;
    const [x, y, w, h] = this.clip;
    const vy = (240 - y - h) * k;
    r.setViewport(x * k, vy, w * k, h * k);
    r.setScissor(x * k, vy, w * k, h * k);
    r.setScissorTest(true);
    r.clearDepth();
    this.#updateProjection();
    this.scene.children.length = 0;
    let order = 0;
    for (const mesh of this.queue) {
      mesh.renderOrder = order++;
      mesh.parent = this.scene;
      this.scene.children.push(mesh);
    }
    r.render(this.scene, this.camera);
    r.setScissorTest(false);
    for (const mesh of this.queue) mesh.parent = null;
    this.scene.children.length = 0;
    this.queue.length = 0;
    for (const obj of this.touched) obj.used = 0;
    this.touched.clear();
  }
}

// ---- factory used by the game through rdash.Host ------------------------------------------------

export const g3dFactory = {
  create(data, len) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, len).slice();
    const magic = String.fromCharCode(bytes[0], bytes[1]);
    try {
      if (magic === 'MB') return createFigure(bytes);
      if (magic === 'MT') return createActionTable(bytes);
      if (magic === 'BM') return new Texture3D(bytes);
      if (magic === 'D4') return createGroup(bytes);
    } catch (e) {
      console.error(`3D resource (${magic}, ${len} bytes) failed to load`, e);
      throw e;
    }
    console.error('unknown 3D resource', magic, len);
    return null;
  },
  createGroup() {
    return createGroup(null);
  },
  createPrimitive(kind, param, count) {
    return new Primitive3D(kind, param, count);
  },
};
