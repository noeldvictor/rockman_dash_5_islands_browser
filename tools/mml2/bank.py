#!/usr/bin/env python3
"""Mega Man Legends 2 sound banks (archive entry types 0x05 and 0x0E) and PSX SPU ADPCM.

Usage:
    python3 tools/mml2/bank.py <disc dir> <out dir>      # export every effect sample as WAV

A bank is Capcom's repacking of a Sony VAB (no 'pBAV' magic).  Entry header:

    +0x0c u16 slot      0 common effects (INIT.BIN), 1/2 stage effects, 3 special weapon effects
                        (PL00Rxx.BIN), 4 music instruments
    +0x0e u16 bank id   for slot 4: BGM id + 0x20
    +0x14 u32 header size = programs * 8 + programs * 16 * 20
    +0x18 u32 sample bytes (entry size - header size)
    +0x1c u16 programs
    +0x1e u8  master volume, +0x1f u8 master pan (always 0x40)

Payload: `programs` program records (8 bytes), then 16 tone records (20 bytes) per program, zero
padding up to the next 0x800 boundary of the archive (counting the 0x30-byte entry header), then
the sample data.  "sample bytes" includes that padding.

    program: u8 tones in use, u8 volume, u8 0xff, u8 pan, 4 zero bytes
    tone:    u32 sample offset (from the start of the sample data)
             u8 priority, u8 mode (4 = reverb on), u8 volume, u8 pan
             u8 centre note, u8 fine tune (1/128 semitone), u8 lowest note, u8 highest note
             u8 bend range down, u8 bend range up (semitones; 0 or 2 on this disc)
             u16 ADSR1, u16 ADSR2 (raw SPU register values)
             u8 sample number (0xff = unused tone), u8 0

Unused tones have sample number 0xff (common and music banks) or an all-zero record (stage
banks).  Sample offsets are relative to the SPU RAM area shared by the banks that are loaded
together: a stage's slot 2 bank is uploaded behind its slot 1 bank, so its offsets start at a
non-zero base, which has to be subtracted.  Every sample begins with a block of 16 zero bytes;
the base is chosen (among 0, the offset left in unused records, and the lowest offset in use) so
that every tone lands on such a block, and `Bank.check()` reports tones that still do not (seven
tones on the disc point past the end of their bank's data and are skipped).

These are the fields of Sony's VagAtr in the same order.  A sample plays at 44100 Hz when the
note equals the centre note and the fine tune is 0:

    rate = 44100 * 2 ** ((note - centre + fine / 128) / 12)

(Confirmed by arithmetic: the effect tones then come out at exactly 11025, 16000, 22050 and
32000 Hz.)  Effects are single-note tones (lowest == highest == 60 + tone number): the game plays
effect `t` of a program by sending note 60 + t.

Sample data is standard SPU ADPCM: 16-byte blocks = shift/filter byte, flag byte (1 = last
block, 2 = when last, jump to the loop point instead of stopping, 4 = loop point), 28 nibbles.
"""
import hashlib
import json
import os
import struct
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import archive  # noqa: E402

F0 = (0, 60, 115, 98, 122)
F1 = (0, 0, -52, -55, -60)


def decode_adpcm(data, off):
    """Decode one sample starting at `off`.  Returns (pcm list, loop start sample or None,
    bytes consumed)."""
    out = []
    s1 = s2 = 0
    loop = None
    p = off
    looped = False
    while p + 16 <= len(data):
        head, flags = data[p], data[p + 1]
        shift, filt = head & 15, head >> 4
        if filt > 4:
            filt = 0
        if shift > 12:
            shift = 9
        f0, f1 = F0[filt], F1[filt]
        if flags & 4:
            loop = len(out)
        for i in range(2, 16):
            b = data[p + i]
            for nib in (b & 15, b >> 4):
                if nib >= 8:
                    nib -= 16
                s = ((nib << 12) >> shift) + ((s1 * f0 + s2 * f1 + 32) >> 6)
                if s > 32767:
                    s = 32767
                elif s < -32768:
                    s = -32768
                out.append(s)
                s2, s1 = s1, s
        p += 16
        if flags & 1:
            looped = bool(flags & 2)
            break
    if not looped:
        loop = None
    return out, loop, p - off


