// MFi software synthesiser: sequencer + voices + 4-port mixer, as plain JavaScript working on
// Float32Arrays. This file has NO imports on purpose: the very same file is
//   - imported by web/src/host/audio.js (compileMFi, and MfiMixer for the ScriptProcessor fallback),
//   - loaded as the AudioWorklet module (it registers the "mfi-mixer" processor at the bottom),
//   - imported by tools/mfi/render.mjs to render WAV files in Node.
//
// Pipeline:  parseMFi() (formats/mfi.js)  ->  compileMFi()  ->  song (plain data, structured-
// clone safe)  ->  MfiPlayer (one per port: sequencer in ticks, tempo/loops resolved live)  ->
// MfiMixer (port gain, master gain, limiter).
//
// The phones this game ran on used a FueTrek wavetable sound source; nothing of its ROM is used
// here. There are two sets of instruments. When a sampled set has been loaded (a 'soundfont'
// message: zones and 16-bit samples cut out of a General MIDI SoundFont by
// tools/soundfont/extract.mjs) notes are played from it, with the SoundFont's own key ranges,
// loops and volume envelopes. Otherwise, and for any program the set lacks, timbres are small
// 2-operator FM patches chosen per General MIDI program and percussion is
// synthesised (sine sweeps + filtered noise). The embedded ADPCM samples are played through
// the phone's own 8 kHz -> 32 kHz reconstruction filter (coefficients as recovered from
// MFiSoundLib by the MLD_Player (MIT) and vavi-sound projects). Level laws are GM-style
// (amplitude = (value / max)^2) — an assumption, the native gain tables were not used.

// ---- song compilation -------------------------------------------------------------------------

export const OP = {
  NOTE: 1, PROGRAM: 2, VOLUME: 3, PAN: 4, BEND: 5, EXPRESSION: 6, MODULATION: 7, TEMPO: 8,
  MASTER: 9, LOOP_START: 10, LOOP_END: 11, AUDIO_PLAY: 12, AUDIO_STOP: 13, AUDIO_VOLUME: 14,
  AUDIO_PAN: 15, END: 16,
};

const PCM_RATE = 32000;
// [b0, b1, b2, a1, a2] with y = b0 x + b1 x1 + b2 x2 + a1 y1 + a2 y2
const RECONSTRUCTION = {
  8000: [
    [0.375, -0.00390625, 0.375, 1.4150390625, -0.6875],
    [0.04296875, 0.0654296875, 0.04296875, 1.439453125, -0.54296875],
    [0.306640625, -0.171875, 0.306640625, 1.4462890625, -0.8896484375],
  ],
  16000: [
    [0.207692, 0.36527, 0.207692, 0.892037, -0.282364],
    [0.35532, 0.289359, 0.35532, 0.588666, -0.588666],
    [0.631808, 0.226858, 0.631808, 0.385442, -0.875916],
  ],
};

/** Bring a decoded sample to 32 kHz the way the phone does: zero-stuff, three IIR sections. */
export function reconstructPcm(pcm, sampleRate) {
  const bank = RECONSTRUCTION[sampleRate];
  if (!bank) return { pcm, rate: sampleRate };
  const factor = PCM_RATE / sampleRate;
  const tail = 64; // let the filter ring out
  const out = new Float32Array(pcm.length * factor + tail);
  const st = bank.map(() => [0, 0, 0, 0]); // x1 x2 y1 y2
  for (let i = 0; i < out.length; i++) {
    let v = i % factor === 0 && i / factor < pcm.length ? pcm[i / factor] : 0;
    for (let s = 0; s < bank.length; s++) {
      const c = bank[s], z = st[s];
      const y = c[0] * v + c[1] * z[0] + c[2] * z[1] + c[3] * z[2] + c[4] * z[3];
      z[1] = z[0];
      z[0] = v;
      z[3] = z[2];
      z[2] = y;
      v = y;
    }
    out[i] = v;
  }
  return { pcm: out, rate: PCM_RATE };
}

/**
 * Turn the output of parseMFi() into the compact, clone-safe form the player consumes.
 * @returns {{title:string|null, duration:number, endTick:number, loops:boolean, loopStart:number,
 *            loopEnd:number, events:object[], samples:{rate:number, pcm:Float32Array}[]}}
 */
export function compileMFi(mfi) {
  const events = [];
  let lastEnd = -1;
  for (const e of mfi.events) {
    const t = e.tick;
    // voices mapped to logical channels 16-63 are legal and silent
    if (e.channel !== undefined && e.channel > 15) continue;
    switch (e.type) {
      case 'note':
        events.push({ t, op: OP.NOTE, ch: e.channel, key: e.midi, vel: e.velocity, gate: e.gate, perc: e.percussion });
        break;
      case 'program': events.push({ t, op: OP.PROGRAM, ch: e.channel, value: e.gm, perc: e.percussion }); break;
      case 'volume': events.push({ t, op: OP.VOLUME, ch: e.channel, value: e.value }); break;
      case 'pan': events.push({ t, op: OP.PAN, ch: e.channel, value: e.value }); break;
      case 'expression': events.push({ t, op: OP.EXPRESSION, ch: e.channel, value: e.value }); break;
      case 'modulation': events.push({ t, op: OP.MODULATION, ch: e.channel, value: e.value }); break;
      case 'pitchBend':
      case 'pitchBendFine':
        if (e.commit) events.push({ t, op: OP.BEND, ch: e.channel, value: e.semitones });
        break;
      case 'tempo':
      case 'tempoRelative':
      case 'reset':
        events.push({ t, op: OP.TEMPO, value: e.secPerTick });
        break;
      case 'masterVolume': events.push({ t, op: OP.MASTER, value: e.value }); break;
      case 'masterVolumeRelative': events.push({ t, op: OP.MASTER, value: e.value, relative: true }); break;
      case 'loop':
        // the native player only honours loop points of track 0
        if (e.track === 0) events.push({ t, op: e.point === 'start' ? OP.LOOP_START : OP.LOOP_END, id: e.id, count: e.count });
        break;
      case 'audioPlay': events.push({ t, op: OP.AUDIO_PLAY, ch: e.channel, sample: e.sample, vel: e.velocity }); break;
      case 'audioStop': events.push({ t, op: OP.AUDIO_STOP, ch: e.channel, sample: e.sample }); break;
      case 'audioVolume': events.push({ t, op: OP.AUDIO_VOLUME, ch: e.channel, value: e.value }); break;
      case 'audioPan': events.push({ t, op: OP.AUDIO_PAN, ch: e.channel, value: e.value }); break;
      case 'end': lastEnd = Math.max(lastEnd, t); break;
      default: break;
    }
  }
  events.push({ t: Math.max(lastEnd, mfi.endTick), op: OP.END });
  const forever = !!mfi.loop && mfi.loop.count === 0 && mfi.loop.track === 0;
  return {
    title: mfi.header.title,
    duration: mfi.duration,
    endTick: mfi.endTick,
    loops: forever,
    loopStart: forever ? mfi.loop.startTime : 0,
    loopEnd: forever ? mfi.loop.endTime : 0,
    events,
    samples: mfi.samples.map((s) => reconstructPcm(s.pcm, s.sampleRate)),
  };
}

// ---- tables -----------------------------------------------------------------------------------

const SINE_SIZE = 4096;
const SINE = new Float32Array(SINE_SIZE + 1);
for (let i = 0; i <= SINE_SIZE; i++) SINE[i] = Math.sin((i / SINE_SIZE) * Math.PI * 2);

