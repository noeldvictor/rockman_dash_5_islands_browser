#!/usr/bin/env node
// Writes a game tune (.mld, MFi) as an ABC score in the dialect the YuE 2 music model reads:
// two voices, "Vocal" (here only rests, carrying the chord symbols) and "Ins" (the lead melody),
// L:1/32, four bars to a line.
//
//   node tools/ai/mfi_abc.mjs <file.mld> [--passes 2] [--section intro]
//
// The lead is the monophonic, mid-to-high channel that sounds for the largest part of the tune;
// chords are the best-fitting major or minor triad of everything sounding in each bar, with the
// bass line's notes counted double. The file's whole length is one loop, written `passes` times.
import { readFileSync } from 'node:fs';
import { parseMFi } from '../../web/src/formats/mfi.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const option = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const passes = Number(option('passes', 2));
const section = option('section', 'intro');

const mfi = parseMFi(new Uint8Array(readFileSync(file)));
const tempo = mfi.events.find((e) => e.type === 'tempo');
const PER_BEAT = tempo?.timebase ?? 48;
const UNIT = PER_BEAT / 8; // ticks per 1/32 note
const BAR = 32; // units per 4/4 bar
const loopEnd = mfi.events.find((e) => e.type === 'loop' && e.point === 'end');
const notes = mfi.events.filter((e) => e.type === 'note' && !e.percussion && e.velocity > 0 && e.channel < 16);
const totalTicks = loopEnd ? loopEnd.tick : Math.max(...notes.map((e) => e.tick + e.heldTicks));
const bars = Math.round(totalTicks / (UNIT * BAR));

