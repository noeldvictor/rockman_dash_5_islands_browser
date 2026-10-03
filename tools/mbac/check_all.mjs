#!/usr/bin/env node
// Runs the MBAC/MTRA parser + poser over every sample figure / action table and
// prints one line per (unique) file.
//   node tools/mbac/check_all.mjs [rootDir=build/assets] [--all] [--quiet]
// - parses every .mba/.mbac/.mtr/.mtra and every MTRA entry of every .all archive
//   (byte-identical copies are parsed once and collapsed; --all lists them too)
// - poses each model with the action table sharing its name stem in the same
//   directory (rock.mba <-> rock.mtr; r_<part>.mbac <-> r_NN_<part>.mtra entries of
//   r_mtra.all) at the first and last frame of every action
// Exits non-zero on any exception, NaN/Infinity, out-of-range index, unconsumed
// bytes, or parser warning. Size anomalies of posed bounding boxes are reported as
// notes only.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  parseMBAC, parseMTRA, parseALL, poseModel, evaluateAction, computeBoneMatrices,
} from '../../web/src/formats/mbac.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const listAll = args.includes('--all');
const quiet = args.includes('--quiet');
const root = resolve(args.find((a) => !a.startsWith('--')) ?? join(repo, 'build/assets'));

const MODEL_RE = /\.(mba|mbac)$/i;
const ANIM_RE = /\.(mtr|mtra)$/i;
const ALL_RE = /\.all$/i;

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (MODEL_RE.test(name) || ANIM_RE.test(name) || ALL_RE.test(name)) out.push(p);
  }
  return out;
}

const sha1 = (b) => createHash('sha1').update(b).digest('hex');
const stemOf = (name) => name.replace(/\.[^.]+$/, '').toLowerCase();
const f0 = (v) => v.toFixed(0);

function bboxOf(p) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  const size = max.map((v, k) => v - min[k]);
  return { min, max, size, diag: Math.hypot(...size) };
}
const allFinite = (arr) => { for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false; return true; };

// ---------------------------------------------------------------------------
// collect files (animations first so that models can look them up)
// ---------------------------------------------------------------------------
const files = walk(root, []);
// directory -> stem -> [{label, bytes}]   (animation sources)
const animsByDir = new Map();
const addAnim = (dir, stem, label, bytes) => {
  if (!animsByDir.has(dir)) animsByDir.set(dir, new Map());
  const m = animsByDir.get(dir);
  if (!m.has(stem)) m.set(stem, []);
  m.get(stem).push({ label, bytes });
};

// Model stems an action table named `stem` may belong to:
//   rock.mtr -> rock.mba                      (same stem)
//   e01_04_0.mtr -> e01_0.mba                 (<name>_<motion>_<variant>)
//   r_05_head.mtra -> r_head.mbac             (<name>_<motion>_<part>)
//   r_10_2_arm_blade.mtra -> r_arm_blade.mbac (<name>_<motion>_<sub>_<part>)
function partnerStems(stem) {
  const out = new Set([stem]);
  const t = stem.split('_');
  if (t.length >= 3 && /^\d+$/.test(t[1])) {
    out.add([t[0], ...t.slice(2)].join('_'));
    if (t.length >= 4 && /^\d+$/.test(t[2])) out.add([t[0], ...t.slice(3)].join('_'));
  }
  return [...out];
}

const items = []; // {kind:'model'|'anim', label, path, bytes}
let failures = 0;
const fail = (label, msg) => { failures++; console.log(`FAIL ${label}: ${msg}`); };