const INV_2PI = 1 / (Math.PI * 2);
const CHUNK = 64;
const MAX_VOICES = 48;
const SILENT = 0.003; // envelope level (-50 dB) at which a voice is dropped
// mix levels: a full BGM arrangement lands around -19 dBFS RMS (peaks about -4), a full-scale
// sampled effect peaks around -4 dBFS on its own; the limiter takes care of the sum
const FM_LEVEL = 0.2;
const DRUM_LEVEL = 0.25;
const PCM_LEVEL = 0.62;
const SF_LEVEL = 0.5; // sampled instruments (full-scale recordings)
const sq = (v) => v * v;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// FM patch: carrier ratio c, modulator ratio m, modulation index i0 -> i1 (time constant id),
// modulator feedback fb, `follow` = how much the index tracks the amplitude envelope (brass),
// amplitude envelope: attack a (s, linear), decay time constant d (s) towards sustain s,
// release r (s to fall 40 dB). c2/det/l2: optional second carrier (ratio, detune in cents, level).
// vib: vibrato depth in cents (after vibDelay s). lvl: patch loudness trim.
const FM_DEFAULT = {
  c: 1, m: 1, i0: 1.5, i1: 0.6, id: 0.3, fb: 0, follow: 0, a: 0.004, d: 0.6, s: 0.5, r: 0.2,
  c2: 0, det: 0, l2: 0, vib: 0, vibDelay: 0.3, lvl: 1, track: 0.3,
};
const fm = (o) => ({ ...FM_DEFAULT, ...o });

const PATCH = {
  piano: fm({ i0: 2.2, i1: 0.35, id: 0.28, a: 0.002, d: 0.9, s: 0, r: 0.3, c2: 1, det: 3, l2: 0.6 }),
  epiano: fm({ i0: 1.3, i1: 0.25, id: 0.45, a: 0.002, d: 1.3, s: 0, r: 0.35, c2: 1, det: 5, l2: 0.7 }),
  clav: fm({ m: 3, i0: 2.4, i1: 0.9, id: 0.18, a: 0.001, d: 0.45, s: 0, r: 0.12 }),
  celesta: fm({ m: 4, i0: 1.3, i1: 0.1, id: 0.12, a: 0.001, d: 0.45, s: 0, r: 0.5, track: 0.5 }),
  vibes: fm({ m: 4, i0: 1.0, i1: 0.12, id: 0.2, a: 0.001, d: 1.0, s: 0, r: 0.7, c2: 1, det: 4, l2: 0.6, track: 0.4 }),
  marimba: fm({ m: 2.4, i0: 1.6, i1: 0.05, id: 0.035, a: 0.001, d: 0.28, s: 0, r: 0.35, lvl: 1.2 }),
  bell: fm({ m: 3.5, i0: 2.4, i1: 0.4, id: 0.5, a: 0.001, d: 1.3, s: 0, r: 1.0, c2: 1, det: 6, l2: 0.6, track: 0.5 }),
  crystal: fm({ m: 5, i0: 1.6, i1: 0.2, id: 0.3, a: 0.001, d: 0.8, s: 0, r: 0.8, c2: 2, det: 5, l2: 0.35, track: 0.5 }),
  organ: fm({ i0: 0.9, i1: 0.9, fb: 0.25, a: 0.005, d: 1, s: 1, r: 0.06, c2: 2, l2: 0.5, vib: 4, vibDelay: 0.1 }),
  rockOrgan: fm({ i0: 1.5, i1: 1.3, id: 0.2, fb: 0.35, a: 0.004, d: 1, s: 1, r: 0.07, c2: 2, det: 3, l2: 0.65, vib: 7, vibDelay: 0.05 }),
  accordion: fm({ m: 2, i0: 1.3, i1: 1.3, fb: 0.2, a: 0.02, d: 1, s: 1, r: 0.1, c2: 1, det: 9, l2: 0.9 }),
  guitar: fm({ i0: 2.6, i1: 0.3, id: 0.18, a: 0.002, d: 0.6, s: 0, r: 0.25 }),
  distGuitar: fm({ i0: 3.2, i1: 2.6, id: 0.4, fb: 0.6, a: 0.004, d: 2.5, s: 0.7, r: 0.15, c2: 1, det: 6, l2: 0.7 }),
  bass: fm({ i0: 2.8, i1: 0.7, id: 0.11, a: 0.002, d: 0.8, s: 0.2, r: 0.12, lvl: 1.5, track: 0 }),
  synthBass: fm({ i0: 3.4, i1: 1.3, id: 0.16, fb: 0.4, a: 0.002, d: 0.5, s: 0.55, r: 0.1, lvl: 1.4, track: 0 }),
  soloString: fm({ i0: 1.5, i1: 1.5, fb: 0.5, a: 0.05, d: 1, s: 0.9, r: 0.25, vib: 8 }),
  pizzicato: fm({ i0: 1.9, i1: 0.2, id: 0.07, a: 0.002, d: 0.16, s: 0, r: 0.2, lvl: 1.2 }),
  harp: fm({ i0: 1.7, i1: 0.2, id: 0.22, a: 0.002, d: 0.8, s: 0, r: 0.6 }),
  timpani: fm({ i0: 2.6, i1: 0.3, id: 0.12, a: 0.002, d: 0.55, s: 0, r: 0.5, lvl: 1.6, track: 0 }),
  strings: fm({ i0: 1.5, i1: 1.5, fb: 0.55, a: 0.07, d: 1, s: 0.9, r: 0.4, c2: 1, det: 9, l2: 1, vib: 5, vibDelay: 0.4 }),
  slowStrings: fm({ i0: 1.3, i1: 1.3, fb: 0.5, a: 0.2, d: 1, s: 0.9, r: 0.6, c2: 1, det: 9, l2: 1, vib: 5, vibDelay: 0.5 }),
  choir: fm({ m: 2, i0: 0.8, i1: 0.8, fb: 0.2, a: 0.09, d: 1, s: 0.9, r: 0.45, c2: 1, det: 8, l2: 1, vib: 6 }),
  hit: fm({ i0: 3, i1: 1, id: 0.2, fb: 0.5, a: 0.004, d: 0.35, s: 0, r: 0.4, c2: 2, det: 8, l2: 0.8 }),
  trumpet: fm({ i0: 2.7, i1: 1.9, id: 0.3, follow: 0.8, a: 0.022, d: 0.8, s: 0.85, r: 0.12, vib: 5, vibDelay: 0.35 }),
  horn: fm({ i0: 1.5, i1: 1.0, id: 0.3, follow: 0.7, a: 0.05, d: 0.8, s: 0.9, r: 0.2, lvl: 1.15 }),
  brass: fm({ i0: 2.9, i1: 2.0, id: 0.3, follow: 0.8, a: 0.028, d: 0.8, s: 0.85, r: 0.14, c2: 1, det: 7, l2: 1 }),
  synthBrass: fm({ i0: 3.1, i1: 2.2, id: 0.25, fb: 0.3, follow: 0.6, a: 0.014, d: 0.8, s: 0.85, r: 0.15, c2: 1, det: 10, l2: 1 }),
  sax: fm({ i0: 2.2, i1: 1.6, id: 0.3, fb: 0.3, follow: 0.6, a: 0.025, d: 0.8, s: 0.9, r: 0.14, vib: 6 }),
  clarinet: fm({ m: 2, i0: 1.4, i1: 1.2, id: 0.3, follow: 0.4, a: 0.03, d: 1, s: 0.95, r: 0.12 }),
  flute: fm({ i0: 0.8, i1: 0.45, id: 0.15, a: 0.035, d: 1, s: 0.92, r: 0.15, vib: 7, vibDelay: 0.25 }),
  whistle: fm({ i0: 0.25, i1: 0.12, id: 0.1, a: 0.03, d: 1, s: 0.95, r: 0.14, vib: 7 }),
  square: fm({ m: 2, i0: 1.7, i1: 1.7, a: 0.003, d: 1, s: 1, r: 0.07, lvl: 0.8 }),
  saw: fm({ i0: 1.7, i1: 1.7, fb: 0.6, a: 0.003, d: 1, s: 1, r: 0.09, c2: 1, det: 6, l2: 0.8, lvl: 0.85 }),
  fifths: fm({ i0: 1.7, i1: 1.6, fb: 0.6, a: 0.004, d: 1, s: 1, r: 0.12, c2: 1.4983, l2: 0.8, lvl: 0.85 }),
  pad: fm({ i0: 1.0, i1: 1.0, fb: 0.4, a: 0.25, d: 1, s: 0.9, r: 0.8, c2: 1, det: 10, l2: 1 }),
  sitar: fm({ m: 3, i0: 2.5, i1: 0.8, id: 0.3, fb: 0.3, a: 0.002, d: 0.7, s: 0, r: 0.3 }),
  woodblock: fm({ m: 2.7, i0: 1.2, i1: 0, id: 0.02, a: 0.001, d: 0.06, s: 0, r: 0.08, lvl: 1.3 }),
};