class Bank:
    def __init__(self, entry):
        h = entry.header
        self.slot, self.id = struct.unpack_from('<HH', h, 0x0c)
        self.header_size, self.sample_size = struct.unpack_from('<II', h, 0x14)
        nprog = struct.unpack_from('<H', h, 0x1c)[0]
        self.volume, self.pan = h[0x1e], h[0x1f]
        d = entry.data
        # the sample body starts on the next 0x800 boundary of the archive (entry header included)
        base = ((archive.HEADER + self.header_size + 0x7ff) & ~0x7ff) - archive.HEADER
        self.samples = d[base:]
        self.programs = []
        raw = []
        unused_offsets = set()
        for p in range(nprog):
            ntones, vol, _, pan = d[p * 8:p * 8 + 4]
            tones = []
            for t in range(16):
                o = nprog * 8 + (p * 16 + t) * 20
                (offset, prio, mode, tvol, tpan, centre, fine, lo, hi, bend_dn, bend_up, adsr1,
                 adsr2, sample, _) = struct.unpack_from('<I10BHHBB', d, o)
                # unused tones: sample 0xff (music/common banks) or an all-zero record that still
                # carries the bank's base offset (stage banks)
                if sample == 0xff or (centre == 0 and hi == 0 and tvol == 0):
                    if sample != 0xff:
                        unused_offsets.add(offset)
                    continue
                tones.append({'tone': t, 'offset': offset, 'priority': prio, 'mode': mode,
                              'volume': tvol, 'pan': tpan, 'centre': centre, 'fine': fine,
                              'low': lo, 'high': hi, 'bendDown': bend_dn, 'bendUp': bend_up,
                              'adsr1': adsr1, 'adsr2': adsr2, 'sample': sample})
                raw.append(tones[-1])
            self.programs.append({'tones': tones, 'volume': vol, 'pan': pan, 'count': ntones})
        # Tone offsets are SPU RAM offsets shared by the banks loaded together (a stage's slot 2
        # bank is uploaded behind its slot 1 bank), so rebase them to this bank's own data.
        used = [t['offset'] for t in raw]
        candidates = [t['offset'] for t in raw if t['sample'] == 0][:1]
        candidates += sorted(unused_offsets) + [0] + ([min(used)] if used else [])
        best = None
        for base in candidates:
            bad = sum(1 for o in used if not self._is_sample_start(o - base))
            if best is None or bad < best[0]:
                best = (bad, base)
        self.base = best[1] if best else 0
        for t in raw:
            t['offset'] -= self.base

    def _is_sample_start(self, o):
        return 0 <= o and o + 32 <= len(self.samples) and not any(self.samples[o:o + 16])

    def check(self):
        """Every tone must point at the 16 zero bytes that lead each sample."""
        bad = []
        for prog in self.programs:
            for t in prog['tones']:
                if not self._is_sample_start(t['offset']):
                    bad.append(t)
        return bad

    def to_json(self):
        return {'slot': self.slot, 'id': self.id, 'volume': self.volume, 'pan': self.pan,
                'programs': self.programs}


def tone_rate(tone, note=None):
    note = tone['low'] if note is None else note
    return 44100 * 2 ** ((note - tone['centre'] + tone['fine'] / 128) / 12)


def write_wav(path, pcm, rate):
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack('<%dh' % len(pcm), *pcm))


SLOT_NAMES = {0: 'common', 1: 'stage-a', 2: 'stage-b', 3: 'weapon'}


def main():
    disc, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    seen = {}
    index = []
    for sub in ('COMMON', 'DAT'):
        for name in sorted(os.listdir(os.path.join(disc, sub))):
            if not name.endswith('.BIN'):
                continue
            data = open(os.path.join(disc, sub, name), 'rb').read()
            for e in archive.entries(data):
                if e.type not in (5, 0x0e):
                    continue
                bank = Bank(e)
                if bank.slot == 4:
                    continue  # music instruments: see music.py
                digest = hashlib.md5(e.data).hexdigest()[:8]
                src = '%s/%s' % (sub, name)
                if digest in seen:
                    seen[digest]['sources'].append(src)
                    continue
                stem = os.path.splitext(name)[0]
                label = '%s_%s' % (stem, SLOT_NAMES.get(bank.slot, 'slot%d' % bank.slot))
                if bank.slot == 3:
                    label = '%s_weapon%02x' % (stem, bank.id)
                os.makedirs(os.path.join(out, label), exist_ok=True)
                rec = {'bank': label, 'slot': bank.slot, 'bankId': bank.id, 'md5': digest,
                       'sources': [src], 'volume': bank.volume, 'effects': []}
                seen[digest] = rec
                index.append(rec)
                decoded = {}
                for pi, prog in enumerate(bank.programs):
                    for tone in prog['tones']:
                        if not bank._is_sample_start(tone['offset']):
                            rec.setdefault('missing', []).append([pi, tone['tone']])
                            continue
                        if tone['offset'] not in decoded:
                            decoded[tone['offset']] = decode_adpcm(bank.samples, tone['offset'])
                        pcm, loop, _ = decoded[tone['offset']]
                        rate = int(round(tone_rate(tone)))
                        rel = '%s/p%d_t%02d.wav' % (label, pi, tone['tone'])
                        write_wav(os.path.join(out, rel), pcm, rate)
                        peak = max((abs(s) for s in pcm), default=0)
                        rec['effects'].append({
                            'file': rel, 'program': pi, 'tone': tone['tone'], 'note': tone['low'],
                            'noteHigh': tone['high'], 'sample': tone['sample'], 'sampleRate': rate,
                            'samples': len(pcm), 'duration': round(len(pcm) / rate, 3),
                            'loopStart': loop, 'peak': peak, 'volume': tone['volume'],
                            'pan': tone['pan'], 'programVolume': prog['volume'],
                            'reverb': bool(tone['mode'] & 4), 'priority': tone['priority'],
                            'adsr1': tone['adsr1'], 'adsr2': tone['adsr2']})
                print(label, len(rec['effects']), 'effects', flush=True)
    with open(os.path.join(out, 'index.json'), 'w') as f:
        json.dump(index, f, indent=1)
    print('%d banks, %d effect files' % (len(index), sum(len(b['effects']) for b in index)))


if __name__ == '__main__':
    main()
