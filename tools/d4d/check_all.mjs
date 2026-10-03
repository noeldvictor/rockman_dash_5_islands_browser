#!/usr/bin/env node
// Runs the D4D parser over every sample map and prints one line per file.
//   node tools/d4d/check_all.mjs [rootDir=build/assets] [--all]
// By default only build/assets/sdcard/** is listed in full; byte-identical copies
// elsewhere are still parsed but collapsed into a count (use --all to list them).
// Exits non-zero if any file fails to parse, has unparsed bytes, a bad checksum,
// out-of-range references, or a texture whose BMP is missing.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseD4D, decodeD4DTextureBMP } from '../../web/src/formats/d4d.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const listAll = args.includes('--all');
const root = resolve(args.find((a) => !a.startsWith('--')) ?? join(repo, 'build/assets'));

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.toLowerCase().endsWith('.d4d')) out.push(p);
  }
  return out;
}

const files = walk(root, []);
// list sdcard copies first so that duplicates elsewhere are the ones collapsed
files.sort((a, b) => Number(b.includes('/sdcard/')) - Number(a.includes('/sdcard/')) || a.localeCompare(b));

const f1 = (v) => v.toFixed(1);
const seen = new Map();
let failures = 0, duplicates = 0, listed = 0;
const totals = { bytes: 0, unparsed: 0, vertices: 0, triangles: 0 };

for (const file of files) {
  const rel = relative(repo, file);
  let bytes;
  try {
    bytes = readFileSync(file);
    const scene = parseD4D(bytes, { texturePrefix: basename(file) });
    const problems = [...scene.warnings];
    if (scene.unparsedBytes) problems.push(`${scene.unparsedBytes} unparsed bytes`);
    if (scene.accountedBytes + scene.unparsedBytes !== scene.byteLength) problems.push(`byte accounting off: ${scene.accountedBytes}+${scene.unparsedBytes} != ${scene.byteLength}`);
    if (scene.meshes.length === 0) problems.push('no mesh');

    let uvMin = Infinity, uvMax = -Infinity, degenerate = 0;
    for (const m of scene.meshes) {
      for (const v of m.positions) if (!Number.isFinite(v)) { problems.push('non-finite position'); break; }
      if (m.uvs) for (const v of m.uvs) { if (v < uvMin) uvMin = v; if (v > uvMax) uvMax = v; }
      if (m.colors && m.colors.length !== m.vertexCount * m.colorItemSize) problems.push('colour array size mismatch');
      if (m.uvs && m.uvs.length !== m.vertexCount * 2) problems.push('uv array size mismatch');
      for (const s of m.submeshes) {
        if (s.material < 0) problems.push('submesh without material');
        for (let i = 0; i < s.indices.length; i += 3) {
          const [a, b, c] = [s.indices[i], s.indices[i + 1], s.indices[i + 2]];
          if (a >= m.vertexCount || b >= m.vertexCount || c >= m.vertexCount) { problems.push('index out of range'); break; }
          if (a === b || b === c || a === c) degenerate++;
        }
      }
    }
    // textures: every referenced BMP must exist and decode
    let texMissing = 0;
    const usesAlpha = new Set();
    for (const m of scene.materials) if (m.usesTextureAlpha && m.textureFileName) usesAlpha.add(m.textureFileName);
    for (const im of scene.images) {
      const p = join(dirname(file), im.fileName);
      if (!existsSync(p)) { texMissing++; problems.push(`missing ${im.fileName}`); continue; }
      const tex = decodeD4DTextureBMP(readFileSync(p));
      if (usesAlpha.has(im.fileName) && tex.alphaValues.every((a) => a === 0)) problems.push(`${im.fileName} is alpha-blended/tested but fully transparent`);
    }

    const hash = createHash('sha1').update(bytes).digest('hex');
    const dupOf = seen.get(hash);
    if (!dupOf) seen.set(hash, rel);
    const ok = problems.length === 0;
    if (!ok) failures++;
    if (dupOf && ok && !listAll) { duplicates++; continue; }

    totals.bytes += scene.byteLength; totals.unparsed += scene.unparsedBytes;
    totals.vertices += scene.vertexCount; totals.triangles += scene.triangleCount;
    listed++;
    const mesh = scene.meshes[0];
    console.log([
      ok ? 'OK  ' : 'FAIL',
      rel.padEnd(38),
      `${String(scene.byteLength).padStart(6)}B`,
      `obj=${String(scene.objects.length - 2).padStart(2)}`,
      `sub=${String(mesh ? mesh.submeshes.length : 0).padStart(2)}`,
      `v=${String(scene.vertexCount).padStart(4)}`,
      `tri=${String(scene.triangleCount).padStart(4)}`,
      `tex=${String(scene.images.length).padStart(2)}`,
      `anim=${scene.animations.length}`,
      `bbox=[${scene.boundsMin.map(f1).join(',')}]..[${scene.boundsMax.map(f1).join(',')}]`,
      `uv=${f1(uvMin)}..${f1(uvMax)}`,
      `degen=${degenerate}`,
      `unparsed=${scene.unparsedBytes}`,
      dupOf ? `(dup of ${dupOf})` : '',
      ok ? '' : `<< ${problems.join('; ')}`,
    ].join(' ').trimEnd());
  } catch (e) {
    failures++;
    console.log(`FAIL ${rel} ${bytes ? bytes.length + 'B' : ''} << ${e.message}`);
  }
}

console.log(`\n${files.length} file(s) parsed: ${listed} listed, ${duplicates} byte-identical duplicate(s) collapsed, ${failures} failure(s)`);
console.log(`listed totals: ${totals.bytes} bytes, ${totals.unparsed} unparsed, ${totals.vertices} vertices, ${totals.triangles} triangles`);
process.exit(failures ? 1 : 0);
