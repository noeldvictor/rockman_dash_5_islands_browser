// Parser for the game's per-area "field" files (aN_M.rfc, in the jar as XaN_M.rfc).
// Shared by dump.mjs and check_all.mjs. Plain Node ES module, no dependencies.
//
// The game reads the file in one pass in ao.a(byte[]) (class `ao` is the map, `bh.b`);
// everything is little-endian and there is no magic number, version, section table or
// checksum. Positions are IEEE float32 in world units (y up); the game converts them to
// 20.12 fixed point on load (ao.java:170-193).
//
//   u16 vertexCount
//   vertexCount x { f32 x, f32 y, f32 z }          collision vertices
//   i8  gridOffsetX, i8 gridOffsetZ                 cell = floor(coord / 12) + offset
//   u16 triCount, u16 quadCount
//   triCount  x { u16 a, b, c;    u8 cellX, u8 cellZ, i8 attr }      9 bytes
//   quadCount x { u16 a, b, c, d; u8 cellX, u8 cellZ, i8 attr }     11 bytes
//   u16 attrCount
//   attrCount x { u8 type;                          surface attributes, indexed by face.attr
//                 type 0: u8 axis, f32 speed, i16 flag
//                 type 2: i16 value }               (type 1 has no payload)
//   u16 actorCount
//   actorCount x { u8 kind, u8 variant, u8 hasPos,
//                  hasPos != 0: f32 pos[3], f32 dir[3],
//                  u8 inert, f32 speed, i16 life, i16 power, f32 sight, f32 range,
//                  u8 pattern, i16 drop, i16 eventA, i16 eventB }    25 or 49 bytes
//   u16 eventCount
//   eventCount x { i8 type, i16 ref, u8 hasPos,
//                  hasPos != 0: f32 pos[3], f32 dir[3],
//                  type 0, 1, 12: i8 auto,
//                  type 0, 1:     i8 axis, f32 amount, i16 hold, i16 wait,
//                  type 9, 11:    i16 textLength, textLength bytes of text }
//   (end of file)
//
// See tools/rfc/dump.mjs for what the fields do in the game.

export const CELL = 12; // world units per collision grid cell (49152 in 20.12 fixed point)
export const GRID = 32; // cells per side (short[32][32][64] in ao.a)
export const CELL_FACES = 63; // faces per cell that the game keeps (the 64th slot is the terminator)

// Actor kind -> model file stem (bh.a(int, bo), bh.java:745-1107). Kinds 13 and 15 share o13.
export const ACTOR_KINDS = {
  0: 'o00', 1: 'o01', 2: 'o02', 3: 'o03', 4: 'o04', 5: 'o05', 6: 'o06', 7: 'o07', 8: 'o08',
  9: 'o09', 10: 'o10', 11: 'o11', 12: 'o12', 13: 'o13', 14: 'o14', 15: 'o13', 16: 'o16',
  17: 'o17', 18: 'o18', 19: 'o19', 20: 'o20',
  21: 'e00', 22: 'e01', 23: 'e02', 24: 'e03', 25: 'e04', 26: 'e05', 27: 'e06', 28: 'e07',
  29: 'e08', 30: 'b00', 31: 'b01', 32: 'b02', 33: 'b03',
};

export const EVENT_TYPES = {
  0: 'move actor', 1: 'rotate actor', 2: 'wake actor', 3: 'open chest', 4: 'pick up item',
  5: 'exit prompt', 6: 'ladder foot', 7: 'ladder top', 8: 'warp', 9: 'message',
  10: 'remove actor', 11: 'player start', 12: 'mission end',
};

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
}

/**
 * @param {Uint8Array} bytes
 * @returns the decoded file; `sections` lists the byte span of every part, `trailing` holds
 *          whatever follows the last record (the game ignores it).
 */
