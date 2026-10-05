#!/usr/bin/env node
// Runs the .rfc parser over every area field file and prints one line per (unique) file,
// then does the same, more briefly, for the .roc collision shapes and .rde cutscene scripts.
//   node tools/rfc/check_all.mjs [rootDir=build/assets] [--all] [--quiet]
// For each .rfc:
//   - the parser must consume the file exactly (no bytes left, none missing) and the
//     structural checks of checkRFC must pass (indices in range, faces inside the 32 x 32
//     grid, at most 63 faces per cell);
//   - bounds of the collision vertices and of the actor/event positions;
//   - "fit": how much the area could grow in x and z before it no longer fits the game's
//     32-cell collision grid (12 units per cell);
//   - cross-check with the scene: bounds of the area's .d4d (same folder, or the SD-card copy
//     for the jar's Xa*.rfc), and "on-scene": the share of collision vertices that lie on a
//     triangle of the scene (within 0.05 units). The collision must stay inside the scene's
//     bounds in x and z (collision walls are often taller than the visible ones, so y is
//     not compared);
//   - how the file differs from the SD-card copy of the same area (the English patch only
//     replaces text).
// Byte-identical copies are parsed once and collapsed (--all lists them). The files the game
// actually loads are the jar's Xa<N>_<M>.rfc (bp.java:140), so those are listed first.
// Exits non-zero if any .rfc or .roc fails. Oddities the game tolerates are printed as
// notes: an event type the game does not act on, a placement outside the collision bounds,
// bytes after the frame count of an .rde (the game stops reading there).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseRFC, checkRFC, bounds, CELL, GRID } from '../../web/src/formats/rfc.js';
import { parseROC, parseRDE, rdePoints } from '../../web/src/formats/rde.js';
import { parseD4D } from '../../web/src/formats/d4d.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const listAll = args.includes('--all');
const quiet = args.includes('--quiet');
const root = resolve(args.find((a) => !a.startsWith('--')) ?? join(repo, 'build/assets'));

function walk(dir, ext, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (name.toLowerCase().endsWith(ext)) out.push(p);
  }
  return out;
}
const sha1 = (b) => createHash('sha1').update(b).digest('hex');
const f1 = (v) => v.toFixed(1);
const box = (b) => (b.empty ? '(none)' : `[${b.min.map(f1).join(',')}]..[${b.max.map(f1).join(',')}]`);

// area "a2_1" of a file name, and where its other files live
const areaOf = (file) => /(a\d_\d)\.rfc$/i.exec(basename(file))?.[1].toLowerCase() ?? null;
function sdcardDir(area) {
  const dir = join(repo, 'build/assets/sdcard', `island${Number(area[1]) - 1}`);
  return existsSync(dir) ? dir : null;
}
function sibling(file, area, ext) {
  const here = join(dirname(file), area + ext);
  if (existsSync(here)) return here;
  const sd = sdcardDir(area);
  return sd && existsSync(join(sd, area + ext)) ? join(sd, area + ext) : null;
}

// a comparable form of a parsed file without the event texts
const shape = (rfc) => JSON.stringify([
  Array.from(rfc.vertices), rfc.gridOffset, rfc.faces.map((f) => [f.v, f.cell, f.attr]),
  rfc.attrs.map(({ offset, ...a }) => a),
  rfc.actors.map(({ offset, posOffset, ...a }) => a),
  rfc.events.map(({ offset, posOffset, text, textBytes, textLength, ...e }) => e),
]);
function versusSdcard(file, area, rfc) {
  const sd = sdcardDir(area);
  const other = sd && join(sd, area + '.rfc');
  if (!other || !existsSync(other) || resolve(other) === resolve(file)) return '';
  const b = parseRFC(new Uint8Array(readFileSync(other)));
  if (shape(rfc) === shape(b)) {
    const texts = rfc.events.filter((e, i) => e.text !== b.events[i].text).length;
    return texts ? `sd:text(${texts})` : 'sd:same';
  }
  const diffs = [];
  if (rfc.events.length === b.events.length) {
    rfc.events.forEach((e, i) => { if (e.type !== b.events[i].type) diffs.push(`event ${i} type ${b.events[i].type}->${e.type}`); });
  }
  return `sd:DIFFERS${diffs.length ? ` (${diffs.join(', ')})` : ''}`;
}

// largest factor by which an extent still fits GRID cells of CELL units
function fit(min, max) {
  const extent = max - min;
  return extent > 0 ? (GRID * CELL) / extent : Infinity;
}

