#!/usr/bin/env node
// Renders one Mega Man Legends 2 music sequence with its instrument bank to a 44.1 kHz stereo WAV.
//
//   node tools/mml2/seqrender.mjs <job.json> <out.wav>
//
// The job file is written by music.py: { seq: base64, samples: base64, bank: {volume, programs},
// passes, tail, gain }.  Prints a JSON line with duration and loop points (in samples).
//
// SEQUENCE FORMAT (archive types 0x08, 0x0F, 0x10 and the title's 0x09; decoded here from the
// data, every sequence on the disc parses to its end-of-track marker):
//   u32 size, u32 tempo (microseconds per quarter note), u16 ticks per quarter note (always 48),
//   u8 time signature numerator, u8 denominator (power of two), then MIDI-like events.
//   The first event has no delta time; every later event is preceded by a MIDI variable-length
//   delta.  Running status is used.  Events:
//     9n kk vv   note on (vv = 0: note off)        Cn pp   program (index into the bank)
//     Bn 07 vv   channel volume                    Bn 0A vv  pan       Bn 0B vv  expression
//     Bn 63 14   loop start (NRPN 20), followed by Bn 06 cc = repeat count (7F = forever)
//     Bn 63 1E   loop end (NRPN 30)                En ll mm  pitch bend (14 bit, 0x2000 = centre)
//     FF 51 tt tt tt   tempo, 3 bytes big endian, no length byte (as in Sony's SEQ format)
//     FF 2F      end of track
//   An entry may hold several sequences back to back (4-byte aligned): variants of a theme or
//   parts that the game layers or switches between.
//
// PLAYBACK RULES.  These were read out of the game's own sound driver (SLUS_011.40, functions at
// 0x8001F29C pitch, 0x8001F3D4 volume/pan, 0x8002223C note on) rather than assumed:
//   pitch   = 0x1000 * 2^((note - centre)/12), from a 12-entry semitone table, with the 7-bit fine
//             tune interpolated linearly towards the next semitone.  Pitch bend adds
//             (bend - 0x2000) * range / 0x2000 semitones, using the tone's own down/up range, so a
//             tone with range 0 ignores bends.
//   volume  = velocity * tone volume * channel volume * expression / 127^3   (0..127), then
//             level = volume^2 * 16383 / 127^2  (quadratic curve) for both sides.
//   pan     = program pan if it is not 64, else channel pan if it is not 64, else tone pan.
//             pan < 64: right = level * pan / 64;  pan > 64: left = level * (127 - pan) / 64.
//   every tone of the program whose key range contains the note is started (layering).
//   ADSR1/ADSR2 are raw SPU register values.
// ASSUMED (not confirmed in the driver): the bank's master volume (entry header +0x1E) scales the
// result linearly; channel volume/expression changes affect notes that are already sounding;
// the game's left/right orientation equals MIDI's (pan 127 = right).
// NOT REPRODUCED: SPU reverb (tones with mode bit 4 send to it; the game's reverb preset was not
// identified), the 24-voice limit and voice stealing.  Sample interpolation uses a 4-tap Gaussian
// kernel fitted to the SPU's (0.147, 0.70, 0.147 at phase 0), not the console's exact table.
// The envelope generator follows the SPU ADSR description in the "Nocash PSX Specifications".

import { readFileSync, writeFileSync } from 'node:fs';

const RATE = 44100;

function decodeAdpcm(data, off) {
  const F0 = [0, 60, 115, 98, 122];
  const F1 = [0, 0, -52, -55, -60];
  const out = [];
  let s1 = 0, s2 = 0, loop = -1, looped = false, p = off;
  while (p + 16 <= data.length) {
    const head = data[p], flags = data[p + 1];
    let shift = head & 15, filt = head >> 4;
    if (filt > 4) filt = 0;
    if (shift > 12) shift = 9;
    if (flags & 4) loop = out.length;
    for (let i = 2; i < 16; i++) {
      const b = data[p + i];
      for (let k = 0; k < 2; k++) {
        let nib = k ? b >> 4 : b & 15;
        if (nib >= 8) nib -= 16;
        let s = ((nib << 12) >> shift) + ((s1 * F0[filt] + s2 * F1[filt] + 32) >> 6);
        if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
        out.push(s);
        s2 = s1; s1 = s;
      }
    }
    p += 16;
    if (flags & 1) { looped = (flags & 2) !== 0; break; }
  }
  return { pcm: Float32Array.from(out), loop: looped && loop >= 0 ? loop : -1 };
}

