#!/usr/bin/env node
// Parses every MFi (.mld) sample and prints one line per file.
//   node tools/mfi/check_all.mjs [dir=build/assets/delocalized/sp/sound] [more dirs...]
// Exits non-zero if a file fails to parse, has unparsed bytes, unknown events or warnings.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMFi, isInfiniteLoop } from '../../web/src/formats/mfi.js';
import { compileMFi } from '../../web/src/host/audio/synth.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dirs = process.argv.slice(2);
if (!dirs.length) dirs.push(join(repo, 'build/assets/delocalized/sp/sound'));

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.toLowerCase().endsWith('.mld')) out.push(p);
  }
  return out;
}

let failures = 0, count = 0;
const totals = { bytes: 0, unparsed: 0, notes: 0, events: 0, samples: 0 };
for (const dir of dirs) {
  for (const file of walk(resolve(dir), [])) {
    count++;
    const rel = relative(repo, file);
    let mfi;
    try {
      const bytes = readFileSync(file);
      mfi = parseMFi(bytes);
      compileMFi(mfi);
      totals.bytes += bytes.length;
    } catch (e) {
      failures++;
      console.log(`${rel}: FAILED ${e.message}`);
      continue;
    }
    const s = mfi.stats;
    const loop = mfi.loop
      ? `loop ${mfi.loop.startTime.toFixed(3)}-${mfi.loop.endTime.toFixed(3)}s ${isInfiniteLoop(mfi.loop) ? 'forever' : `x${mfi.loop.count}`}`
      : 'no loop';
    const pcm = mfi.samples.length
      ? ` pcm ${mfi.samples.map((x) => `${x.sampleRate / 1000}k/${x.bits}b/${x.duration.toFixed(2)}s`).join('+')}`
      : '';
    const bad = mfi.unparsed > 0 || s.unknownEvents > 0 || mfi.warnings.length > 0;
    if (bad) failures++;
    totals.unparsed += mfi.unparsed;
    totals.notes += s.notes;
    totals.events += mfi.events.length;
    totals.samples += mfi.samples.length;
    console.log(
      `${rel.split('/').pop().padEnd(13)} ${mfi.duration.toFixed(3).padStart(7)}s  tracks ${mfi.tracks.length}  ` +
      `events ${String(mfi.events.length).padStart(4)}  notes ${String(s.notes).padStart(4)} (${s.ties} tied)  ` +
      `ch ${s.channels.join(',') || '-'}  prog ${s.programs.join(',') || '-'}${pcm}  ${loop}  ` +
      `unknown ${s.unknownEvents}  unparsed ${mfi.unparsed}${bad ? '  <-- PROBLEM' : ''}`,
    );
    for (const w of mfi.warnings) console.log(`    warning: ${w}`);
  }
}
console.log(`\n${count} files, ${totals.bytes} bytes, ${totals.events} events, ${totals.notes} notes, ${totals.samples} embedded samples, ` +
  `${totals.unparsed} unparsed bytes, ${failures} problem file(s)`);
process.exit(failures || !count ? 1 : 0);
