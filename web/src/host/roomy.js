// Experiment: roomier areas ("Roomier areas" under Settings > Extras).
//
// A mission area is widened by stretching it horizontally (x and z) by one factor about the
// origin, while what stands in it keeps its size: the player, enemies and loose objects are
// further apart and the corridors between walls get wider (the game's corridors are one
// 6-unit block wide). Heights do not change. Everything is done as the game reads its files;
// nothing is written anywhere:
//
//   X<area>.rfc  what the game collides with and where it puts things (formats/rfc.js):
//                rewritten, see widenRFC();
//   <area>.d4d   what is drawn: the scene just built from it has its vertices scaled;
//   o*.roc       the collision shapes of the objects built into the architecture (doors, wall
//                and floor pieces, lifts, laser gates: FITTED) are scaled the same way, and
//                those objects are drawn that much wider (figure.js, g3d.js), so that a door
//                still closes its doorway and a floor tile still meets the next.
//
// How it knows what is what. A mission reads its scene, builds it, then reads its .rfc; a
// cutscene reads its script (.rde), then the scenes and models it shows. So the scene that is
// widened is the last one built when a mission's .rfc comes by, and the models and collision
// shapes that are widened are those loaded after a widened .rfc and before the next script.
// Cutscenes are left exactly as they are: they are staged shot by shot in the original space.
//
// The collision is a fixed grid of 12-unit cells, 32 a side, with each face filed under the
// one cell it lies in, so a stretched face has to be cut along the grid lines again. That, and
// the limit of 63 faces in a cell, is why an area can only grow so far (widenRFC throws; the
// area is then left as it is).
//
// Not handled: distances the game has as constants. Jumps and trigger reach stay as they are
// while gaps and doorways grow, conveyors keep their speed, and so on. Untested area by area.

import { parseRFC, CELL, GRID, CELL_FACES } from '../formats/rfc.js';

/** Objects that are part of the architecture: o07 door, o11 floor tile, o16 lift, o17/o18 wall pieces, o19 laser gate. */
const FITTED = /^o(07|11|16|17|18|19)\.(mba|mbac|roc)$/i;

export const roomy = {
  /** Horizontal factor; 1 = off. */
  scale: 1,
  /** What the last widened area came to, for diagnostics. */
  stats: null,
  /** The scene file the game read last, and the scene it built last: { area, group }. */
  lastFile: '',
  lastScene: null,
  /** The factor of what is being loaded now: the widened mission's, else 1. */
  context: 1,
  /** Content keys of the FITTED models (set by the page from the game's data files). */
  fittedKeys: new Set(),
};
let cached = null; // the last .rfc widened: { name, scale, bytes }

