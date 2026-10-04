// Identify a game data file by its content. The game hands the 3D engine byte arrays, not names,
// so anything that needs to know which model it is being asked to draw compares these keys.

let table = null;

export function crc32(bytes) {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {Uint8Array} bytes */
export const keyOf = (bytes) => `${bytes.length}:${crc32(bytes)}`;