for (const file of files) {
  const rel = relative(repo, file);
  const name = basename(file);
  const bytes = readFileSync(file);
  if (ALL_RE.test(name)) {
    let entries;
    try {
      entries = parseALL(bytes);
    } catch (e) {
      fail(rel, `archive: ${e.message}`);
      continue;
    }
    let n = 0;
    for (const e of entries) {
      if (!ANIM_RE.test(e.name) && !MODEL_RE.test(e.name)) continue;
      n++;
      const label = `${rel}:${e.name}`;
      if (ANIM_RE.test(e.name)) {
        items.push({ kind: 'anim', label, bytes: e.bytes });
        for (const s of partnerStems(stemOf(e.name))) addAnim(dirname(file), s, label, e.bytes);
      } else {
        items.push({ kind: 'model', label, dir: dirname(file), stem: stemOf(e.name), bytes: e.bytes });
      }
    }
    if (!quiet) console.log(`ARCH ${rel}: ${entries.length} entries (${n} MBAC/MTRA), ${bytes.length} bytes, layout ok`);
  } else if (ANIM_RE.test(name)) {
    items.push({ kind: 'anim', label: rel, bytes });
    for (const s of partnerStems(stemOf(name))) addAnim(dirname(file), s, rel, bytes);
  } else {
    items.push({ kind: 'model', label: rel, dir: dirname(file), stem: stemOf(name), bytes });
  }
}
// sdcard copies first, so that duplicates elsewhere are the ones collapsed
items.sort((a, b) => Number(b.label.includes('sdcard/')) - Number(a.label.includes('sdcard/')));

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------
function checkModel(model, problems) {
  if (model.trailingBytes !== 0) problems.push(`${model.trailingBytes} unconsumed bytes`);
  for (const w of model.warnings) problems.push(w);
  if (model.version >= 4 && (!model.trailer || model.trailer.length !== 20)) problems.push('missing 20-byte trailer');
  // bones: acyclic (parent precedes child), vertex ranges tile [0, numVertices)
  let next = 0;
  for (const b of model.bones) {
    if (b.parent < -1 || b.parent >= b.index) problems.push(`bone ${b.index}: bad parent ${b.parent}`);
    if (b.vertexStart !== next) problems.push(`bone ${b.index}: vertex range not contiguous`);
    next = b.vertexStart + b.vertexCount;
  }
  if (next !== model.numVertices) problems.push(`bones cover ${next} of ${model.numVertices} vertices`);
  if (!allFinite(model.boneMatrices)) problems.push('non-finite bone matrix');
  for (let v = 0; v < model.numVertices; v++) {
    const b = model.bones[model.vertexBone[v]];
    if (!b || v < b.vertexStart || v >= b.vertexStart + b.vertexCount) { problems.push('vertexBone inconsistent'); break; }
  }
  // polygons / batches
  let tris = 0;
  let degenerate = 0;
  let polys = 0;
  for (const b of model.batches) {
    tris += b.numTriangles;
    polys += b.numPolygons;
    if (b.cornerVertex.length !== b.numTriangles * 3) problems.push('cornerVertex size mismatch');
    if (b.textured) {
      if (!b.uvs || b.uvs.length !== b.numCorners * 2) problems.push('uv array size mismatch');
      else if (!allFinite(b.uvs)) problems.push('non-finite uv');
      if (!(b.textureIndex >= 0 && b.textureIndex < model.numTextures)) problems.push(`texture index ${b.textureIndex} out of range`);
    } else if (!b.colors || b.colors.length !== b.numCorners * 3) problems.push('color array size mismatch');
    if (b.trianglePattern.length !== b.numTriangles || b.trianglePolygon.length !== b.numTriangles) problems.push('per-triangle array size mismatch');
    for (let i = 0; i < b.cornerVertex.length; i++) {
      if (b.cornerVertex[i] >= model.numVertices) { problems.push('vertex index out of range'); break; }
    }
    for (let i = 0; i < b.trianglePolygon.length; i++) {
      if (b.trianglePolygon[i] >= model.polygons.length) { problems.push('polygon index out of range'); break; }
      if (!model.patternMasks.includes(b.trianglePattern[i])) { problems.push('unknown pattern mask'); break; }
    }
    for (let i = 0; i < b.cornerVertex.length; i += 3) {
      const [a, c, d] = [b.cornerVertex[i], b.cornerVertex[i + 1], b.cornerVertex[i + 2]];
      if (a === c || c === d || a === d) degenerate++;
    }
  }
  const expectTris = model.numPolyT3 + model.numPolyC3 + 2 * (model.numPolyT4 + model.numPolyC4);
  if (tris !== expectTris) problems.push(`triangle count ${tris} != ${expectTris}`);
  if (polys !== model.polygons.length) problems.push(`batched polygons ${polys} != ${model.polygons.length}`);
  if (!allFinite(model.positions)) problems.push('non-finite bind position');
  if (model.normals && !allFinite(model.normals)) problems.push('non-finite bind normal');
  return { tris, degenerate };
}

