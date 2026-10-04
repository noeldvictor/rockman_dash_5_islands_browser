#!/usr/bin/env python3
"""Demultiplex and decode the CD-XA ADPCM streams of Mega Man Legends 2 (`XA/*.XA`).

Usage:
    python3 tools/mml2/xa.py <disc dir> <out dir> [--wav]

`<disc dir>` is the output of `iso.py extract` (XA files are stored there as raw 2352-byte
sectors).  Each sector's subheader (bytes 16..19: file, channel, submode, coding info) says which
of the interleaved channels it belongs to; submode bit 0x04 marks audio, bit 0x80 the last sector
of a clip.  A clip is therefore "all audio sectors of one channel up to and including an EOF
sector".  Coding info: bit 0 stereo, bit 2 = 18.9 kHz (else 37.8 kHz), bit 4 = 8-bit samples.

On this disc `*_37.XA` are 8-channel 37.8 kHz stereo files and `*_18.XA` are up-to-32-channel
18.9 kHz mono files; all are 4-bit ADPCM.

The ADPCM decoder below is the standard CD-ROM XA one (Green Book / CD-i, also in the "Nocash PSX
Specifications", section "CDROM XA Audio ADPCM Compression"): each sector holds 18 sound groups of
128 bytes = 16 header bytes + 112 data bytes; a group has 8 sound units of 28 nibbles; header
bytes 4..11 give each unit's shift (low nibble) and filter (high nibble); filters are
(0,0) (60,0) (115,-52) (98,-55) in 1/64 units.  In stereo, even units are left, odd are right.

Output: one Ogg Vorbis file per clip (`<out>/<XA name>/chCC_NN.ogg`) and `<out>/index.json`.
"""
import json
import os
import struct
import subprocess
import sys
import wave

SECTOR = 2352
K0 = (0, 60, 115, 98)
K1 = (0, 0, -52, -55)


def clips(path):
    """Yield (channel, clip number, coding, first sector, [sector payloads])."""
    open_clips = {}
    counts = {}
    with open(path, 'rb') as f:
        n = os.path.getsize(path) // SECTOR
        for i in range(n):
            sec = f.read(SECTOR)
            ch, sub, coding = sec[17], sec[18], sec[19]
            if not sub & 0x04:
                continue
            clip = open_clips.setdefault(ch, [coding, i, []])
            clip[2].append(sec[24:24 + 2304])  # 18 groups * 128; last 20 bytes are padding
            if sub & 0x80:
                k = counts.get(ch, 0)
                counts[ch] = k + 1
                yield ch, k, clip[0], clip[1], clip[2]
                del open_clips[ch]
    for ch, clip in sorted(open_clips.items()):  # a clip without an EOF marker
        yield ch, counts.get(ch, 0), clip[0], clip[1], clip[2]


def decode(sectors, stereo):
    """Decode 4-bit XA ADPCM sectors to interleaved signed 16-bit PCM (bytes)."""
    out = []
    hist = [[0, 0], [0, 0]]
    nch = 2 if stereo else 1
    for sec in sectors:
        for g in range(18):
            base = g * 128
            units = []
            for u in range(8):
                p = sec[base + 4 + u]
                shift, filt = p & 15, (p >> 4) & 3
                if shift > 12:
                    shift = 9
                k0, k1 = K0[filt], K1[filt]
                h = hist[u & 1] if stereo else hist[0]
                s1, s2 = h
                pcm = []
                bitpos = 4 * (u & 1)
                col = base + 16 + (u >> 1)
                for i in range(28):
                    nib = (sec[col + i * 4] >> bitpos) & 15
                    if nib >= 8:
                        nib -= 16
                    s = ((nib << 12) >> shift) + ((s1 * k0 + s2 * k1 + 32) >> 6)
                    if s > 32767:
                        s = 32767
                    elif s < -32768:
                        s = -32768
                    pcm.append(s)
                    s2, s1 = s1, s
                h[0], h[1] = s1, s2
                units.append(pcm)
            if stereo:
                for u in range(0, 8, 2):
                    left, right = units[u], units[u + 1]
                    for i in range(28):
                        out.append(left[i])
                        out.append(right[i])
            else:
                for u in range(8):
                    out.extend(units[u])
    return struct.pack('<%dh' % len(out), *out), nch


def write_wav(path, pcm, nch, rate):
    with wave.open(path, 'wb') as w:
        w.setnchannels(nch)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)


def encode_ogg(wav, ogg, quality='5'):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', wav, '-c:a', 'libvorbis', '-q:a', quality,
                    ogg], check=True)


def convert_file(args):
    xa_dir, out, name, keep_wav = args
    stem = os.path.splitext(name)[0]
    os.makedirs(os.path.join(out, stem), exist_ok=True)
    index = []
    for ch, k, coding, first, sectors in clips(os.path.join(xa_dir, name)):
        stereo = bool(coding & 1)
        rate = 18900 if coding & 4 else 37800
        assert not coding & 0x10, '8-bit XA not expected'
        pcm, nch = decode(sectors, stereo)
        rel = '%s/ch%02d_%02d' % (stem, ch, k)
        wav = os.path.join(out, rel + '.wav')
        write_wav(wav, pcm, nch, rate)
        encode_ogg(wav, os.path.join(out, rel + '.ogg'))
        if not keep_wav:
            os.remove(wav)
        index.append({'id': rel, 'file': rel + '.ogg', 'source': 'XA/' + name, 'channel': ch,
                      'clip': k, 'firstSector': first, 'sectors': len(sectors),
                      'sampleRate': rate, 'channels': nch,
                      'duration': round(len(pcm) / 2 / nch / rate, 3)})
    print(name, len(index), 'clips', flush=True)
    return index


def main():
    from multiprocessing import Pool
    disc, out = sys.argv[1], sys.argv[2]
    keep_wav = '--wav' in sys.argv
    xa_dir = os.path.join(disc, 'XA')
    os.makedirs(out, exist_ok=True)
    jobs = [(xa_dir, out, name, keep_wav) for name in sorted(os.listdir(xa_dir))]
    with Pool(min(8, len(jobs))) as pool:
        index = [e for part in pool.map(convert_file, jobs, chunksize=1) for e in part]
    with open(os.path.join(out, 'index.json'), 'w') as f:
        json.dump(index, f, indent=1)
    print('%d clips, %.0f s' % (len(index), sum(e['duration'] for e in index)))


if __name__ == '__main__':
    main()
