#!/usr/bin/env node
// Lists the contents of an MFi (.mld) file: header, embedded samples, every event with its
// tick / time, and a summary.
//   node tools/mfi/dump.mjs <file.mld> [--summary] [--track N]
import { readFileSync } from 'node:fs';
import { parseMFi, isInfiniteLoop } from '../../web/src/formats/mfi.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node tools/mfi/dump.mjs <file.mld> [--summary] [--track N]');
  process.exit(2);
}
const summaryOnly = args.includes('--summary');
const onlyTrack = args.includes('--track') ? Number(args[args.indexOf('--track') + 1]) : null;

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (m) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
const hex = (bytes) => [...bytes].map((v) => v.toString(16).padStart(2, '0')).join(' ');

const mfi = parseMFi(readFileSync(file));
const h = mfi.header;
console.log(`${file}`);
console.log(`  MFi version ${h.version}  type ${h.majorType}.${h.minorType}  tracks ${h.trackCount}  note mode ${h.noteMode}  exst ${h.exst}`);
console.log(`  title ${JSON.stringify(h.title)}  date ${h.date}  tool ${JSON.stringify(h.support)}  source ${h.source}${h.protected ? ' (protected)' : ''}`);
console.log(`  header chunks: ${h.chunks.map((c) => `${c.id}[${c.length}]`).join(' ')}`);
for (const s of mfi.samples) {
  let peak = 0;
  for (const v of s.pcm) peak = Math.max(peak, Math.abs(v));
  console.log(`  adat ${s.index}: format 0x${s.format.toString(16)} attr 0x${s.attribute.toString(16)}` +
    `${s.followsPitch ? ' +pitch' : ''}${s.followsTempo ? ' +tempo' : ''}  ${s.sampleRate} Hz ${s.bits}-bit ch ${s.channels}` +
    `  ${s.data.length} bytes -> ${s.pcm.length} samples (${s.duration.toFixed(3)} s)  packing ${s.bitOrder}  peak ${peak.toFixed(3)}`);
}

function describe(e) {
  switch (e.type) {
    case 'note': return `note   ch${e.channel}${e.percussion ? ' drum' : ''} ${noteName(e.midi).padEnd(4)} (midi ${e.midi}, key ${e.key}${e.octaveShift ? ` oct ${e.octaveShift > 0 ? '+' : ''}${e.octaveShift}` : ''}) vel ${e.velocity} gate ${e.gate} (${e.duration.toFixed(3)} s)${e.tied ? ' [tie: extends the sounding note]' : e.heldTicks > e.gate ? ` [held ${e.heldTicks} ticks with ties]` : ''}`;
    case 'audioPlay': return `audio play   ch${e.channel} sample ${e.sample} vel ${e.velocity}`;
    case 'audioStop': return `audio stop   ch${e.channel} sample ${e.sample}`;
    case 'audioVolume': return `audio volume ch${e.channel} ${e.value}`;
    case 'audioPan': return `audio pan    ch${e.channel} ${e.value}`;
    case 'tempo': return `tempo  ${e.bpm} bpm, timebase ${e.timebase}`;
    case 'masterVolume': return `master volume ${e.value}`;
    case 'channelConfig': return `channel config ch${e.channel} mode ${e.mode}${e.percussion ? ' (percussion)' : ''}`;
    case 'cue': return `cue ${e.point}`;
    case 'loop': return `loop ${e.point} id ${e.id} count ${e.count}${e.count === 0 ? ' (forever)' : ''}`;
    case 'nop': return e.wide ? `nop (16-bit delta ${e.delta})` : 'nop';
    case 'end': return 'end of track';
    case 'bank': return `bank   ch${e.channel} set ${e.bank} high ${e.high}`;
    case 'program': return `program ch${e.channel} ${e.program}${e.percussion ? ' (drum kit)' : ''} bank ${e.bank}`;
    case 'volume': return `volume ch${e.channel} ${e.value}`;
    case 'pan': return `pan    ch${e.channel} ${e.value}`;
    case 'pitchBend': return `bend   ch${e.channel} coarse ${e.value} -> ${e.bend} (${e.semitones.toFixed(3)} st)`;
    case 'pitchBendFine': return `bend   ch${e.channel} fine ${e.value}${e.standalone ? ' (standalone)' : ''} -> ${e.bend}`;
    case 'pitchBendRange': return `bend range ch${e.channel} ${e.value}`;
    case 'channelAssign': return `assign voice ${e.voice} -> ch${e.to}`;
    case 'expression': return `expression ch${e.channel} ${e.value}`;
    case 'modulation': return `modulation ch${e.channel} ${e.value}`;
    case 'ext': return `ext 0x${e.ext.toString(16)} [${hex(e.data)}]`;
    default: return `UNKNOWN status 0x${e.status.toString(16)} ext 0x${e.ext.toString(16)} [${hex(e.data)}]`;
  }
}

if (!summaryOnly) {
  for (const t of mfi.tracks) {
    if (onlyTrack !== null && t.index !== onlyTrack) continue;
    console.log(`\ntrack ${t.index}: ${t.length} bytes at 0x${t.offset.toString(16)}, ${t.events.length} events, ends at tick ${t.endTick} (${t.endTime.toFixed(3)} s)`);
    for (const e of t.events) {
      console.log(`  ${String(e.tick).padStart(6)} ${e.time.toFixed(3).padStart(8)}s  ${describe(e)}`);
    }
  }
}

console.log('\nsummary');
console.log(`  duration ${mfi.duration.toFixed(3)} s (${mfi.endTick} ticks), ${mfi.stats.notes} notes (${mfi.stats.ties} tied), ${mfi.stats.audioPlays} audio plays, ${mfi.samples.length} samples`);
console.log(`  tempo: ${mfi.tempoMap.map((t) => `${t.bpm} bpm/tb ${t.timebase} @${t.tick}`).join(', ')}`);
console.log(`  channels ${mfi.stats.channels.join(',') || '-'}  programs ${mfi.stats.programs.join(',') || '-'}`);
console.log(`  loop: ${mfi.loop ? `ticks ${mfi.loop.startTick}-${mfi.loop.endTick} (${mfi.loop.startTime.toFixed(3)}-${mfi.loop.endTime.toFixed(3)} s) ${isInfiniteLoop(mfi.loop) ? 'forever' : `x${mfi.loop.count}`}` : 'none'}`);
console.log(`  cue: ${mfi.cue.startTick ?? '-'} .. ${mfi.cue.endTick ?? '-'}`);
console.log(`  unknown events ${mfi.stats.unknownEvents}, unparsed bytes ${mfi.unparsed}`);
for (const w of mfi.warnings) console.log(`  warning: ${w}`);