// ---- key (Krumhansl-Schmuckler) ----
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const histogram = new Array(12).fill(0);
for (const e of notes) histogram[e.midi % 12] += e.heldTicks;
const correlate = (h, profile, shift) => {
  const b = profile.map((_, i) => profile[(i - shift + 12) % 12]);
  const ma = h.reduce((x, y) => x + y) / 12, mb = b.reduce((x, y) => x + y) / 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { num += (h[i] - ma) * (b[i] - mb); da += (h[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / (Math.sqrt(da * db) || 1);
};
let key = { r: -2, tonic: 0, minor: false };
for (let k = 0; k < 12; k++) {
  for (const minor of [false, true]) {
    const r = correlate(histogram, minor ? MINOR : MAJOR, k);
    if (r > key.r) key = { r, tonic: k, minor };
  }
}
// spelling: keys with flats in their signature use flat names
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const relativeMajor = key.minor ? (key.tonic + 3) % 12 : key.tonic;
const useFlats = [5, 10, 3, 8, 1, 6].includes(relativeMajor); // F Bb Eb Ab Db Gb
const NAMES = useFlats ? FLAT : SHARP;
// the signature's accidental for each letter (0 natural, 1 sharp, -1 flat)
const SIGNATURE_ORDER = useFlats ? ['B', 'E', 'A', 'D', 'G', 'C', 'F'] : ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const COUNT = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 5: 1, 10: 2, 3: 3, 8: 4, 1: 5 }[relativeMajor];
const signature = Object.fromEntries('CDEFGAB'.split('').map((l) => [l, 0]));
for (let i = 0; i < COUNT; i++) signature[SIGNATURE_ORDER[i]] = useFlats ? -1 : 1;

// ---- lead melody ----
const channels = new Map();
for (const e of notes) {
  let c = channels.get(e.channel);
  if (!c) channels.set(e.channel, (c = { channel: e.channel, notes: [], held: 0, pitch: 0, covered: new Uint8Array(Math.ceil(totalTicks) + 1) }));
  c.notes.push(e);
  c.held += e.heldTicks;
  c.pitch += e.midi;
  c.covered.fill(1, Math.min(totalTicks, e.tick), Math.min(totalTicks, e.tick + e.heldTicks));
}
const stats = [...channels.values()].map((c) => {
  const covered = c.covered.reduce((a, b) => a + b, 0);
  return { ...c, pitch: c.pitch / c.notes.length, length: c.held / c.notes.length, polyphony: c.held / Math.max(1, covered), coverage: covered / totalTicks };
});
const candidates = stats.filter((c) => c.pitch >= 58 && c.polyphony <= 1.3 && c.length < PER_BEAT * 2.5);
const lead = (candidates.length ? candidates : stats).sort((a, b) => b.coverage - a.coverage || b.pitch - a.pitch)[0];
const bass = [...stats].sort((a, b) => a.pitch - b.pitch)[0];

// monophonic line, [start, length, midi] in 1/32 units: onsets on the 1/16 grid, a later note
// cuts an earlier one, and gaps of up to an eighth note are closed (the game plays its notes
// short; written out literally that is a clutter of tiny rests no score would have)
const GRID = 2;
const CLOSE = 4;
const line = [];
for (const e of [...lead.notes].sort((a, b) => a.tick - b.tick || b.midi - a.midi)) {
  const start = Math.round(e.tick / UNIT / GRID) * GRID;
  const length = Math.max(GRID, Math.round(e.heldTicks / UNIT / GRID) * GRID);
  const last = line[line.length - 1];
  if (last && start <= last[0]) continue; // same instant: the higher note was kept
  if (last && (last[0] + last[1] > start || start - (last[0] + last[1]) <= CLOSE)) last[1] = start - last[0];
  if (start < bars * BAR) line.push([start, Math.min(length, bars * BAR - start), e.midi]);
}

// ---- chords, one per bar ----
const chords = [];
for (let b = 0; b < bars; b++) {
  const from = b * BAR * UNIT, to = from + BAR * UNIT;
  const h = new Array(12).fill(0);
  for (const e of notes) {
    const overlap = Math.min(to, e.tick + e.heldTicks) - Math.max(from, e.tick);
    if (overlap > 0) h[e.midi % 12] += overlap * (e.channel === bass.channel ? 2 : 1);
  }
  let best = { score: -1, name: NAMES[key.tonic] + (key.minor ? 'm' : '') };
  for (let root = 0; root < 12; root++) {
    for (const minor of [false, true]) {
      const third = (root + (minor ? 3 : 4)) % 12, fifth = (root + 7) % 12;
      const score = h[root] * 1.3 + h[third] + h[fifth] * 0.9 - 0.4 * h.reduce((a, v, i) => a + ([root, third, fifth].includes(i) ? 0 : v), 0);
      if (score > best.score) best = { score, name: NAMES[root] + (minor ? 'm' : '') };
    }
  }
  chords.push(best.name);
}

// ---- writing ----
const LETTER = useFlats
  ? [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]]
  : [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
function pitch(midi, state) {
  const [letter, accidental] = LETTER[midi % 12];
  const octave = Math.floor(midi / 12) - 1; // MIDI 60 = C4
  const id = letter + octave;
  const current = state.has(id) ? state.get(id) : signature[letter];
  let prefix = '';
  if (current !== accidental) {
    prefix = accidental === 1 ? '^' : accidental === -1 ? '_' : '=';
    state.set(id, accidental);
  }
  const name = octave >= 5 ? letter.toLowerCase() + "'".repeat(octave - 5) : letter + ','.repeat(4 - octave);
  return prefix + name;
}
const length = (n) => (n === 1 ? '' : String(n));

const melodyBars = [];
let i = 0;
for (let b = 0; b < bars; b++) {
  const from = b * BAR, to = from + BAR;
  const state = new Map(); // accidentals last until the bar line
  let out = '', at = from;
  // a note held over from the previous bar
  const pieces = line.filter(([s, l]) => s < to && s + l > from);
  for (const [s, l, midi] of pieces) {
    const start = Math.max(s, from), end = Math.min(s + l, to);
    if (start > at) out += `z${length(start - at)}`;
    out += pitch(midi, state) + length(end - start) + (s + l > to ? '-' : '');
    at = end;
  }
  if (at < to) out += at === from ? 'Z' : `z${length(to - at)}`;
  melodyBars.push(out);
  i++;
}

const head = [
  'X:1', 'T:', 'M:4/4', 'L:1/32', `Q:1/4=${tempo?.bpm ?? 125}`,
  'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"',
  'V: Ins clef=treble name="Ins Melody" snm="Inst."',
  `K:${NAMES[key.tonic]}${key.minor ? 'm' : ''}`,
];
const body = [`% ${section}`];
for (let p = 0; p < passes; p++) {
  for (let b = 0; b < bars; b += 4) {
    const group = [...Array(Math.min(4, bars - b)).keys()].map((k) => b + k);
    body.push('V: Vocal', group.map((k) => `"${chords[k]}"z${BAR}`).join('|') + '|');
    body.push('V: Ins', group.map((k) => melodyBars[k]).join('|') + '|');
  }
}
if (args.includes('--info')) {
  // General MIDI programs the tune's channels play, most-used first, and whether it has drums
  const programs = new Map();
  const program = new Map();
  for (const e of mfi.events) {
    if (e.type === 'program' && !e.percussion) program.set(e.channel, e.gm & 127);
    if (e.type === 'note' && !e.percussion && e.velocity > 0) {
      const g = program.get(e.channel) ?? 0;
      programs.set(g, (programs.get(g) ?? 0) + e.heldTicks);
    }
  }
  const drums = mfi.events.some((e) => e.type === 'note' && e.percussion);
  console.error(JSON.stringify({ bars, bpm: tempo?.bpm, key: head[7].slice(2),
    programs: [...programs].sort((a, b) => b[1] - a[1]).map(([g]) => g), drums, lead: { channel: lead.channel, notes: lead.notes.length, coverage: +lead.coverage.toFixed(2), pitch: +lead.pitch.toFixed(1) }, chords }));
}
console.log([...head, ...body].join('\n'));
