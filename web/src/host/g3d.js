// DoJa 5 "graphics3d" on three.js.
//
// The game issues immediate-mode calls between Graphics.lock()/unlock():
//   setTransform(view) / setPerspectiveView / setClipRectFor3D, then renderObject3D(obj, model)
//   for each object, then flushBuffer(). renderObject3D only queues; flushBuffer draws the queue.
//
// Conventions (see Transform.java): matrices arrive row-major with the translation in elements
// 3/7/11; view space is right-handed with x right, y DOWN and +z into the screen. three.js
// cameras look down -z with y up, so the projection is built by hand here instead of using a
// three.js camera class.

import * as THREE from 'three';
import { decodeBMP8 } from '../formats/bmp.js';
import { createFigure, createActionTable } from './figure.js';
import { createGroup } from './group.js';
import { legends2 } from '../mods/legends2.js';
import { registerTexture } from './texfilter.js';
import { makeLit, makeOutline, updateDraw, shadows } from './lighting.js';
import { FIGURE_SCALE } from './conventions.js';

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
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.flipY = false; // row 0 of the data is the top of the image; v grows downwards
      registerTexture(t);
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
  vertexColors = false, doubleSide = true, color = 0xffffff, figure = false }) {
  const key = `${map ? map.id : 0}|${colorKey ? 1 : 0}|${blend}|${alpha.toFixed(3)}|${vertexColors ? 1 : 0}|${doubleSide ? 1 : 0}|${color}|${figure ? 1 : 0}`;
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
    // figures: pose blending always, optional lighting / cel shading on opaque surfaces
    if (figure) makeLit(m, { light: blend === BLEND_NORMAL, character: true, tween: true });
    materialCache.set(key, m);
  }
  return m;
}

/** Black shell drawn around an opaque figure mesh for the cel-shading outline (lighting.js). */
const outlineCache = new Map();
export function getOutlineMaterial({ map = null, colorKey = false }) {
  const key = `${map ? map.id : 0}|${colorKey ? 1 : 0}`;
  let m = outlineCache.get(key);
  if (!m) {
    m = makeOutline(new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: colorKey ? map : null, // only the texture's cut-out matters
      alphaTest: colorKey ? 0.5 : 0,
      side: THREE.DoubleSide,
    }), { tween: true });
    outlineCache.set(key, m);
  }
  return m;
}