// 4-tap Gaussian interpolation kernel, 256 phases
const GAUSS = (() => {
  const t = new Float32Array(256 * 4);
  const sigma2 = 2 * 0.57 * 0.57;
  for (let ph = 0; ph < 256; ph++) {
    const f = ph / 256;
    let sum = 0;
    const w = [];
    for (let k = -1; k <= 2; k++) { const d = k - f; const v = Math.exp(-d * d / sigma2); w.push(v); sum += v; }
    for (let k = 0; k < 4; k++) t[ph * 4 + k] = w[k] / sum;
  }
  return t;
})();

class Envelope {
  constructor(adsr1, adsr2) {
    this.adsr1 = adsr1; this.adsr2 = adsr2;
    this.level = 0; this.phase = 0; this.counter = 0; // 0 attack 1 decay 2 sustain 3 release 4 off
    this.sustainLevel = ((adsr1 & 15) + 1) * 0x800;
  }
  release() { if (this.phase < 3) { this.phase = 3; this.counter = 0; } }
  step() {
    let rate, exp, dec;
    const a1 = this.adsr1, a2 = this.adsr2;
    switch (this.phase) {
      case 0: rate = (a1 >> 8) & 0x7f; exp = a1 >> 15; dec = 0; break;
      case 1: rate = ((a1 >> 4) & 15) * 4; exp = 1; dec = 1; break;
      case 2: rate = (a2 >> 6) & 0x7f; exp = a2 >> 15; dec = (a2 >> 14) & 1; break;
      case 3: rate = (a2 & 31) * 4; exp = (a2 >> 5) & 1; dec = 1; break;
      default: return 0;
    }
    if (this.counter > 0) { this.counter--; }
    if (this.counter <= 0) {
      const shift = rate >> 2;
      let stepVal = dec ? -8 + (rate & 3) : 7 - (rate & 3);
      let cycles = 1 << Math.max(0, shift - 11);
      let step = stepVal << Math.max(0, 11 - shift);
      if (exp && !dec && this.level > 0x6000) cycles *= 4;
      if (exp && dec) step = (step * this.level) >> 15;
      this.counter = cycles;
      if (rate < 0x7f || this.phase !== 2) this.level += step;
      if (this.level > 0x7fff) this.level = 0x7fff;
      if (this.level < 0) this.level = 0;
      if (this.phase === 0 && this.level >= 0x7fff) { this.phase = 1; this.counter = 0; }
      else if (this.phase === 1 && this.level <= this.sustainLevel) { this.phase = 2; this.counter = 0; }
      else if (this.phase === 3 && this.level <= 0) { this.phase = 4; }
    }
    return this.level;
  }
}

function pitchRatio(note, tone, bend) {
  // note in semitones, fine tune and bend in 1/128 semitone, as the driver does
  let units = note * 128 + tone.fine;
  if (bend < 0x2000) units -= Math.trunc((0x2000 - bend) * (tone.bendDown * 128) / 0x2000);
  else if (bend > 0x2000) units += Math.trunc((bend - 0x2000) * (tone.bendUp * 128) / 0x2000);
  const semis = (units >> 7) - tone.centre;
  const frac = (units & 127) / 128;
  const lo = Math.pow(2, semis / 12), hi = Math.pow(2, (semis + 1) / 12);
  return lo + (hi - lo) * frac; // linear inside the semitone, like the driver
}