export function parseRFC(bytes) {
  const r = new Reader(bytes);
  const sections = [];
  const mark = (name, start, count) => sections.push({ name, offset: start, length: r.pos - start, count });

  let start = r.pos;
  const vertexCount = r.u16();
  const vertices = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount * 3; i++) vertices[i] = r.f32();
  mark('vertices', start, vertexCount);

  start = r.pos;
  const gridOffset = [r.i8(), r.i8()];
  const triCount = r.u16();
  const quadCount = r.u16();
  mark('grid header', start, 1);

  const faces = [];
  start = r.pos;
  for (let i = 0; i < triCount; i++) {
    const offset = r.pos;
    faces.push({ index: faces.length, offset, v: [r.u16(), r.u16(), r.u16()], cell: [r.u8(), r.u8()], attr: r.i8() });
  }
  mark('triangles', start, triCount);
  start = r.pos;
  for (let i = 0; i < quadCount; i++) {
    const offset = r.pos;
    faces.push({ index: faces.length, offset, v: [r.u16(), r.u16(), r.u16(), r.u16()], cell: [r.u8(), r.u8()], attr: r.i8() });
  }
  mark('quads', start, quadCount);

  start = r.pos;
  const attrCount = r.u16();
  const attrs = [];
  for (let i = 0; i < attrCount; i++) {
    const offset = r.pos;
    const a = { index: i, offset, type: r.u8() };
    if (a.type === 0) { a.axis = r.u8(); a.speed = r.f32(); a.flag = r.i16(); }
    if (a.type === 2) a.value = r.i16();
    attrs.push(a);
  }
  mark('surface attributes', start, attrCount);

  start = r.pos;
  const actorCount = r.i16();
  const actors = [];
  for (let i = 0; i < actorCount; i++) {
    const offset = r.pos;
    const a = { index: i, offset, kind: r.u8(), variant: r.u8(), hasPos: r.u8(), pos: null, dir: null };
    if (a.hasPos !== 0) { a.posOffset = r.pos; a.pos = r.vec3(); a.dir = r.vec3(); }
    a.inert = r.u8();
    a.speed = r.f32();
    a.life = r.i16();
    a.power = r.i16();
    a.sight = r.f32();
    a.range = r.f32();
    a.pattern = r.u8();
    a.drop = r.i16();
    a.eventA = r.i16();
    a.eventB = r.i16();
    actors.push(a);
  }
  mark('actors', start, actorCount);

  start = r.pos;
  const eventCount = r.i16();
  const events = [];
  for (let i = 0; i < eventCount; i++) {
    const offset = r.pos;
    const e = { index: i, offset, type: r.i8(), ref: r.i16(), hasPos: r.u8(), pos: null, dir: null };
    if (e.hasPos !== 0) { e.posOffset = r.pos; e.pos = r.vec3(); e.dir = r.vec3(); }
    if (e.type === 0 || e.type === 1 || e.type === 12) e.auto = r.i8();
    if (e.type === 0 || e.type === 1) { e.axis = r.i8(); e.amount = r.f32(); e.hold = r.i16(); e.wait = r.i16(); }
    if (e.type === 9 || e.type === 11) {
      e.textLength = r.i16();
      e.textBytes = e.textLength > 0 ? r.raw(e.textLength) : new Uint8Array(0);
      e.text = new TextDecoder('utf-8').decode(e.textBytes);
    }
    events.push(e);
  }
  mark('events', start, eventCount);

  const trailing = bytes.subarray(r.pos);
  return {
    byteLength: bytes.length, parsedBytes: r.pos, trailing, sections,
    vertexCount, vertices, gridOffset, triCount, quadCount, faces, attrs, actors, events,
  };
}

/** min/max of a list of [x, y, z] (or a flat array with stride 3). */
export function bounds(points) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const add = (x, y, z) => {
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  };
  if (points.length && typeof points[0] === 'number') for (let i = 0; i < points.length; i += 3) add(points[i], points[i + 1], points[i + 2]);
  else for (const p of points) add(p[0], p[1], p[2]);
  return { min, max, empty: min[0] === Infinity };
}

