#!/usr/bin/env node
// Renders an MFi (.mld) file to a 16-bit stereo WAV through the same code the browser runs
// (parseMFi -> compileMFi -> MfiMixer, in 128-frame blocks like an AudioWorklet).
//   node tools/mfi/render.mjs <file.mld> <out.wav> [--rate 44100] [--passes 2] [--seconds N]
//                             [--solo 1,3] [--no-file-loops] [--volume 100] [--soundfont <dir>]
// --passes       how many times the body of a "forever" loop is played (default 2: one seam)
// --seconds      hard limit on the output length
// --solo         only these channels sound (for pitch / timing checks)
// --no-file-loops ignore the loop points in the file (play through to the end of the tracks)
// --volume       port volume 0..100, as the game's setAttribute(SET_VOLUME, v)
// --soundfont    directory with gm.json + gm.bin (tools/soundfont/extract.mjs): sampled instruments
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMFi } from '../../web/src/formats/mfi.js';
import { compileMFi, MfiMixer } from '../../web/src/host/audio/synth.js';

export function renderMFi(bytes, opt = {}) {
  const rate = opt.rate ?? 44100;
  const mfi = parseMFi(bytes);
  const song = compileMFi(mfi);
  const mixer = new MfiMixer(rate, 4, { fileLoops: opt.fileLoops !== false });
  if (opt.soundfont) {
    const set = JSON.parse(readFileSync(resolve(opt.soundfont, 'gm.json'), 'utf8'));
    const bin = readFileSync(resolve(opt.soundfont, 'gm.bin'));
    const pcm = new Int16Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length));
    mixer.handle({ type: 'soundfont', programs: set.programs, drums: set.drums, samples: set.samples, pcm });
  }
  const player = mixer.ports[0].player;
  player.maxLoopPasses = opt.passes ?? 2;
  if (opt.solo) player.solo = new Set(opt.solo);
  const volume = (opt.volume ?? 100) / 100;
  mixer.handle({ type: 'play', port: 0, song, gen: 1, volume: volume * volume });
  const limit = Math.ceil((opt.seconds ?? 600) * rate);
  const blocks = [];
  const BLOCK = 128;
  let frames = 0, completeAt = null, loops = 0, minLimiter = 1;
  while (frames < limit) {
    const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
    for (const e of mixer.render(L, R, BLOCK)) {
      if (e.type === 'complete') completeAt = frames / rate;
      else if (e.type === 'loop') loops++;
    }
    minLimiter = Math.min(minLimiter, mixer.limiter);
    blocks.push([L, R]);
    frames += BLOCK;
    if (!player.active) break;
  }
  const left = new Float32Array(frames), right = new Float32Array(frames);
  blocks.forEach(([L, R], i) => {
    left.set(L, i * BLOCK);
    right.set(R, i * BLOCK);
  });
  return { mfi, song, rate, left, right, completeAt, loops, minLimiter };
}

export function wavBytes(left, right, rate) {
  const n = left.length;
  const b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 4, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 4, 40);
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    for (const [ch, v] of [[0, left[i]], [1, right[i]]]) {
      let s = Math.round(v * 32767);
      if (s > 32767 || s < -32768) {
        clipped++;
        s = Math.max(-32768, Math.min(32767, s));
      }
      b.writeInt16LE(s, 44 + i * 4 + ch * 2);
    }
  }
  return { bytes: b, clipped };
}

export function levelStats(left, right) {
  let peak = 0, sum = 0;
  for (let i = 0; i < left.length; i++) {
    const a = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    if (a > peak) peak = a;
    sum += left[i] * left[i] + right[i] * right[i];
  }
  const rms = Math.sqrt(sum / Math.max(1, left.length * 2));
  const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
  return { peak, rms, peakDb: db(peak), rmsDb: db(rms) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const files = [], opt = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--rate') opt.rate = Number(args[++i]);
    else if (a === '--passes') opt.passes = Number(args[++i]);
    else if (a === '--seconds') opt.seconds = Number(args[++i]);
    else if (a === '--volume') opt.volume = Number(args[++i]);
    else if (a === '--solo') opt.solo = args[++i].split(',').map(Number);
    else if (a === '--no-file-loops') opt.fileLoops = false;
    else if (a === '--soundfont') opt.soundfont = args[++i];
    else files.push(a);
  }
  if (files.length !== 2) {
    console.error('usage: node tools/mfi/render.mjs <file.mld> <out.wav> [--rate 44100] [--passes 2] [--seconds N] [--solo 1,3] [--no-file-loops] [--volume 100]');
    process.exit(2);
  }
  const t0 = performance.now();
  const r = renderMFi(readFileSync(files[0]), opt);
  const ms = performance.now() - t0;
  const { bytes, clipped } = wavBytes(r.left, r.right, r.rate);
  mkdirSync(dirname(resolve(files[1])), { recursive: true });
  writeFileSync(files[1], bytes);
  const s = levelStats(r.left, r.right);
  const seconds = r.left.length / r.rate;
  console.log(
    `${files[1]}: ${seconds.toFixed(3)} s @ ${r.rate} Hz, peak ${s.peakDb.toFixed(1)} dBFS, rms ${s.rmsDb.toFixed(1)} dBFS, ` +
    `clipped ${clipped}, limiter min gain ${r.minLimiter.toFixed(2)}, ` +
    `${r.completeAt === null ? 'never completed' : `complete at ${r.completeAt.toFixed(3)} s`}, loop jumps ${r.loops}, ` +
    `rendered in ${ms.toFixed(0)} ms (${(seconds * 1000 / ms).toFixed(0)}x real time)`,
  );
}