function render(job) {
  const seq = Buffer.from(job.seq, 'base64');
  const body = Buffer.from(job.samples, 'base64');
  const bank = job.bank;
  const passes = job.passes ?? 2;
  const gain = (job.gain ?? 1) * (bank.volume / 127);
  const cache = new Map();
  const sample = (off) => { if (!cache.has(off)) cache.set(off, decodeAdpcm(body, off)); return cache.get(off); };

  const chans = Array.from({ length: 16 }, () => ({ program: 0, volume: 127, expression: 127, pan: 64, bend: 0x2000, nrpn: -1 }));
  let voices = [];
  let left = new Float32Array(RATE * 60), right = new Float32Array(RATE * 60);
  let pos = 0; // samples rendered
  const grow = (n) => {
    if (n <= left.length) return;
    const size = Math.max(n, left.length * 2);
    const l = new Float32Array(size), r = new Float32Array(size);
    l.set(left); r.set(right); left = l; right = r;
  };

  const setLevels = (v) => {
    const ch = chans[v.channel];
    const vol = Math.trunc(v.velocity * v.tone.volume * ch.volume * ch.expression / (127 * 127 * 127));
    const level = Math.trunc(vol * vol * 16383 / 16129);
    const prog = bank.programs[v.program];
    const pan = prog.pan !== 64 ? prog.pan : ch.pan !== 64 ? ch.pan : v.tone.pan;
    let l = level, r = level;
    if (pan < 64) r = (level * pan) >> 6;
    else if (pan > 64) l = (level * (127 - pan)) >> 6;
    v.l = l / 0x4000 * gain; v.r = r / 0x4000 * gain;
  };

  const renderTo = (end) => {
    end = Math.floor(end);
    if (end <= pos) return;
    grow(end + 1);
    for (const v of voices) {
      const pcm = v.sample.pcm, n = pcm.length, loop = v.sample.loop;
      let p = v.pos;
      const step = v.step, env = v.env;
      for (let i = pos; i < end; i++) {
        const lvl = env.step();
        if (env.phase === 4) { v.dead = true; break; }
        let ip = Math.floor(p);
        if (ip >= n) {
          if (loop < 0) { v.dead = true; break; }
          const span = n - loop;
          p = loop + ((p - loop) % span); ip = Math.floor(p);
        }
        const g = (Math.floor((p - ip) * 256)) * 4;
        const at = (k) => { let j = ip + k; if (j < 0) return 0; if (j >= n) { if (loop < 0) return 0; j = loop + ((j - loop) % (n - loop)); } return pcm[j]; };
        const s = at(-1) * GAUSS[g] + pcm[ip] * GAUSS[g + 1] + at(1) * GAUSS[g + 2] + at(2) * GAUSS[g + 3];
        const a = s * lvl / (32768 * 32768);
        left[i] += a * v.l; right[i] += a * v.r;
        p += step;
      }
      v.pos = p;
    }
    voices = voices.filter((v) => !v.dead);
    pos = end;
  };

  const noteOn = (c, key, vel) => {
    const ch = chans[c];
    const prog = bank.programs[ch.program];
    if (!prog) return;
    for (const tone of prog.tones) {
      if (key < tone.low || key > tone.high) continue;
      const smp = sample(tone.offset);
      if (!smp.pcm.length) continue;
      const v = { channel: c, key, velocity: vel, tone, program: ch.program, sample: smp, pos: 0,
        step: pitchRatio(key, tone, ch.bend), env: new Envelope(tone.adsr1, tone.adsr2), l: 0, r: 0 };
      setLevels(v);
      voices.push(v);
    }
  };
  const noteOff = (c, key) => { for (const v of voices) if (v.channel === c && v.key === key) v.env.release(); };

  const size = seq.readUInt32LE(0);
  let tempo = seq.readUInt32LE(4);
  const ppqn = seq.readUInt16LE(8);
  let p = 12, status = 0, first = true, time = 0; // time in samples (float)
  let loopStartP = -1, loopStartStatus = 0, loopCount = 0, pass = 0;
  const marks = { loopStartTick: null, loopEndTick: null, boundaries: [] };
  let tick = 0, notes = 0, ended = false;
  const stats = { unknownProgram: 0, unmatchedNotes: 0 };

  while (p < size) {
    if (!first) {
      let d = 0, b;
      do { b = seq[p++]; d = (d << 7) | (b & 0x7f); } while (b & 0x80);
      tick += d;
      time += d * tempo / 1e6 / ppqn * RATE;
      renderTo(time);
    }
    first = false;
    if (seq[p] & 0x80) status = seq[p++];
    const hi = status & 0xf0, c = status & 15;
    if (status === 0xff) {
      const m = seq[p++];
      if (m === 0x51) { tempo = (seq[p] << 16) | (seq[p + 1] << 8) | seq[p + 2]; p += 3; }
      else if (m === 0x2f) { ended = true; break; }
      else throw new Error('unknown meta ' + m);
    } else if (hi === 0x90 || hi === 0x80) {
      const key = seq[p++], vel = seq[p++];
      if (hi === 0x90 && vel > 0) {
        notes++;
        const before = voices.length;
        if (!bank.programs[chans[c].program]) stats.unknownProgram++;
        noteOn(c, key, vel);
        if (voices.length === before) stats.unmatchedNotes++;
      } else noteOff(c, key);
    } else if (hi === 0xb0) {
      const cc = seq[p++], val = seq[p++];
      const ch = chans[c];
      if (cc === 7) ch.volume = val;
      else if (cc === 10) ch.pan = val;
      else if (cc === 11) ch.expression = val;
      else if (cc === 99) {
        ch.nrpn = val;
        if (val === 20) { loopStartP = p; loopStartStatus = status; marks.loopStartTick = tick; if (!marks.boundaries.length) marks.boundaries.push(Math.floor(time)); }
        else if (val === 30) {
          marks.loopEndTick = tick;
          marks.boundaries.push(Math.floor(time));
          pass++;
          if (loopStartP >= 0 && pass < passes && (loopCount === 127 || pass < loopCount)) { p = loopStartP; status = loopStartStatus; }
        }
      } else if (cc === 6) { if (ch.nrpn === 20) loopCount = val; }
      if (cc === 7 || cc === 10 || cc === 11) for (const v of voices) if (v.channel === c) setLevels(v);
    } else if (hi === 0xc0) {
      chans[c].program = seq[p++];
    } else if (hi === 0xe0) {
      const lsb = seq[p++], msb = seq[p++];
      chans[c].bend = (msb << 7) | lsb;
      for (const v of voices) if (v.channel === c) v.step = pitchRatio(v.key, v.tone, chans[c].bend);
    } else if (hi === 0xd0) { p++; } else if (hi === 0xa0) { p += 2; } else throw new Error('bad status ' + status.toString(16));
  }
  const musicEnd = Math.floor(time);
  // tail: release everything and let it ring out
  for (const v of voices) v.env.release();
  const tail = Math.floor((job.tail ?? 2) * RATE);
  renderTo(time + tail);
  let end = pos;
  // trim trailing silence of the tail
  while (end > musicEnd && Math.abs(left[end - 1]) < 1e-5 && Math.abs(right[end - 1]) < 1e-5) end--;
  return { left, right, length: end, musicEnd, marks, loopCount, notes, ended, tempo, ppqn, stats };
}

