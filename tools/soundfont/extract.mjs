#!/usr/bin/env node
// Builds the sampled-instrument set the web host's synthesiser can play the game's music with.
//
//   node tools/soundfont/extract.mjs [--sf2 /usr/share/sounds/sf2/FluidR3_GM.sf2]
//                                    [--variant localized] [--out web/public/soundfont]
//
// The game's music (.mld, MFi) addresses General MIDI program numbers. This tool finds which
// programs, key ranges and drum notes the game's sound files use, pulls just those out of a
// General MIDI SoundFont (.sf2) and writes them as
//
//   gm.json  { source, programs: { <program>: [zone...] }, drums: { <key>: [zone...] },
//              samples: [{ o, n, rate }] }      (o, n: offset and length in 16-bit samples)
//   gm.bin   the samples, 16-bit little-endian mono, back to back
//
// zone = { lo, hi      MIDI key range it covers
//          s           index into samples
//          root        MIDI key (fractional) at which the sample plays at its recorded pitch
//          scale       pitch tracking, semitones per key (1 normally, 0 for fixed pitch)
//          loop        [start, end] in samples, or absent for a one-shot
//          gain        linear
//          pan         -1..1
//          a, h, d, r  volume envelope: attack, hold, decay, release times in seconds
//          sus         sustain level, linear
//          excl        exclusive class (a new note cuts others of the same class), or absent }
//
// The output is generated data (git-ignored). Without it the host falls back to its FM patches.
// FluidR3_GM (Frank Wen, MIT licence) is the default source; on Debian/Ubuntu it is the package
// fluid-soundfont-gm.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from '../../web/node_modules/fflate/esm/index.mjs';
import { parseMFi } from '../../web/src/formats/mfi.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = { sf2: '/usr/share/sounds/sf2/FluidR3_GM.sf2', variant: 'localized', out: 'web/public/soundfont' };
for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, '')] = args[i + 1];

/** Keys either side of the used range that are kept, for pitch bends. */
const KEY_MARGIN = 3;
/** MIDI velocity whose layer is taken (the format has one layer per key range). */
const VELOCITY = 100;
/** One-shot samples are cut to this length. */
const MAX_SECONDS = 6;

// ---- what the game's music uses -----------------------------------------------------------------

function soundFiles() {
  const sp = readFileSync(resolve(root, 'original', opt.variant, 'RockmanDASH.sp'));
  // 64-byte header of little-endian int32 segment sizes; segment 3 = [int32 length][zip of .mld]
  let offset = 64;
  for (let i = 0; i < 3; i++) offset += sp.readInt32LE(i * 4);
  const length = sp.readInt32LE(offset);
  return unzipSync(new Uint8Array(sp.buffer, sp.byteOffset + offset + 4, length));
}

function usage() {
  const programs = new Map(); // program -> [lowest, highest] key
  const drums = new Set();
  for (const [name, bytes] of Object.entries(soundFiles())) {
    if (!/\.mld$/i.test(name)) continue;
    const channels = new Map();
    for (const e of parseMFi(bytes).events) {
      if (e.channel !== undefined && e.channel > 15) continue;
      if (e.type === 'program') channels.set(e.channel, { program: e.gm & 127, percussion: e.percussion });
      if (e.type !== 'note' || e.velocity === 0) continue;
      const ch = channels.get(e.channel) ?? { program: 0, percussion: e.channel === 9 };
      if (e.percussion || ch.percussion) drums.add(e.midi);
      else {
        const r = programs.get(ch.program) ?? [127, 0];
        programs.set(ch.program, [Math.min(r[0], e.midi), Math.max(r[1], e.midi)]);
      }
    }
  }
  return { programs, drums };
}

// ---- SoundFont 2 --------------------------------------------------------------------------------

const GEN = {
  startOffset: 0, endOffset: 1, loopStartOffset: 2, loopEndOffset: 3, startCoarse: 4, endCoarse: 12,
  pan: 17, attack: 34, hold: 35, decay: 36, sustain: 37, release: 38, instrument: 41, keyRange: 43,
  velRange: 44, loopStartCoarse: 45, attenuation: 48, loopEndCoarse: 50, coarseTune: 51, fineTune: 52,
  sampleID: 53, sampleModes: 54, scaleTuning: 56, exclusiveClass: 57, rootKey: 58,
};
/** Generators a preset zone adds to the instrument's value (the rest only make sense per sample). */
const ADDITIVE = [GEN.pan, GEN.attack, GEN.hold, GEN.decay, GEN.sustain, GEN.release, GEN.attenuation,
  GEN.coarseTune, GEN.fineTune];
