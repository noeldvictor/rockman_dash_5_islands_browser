#!/usr/bin/env node
// Readable dump of an area's field file (.rfc), an object collision shape (.roc) or a
// cutscene script (.rde).
//   node tools/rfc/dump.mjs <file.rfc> [--all] [--obj out.obj]
//   node tools/rfc/dump.mjs <file.roc>
//   node tools/rfc/dump.mjs <file.rde> [--all]
// --all   .rfc: also list every vertex and face; .rde: also list the non-position tracks
// --obj   .rfc: write the collision faces as a Wavefront OBJ (one group per surface attribute)
// The byte layouts are documented at the top of web/src/formats/rfc.js and rde.js. Every byte of the
// file is accounted for: the section table adds up to the file length, and anything after
// the last record is printed as hex.
//
// What the .rfc holds, as the game uses it (class/method names are the obfuscated ones of
// the decompiled jar; `ao` is the map, `bh` the world, `k`/`a` the area events):
//
// COLLISION (ao.a(byte[]), ao.java:154-249)
//   Vertices are world positions. A face is a triangle or a convex quad (`bm`) and is filed
//   under exactly one cell of a 32 x 32 grid of 12-unit squares: cell = floor(x / 12) +
//   gridOffsetX, floor(z / 12) + gridOffsetZ (the divisor 49152 = 12 * 4096 is a constant in
//   ao.java:751-755, 883-884, 933-947, 1036-1043, 1096-1097). In the shipped files every face
//   lies inside its cell: the geometry was cut along the grid lines when it was exported.
//   A query looks at the cell under the point and at the neighbour cells the point is close
//   to (player/enemy push-out, ao.java:741-866) or at the cells a swept sphere crosses
//   (shots and the camera, ao.java:919-1028). A cell keeps at most 63 faces. The map-screen
//   scroll limits ao.a..d (min x, min z, max x, max z) are the bounds of these vertices,
//   starting from 0 (ao.java:174-193; used in bp.java:345-357 and bh.java:522-532).
//
// SURFACE ATTRIBUTES (ao.java:250-273; used in ao.b(h, long), ao.java:1030-1088)
//   face.attr is an index here, or negative for a plain surface.
//   type 0: axis 0/1/2 = world x/y/z, speed = world units per frame the surface carries
//           whoever stands on it (a conveyor; 0 = it does not move); flag > 0 is the damage
//           taken while touching it (bh.java:431-432, 1208-1209).
//   type 1: sets h.aq on whoever stands on it (slippery floor).
//   type 2: makes an edge push the player away from the edge point instead of along the
//           face normal (ao.java:676-690). Its i16 is read and never used.
//
// ACTORS (ao.java:274-335 -> bh.a(bo) and bh.c(bo, m), bh.java:574-724)
//   Everything the area places: doors, chests, crates, hazards, pick-ups, enemies, bosses.
//   kind     model and behaviour class (0-20 = o00..o20, 21-29 = e00..e08, 30-33 = b00..b03)
//   variant  texture number (oNN_0<variant>.bmp) or sub-type
//   pos      world position; also kept as the actor's home, bk.x(0)
//   dir      the direction its z axis points (a vector, not angles; s.e()); kept as bk.x(1)
//   inert    non-zero: cannot be damaged
//   speed    world units per frame (a few classes use it as a timer instead)
//   life, power   hit points; damage dealt
//   sight    x 3 = distance to the player under which it reacts (0 means 30 units); bk.t()
//   range    x 3 = how far it may go from its home position (bk.u(), bk.v()); for the
//            pistons (kinds 13 and 15) the length of the stroke along dir (l.java:76)
//   pattern  1 = walk to and fro, 2 = wander (bk.k(), bk.a(boolean, as))
//   drop     chest contents: >= 0 item number + 8, < 0 minus the zenny (k.java:545-555);
//            enemies: minus the zenny they leave
//   eventA/B events fired when it is destroyed (bk.w()), -1 = none
//
// EVENTS (ao.java:336-401 -> k.a(ao, bh, ai), k.java:106-166; run by a.e(), a.java:159-307)
//   An event with a position is a trigger: it fires when the player is within reach of pos
//   and faces along dir (within 45 degrees; a.b(), a.java:104-130). Reach is the player's
//   radius + 1 unit; 3 units for events on a door (actor kind 7); 4 units for type 2; type 6
//   also needs the player within 0.6 units on x and on z.
//   type 0  slide actor `ref` along its own axis (0 = x, 1 = y, 2 = z) by `amount` world
//           units, in 16 steps of amount / 16 (a door, actor kind 7: 8 steps of amount / 7,
//           so it travels 8/7 of `amount`; a.a(long) and a.e())
//   type 1  turn actor `ref` about its own axis by `amount` degrees, in 16 steps
//           hold: > 0 = frames to stay there before going back, -1 = stay for good,
//                 -2 = stay, and go back the next time it fires
//           wait: 0 = act at once; -1 = act only when every event of the same type on the
//                 same actor has fired (a door that opens when all enemies of a room are
//                 gone); > 0 = the same, but they must fire within that many frames (k.c())
//   type 2  wake actor `ref`            type 3  open chest `ref`
//   type 4  pick-up (`ref` = item number + 8, or minus the zenny)
//   type 5  "Return to the Flutter?"
//   type 6, 7  set the mission flags k.h / k.g. They come in pairs with the same x and z
//           and 4.5 to 11.5 units apart in height: the foot and the top of a ladder
//   type 8  warp to the position of event `ref` (the two ends point at each other)
//   type 9  message (text)
//   type 10 remove actor `ref` (always an o19 barrier in the shipped areas)
//   type 11 the player's start position and heading, and the mission briefing text
//   type 12 mission end
//   auto    (types 0, 1, 12) non-zero: fires as soon as the player is in reach. Types 2, 7,
//           9 and 11 always do. The others fire when the player presses the action key in
//           reach (av.java:1509 -> k.d()) or when an actor's eventA/eventB names them
import { readFileSync, writeFileSync } from 'node:fs';
import { parseRFC, checkRFC, bounds, ACTOR_KINDS, EVENT_TYPES, CELL, GRID } from '../../web/src/formats/rfc.js';
import { parseROC, parseRDE, rdePoints } from '../../web/src/formats/rde.js';

