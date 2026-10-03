#!/usr/bin/env node
// Structural dump of a .d4d map, optional OBJ export.
//   node tools/d4d/dump.mjs <file.d4d> [--obj out.obj] [--objects]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseD4D, d4dTextureFileName, sampleD4DTrack } from '../../web/src/formats/d4d.js';

const args = process.argv.slice(2);
let file = null, objOut = null, listObjects = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--obj') objOut = args[++i];
  else if (args[i] === '--objects') listObjects = true;
  else if (!file) file = args[i];
}
if (!file) {
  console.error('usage: node tools/d4d/dump.mjs <file.d4d> [--obj out.obj] [--objects]');
  process.exit(2);
}

const f = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/\.?0+$/, ''));
const vec = (a) => `[${Array.from(a, f).join(', ')}]`;

const bytes = readFileSync(file);
const scene = parseD4D(bytes, { texturePrefix: basename(file) });

console.log(`${file}: ${scene.byteLength} bytes`);
console.log(`header: magic=${scene.header.magic} variant=${scene.header.variant} totalSectionBytes=${scene.header.totalSectionBytes} objectCount=${scene.header.objectCount}`);
for (const [i, s] of scene.sections.entries()) {
  console.log(`section ${i}: offset=${s.offset} total=${s.totalLength} data=${s.uncompressedLength} objects=${s.objectCount} checksum=${s.checksum.toString(16).padStart(8, '0')} ${s.checksumValid ? 'ok' : 'MISMATCH'}`);
}
const counts = {};
for (const o of scene.objects) if (o) counts[o.typeName] = (counts[o.typeName] ?? 0) + 1;
console.log('objects: ' + Object.entries(counts).map(([k, v]) => `${k}x${v}`).join(' '));
if (listObjects) {
  for (const o of scene.objects) if (o) console.log(`  #${o.index} @${o.offset} ${o.typeName} len=${o.length} userID=${o.userID ?? '-'}`);
}

console.log('\nnodes:');
const printNode = (i, depth) => {
  const n = scene.nodes[i];
  const t = n.transform.isIdentity ? 'identity' : `T=${vec(n.transform.translation)} S=${vec(n.transform.scale)} R=${f(n.transform.rotation.angleDegrees)}deg@${vec(n.transform.rotation.axis)}`;
  console.log(`${'  '.repeat(depth + 1)}[${i}] ${n.type} #${n.objectIndex} transform=${t} visible=${n.visible}${n.mesh >= 0 ? ` mesh=${n.mesh}` : ''}`);
  for (const c of n.children) printNode(c, depth + 1);
};
for (const r of scene.roots) printNode(r, 0);

console.log('\nimages:');
for (const [i, im] of scene.images.entries()) {
  const path = join(dirname(file), im.fileName);
  console.log(`  [${i}] #${im.objectIndex} userID=${im.userID} ${im.format} ${im.width}x${im.height}${im.isPlaceholder ? ' (placeholder)' : ''} -> ${im.fileName}${existsSync(path) ? '' : ' (MISSING)'}`);
}

console.log('\nmaterials:');
for (const [i, m] of scene.materials.entries()) {
  const tex = m.texture >= 0 ? scene.textures[m.texture] : null;
  const extra = [];
  if (m.alphaThreshold) extra.push(`alphaTest=${f(m.alphaThreshold)}`);
  if (!m.depthWrite) extra.push('noDepthWrite');
  if (m.depthOffsetFactor || m.depthOffsetUnits) extra.push(`polyOffset=${f(m.depthOffsetFactor)},${f(m.depthOffsetUnits)}`);
  if (m.doubleSided) extra.push('doubleSided');
  if (tex && tex.animationTracks.length) extra.push(`animTracks=${tex.animationTracks.join(',')}`);
  if (tex && !tex.transform.isIdentity) extra.push(`texT=${vec(tex.transform.translation)}`);
  console.log(`  [${i}] layer=${m.layer} blend=${m.blendMode} cull=${m.culling} tex=${m.textureFileName ?? '-'}${tex ? ` (${tex.blending},${tex.wrapS},${tex.imageFilter})` : ''} ${extra.join(' ')}`);
}

