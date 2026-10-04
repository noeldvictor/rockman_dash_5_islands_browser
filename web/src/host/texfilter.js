// Texture filtering for everything drawn in 3D (Settings > Video > Textures):
//   sharp   nearest, exactly the phone's look
//   smooth  bilinear with mipmaps and anisotropic filtering
//   hd      the same, on textures enlarged 4x with the Scale2x (EPX) pixel-art rule applied twice,
//           which keeps edges crisp instead of blurring them
// In the two filtered modes the colour of fully transparent texels (the colour key) is replaced
// by that of their opaque neighbours, so cut-out edges do not pick up a fringe of the key colour.
// Textures register here when created so the setting can be changed while the game runs. Only
// textures made from raw pixels (the game's own) are reprocessed; others just change filter.

import * as THREE from 'three';

const entries = new Map(); // texture -> { original: {data, width, height}|null, cache: {} }
let mode = 'sharp';
let maxAnisotropy = 1;

/** Give transparent texels the average colour of their opaque neighbours (alpha stays 0). */
function bleed(data, width, height) {
  const out = data.slice();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (data[o + 3] !== 0) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          // textures repeat, so neighbours wrap around
          const p = (((y + dy + height) % height) * width + ((x + dx + width) % width)) * 4;
          if (data[p + 3] === 0) continue;
          r += data[p];
          g += data[p + 1];
          b += data[p + 2];
          n++;
        }
      }
      if (n) {
        out[o] = r / n;
        out[o + 1] = g / n;
        out[o + 2] = b / n;
      }
    }
  }
  return out;
}

/** Scale2x / EPX: double an image, sharpening diagonals by copying matching neighbours. */
function scale2x(data, width, height) {
  const src = new Uint32Array(data.buffer, data.byteOffset, width * height);
  const out = new Uint8Array(width * height * 16);
  const dst = new Uint32Array(out.buffer);
  const w2 = width * 2;
  for (let y = 0; y < height; y++) {
    const up = ((y + height - 1) % height) * width;
    const row = y * width;
    const down = ((y + 1) % height) * width;
    for (let x = 0; x < width; x++) {
      const l = (x + width - 1) % width;
      const r = (x + 1) % width;
      const p = src[row + x];
      const a = src[up + x], b = src[row + r], c = src[row + l], d = src[down + x];
      const o = y * 2 * w2 + x * 2;
      const differ = c !== b && a !== d;
      dst[o] = differ && c === a ? a : p;
      dst[o + 1] = differ && a === b ? b : p;
      dst[o + w2] = differ && d === c ? c : p;
      dst[o + w2 + 1] = differ && b === d ? d : p;
    }
  }
  return out;
}

function imageFor(entry) {
  const { original, cache } = entry;
  if (mode === 'sharp') return original;
  if (!cache[mode]) {
    let { data, width, height } = original;
    if (mode === 'hd') {
      for (let i = 0; i < 2; i++) {
        data = scale2x(data, width, height);
        width *= 2;
        height *= 2;
      }
    }
    cache[mode] = { data: bleed(data, width, height), width, height };
  }
  return cache[mode];
}

function apply(t, entry) {
  const filtered = mode !== 'sharp';
  if (entry.original) {
    const image = imageFor(entry);
    if (t.image !== image) {
      if (t.image.width !== image.width) {
        // a different size needs new GPU storage
        entry.replacing = true;
        t.dispose();
        entry.replacing = false;
      }
      t.image = image;
    }
  }
  t.magFilter = filtered ? THREE.LinearFilter : THREE.NearestFilter;
  t.minFilter = filtered ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter;
  t.generateMipmaps = filtered;
  t.anisotropy = filtered ? maxAnisotropy : 1;
  t.needsUpdate = true;
}

/** Give a newly created texture the current filtering and keep it in sync with the setting. */
export function registerTexture(t) {
  const raw = t.isDataTexture && t.image?.data instanceof Uint8Array && t.format === THREE.RGBAFormat;
  const entry = { original: raw ? t.image : null, cache: {}, replacing: false };
  entries.set(t, entry);
  t.addEventListener('dispose', () => {
    if (!entry.replacing) entries.delete(t);
  });
  apply(t, entry);
  return t;
}

/** @param {'sharp'|'smooth'|'hd'} value */
export function setTextureFilter(value) {
  const next = value === 'smooth' || value === 'hd' ? value : 'sharp';
  if (next === mode) return;
  mode = next;
  for (const [t, entry] of entries) apply(t, entry);
}

/** The most anisotropic filtering the graphics card offers (capped; set once at start). */
export function setMaxAnisotropy(value) {
  maxAnisotropy = Math.max(1, Math.min(16, value | 0));
}
