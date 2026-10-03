// MFi ("Melody Format for i-mode", .mld) parser — the music / sound-effect format of NTT DoCoMo
// phones. Dependency-free; used by the browser host (web/src/host/audio*) and by tools/mfi/*.
//
// There is no public specification. Everything below is marked with where it comes from:
//   [T]  TiMidity++ timidity/mfi.c (Kentaro Sato; GPL — read for the format facts, no code ported)
//   [L]  logue/smfplayer.js src/mld.js (imaya / GREE, Masashi Yoshikawa; MIT — facts only)
//   [V]  umjammer/vavi-sound, vavi.sound.mfi.* and vavi.sound.mobile.Fuetrek* (Naohide Sano; no
//        licence file in the repository — read for the format facts, no code ported)
//   [K]  Koizumi Project "MLDファイル" notes, https://koizumipro.my.coocan.jp/mldform.htm
//   [G]  ITU-T G.726 as implemented by the public-domain Sun Microsystems g72x.c / g721.c /
//        g723_16.c reference ("unrestricted use" licence); the decoder below is a re-implementation
//        of that algorithm with its tables
//   [M]  Magstic/MLD_Player docs/mld_*_spec.md (MIT): a specification reverse-engineered from
//        DoCoMo's DoJa SDK sound library (MFiSoundLib / MFiPluginMFi5 / MFiAudio). Its authors
//        warn that it was compiled with AI assistance; where it matters here it agrees with the
//        other sources or with the sample files. Facts only, no code ported.
//   [S]  inferred from / checked against the 31 sample files of this game (all written by
//        "MFi5PlugIn_DoCoMo 01.00.02", version "0500")
//
// ---- Container (all integers big-endian) ---------------------------------------------------
//   "melo"  u32 fileLength (= file size - 8)                                           [T][L][K]
//   u16 headerLength   bytes from here+2 up to the first chunk after the header        [T][L][K]
//   u8 majorType (1 = melody), u8 minorType (1 = whole tune), u8 trackCount            [T][K]
//   header sub-chunks until 10 + headerLength:  4-char id, u16 length, data            [T][L][K]
//     vers "0500"     format version text                                              [T][K]
//     note u16        1 = note events have a 4th byte (velocity / octave shift)        [T][K]
//     exst u16        extra length of "extended status A" messages (see below)         [V]
//     sorc u8         bit 0 = copy-protected, bits 1.. = source (0 net, 1 input, 2 ext)[T]
//     titl/copy/prot/auth/date/supt   text (supt = authoring tool)                     [T][K][V]
//     ainf u8 (low 6 bits = number of "adat" chunks that follow the header), u8 ?    [V][M][S]
//     thrd, code, ...  kept as raw bytes
//   "adat" u32 length  (ainf.count of them, MFi4+): embedded wave data                 [V][S]
//       u16 infoLength; u8 format (0x81 = "ADPCM type 2"); u8 attribute (bit 0 follows pitch
//       changes, bit 1 follows tempo changes, bit 2 3D); sub-chunks as in the header, here
//       "adpm" = u8 sample rate in kHz, u8 bits per sample (2 or 4), u8 channels (low 3 bits,
//       bit 3 = interleaved); then the ADPCM bytes up to the end of the chunk.
//       Format 0x81 is ITU-T G.726 at 16 kbit/s (2-bit) or 32 kbit/s (4-bit), code words packed
//       from the low bits of each byte upwards [V][M]; stereo = left stream then right stream.
//       [S]: the tails of the samples here are silence only as G.726 (trailing 0xff bytes in
//       4-bit data, codes 00/11 in 2-bit data), and the play time (bytes*8/bits/rate) matches
//       the tick distance to the next event in every file. Low-bits-first packing is supported
//       by the data too: decoded that way all ten 4-bit streams peak just below full scale and
//       never saturate, the other way seven of them overflow. (decodeG726() with the rounding
//       term of FMULT removed is bit-identical to libsndfile's G.721 decoder on these streams;
//       libsndfile drops that term on purpose, the ITU text and the phone [M] keep it.)
//   "trac" u32 length  x trackCount: event stream                                       [T][L][K]
//
// ---- Track events ----------------------------------------------------------------------------
//   u8 delta (ticks since the previous event of this track), u8 status, ...
//   status low 6 bits != 0x3f : NOTE.  voice = status >> 6, key = status & 0x3f,       [T][L][K]
//       u8 gate time in ticks, and when note == 1: u8 = velocity << 2 | octaveShift
//       (shift 0, 1 = +1, 2 = -2, 3 = -1 octaves).  MIDI note = key + 45 + 12*shift     [T][L]
//       ([K] says key 0x1b is "middle C", which is the same thing with C5 = 72);
//       on a percussion channel it is key + 35 + 12*shift (GM drum map)              [L][V][M][S]
//       channel = track * 4 + voice (16 channels); channel 9 is percussion by default   [T][V]
//       A note for a (channel, key) whose gate has not expired yet does not strike again: it
//       only moves the end of the sounding note ("gate refresh"); a gate that expires on the
//       tick of the new note expires first                                              [T][M]
//   status 0xff ("normal"), 0x3f / 0x7f / 0xbf ("class A/B/C") : u8 ext, then           [V]
//       ext 0x00-0x7f : 1 + exst data bytes        ("extended status A")
//       ext 0x80-0xef : 1 data byte                ("extended status B")
//       ext 0xf0-0xff : u16 length + data          ("extended information")
//     0xff messages (x = data byte; "part" = x >> 6 = voice, value = x & 0x3f):
//       b0 master volume 0-127 (default 100 [M])                                      [T][L][K]
//       ba channel configuration: channel = (x >> 3) & 15, low 3 bits 1 = percussion   [T][K][V]
//       b1 master balance, bc relative tempo (x - 64), bd relative master volume (x - 64),
//          be all notes off, bf reset — parsed, none occurs in this game's files          [M]
//       c0-cf tempo: timebase = (6 or, if bit 3, 15) << (ext & 7) ticks per quarter,   [T][L][K]
//             x = quarter notes per minute (at least 20 [M]).  One tick = 60 / (bpm * timebase)
//             seconds.  Before the first tempo event: 125 bpm, timebase 48               [M]
//       d0 cue point (0 = start, 1 = end of the ringtone excerpt; no effect on playback)[T][L]
//       dc "NOP2": 16-bit delta, x is the high byte ([V]: of this event's delta, [M]: of the
//          next event's — the same thing for everything that follows)                  [V][M][S]
//       dd loop point: id = x >> 6 (4 slots), x & 3: 0 start, 1 end; on the end event      [L][V]
//          count = (x >> 2) & 15: 0 = forever, n = n more passes. Only track 0's loop points
//          count; a jump rewinds every track to where it was just after the start event; a loop
//          whose end is on the tick of its start ends the whole sequence                  [M]
//          [S]: the files with a "forever" loop are exactly the ones the game itself registers
//          as looping sounds (all BGM, se01/04/06/09/11/16; se15 is never played).
//       de NOP, df end of track                                                        [T][L][K]
//       e0 program, low 6 bits; e1 bank: bit 0 = program bit 6, bits 1-5 = sound set    [T][K]
//          (1 = General MIDI). Bank values 0 and 1 select the six MFi1 basic voices instead
//          (program 0-5 = GM 0, 9, 16, 24, 13, 74)                                        [M]
//       e2 channel volume, e3 pan (32 = centre)                                        [T][L][K]
//       e4 pitch bend, coarse half (32 = rest); e8 / e9 fine half (32 = rest):         [T][V]
//          14-bit bend = ((coarse * 32 + fine) * 8) - 256, 8192 = centre
//          e9 is only stored; e4 and e8 apply the bend                                    [M]
//       e5 map voice to channel, e6 relative channel volume (x - 32) ([T] reads it as an
//       expression controller), e7 pitch bend range (semitones, default 2, max 24),
//       ea modulation depth                                                          [T][L][M]
//          (e5/e6/e7/e8/ea do not occur in this game's files — parsed, not exercised)
//       f0-ff extended information (voice edit, vendor exclusive) — kept raw
//     0x7f messages (MFi4+ audio):                                                      [V][S]
//       00 audio play: byte 0 = voice << 6 | adat index, byte 1 = velocity 0-63
//       01 audio stop: byte 0 = voice << 6 | adat index
//       80 audio channel volume, 81 audio channel pan (voice << 6 | value)
//
// ---- What parseMFi() returns -----------------------------------------------------------------
//   header   { fileLength, headerLength, majorType, minorType, trackCount, version, title, date,
//              support, copyright, source, protected, noteMode, exst, audioCount, chunks[] }
//   samples  [{ index, format, attribute, followsPitch, followsTempo, sampleRate, bits, channels,
//               interleaved, bitOrder, data: Uint8Array, pcm: Float32Array (mono, -1..1) }]
//   tracks   [{ index, offset, length, endTick, events[] }]   events in file order
//   events   every event of every track, sorted by tick (ties: track, then file order), each
//            { type, track, tick, time (seconds), offset, ... }.  Types: note, audioPlay,
//            audioStop, audioVolume, audioPan, tempo, masterVolume, channelConfig, cue, loop,
//            nop, end, bank, program, volume, pan, pitchBend, pitchBendFine, pitchBendRange,
//            channelAssign, expression, modulation, ext, unknown.
//            note: { voice, channel, key, octaveShift, midi, percussion, velocity (0-63), gate
//                    (ticks), duration (seconds), tied (true: only extends an earlier note),
//                    heldTicks / heldDuration (length including the notes tied to it) }
//            program: { channel, low, bankValue, program (0-127), gm (GM program to use) }
//   tempoMap [{ tick, time, bpm, timebase, secPerTick }]
//   loop     { id, count (0 = forever), track, startTick, endTick, startTime, endTime } | null
//            (track 0's forever loop if there is one), loops[] = all of them
//   cue      { startTick, endTick, startTime, endTime } (missing ends are null)
//   endTick, duration   the end of the longest track (ticks / seconds, one pass, no looping)
//   stats    { notes, ties, audioPlays, programs[], channels[], unknownEvents }
//   unparsed number of bytes not accounted for; warnings[]