const PROGRAM_PATCH = new Array(128);
(function buildProgramMap() {
  const set = (from, to, name) => {
    for (let p = from; p <= to; p++) PROGRAM_PATCH[p] = PATCH[name];
  };
  set(0, 3, 'piano'); set(4, 5, 'epiano'); set(6, 7, 'clav');
  set(8, 8, 'celesta'); set(9, 10, 'bell'); set(11, 11, 'vibes'); set(12, 13, 'marimba'); set(14, 15, 'bell');
  set(16, 17, 'organ'); set(18, 18, 'rockOrgan'); set(19, 20, 'organ'); set(21, 23, 'accordion');
  set(24, 28, 'guitar'); set(29, 30, 'distGuitar'); set(31, 31, 'guitar');
  set(32, 37, 'bass'); set(38, 39, 'synthBass');
  set(40, 44, 'soloString'); set(45, 45, 'pizzicato'); set(46, 46, 'harp'); set(47, 47, 'timpani');
  set(48, 48, 'strings'); set(49, 49, 'slowStrings'); set(50, 51, 'strings'); set(52, 54, 'choir'); set(55, 55, 'hit');
  set(56, 59, 'trumpet'); set(60, 60, 'horn'); set(61, 61, 'brass'); set(62, 63, 'synthBrass');
  set(64, 67, 'sax'); set(68, 70, 'clarinet'); set(71, 71, 'clarinet');
  set(72, 77, 'flute'); set(78, 79, 'whistle');
  set(80, 80, 'square'); set(81, 81, 'saw'); set(82, 83, 'flute'); set(84, 84, 'distGuitar'); set(85, 85, 'choir');
  set(86, 86, 'fifths'); set(87, 87, 'synthBass');
  set(88, 95, 'pad');
  set(96, 97, 'pad'); set(98, 98, 'crystal'); set(99, 103, 'pad');
  set(104, 107, 'sitar'); set(108, 108, 'marimba'); set(109, 111, 'clarinet');
  set(112, 112, 'bell'); set(113, 113, 'woodblock'); set(114, 114, 'bell'); set(115, 115, 'woodblock');
  set(116, 118, 'timpani'); set(119, 127, 'pad');
})();

export function patchNameForProgram(program) {
  const p = PROGRAM_PATCH[program & 127];
  return Object.keys(PATCH).find((k) => PATCH[k] === p) ?? 'piano';
}

// Percussion (GM key numbers). tone: [startHz, endHz, sweep time constant, decay time constant,
// level]; noise: [high-pass Hz, low-pass Hz, decay time constant, level]; metal: level of the
// inharmonic square cluster fed into the noise filter; pan -1..1; choke group.
const DRUM_DEFAULT = { tone: null, tone2: null, noise: null, metal: 0, metalHz: 1, pan: 0, choke: 0, lvl: 1 };
const dr = (o) => ({ ...DRUM_DEFAULT, ...o });
const DRUMS = {
  35: dr({ tone: [130, 45, 0.03, 0.16, 1.5], noise: [800, 5000, 0.006, 0.25] }),
  36: dr({ tone: [170, 52, 0.022, 0.13, 1.5], noise: [1000, 6000, 0.005, 0.3] }),
  37: dr({ tone: [1700, 1650, 0.01, 0.012, 0.5], noise: [1800, 9000, 0.012, 0.5] }),
  38: dr({ tone: [260, 180, 0.012, 0.07, 0.7], noise: [1400, 8500, 0.085, 0.75] }),
  39: dr({ noise: [900, 3500, 0.11, 0.9], pan: -0.1 }),
  40: dr({ tone: [300, 210, 0.01, 0.055, 0.6], noise: [2000, 10000, 0.07, 0.75] }),
  41: dr({ tone: [140, 78, 0.06, 0.2, 1.2], noise: [600, 3000, 0.01, 0.15], pan: -0.4 }),
  42: dr({ noise: [7000, 16000, 0.022, 1.1], metal: 0.5, pan: 0.25, choke: 1 }),
  43: dr({ tone: [165, 95, 0.06, 0.19, 1.2], noise: [600, 3000, 0.01, 0.15], pan: -0.25 }),
  44: dr({ noise: [6500, 16000, 0.03, 1.0], metal: 0.5, pan: 0.25, choke: 1 }),
  45: dr({ tone: [200, 120, 0.06, 0.18, 1.2], noise: [600, 3000, 0.01, 0.15], pan: -0.1 }),
  46: dr({ noise: [6500, 16000, 0.16, 1.0], metal: 0.5, pan: 0.25, choke: 1 }),
  47: dr({ tone: [240, 150, 0.06, 0.17, 1.2], noise: [600, 3000, 0.01, 0.15], pan: 0.1 }),
  48: dr({ tone: [290, 185, 0.06, 0.16, 1.2], noise: [600, 3000, 0.01, 0.15], pan: 0.25 }),
  49: dr({ noise: [4500, 15000, 0.45, 0.9], metal: 0.45, metalHz: 0.9, pan: -0.3 }),
  50: dr({ tone: [340, 225, 0.06, 0.15, 1.2], noise: [600, 3000, 0.01, 0.15], pan: 0.4 }),
  51: dr({ noise: [5500, 14000, 0.25, 0.7], metal: 0.6, metalHz: 1.25, pan: 0.3 }),
  52: dr({ noise: [3500, 13000, 0.4, 0.9], metal: 0.5, metalHz: 0.8, pan: 0.3 }),
  53: dr({ tone: [2630, 2630, 1, 0.25, 0.25], noise: [5500, 14000, 0.2, 0.5], metal: 0.6, metalHz: 1.4, pan: 0.3 }),
  54: dr({ noise: [7500, 16000, 0.09, 0.9], metal: 0.4, metalHz: 1.6, pan: -0.2 }),
  55: dr({ noise: [5500, 16000, 0.3, 0.9], metal: 0.45, metalHz: 1.1, pan: -0.2 }),
  56: dr({ tone: [800, 800, 1, 0.07, 0.6], tone2: [540, 540, 1, 0.07, 0.6], pan: 0.2 }),
  57: dr({ noise: [4000, 15000, 0.5, 0.9], metal: 0.45, metalHz: 0.8, pan: 0.3 }),
  58: dr({ noise: [1500, 5000, 0.25, 0.6], metal: 0.3, metalHz: 0.4, pan: -0.3 }),
  59: dr({ noise: [5000, 14000, 0.25, 0.7], metal: 0.6, metalHz: 1.15, pan: -0.3 }),
  60: dr({ tone: [420, 380, 0.02, 0.06, 1], pan: 0.3 }),
  61: dr({ tone: [300, 270, 0.02, 0.08, 1], pan: 0.3 }),
  62: dr({ tone: [330, 300, 0.01, 0.03, 0.9], noise: [1000, 4000, 0.01, 0.2], pan: -0.3 }),
  63: dr({ tone: [310, 280, 0.02, 0.1, 1], pan: -0.3 }),
  64: dr({ tone: [220, 195, 0.02, 0.12, 1.1], pan: -0.3 }),
  65: dr({ tone: [520, 470, 0.02, 0.1, 0.9], noise: [2000, 8000, 0.01, 0.2], pan: 0.2 }),
  66: dr({ tone: [380, 340, 0.02, 0.12, 0.9], noise: [2000, 8000, 0.01, 0.2], pan: 0.2 }),
  67: dr({ tone: [1250, 1250, 1, 0.09, 0.6], tone2: [1870, 1870, 1, 0.07, 0.4], pan: -0.2 }),
  68: dr({ tone: [900, 900, 1, 0.09, 0.6], tone2: [1350, 1350, 1, 0.07, 0.4], pan: -0.2 }),
  69: dr({ noise: [6000, 14000, 0.05, 0.5], pan: -0.3 }),
  70: dr({ noise: [8000, 16000, 0.03, 0.5], pan: 0.3 }),
  71: dr({ tone: [2300, 2300, 1, 0.05, 0.5], pan: 0.3 }),
  72: dr({ tone: [2100, 2100, 1, 0.2, 0.5], pan: 0.3 }),
  73: dr({ noise: [3000, 9000, 0.03, 0.5], pan: 0.3 }),
  74: dr({ noise: [2500, 8000, 0.15, 0.5], pan: 0.3 }),
  75: dr({ tone: [2500, 2500, 1, 0.025, 0.8], pan: 0.2 }),
  76: dr({ tone: [1100, 1100, 1, 0.03, 0.8], pan: 0.2 }),
  77: dr({ tone: [750, 750, 1, 0.035, 0.8], pan: 0.2 }),
  78: dr({ tone: [700, 500, 0.08, 0.08, 0.6], pan: -0.2 }),
  79: dr({ tone: [450, 620, 0.08, 0.12, 0.6], pan: -0.2 }),
  80: dr({ tone: [4200, 4200, 1, 0.04, 0.4], pan: -0.3 }),
  81: dr({ tone: [4200, 4200, 1, 0.3, 0.4], pan: -0.3 }),
};
const DRUM_FALLBACK = dr({ tone: [600, 500, 0.02, 0.04, 0.6], noise: [2000, 8000, 0.03, 0.3] });
const METAL_HZ = [3520, 4690, 5540, 6310, 7640, 9210];