const args = process.argv.slice(2);
let file = null, objOut = null, all = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--obj') objOut = args[++i];
  else if (args[i] === '--all') all = true;
  else if (!file) file = args[i];
}
if (!file) {
  console.error('usage: node tools/rfc/dump.mjs <file.rfc|file.roc|file.rde> [--all] [--obj out.obj]');
  process.exit(2);
}

const f = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/\.?0+$/, ''));
const vec = (a) => `(${Array.from(a, f).join(', ')})`;
const box = (b) => (b.empty ? '(none)' : `${vec(b.min)} .. ${vec(b.max)}`);
const hex = (bytes, offset) => {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push(`  ${String(offset + i).padStart(6)}: ${Array.from(bytes.subarray(i, i + 16), (b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  }
  return lines.join('\n');
};
// The English patch stores ASCII; the original files store Shift_JIS.
const text = (bytes) => {
  let ascii = true;
  for (const b of bytes) if (b >= 0x80) { ascii = false; break; }
  const s = new TextDecoder(ascii ? 'utf-8' : 'shift_jis').decode(bytes);
  return JSON.stringify(s.replace(/\0+$/, ''));
};

const bytes = new Uint8Array(readFileSync(file));
const lower = file.toLowerCase();
if (lower.endsWith('.roc')) dumpROC();
else if (lower.endsWith('.rde')) dumpRDE();
else dumpRFC();

function dumpRFC() {
  const rfc = parseRFC(bytes);
  const { problems, notes, grid } = checkRFC(rfc);
  console.log(`${file}: ${rfc.byteLength} bytes`);
  console.log('\nsections (offset, length):');
  let total = 0;
  for (const s of rfc.sections) {
    total += s.length;
    console.log(`  ${String(s.offset).padStart(6)} ${String(s.length).padStart(6)}  ${s.name}${s.name === 'grid header' ? '' : ` x${s.count}`}`);
  }
  console.log(`  ${String(rfc.parsedBytes).padStart(6)} ${String(rfc.trailing.length).padStart(6)}  after the last record`);
  console.log(`  sum ${total + rfc.trailing.length} of ${rfc.byteLength} bytes`);
  if (rfc.trailing.length) console.log(hex(rfc.trailing, rfc.parsedBytes));

  const vb = bounds(rfc.vertices);
  console.log(`\ncollision: ${rfc.vertexCount} vertices, ${rfc.triCount} triangles, ${rfc.quadCount} quads`);
  console.log(`  bounds ${box(vb)}`);
  console.log(`  grid offset ${rfc.gridOffset.join(', ')} -> the ${GRID} x ${GRID} grid of ${CELL}-unit cells covers x ${-rfc.gridOffset[0] * CELL} .. ${(GRID - rfc.gridOffset[0]) * CELL}, z ${-rfc.gridOffset[1] * CELL} .. ${(GRID - rfc.gridOffset[1]) * CELL}`);
  console.log(`  ${grid.usedCells} cells used, at most ${grid.maxPerCell} faces in one (limit 63)`);
  console.log(`  faces reaching outside their cell: ${grid.outsideCell} (largest overshoot ${grid.maxOver.toExponential(1)} units); longest edge ${f(grid.maxEdge)}`);
  const perAttr = new Map();
  for (const face of rfc.faces) perAttr.set(face.attr, (perAttr.get(face.attr) ?? 0) + 1);
  console.log(`  faces by attribute: ${[...perAttr].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k < 0 ? 'none' : k}:${n}`).join(' ')}`);
  if (all) {
    console.log('\nvertices:');
    for (let i = 0; i < rfc.vertexCount; i++) console.log(`  [${i}] @${2 + i * 12} ${vec(rfc.vertices.subarray(i * 3, i * 3 + 3))}`);
    console.log('\nfaces (vertex indices, cell x z, attribute):');
    for (const face of rfc.faces) console.log(`  [${face.index}] @${face.offset} ${face.v.length === 3 ? 'tri ' : 'quad'} ${face.v.join(' ')}  cell ${face.cell.join(' ')}  attr ${face.attr}`);
  }

  console.log(`\nsurface attributes: ${rfc.attrs.length}`);
  for (const a of rfc.attrs) {
    let d = `type ${a.type}`;
    if (a.type === 0) d += ` carry axis=${'xyz'[a.axis] ?? a.axis} speed=${f(a.speed)}/frame damage=${a.flag}`;
    else if (a.type === 1) d += ' slippery';
    else if (a.type === 2) d += ` round edge (value ${a.value})`;
    console.log(`  [${a.index}] @${a.offset} ${d}  faces=${perAttr.get(a.index) ?? 0}`);
  }

  console.log(`\nactors: ${rfc.actors.length}`);
  for (const a of rfc.actors) {
    const place = a.pos ? `pos=${vec(a.pos)} dir=${vec(a.dir)}` : 'no position';
    console.log(`  [${a.index}] @${a.offset} kind=${a.kind}(${ACTOR_KINDS[a.kind] ?? '?'}) variant=${a.variant} ${place}`
      + ` inert=${a.inert} speed=${f(a.speed)} life=${a.life} power=${a.power} sight=${f(a.sight)} range=${f(a.range)}`
      + ` pattern=${a.pattern} drop=${a.drop} events=${a.eventA},${a.eventB}`);
  }

  console.log(`\nevents: ${rfc.events.length}`);
  for (const e of rfc.events) {
    const place = e.pos ? `pos=${vec(e.pos)} dir=${vec(e.dir)}` : 'no position';
    let d = `type=${e.type}(${EVENT_TYPES[e.type] ?? 'unknown'}) ref=${e.ref}`;
    if (e.type >= 0 && e.type <= 3 && rfc.actors[e.ref]) d += `(${ACTOR_KINDS[rfc.actors[e.ref].kind]})`;
    d += ` ${place}`;
    if (e.auto !== undefined) d += ` auto=${e.auto}`;
    if (e.axis !== undefined) d += ` axis=${'xyz'[e.axis] ?? e.axis} amount=${f(e.amount)} hold=${e.hold} wait=${e.wait}`;
    if (e.textLength !== undefined) d += ` text[${e.textLength}]=${text(e.textBytes)}`;
    console.log(`  [${e.index}] @${e.offset} ${d}`);
  }

  const placed = [...rfc.actors, ...rfc.events].filter((x) => x.pos).map((x) => x.pos);
  console.log(`\nbounds of actor and event positions: ${box(bounds(placed))}`);
  if (notes.length) console.log(`\nnotes:\n  ${notes.join('\n  ')}`);
  console.log(problems.length ? `\nPROBLEMS:\n  ${problems.join('\n  ')}` : '\nno structural problems found');

  if (objOut) {
    const out = [`# collision faces of ${file}`];
    for (let i = 0; i < rfc.vertexCount; i++) out.push(`v ${rfc.vertices[i * 3]} ${rfc.vertices[i * 3 + 1]} ${rfc.vertices[i * 3 + 2]}`);
    const groups = new Map();
    for (const face of rfc.faces) (groups.get(face.attr) ?? groups.set(face.attr, []).get(face.attr)).push(face);
    for (const [attr, faces] of [...groups].sort((a, b) => a[0] - b[0])) {
      out.push(`g attr_${attr < 0 ? 'none' : attr}`);
      for (const face of faces) out.push(`f ${face.v.map((v) => v + 1).join(' ')}`);
    }
    writeFileSync(objOut, out.join('\n') + '\n');
    console.log(`\nwrote ${objOut}`);
  }
}