const TEXT_CHUNKS = new Set(['vers', 'titl', 'copy', 'prot', 'auth', 'date', 'supt']);
const OCTAVE_SHIFT = [0, 1, -2, -1];
const BASIC_VOICE_GM = [0, 9, 16, 24, 13, 74]; // MFi1 basic voices (bank 0/1) as GM programs
export const MFI_PERCUSSION_CHANNEL = 9;
export const MFI_DEFAULT_TEMPO = { bpm: 125, timebase: 48 }; // [M]; every sample here sets one at tick 0

function fourcc(b, p) {
  return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
}
const u16 = (b, p) => (b[p] << 8) | b[p + 1];
const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;

function text(b, p, n) {
  // Titles in Japanese tools are Shift_JIS; the files here are ASCII.
  const raw = b.subarray(p, p + n);
  if (typeof TextDecoder !== 'undefined') {
    try {
      return new TextDecoder('shift_jis').decode(raw).replace(/\0+$/, '');
    } catch {
      /* fall through */
    }
  }
  let s = '';
  for (const c of raw) s += String.fromCharCode(c);
  return s.replace(/\0+$/, '');
}

function parseSubChunks(b, p, end, warnings, where) {
  const chunks = [];
  while (p + 6 <= end) {
    const id = fourcc(b, p);
    const length = u16(b, p + 4);
    if (p + 6 + length > end) {
      warnings.push(`${where}: sub-chunk ${id} overruns its container`);
      break;
    }
    chunks.push({ id, offset: p, length, data: b.subarray(p + 6, p + 6 + length) });
    p += 6 + length;
  }
  return { chunks, end: p };
}

