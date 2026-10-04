// DoJa 2D Graphics on Canvas2D.
//
// All coordinates the game passes are in the phone's 240x240 logical space. Mutable surfaces (the
// screen layer and Image.createImage() images) are backed by canvases `scale` times larger with a
// scaled context, so text and shapes come out sharp at any size; decoded GIF/BMP art stays at its
// native resolution and is scaled with nearest-neighbour.

import { decodeImage } from './images.js';

const LOADING_LINE = /do not (press|push) any buttons/i;
const FONT_FAMILY = '"DejaVu Sans Mono", "Menlo", "Consolas", "Liberation Mono", monospace';

/** An image the game can draw, and (when mutable) draw into. */
export class Img {
  /**
   * @param {HTMLCanvasElement|OffscreenCanvas} canvas
   * @param {number} width   logical width
   * @param {number} height  logical height
   * @param {number} scale   canvas pixels per logical pixel
   */
  constructor(canvas, width, height, scale) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    this.scale = scale;
    this.g = null;
  }

  static fromRGBA({ width, height, rgba }) {
    const canvas = makeCanvas(width, height);
    canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    return new Img(canvas, width, height, 1);
  }

  static decode(bytes) {
    const d = decodeImage(bytes);
    return d ? Img.fromRGBA(d) : null;
  }

  graphics() {
    if (!this.g) this.g = new G2D(this.canvas.getContext('2d'), this.scale, null);
    return this.g;
  }

  dispose() {
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.g = null;
  }
}

export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const cssColor = (c) => `rgb(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255})`;

