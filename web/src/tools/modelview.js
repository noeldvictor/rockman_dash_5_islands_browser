// Development tool, not part of the game: renders the phone game's models (MBAC figures, with
// their BMP textures and optionally a pose from an MTRA action) and .glb files to PNG pictures.
// Loaded by web/modelview.html (dev server only; the production build has one page) and driven
// from tools/ai/ through a headless browser:
//
//   await window.renderPhoneModel({ model, textures, action, actionIndex, frame, pattern, views, size })
//   await window.renderGlb({ glb, views, size })
//
// `model`, `textures[]`, `action`, `glb` are base64; `views` is a list of [yaw, pitch] in
// degrees (yaw 0 = the model's front). Both return a list of PNG data URLs, one per view, with
// the model centred and fitted on a plain background.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { parseMBAC, parseMTRA, poseModel, getActionPattern } from '../formats/mbac.js';
import { decodeBMP8 } from '../formats/bmp.js';

const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function textureOf(bmp, colorKey) {
  const { width, height, palette, indices } = decodeBMP8(bmp);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < indices.length; i++) {
    const p = indices[i] * 4;
    data[i * 4] = palette[p];
    data[i * 4 + 1] = palette[p + 1];
    data[i * 4 + 2] = palette[p + 2];
    data[i * 4 + 3] = colorKey && indices[i] === 0 ? 0 : 255; // palette index 0 is the colour key
  }
  const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

/** The phone model as a three.js group, in the pose and face pattern asked for. */
function phoneGroup({ model, textures = [], action, actionIndex = 0, frame = 0, pattern }) {
  const m = parseMBAC(bytes(model));
  const table = action ? parseMTRA(bytes(action)) : null;
  const posed = new Float32Array(m.numVertices * 3);
  poseModel(m, table, actionIndex, frame, posed);
  const shown = pattern ?? (table ? getActionPattern(table, actionIndex, frame, 0) : 0);
  const maps = textures.map((t) => bytes(t));
  const group = new THREE.Group();
  for (const b of m.batches) {
    const pos = [];
    const uv = [];
    const col = [];
    const bmp = b.textured ? (maps[b.textureIndex] ?? maps[0]) : null;
    const width = bmp ? decodeBMP8(bmp).width : 1;
    for (let t = 0; t < b.numTriangles; t++) {
      const mask = b.patternUnion !== 0 ? b.trianglePattern[t] : 0;
      if ((mask & shown) !== mask) continue;
      for (let c = t * 3; c < t * 3 + 3; c++) {
        const v = b.cornerVertex[c] * 3;
        pos.push(posed[v], posed[v + 1], posed[v + 2]);
        // the engine divides both axes by the texture width
        if (b.textured) uv.push(b.uvs[c * 2] / width, b.uvs[c * 2 + 1] / width);
        else if (b.colors) col.push(b.colors[c * 3] / 255, b.colors[c * 3 + 1] / 255, b.colors[c * 3 + 2] / 255);
      }
    }
    if (!pos.length || (b.textured && !bmp)) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    if (b.textured) {
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      mat.map = textureOf(bmp, b.transparent);
      mat.map.flipY = false;
      mat.alphaTest = b.transparent ? 0.5 : 0;
    } else if (col.length) {
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      mat.vertexColors = true;
    }
    group.add(new THREE.Mesh(g, mat));
  }
  return group;
}

let renderer = null;

/** Render `object` from each [yaw, pitch], fitted to the frame. */
function shoot(object, { views = [[0, 0]], size = 1024, background = '#ffffff', lit = false }) {
  renderer ??= new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  scene.add(object);
  if (lit) {
    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(1, 2, 3);
    scene.add(sun);
  }
  const box = new THREE.Box3().setFromObject(object);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  const camera = new THREE.PerspectiveCamera(30, 1, radius / 50, radius * 50);
  const distance = (radius / Math.sin((15 * Math.PI) / 180)) * 1.02;
  const out = [];
  for (const [yaw, pitch] of views) {
    const y = (yaw * Math.PI) / 180;
    const p = (pitch * Math.PI) / 180;
    camera.position.set(
      centre.x + distance * Math.sin(y) * Math.cos(p),
      centre.y + distance * Math.sin(p),
      centre.z + distance * Math.cos(y) * Math.cos(p),
    );
    camera.lookAt(centre);
    renderer.render(scene, camera);
    out.push(renderer.domElement.toDataURL('image/png'));
  }
  return out;
}

window.renderPhoneModel = async (options) => shoot(phoneGroup(options), options);

window.renderGlb = async (options) => {
  const gltf = await new GLTFLoader().parseAsync(bytes(options.glb).buffer, '');
  return shoot(gltf.scene, { lit: true, ...options });
};

