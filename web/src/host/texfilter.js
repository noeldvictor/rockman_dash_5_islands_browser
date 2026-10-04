// Texture filtering for everything drawn in 3D (Settings > Video > Textures):
//   sharp   nearest, exactly the phone's look
//   smooth  bilinear with mipmaps and anisotropic filtering
//   hd      the same, on textures enlarged 4x with the Scale2x (EPX) pixel-art rule applied twice,
//           which keeps edges crisp instead of blurring them
//   ai      the same, on textures enlarged 4x by an image model ahead of time: an optional
//           texture pack (web/public/hd/, made by tools/ai/textures.py), loaded picture by
//           picture as the game creates its textures. A texture is found in the pack by its
//           size and the CRC of its RGB pixels; until its picture has arrived, and for anything
//           the pack lacks, the `hd` version is shown
// In the two filtered modes the colour of fully transparent texels (the colour key) is replaced
// by that of their opaque neighbours, so cut-out edges do not pick up a fringe of the key colour.
// Textures register here when created so the setting can be changed while the game runs. Only
// textures made from raw pixels (the game's own) are reprocessed; others just change filter.

import * as THREE from 'three';
import { crc32 } from './contentkey.js';

const entries = new Map(); // texture -> { original: {data, width, height}|null, cache: {} }
let mode = 'sharp';
let maxAnisotropy = 1;
/** The AI texture pack, once its manifest has loaded: { base, textures: { key: { file, keyed? } } } */
let pack = null;
/** Diagnostics: textures taken from the pack / not found in it. */
export const packStats = { loaded: 0, missing: 0 };

/** "<width>x<height>:<crc32 of the RGB pixels>", as tools/ai/textures.py names its pictures. */
function packKey({ data, width, height }) {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, n = width * height; i < n; i++) {
    rgb[i * 3] = data[i * 4];
    rgb[i * 3 + 1] = data[i * 4 + 1];
    rgb[i * 3 + 2] = data[i * 4 + 2];
  }
  return `${width}x${height}:${crc32(rgb)}`;
}

/** Fetch a texture's picture from the pack; its transparency is the original's, enlarged smoothly. */
async function loadFromPack(t, entry) {
  const { original } = entry;
  const info = pack.textures[packKey(original)];
  if (!info) {
    packStats.missing++;
    return;
  }
  const transparent = original.data.some((v, i) => (i & 3) === 3 && v < 255);
  const response = await fetch(`${pack.base}/${transparent && info.keyed ? info.keyed : info.file}`);
  if (!response.ok) return;
  const bitmap = await createImageBitmap(await response.blob());
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const data = new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer);
  if (transparent) {
    // draw the original's alpha as a grey picture, enlarged with smoothing, and read it back
    const small = new OffscreenCanvas(original.width, original.height);
    const grey = new Uint8ClampedArray(original.data.length);
    for (let i = 0; i < grey.length; i += 4) {
      grey[i] = grey[i + 1] = grey[i + 2] = original.data[i + 3];
      grey[i + 3] = 255;
    }
    small.getContext('2d').putImageData(new ImageData(grey, original.width, original.height), 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, width, height);
    const alpha = ctx.getImageData(0, 0, width, height).data;
    for (let i = 0; i < data.length; i += 4) data[i + 3] = alpha[i];
  }
  entry.cache.ai = { data, width, height };
  packStats.loaded++;
  if (mode === 'ai' && entries.has(t)) apply(t, entry);
}

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

function imageFor(t, entry) {
  const { original, cache } = entry;
  if (mode === 'sharp') return original;
  let kind = mode;
  if (mode === 'ai') {
    if (cache.ai) return cache.ai;
    if (pack && !entry.requested) {
      entry.requested = true;
      loadFromPack(t, entry).catch((e) => console.warn('[textures] pack picture failed', e));
    }
    kind = 'hd'; // until the picture arrives, or if the pack has none
  }
  if (!cache[kind]) {
    let { data, width, height } = original;
    if (kind === 'hd') {
      for (let i = 0; i < 2; i++) {
        data = scale2x(data, width, height);
        width *= 2;
        height *= 2;
      }
    }
    cache[kind] = { data: bleed(data, width, height), width, height };
  }
  return cache[kind];
}

function apply(t, entry) {
  const filtered = mode !== 'sharp';
  if (entry.original) {
    const image = imageFor(t, entry);
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

/**
 * Look for the AI texture pack under `base` (manifest.json + one PNG per texture).
 * @returns {Promise<boolean>} whether there is one
 */
export async function loadTexturePack(base) {
  try {
    const response = await fetch(`${base}/manifest.json`);
    if (!response.ok) return false;
    pack = { base, textures: (await response.json()).textures };
  } catch {
    return false;
  }
  if (mode === 'ai') for (const [t, entry] of entries) apply(t, entry);
  return true;
}

/** @param {'sharp'|'smooth'|'hd'|'ai'} value */
export function setTextureFilter(value) {
  const next = ['smooth', 'hd', 'ai'].includes(value) ? value : 'sharp';
  if (next === mode) return;
  mode = next;
  for (const [t, entry] of entries) apply(t, entry);
}

/** The most anisotropic filtering the graphics card offers (capped; set once at start). */
export function setMaxAnisotropy(value) {
  maxAnisotropy = Math.max(1, Math.min(16, value | 0));
}
