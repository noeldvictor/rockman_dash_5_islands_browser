#!/usr/bin/env node
// Summarise a MascotCapsule MBAC figure (and optionally an MTRA action table) and
// optionally export the posed mesh as Wavefront OBJ.
//
//   node tools/mbac/dump.mjs <model.mba|.mbac> [<anim.mtr|.mtra> [action [frame]]] [--obj out.obj] [--file-winding] [--bones]
//
//   action  action index (default 0)
//   frame   in KEYFRAME units, may be fractional (default 0); it is multiplied by
//           65536 to get the 16.16 value poseModel()/Figure.setPosture() take.
//   --obj   write the posed mesh in the file's own coordinates (right-handed; this
//           game's characters are +Y up, facing +Z). Faces are written counter-
//           clockwise (OBJ / three.js convention), i.e. with the file's clockwise
//           order flipped, unless --file-winding is given. Polygons hidden by the
//           action's pattern keys at that frame are left out.
//   --file-winding  keep the file's (clockwise-front) corner order in the OBJ
//   --bones list every bone / every bone track
//   <anim> may also be "archive.all:entryName" to use an entry of a .all archive.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  parseMBAC, parseMTRA, parseBMP, parseALL, poseModel, isPatternVisible, getActionPattern, BLEND_NAMES,
} from '../../web/src/formats/mbac.js';

const argv = process.argv.slice(2);
const flags = { obj: null, fileWinding: false, bones: false };
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--obj') flags.obj = argv[++i];
  else if (argv[i] === '--file-winding') flags.fileWinding = true;
  else if (argv[i] === '--bones') flags.bones = true;
  else pos.push(argv[i]);
}
if (pos.length < 1 || (argv.includes('--obj') && !flags.obj)) {
  console.error('usage: node tools/mbac/dump.mjs <model> [<anim> [action [frame]]] [--obj out.obj] [--file-winding] [--bones]');
  process.exit(2);
}

const [modelPath, animPath] = pos;
const actionIndex = pos[2] !== undefined ? Number(pos[2]) : 0;
const frameKeys = pos[3] !== undefined ? Number(pos[3]) : 0;
const frame = Math.round(frameKeys * 65536);

const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
const vec = (a) => `(${a.map(fmt).join(', ')})`;
function bbox(p) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  return { min, max, size: max.map((v, k) => v - min[k]) };
}

function loadAnim(spec) {
  const m = /^(.*\.all):(.+)$/i.exec(spec);
  if (!m) return parseMTRA(readFileSync(spec));
  const entry = parseALL(readFileSync(m[1])).find((e) => e.name === m[2]);
  if (!entry) throw new Error(`no entry "${m[2]}" in ${m[1]}`);
  return parseMTRA(entry.bytes);
}

const model = parseMBAC(readFileSync(modelPath));
console.log(`MBAC ${modelPath}`);
console.log(`  version ${model.version}  formats: vertex ${model.vertexFormat}, normal ${model.normalFormat}, ` +
  `polygon ${model.polygonFormat}, bone ${model.boneFormat}`);
console.log(`  vertices ${model.numVertices}  normals ${model.localNormals ? 'yes' : 'no'}  bones ${model.numBones}  ` +
  `textures ${model.numTextures}  patterns ${model.numPatterns}  colors ${model.numColors}`);
console.log(`  polygons: T3 ${model.numPolyT3}  T4 ${model.numPolyT4}  C3 ${model.numPolyC3}  C4 ${model.numPolyC4}  ` +
  `-> ${model.batches.reduce((a, b) => a + b.numTriangles, 0)} triangles in ${model.batches.length} batches`);
const enc = model.polygonEncoding;
if (enc.textured) console.log(`  textured encoding: ${JSON.stringify(enc.textured)}`);
if (enc.colored) console.log(`  coloured encoding: ${JSON.stringify(enc.colored)}`);
const bb = bbox(model.positions);
console.log(`  bind bbox min ${vec(bb.min)} max ${vec(bb.max)} size ${vec(bb.size)}`);
const lb = bbox(model.localPositions);
console.log(`  bone-local (raw) bbox min ${vec(lb.min)} max ${vec(lb.max)}`);
console.log(`  trailing bytes ${model.trailingBytes}  trailer ${model.trailer ? Buffer.from(model.trailer).toString('hex') : '-'}`);
for (const w of model.warnings) console.log(`  WARNING: ${w}`);