// distance from point p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5)
function pointTriangle(p, a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const from = (q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const dist = (q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const along = (q, d, t) => [q[0] + d[0] * t, q[1] + d[1] * t, q[2] + d[2] * t];
  const ap = from(a), d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dist(a);
  const bp = from(b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dist(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return dist(along(a, ab, d1 / (d1 - d3)));
  const cp = from(c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dist(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return dist(along(a, ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return dist(along(b, [c[0] - b[0], c[1] - b[1], c[2] - b[2]], (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const den = 1 / (va + vb + vc);
  return dist(along(along(a, ab, vb * den), ac, vc * den));
}

const sceneCache = new Map();
function loadScene(d4d) {
  if (!sceneCache.has(d4d)) {
    const scene = parseD4D(readFileSync(d4d), { texturePrefix: basename(d4d) });
    const tris = [];
    for (const m of scene.meshes) {
      const at = (i) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
      for (const sub of m.submeshes) for (let k = 0; k < sub.indices.length; k += 3) tris.push([at(sub.indices[k]), at(sub.indices[k + 1]), at(sub.indices[k + 2])]);
    }
    sceneCache.set(d4d, { scene, tris });
  }
  return sceneCache.get(d4d);
}

function sceneCheck(file, area, rfc) {
  const d4d = sibling(file, area, '.d4d');
  if (!d4d) return { text: 'scene: (no .d4d found)', problems: [] };
  const { scene, tris } = loadScene(d4d);
  let on = 0;
  for (let i = 0; i < rfc.vertices.length; i += 3) {
    const p = [rfc.vertices[i], rfc.vertices[i + 1], rfc.vertices[i + 2]];
    for (const t of tris) if (pointTriangle(p, t[0], t[1], t[2]) < 0.05) { on++; break; }
  }
  const vb = bounds(rfc.vertices);
  // collision outside the scene's horizontal bounds would mean the two files describe
  // different spaces
  const slack = 0.5;
  const outside = [0, 2].some((c) => vb.min[c] < scene.boundsMin[c] - slack || vb.max[c] > scene.boundsMax[c] + slack);
  const share = rfc.vertexCount ? Math.round((100 * on) / rfc.vertexCount) : 0;
  return {
    text: `scene=[${scene.boundsMin.map(f1).join(',')}]..[${scene.boundsMax.map(f1).join(',')}] on-scene=${share}%`,
    problems: outside ? ['collision bounds reach more than 0.5 units outside the scene bounds in x or z'] : [],
    share,
  };
}

// ---------------------------------------------------------------------------
// .rfc
// ---------------------------------------------------------------------------
const rfcFiles = walk(root, '.rfc');
const rank = (p) => (p.includes('/localized/jar/') ? 0 : p.includes('/delocalized/jar/') ? 1 : p.includes('/sdcard/') ? 2 : 3);
rfcFiles.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

const seen = new Map();
let failures = 0, duplicates = 0, listed = 0;
const totals = { bytes: 0, vertices: 0, faces: 0, actors: 0, events: 0, minShare: 100, minFit: Infinity, minFitFile: '' };

for (const file of rfcFiles) {
  const rel = relative(repo, file);
  let bytes;
  try {
    bytes = new Uint8Array(readFileSync(file));
    const hash = sha1(bytes);
    const dupOf = seen.get(hash);
    if (dupOf && !listAll) { duplicates++; continue; }
    if (!dupOf) seen.set(hash, rel);

    const rfc = parseRFC(bytes);
    const { problems, notes, grid } = checkRFC(rfc);
    if (rfc.parsedBytes !== rfc.byteLength) problems.push(`parsed ${rfc.parsedBytes} of ${rfc.byteLength} bytes`);
    const area = areaOf(file);
    const vb = bounds(rfc.vertices);
    const placed = bounds([...rfc.actors, ...rfc.events].filter((x) => x.pos).map((x) => x.pos));
    // actors and events are placed inside the collision geometry
    if (!placed.empty && [0, 2].some((c) => placed.min[c] < vb.min[c] - 1 || placed.max[c] > vb.max[c] + 1)) notes.push('a placement lies more than 1 unit outside the collision bounds in x or z');
    const scene = area ? sceneCheck(file, area, rfc) : { text: '', problems: [] };
    problems.push(...scene.problems);
    const versus = area ? versusSdcard(file, area, rfc) : '';
    const fitX = fit(vb.min[0], vb.max[0]), fitZ = fit(vb.min[2], vb.max[2]);

    const ok = problems.length === 0;
    if (!ok) failures++;
    listed++;
    totals.bytes += rfc.byteLength; totals.vertices += rfc.vertexCount; totals.faces += rfc.faces.length;
    totals.actors += rfc.actors.length; totals.events += rfc.events.length;
    if (scene.share !== undefined && scene.share < totals.minShare) totals.minShare = scene.share;
    if (Math.min(fitX, fitZ) < totals.minFit) { totals.minFit = Math.min(fitX, fitZ); totals.minFitFile = rel; }
    if (quiet && ok) continue;
    console.log([
      ok ? 'OK  ' : 'FAIL',
      rel.padEnd(36),
      `${String(rfc.byteLength).padStart(5)}B left=${rfc.trailing.length}`,
      `v=${String(rfc.vertexCount).padStart(4)}`,
      `tri=${String(rfc.triCount).padStart(3)}`,
      `quad=${String(rfc.quadCount).padStart(3)}`,
      `attr=${String(rfc.attrs.length).padStart(2)}`,
      `actors=${String(rfc.actors.length).padStart(2)}`,
      `events=${String(rfc.events.length).padStart(2)}`,
      `grid=${rfc.gridOffset.join(',')} cells=${grid.usedCells} max/cell=${grid.maxPerCell} outside-cell=${grid.outsideCell}`,
      `bbox=${box(vb)}`,
      `placed=${box(placed)}`,
      `fit=x${fitX.toFixed(2)},z${fitZ.toFixed(2)}`,
      scene.text,
      versus,
      dupOf ? `(dup of ${dupOf})` : '',
      ok ? '' : `<< ${problems.join('; ')}`,
      notes.length ? `(note: ${notes.join('; ')})` : '',
    ].join(' ').replace(/ +/g, ' ').trimEnd());
  } catch (e) {
    failures++;
    console.log(`FAIL ${rel} ${bytes ? bytes.length + 'B' : ''} << ${e.message}`);
  }
}
console.log(`\n${rfcFiles.length} .rfc file(s): ${listed} parsed${quiet ? '' : ' and listed'}, ${duplicates} byte-identical duplicate(s) collapsed, ${failures} failure(s)`);
console.log(`totals: ${totals.bytes} bytes, ${totals.vertices} vertices, ${totals.faces} faces, ${totals.actors} actors, ${totals.events} events`);
console.log(`lowest share of collision vertices lying on the scene's surfaces: ${totals.minShare}%; tightest grid fit: x${totals.minFit.toFixed(2)} (${totals.minFitFile})`);

// ---------------------------------------------------------------------------
// .roc and .rde
// ---------------------------------------------------------------------------
function brief(ext, parse, describe, trailingIsFailure) {
  const files = walk(root, ext);
  const unique = new Map();
  for (const file of files) {
    const bytes = new Uint8Array(readFileSync(file));
    const hash = sha1(bytes);
    if (!unique.has(hash)) unique.set(hash, { file, bytes });
  }
  let bad = 0, notes = 0;
  const lines = [];
  for (const { file, bytes } of unique.values()) {
    const rel = relative(repo, file);
    try {
      const parsed = parse(bytes);
      if (parsed.trailing.length) {
        if (trailingIsFailure) { bad++; lines.push(`FAIL ${rel} ${parsed.trailing.length} byte(s) left`); }
        else { notes++; lines.push(`note ${rel} ${parsed.trailing.length} byte(s) after the last record`); }
      } else if (!quiet && describe) lines.push(`OK   ${rel.padEnd(36)} ${describe(parsed)}`);
    } catch (e) {
      bad++;
      lines.push(`FAIL ${rel} << ${e.message}`);
    }
  }
  return { files: files.length, unique: unique.size, bad, notes, lines };
}

const roc = brief('.roc', parseROC, null, true);
console.log(`\n${roc.files} .roc file(s), ${roc.unique} unique: ${roc.bad} failure(s)`);
for (const l of roc.lines) console.log(l);

const rde = brief('.rde', parseRDE, listAll ? (r) => {
  const pts = rdePoints(r);
  const scenes = r.assets.filter((a) => a.kind === 'scene').map((a) => a.name).join(',');
  return `${r.frames} frames, ${pts.length} positions ${box(bounds(pts.map((p) => p.v)))} scenes=${scenes}`;
} : null, false);
console.log(`\n${rde.files} .rde file(s), ${rde.unique} unique: ${rde.bad} failure(s), ${rde.notes} with bytes after the frame count`);
for (const l of rde.lines) console.log(l);

process.exit(failures || roc.bad || rde.bad ? 1 : 0);