/** Counts presented frames; drawing instances use it to tell whether they were drawn last frame. */
export const frameClock = { frame: 0 };

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
    // the engine maps texel coordinate (size - 1) to exactly 1.0
    const tw = tex ? Math.max(1, tex.width - 1) : 1;
    const th = tex ? Math.max(1, tex.height - 1) : 1;
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
          uv.array[o * 2] = t[i * 2] / tw;
          uv.array[o * 2 + 1] = t[i * 2 + 1] / th;
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
      alpha: Math.trunc((this.transparency * 255) / 100) / 255,
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
    this.touched.add(obj);
    if (obj.type === TYPE.FIGURE && obj.model.numBones >= 2) {
      const b = obj.model.bounds;
      shadows.add(matrix, { min: b.min.map((v) => v * FIGURE_SCALE), max: b.max.map((v) => v * FIGURE_SCALE) });
    }
    if (built.legends2Part) {
      // a player part the Legends 2 replacement may take over; resolved at flush
      legends2.add(built.legends2Part, matrix);
      this.pendingParts = true;
      return;
    }
    for (const mesh of Array.isArray(built) ? built : [built]) this.#enqueue(mesh, matrix);
  }

  #enqueue(mesh, matrix) {
    // a built node may carry its own local transform (groups, figures)
    if (mesh.userData.local) mesh.matrix.multiplyMatrices(matrix, mesh.userData.local);
    else mesh.matrix.copy(matrix);
    mesh.matrixWorld.copy(mesh.matrix);
    this.queue.push(mesh);
  }

  /** Full-screen 3D fills the whole (possibly wide) canvas; inset views keep the 240 square. */
  #isWide() {
    const [x, y, w, h] = this.clip;
    return this.screen.xoff > 0 && x <= 0 && y <= 0 && w >= 240 && h >= 240;
  }

  /**
   * Set up the camera for a batch.
   * @param {object} p              the batch's projection (see the setters above)
   * @param {THREE.Matrix4} view    world -> view
   * @param {number} aspect         width / height of the viewport being rendered into
   */
  #updateCamera(p, view, aspect) {
    // The projection always spans the whole surface; setClipRectFor3D only scissors. Verified
    // against the phone engine (micro3d_d4.dll), where the surface is 240x240 (aspect 1).
    const e = this.camera.projectionMatrix.elements;
    e.fill(0);
    if (p.kind === 'parallel') {
      // p.w x p.h world units are visible across the 240x240 surface; depth range 0..32768
      const far = 32768;
      e[0] = 2 / (p.w * aspect);
      e[5] = -2 / p.h; // view-space y points down the screen
      e[10] = 2 / far;
      e[14] = -1;
      e[15] = 1;
    } else {
      // perspective: `angle` is the full vertical field of view; the frustum overload gives
      // the size of the view window at the near plane
      const fy = p.kind === 'perspective'
        ? 1 / Math.tan((p.angle * Math.PI) / 360)
        : (2 * p.near) / p.h;
      const fx = (p.kind === 'perspective' ? fy : (2 * p.near) / p.w) / aspect;
      const { near, far } = p;
      e[0] = fx;
      e[5] = -fy; // view-space y points down the screen
      e[10] = (far + near) / (far - near);
      e[11] = 1; // w = +z (view space looks down +z)
      e[14] = (-2 * far * near) / (far - near);
    }
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.camera.matrixWorldInverse.copy(view);
    this.camera.matrixWorld.copy(view).invert();
  }

  /**
   * End the batch of objects queued so far: it becomes a step of the frame being recorded
   * (screen.js), drawn when the frame is presented.
   */
  flush() {
    if (this.pendingParts) {
      this.pendingParts = false;
      const { nodes, meshes } = legends2.finish();
      for (const { mesh, matrix } of meshes) this.#enqueue(mesh, matrix);
      for (const node of nodes) this.queue.push(node); // already posed, world matrices set
    }
    if (this.queue.length === 0) return;
    for (const mesh of shadows.finish(this.queue)) this.queue.push(mesh);
    const screen = this.screen;
    const wide = this.#isWide();
    screen.flush2D(wide);
    if (wide) screen.wide3D = true;
    const frame = frameClock.frame;
    const objects = this.queue;
    const matrices = [];
    const before = []; // where each object was in the previous frame, if it moved
    for (const obj of objects) {
      const u = obj.userData;
      const now = obj.matrixWorld.clone();
      if (u.seen !== frame) {
        u.before = u.seen === frame - 1 ? u.latest : null;
        u.seen = frame;
      }
      u.latest = now;
      matrices.push(now);
      before.push(u.before && !u.before.equals(now) && !jumped(u.before, now) ? u.before : null);
    }
    screen.record3D({
      wide,
      clip: [...this.clip],
      projection: this.projection,
      view: this.view.clone(),
      viewBefore: null, // set by link()
      objects,
      matrices,
      before,
    });
    this.queue = [];
  }

  /** The frame has been presented: drawing instances can be reused for the next one. */
  endFrame() {
    frameClock.frame++;
    for (const obj of this.touched) obj.used = 0;
    this.touched.clear();
    legends2.endFlush();
    shadows.endFrame();
  }

  /**
   * Pair the 3D batches of two consecutive frames for interpolation.
   * @returns {boolean} true when the newer frame can be shown moving on from the older one:
   *   both have the same batches, at least one of them full-screen, and the camera did not cut
   */
  link(olderSteps, newerSteps) {
    const older = olderSteps.filter((s) => !s.layer);
    const newer = newerSteps.filter((s) => !s.layer);
    if (newer.length === 0 || older.length !== newer.length) return false;
    let full = false;
    for (let i = 0; i < newer.length; i++) {
      const a = older[i];
      const b = newer[i];
      if (a.projection.kind !== b.projection.kind || a.clip.join() !== b.clip.join()) return false;
      if (cameraCut(a.view, b.view)) return false;
      b.viewBefore = a.view.equals(b.view) ? null : a.view;
      const [x, y, w, h] = b.clip;
      if (x <= 0 && y <= 0 && w >= 240 && h >= 240) full = true;
    }
    return full;
  }

  /** Draw a recorded batch; `t` (0..1) is how far it has moved on from the previous frame. */
  draw(step, t) {
    const screen = this.screen;
    const r = screen.renderer;
    const k = screen.scale;
    const [x, y, w, h] = step.clip;
    if (step.wide) {
      // widescreen: same vertical field of view, more to see at the sides
      r.setViewport(0, 0, screen.viewWidth * k, 240 * k);
      r.setScissor(0, 0, screen.viewWidth * k, 240 * k);
    } else {
      r.setViewport(screen.xoff * k, 0, 240 * k, 240 * k);
      r.setScissor((screen.xoff + x) * k, (240 - y - h) * k, w * k, h * k);
    }
    r.setScissorTest(true);
    r.clearDepth();
    const moving = t < 1;
    const view = moving && step.viewBefore ? mixView(step.viewBefore, step.view, t) : step.view;
    updateDraw(view, moving ? t : 1, step.wide ? screen.viewWidth : 240, 240);
    this.#updateCamera(step.projection, view, step.wide ? screen.aspect : 1);
    this.scene.children.length = 0;
    const { objects, matrices, before } = step;
    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      obj.matrix.copy(moving && before[i] ? mixMatrix(before[i], matrices[i], t) : matrices[i]);
      obj.matrixWorld.copy(obj.matrix);
      for (const child of obj.children) child.updateMatrixWorld(true); // Legends 2 models
      obj.renderOrder = i;
      obj.parent = this.scene;
      this.scene.children.push(obj);
    }
    r.render(this.scene, this.camera);
    r.setScissorTest(false);
    for (const obj of objects) obj.parent = null;
    this.scene.children.length = 0;
  }
}

