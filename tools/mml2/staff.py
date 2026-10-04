#!/usr/bin/env python3
"""Decode the staff-roll music stream in COMMON/STAFF.BIN of Mega Man Legends 2.

Usage:
    python3 tools/mml2/staff.py <disc dir> <out dir>      # writes staff_roll.ogg + staff_roll.json

STAFF.BIN is an archive of 314 groups: a type 0 entry (2000 zero bytes; header +0x0c = sector
number, +0x10 = byte length of the group), then two type 0x15 entries of 0x4000 bytes (header
+0x0d = channel 0/1, +0x10 = chunk number) and an empty type 0x15 terminator.  24 type 2 images
(the credit pictures) are interleaved.  The type 0x15 payloads are raw SPU ADPCM (16-byte blocks,
see bank.py), continuous across chunks: channel 0 is left, channel 1 right (assumed order).

The sample rate is not stored in the file.  44100 Hz is used: with it the music's spectral peaks
fall on equal-tempered pitches (mean offset +0.01 semitone over 270 peaks), which rules out
37800, 32000 and 48000 Hz; 22050 Hz (an octave lower, twice as long) cannot be ruled out by
tuning alone.
"""
import json
import os
import struct
import subprocess
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import archive  # noqa: E402

RATE = 44100
F0 = (0, 60, 115, 98, 122)
F1 = (0, 0, -52, -55, -60)


def decode_stream(data):
    out = []
    s1 = s2 = 0
    for p in range(0, len(data) - 15, 16):
        head = data[p]
        shift, filt = head & 15, head >> 4
        if filt > 4:
            filt = 0
        if shift > 12:
            shift = 9
        f0, f1 = F0[filt], F1[filt]
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
    return out


def main():
    disc, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    data = open(os.path.join(disc, 'COMMON', 'STAFF.BIN'), 'rb').read()
    chans = [bytearray(), bytearray()]
    chunks = 0
    for e in archive.entries(data):
        if e.type == 0x15 and e.size:
            chans[e.header[0x0d]] += e.data
            chunks += 1
    left, right = decode_stream(bytes(chans[0])), decode_stream(bytes(chans[1]))
    n = min(len(left), len(right))
    inter = [0] * (2 * n)
    inter[0::2] = left[:n]
    inter[1::2] = right[:n]
    wav = os.path.join(out, 'staff_roll.wav')
    with wave.open(wav, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(struct.pack('<%dh' % len(inter), *inter))
    ogg = os.path.join(out, 'staff_roll.ogg')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', wav, '-c:a', 'libvorbis', '-q:a', '6', ogg],
                   check=True)
    os.remove(wav)
    info = {'id': 'staff_roll', 'file': 'staff_roll.ogg', 'sources': ['COMMON/STAFF.BIN'],
            'sampleRate': RATE, 'samples': n, 'duration': round(n / RATE, 3), 'loop': False,
            'chunks': chunks, 'format': 'streamed SPU ADPCM, stereo',
            'note': 'sample rate inferred from tuning (44100 or 22050 Hz); 44100 assumed'}
    with open(os.path.join(out, 'staff_roll.json'), 'w') as f:
        json.dump(info, f, indent=1)
    print(info)


if __name__ == '__main__':
    main()
