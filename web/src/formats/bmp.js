// 8-bit paletted Windows BMP, as used for every 3D texture in the game.

/**
 * @param {Uint8Array} b
 * @returns {{width:number,height:number,palette:Uint8Array,indices:Uint8Array}} palette is RGBA x 256,
 *          indices are top-down rows
 */
export function decodeBMP8(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] !== 0x42 || b[1] !== 0x4d) throw new Error('not a BMP');
  const dataOffset = dv.getUint32(10, true);
  const headerSize = dv.getUint32(14, true);
  const core = headerSize === 12;
  const width = core ? dv.getUint16(18, true) : dv.getInt32(18, true);
  let height = core ? dv.getUint16(20, true) : dv.getInt32(22, true);
  const bpp = dv.getUint16(core ? 24 : 28, true);
  if (bpp !== 8) throw new Error(`unsupported texture depth ${bpp}`);
  if (!core && dv.getUint32(30, true) !== 0) throw new Error('compressed BMP texture');
  const topDown = height < 0;
  height = Math.abs(height);
  const entry = core ? 3 : 4;
  const paletteOffset = 14 + headerSize;
  const colors = Math.min(256, Math.floor((dataOffset - paletteOffset) / entry));
  const palette = new Uint8Array(256 * 4);
  for (let i = 0; i < colors; i++) {
    const p = paletteOffset + i * entry;
    palette[i * 4] = b[p + 2];
    palette[i * 4 + 1] = b[p + 1];
    palette[i * 4 + 2] = b[p];
    palette[i * 4 + 3] = 255;
  }
  const stride = (width + 3) & ~3;
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = dataOffset + (topDown ? y : height - 1 - y) * stride;
    indices.set(b.subarray(row, row + width), y * width);
  }
  return { width, height, palette, indices };
}