function dumpROC() {
  const roc = parseROC(bytes);
  console.log(`${file}: ${roc.byteLength} bytes, ${roc.parsedBytes} parsed, ${roc.trailing.length} after the last record`);
  if (roc.trailing.length) console.log(hex(roc.trailing, roc.parsedBytes));
  console.log(`bounding sphere: centre ${vec(roc.centre)} radius ${f(roc.radius)}`);
  console.log(`bounds ${box(bounds(roc.vertices))}`);
  console.log(`vertices: ${roc.vertexCount}`);
  for (const [i, v] of roc.vertices.entries()) console.log(`  [${i}] ${vec(v)}`);
  console.log(`faces: ${roc.triCount} triangles, ${roc.quadCount} quads`);
  for (const [i, face] of roc.faces.entries()) console.log(`  [${i}] ${face.join(' ')}`);
}

function dumpRDE() {
  const rde = parseRDE(bytes);
  const keys = (list) => list.map((k) => `${k.frame}:${vec(k.v)}`).join(' ');
  const track = (list) => list.map((k) => `${k.frame}:${JSON.stringify(k.v)}`).join(' ');
  console.log(`${file}: ${rde.byteLength} bytes, ${rde.parsedBytes} parsed, ${rde.trailing.length} after the last record`);
  console.log(`magic ${JSON.stringify(rde.magic)}, ${rde.frames} frames, ${rde.assets.length} assets`);
  console.log(`\ncamera position keys (${rde.cameraPosition.length}): ${keys(rde.cameraPosition)}`);
  console.log(`camera target keys (${rde.cameraTarget.length}): ${keys(rde.cameraTarget)}`);
  console.log('\nassets:');
  for (const a of rde.assets) {
    console.log(`  [${a.index}] ${a.kind} ${a.name}${a.actions ? ` actions=${a.actions}` : ''}${a.textures?.length ? ` textures=${a.textures.join(',')}` : ''}${a.loop !== undefined ? ` loop=${a.loop}` : ''}`);
    if (a.position.length) console.log(`      position keys (${a.position.length}): ${keys(a.position)}`);
    if (a.target.length) console.log(`      target keys (${a.target.length}): ${keys(a.target)}`);
    if (all) {
      if (a.animation.length) console.log(`      animation: ${track(a.animation)}`);
      if (a.pattern.length) console.log(`      pattern: ${track(a.pattern)}`);
      if (a.sound.length) console.log(`      sound: ${track(a.sound)}`);
    }
    if (a.visible.length) console.log(`      visible: ${track(a.visible)}`);
  }
  if (all) {
    for (const [i, line] of rde.text.entries()) {
      console.log(`\ntext line ${i} (${line.length}):`);
      for (const k of line) console.log(`  ${k.frame}: ${text(Buffer.from(k.v, 'latin1'))}`);
    }
    console.log(`\nbackground: ${track(rde.background)}`);
    console.log(`waits: ${rde.waits.join(' ')}`);
    for (const [i, name] of ['fade in from black', 'fade out to black', 'fade in from white', 'fade out to white'].entries()) console.log(`${name}: ${track(rde.fades[i])}`);
    console.log(`save flags: ${track(rde.saveFlags)}`);
    console.log(`speech pointer: ${track(rde.pointer)}`);
    console.log(`sound switch: ${track(rde.soundSwitch)}`);
    console.log(`sound stop: ${track(rde.soundStop)}`);
    console.log(`volume 0: ${track(rde.volume[0])}`);
    console.log(`volume 1: ${track(rde.volume[1])}`);
  }
  const pts = rdePoints(rde);
  console.log(`\n${pts.length} world positions, bounds ${box(bounds(pts.map((p) => p.v)))}`);
  if (rde.trailing.length) {
    console.log(`\nbytes after the last record (the game stops reading at the frame count):`);
    console.log(hex(rde.trailing, rde.parsedBytes));
  }
}