// ---- G.726 (16 and 32 kbit/s) decoder [G] -----------------------------------------------------

const G726_DQLN = { 2: [116, 365, 365, 116], 4: [-2048, 4, 135, 213, 273, 323, 373, 425, 425, 373, 323, 273, 213, 135, 4, -2048] };
const G726_WI = { 2: [-704, 14048, 14048, -704], 4: [-12, 18, 41, 64, 112, 198, 355, 1122, 1122, 355, 198, 112, 64, 41, 18, -12].map((v) => v << 5) };
const G726_FI = { 2: [0, 0xe00, 0xe00, 0], 4: [0, 0, 0, 0x200, 0x200, 0x200, 0x600, 0xe00, 0xe00, 0x600, 0x200, 0x200, 0x200, 0, 0, 0] };

/** Number of powers of two (1 .. 0x4000) that are <= val, as g72x.c's quan(val, power2, 15). */
function quan(val) {
  let i = 0;
  while (i < 15 && val >= 1 << i) i++;
  return i;
}

function fmult(an, srn) {
  const anmag = an > 0 ? an : -an & 0x1fff;
  const anexp = quan(anmag) - 6;
  const anmant = anmag === 0 ? 32 : anexp >= 0 ? anmag >> anexp : anmag << -anexp;
  const wanexp = anexp + ((srn >> 6) & 0xf) - 13;
  const wanmant = (anmant * (srn & 0x3f) + 0x30) >> 4;
  const retval = wanexp >= 0 ? (wanmant << wanexp) & 0x7fff : wanmant >> -wanexp;
  return (an ^ srn) < 0 ? -retval : retval;
}

const s16 = (v) => (v << 16) >> 16;

/**
 * Decode G.726 code words (2 or 4 bits each) to 16-bit linear PCM.
 * @param {Uint8Array} data
 * @param {2|4} bits
 * @param {'lsb'|'msb'} bitOrder which end of each byte holds the first code word
 * @returns {Int16Array}
 */