// ---- voices -----------------------------------------------------------------------------------

class Channel {
  constructor() {
    this.reset();
  }

  reset() {
    this.patch = PATCH.piano;
    this.program = 0;
    this.percussion = false;
    this.volume = 63;
    this.pan = 32;
    this.bend = 0; // semitones
    this.modulation = 0;
    this.audioVolume = 63;
    this.audioPan = 32;
  }
}

function panGains(pan, out) {
  // pan -1..1, equal power, 0 dB at centre
  const a = (clamp(pan, -1, 1) + 1) * 0.25 * Math.PI;
  out[0] = Math.cos(a) * Math.SQRT2;
  out[1] = Math.sin(a) * Math.SQRT2;
}
const PG = [1, 1];

class FmVoice {
  kind = 0;

  init(player, ch, key, vel, gate) {
    const sr = player.sampleRate;
    const p = ch.patch;
    this.player = player;
    this.ch = ch;
    this.patch = p;
    this.key = key;
    this.gate = gate;
    this.released = false;
    this.age = 0;
    this.hz = midiHz(key);
    this.velGain = sq(vel / 63);
    // brighter when hit harder, duller towards the top of the keyboard, and never past Nyquist
    const bright = 0.55 + 0.45 * (vel / 63);
    const keyScale = Math.pow(clamp(261.6 / this.hz, 0.25, 2), p.track);
    // highest significant partial is about carrier + (index + 1) * modulator
    const limit = Math.max(0, ((0.42 * sr) / this.hz - Math.max(p.c, p.c2)) / p.m - 1);
    this.i0 = Math.min(p.i0 * bright * keyScale, limit);
    this.i1 = Math.min(p.i1 * bright * keyScale, limit);
    this.idx = 1; // index envelope 1 -> 0
    this.idxCoef = Math.exp(-1 / (p.id * sr));
    this.env = 0;
    this.stage = 0; // 0 attack, 1 decay/sustain, 2 release
    this.aInc = 1 / Math.max(1, p.a * sr);
    // plucked / struck sounds ring shorter the higher they are
    const dScale = p.s === 0 ? clamp(Math.pow(261.6 / this.hz, 0.35), 0.3, 2.2) : 1;
    this.dCoef = Math.exp(-1 / (p.d * dScale * sr));
    this.rCoef = Math.exp(-4.6 / (p.r * sr)); // r = time to fall 40 dB
    this.pc = 0;
    this.pm = 0;
    this.p2 = 0.25;
    this.fbv = 0;
    this.amp = FM_LEVEL * p.lvl / (1 + p.l2);
    this.gl = -1;
    this.gr = 0;
    this.lfo = 0;
    return this;
  }

  release() {
    if (this.stage !== 2) this.stage = 2;
    this.released = true;
    this.gate = Infinity;
  }

  /** Fade out quickly (used when a port is stopped). */
  kill(sr) {
    this.release();
    this.rCoef = Math.exp(-1 / (0.008 * sr));
  }