function checkTable(table, problems) {
  if (table.trailingBytes !== 0) problems.push(`${table.trailingBytes} unconsumed bytes`);
  for (const w of table.warnings) problems.push(w);
  if (table.version >= 4 && (!table.trailer || table.trailer.length !== 20)) problems.push('missing 20-byte trailer');
  // header cross-check: transTypeCounts = number of tracks of each type
  const counts = new Array(8).fill(0);
  let maxFrames = 0;
  for (const a of table.actions) {
    maxFrames = Math.max(maxFrames, a.keyframes);
    if (a.maxFrame !== a.keyframes * 65536) problems.push(`action ${a.index}: maxFrame mismatch`);
    for (const t of a.boneTracks) {
      counts[t.type]++;
      for (const k of [t.translate, t.scale, t.rotate, t.roll]) {
        if (!k) continue;
        if (k.keys.length === 0) problems.push(`action ${a.index}: empty key track`);
        for (let i = 1; i < k.keys.length; i++) if (k.keys[i] <= k.keys[i - 1]) { problems.push(`action ${a.index}: keys not ascending`); break; }
        if (k.keys.length && k.keys[k.keys.length - 1] > a.keyframes) problems.push(`action ${a.index}: key ${k.keys[k.keys.length - 1]} beyond keyframes ${a.keyframes}`);
      }
    }
    for (const frame of [0, a.maxFrame]) {
      const m = evaluateAction(a, frame);
      if (!allFinite(m)) problems.push(`action ${a.index} frame ${frame >> 16}: non-finite action matrix`);
    }
  }
  if (counts.some((c, i) => c !== table.transTypeCounts[i])) {
    problems.push(`transTypeCounts header [${table.transTypeCounts}] != counted [${counts}]`);
  }
  return { maxFrames };
}