export function decodeG726(data, bits, bitOrder = 'lsb') {
  if (bits !== 2 && bits !== 4) throw new Error(`G.726: unsupported code size ${bits}`);
  const dqlntab = G726_DQLN[bits], witab = G726_WI[bits], fitab = G726_FI[bits];
  const perByte = 8 / bits, mask = (1 << bits) - 1, signBit = 1 << (bits - 1);
  const out = new Int16Array(data.length * perByte);
  // predictor / quantiser state (g72x_init_state)
  let yl = 34816, yu = 544, dms = 0, dml = 0, ap = 0, td = 0;
  const a = [0, 0], pk = [0, 0], sr = [32, 32];
  const b = [0, 0, 0, 0, 0, 0], dqs = [32, 32, 32, 32, 32, 32];
  let o = 0;
  for (let n = 0; n < data.length; n++) {
    for (let k = 0; k < perByte; k++) {
      const shift = bitOrder === 'msb' ? 8 - bits * (k + 1) : bits * k;
      const code = (data[n] >> shift) & mask;

      let sezi = 0;
      for (let i = 0; i < 6; i++) sezi += fmult(b[i] >> 2, dqs[i]);
      sezi = s16(sezi);
      const sez = sezi >> 1;
      const sei = s16(sezi + fmult(a[1] >> 2, sr[1]) + fmult(a[0] >> 2, sr[0]));
      const se = sei >> 1;

      // step_size
      let y;
      if (ap >= 256) y = yu;
      else {
        y = yl >> 6;
        const dif = yu - y, al = ap >> 2;
        if (dif > 0) y += (dif * al) >> 6;
        else if (dif < 0) y += (dif * al + 0x3f) >> 6;
      }

      // reconstruct
      const sign = code & signBit;
      const dql = s16(dqlntab[code] + (y >> 2));
      let dq;
      if (dql < 0) dq = sign ? -0x8000 : 0;
      else {
        const dex = (dql >> 7) & 15;
        const dqt = 128 + (dql & 127);
        const mag = s16((dqt << 7) >> (14 - dex));
        dq = sign ? mag - 0x8000 : mag;
      }
      const srv = s16(dq < 0 ? se - (dq & 0x3fff) : se + dq);
      const dqsez = s16(srv - se + sez);

      // update
      const wi = witab[code], fi = fitab[code];
      const pk0 = dqsez < 0 ? 1 : 0;
      let mag = dq & 0x7fff;
      const ylint = yl >> 15;
      const ylfrac = (yl >> 10) & 0x1f;
      const thr1 = s16((32 + ylfrac) << ylint);
      const thr2 = ylint > 9 ? 31 << 10 : thr1;
      const dqthr = (thr2 + (thr2 >> 1)) >> 1;
      const tr = td === 0 ? 0 : mag <= dqthr ? 0 : 1;

      yu = y + ((wi - y) >> 5);
      if (yu < 544) yu = 544;
      else if (yu > 5120) yu = 5120;
      yl += yu + (-yl >> 6);

      let a2p = 0;
      if (tr === 1) {
        a[0] = a[1] = 0;
        b.fill(0);
      } else {
        const pks1 = pk0 ^ pk[0];
        a2p = a[1] - (a[1] >> 7);
        if (dqsez !== 0) {
          const fa1 = pks1 ? a[0] : -a[0];
          if (fa1 < -8191) a2p -= 0x100;
          else if (fa1 > 8191) a2p += 0xff;
          else a2p += fa1 >> 5;
          if (pk0 ^ pk[1]) {
            if (a2p <= -12160) a2p = -12288;
            else if (a2p >= 12416) a2p = 12288;
            else a2p -= 0x80;
          } else if (a2p <= -12416) a2p = -12288;
          else if (a2p >= 12160) a2p = 12288;
          else a2p += 0x80;
        }
        a[1] = a2p;
        a[0] -= a[0] >> 8;
        if (dqsez !== 0) a[0] += pks1 === 0 ? 192 : -192;
        const a1ul = 15360 - a2p;
        if (a[0] < -a1ul) a[0] = -a1ul;
        else if (a[0] > a1ul) a[0] = a1ul;
        for (let i = 0; i < 6; i++) {
          b[i] -= b[i] >> 8;
          if (dq & 0x7fff) b[i] += (dq ^ dqs[i]) >= 0 ? 128 : -128;
        }
      }

      for (let i = 5; i > 0; i--) dqs[i] = dqs[i - 1];
      if (mag === 0) dqs[0] = dq >= 0 ? 0x20 : s16(0xfc20);
      else {
        const exp = quan(mag);
        dqs[0] = s16(dq >= 0 ? (exp << 6) + ((mag << 6) >> exp) : (exp << 6) + ((mag << 6) >> exp) - 0x400);
      }
      sr[1] = sr[0];
      if (srv === 0) sr[0] = 0x20;
      else if (srv > 0) {
        const exp = quan(srv);
        sr[0] = (exp << 6) + ((srv << 6) >> exp);
      } else if (srv > -32768) {
        mag = -srv;
        const exp = quan(mag);
        sr[0] = s16((exp << 6) + ((mag << 6) >> exp) - 0x400);
      } else sr[0] = s16(0xfc20);

      pk[1] = pk[0];
      pk[0] = pk0;
      td = tr === 1 ? 0 : a2p < -11776 ? 1 : 0;

      dms += (fi - dms) >> 5;
      dml += ((fi << 2) - dml) >> 7;
      if (tr === 1) ap = 256;
      else if (y < 1536 || td === 1 || Math.abs((dms << 2) - dml) >= dml >> 3) ap += (0x200 - ap) >> 4;
      else ap += -ap >> 4;

      // sr has a 14-bit range
      const pcm = srv << 2;
      out[o++] = pcm > 32767 ? 32767 : pcm < -32768 ? -32768 : pcm;
    }
  }
  return out;
}

/** Mean |first difference| relative to RMS: low for a correctly decoded wave, ~1+ for noise. */
function roughness(pcm) {
  let energy = 0, diff = 0;
  for (let i = 0; i < pcm.length; i++) {
    energy += pcm[i] * pcm[i];
    if (i) diff += Math.abs(pcm[i] - pcm[i - 1]);
  }
  if (!energy) return Infinity;
  return diff / Math.max(1, pcm.length - 1) / Math.sqrt(energy / pcm.length);
}

/**
 * Decode the ADPCM payload of an "adat" chunk to mono Float32 (-1..1).
 * bitOrder: 'lsb' (default, what the phone does), 'msb', or 'auto' (decode both, keep the
 * smoother one — only a debugging aid, the score is unreliable for noisy effects).
 */