const DEFAULTS = {
  [GEN.attack]: -12000, [GEN.hold]: -12000, [GEN.decay]: -12000, [GEN.release]: -12000,
  [GEN.scaleTuning]: 100, [GEN.rootKey]: -1,
};

function parseSf2(buf) {
  const chunks = {};
  const walk = (start, end) => {
    for (let p = start; p + 8 <= end;) {
      const id = buf.toString('latin1', p, p + 4);
      const size = buf.readUInt32LE(p + 4);
      if (id === 'RIFF' || id === 'LIST') walk(p + 12, p + 8 + size);
      else chunks[id] = [p + 8, size];
      p += 8 + size + (size & 1);
    }
  };
  walk(0, buf.length);
  const records = (id, size, read) => {
    const [at, length] = chunks[id];
    return Array.from({ length: length / size }, (_, i) => read(at + i * size));
  };
  const name = (p) => buf.toString('latin1', p, p + 20).replace(/\0.*$/, '');
  const gens = (id) => records(id, 4, (p) => {
    const g = buf.readUInt16LE(p);
    const ranged = g === GEN.keyRange || g === GEN.velRange;
    return [g, ranged ? [buf[p + 2], buf[p + 3]] : g === GEN.instrument || g === GEN.sampleID
      ? buf.readUInt16LE(p + 2) : buf.readInt16LE(p + 2)];
  });
  return {
    smpl: chunks.smpl[0],
    presets: records('phdr', 38, (p) => ({ name: name(p), program: buf.readUInt16LE(p + 20), bank: buf.readUInt16LE(p + 22), bag: buf.readUInt16LE(p + 24) })),
    pbag: records('pbag', 4, (p) => buf.readUInt16LE(p)),
    pgen: gens('pgen'),
    instruments: records('inst', 22, (p) => ({ name: name(p), bag: buf.readUInt16LE(p + 20) })),
    ibag: records('ibag', 4, (p) => buf.readUInt16LE(p)),
    igen: gens('igen'),
    samples: records('shdr', 46, (p) => ({
      name: name(p), start: buf.readUInt32LE(p + 20), end: buf.readUInt32LE(p + 24),
      loopStart: buf.readUInt32LE(p + 28), loopEnd: buf.readUInt32LE(p + 32), rate: buf.readUInt32LE(p + 36),
      pitch: buf[p + 40], correction: buf.readInt8(p + 41), type: buf.readUInt16LE(p + 44),
    })),
  };
}

/** The zones of a preset or instrument: [{ gens: Map, target }], global zone folded in. */
function zonesOf(headers, index, bags, gens, targetGen) {
  const zones = [];
  let global = new Map();
  for (let b = headers[index].bag; b < headers[index + 1].bag; b++) {
    const g = new Map(gens.slice(bags[b], bags[b + 1]));
    if (!g.has(targetGen)) {
      if (b === headers[index].bag) global = g;
      continue;
    }
    zones.push(new Map([...global, ...g]));
  }
  return zones;
}

const timecents = (tc) => 2 ** (tc / 1200);
const overlaps = (range, lo, hi) => !range || (range[0] <= hi && range[1] >= lo);