function writeWav(path, left, right, n, scale) {
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    let l = Math.round(left[i] * scale * 32767), r = Math.round(right[i] * scale * 32767);
    if (l > 32767) { l = 32767; clipped++; } else if (l < -32768) { l = -32768; clipped++; }
    if (r > 32767) { r = 32767; clipped++; } else if (r < -32768) { r = -32768; clipped++; }
    buf.writeInt16LE(l, 44 + i * 4); buf.writeInt16LE(r, 46 + i * 4);
  }
  writeFileSync(path, buf);
  return clipped;
}

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const r = render(job);
let peak = 0;
for (let i = 0; i < r.length; i++) { const a = Math.abs(r.left[i]), b = Math.abs(r.right[i]); if (a > peak) peak = a; if (b > peak) peak = b; }
const clipped = process.argv[3] ? writeWav(process.argv[3], r.left, r.right, r.length, 1) : 0;
const b = r.marks.boundaries;
console.log(JSON.stringify({
  samples: r.length, duration: r.length / RATE, musicEnd: r.musicEnd, peak, clipped, notes: r.notes,
  ended: r.ended, loopCount: r.loopCount, loopStartTick: r.marks.loopStartTick, loopEndTick: r.marks.loopEndTick,
  // boundaries[0] = first arrival at the loop start; boundaries[k] = end of pass k
  boundaries: b, stats: r.stats,
}));