window.glbInfo = async (options) => {
  const gltf = await new GLTFLoader().parseAsync(bytes(options.glb).buffer, '');
  let triangles = 0;
  const maps = new Set();
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m.map) maps.add(m.map);
  });
  const first = [...maps][0]?.image;
  const box = new THREE.Box3().setFromObject(gltf.scene);
  return { triangles, textures: maps.size, textureSize: first ? `${first.width}x${first.height}` : '', min: box.min.toArray(), max: box.max.toArray() };
};

/** A .glb as the game would draw it: unlit, texture colours as they are. */
async function glbGroup(glb) {
  const gltf = await new GLTFLoader().parseAsync(bytes(glb).buffer, '');
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const flat = (m) => new THREE.MeshBasicMaterial({ map: m.map, side: THREE.DoubleSide });
    o.material = Array.isArray(o.material) ? o.material.map(flat) : flat(o.material);
  });
  gltf.scene.updateMatrixWorld(true);
  return gltf.scene;
}

/** Small orthographic pictures of `object` from the front, the left and above, framed on `box`. */
function probe(object, box, size = 96) {
  renderer ??= new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#ffffff');
  scene.add(object);
  const centre = box.getCenter(new THREE.Vector3());
  const half = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, half * 8);
  const gl = renderer.getContext();
  const out = [];
  for (const [dir, up] of [[[0, 0, 1], [0, 1, 0]], [[1, 0, 0], [0, 1, 0]], [[0, 1, 0], [0, 0, -1]]]) {
    camera.position.set(centre.x + dir[0] * half * 3, centre.y + dir[1] * half * 3, centre.z + dir[2] * half * 3);
    camera.up.set(...up);
    camera.lookAt(centre);
    renderer.render(scene, camera);
    const px = new Uint8Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
    out.push(px);
  }
  scene.remove(object);
  return out;
}

/**
 * Fit a remade model to the phone model it replaces: the same bounding box, and of the four
 * upright orientations the one that looks most like it from the front, the side and above.
 * Returns the 4x4 matrix (column-major, three.js order) from .glb space to phone model units.
 */
window.fitGlb = async (options) => {
  const phone = phoneGroup(options);
  const target = new THREE.Box3().setFromObject(phone);
  const want = probe(phone, target);
  const scene = await glbGroup(options.glb);
  const source = new THREE.Box3().setFromObject(scene);
  const from = source.getCenter(new THREE.Vector3());
  const to = target.getCenter(new THREE.Vector3());
  const size = target.getSize(new THREE.Vector3());
  const holder = new THREE.Group();
  holder.add(scene);
  holder.matrixAutoUpdate = false;
  let best = null;
  for (let turn = 0; turn < 4; turn++) {
    const s = source.getSize(new THREE.Vector3());
    if (turn % 2) [s.x, s.z] = [s.z, s.x]; // a quarter turn swaps the footprint
    // the phone model's height exactly; its footprint too, unless that would distort the shape
    const k = size.y / s.y;
    // ... but a flat object (a door panel) gets exactly the phone model's thickness, less a
    // little: it slides into a wall that leaves it no room (see `flat` in mods/remake.js)
    const thin = Math.min(size.x, size.z) < 0.25 * Math.max(size.x, size.y, size.z) ? (size.x < size.z ? 'x' : 'z') : '';
    const fit = (a, b, axis) => (axis === thin
      ? (Math.max(a, size.y * 0.01) * 0.9) / b
      : Math.min(1.3, Math.max(0.77, a / b / k)) * k);
    const matrix = new THREE.Matrix4().makeTranslation(to.x, to.y, to.z)
      .multiply(new THREE.Matrix4().makeScale(fit(size.x, s.x, 'x'), k, fit(size.z, s.z, 'z')))
      .multiply(new THREE.Matrix4().makeRotationY((turn * Math.PI) / 2))
      .multiply(new THREE.Matrix4().makeTranslation(-from.x, -from.y, -from.z));
    holder.matrix.copy(matrix);
    holder.updateMatrixWorld(true);
    const got = probe(holder, target);
    let diff = 0;
    for (let v = 0; v < 3; v++) for (let i = 0; i < got[v].length; i++) diff += Math.abs(got[v][i] - want[v][i]);
    const score = diff / (3 * got[0].length);
    if (!best || score < best.score) best = { score, turn, matrix: matrix.toArray(), flat: thin !== '' };
  }
  // for checking by eye: the phone model and the fitted one from the same two corners
  holder.matrix.fromArray(best.matrix);
  holder.updateMatrixWorld(true);
  const views = { views: [[28, 12], [208, 12]], size: options.size ?? 512 };
  best.pictures = [...shoot(phone, views), ...shoot(holder, views)];
  return best;
};

window.modelInfo = (options) => {
  const m = parseMBAC(bytes(options.model));
  return { bones: m.numBones, vertices: m.numVertices, patterns: m.numPatterns, textures: m.numTextures,
    triangles: m.batches.reduce((n, b) => n + b.numTriangles, 0), bounds: m.bounds };
};

window.modelviewReady = true;