  render(L, R, start, n) {
    const p = this.patch, ch = this.ch, sr = this.player.sampleRate;
    // per-chunk control: pitch (bend, vibrato), gains
    let ratio = ch.bend !== 0 ? Math.pow(2, ch.bend / 12) : 1;
    const vibDepth = p.vib + ch.modulation * 0.8;
    if (vibDepth > 0 && this.age > p.vibDelay * sr) {
      this.lfo += (5.6 * n) / sr;
      ratio *= 1 + Math.sin(this.lfo * Math.PI * 2) * vibDepth * 0.000578;
    }
    const base = (this.hz * ratio) / sr;
    const incC = base * p.c, incM = base * p.m;
    const useC2 = p.l2 > 0;
    const inc2 = useC2 ? base * p.c2 * (p.det ? Math.pow(2, p.det / 1200) : 1) : 0;
    const l2 = p.l2, fb = p.fb, follow = p.follow;
    panGains((ch.pan - 32) / 32, PG);
    const g = this.amp * this.velGain * sq(ch.volume / 63) * this.player.masterGain;
    const tl = g * PG[0], tr = g * PG[1];
    if (this.gl < 0) {
      this.gl = tl;
      this.gr = tr;
    }
    let gl = this.gl, gr = this.gr;
    const dl = (tl - gl) / n, dR = (tr - gr) / n;

    let pc = this.pc, pm = this.pm, p2 = this.p2, fbv = this.fbv;
    let env = this.env, idx = this.idx, stage = this.stage;
    const aInc = this.aInc, dCoef = this.dCoef, rCoef = this.rCoef, idxCoef = this.idxCoef;
    const sus = p.s, i0 = this.i0, i1 = this.i1;
    const end = start + n;
    for (let i = start; i < end; i++) {
      if (stage === 0) {
        env += aInc;
        if (env >= 1) {
          env = 1;
          stage = 1;
        }
      } else if (stage === 1) env = sus + (env - sus) * dCoef;
      else env *= rCoef;
      idx *= idxCoef;
      let index = i1 + (i0 - i1) * idx;
      if (follow > 0) index *= 1 - follow + follow * env;

      // modulator (with feedback)
      let x = pm + fbv * fb * INV_2PI;
      x -= Math.floor(x);
      let f = x * SINE_SIZE, k = f | 0;
      const mod = SINE[k] + (SINE[k + 1] - SINE[k]) * (f - k);
      fbv = mod;
      const dev = mod * index * INV_2PI;
      // carrier(s)
      x = pc + dev;
      x -= Math.floor(x);
      f = x * SINE_SIZE;
      k = f | 0;
      let s = SINE[k] + (SINE[k + 1] - SINE[k]) * (f - k);
      if (useC2) {
        x = p2 + dev;
        x -= Math.floor(x);
        f = x * SINE_SIZE;
        k = f | 0;
        s += (SINE[k] + (SINE[k + 1] - SINE[k]) * (f - k)) * l2;
        p2 += inc2;
        if (p2 >= 1) p2 -= 1;
      }
      s *= env;
      L[i] += s * gl;
      R[i] += s * gr;
      gl += dl;
      gr += dR;
      pc += incC;
      if (pc >= 1) pc -= 1;
      pm += incM;
      if (pm >= 1) pm -= 1;
    }
    this.pc = pc;
    this.pm = pm;
    this.p2 = p2;
    this.fbv = fbv;
    this.env = env;
    this.idx = idx;
    this.stage = stage;
    this.gl = tl;
    this.gr = tr;
    this.age += n;
    // dead once inaudible (struck sounds die on their own, sustained ones after release)
    return !((stage === 2 || (stage === 1 && sus === 0)) && env < SILENT);
  }
}

class Tone {
  on = false;
  f = 0;
  f1 = 0;
  sweep = 1;
  env = 0;
  decay = 1;
  ph = 0;

  set(t, sr) {
    this.on = !!t;
    this.env = 0;
    if (!t) return;
    this.f = t[0];
    this.f1 = t[1];
    this.sweep = Math.exp(-1 / (t[2] * sr));
    this.decay = Math.exp(-1 / (t[3] * sr));
    this.env = t[4];
    this.ph = 0;
  }
}

class DrumVoice {
  kind = 1;
  t1 = new Tone();
  t2 = new Tone();
  mph = new Float64Array(6);
  minc = new Float64Array(6);

  init(player, ch, key, vel, gate) {
    const sr = player.sampleRate;
    const d = DRUMS[key] ?? DRUM_FALLBACK;
    this.player = player;
    this.ch = ch;
    this.def = d;
    this.key = key;
    this.gate = gate;
    this.released = false;
    this.age = 0;
    this.velGain = sq(vel / 63);
    this.choke = d.choke;
    this.fade = 1;
    this.fadeCoef = 1;
    this.t1.set(d.tone, sr);
    this.t2.set(d.tone2, sr);
    if (d.noise) {
      const ny = sr * 0.45;
      this.nEnv = d.noise[3];
      this.nDecay = Math.exp(-1 / (d.noise[2] * sr));
      this.hpA = Math.exp((-2 * Math.PI * Math.min(d.noise[0], ny)) / sr);
      this.lpA = 1 - Math.exp((-2 * Math.PI * Math.min(d.noise[1], ny)) / sr);
    } else {
      this.nEnv = 0;
      this.nDecay = 0;
      this.hpA = 0;
      this.lpA = 0;
    }
    this.hx = 0;
    this.hy = 0;
    this.hx2 = 0;
    this.hy2 = 0;
    this.lp = 0;
    this.metal = d.metal;
    for (let j = 0; j < 6; j++) {
      this.mph[j] = (j * 0.37) % 1;
      this.minc[j] = Math.min((METAL_HZ[j] * d.metalHz) / sr, 0.49);
    }
    this.amp = DRUM_LEVEL * d.lvl;
    return this;
  }

  release() {
    // one-shot: the gate only matters for the "same key before expiry" rule
    this.released = true;
    this.gate = Infinity;
  }

  kill(sr, seconds = 0.008) {
    this.release();
    this.fadeCoef = Math.exp(-1 / (seconds * sr));
  }

  render(L, R, start, n) {
    const ch = this.ch, d = this.def, invSr = 1 / this.player.sampleRate;
    panGains(clamp((ch.pan - 32) / 32 + d.pan, -1, 1), PG);
    const g = this.amp * this.velGain * sq(ch.volume / 63) * this.player.masterGain;
    const gl = g * PG[0], gr = g * PG[1];
    const t1 = this.t1, t2 = this.t2;
    let nEnv = this.nEnv;
    const nDecay = this.nDecay, hpA = this.hpA, lpA = this.lpA;
    let hx = this.hx, hy = this.hy, hx2 = this.hx2, hy2 = this.hy2, lp = this.lp;
    let seed = this.player.seed;
    const metal = this.metal, mph = this.mph, minc = this.minc;
    let fade = this.fade;
    const fadeCoef = this.fadeCoef;
    const end = start + n;
    for (let i = start; i < end; i++) {
      let s = 0;
      if (t1.on) {
        t1.f = t1.f1 + (t1.f - t1.f1) * t1.sweep;
        t1.ph += t1.f * invSr;
        if (t1.ph >= 1) t1.ph -= 1;
        const f = t1.ph * SINE_SIZE, k = f | 0;
        s += (SINE[k] + (SINE[k + 1] - SINE[k]) * (f - k)) * t1.env;
        t1.env *= t1.decay;
      }
      if (t2.on) {
        t2.f = t2.f1 + (t2.f - t2.f1) * t2.sweep;
        t2.ph += t2.f * invSr;
        if (t2.ph >= 1) t2.ph -= 1;
        const f = t2.ph * SINE_SIZE, k = f | 0;
        s += (SINE[k] + (SINE[k + 1] - SINE[k]) * (f - k)) * t2.env;
        t2.env *= t2.decay;
      }
      if (nEnv > 0.0003) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        let x = seed * 4.656612873e-10; // -1..1
        if (metal > 0) {
          let m = 0;
          for (let j = 0; j < 6; j++) {
            let ph = mph[j] + minc[j];
            if (ph >= 1) ph -= 1;
            mph[j] = ph;
            m += ph < 0.5 ? 1 : -1;
          }
          x = x * (1 - metal) + m * (metal / 3);
        }
        // two one-pole high-passes, one one-pole low-pass
        hy = hpA * (hy + x - hx);
        hx = x;
        hy2 = hpA * (hy2 + hy - hx2);
        hx2 = hy;
        lp += lpA * (hy2 - lp);
        s += lp * nEnv * 1.6;
        nEnv *= nDecay;
      }
      s *= fade;
      fade *= fadeCoef;
      L[i] += s * gl;
      R[i] += s * gr;
    }
    this.nEnv = nEnv;
    this.hx = hx;
    this.hy = hy;
    this.hx2 = hx2;
    this.hy2 = hy2;
    this.lp = lp;
    this.fade = fade;
    this.player.seed = seed;
    this.age += n;
    return Math.max(t1.env, t2.env, nEnv) * fade > SILENT;
  }
}