// ---- interpolation between game frames ("smooth motion") ---------------------------------------

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _s0 = new THREE.Vector3();
const _s1 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _mix = new THREE.Matrix4();
const _c0 = new THREE.Matrix4();
const _c1 = new THREE.Matrix4();

/** An object that moved this far in one frame was teleported: do not slide it across. */
const JUMP_DISTANCE = 6;
/** A camera that moved or turned this much in one frame was cut to a new shot. */
const CUT_DISTANCE = 10;
const CUT_ANGLE = (50 * Math.PI) / 180;

function jumped(a, b) {
  const ea = a.elements;
  const eb = b.elements;
  return Math.hypot(eb[12] - ea[12], eb[13] - ea[13], eb[14] - ea[14]) > JUMP_DISTANCE;
}

/** Model matrix part of the way from `a` to `b` (returns a shared scratch matrix). */
function mixMatrix(a, b, t) {
  a.decompose(_p0, _q0, _s0);
  b.decompose(_p1, _q1, _s1);
  return _mix.compose(_p0.lerp(_p1, t), _q0.slerp(_q1, t), _s0.lerp(_s1, t));
}

/** View matrix part of the way between two views: the camera itself is moved and turned. */
function mixView(a, b, t) {
  _c0.copy(a).invert().decompose(_p0, _q0, _s0);
  _c1.copy(b).invert().decompose(_p1, _q1, _s1);
  return _c0.compose(_p0.lerp(_p1, t), _q0.slerp(_q1, t), _s0.lerp(_s1, t)).invert();
}

function cameraCut(a, b) {
  if (a.equals(b)) return false;
  _c0.copy(a).invert().decompose(_p0, _q0, _s0);
  _c1.copy(b).invert().decompose(_p1, _q1, _s1);
  return _p0.distanceTo(_p1) > CUT_DISTANCE || _q0.angleTo(_q1) > CUT_ANGLE;
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
