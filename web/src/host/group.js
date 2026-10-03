// Map scenes: a DoJa Group created from .d4d data (an M3G object stream, see formats/d4d.js).
//
// By the time the bytes reach Object3D.createInstance() the game has already spliced the map's
// BMP textures into the stream as paletted RGBA images, so everything needed is in `bytes`.

import * as THREE from 'three';
import { parseD4D, d4dTextureTranslationAt } from '../formats/d4d.js';
import { TYPE } from './g3d.js';
import { MODEL_FLIP } from './conventions.js';

function imageTexture(image, opaque) {
  const { width, height, palette, pixels, bytesPerPixel, isPaletted } = image;
  const rgba = new Uint8Array(width * height * 4);
  const src = isPaletted ? palette : pixels;
  for (let i = 0, n = width * height; i < n; i++) {
    const s = (isPaletted ? pixels[i] : i) * bytesPerPixel;
    if (bytesPerPixel >= 3) {
      rgba[i * 4] = src[s];
      rgba[i * 4 + 1] = src[s + 1];
      rgba[i * 4 + 2] = src[s + 2];
      rgba[i * 4 + 3] = opaque || bytesPerPixel === 3 ? 255 : src[s + 3];
    } else {
      // luminance (+ alpha)
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = src[s];
      rgba[i * 4 + 3] = opaque || bytesPerPixel === 1 ? 255 : src[s + 1];
    }
  }
  const t = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.flipY = false; // M3G texture space: t = 0 is the top row
  t.needsUpdate = true;
  return t;
}

class Group3D {
  type = TYPE.GROUP;
  blendMode = 0;
  transparency = 100;
  used = 0;

  constructor(bytes) {
    this.meshes = [];
    this.animated = []; // { texture: THREE.Texture, index: scene texture index }
    this.time = 0;
    this.disposables = [];
    if (!bytes) return; // an empty Group made by `new Group()`
    // The game hands over its whole (fixed-size) work buffer; the header says how much is data.
    const size = 10 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
    const scene = parseD4D(bytes.subarray(0, Math.min(size, bytes.length)));
    this.scene = scene;
    for (const w of scene.warnings) console.warn('[d4d]', w);

    const local = new THREE.Matrix4().copy(MODEL_FLIP);
    for (const mesh of scene.meshes) {
      const position = new THREE.BufferAttribute(mesh.positions, 3);
      const uv = mesh.uvs ? new THREE.BufferAttribute(mesh.uvs, 2) : null;
      const color = mesh.colors
        ? new THREE.BufferAttribute(mesh.colors, mesh.colorItemSize, true)
        : null;
      // draw order: appearance layer, then opaque before blended (M3G rules)
      const order = mesh.submeshes
        .map((s, i) => ({ s, i, m: scene.materials[s.material] }))
        .sort((a, b) => (a.m.layer - b.m.layer) || (a.m.transparent - b.m.transparent) || (a.i - b.i));
      for (const { s, m } of order) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', position);
        if (uv) g.setAttribute('uv', uv);
        if (color) g.setAttribute('color', color);
        g.setIndex(new THREE.BufferAttribute(s.indices, 1));
        this.disposables.push(g);

        let map = null;
        if (m.texture >= 0 && uv) {
          const tex = scene.textures[m.texture];
          const image = scene.images[tex.image];
          map = imageTexture(image, !m.usesTextureAlpha);
          this.disposables.push(map);
          if (tex.animationTracks.length) this.animated.push({ texture: map, index: m.texture });
        }
        const material = new THREE.MeshBasicMaterial({
          map,
          vertexColors: !!color,
          side: THREE.DoubleSide,
          alphaTest: m.alphaThreshold > 0 ? m.alphaThreshold / 255 : 0,
          transparent: m.transparent,
          blending: m.blendMode === 'alphaAdd' ? THREE.AdditiveBlending : THREE.NormalBlending,
          depthTest: m.depthTest,
          depthWrite: m.depthWrite,
          polygonOffset: m.depthOffsetFactor !== 0 || m.depthOffsetUnits !== 0,
          polygonOffsetFactor: m.depthOffsetFactor,
          polygonOffsetUnits: m.depthOffsetUnits,
        });
        if (!color) material.color.setRGB(mesh.defaultColor[0] / 255, mesh.defaultColor[1] / 255, mesh.defaultColor[2] / 255);
        this.disposables.push(material);
        const node = new THREE.Mesh(g, material);
        node.frustumCulled = false;
        node.matrixAutoUpdate = false;
        node.userData.local = local;
        this.meshes.push(node);
      }
    }
  }

  // Group API (only used for groups the game builds itself, which it never does)
  add() {}
  removeAt() {}
  setTransform() {}

  setTime(t) {
    this.time = t;
  }

  build() {
    for (const a of this.animated) {
      const [x, y] = d4dTextureTranslationAt(this.scene, a.index, this.time);
      a.texture.offset.set(x, y);
    }
    return this.meshes;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.meshes.length = 0;
  }
}

export function createGroup(bytes) {
  return new Group3D(bytes);
}