class PcmVoice {
  kind = 2;

  init(player, ch, sampleIndex, sample, vel) {
    this.player = player;
    this.ch = ch;
    this.key = -1 - sampleIndex;
    this.sample = sampleIndex;
    this.pcm = sample.pcm;
    this.step = sample.rate / player.sampleRate;
    this.pos = 0;
    this.gate = Infinity;
    this.released = false;
    this.age = 0;
    this.velGain = sq(vel / 63);
    this.fade = 1;
    this.fadeCoef = 1;
    this.choke = 0;
    return this;
  }

  release() {
    this.released = true;
    this.gate = Infinity;
  }

  kill(sr, seconds = 0.006) {
    this.release();
    this.fadeCoef = Math.exp(-1 / (seconds * sr));
  }

  render(L, R, start, n) {
    const ch = this.ch, pcm = this.pcm, last = pcm.length - 1;
    panGains((ch.audioPan - 32) / 32, PG);
    const g = PCM_LEVEL * this.velGain * sq(ch.audioVolume / 63) * this.player.masterGain;
    const gl = g * PG[0], gr = g * PG[1];
    let pos = this.pos, fade = this.fade;
    const step = this.step, fadeCoef = this.fadeCoef;
    const end = start + n;
    let alive = true;
    for (let i = start; i < end; i++) {
      const k = pos | 0;
      if (k >= last) {
        alive = false;
        break;
      }
      const s = (pcm[k] + (pcm[k + 1] - pcm[k]) * (pos - k)) * fade;
      fade *= fadeCoef;
      L[i] += s * gl;
      R[i] += s * gr;
      pos += step;
    }
    this.pos = pos;
    this.fade = fade;
    this.age += n;
    return alive && fade > SILENT;
  }
}

/**
 * A note played from the sampled instrument set: one zone of a SoundFont preset. The sample is
 * read at the pitch of the key (linear interpolation), looped if the zone has a loop, and shaped
 * by the zone's attack / hold / decay / sustain / release envelope (SoundFont decay and release
 * times are the time to fall 100 dB). Percussion ignores note-off, like General MIDI drums.
 */
class SfVoice {
  kind = 3;

  init(player, ch, key, vel, gate, zone, sf, percussion) {
    const sr = player.sampleRate;
    const sample = sf.samples[zone.s];
    this.player = player;
    this.ch = ch;
    this.key = key;
    this.gate = percussion ? Infinity : gate;
    this.released = false;
    this.percussion = percussion;
    this.age = 0;
    this.pcm = sf.pcm;
    this.base = sample.o;
    this.last = sample.n - 1;
    this.loopStart = zone.loop ? zone.loop[0] : -1;
    this.loopEnd = zone.loop ? Math.min(zone.loop[1], sample.n - 2) : 0;
    this.semis = (key - zone.root) * zone.scale;
    this.rate = sample.rate / sr;
    this.pos = 0;
    this.velGain = sq(vel / 63);
    this.zoneGain = zone.gain;
    this.zonePan = zone.pan;
    this.choke = zone.excl ?? 0;
    this.env = 0;
    this.stage = 0; // 0 attack, 1 hold, 2 decay, 3 sustain, 4 release
    this.aInc = 1 / Math.max(1, zone.a * sr);
    this.hold = zone.h * sr;
    this.dCoef = Math.exp(-11.51 / (Math.max(0.002, zone.d) * sr));
    this.sus = zone.sus;
    this.rCoef = Math.exp(-11.51 / (Math.max(0.01, zone.r) * sr));
    return this;
  }

  release() {
    this.released = true;
    this.gate = Infinity;
    if (!this.percussion) this.stage = 4;
  }

  /** Fade out quickly (a stopped port, a choked hi-hat). */
  kill(sr, seconds = 0.008) {
    this.released = true;
    this.gate = Infinity;
    this.stage = 4;
    this.rCoef = Math.exp(-1 / (seconds * sr));
  }

  render(L, R, start, n) {
    const ch = this.ch, pcm = this.pcm, base = this.base, last = this.last;
    const loopStart = this.loopStart, loopEnd = this.loopEnd, loopLength = loopEnd - loopStart;
    const step = this.rate * Math.pow(2, (this.semis + (this.percussion ? 0 : ch.bend)) / 12);
    panGains(clamp((ch.pan - 32) / 32 + this.zonePan, -1, 1), PG);
    const g = (SF_LEVEL / 32768) * this.velGain * this.zoneGain * sq(ch.volume / 63) * this.player.masterGain;
    const gl = g * PG[0], gr = g * PG[1];
    const { aInc, dCoef, rCoef, sus } = this;
    let pos = this.pos, env = this.env, stage = this.stage, hold = this.hold;
    const end = start + n;
    let alive = true;
    for (let i = start; i < end; i++) {
      let k = pos | 0;
      if (loopStart >= 0 && k >= loopEnd) {
        pos -= loopLength;
        k = pos | 0;
      } else if (k >= last) {
        alive = false;
        break;
      }
      if (stage === 0) {
        env += aInc;
        if (env >= 1) {
          env = 1;
          stage = 1;
        }
      } else if (stage === 1) {
        if (--hold <= 0) stage = 2;
      } else if (stage === 2) {
        env *= dCoef;
        if (env <= sus) {
          env = sus;
          stage = 3;
        }
      } else if (stage === 4) env *= rCoef;
      const a = pcm[base + k];
      const s = (a + (pcm[base + k + 1] - a) * (pos - k)) * env;
      L[i] += s * gl;
      R[i] += s * gr;
      pos += step;
    }
    this.pos = pos;
    this.env = env;
    this.stage = stage;
    this.hold = hold;
    this.age += n;
    return alive && !(stage >= 2 && env < SILENT);
  }
}

// ---- player (one port) ------------------------------------------------------------------------

const DEFAULT_SEC_PER_TICK = 60 / (125 * 48); // native default: 125 bpm, timebase 48

