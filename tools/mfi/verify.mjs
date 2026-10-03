#!/usr/bin/env node
// Checks the synthesiser against the parsed data, without speakers:
//   1. every sample renders: not silent, no clipping, sensible length, completion reported at
//      the time the parser predicts (for "forever" loops: after the requested number of passes);
//   2. loop seams: the 2nd and 3rd pass of a looping BGM have the same loudness contour;
//   3. pitch / onsets: soloed channels are analysed (energy-rise onset detector + normalised
//      autocorrelation pitch) and compared with the note events;
//   4. the mixer: four ports at once without clipping, completions per port, stop, port volume.
//   node tools/mfi/verify.mjs [dir=build/assets/delocalized/sp/sound] [--wav outDir]
// Exits non-zero on any failed check.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMFi, wavBytes, levelStats } from './render.mjs';
import { parseMFi } from '../../web/src/formats/mfi.js';
import { compileMFi, MfiMixer } from '../../web/src/host/audio/synth.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const wavDir = args.includes('--wav') ? resolve(args[args.indexOf('--wav') + 1]) : null;
const dir = resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--wav') ?? join(repo, 'build/assets/delocalized/sp/sound'));
if (wavDir) mkdirSync(wavDir, { recursive: true });
let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`    FAIL: ${msg}`);
};

// ---- 1. every file -----------------------------------------------------------------------------
console.log('1. render every file (2 passes of "forever" loops)');
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mld')).sort();
for (const f of files) {
  const bytes = readFileSync(join(dir, f));
  const r = renderMFi(bytes, { passes: 2 });
  const s = levelStats(r.left, r.right);
  const seconds = r.left.length / r.rate;
  const { bytes: wav, clipped } = wavBytes(r.left, r.right, r.rate);
  if (wavDir) writeFileSync(join(wavDir, f.replace(/\.mld$/i, '.wav')), wav);
  const loopLen = r.song.loops ? r.song.loopEnd - r.song.loopStart : 0;
  const expected = r.mfi.duration + loopLen;
  const isBgm = /^bgm/i.test(f);
  console.log(`  ${f.padEnd(13)} ${seconds.toFixed(2).padStart(7)} s  peak ${s.peakDb.toFixed(1).padStart(6)} dBFS  rms ${s.rmsDb.toFixed(1).padStart(6)} dBFS  ` +
    `limiter min ${r.minLimiter.toFixed(2)}  complete ${r.completeAt?.toFixed(3) ?? 'never'} s (expected ${expected.toFixed(3)})`);
  if (!(s.rmsDb > -45)) fail('silent');
  if (clipped || s.peak > 0.95) fail(`clipping (peak ${s.peak.toFixed(3)}, ${clipped} clipped samples)`);
  if (r.completeAt === null || Math.abs(r.completeAt - expected) > 0.005) fail('completion time is off');
  if (isBgm ? seconds < 20 || seconds > 2 * expected : seconds > 6) fail('implausible length');
  if (seconds - r.completeAt > 3) fail('tail rings for more than 3 s after the end');
}

// ---- 2. loop seams -----------------------------------------------------------------------------
console.log('\n2. loop seams (loudness contour of pass 2 vs pass 3, 20 ms frames)');
for (const f of files.filter((x) => /^bgm/i.test(x))) {
  const r = renderMFi(readFileSync(join(dir, f)), { passes: 3 });
  const { loopStart, loopEnd } = r.song;
  const len = loopEnd - loopStart;
  const hop = Math.round(0.02 * r.rate);
  const contour = (t0) => {
    const out = [];
    for (let p = Math.round(t0 * r.rate); p + hop <= Math.round((t0 + len) * r.rate); p += hop) {
      let e = 0;
      for (let i = p; i < p + hop; i++) e += r.left[i] * r.left[i] + r.right[i] * r.right[i];
      out.push(Math.sqrt(e / hop));
    }
    return out;
  };
  const a = contour(loopStart + len), b = contour(loopStart + 2 * len);
  const n = Math.min(a.length, b.length);
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i]; sb += b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i];
  }
  const corr = (n * sab - sa * sb) / Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
  console.log(`  ${f.padEnd(13)} loop ${loopStart.toFixed(3)}-${loopEnd.toFixed(3)} s (${len.toFixed(3)} s), ${r.loops} jumps, contour correlation ${corr.toFixed(4)}`);
  if (!(corr > 0.97)) fail('pass 3 does not line up with pass 2');
  if (r.loops !== 2) fail(`expected 2 loop jumps, got ${r.loops}`);
}