console.log('\nmeshes:');
for (const [i, m] of scene.meshes.entries()) {
  console.log(`  [${i}] #${m.objectIndex} vertices=${m.vertexCount} colors=${m.colors ? (m.colorItemSize === 4 ? 'RGBA' : 'RGB') : 'none'} normals=${m.normals ? 'yes' : 'none'} uvSets=${m.uvSets.length} scale=${f(m.positionScale)} bias=${vec(m.positionBias)}`);
  console.log(`      bounds ${vec(m.boundsMin)} .. ${vec(m.boundsMax)}`);
  if (m.uvs) {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < m.uvs.length; k += 2) {
      u0 = Math.min(u0, m.uvs[k]); u1 = Math.max(u1, m.uvs[k]);
      v0 = Math.min(v0, m.uvs[k + 1]); v1 = Math.max(v1, m.uvs[k + 1]);
    }
    console.log(`      uv range s ${f(u0)}..${f(u1)}  t ${f(v0)}..${f(v1)}`);
  }
  for (const [j, s] of m.submeshes.entries()) {
    console.log(`      submesh ${j}: triangles=${s.triangleCount} material=${s.material} ${s.indices.constructor.name}${s.sourceIsTriangleList ? '' : ' (from strips)'}`);
  }
}

if (scene.animations.length) {
  console.log('\nanimations:');
  for (const [i, a] of scene.animations.entries()) {
    const keys = [];
    for (let k = 0; k < a.keyframeCount; k++) keys.push(`${a.times[k]}:${vec(a.values.subarray(k * a.componentCount, (k + 1) * a.componentCount))}`);
    const tg = a.targets.map((t) => `${t.kind}[${t.index}]`).join(',');
    console.log(`  [${i}] ${a.property} of ${tg} ${a.interpolation}/${a.repeatMode} duration=${a.duration} keys ${keys.join(' ')}`);
    console.log(`      sample t=0 ${vec(sampleD4DTrack(scene, i, 0))} t=${a.duration >> 1} ${vec(sampleD4DTrack(scene, i, a.duration >> 1))}`);
  }
}

console.log(`\ntotals: vertices=${scene.vertexCount} triangles=${scene.triangleCount} bounds ${vec(scene.boundsMin)} .. ${vec(scene.boundsMax)}`);
console.log(`bytes: accounted=${scene.accountedBytes} unparsed=${scene.unparsedBytes} of ${scene.byteLength}`);
for (const u of scene.unknownRanges) console.log(`  unknown @${u.offset} +${u.length}: ${u.what}`);
for (const w of scene.warnings) console.log(`warning: ${w}`);

if (objOut) {
  const lines = [`# ${basename(file)} exported by tools/d4d/dump.mjs`, `mtllib ${basename(objOut).replace(/\.obj$/i, '')}.mtl`];
  const mtl = [];
  let base = 1;
  for (const [mi, m] of scene.meshes.entries()) {
    lines.push(`o mesh${mi}`);
    for (let i = 0; i < m.vertexCount; i++) {
      let line = `v ${m.positions[i * 3]} ${m.positions[i * 3 + 1]} ${m.positions[i * 3 + 2]}`;
      if (m.colors) {
        const c = m.colorItemSize;
        line += ` ${(m.colors[i * c] / 255).toFixed(4)} ${(m.colors[i * c + 1] / 255).toFixed(4)} ${(m.colors[i * c + 2] / 255).toFixed(4)}`;
      }
      lines.push(line);
    }
    // OBJ has v up, the file has t down
    if (m.uvs) for (let i = 0; i < m.vertexCount; i++) lines.push(`vt ${m.uvs[i * 2]} ${1 - m.uvs[i * 2 + 1]}`);
    for (const [si, s] of m.submeshes.entries()) {
      const name = `mat${s.material}`;
      lines.push(`g mesh${mi}_sub${si}`, `usemtl ${name}`);
      for (let i = 0; i < s.indices.length; i += 3) {
        const [a, b, c] = [s.indices[i] + base, s.indices[i + 1] + base, s.indices[i + 2] + base];
        lines.push(m.uvs ? `f ${a}/${a} ${b}/${b} ${c}/${c}` : `f ${a} ${b} ${c}`);
      }
    }
    base += m.vertexCount;
  }
  for (const [i, m] of scene.materials.entries()) {
    mtl.push(`newmtl mat${i}`, 'Kd 1 1 1');
    if (m.textureUserID >= 0) mtl.push(`map_Kd ${d4dTextureFileName(basename(file), m.textureUserID)}`);
    mtl.push('');
  }
  writeFileSync(objOut, lines.join('\n') + '\n');
  writeFileSync(objOut.replace(/\.obj$/i, '') + '.mtl', mtl.join('\n'));
  console.log(`wrote ${objOut} (+ .mtl)`);
}