export class MfiPlayer {
  /**
   * @param {number} sampleRate
   * @param {{fileLoops?: boolean}} [options] fileLoops=false ignores the "forever" loop points
   *   in the file (the sequence then runs to its end and reports completion)
   */
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.fileLoops = options.fileLoops !== false;
    this.voices = [];
    this.pool = [[], [], [], []];
    /** Sampled instrument set shared by all ports (set by the mixer), or null: FM patches. */
    this.soundfont = null;
    this.channels = [];
    for (let i = 0; i < 16; i++) this.channels.push(new Channel());
    this.seed = 0x1234567;
    this.song = null;
    this.playing = false;
    this.ended = false;
    this.masterVolume = 100;
    this.masterGain = sq(100 / 127);
    this.solo = null; // optional Set of channel numbers (render tool)
    this.notifications = []; // { type: 'complete' | 'loop', frame }
    this.frame = 0; // frames rendered since start()
    this.loopPasses = 0;
    this.maxLoopPasses = Infinity;
  }

  get active() {
    return this.playing || this.voices.length > 0;
  }

  start(song) {
    // voices of the previous sound: keep natural tails, cut anything still held
    this.silence(this.ended ? null : 0.012);
    this.song = song;
    this.channels = [];
    for (let i = 0; i < 16; i++) this.channels.push(new Channel());
    this.channels[9].percussion = true;
    this.masterVolume = 100;
    this.masterGain = sq(100 / 127);
    this.secPerTick = DEFAULT_SEC_PER_TICK;
    this.index = 0;
    this.slots = [null, null, null, null];
    this.loopPasses = 0;
    this.frame = 0;
    this.ended = false;
    this.playing = !!song && song.events.length > 0;
    this.wait = this.playing ? song.events[0].t * this.secPerTick * this.sampleRate : 0;
  }

  /** Stop the sequence. Voices fade out over `fade` seconds (null: leave them to ring out). */
  stop(fade = 0.012) {
    this.playing = false;
    this.silence(fade);
  }

  silence(fade) {
    for (const v of this.voices) {
      if (fade === null) {
        if (!v.released) v.release();
      } else v.kill(this.sampleRate, fade);
    }
  }

  alloc(kind) {
    return this.pool[kind].pop()
      ?? (kind === 0 ? new FmVoice() : kind === 1 ? new DrumVoice() : kind === 2 ? new PcmVoice() : new SfVoice());
  }

  addVoice(v) {
    if (this.voices.length >= MAX_VOICES) {
      // steal: prefer the oldest released voice, else the oldest
      let best = 0, bestScore = -1;
      for (let i = 0; i < this.voices.length; i++) {
        const o = this.voices[i];
        const score = o.age + (o.released ? 1e12 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      const dead = this.voices[best];
      this.voices[best] = this.voices[this.voices.length - 1];
      this.voices.pop();
      this.pool[dead.kind].push(dead);
    }
    this.voices.push(v);
  }

  dispatch(e) {
    const sr = this.sampleRate;
    switch (e.op) {
      case OP.NOTE: {
        if (this.solo && !this.solo.has(e.ch)) break;
        const ch = this.channels[e.ch];
        const gate = Math.max(1, e.gate * this.secPerTick * sr);
        // the native scheduler refreshes the gate of a key that is still held instead of
        // striking it again
        let held = false;
        for (const v of this.voices) {
          // (a sampled note can be several voices; sampled percussion is never "held")
          if (v.ch === ch && v.key === e.key && !v.released && v.kind !== 2 && !v.percussion) {
            v.gate = gate;
            held = true;
          }
        }
        if (held) break;
        if (e.vel === 0) break;
        const percussion = e.perc || ch.percussion;
        const sf = this.soundfont;
        const zones = sf ? (percussion ? sf.drums[e.key] : sf.programs[ch.program]) : null;
        if (zones) {
          // sampled instruments: every zone covering the key sounds
          let played = false;
          for (const zone of zones) {
            if (e.key < zone.lo || e.key > zone.hi) continue;
            const v = this.alloc(3).init(this, ch, e.key, e.vel, gate, zone, sf, percussion);
            if (v.choke) {
              for (const o of this.voices) if (o.kind === 3 && o.choke === v.choke && o.ch === ch) o.kill(sr, 0.01);
            }
            this.addVoice(v);
            played = true;
          }
          if (played) break;
        }
        if (percussion) {
          const v = this.alloc(1).init(this, ch, e.key, e.vel, gate);
          if (v.choke) {
            for (const o of this.voices) if (o.kind === 1 && o.choke === v.choke && o.ch === ch) o.kill(sr, 0.01);
          }
          this.addVoice(v);
        } else this.addVoice(this.alloc(0).init(this, ch, e.key, e.vel, gate));
        break;
      }
      case OP.PROGRAM: {
        const ch = this.channels[e.ch];
        ch.percussion = e.perc;
        ch.program = e.value & 127;
        ch.patch = PROGRAM_PATCH[e.value & 127] ?? PATCH.piano;
        break;
      }
      case OP.VOLUME: this.channels[e.ch].volume = e.value; break;
      case OP.EXPRESSION: {
        const ch = this.channels[e.ch];
        ch.volume = clamp(ch.volume + e.value - 32, 0, 63);
        break;
      }
      case OP.PAN: this.channels[e.ch].pan = e.value; break;
      case OP.BEND: this.channels[e.ch].bend = e.value; break;
      case OP.MODULATION: this.channels[e.ch].modulation = e.value; break;
      case OP.TEMPO: this.secPerTick = e.value; break;
      case OP.MASTER:
        this.masterVolume = e.relative ? clamp(this.masterVolume + e.value, 0, 127) : e.value;
        this.masterGain = sq(this.masterVolume / 127);
        break;
      case OP.AUDIO_VOLUME: this.channels[e.ch & 15].audioVolume = e.value; break;
      case OP.AUDIO_PAN: this.channels[e.ch & 15].audioPan = e.value; break;
      case OP.AUDIO_PLAY: {
        if (this.solo && !this.solo.has(e.ch)) break;
        const sample = this.song.samples[e.sample];
        if (sample && sample.pcm.length > 1) this.addVoice(this.alloc(2).init(this, this.channels[e.ch & 15], e.sample, sample, e.vel));
        break;
      }
      case OP.AUDIO_STOP: {
        const ch = this.channels[e.ch & 15];
        for (const v of this.voices) if (v.kind === 2 && v.ch === ch && v.sample === e.sample) v.kill(sr);
        break;
      }
      default: break;
    }
  }

  /** Process the event at this.index; returns false when the sequence is over. */
  step() {
    const events = this.song.events;
    const e = events[this.index];
    let next = this.index + 1;
    let fromTick = e.t;
    if (e.op === OP.LOOP_START) {
      this.slots[e.id] = { index: this.index + 1, tick: e.t, remaining: -1 };
    } else if (e.op === OP.LOOP_END) {
      const slot = this.slots[e.id];
      if (slot) {
        const forever = e.count === 0;
        if (slot.tick === e.t) {
          // native rule: a zero-length loop ends every track
          this.finish();
          return false;
        }
        let jump = false;
        if (forever) jump = this.fileLoops && this.loopPasses + 1 < this.maxLoopPasses;
        else {
          if (slot.remaining < 0) slot.remaining = e.count;
          if (slot.remaining > 0) {
            slot.remaining--;
            jump = true;
          } else slot.remaining = -1;
        }
        if (jump) {
          next = slot.index;
          fromTick = slot.tick;
          if (forever) {
            this.loopPasses++;
            this.notifications.push({ type: 'loop', frame: this.frame });
          }
        }
      }
    } else if (e.op === OP.END) {
      this.finish();
      return false;
    } else this.dispatch(e);
    if (next >= events.length) {
      this.finish();
      return false;
    }
    this.index = next;
    this.wait += (events[next].t - fromTick) * this.secPerTick * this.sampleRate;
    return true;
  }

  finish() {
    this.playing = false;
    this.ended = true;
    // held notes are released, everything rings out naturally
    for (const v of this.voices) if (!v.released && v.kind !== 2) v.release();
    this.notifications.push({ type: 'complete', frame: this.frame });
  }

  /** Mix `frames` frames into L/R starting at `start` (adds to what is there). */
  render(L, R, start, frames) {
    let pos = start, left = frames, guard = 0;
    const voices = this.voices;
    while (left > 0) {
      let n = left < CHUNK ? left : CHUNK;
      if (this.playing) {
        while (this.playing && this.wait < 1) {
          if (++guard > 20000) {
            this.finish();
            break;
          }
          if (!this.step()) break;
        }
        if (this.playing && this.wait < n) n = Math.max(1, Math.floor(this.wait));
      }
      for (let i = 0; i < voices.length; i++) {
        const v = voices[i];
        if (v.gate <= 0.5) v.release();
        else if (v.gate < n) n = Math.max(1, Math.ceil(v.gate));
      }
      for (let i = voices.length - 1; i >= 0; i--) {
        const v = voices[i];
        const alive = v.render(L, R, pos, n);
        v.gate -= n;
        if (!alive) {
          voices[i] = voices[voices.length - 1];
          voices.pop();
          this.pool[v.kind].push(v);
        }
      }
      if (this.playing) this.wait -= n;
      this.frame += n;
      pos += n;
      left -= n;
    }
  }
}

// ---- mixer ------------------------------------------------------------------------------------

/**
 * N ports, each an MfiPlayer with its own volume, summed through a master gain and a limiter.
 * Driven by plain messages so that it can live in an AudioWorklet or on the main thread:
 *   { type: 'load', key, song }                      cache a compiled song
 *   { type: 'play', port, key, gen, volume }         start it (gen is echoed back in events)
 *   { type: 'stop', port }                           stop, short fade
 *   { type: 'volume', port, value }                  port volume 0..1 (already perceptual)
 *   { type: 'master', value }                        master gain 0..1
 *   { type: 'options', fileLoops, sampled }          honour "forever" loop points; use the
 *                                                    sampled instrument set when one is loaded
 *   { type: 'soundfont', programs, drums, samples, pcm }   the sampled instrument set (see
 *                                                    tools/soundfont/extract.mjs; pcm: Int16Array)
 * render() returns the events that happened: { type: 'complete' | 'loop', port, gen }.
 */
const NO_EVENTS = Object.freeze([]);

export class MfiMixer {
  constructor(sampleRate, portCount = 4, options = {}) {
    this.sampleRate = sampleRate;
    this.options = { fileLoops: options.fileLoops !== false, sampled: options.sampled !== false };
    this.soundfont = null;
    this.ports = [];
    for (let i = 0; i < portCount; i++) this.ports.push(this.newPort());
    this.songs = new Map();
    this.master = 1;
    this.masterNow = 1;
    this.limiter = 1;
    this.limitRelease = Math.exp(-1 / (0.12 * sampleRate));
    this.ceiling = 0.92;
    this.bufL = new Float32Array(0);
    this.bufR = new Float32Array(0);
    this.peak = 0;
    this.events = [];
  }

  newPort() {
    const player = new MfiPlayer(this.sampleRate, this.options);
    player.soundfont = this.options.sampled ? this.soundfont ?? null : null;
    return { player, gen: 0, volume: 1, volumeNow: 1 };
  }

  /** Notes started from now on use the sampled set, or the FM patches (sounding notes ring out). */
  #applySoundfont() {
    for (const p of this.ports) p.player.soundfont = this.options.sampled ? this.soundfont : null;
  }

  port(index) {
    while (this.ports.length <= index) this.ports.push(this.newPort());
    return this.ports[index];
  }

  handle(msg) {
    switch (msg.type) {
      case 'load': this.songs.set(msg.key, msg.song); break;
      case 'play': {
        const p = this.port(msg.port);
        const song = msg.song ?? this.songs.get(msg.key);
        p.gen = msg.gen;
        if (msg.volume !== undefined) {
          p.volume = msg.volume;
          if (!p.player.active) p.volumeNow = msg.volume;
        }
        p.player.fileLoops = this.options.fileLoops;
        if (song) p.player.start(song);
        else p.player.stop();
        break;
      }
      case 'stop': {
        const p = this.port(msg.port);
        // after a natural end the tail keeps ringing; a sequence that is still running is cut
        if (p.player.playing) p.player.stop();
        if (msg.gen !== undefined) p.gen = msg.gen;
        break;
      }
      case 'volume': this.port(msg.port).volume = msg.value; break;
      case 'master': this.master = msg.value; break;
      case 'options':
        if (msg.fileLoops !== undefined) this.options.fileLoops = !!msg.fileLoops;
        if (msg.sampled !== undefined) this.options.sampled = !!msg.sampled;
        this.#applySoundfont();
        break;
      case 'soundfont':
        this.soundfont = { programs: msg.programs, drums: msg.drums, samples: msg.samples, pcm: msg.pcm };
        this.#applySoundfont();
        break;
      default: break;
    }
  }

  /** Fill outL/outR (overwrites). Returns the list of events since the last call. */
  render(outL, outR, frames = outL.length) {
    if (this.bufL.length < frames) {
      this.bufL = new Float32Array(frames);
      this.bufR = new Float32Array(frames);
    }
    const bl = this.bufL, br = this.bufR;
    outL.fill(0, 0, frames);
    if (outR !== outL) outR.fill(0, 0, frames);
    for (let pi = 0; pi < this.ports.length; pi++) {
      const p = this.ports[pi];
      const player = p.player;
      if (!player.active) {
        p.volumeNow = p.volume;
        continue;
      }
      bl.fill(0, 0, frames);
      br.fill(0, 0, frames);
      player.render(bl, br, 0, frames);
      let g = p.volumeNow;
      const dg = (p.volume - g) / frames;
      for (let i = 0; i < frames; i++) {
        g += dg;
        outL[i] += bl[i] * g;
        outR[i] += br[i] * g;
      }
      p.volumeNow = p.volume;
      if (player.notifications.length) {
        for (const n of player.notifications) this.events.push({ type: n.type, port: pi, gen: p.gen });
        player.notifications.length = 0;
      }
    }
    // master gain + limiter (instant attack, slow release: rides the gain, never clips)
    let m = this.masterNow, lim = this.limiter, peak = this.peak;
    const dm = (this.master - m) / frames;
    const ceiling = this.ceiling, rel = this.limitRelease;
    for (let i = 0; i < frames; i++) {
      m += dm;
      const l = outL[i] * m, r = outR[i] * m;
      const a = Math.max(Math.abs(l), Math.abs(r));
      lim = 1 - (1 - lim) * rel;
      if (a * lim > ceiling) lim = ceiling / a;
      outL[i] = l * lim;
      outR[i] = r * lim;
      if (a * lim > peak) peak = a * lim;
    }
    this.masterNow = this.master;
    this.limiter = lim;
    this.peak = peak;
    if (!this.events.length) return NO_EVENTS;
    const events = this.events;
    this.events = [];
    return events;
  }

  /** Peak output level since the last call (for meters / tests). */
  takePeak() {
    const p = this.peak;
    this.peak = 0;
    return p;
  }
}