export function decodeMFiAdpcm(data, options = {}) {
  const { format = 0x81, bits = 4, channels = 1 } = options;
  const bitOrder = options.bitOrder ?? 'lsb';
  if (format !== 0x81) throw new Error(`MFi audio format 0x${format.toString(16)} is not supported`);
  let order = bitOrder, pcm16, scores = null;
  if (order === 'auto') {
    const lsb = decodeG726(data, bits, 'lsb');
    const msb = decodeG726(data, bits, 'msb');
    scores = { lsb: roughness(lsb), msb: roughness(msb) };
    order = scores.msb < scores.lsb ? 'msb' : 'lsb';
    pcm16 = order === 'msb' ? msb : lsb;
  } else pcm16 = decodeG726(data, bits, order);
  let pcm;
  if (channels === 2) {
    // [V]: type-2 stereo is stored as the whole left stream followed by the whole right stream,
    // each with its own predictor. Untested (no stereo sample here): re-decode per half, mix down.
    const half = data.length >> 1;
    const l = decodeG726(data.subarray(0, half), bits, order);
    const r = decodeG726(data.subarray(half, half * 2), bits, order);
    pcm = new Float32Array(l.length);
    for (let i = 0; i < l.length; i++) pcm[i] = (l[i] + r[i]) / 65536;
  } else {
    pcm = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) pcm[i] = pcm16[i] / 32768;
  }
  return { pcm, bitOrder: order, roughness: scores };
}

// ---- parser -----------------------------------------------------------------------------------

function parseAdat(b, p, length, index, warnings) {
  const end = p + 8 + length;
  const infoLength = u16(b, p + 8);
  const format = b[p + 10];
  const attribute = b[p + 11];
  const infoEnd = p + 10 + infoLength;
  const sub = parseSubChunks(b, p + 12, infoEnd, warnings, `adat ${index}`);
  let unparsed = infoEnd - sub.end;
  const sample = {
    index,
    offset: p,
    length,
    format,
    attribute,
    followsPitch: (attribute & 1) !== 0,
    followsTempo: (attribute & 2) !== 0,
    is3D: (attribute & 4) !== 0,
    sampleRate: 8000,
    bits: 4,
    channels: 1,
    interleaved: false,
    bitOrder: null,
    data: b.subarray(infoEnd, end),
    pcm: new Float32Array(0),
    chunks: sub.chunks.map((c) => ({ id: c.id, offset: c.offset, length: c.length })),
  };
  const adpm = sub.chunks.find((c) => c.id === 'adpm');
  if (adpm && adpm.length >= 3) {
    sample.sampleRate = adpm.data[0] * 1000;
    sample.bits = adpm.data[1];
    sample.channels = adpm.data[2] & 7;
    sample.interleaved = (adpm.data[2] & 8) !== 0;
  } else warnings.push(`adat ${index}: no adpm sub-chunk, assuming 8 kHz 4-bit mono`);
  try {
    const dec = decodeMFiAdpcm(sample.data, { format, bits: sample.bits, channels: sample.channels });
    sample.pcm = dec.pcm;
    sample.bitOrder = dec.bitOrder;
    sample.roughness = dec.roughness;
  } catch (e) {
    warnings.push(`adat ${index}: ${e.message}`);
    unparsed += sample.data.length;
  }
  sample.duration = sample.sampleRate ? sample.pcm.length / sample.sampleRate : 0;
  return { sample, unparsed };
}