export class G2D {
  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} scale
   * @param {import('./screen.js').Screen|null} screen  set for the display surface
   */
  constructor(ctx, scale, screen) {
    this.screen = screen;
    this.g3d = screen ? screen.g3d : NO_3D;
    this.flip = 0;
    this.ox = 0;
    this.oy = 0;
    this.clip = null;
    this.color = '#000';
    this.fontPx = 24;
    this.fontCss = `24px ${FONT_FAMILY}`;
    this.bind(ctx, scale);
  }

  /**
   * (Re)attach to a context, e.g. after the screen was resized.
   * @param {number} [left] logical x of the game's origin on this surface (widescreen)
   */
  bind(ctx, scale, left = 0) {
    this.ctx = ctx;
    this.scale = scale;
    this.left = left;
    ctx.setTransform(scale, 0, 0, scale, left * scale, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    ctx.save();
    this.#applyClip();
  }

  #applyClip() {
    const ctx = this.ctx;
    ctx.restore();
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    let clip = this.clip;
    if (this.screen) {
      // the display surface may be wider than the phone's screen (widescreen): never let the
      // game's 2D drawing spill outside its own 240x240 area
      if (!clip) clip = [0, 0, 240, 240];
      else {
        const x0 = Math.max(0, clip[0]);
        const y0 = Math.max(0, clip[1]);
        clip = [x0, y0, Math.max(0, Math.min(240, clip[0] + clip[2]) - x0),
          Math.max(0, Math.min(240, clip[1] + clip[3]) - y0)];
      }
    }
    if (clip) {
      const [x, y, w, h] = clip;
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
    }
  }

  #touch() {
    if (this.screen) this.screen.dirty2D = true;
  }

  /** Erase the whole surface to transparent, ignoring the clip. */
  clearSurface() {
    const ctx = this.ctx;
    ctx.restore(); // back to the unclipped base state
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    this.#applyClip();
  }

  lock() {
    if (this.screen) this.screen.lockCount++;
  }

  /** @returns {boolean} true when the display was presented */
  unlock(force) {
    const s = this.screen;
    if (!s) return false;
    s.lockCount = force ? 0 : Math.max(0, s.lockCount - 1);
    if (s.lockCount > 0) return false;
    s.present();
    return true;
  }

  setColor(c) {
    this.color = cssColor(c);
  }

  setFont(px, bold, italic) {
    this.fontPx = px;
    this.fontCss = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${px}px ${FONT_FAMILY}`;
  }

  setOrigin(x, y) {
    this.ox = x;
    this.oy = y;
  }

  setClip(x, y, w, h) {
    this.clip = [x + this.ox, y + this.oy, w, h];
    this.#applyClip();
  }

  clearClip() {
    this.clip = null;
    this.#applyClip();
  }

  fillRect(x, y, w, h) {
    this.ctx.fillStyle = this.color;
    this.ctx.fillRect(x + this.ox, y + this.oy, w, h);
    this.#touch();
  }

  clearRect(x, y, w, h) {
    // DoJa clears to the frame background colour (white by default; the game repaints anyway)
    this.ctx.fillStyle = '#fff';
    this.ctx.fillRect(x + this.ox, y + this.oy, w, h);
    this.#touch();
  }

  drawRect(x, y, w, h) {
    const ctx = this.ctx;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + this.ox + 0.5, y + this.oy + 0.5, w, h);
    this.#touch();
  }

  drawLine(x1, y1, x2, y2) {
    const ctx = this.ctx;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1;
    ctx.lineCap = 'square';
    ctx.beginPath();
    ctx.moveTo(x1 + this.ox + 0.5, y1 + this.oy + 0.5);
    ctx.lineTo(x2 + this.ox + 0.5, y2 + this.oy + 0.5);
    ctx.stroke();
    this.#touch();
  }

  /** Angles in degrees, counter-clockwise from 3 o'clock. */
  arc(x, y, w, h, start, sweep, fill) {
    const ctx = this.ctx;
    const cx = x + this.ox + w / 2;
    const cy = y + this.oy + h / 2;
    const a0 = (-start * Math.PI) / 180;
    const a1 = (-(start + sweep) * Math.PI) / 180;
    ctx.beginPath();
    if (fill && Math.abs(sweep) < 360) ctx.moveTo(cx, cy);
    ctx.ellipse(cx, cy, w / 2, h / 2, 0, a0, a1, sweep > 0);
    if (fill) {
      ctx.closePath();
      ctx.fillStyle = this.color;
      ctx.fill();
    } else {
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    this.#touch();
  }

  polygon(xs, ys, off, n, fill) {
    if (n < 2) return;
    const ctx = this.ctx;
    const d = fill ? 0 : 0.5;
    ctx.beginPath();
    ctx.moveTo(xs[off] + this.ox + d, ys[off] + this.oy + d);
    for (let i = 1; i < n; i++) ctx.lineTo(xs[off + i] + this.ox + d, ys[off + i] + this.oy + d);
    if (fill) {
      ctx.closePath();
      ctx.fillStyle = this.color;
      ctx.fill();
    } else {
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    this.#touch();
  }

  /** (x, y) is the left end of the baseline. Glyphs sit on the phone's fixed-pitch grid. */
  drawString(s, x, y) {
    // Loading screens all carry this line; while one is showing, the game's 15 fps limiter is
    // bypassed (rdash.GameHooks) so loading is not artificially slow.
    if (this.screen && LOADING_LINE.test(s)) globalThis.DOJA.loadingUntil = performance.now() + 250;
    const ctx = this.ctx;
    ctx.font = this.fontCss;
    ctx.fillStyle = this.color;
    const half = this.fontPx / 2;
    let cx = x + this.ox;
    const by = y + this.oy;
    for (const ch of s) {
      const code = ch.codePointAt(0);
      if (code < 0x20) continue; // the game's strings carry trailing NULs; they have no glyph
      const cell = code < 0x100 || (code >= 0xff61 && code <= 0xff9f) ? half : this.fontPx;
      if (code !== 0x20) ctx.fillText(ch, cx + cell / 2, by, cell);
      cx += cell;
    }
    this.#touch();
  }

  drawImage(img, dx, dy, dw, dh, sx, sy, sw, sh) {
    if (!img.canvas.width) return;
    if (sw < 0) {
      sw = img.width;
      sh = img.height;
    }
    if (dw < 0) {
      dw = sw;
      dh = sh;
    }
    // clamp the source rectangle to the image, shrinking the destination to match
    if (sx < 0) { dx -= (sx * dw) / sw; dw += (sx * dw) / sw; sw += sx; sx = 0; }
    if (sy < 0) { dy -= (sy * dh) / sh; dh += (sy * dh) / sh; sh += sy; sy = 0; }
    if (sx + sw > img.width) { dw = (dw * (img.width - sx)) / sw; sw = img.width - sx; }
    if (sy + sh > img.height) { dh = (dh * (img.height - sy)) / sh; sh = img.height - sy; }
    if (sw <= 0 || sh <= 0 || dw === 0 || dh === 0) return;
    const ctx = this.ctx;
    const k = img.scale;
    dx += this.ox;
    dy += this.oy;
    if (this.flip === 0) {
      ctx.drawImage(img.canvas, sx * k, sy * k, sw * k, sh * k, dx, dy, dw, dh);
    } else {
      ctx.save();
      ctx.translate(dx + dw / 2, dy + dh / 2);
      switch (this.flip) {
        case 1: ctx.scale(-1, 1); break;
        case 2: ctx.scale(1, -1); break;
        case 3: ctx.scale(-1, -1); break;
        case 4: ctx.rotate(-Math.PI / 2); break;
        case 5: ctx.rotate(Math.PI / 2); break;
        case 6: ctx.rotate(Math.PI / 2); ctx.scale(-1, 1); break;
        case 7: ctx.rotate(Math.PI / 2); ctx.scale(1, -1); break;
      }
      ctx.drawImage(img.canvas, sx * k, sy * k, sw * k, sh * k, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    }
    this.#touch();
  }

  /**
   * Affine blit: m = [a, b, tx, c, d, ty] in 20.12 fixed point, mapping source pixel (u, v)
   * (relative to the source rectangle) to x = a*u + b*v + tx, y = c*u + d*v + ty.
   */
  drawImageAffine(img, m, sx, sy, w, h) {
    if (!img.canvas.width) return;
    if (w < 0) {
      w = img.width;
      h = img.height;
    }
    const ctx = this.ctx;
    const k = img.scale;
    const f = 1 / 4096;
    ctx.save();
    ctx.transform(m[0] * f, m[3] * f, m[1] * f, m[4] * f, m[2] * f + this.ox, m[5] * f + this.oy);
    ctx.drawImage(img.canvas, sx * k, sy * k, w * k, h * k, 0, 0, w, h);
    ctx.restore();
    this.#touch();
  }

  setRGBPixels(x, y, w, h, px, off) {
    if (w <= 0 || h <= 0) return;
    const tmp = makeCanvas(w, h);
    const id = new ImageData(w, h);
    const d = id.data;
    for (let i = 0, n = w * h; i < n; i++) {
      const c = px[off + i];
      d[i * 4] = (c >> 16) & 255;
      d[i * 4 + 1] = (c >> 8) & 255;
      d[i * 4 + 2] = c & 255;
      d[i * 4 + 3] = 255;
    }
    tmp.getContext('2d').putImageData(id, 0, 0);
    this.ctx.drawImage(tmp, x + this.ox, y + this.oy, w, h);
    this.#touch();
  }

  getRGBPixels(x, y, w, h, px, off) {
    if (this.screen) {
      // The display is composed on the GPU; reading it back is not supported.
      px.fill(0, off, off + w * h);
      return;
    }
    const k = this.scale;
    const d = this.ctx.getImageData((x + this.ox + this.left) * k, (y + this.oy) * k, w * k, h * k).data;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const o = (j * k * w * k + i * k) * 4;
        px[off + j * w + i] = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
      }
    }
  }

  copyArea(sx, sy, w, h, dx, dy) {
    const ctx = this.ctx;
    const k = this.scale;
    ctx.drawImage(ctx.canvas, (sx + this.ox + this.left) * k, (sy + this.oy) * k, w * k, h * k,
      sx + dx + this.ox, sy + dy + this.oy, w, h);
    this.#touch();
  }
}

const warnOnce = (() => {
  let warned = false;
  return () => {
    if (!warned) console.warn('3D drawing into an off-screen Image is not supported');
    warned = true;
  };
})();

const NO_3D = {
  setClipRect: warnOnce,
  setParallelView: warnOnce,
  setPerspectiveFov: warnOnce,
  setPerspectiveSize: warnOnce,
  setViewTransform: warnOnce,
  flush: warnOnce,
  render: warnOnce,
};