const areaOf = (name) => name.replace(/^.*\//, '').replace(/^X/, '').replace(/\.[a-z0-9]+$/i, '');

/** Whether a data file is one of the models built into the architecture. */
export const isFitted = (name) => FITTED.test(name.replace(/^.*\//, ''));

/** The game read `name` from its data: note it, and return changed bytes or null. */
export function onRead(name, bytes) {
  const file = name.replace(/^.*\//, '');
  if (/\.d4d$/i.test(file)) {
    roomy.lastFile = areaOf(file);
    return null;
  }
  if (/\.rde$/i.test(file)) {
    roomy.context = 1; // a cutscene: what it loads stays as it is
    return null;
  }
  if (/\.rfc$/i.test(file)) {
    roomy.context = 1;
    if (roomy.scale === 1) return null;
    try {
      if (!cached || cached.name !== file || cached.scale !== roomy.scale) {
        cached = { name: file, scale: roomy.scale, bytes: widenRFC(bytes, roomy.scale) };
      }
    } catch (e) {
      console.warn('[roomy] left', file, 'as it is:', e.message);
      cached = null;
      return null;
    }
    // the scene of this mission was built just before
    const scene = roomy.lastScene;
    if (scene && scene.area === areaOf(file)) scene.group.widen(roomy.scale);
    roomy.context = roomy.scale;
    return cached.bytes;
  }
  if (/\.roc$/i.test(file) && roomy.context !== 1 && FITTED.test(file)) return widenROC(bytes, roomy.context);
  return null;
}

/** group.js: a scene has been built (from the scene file read last). */
export function sceneBuilt(group) {
  roomy.lastScene = { area: roomy.lastFile, group };
}

/** figure.js: how much wider a model being created now is to be drawn (1 = as it is). */
export function figureScale(key) {
  return roomy.context !== 1 && roomy.fittedKeys.has(key) ? roomy.context : 1;
}

/** An object's collision shape (.roc), stretched like the architecture it is part of. */
function widenROC(bytes, s) {
  const out = bytes.slice();
  const view = new DataView(out.buffer);
  const count = view.getUint16(0, true);
  // the vertices, then the centre of the bounding sphere
  for (let i = 0; i <= count; i++) {
    const o = 2 + i * 12;
    view.setFloat32(o, view.getFloat32(o, true) * s, true);
    view.setFloat32(o + 8, view.getFloat32(o + 8, true) * s, true);
  }
  const radius = 2 + (count + 1) * 12;
  view.setFloat32(radius, view.getFloat32(radius, true) * s, true);
  return out;
}

/** The part of a convex polygon (points [x, y, z]) on one side of a line x = c or z = c. */
function clip(points, axis, c, keepAbove) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ina = keepAbove ? a[axis] >= c : a[axis] <= c;
    const inb = keepAbove ? b[axis] >= c : b[axis] <= c;
    if (ina) out.push(a);
    if (ina !== inb) {
      const t = (c - a[axis]) / (b[axis] - a[axis]);
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      p[axis] = c; // exactly on the line, so both neighbours get the same vertex
      out.push(p);
    }
  }
  return out;
}

/** Twice the area of a polygon in 3D. */
function area2(points) {
  let x = 0, y = 0, z = 0;
  for (let i = 1; i + 1 < points.length; i++) {
    const a = points[0], b = points[i], c = points[i + 1];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    x += uy * vz - uz * vy;
    y += uz * vx - ux * vz;
    z += ux * vy - uy * vx;
  }
  return Math.hypot(x, y, z);
}

/**
 * An area's collision and placements, stretched by `s` in x and z.
 * @param {Uint8Array} bytes  the .rfc as shipped
 * @returns {Uint8Array} a new .rfc
 */
export function widenRFC(bytes, s) {
  const rfc = parseRFC(bytes);
  const V = rfc.vertices;
  const at = (i) => [V[i * 3] * s, V[i * 3 + 1], V[i * 3 + 2] * s];
  // the faces as polygons; a quad is the two triangles the game tests it as (abc, acd), which
  // is also right for the few that are not flat or not convex
  const polygons = [];
  for (const face of rfc.faces) {
    const p = face.v.map(at);
    polygons.push({ p: [p[0], p[1], p[2]], attr: face.attr });
    if (p.length === 4) polygons.push({ p: [p[0], p[2], p[3]], attr: face.attr });
  }
  let minX = 0, minZ = 0, maxX = 0, maxZ = 0;
  for (const { p } of polygons) {
    for (const v of p) {
      minX = Math.min(minX, v[0]);
      maxX = Math.max(maxX, v[0]);
      minZ = Math.min(minZ, v[2]);
      maxZ = Math.max(maxZ, v[2]);
    }
  }
  // cell = floor(coordinate / 12) + offset, from 0 to 31
  const offset = [-Math.floor(minX / CELL), -Math.floor(minZ / CELL)];
  const cells = [Math.floor((maxX - 1e-4) / CELL) + offset[0] + 1, Math.floor((maxZ - 1e-4) / CELL) + offset[1] + 1];
  if (cells[0] > GRID || cells[1] > GRID || offset[0] > 127 || offset[1] > 127) {
    throw new Error(`${cells[0]} x ${cells[1]} cells of collision do not fit the game's ${GRID} x ${GRID} grid`);
  }
  // cut every polygon along the grid lines; index the vertices again
  const vertices = [];
  const index = new Map();
  const vertex = (v) => {
    const key = `${Math.round(v[0] * 4096)},${Math.round(v[1] * 4096)},${Math.round(v[2] * 4096)}`;
    let i = index.get(key);
    if (i === undefined) {
      i = vertices.length / 3;
      vertices.push(v[0], v[1], v[2]);
      index.set(key, i);
    }
    return i;
  };
  const tris = [];
  const quads = [];
  const perCell = new Map();
  for (const { p, attr } of polygons) {
    const xs = p.map((v) => v[0]);
    const zs = p.map((v) => v[2]);
    const x0 = Math.floor(Math.min(...xs) / CELL), x1 = Math.floor((Math.max(...xs) - 1e-6) / CELL);
    const z0 = Math.floor(Math.min(...zs) / CELL), z1 = Math.floor((Math.max(...zs) - 1e-6) / CELL);
    for (let cx = x0; cx <= Math.max(x0, x1); cx++) {
      const column = cx === x0 && cx === x1 ? p : clip(clip(p, 0, cx * CELL, true), 0, (cx + 1) * CELL, false);
      if (column.length < 3) continue;
      for (let cz = z0; cz <= Math.max(z0, z1); cz++) {
        const piece = cz === z0 && cz === z1 ? column : clip(clip(column, 2, cz * CELL, true), 2, (cz + 1) * CELL, false);
        if (piece.length < 3 || area2(piece) < 1e-5) continue;
        const cell = [cx + offset[0], cz + offset[1]];
        // a convex polygon as a fan of quads, with a triangle at the end if it is odd
        // (corners that the cut brought together count once)
        const ids = piece.map(vertex).filter((id, i, all) => id !== all[(i + 1) % all.length]);
        if (new Set(ids).size < 3 || new Set(ids).size !== ids.length) {
          if (new Set(ids).size >= 3) throw new Error('a collision face folds back on itself when cut');
          continue;
        }
        for (let i = 1; i + 1 < ids.length; i += 2) {
          const part = i + 2 < ids.length ? [ids[0], ids[i], ids[i + 1], ids[i + 2]] : [ids[0], ids[i], ids[i + 1]];
          (part.length === 4 ? quads : tris).push({ v: part, cell, attr });
          const key = cell[0] * GRID + cell[1];
          perCell.set(key, (perCell.get(key) ?? 0) + 1);
        }
      }
    }
  }
  const most = Math.max(0, ...perCell.values());
  if (most > CELL_FACES) throw new Error(`${most} faces in one collision cell (the game keeps ${CELL_FACES})`);
  if (vertices.length / 3 > 65535 || tris.length > 65535 || quads.length > 65535) throw new Error('too much collision for the file format');

  // everything after the faces is copied as it is, then the positions in it are moved
  const tailStart = rfc.sections.find((x) => x.name === 'surface attributes').offset;
  const tail = bytes.subarray(tailStart);
  const head = 2 + vertices.length * 4 + 6 + tris.length * 9 + quads.length * 11;
  const out = new Uint8Array(head + tail.length);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint16(o, vertices.length / 3, true); o += 2;
  for (const f of vertices) { view.setFloat32(o, f, true); o += 4; }
  view.setInt8(o++, offset[0]);
  view.setInt8(o++, offset[1]);
  view.setUint16(o, tris.length, true); o += 2;
  view.setUint16(o, quads.length, true); o += 2;
  for (const face of [...tris, ...quads]) {
    for (const i of face.v) { view.setUint16(o, i, true); o += 2; }
    view.setUint8(o++, face.cell[0]);
    view.setUint8(o++, face.cell[1]);
    view.setInt8(o++, face.attr);
  }
  out.set(tail, o);
  for (const thing of [...rfc.actors, ...rfc.events]) {
    if (!thing.pos) continue;
    const at2 = thing.posOffset - tailStart + head;
    view.setFloat32(at2, thing.pos[0] * s, true);
    view.setFloat32(at2 + 8, thing.pos[2] * s, true);
  }
  // how far an enemy sees and roams, and how far a piston pushes, grow with the room
  for (const actor of rfc.actors) {
    const at2 = actor.sightOffset - tailStart + head;
    view.setFloat32(at2, actor.sight * s, true);
    view.setFloat32(at2 + 4, actor.range * s, true);
  }
  roomy.stats = { scale: s, cells, mostInCell: most, faces: [rfc.faces.length, tris.length + quads.length], bytes: [bytes.length, out.length] };
  return out;
}