function parseTrack(b, p, length, index, hdr, warnings) {
  const start = p + 8, end = start + length;
  const events = [];
  const noteBytes = hdr.noteMode === 1 ? 2 : 1;
  const channelMap = [0, 1, 2, 3].map((v) => (index * 4 + v) & 15);
  let q = start, tick = 0, ended = false, unparsed = 0, unknown = 0;
  while (q < end) {
    if (ended) {
      // nothing may follow the end-of-track event
      unparsed += end - q;
      warnings.push(`track ${index}: ${end - q} bytes after end of track`);
      break;
    }
    const offset = q;
    if (q + 2 > end) {
      unparsed += end - q;
      warnings.push(`track ${index}: truncated event at 0x${q.toString(16)}`);
      break;
    }
    let delta = b[q++];
    const status = b[q++];
    const ev = { type: 'unknown', track: index, tick: 0, time: 0, offset };
    if ((status & 0x3f) !== 0x3f) {
      if (q + noteBytes > end) {
        unparsed += end - offset;
        warnings.push(`track ${index}: truncated note at 0x${offset.toString(16)}`);
        break;
      }
      const voice = status >> 6;
      const gate = b[q++];
      let velocity = 63, octaveShift = 0;
      if (noteBytes === 2) {
        const x = b[q++];
        velocity = x >> 2;
        octaveShift = OCTAVE_SHIFT[x & 3];
      }
      Object.assign(ev, {
        type: 'note', voice, channel: channelMap[voice], key: status & 0x3f, octaveShift,
        midi: 0, percussion: false, velocity, gate, duration: 0,
      });
    } else {
      if (q >= end) {
        unparsed += end - offset;
        warnings.push(`track ${index}: truncated message at 0x${offset.toString(16)}`);
        break;
      }
      const ext = b[q++];
      let dataLen, dataPos;
      if (ext >= 0xf0) {
        if (q + 2 > end) {
          unparsed += end - offset;
          warnings.push(`track ${index}: truncated message at 0x${offset.toString(16)}`);
          break;
        }
        dataLen = u16(b, q);
        dataPos = q + 2;
      } else {
        dataLen = ext < 0x80 ? 1 + hdr.exst : 1;
        dataPos = q;
      }
      if (dataPos + dataLen > end) {
        unparsed += end - offset;
        warnings.push(`track ${index}: message at 0x${offset.toString(16)} overruns the track`);
        break;
      }
      q = dataPos + dataLen;
      const x = b[dataPos];
      const voice = x >> 6, value = x & 0x3f;
      const part = { voice, channel: channelMap[voice] };
      if (status === 0xff) {
        if (ext >= 0xf0) Object.assign(ev, { type: 'ext', ext, data: b.subarray(dataPos, dataPos + dataLen) });
        else if (ext === 0xb0) Object.assign(ev, { type: 'masterVolume', value: x & 0x7f });
        else if (ext === 0xb1) Object.assign(ev, { type: 'masterBalance', value: x & 0x7f });
        else if (ext === 0xbc) Object.assign(ev, { type: 'tempoRelative', value: x - 0x40 });
        else if (ext === 0xbd) Object.assign(ev, { type: 'masterVolumeRelative', value: x - 0x40 });
        else if (ext === 0xbe) Object.assign(ev, { type: 'allStop' });
        else if (ext === 0xbf) Object.assign(ev, { type: 'reset' });
        else if (ext === 0xba) Object.assign(ev, { type: 'channelConfig', channel: (x >> 3) & 15, mode: x & 7, percussion: (x & 7) === 1 });
        else if (ext >= 0xc0 && ext <= 0xcf) {
          const n = ext & 7;
          if (n === 7) {
            warnings.push(`track ${index}: undefined timebase in tempo event at 0x${offset.toString(16)}`);
            Object.assign(ev, { type: 'unknown', status, ext, data: b.subarray(dataPos, dataPos + dataLen) });
          } else Object.assign(ev, { type: 'tempo', timebase: (ext & 8 ? 15 : 6) << n, bpm: Math.max(20, x) });
        } else if (ext === 0xd0) Object.assign(ev, { type: 'cue', point: x === 0 ? 'start' : 'end', value: x });
        else if (ext === 0xdc) {
          delta |= x << 8;
          Object.assign(ev, { type: 'nop', wide: true });
        } else if (ext === 0xdd) Object.assign(ev, { type: 'loop', id: x >> 6, count: (x >> 2) & 15, point: (x & 3) === 0 ? 'start' : 'end', value: x });
        else if (ext === 0xde) Object.assign(ev, { type: 'nop', wide: false });
        else if (ext === 0xdf) {
          Object.assign(ev, { type: 'end' });
          ended = true;
        } else if (ext === 0xe0) Object.assign(ev, { type: 'program', ...part, low: value, program: value, bank: 0, bankValue: 0, gm: 0 });
        else if (ext === 0xe1) Object.assign(ev, { type: 'bank', ...part, bank: value >> 1, high: value & 1, value });
        else if (ext === 0xe2) Object.assign(ev, { type: 'volume', ...part, value });
        else if (ext === 0xe3) Object.assign(ev, { type: 'pan', ...part, value });
        else if (ext === 0xe4) Object.assign(ev, { type: 'pitchBend', ...part, value, bend: 8192, semitones: 0 });
        else if (ext === 0xe5) {
          // [M]: destinations 16-63 are legal and silent
          Object.assign(ev, { type: 'channelAssign', voice, to: value });
          channelMap[voice] = value;
        } else if (ext === 0xe6) Object.assign(ev, { type: 'expression', ...part, value });
        else if (ext === 0xe7) Object.assign(ev, { type: 'pitchBendRange', ...part, value });
        else if (ext === 0xe8 || ext === 0xe9) Object.assign(ev, { type: 'pitchBendFine', ...part, value, standalone: ext === 0xe8, bend: 8192, semitones: 0 });
        else if (ext === 0xea) Object.assign(ev, { type: 'modulation', ...part, value });
        else Object.assign(ev, { status, ext, data: b.subarray(dataPos, dataPos + dataLen) });
      } else if (status === 0x7f) {
        // audio lanes are not remapped by e5 [M]
        const audioChannel = (index * 4 + voice) & 15;
        if (ext === 0x00) Object.assign(ev, { type: 'audioPlay', voice, channel: audioChannel, sample: value, velocity: dataLen > 1 ? b[dataPos + 1] & 0x3f : 63 });
        else if (ext === 0x01) Object.assign(ev, { type: 'audioStop', voice, channel: audioChannel, sample: value });
        else if (ext === 0x80) Object.assign(ev, { type: 'audioVolume', voice, channel: audioChannel, value });
        else if (ext === 0x81) Object.assign(ev, { type: 'audioPan', voice, channel: audioChannel, value });
        else Object.assign(ev, { status, ext, data: b.subarray(dataPos, dataPos + dataLen) });
      } else Object.assign(ev, { status, ext, data: b.subarray(dataPos, dataPos + dataLen) });
      if (ev.type === 'unknown') unknown++;
    }
    tick += delta;
    ev.tick = tick;
    ev.delta = delta;
    events.push(ev);
  }
  if (!ended) warnings.push(`track ${index}: no end-of-track event`);
  return { track: { index, offset: p, length, endTick: tick, events }, unparsed, unknown };
}