function extract(sf, buf, bank, program, lo, hi) {
  const pi = sf.presets.findIndex((p) => p.bank === bank && p.program === program);
  if (pi < 0) return null;
  const out = [];
  for (const pz of zonesOf(sf.presets, pi, sf.pbag, sf.pgen, GEN.instrument)) {
    if (!overlaps(pz.get(GEN.keyRange), lo, hi) || !overlaps(pz.get(GEN.velRange), VELOCITY, VELOCITY)) continue;
    for (const iz of zonesOf(sf.instruments, pz.get(GEN.instrument), sf.ibag, sf.igen, GEN.sampleID)) {
      if (!overlaps(iz.get(GEN.keyRange), lo, hi) || !overlaps(iz.get(GEN.velRange), VELOCITY, VELOCITY)) continue;
      const sample = sf.samples[iz.get(GEN.sampleID)];
      if ((sample.type & 0x7fff) === 2) continue; // right half of a stereo pair: the left one is kept
      const v = (g) => (iz.get(g) ?? DEFAULTS[g] ?? 0) + (ADDITIVE.includes(g) ? pz.get(g) ?? 0 : 0);
      const pr = pz.get(GEN.keyRange) ?? [0, 127];
      const ir = iz.get(GEN.keyRange) ?? [0, 127];
      const start = sample.start + v(GEN.startOffset) + 32768 * v(GEN.startCoarse);
      const end = sample.end + v(GEN.endOffset) + 32768 * v(GEN.endCoarse);
      const loopStart = sample.loopStart + v(GEN.loopStartOffset) + 32768 * v(GEN.loopStartCoarse);
      const loopEnd = sample.loopEnd + v(GEN.loopEndOffset) + 32768 * v(GEN.loopEndCoarse);
      const looped = (v(GEN.sampleModes) & 1) === 1 && loopEnd > loopStart + 8;
      const rootKey = v(GEN.rootKey) >= 0 ? v(GEN.rootKey) : sample.pitch;
      out.push({
        lo: Math.max(pr[0], ir[0], lo),
        hi: Math.min(pr[1], ir[1], hi),
        sample: { start, end: looped ? Math.min(end, loopEnd + 8) : Math.min(end, start + MAX_SECONDS * sample.rate), rate: sample.rate },
        root: +(rootKey - v(GEN.coarseTune) - (v(GEN.fineTune) + sample.correction) / 100).toFixed(3),
        scale: v(GEN.scaleTuning) / 100,
        loop: looped ? [loopStart - start, loopEnd - start] : undefined,
        // 0.4: the attenuation scale of the hardware the format comes from, as FluidSynth applies it
        gain: +(10 ** ((-0.4 * Math.max(0, v(GEN.attenuation))) / 200)).toFixed(4),
        pan: (sample.type & 0x7fff) === 4 ? 0 : Math.max(-1, Math.min(1, v(GEN.pan) / 500)),
        a: +timecents(v(GEN.attack)).toFixed(4),
        h: +timecents(v(GEN.hold)).toFixed(4),
        d: +timecents(v(GEN.decay)).toFixed(4),
        sus: +(10 ** (-Math.min(1440, Math.max(0, v(GEN.sustain))) / 200)).toFixed(4),
        r: +timecents(v(GEN.release)).toFixed(4),
        excl: v(GEN.exclusiveClass) || undefined,
      });
    }
  }
  return { name: sf.presets[pi].name, zones: out.filter((z) => z.lo <= z.hi) };
}

// ---- main ---------------------------------------------------------------------------------------

if (!existsSync(opt.sf2)) {
  console.error(`soundfont: ${opt.sf2} not found (install a General MIDI .sf2 or pass --sf2); nothing written`);
  process.exit(2);
}
const used = usage();
const buf = readFileSync(opt.sf2);
const sf = parseSf2(buf);
const pieces = []; // Buffers of 16-bit samples
const sampleIndex = new Map(); // "start:end" -> index
const samples = [];
let total = 0;
const store = (zones) => zones.map(({ sample, ...zone }) => {
  const key = `${sample.start}:${sample.end}`;
  let s = sampleIndex.get(key);
  if (s === undefined) {
    s = samples.length;
    sampleIndex.set(key, s);
    const n = sample.end - sample.start;
    samples.push({ o: total, n, rate: sample.rate });
    pieces.push(buf.subarray(sf.smpl + sample.start * 2, sf.smpl + sample.end * 2));
    total += n;
  }
  return { ...zone, s };
});

const programs = {};
const report = [];
for (const [program, [lo, hi]] of [...used.programs].sort((a, b) => a[0] - b[0])) {
  const e = extract(sf, buf, 0, program, Math.max(0, lo - KEY_MARGIN), Math.min(127, hi + KEY_MARGIN));
  if (!e || !e.zones.length) continue;
  programs[program] = store(e.zones);
  report.push(`  ${String(program).padStart(3)} ${e.name.padEnd(20)} keys ${lo}-${hi}, ${e.zones.length} zone(s)`);
}
const drums = {};
for (const key of [...used.drums].sort((a, b) => a - b)) {
  const e = extract(sf, buf, 128, 0, key, key);
  if (e && e.zones.length) drums[key] = store(e.zones);
}
const dir = resolve(root, opt.out);
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'gm.bin'), Buffer.concat(pieces));
writeFileSync(resolve(dir, 'gm.json'), JSON.stringify({ source: opt.sf2.replace(/^.*\//, ''), programs, drums, samples }));
console.log(`soundfont: ${Object.keys(programs).length} programs, ${Object.keys(drums).length} drum notes, `
  + `${samples.length} samples, ${(total * 2 / 1048576).toFixed(1)} MB -> ${opt.out}/gm.{json,bin}`);
console.log(report.join('\n'));
console.log(`  drums: ${Object.keys(drums).join(' ')}`);
