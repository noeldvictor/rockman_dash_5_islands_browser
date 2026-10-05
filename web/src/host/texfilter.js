// Texture filtering for everything drawn in 3D (Settings > Video > Textures):
//   sharp   nearest, exactly the phone's look
//   smooth  bilinear with mipmaps and anisotropic filtering
//   hd      the same, on textures enlarged 4x with the Scale2x (EPX) pixel-art rule applied twice,
//           which keeps edges crisp instead of blurring them
//   ai      the same, on textures enlarged 4x by an image model ahead of time: an optional
//           texture pack (web/public/hd/, made by tools/ai/textures.py), loaded picture by
//           picture as the game creates its textures. A texture is found in the pack by its
//           size and the CRC of its RGB pixels; until its picture has arrived, and for anything
//           the pack lacks, the `hd` version is shown. Textures that are not raw pixels (the
//           Legends 2 models') register with their name in the pack and swap pictures whole
// In the two filtered modes the colour of fully transparent texels (the colour key) is replaced
// by that of their opaque neighbours, so cut-out edges do not pick up a fringe of the key colour.
// Textures register here when created so the setting can be changed while the game runs. Only
// textures made from raw pixels (the game's own) are reprocessed; others just change filter.

import * as THREE from 'three';
import { crc32 } from './contentkey.js';

const entries = new Map(); // texture -> { original: {data, width, height}|null, cache: {} }
let mode = 'sharp';
let maxAnisotropy = 1;
/**
 * The AI texture pack, once its manifest has loaded:
 * { base, textures: { key: { file, keyed? } }, models: { model: { imageIndex: file } } }
 */
let pack = null;
/** The redrawn textures (tools/ai/restyle.py), same format; a texture it lacks falls back to `pack`. */
let redrawn = null;
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
async function loadFromPack(t, entry, which = 'ai') {
  const { original } = entry;
  const from = which === 'redraw' ? redrawn : pack;
  const info = from.textures[packKey(original)];
  if (!info) {
    if (which === 'ai') packStats.missing++;
    return;
  }
  const transparent = original.data.some((v, i) => (i & 3) === 3 && v < 255);
  const response = await fetch(`${from.base}/${transparent && info.keyed ? info.keyed : info.file}`);
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
  entry.cache[which] = { data, width, height };
  packStats.loaded++;
  if ((mode === 'ai' || mode === 'redraw') && entries.has(t)) apply(t, entry);
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

/** A named picture (a Legends 2 model texture) from the pack; it carries its own transparency. */
async function loadNamed(t, entry) {
  const [model, index] = entry.packName;
  const file = pack.models?.[model]?.[index];
  if (!file) {
    packStats.missing++;
    return;
  }
  const response = await fetch(`${pack.base}/${file}`);
  if (!response.ok) return;
  entry.cache.ai = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  packStats.loaded++;
  if (mode === 'ai' && entries.has(t)) apply(t, entry);
}

function imageFor(t, entry) {
  const { original, cache } = entry;
  if (mode === 'sharp') return original;
  let kind = mode;
  if (mode === 'ai' || mode === 'redraw') {
    // redrawn if there is one, else the upscaled one, else enlarged here
    if (mode === 'redraw') {
      if (cache.redraw) return cache.redraw;
      if (redrawn && !entry.requestedRedraw) {
        entry.requestedRedraw = true;
        loadFromPack(t, entry, 'redraw').catch((e) => console.warn('[textures] redrawn picture failed', e));
      }
    }
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
  let image = null;
  if (entry.original) image = imageFor(t, entry);
  else if (entry.packName) {
    // not raw pixels: the picture is swapped whole, when the pack has one
    image = entry.source;
    if (mode === 'ai' || mode === 'redraw') {
      if (entry.cache.ai) image = entry.cache.ai;
      else if (pack && !entry.requested) {
        entry.requested = true;
        loadNamed(t, entry).catch((e) => console.warn('[textures] pack picture failed', e));
      }
    }
  }
  if (image && t.image !== image) {
    if (t.image.width !== image.width) {
      // a different size needs new GPU storage
      entry.replacing = true;
      t.dispose();
      entry.replacing = false;
    }
    t.image = image;
  }
  t.magFilter = filtered ? THREE.LinearFilter : THREE.NearestFilter;
  t.minFilter = filtered ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter;
  t.generateMipmaps = filtered;
  t.anisotropy = filtered ? maxAnisotropy : 1;
  t.needsUpdate = true;
}

/**
 * Give a newly created texture the current filtering and keep it in sync with the setting.
 * @param {[string, string]} [packName]  for a texture that is not raw pixels: [model, image index]
 *                                       under which the AI texture pack lists its picture
 */
export function registerTexture(t, packName = null) {
  const raw = t.isDataTexture && t.image?.data instanceof Uint8Array && t.format === THREE.RGBAFormat;
  const entry = { original: raw ? t.image : null, source: t.image, packName, cache: {}, replacing: false };
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
export async function loadTexturePack(base, which = 'ai') {
  try {
    const response = await fetch(`${base}/manifest.json`);
    if (!response.ok) return false;
    const manifest = await response.json();
    const loaded = { base, textures: manifest.textures ?? {}, models: manifest.models ?? {} };
    if (which === 'redraw') redrawn = loaded;
    else pack = loaded;
  } catch {
    return false;
  }
  if (mode === 'ai' || mode === 'redraw') for (const [t, entry] of entries) apply(t, entry);
  return true;
}

/** @param {'sharp'|'smooth'|'hd'|'ai'|'redraw'} value */
export function setTextureFilter(value) {
  const next = ['smooth', 'hd', 'ai', 'redraw'].includes(value) ? value : 'sharp';
  if (next === mode) return;
  mode = next;
  for (const [t, entry] of entries) apply(t, entry);
}

/** The most anisotropic filtering the graphics card offers (capped; set once at start). */
export function setMaxAnisotropy(value) {
  maxAnisotropy = Math.max(1, Math.min(16, value | 0));
}