/**
 * @param {Uint8Array|ArrayBuffer|ArrayLike<number>} input
 */
export function parseMFi(input) {
  const b = input instanceof Uint8Array ? input : ArrayBuffer.isView(input)
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
  if (b.length < 13 || fourcc(b, 0) !== 'melo') throw new Error('not an MFi file (no "melo" signature)');
  const warnings = [];
  let unparsed = 0;
  const fileLength = u32(b, 4);
  const headerLength = u16(b, 8);
  const header = {
    fileLength, headerLength, majorType: b[10], minorType: b[11], trackCount: b[12],
    version: null, title: null, date: null, support: null, copyright: null, author: null,
    source: null, protected: null, noteMode: 0, exst: 0, audioCount: 0, chunks: [],
  };
  if (fileLength + 8 !== b.length) warnings.push(`file length field says ${fileLength + 8} bytes, file has ${b.length}`);
  const fileEnd = Math.min(b.length, fileLength + 8);
  const headerEnd = 10 + headerLength;
  if (headerEnd > fileEnd) throw new Error('MFi header overruns the file');

  const sub = parseSubChunks(b, 13, headerEnd, warnings, 'header');
  unparsed += headerEnd - sub.end;
  for (const c of sub.chunks) {
    const info = { id: c.id, offset: c.offset, length: c.length };
    if (TEXT_CHUNKS.has(c.id)) info.text = text(c.data, 0, c.length);
    else info.bytes = c.data;
    header.chunks.push(info);
    switch (c.id) {
      case 'vers': header.version = info.text; break;
      case 'titl': header.title = info.text; break;
      case 'date': header.date = info.text; break;
      case 'supt': header.support = info.text; break;
      case 'copy': header.copyright = info.text; break;
      case 'auth': header.author = info.text; break;
      case 'note': header.noteMode = c.length >= 2 ? u16(c.data, 0) : 0; break;
      case 'exst': header.exst = c.length >= 2 ? u16(c.data, 0) : 0; break;
      case 'sorc':
        header.protected = (c.data[0] & 1) !== 0;
        header.source = c.data[0] >> 1;
        break;
      case 'ainf': header.audioCount = c.data[0] & 0x3f; break;
      default: break;
    }
  }
  if (header.noteMode > 1) warnings.push(`unknown note mode ${header.noteMode}`);

  const samples = [], tracks = [];
  let unknownEvents = 0;
  let p = headerEnd;
  while (p + 8 <= fileEnd) {
    const id = fourcc(b, p);
    const length = u32(b, p + 4);
    if (p + 8 + length > fileEnd) {
      warnings.push(`chunk ${id} at 0x${p.toString(16)} overruns the file`);
      break;
    }
    if (id === 'adat') {
      const r = parseAdat(b, p, length, samples.length, warnings);
      samples.push(r.sample);
      unparsed += r.unparsed;
    } else if (id === 'trac') {
      const r = parseTrack(b, p, length, tracks.length, header, warnings);
      tracks.push(r.track);
      unparsed += r.unparsed;
      unknownEvents += r.unknown;
    } else {
      warnings.push(`unknown chunk "${id}" (${length} bytes) at 0x${p.toString(16)}`);
      unparsed += 8 + length;
    }
    p += 8 + length;
  }
  unparsed += b.length - p;
  if (tracks.length !== header.trackCount) warnings.push(`header says ${header.trackCount} tracks, found ${tracks.length}`);
  if (samples.length !== header.audioCount) warnings.push(`ainf says ${header.audioCount} audio chunks, found ${samples.length}`);

  // ---- merge, resolve channel state and time ----
  const events = [];
  for (const t of tracks) for (let i = 0; i < t.events.length; i++) events.push(t.events[i]);
  const order = new Map(events.map((e, i) => [e, i]));
  events.sort((x, y) => x.tick - y.tick || x.track - y.track || order.get(x) - order.get(y));

  const tempoMap = [];
  let tempo = { tick: 0, time: 0, ...MFI_DEFAULT_TEMPO, secPerTick: 60 / (MFI_DEFAULT_TEMPO.bpm * MFI_DEFAULT_TEMPO.timebase) };
  const timeAt = (tick) => {
    let seg = tempoMap.length ? tempoMap[0] : tempo;
    if (tick < seg.tick) return tick * tempo0.secPerTick;
    for (let i = tempoMap.length - 1; i >= 0; i--) {
      if (tempoMap[i].tick <= tick) {
        seg = tempoMap[i];
        break;
      }
    }
    return seg.time + (tick - seg.tick) * seg.secPerTick;
  };
  const tempo0 = tempo;
  for (const e of events) {
    let bpm, timebase = tempo.timebase;
    if (e.type === 'tempo') {
      bpm = e.bpm;
      timebase = e.timebase;
    } else if (e.type === 'tempoRelative') bpm = Math.min(255, Math.max(20, tempo.bpm + e.value));
    else if (e.type === 'reset') bpm = MFI_DEFAULT_TEMPO.bpm;
    else continue;
    const time = tempo.time + (e.tick - tempo.tick) * tempo.secPerTick;
    tempo = { tick: e.tick, time, bpm, timebase, secPerTick: 60 / (bpm * timebase) };
    e.secPerTick = tempo.secPerTick;
    if (tempoMap.length && tempoMap[tempoMap.length - 1].tick === e.tick) tempoMap[tempoMap.length - 1] = tempo;
    else tempoMap.push(tempo);
  }
  if (!tempoMap.length || tempoMap[0].tick > 0) tempoMap.unshift({ ...tempo0 });

  const percussion = new Array(64).fill(false);
  percussion[MFI_PERCUSSION_CHANNEL] = true;
  const bankHigh = new Array(64).fill(0), bank = new Array(64).fill(0), bankValue = new Array(64).fill(0);
  const sounding = new Map(); // channel * 256 + midi -> first note event of a tie chain
  const coarse = new Array(64).fill(32), fine = new Array(64).fill(32), range = new Array(64).fill(2);
  const programs = new Set(), channels = new Set();
  let notes = 0, audioPlays = 0, ties = 0;
  const loopStarts = new Map();
  const loops = [];
  const cue = { startTick: null, endTick: null, startTime: null, endTime: null };
  const bendOf = (ch) => ((coarse[ch] * 32 + fine[ch]) * 8) - 256;
  for (const e of events) {
    e.time = timeAt(e.tick);
    switch (e.type) {
      case 'note':
        e.percussion = percussion[e.channel];
        e.midi = e.key + (e.percussion ? 35 : 45) + 12 * e.octaveShift;
        e.duration = timeAt(e.tick + e.gate) - e.time;
        e.tied = false;
        e.heldTicks = e.gate;
        e.heldDuration = e.duration;
        {
          const id = e.channel * 256 + e.midi;
          const head = sounding.get(id);
          if (head && e.tick < head.tick + head.heldTicks) {
            e.tied = true;
            head.heldTicks = e.tick + e.gate - head.tick;
            head.heldDuration = timeAt(head.tick + head.heldTicks) - head.time;
            ties++;
          } else sounding.set(id, e);
        }
        channels.add(e.channel);
        notes++;
        break;
      case 'audioPlay': audioPlays++; break;
      case 'channelConfig': percussion[e.channel] = e.percussion; break;
      case 'bank':
        bankHigh[e.channel] = e.high;
        bank[e.channel] = e.bank;
        bankValue[e.channel] = e.value;
        break;
      case 'program':
        e.program = (bankHigh[e.channel] << 6) | e.low;
        e.bank = bank[e.channel];
        e.bankValue = bankValue[e.channel];
        e.gm = e.bankValue <= 1 ? BASIC_VOICE_GM[e.low] ?? 0 : e.program;
        e.percussion = percussion[e.channel];
        programs.add(`${e.percussion ? 'd' : ''}${e.program}`);
        break;
      case 'pitchBendRange':
        if (e.value <= 24) range[e.channel] = e.value;
        break;
      case 'pitchBend':
      case 'pitchBendFine':
        if (e.type === 'pitchBend') coarse[e.channel] = e.value;
        else fine[e.channel] = e.value;
        e.bend = bendOf(e.channel);
        e.semitones = ((e.bend - 8192) / 8192) * range[e.channel];
        // a fine half that "rides" (0xe9) only takes effect with the coarse half that follows
        e.commit = e.type === 'pitchBend' || e.standalone;
        break;
      case 'cue':
        if (e.point === 'start') {
          cue.startTick = e.tick;
          cue.startTime = e.time;
        } else {
          cue.endTick = e.tick;
          cue.endTime = e.time;
        }
        break;
      case 'loop':
        if (e.point === 'start') loopStarts.set(e.id, e);
        else {
          const s = loopStarts.get(e.id);
          if (!s) warnings.push(`loop ${e.id} ends at tick ${e.tick} without a start`);
          else {
            loops.push({ id: e.id, count: s.count, track: e.track, startTick: s.tick, endTick: e.tick, startTime: s.time, endTime: e.time });
            loopStarts.delete(e.id);
          }
        }
        break;
      default: break;
    }
  }
  for (const s of loopStarts.values()) warnings.push(`loop ${s.id} starts at tick ${s.tick} but never ends`);

  const endTick = tracks.reduce((m, t) => Math.max(m, t.endTick), 0);
  for (const t of tracks) t.endTime = timeAt(t.endTick);
  const usable = loops.filter((l) => l.endTick > l.startTick);
  // the player only acts on track 0's loop points [M]
  const loop = usable.find((l) => l.track === 0 && l.count === 0) ?? usable.find((l) => l.track === 0) ?? null;

  return {
    header, samples, tracks, events, tempoMap, loop, loops, cue,
    endTick, duration: timeAt(endTick),
    stats: {
      notes, ties, audioPlays, unknownEvents,
      programs: [...programs].sort((x, y) => parseInt(x.replace('d', '1000'), 10) - parseInt(y.replace('d', '1000'), 10)),
      channels: [...channels].sort((x, y) => x - y),
    },
    unparsed, warnings,
    timeAt,
  };
}

/** True when the loop of a parsed file never terminates on its own. */
export function isInfiniteLoop(loop) {
  return !!loop && loop.count === 0;
}