export const faceVertex = (rfc, face, k) => {
  const i = face.v[k] * 3;
  return [rfc.vertices[i], rfc.vertices[i + 1], rfc.vertices[i + 2]];
};

/** Grid cell of a world coordinate, as the game computes it (ao.java:933-940). */
export const cellOf = (coord, offset) => Math.floor(coord / CELL) + offset;

/**
 * Consistency checks. `problems` are structural faults (the file cannot be what the parser
 * thinks it is, or the game would misread it); `notes` are oddities of the data that the
 * game tolerates. Also returns some measurements about the collision grid.
 */
export function checkRFC(rfc) {
  const problems = [], notes = [];
  if (rfc.trailing.length) problems.push(`${rfc.trailing.length} trailing byte(s)`);
  for (let i = 0; i < rfc.vertices.length; i++) if (!Number.isFinite(rfc.vertices[i])) { problems.push('non-finite vertex'); break; }

  const perCell = new Map();
  let outsideCell = 0, maxSpanCells = 0, maxOver = 0, maxEdge = 0, degenerate = 0;
  for (const f of rfc.faces) {
    if (f.v.some((v) => v >= rfc.vertexCount)) { problems.push(`face ${f.index}: vertex index out of range`); continue; }
    if (f.cell[0] >= GRID || f.cell[1] >= GRID) problems.push(`face ${f.index}: cell ${f.cell} outside the ${GRID}x${GRID} grid`);
    if (f.attr >= rfc.attrs.length) problems.push(`face ${f.index}: attribute ${f.attr} out of range`);
    const key = f.cell[0] * GRID + f.cell[1];
    perCell.set(key, (perCell.get(key) ?? 0) + 1);
    const pts = f.v.map((_, k) => faceVertex(rfc, f, k));
    const b = bounds(pts);
    // how far the face reaches outside the cell it is filed under, in world units
    const x0 = (f.cell[0] - rfc.gridOffset[0]) * CELL, z0 = (f.cell[1] - rfc.gridOffset[1]) * CELL;
    const over = Math.max(x0 - b.min[0], b.max[0] - (x0 + CELL), z0 - b.min[2], b.max[2] - (z0 + CELL), 0);
    if (over > 1e-3) outsideCell++;
    if (over > maxOver) maxOver = over;
    const span = Math.max(
      cellOf(b.max[0], 0) - cellOf(b.min[0], 0) + 1,
      cellOf(b.max[2], 0) - cellOf(b.min[2], 0) + 1);
    if (span > maxSpanCells) maxSpanCells = span;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k], q = pts[(k + 1) % pts.length];
      const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (d > maxEdge) maxEdge = d;
      if (d === 0) degenerate++;
    }
  }
  let maxPerCell = 0;
  for (const n of perCell.values()) if (n > maxPerCell) maxPerCell = n;
  if (maxPerCell > CELL_FACES) problems.push(`a grid cell holds ${maxPerCell} faces; the game keeps ${CELL_FACES}`);

  for (const a of rfc.actors) {
    if (!(a.kind in ACTOR_KINDS)) problems.push(`actor ${a.index}: unknown kind ${a.kind}`);
    for (const ev of [a.eventA, a.eventB]) if (ev >= rfc.events.length) problems.push(`actor ${a.index}: event ${ev} out of range`);
  }
  for (const e of rfc.events) {
    if (!(e.type in EVENT_TYPES)) notes.push(`event ${e.index}: type ${e.type} is not one the game acts on`);
    if (e.type <= 3 && (e.ref < 0 || e.ref >= rfc.actors.length)) problems.push(`event ${e.index}: actor ${e.ref} out of range`);
    if (e.type === 8 && (e.ref < 0 || e.ref >= rfc.events.length)) problems.push(`event ${e.index}: warp target ${e.ref} out of range`);
  }
  return {
    problems, notes,
    grid: { usedCells: perCell.size, maxPerCell, outsideCell, maxOver, maxSpanCells, maxEdge, degenerate },
  };
}