console.log('  patterns:');
model.patternCounts.forEach((p, i) => {
  console.log(`    [${i}] mask 0x${model.patternMasks[i].toString(16)}  C3 ${p.c3} C4 ${p.c4}  ` +
    p.tex.map((t, j) => `tex${j}: T3 ${t[0]} T4 ${t[1]}`).join('  '));
});

console.log('  batches:');
model.batches.forEach((b, i) => {
  const f = [];
  if (b.transparent) f.push('colorkey');
  if (b.doubleSided) f.push('double-sided');
  if (b.lighting) f.push('lighting');
  if (b.specular) f.push('specular');
  let uvr = '';
  if (b.uvs) {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < b.uvs.length; k += 2) {
      u0 = Math.min(u0, b.uvs[k]); u1 = Math.max(u1, b.uvs[k]);
      v0 = Math.min(v0, b.uvs[k + 1]); v1 = Math.max(v1, b.uvs[k + 1]);
    }
    uvr = `  uv(texels) u ${u0}..${u1} v ${v0}..${v1}`;
  } else {
    const set = new Set();
    for (let k = 0; k < b.colors.length; k += 3) set.add(`#${[b.colors[k], b.colors[k + 1], b.colors[k + 2]].map((c) => c.toString(16).padStart(2, '0')).join('')}`);
    uvr = `  colors ${[...set].slice(0, 6).join(' ')}${set.size > 6 ? ` (+${set.size - 6})` : ''}`;
  }
  console.log(`    [${i}] ${b.textured ? `tex ${b.textureIndex}` : 'flat '}  material 0x${b.material.toString(16).padStart(2, '0')}  ` +
    `blend ${BLEND_NAMES[b.blendMode]}  ${f.join(',') || '-'}  polys ${b.numPolygons} tris ${b.numTriangles}  ` +
    `patterns 0x${b.patternUnion.toString(16)}${uvr}`);
});

console.log(`  bones: ${model.numBones} (roots: ${model.bones.filter((b) => b.parent < 0).map((b) => b.index).join(',')})`);
if (flags.bones) {
  for (const b of model.bones) {
    const m = b.matrix;
    console.log(`    [${b.index}] parent ${b.parent}  vertices ${b.vertexStart}..${b.vertexStart + b.vertexCount - 1} (${b.vertexCount})  ` +
      `t ${vec([m[3], m[7], m[11]])}  r [${[m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]].map((v) => v.toFixed(3)).join(' ')}]`);
  }
}

let table = null;
if (animPath) {
  table = loadAnim(animPath);
  console.log(`MTRA ${animPath}`);
  console.log(`  version ${table.version}  actions ${table.numActions}  bones ${table.numBones}` +
    `${table.numBones !== model.numBones ? `  (model has ${model.numBones}!)` : ''}  ` +
    `typeCounts [${table.transTypeCounts.join(',')}]  dataSize ${table.dataSize}  trailing bytes ${table.trailingBytes}`);
  for (const w of table.warnings) console.log(`  WARNING: ${w}`);
  const tmp = new Float32Array(model.numVertices * 3);
  for (const a of table.actions) {
    const types = a.boneTracks.map((t) => t.type).join('');
    poseModel(model, table, a.index, 0, tmp);
    const b0 = bbox(tmp);
    poseModel(model, table, a.index, a.maxFrame, tmp);
    const b1 = bbox(tmp);
    console.log(`  action ${String(a.index).padStart(2)}: keyframes ${a.keyframes}  maxFrame ${a.maxFrame} (0x${a.maxFrame.toString(16)})  ` +
      `track types ${types}  dynamic ${a.dynamic && a.dynamic.length ? a.dynamic.map((d) => `${d.frame}:0x${(d.pattern >>> 0).toString(16)}`).join(' ') : '-'}`);
    console.log(`             bbox size @0 ${vec(b0.size)}  @max ${vec(b1.size)}`);
    if (flags.bones) {
      a.boneTracks.forEach((t, i) => {
        const n = (k) => (k ? k.keys.length : 0);
        console.log(`      bone ${i}: type ${t.type}  keys T ${n(t.translate)} S ${n(t.scale)} R ${n(t.rotate)} roll ${n(t.roll)}`);
      });
    }
  }
}

