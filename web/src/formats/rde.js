// Parsers for the two other file types that hold positions next to an area's .rfc:
//   .roc  collision shape of one object/enemy model, in the model's own space (ap.a(byte[]))
//   .rde  cutscene script played before ("a") and after ("b") a mission (b.b(ad), b.java:641)
// Plain Node ES module, no dependencies. Everything is little-endian.

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }
  need(n) {
    if (this.pos + n > this.bytes.length) throw new Error(`read of ${n} byte(s) at ${this.pos} runs past the end (${this.bytes.length})`);
  }
  u8() { this.need(1); return this.view.getUint8(this.pos++); }
  i8() { this.need(1); return this.view.getInt8(this.pos++); }
  u16() { this.need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { this.need(2); const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  f32() { this.need(4); const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  vec3() { return [this.f32(), this.f32(), this.f32()]; }
  raw(n) { this.need(n); const b = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  str(n) { return String.fromCharCode(...this.raw(n)); } // Latin-1; runs in Node and in the browser
}

/**
 * .roc (ap.java:13-71):
 *   u16 vertexCount, vertexCount x f32[3]   model space, world units (not the 1/64 figure units)
 *   f32[3] centre, f32 radius               bounding sphere, used as the actor's size (h.E(n))
 *   u16 triCount, u16 quadCount
 *   triCount x u16[3], quadCount x u16[4]
 * The game transforms the vertices by the actor's matrix every time it moves (h.F()).
 */
export function parseROC(bytes) {
  const r = new Reader(bytes);
  const vertexCount = r.u16();
  const vertices = [];
  for (let i = 0; i < vertexCount; i++) vertices.push(r.vec3());
  const centre = r.vec3();
  const radius = r.f32();
  const triCount = r.u16(), quadCount = r.u16();
  const faces = [];
  for (let i = 0; i < triCount; i++) faces.push([r.u16(), r.u16(), r.u16()]);
  for (let i = 0; i < quadCount; i++) faces.push([r.u16(), r.u16(), r.u16(), r.u16()]);
  return { byteLength: bytes.length, parsedBytes: r.pos, trailing: bytes.subarray(r.pos), vertexCount, vertices, centre, radius, triCount, quadCount, faces };
}

/**
 * .rde (b.java:641-908; played back in b.c / b.a(Graphics, i, ad), b.java:162-640).
 * A timeline of `frames` game frames (15 per second). Frame numbers are u16.
 *
 *   4 bytes "RDE0"
 *   u8 assetCount, then per asset: u8 nameLength, name, and by extension
 *        .mld: u8 loop
 *        .gif: nothing
 *        .d4d: u8 n, n x { u8 length, texture name }       (names are skipped by the game)
 *        else (a figure): u8 length, action table name (length may be 0);
 *                         u8 n, n x { u8 length, texture name }
 *   u8 n, n x { u16 frame, f32[3] }       camera position keys          WORLD POSITION
 *   u8 n, n x { u16 frame, f32[3] }       camera look-at point keys     WORLD POSITION
 *   3 x { u8 n, n x { u16 frame, u8 length, text } }     the three dialogue lines
 *   u8 n, n x { u16 frame, u8[3] rgb top, u8[3] rgb bottom }   background gradient
 *   u8 n, n x u16 frame                   frames that wait for the confirm key
 *   4 x { u8 n, n x { u16 frame, u8 duration } }   screen fades: in from black, out to black,
 *                                         in from white, out to white
 *   u8 n, n x { u16 frame, i8 }           save-data flags set when the cutscene ends
 *   u8 n, n x { u16 frame, u8[4] }        speech pointer: screen x, y of the tip and the tail
 *   u8 n, n x { u16 frame, i8 }           sound on/off
 *   u8 n, n x { u16 frame, u8 }           stop sound channel
 *   2 x { u8 n, n x { u16 frame, u8 } }   volume keys of channels 0 and 1
 *   per asset:
 *     u8 n, n x { u16 frame, f32[3] }     position keys                 WORLD POSITION
 *     u8 n, n x { u16 frame, f32[3] }     "face this point" keys        WORLD POSITION
 *     u8 n, n x { u16 frame, i16[3] }     animation: action number and two playback
 *                                         arguments of h.a(0, action, a, b) (not positions)
 *     u8 n, n x { u16 frame, u8 }         face pattern (h.j)
 *     u8 n, n x { u16 frame, i8 }         visibility: 0 hides the asset from that frame on
 *     u8 n, n x { u16 frame, u8, u8 }     sound: channel, volume
 *   u16 frames
 * Keys are interpolated linearly between frames. A figure is placed with s.a(x, y, z) and
 * turned with s.d(x, y, z), which points its z axis at that world point.
 */
export function parseRDE(bytes) {
  const r = new Reader(bytes);
  const magic = r.str(4);
  const keys3 = () => { const n = r.u8(); const out = []; for (let i = 0; i < n; i++) out.push({ frame: r.u16(), offset: r.pos, v: r.vec3() }); return out; };
  const track = (read) => { const n = r.u8(); const out = []; for (let i = 0; i < n; i++) out.push({ frame: r.u16(), v: read() }); return out; };
  const names = () => { const n = r.u8(); const out = []; for (let i = 0; i < n; i++) out.push(r.str(r.u8())); return out; };

  const assets = [];
  const assetCount = r.u8();
  for (let i = 0; i < assetCount; i++) {
    const a = { index: i, name: r.str(r.u8()) };
    const ext = a.name.slice(-3);
    if (ext === 'mld') { a.kind = 'sound'; a.loop = r.u8(); }
    else if (ext === 'gif') a.kind = 'image';
    else if (ext === 'd4d') { a.kind = 'scene'; a.textures = names(); }
    else {
      a.kind = 'figure';
      const n = r.u8();
      a.actions = n > 0 ? r.str(n) : null;
      a.textures = names();
    }
    assets.push(a);
  }
  const cameraPosition = keys3();
  const cameraTarget = keys3();
  const text = [0, 1, 2].map(() => track(() => r.str(r.u8())));
  const background = track(() => [Array.from(r.raw(3)), Array.from(r.raw(3))]);
  const waits = (() => { const n = r.u8(); const out = []; for (let i = 0; i < n; i++) out.push(r.u16()); return out; })();
  const fades = [0, 1, 2, 3].map(() => track(() => r.u8()));
  const saveFlags = track(() => r.i8());
  const pointer = track(() => Array.from(r.raw(4)));
  const soundSwitch = track(() => r.i8());
  const soundStop = track(() => r.u8());
  const volume = [0, 1].map(() => track(() => r.u8()));
  for (const a of assets) {
    a.position = keys3();
    a.target = keys3();
    a.animation = track(() => [r.i16(), r.i16(), r.i16()]);
    a.pattern = track(() => r.u8());
    a.visible = track(() => r.i8());
    a.sound = track(() => [r.u8(), r.u8()]);
  }
  const frames = r.u16();
  return {
    byteLength: bytes.length, parsedBytes: r.pos, trailing: bytes.subarray(r.pos), magic,
    assets, cameraPosition, cameraTarget, text, background, waits, fades, saveFlags, pointer,
    soundSwitch, soundStop, volume, frames,
  };
}

/** Every world-space point stored in a parsed .rde, with its file offset. */
export function rdePoints(rde) {
  const out = [];
  for (const k of rde.cameraPosition) out.push({ what: 'camera position', frame: k.frame, offset: k.offset, v: k.v });
  for (const k of rde.cameraTarget) out.push({ what: 'camera target', frame: k.frame, offset: k.offset, v: k.v });
  for (const a of rde.assets) {
    for (const k of a.position) out.push({ what: `${a.name} position`, frame: k.frame, offset: k.offset, v: k.v });
    for (const k of a.target) out.push({ what: `${a.name} target`, frame: k.frame, offset: k.offset, v: k.v });
  }
  return out;
}