// ---- 3. pitch and onsets -----------------------------------------------------------------------
function detectOnsets(x, rate, lookbackMs) {
  // High-pass (second difference) so that only transients count, energy in 3 ms windows every
  // 0.5 ms; an onset is a window 3x louder than anything in the `lookbackMs` before it (longer
  // than a period of the lowest note, so the cycles of a steady tone never trigger).
  const hp = new Float32Array(x.length);
  for (let i = 2; i < x.length; i++) hp[i] = x[i] - 2 * x[i - 1] + x[i - 2];
  const hop = Math.round(rate / 2000), win = hop * 6, back = Math.round(lookbackMs * 2);
  const env = [];
  for (let p = 0; p + win <= hp.length; p += hop) {
    let e = 0;
    for (let i = p; i < p + win; i++) e += hp[i] * hp[i];
    env.push(e / win);
  }
  const floor = 1e-9;
  const onsets = [];
  let last = -1e9;
  for (let i = 1; i < env.length; i++) {
    if (i - last < 30 || env[i] < floor) continue;
    let before = 0;
    for (let k = Math.max(0, i - back); k < i - 5; k++) if (env[k] > before) before = env[k];
    if (env[i] > before * 3 + floor) {
      // refine inside the window: first sample above 25% of the window's peak
      const from = i * hop, to = Math.min(hp.length, from + win);
      let peak = 0;
      for (let k = from; k < to; k++) peak = Math.max(peak, Math.abs(hp[k]));
      let k = from;
      while (k < to && Math.abs(hp[k]) < 0.25 * peak) k++;
      onsets.push(k / rate);
      last = i;
    }
  }
  return onsets;
}

function pitchAt(x, rate, t, expectHz) {
  // normalised autocorrelation over ~8 periods, first strong peak, parabolic refinement
  const start = Math.round((t + 0.012) * rate);
  const minLag = Math.floor(rate / 2500), maxLag = Math.ceil(rate / 35);
  const n = Math.min(Math.round(rate * 0.09), Math.max(1024, Math.round((8 * rate) / expectHz)));
  if (start + n + maxLag >= x.length) return null;
  const nac = new Float64Array(maxLag + 2);
  let best = 0;
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < n; i++) {
      const a = x[start + i], b = x[start + i + lag];
      ab += a * b; aa += a * a; bb += b * b;
    }
    nac[lag] = ab / Math.sqrt(aa * bb + 1e-20);
    if (nac[lag] > best) best = nac[lag];
  }
  for (let lag = minLag + 1; lag <= maxLag; lag++) {
    if (nac[lag] > 0.9 * best && nac[lag] >= nac[lag - 1] && nac[lag] >= nac[lag + 1]) {
      const d = nac[lag - 1] - 2 * nac[lag] + nac[lag + 1];
      const shift = d ? (0.5 * (nac[lag - 1] - nac[lag + 1])) / d : 0;
      return rate / (lag + shift);
    }
  }
  return null;
}