function poseAll(model, table, problems, notes) {
  const out = new Float32Array(model.numVertices * 3);
  const outN = model.localNormals ? new Float32Array(model.numVertices * 3) : null;
  const bind = bboxOf(model.positions);
  let poses = 0;
  let minRatio = Infinity;
  let maxRatio = 0;
  for (const a of table.actions) {
    for (const frame of a.maxFrame > 0 ? [0, a.maxFrame] : [0]) {
      out.fill(NaN);
      if (outN) outN.fill(NaN);
      poseModel(model, table, a.index, frame, out, outN ?? undefined);
      poses++;
      if (!allFinite(out)) { problems.push(`action ${a.index} frame ${frame >> 16}: non-finite position`); continue; }
      if (outN && !allFinite(outN)) problems.push(`action ${a.index} frame ${frame >> 16}: non-finite normal`);
      const world = computeBoneMatrices(model, a.matrices, a.boneTracks.length);
      if (!allFinite(world.subarray(0, model.numBones * 12))) problems.push(`action ${a.index}: non-finite bone matrix`);
      if (model.numVertices > 0 && bind.diag > 0) {
        const ratio = bboxOf(out).diag / bind.diag;
        minRatio = Math.min(minRatio, ratio);
        maxRatio = Math.max(maxRatio, ratio);
      }
    }
  }
  if (maxRatio > 4 || minRatio < 0.25) notes.push(`posed/bind bbox diagonal ratio ${minRatio.toFixed(2)}..${maxRatio.toFixed(2)}`);
  return { poses, minRatio, maxRatio };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
const seen = new Map();
const parsedTables = new Map(); // sha1 -> table (or null if it failed)
const totals = { models: 0, anims: 0, dupModels: 0, dupAnims: 0, vertices: 0, triangles: 0, actions: 0, poses: 0, paired: 0, unpaired: 0 };
const versions = new Map();

function getTable(bytes) {
  const h = sha1(bytes);
  if (!parsedTables.has(h)) {
    try { parsedTables.set(h, parseMTRA(bytes)); } catch { parsedTables.set(h, null); }
  }
  return parsedTables.get(h);
}

for (const item of items) {
  const hash = `${item.kind}:${sha1(item.bytes)}`;
  const dupOf = seen.get(hash);
  const problems = [];
  const notes = [];
  let line = '';
  try {
    if (item.kind === 'anim') {
      if (dupOf && !listAll) { totals.dupAnims++; continue; }
      const table = parseMTRA(item.bytes);
      const { maxFrames } = checkTable(table, problems);
      totals.anims++;
      totals.actions += table.numActions;
      versions.set(`MTRA v${table.version}`, (versions.get(`MTRA v${table.version}`) ?? 0) + 1);
      const types = table.transTypeCounts.slice(0, 7).join('/');
      const dyn = table.actions.reduce((n, a) => n + (a.dynamic ? a.dynamic.length : 0), 0);
      line = `MTRA v${table.version} actions ${String(table.numActions).padStart(3)} bones ${String(table.numBones).padStart(2)} ` +
        `maxKeyframes ${String(maxFrames).padStart(3)} types[0-6] ${types} patternKeys ${dyn}`;
    } else {
      // pose with all same-stem tables in the same directory, even for duplicates
      // of an already-seen model (the partner may differ) -- but only list once.
      const model = parseMBAC(item.bytes);
      const { tris, degenerate } = checkModel(model, problems);
      const partners = animsByDir.get(item.dir)?.get(item.stem) ?? [];
      let poses = 0;
      let actions = 0;
      const partnerSeen = new Set();
      for (const p of partners) {
        const ph = sha1(p.bytes);
        if (partnerSeen.has(ph)) continue;
        partnerSeen.add(ph);
        const table = getTable(p.bytes);
        if (!table) { problems.push(`partner ${basename(p.label)} failed to parse`); continue; }
        if (table.numBones !== model.numBones) notes.push(`${p.label.split(':').pop().split('/').pop()}: ${table.numBones} action bones vs ${model.numBones} model bones`);
        const r = poseAll(model, table, problems, notes);
        poses += r.poses;
        actions += table.numActions;
      }
      if (dupOf && !listAll && problems.length === 0) { totals.dupModels++; continue; }
      totals.models++;
      totals.vertices += model.numVertices;
      totals.triangles += tris;
      totals.poses += poses;
      if (partners.length) totals.paired++; else totals.unpaired++;
      versions.set(`MBAC v${model.version}`, (versions.get(`MBAC v${model.version}`) ?? 0) + 1);
      const s = bboxOf(model.positions).size;
      line = `MBAC v${model.version} f${model.vertexFormat}${model.normalFormat}${model.polygonFormat} ` +
        `verts ${String(model.numVertices).padStart(4)} bones ${String(model.numBones).padStart(2)} ` +
        `polys T ${model.numPolyT3}+${model.numPolyT4} C ${model.numPolyC3}+${model.numPolyC4} tris ${String(tris).padStart(4)} ` +
        `batches ${model.batches.length} tex ${model.numTextures} pat ${model.numPatterns} ` +
        `bbox ${f0(s[0])}x${f0(s[1])}x${f0(s[2])}` +
        `${degenerate ? ` degenerate ${degenerate}` : ''}` +
        (partnerSeen.size ? ` | posed: ${partnerSeen.size} table(s), ${actions} actions, ${poses} poses` : ' | no action table');
    }
  } catch (e) {
    problems.push(`EXCEPTION ${e.message}`);
  }
  if (!dupOf) seen.set(hash, item.label);
  const ok = problems.length === 0;
  if (!ok) failures++;
  if (!quiet || !ok || notes.length) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${item.label}: ${line}${dupOf ? ` (dup of ${dupOf})` : ''}` +
      `${notes.length ? `  NOTE ${[...new Set(notes)].join('; ')}` : ''}${ok ? '' : `  PROBLEMS ${[...new Set(problems)].join('; ')}`}`);
  }
}

console.log('');
console.log(`models: ${totals.models} unique (${totals.dupModels} byte-identical copies skipped), ` +
  `${totals.vertices} vertices, ${totals.triangles} triangles; ${totals.paired} with action table, ${totals.unpaired} without`);
console.log(`action tables: ${totals.anims} unique (${totals.dupAnims} copies skipped), ${totals.actions} actions; ${totals.poses} poses evaluated`);
console.log(`versions: ${[...versions.entries()].map(([k, v]) => `${k} x${v}`).join(', ')}`);
console.log(failures ? `${failures} FAILURE(S)` : 'all ok');
process.exit(failures ? 1 : 0);