// ---- pose -----------------------------------------------------------------
const posed = new Float32Array(model.numVertices * 3);
const posedN = model.localNormals ? new Float32Array(model.numVertices * 3) : null;
poseModel(model, table, actionIndex, frame, posed, posedN ?? undefined);
const pb = bbox(posed);
if (table) {
  console.log(`posed with action ${actionIndex} frame ${frameKeys} (16.16: ${frame}): bbox min ${vec(pb.min)} max ${vec(pb.max)} size ${vec(pb.size)}`);
} else {
  console.log('posed: bind pose');
}

if (flags.obj) {
  // texture sizes for UV normalisation: look for <stem>_NN.bmp / <stem>.bmp next to the model
  const stem = basename(modelPath).replace(/\.[^.]+$/, '');
  const dir = dirname(modelPath);
  const texSize = [];
  for (let t = 0; t < model.numTextures; t++) {
    const cands = [`${stem}_${String(t).padStart(2, '0')}.bmp`, `${stem}.bmp`];
    const found = cands.map((c) => join(dir, c)).find((p) => existsSync(p));
    if (found) {
      try {
        const bmp = parseBMP(readFileSync(found));
        texSize.push({ w: bmp.width, h: bmp.height, file: basename(found) });
        continue;
      } catch { /* fall through */ }
    }
    texSize.push({ w: 256, h: 256, file: null });
  }
  const pattern = table ? getActionPattern(table, actionIndex, frame, 0xffffffff) : 0xffffffff;
  const out = [];
  out.push(`# ${basename(modelPath)}${table ? ` posed with ${basename(animPath)} action ${actionIndex} frame ${frameKeys}` : ' bind pose'}`);
  out.push(`# coordinates as stored (right-handed); faces ${flags.fileWinding ? 'in file order (clockwise front)' : 'flipped to counter-clockwise front'}`);
  out.push(`# vt = (u / texW, 1 - v / texH); texture sizes: ${texSize.map((t, i) => `${i}:${t.w}x${t.h}${t.file ? ` ${t.file}` : ' (assumed)'}`).join(', ')}`);
  for (let i = 0; i < posed.length; i += 3) out.push(`v ${posed[i]} ${posed[i + 1]} ${posed[i + 2]}`);
  if (posedN) {
    for (let i = 0; i < posedN.length; i += 3) {
      const l = Math.hypot(posedN[i], posedN[i + 1], posedN[i + 2]) || 1;
      out.push(`vn ${(posedN[i] / l).toFixed(5)} ${(posedN[i + 1] / l).toFixed(5)} ${(posedN[i + 2] / l).toFixed(5)}`);
    }
  }
  let vt = 0;
  model.batches.forEach((b, bi) => {
    out.push(`g batch${bi}_${b.textured ? `tex${b.textureIndex}` : 'flat'}_m${b.material.toString(16)}`);
    out.push(`usemtl ${b.textured ? `tex${b.textureIndex}` : 'flat'}`);
    const ts = b.textured ? texSize[b.textureIndex] ?? { w: 256, h: 256 } : null;
    for (let t = 0; t < b.numTriangles; t++) {
      if (!isPatternVisible(b.trianglePattern[t], pattern)) continue;
      const refs = [];
      for (let k = 0; k < 3; k++) {
        const c = t * 3 + k;
        const v = b.cornerVertex[c] + 1;
        let ref = String(v);
        if (b.uvs) {
          out.push(`vt ${(b.uvs[c * 2] / ts.w).toFixed(5)} ${(1 - b.uvs[c * 2 + 1] / ts.h).toFixed(5)}`);
          vt++;
          ref += `/${vt}`;
          if (posedN) ref += `/${v}`;
        } else if (posedN) {
          ref += `//${v}`;
        }
        refs.push(ref);
      }
      // batches are in file (clockwise-front) order
      if (flags.fileWinding) out.push(`f ${refs[0]} ${refs[1]} ${refs[2]}`);
      else out.push(`f ${refs[0]} ${refs[2]} ${refs[1]}`);
    }
  });
  writeFileSync(flags.obj, `${out.join('\n')}\n`);
  console.log(`wrote ${flags.obj} (${model.numVertices} vertices, ${out.filter((l) => l.startsWith('f ')).length} faces)`);
}
