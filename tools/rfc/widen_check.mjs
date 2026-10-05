// Check the area widening (web/src/host/roomy.js) on every room file: widen each by a factor,
// parse the result again with the same checks as the shipped files, and compare what must and
// must not have changed.
//
//   node tools/rfc/widen_check.mjs [factor=1.4] [root=build/assets/localized/jar]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRFC, checkRFC } from '../../web/src/formats/rfc.js';
import { widenRFC } from '../../web/src/host/roomy.js';

const s = Number(process.argv[2] ?? 1.4);
const root = process.argv[3] ?? 'build/assets/localized/jar';
let ok = 0, refused = 0, bad = 0;
for (const file of readdirSync(root).filter((f) => /\.rfc$/i.test(f)).sort()) {
  const bytes = new Uint8Array(readFileSync(join(root, file)));
  const before = parseRFC(bytes);
  let out;
  try {
    out = widenRFC(bytes, s);
  } catch (e) {
    refused++;
    console.log(`${file}: not widened: ${e.message}`);
    continue;
  }
  const after = parseRFC(out);
  const problems = [...(checkRFC(after).problems ?? checkRFC(after).errors ?? [])];
  if (after.parsedBytes !== out.length) problems.push('bytes left over');
  // total surface must be the original's with x and z stretched: compare the area of the faces
  const area = (rfc, k) => {
    let sum = 0;
    for (const f of rfc.faces) {
      const p = f.v.map((i) => [rfc.vertices[i * 3] * k, rfc.vertices[i * 3 + 1], rfc.vertices[i * 3 + 2] * k]);
      for (let i = 1; i + 1 < p.length; i++) {
        const [a, b, c] = [p[0], p[i], p[i + 1]];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        sum += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
      }
    }
    return sum;
  };
  const want = area(before, s), got = area(after, 1);
  if (Math.abs(want - got) > want * 1e-3) problems.push(`surface ${got.toFixed(1)} instead of ${want.toFixed(1)}`);
  before.actors.forEach((a, i) => {
    const b = after.actors[i];
    if (!a.pos) return;
    if (Math.abs(b.pos[0] - a.pos[0] * s) > 1e-3 || Math.abs(b.pos[2] - a.pos[2] * s) > 1e-3 || b.pos[1] !== a.pos[1] || b.kind !== a.kind) problems.push(`actor ${i} moved wrongly`);
    if (Math.abs(b.sight - a.sight * s) > 1e-3 || Math.abs(b.range - a.range * s) > 1e-3 || b.life !== a.life || b.speed !== a.speed) problems.push(`actor ${i}: sight/range not scaled alone`);
  });
  before.events.forEach((e, i) => {
    const b = after.events[i];
    if (b.type !== e.type || (e.pos && (Math.abs(b.pos[0] - e.pos[0] * s) > 1e-3 || b.pos[1] !== e.pos[1]))) problems.push(`event ${i} changed wrongly`);
  });
  if (problems.length) {
    bad++;
    console.log(`${file}: PROBLEMS: ${problems.slice(0, 4).join('; ')}`);
  } else ok++;
}
console.log(`factor ${s}: ${ok} widened and consistent, ${refused} refused (does not fit the collision grid), ${bad} with problems`);
process.exit(bad ? 1 : 0);
