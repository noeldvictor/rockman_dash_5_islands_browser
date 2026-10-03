// Synchronous GIF and BMP decoders.
//
// DoJa's MediaImage.use() is synchronous, and the recompiled game calls it from straight-line
// code, so the browser's (asynchronous) image decoding cannot be used.

/** @returns {{width:number,height:number,rgba:Uint8ClampedArray}|null} */
export function decodeImage(bytes) {
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return decodeGIF(bytes);
  }
  if (bytes.length > 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return decodeBMP(bytes);
  }
  return null;
}

/** First frame of a GIF87a/89a, honouring the transparent colour index and interlacing. */
export function decodeGIF(b) {
  const u16 = (o) => b[o] | (b[o + 1] << 8);
  const width = u16(6);
  const height = u16(8);
  const flags = b[10];
  let pos = 13;
  let globalPalette = null;
  if (flags & 0x80) {
    const n = 2 << (flags & 7);
    globalPalette = b.subarray(pos, pos + n * 3);
    pos += n * 3;
  }
  let transparent = -1;
  const rgba = new Uint8ClampedArray(width * height * 4);
  while (pos < b.length) {
    const block = b[pos++];
    if (block === 0x21) {
      const label = b[pos++];
      if (label === 0xf9) {
        // graphic control extension
        if (b[pos + 1] & 1) transparent = b[pos + 4];
      }
      while (b[pos] !== 0) pos += b[pos] + 1;
      pos++;
    } else if (block === 0x2c) {
      const ix = u16(pos);
      const iy = u16(pos + 2);
      const iw = u16(pos + 4);
      const ih = u16(pos + 6);
      const lflags = b[pos + 8];
      pos += 9;
      let palette = globalPalette;
      if (lflags & 0x80) {
        const n = 2 << (lflags & 7);
        palette = b.subarray(pos, pos + n * 3);
        pos += n * 3;
      }
      const minCode = b[pos++];
      // gather the data sub-blocks
      let total = 0;
      let p = pos;
      while (b[p] !== 0) {
        total += b[p];
        p += b[p] + 1;
      }
      const data = new Uint8Array(total);
      let d = 0;
      while (b[pos] !== 0) {
        data.set(b.subarray(pos + 1, pos + 1 + b[pos]), d);
        d += b[pos];
        pos += b[pos] + 1;
      }
      pos++;
      const indices = lzw(data, minCode, iw * ih);
      const interlaced = (lflags & 0x40) !== 0;
      const rows = interlaced ? interlaceOrder(ih) : null;
      for (let y = 0; y < ih; y++) {
        const dy = iy + (rows ? rows[y] : y);
        if (dy >= height) continue;
        for (let x = 0; x < iw; x++) {
          const dx = ix + x;
          if (dx >= width) continue;
          const c = indices[y * iw + x];
          if (c === transparent) continue;
          const o = (dy * width + dx) * 4;
          rgba[o] = palette[c * 3];
          rgba[o + 1] = palette[c * 3 + 1];
          rgba[o + 2] = palette[c * 3 + 2];
          rgba[o + 3] = 255;
        }
      }
      return { width, height, rgba };
    } else {
      break; // trailer or garbage
    }
  }
  return { width, height, rgba };
}

function interlaceOrder(h) {
  const rows = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < h; y += step) rows.push(y);
  }
  return rows;
}

function lzw(data, minCode, pixelCount) {
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCode;
  const eoi = clear + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  let codeSize = minCode + 1;
  let mask = (1 << codeSize) - 1;
  let avail = clear + 2;
  let old = -1;
  let first = 0;
  let bits = 0;
  let acc = 0;
  let o = 0;
  let sp = 0;
  for (let i = 0; i < clear; i++) suffix[i] = i;
  let pos = 0;
  while (o < pixelCount) {
    while (bits < codeSize) {
      if (pos >= data.length) return out;
      acc |= data[pos++] << bits;
      bits += 8;
    }
    let code = acc & mask;
    acc >>= codeSize;
    bits -= codeSize;
    if (code === clear) {
      codeSize = minCode + 1;
      mask = (1 << codeSize) - 1;
      avail = clear + 2;
      old = -1;
      continue;
    }
    if (code === eoi) break;
    if (old === -1) {
      out[o++] = suffix[code];
      old = code;
      first = code;
      continue;
    }
    const inCode = code;
    if (code >= avail) {
      stack[sp++] = first;
      code = old;
    }
    while (code >= clear) {
      stack[sp++] = suffix[code];
      code = prefix[code];
    }
    first = suffix[code];
    stack[sp++] = first;
    if (avail < 4096) {
      prefix[avail] = old;
      suffix[avail] = first;
      avail++;
      if ((avail & mask) === 0 && avail < 4096) {
        codeSize++;
        mask = (1 << codeSize) - 1;
      }
    }
    old = inCode;
    while (sp > 0 && o < pixelCount) out[o++] = stack[--sp];
    sp = 0;
  }
  return out;
}

/** Uncompressed 1/4/8/24/32-bit Windows BMP. Opaque. */
export function decodeBMP(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const dataOffset = dv.getUint32(10, true);
  const headerSize = dv.getUint32(14, true);
  let width;
  let height;
  let bpp;
  let paletteEntry = 4;
  if (headerSize === 12) {
    width = dv.getUint16(18, true);
    height = dv.getUint16(20, true);
    bpp = dv.getUint16(24, true);
    paletteEntry = 3;
  } else {
    width = dv.getInt32(18, true);
    height = dv.getInt32(22, true);
    bpp = dv.getUint16(28, true);
    if (dv.getUint32(30, true) !== 0) return null; // compressed
  }
  const topDown = height < 0;
  height = Math.abs(height);
  const paletteOffset = 14 + headerSize;
  const stride = (((width * bpp + 31) >> 5) << 2);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = dataOffset + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (bpp <= 8) {
        let c;
        if (bpp === 8) c = b[row + x];
        else if (bpp === 4) c = (b[row + (x >> 1)] >> ((x & 1) ? 0 : 4)) & 15;
        else c = (b[row + (x >> 3)] >> (7 - (x & 7))) & 1;
        const p = paletteOffset + c * paletteEntry;
        rgba[o] = b[p + 2];
        rgba[o + 1] = b[p + 1];
        rgba[o + 2] = b[p];
      } else {
        const p = row + x * (bpp >> 3);
        rgba[o] = b[p + 2];
        rgba[o + 1] = b[p + 1];
        rgba[o + 2] = b[p];
      }
      rgba[o + 3] = 255;
    }
  }
  return { width, height, rgba };
}