// ---- AudioWorklet glue ------------------------------------------------------------------------

export const WORKLET_NAME = 'mfi-mixer';

if (typeof AudioWorkletProcessor !== 'undefined' && typeof registerProcessor === 'function') {
  registerProcessor(WORKLET_NAME, class extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const o = options?.processorOptions ?? {};
      // eslint-disable-next-line no-undef
      this.mixer = new MfiMixer(sampleRate, o.ports ?? 4, o);
      this.meter = false;
      this.meterCount = 0;
      this.scratch = new Float32Array(128);
      this.port.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'meter') this.meter = !!msg.enable;
        else this.mixer.handle(msg);
      };
    }

    process(inputs, outputs) {
      const out = outputs[0];
      if (!out || !out.length) return true;
      const L = out[0];
      let R = out[1];
      if (!R) {
        if (this.scratch.length < L.length) this.scratch = new Float32Array(L.length);
        R = this.scratch;
      }
      const events = this.mixer.render(L, R, L.length);
      if (!out[1]) for (let i = 0; i < L.length; i++) L[i] = (L[i] + R[i]) * 0.5;
      if (events.length) {
        // only completions matter to the page; loop jumps stay here
        const done = events.filter((e) => e.type === 'complete');
        if (done.length) this.port.postMessage({ type: 'events', events: done });
      }
      if (this.meter && (this.meterCount += L.length) >= 4096) {
        this.meterCount = 0;
        this.port.postMessage({ type: 'meter', peak: this.mixer.takePeak() });
      }
      return true;
    }
  });
}