console.log('\n3. pitch / onset check on soloed channels');
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const name = (m) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
const cases = [
  { file: 'bgmtitle.mld', ch: 1, pitch: true, count: 16 },
  { file: 'bgmtitle.mld', ch: 2, pitch: true, count: 16 },
  { file: 'bgmtitle.mld', ch: 9, pitch: false, count: 24 },
  { file: 'bgm00.mld', ch: 1, pitch: true, count: 16 },
  { file: 'se14.mld', ch: 0, pitch: true, count: 2 },
];
for (const c of cases) {
  let bytes;
  try {
    bytes = readFileSync(join(dir, c.file));
  } catch {
    console.log(`  ${c.file}: not found, skipped`);
    continue;
  }
  const mfi = parseMFi(bytes);
  const expected = mfi.events.filter((e) => e.type === 'note' && e.channel === c.ch && !e.tied);
  // chords / unisons: one onset per distinct time
  const starts = [];
  for (const e of expected) if (!starts.length || e.time - starts[starts.length - 1].time > 1e-6) starts.push(e);
  const r = renderMFi(bytes, { passes: 1, solo: [c.ch], seconds: 20 });
  const mono = new Float32Array(r.left.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (r.left[i] + r.right[i]) * 0.5;
  const lowest = expected.reduce((m, e) => Math.min(m, e.percussion ? 60 : 440 * 2 ** ((e.midi - 69) / 12)), 1e9);
  const onsets = detectOnsets(mono, r.rate, Math.min(35, Math.max(8, 1500 / lowest)));
  console.log(`  ${c.file} channel ${c.ch}: ${expected.length} notes, ${onsets.length} onsets detected in ${(mono.length / r.rate).toFixed(1)} s`);
  const errs = [], cents = [];
  let missed = 0;
  for (const e of starts.slice(0, c.count)) {
    let near = null;
    for (const o of onsets) if (near === null || Math.abs(o - e.time) < Math.abs(near - e.time)) near = o;
    const err = near === null ? Infinity : (near - e.time) * 1000;
    const hz = 440 * 2 ** ((e.midi - 69) / 12);
    let line = `    tick ${String(e.tick).padStart(5)}  ${e.time.toFixed(4)} s  ${(e.percussion ? `drum ${e.midi}` : name(e.midi)).padEnd(8)}`;
    if (Math.abs(err) > 25) {
      missed++;
      line += '  onset: not detected          ';
    } else {
      errs.push(Math.abs(err));
      line += `  onset ${near.toFixed(4)} s (${err >= 0 ? '+' : ''}${err.toFixed(2)} ms)`;
    }
    if (c.pitch) {
      const f0 = pitchAt(mono, r.rate, e.time, hz);
      if (f0 === null) line += `  pitch: n/a (expected ${hz.toFixed(2)} Hz)`;
      else {
        const d = 1200 * Math.log2(f0 / hz);
        cents.push(Math.abs(d));
        line += `  expected ${hz.toFixed(2)} Hz, measured ${f0.toFixed(2)} Hz (${d >= 0 ? '+' : ''}${d.toFixed(1)} cents)`;
      }
    }
    console.log(line);
  }
  const checked = Math.min(c.count, starts.length);
  const pct = (list, q) => (list.length ? [...list].sort((x, y) => x - y)[Math.min(list.length - 1, Math.floor(q * list.length))] : NaN);
  console.log(`    -> onsets: ${errs.length}/${checked} detected, median error ${pct(errs, 0.5).toFixed(2)} ms, 90th percentile ${pct(errs, 0.9).toFixed(2)} ms, worst ${Math.max(...errs).toFixed(2)} ms` +
    (c.pitch ? `; pitch: median error ${pct(cents, 0.5).toFixed(1)} cents, ${cents.filter((v) => v <= 10).length}/${cents.length} within 10 cents, worst ${Math.max(...cents).toFixed(1)}` : ''));
  // the detectors are simple (a note struck under a ringing one is often missed, an overlapping
  // tail pulls the autocorrelation), so judge the bulk, not the worst case
  if (errs.length < 0.5 * checked) fail('fewer than half of the onsets were detected');
  if (!(pct(errs, 0.5) <= 2) || !(pct(errs, 0.9) <= 5)) fail('onsets are off (median > 2 ms or 90th percentile > 5 ms)');
  if (c.pitch && (!(pct(cents, 0.5) <= 5) || cents.filter((v) => v <= 10).length < 0.8 * cents.length)) fail('pitch is off');
}

// ---- 4. mixer: four ports at once, port volume ---------------------------------------------------
console.log('\n4. mixer: four ports at once, port volume, stop');
{
  const rate = 44100;
  const names = ['bgmtitle.mld', 'se16.mld', 'se08.mld', 'se21.mld'].filter((f) => files.includes(f));
  const songs = names.map((f) => compileMFi(parseMFi(readFileSync(join(dir, f)))));
  const mixer = new MfiMixer(rate, 4);
  songs.forEach((song, port) => mixer.handle({ type: 'play', port, song, gen: port + 1, volume: 1 }));
  const L = new Float32Array(128), R = new Float32Array(128);
  const done = new Map();
  let peak = 0, frames = 0, minLimiter = 1, stopped = false, afterStop = 0;
  while (frames < rate * 8) {
    for (const e of mixer.render(L, R, 128)) if (e.type === 'complete') done.set(e.port, frames / rate);
    for (let i = 0; i < 128; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    minLimiter = Math.min(minLimiter, mixer.limiter);
    frames += 128;
    if (!stopped && frames >= rate * 6) {
      // the game stops its looping sounds (ports 0 and 1) by hand
      mixer.handle({ type: 'stop', port: 0 });
      mixer.handle({ type: 'stop', port: 1 });
      stopped = true;
    } else if (stopped && frames >= rate * 6.1) for (let i = 0; i < 128; i++) afterStop = Math.max(afterStop, Math.abs(L[i]), Math.abs(R[i]));
  }
  console.log(`  ${names.join(' + ')}: peak ${peak.toFixed(3)}, limiter min gain ${minLimiter.toFixed(2)}, completions ` +
    `${[...done].map(([p, t]) => `port ${p} at ${t.toFixed(2)} s`).join(', ') || 'none'}, level 0.1 s after stop ${afterStop.toFixed(4)}`);
  if (peak > 0.95) fail('four ports together clip');
  songs.forEach((song, port) => {
    if (song.loops && done.has(port)) fail(`port ${port} loops forever but reported completion`);
    if (!song.loops && !done.has(port)) fail(`port ${port} never completed`);
  });
  if (afterStop > 0.001) fail('sound continues after stop');

  const rms = (volume) => {
    const m = new MfiMixer(rate, 4);
    m.handle({ type: 'play', port: 0, song: songs[2], gen: 1, volume: 1 });
    m.handle({ type: 'volume', port: 0, value: volume });
    let sum = 0;
    for (let n = 0; n < rate; n += 128) {
      m.render(L, R, 128);
      if (n > rate * 0.1) for (let i = 0; i < 128; i++) sum += L[i] * L[i];
    }
    return Math.sqrt(sum);
  };
  // setAttribute(SET_VOLUME, 50) is sent as gain 0.25 (square law) = -12 dB (limiter idle for one effect)
  const ratio = 20 * Math.log10(rms(0.25) / rms(1));
  console.log(`  port volume 50% -> ${ratio.toFixed(2)} dB (expected -12.04)`);
  if (Math.abs(ratio + 12.04) > 0.6) fail('port volume is off');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
