#!/usr/bin/env python3
"""Render every Mega Man Legends 2 BGM sequence to Ogg Vorbis with the game's own instruments.

Usage:
    python3 tools/mml2/music.py <disc dir> <out dir> [--only 0f,15] [--wav] [--jobs N] [--gain G]

The music is sequenced, not streamed: each stage archive carries a sequence entry (type 0x08,
0x0F or compressed 0x10; the title screen's is type 0x09 in COMMON/TITLE.BIN) with a BGM id at
header +0x16 and a sequence count at +0x18, plus an instrument bank (type 0x05/0x0E, slot 4)
whose id is the BGM id + 0x20.  See seqrender.mjs for the sequence format and playback rules and
bank.py for the bank format.

Levels: all tracks share one fixed gain (default 0.5, i.e. -6 dB below the SPU's full-scale sum)
so their relative loudness is preserved; a track that would still clip is turned down just enough
and its `gain` in the index says by how much.

Each sequence is rendered as intro + two passes of its loop.  `loopStart`/`loopEnd` in the index
are sample positions (44.1 kHz) of the second pass, so looping that region is seamless and
includes the tails of notes that ring across the loop point; `firstLoopStart` is where the loop
body begins the first time.  Sequences without loop markers are rendered once with their tail.
"""
import base64
import hashlib
import json
import os
import struct
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import archive  # noqa: E402
import bank as bankmod  # noqa: E402

SEQ_TYPES = (0x08, 0x09, 0x0f, 0x10)

# Where a track plays.  'disc' entries follow from the archive's own name; 'web' entries are stage
# names quoted in a web search summary of the fan "Stage Names" list (megamanfanon.fandom.com /
# dwn009.fandom.com; the pages themselves could not be fetched), so treat them as unverified.
ARCHIVE_NOTES = {
    'TITLE': ('title screen', 'disc'),
    'G_OVER00': ('game over screen', 'disc'), 'G_OVER01': ('game over screen', 'disc'),
    'G_OVER02': ('game over screen', 'disc'),
}
STAGE_NOTES = {
    0x04: 'Flutter (before Forbidden Island)', 0x0d: 'Flutter (after the fire)',
    0x0f: 'first ruin (Roll rescue)', 0x10: 'Forbidden Island part 1',
    0x11: 'Forbidden Island part 2', 0x12: 'Manda Island', 0x13: 'Manda Island part 2',
    0x14: 'Manda Island part 3', 0x15: 'Nino Island (Birdbot invasion 2)',
    0x16: 'Nino Island (Birdbot invasion 1)', 0x17: 'Nino Island (Birdbot invasion 3)',
    0x1f: 'Calbania Island (outside Glyde\'s castle)',
}


def describe_sources(sources):
    """Returns (stage numbers, [context strings], context source)."""
    stages, notes, origin = [], [], None
    for src in sources:
        stem = os.path.splitext(os.path.basename(src))[0]
        if stem in ARCHIVE_NOTES:
            note, origin = ARCHIVE_NOTES[stem]
            if note not in notes:
                notes.append(note)
        elif stem.startswith('ST'):
            n = int(stem[2:4], 16)
            scene = stem[4:].rstrip('T')
            if n not in stages:
                stages.append(n)
            if n in STAGE_NOTES:
                origin = origin or 'web'
                note = STAGE_NOTES[n] + (' scene ' + scene if scene else '')
                if note not in notes:
                    notes.append(note)
    return stages, notes, origin


def split_sequences(data, count):
    out = []
    off = 0
    for _ in range(count):
        size = struct.unpack_from('<I', data, off)[0]
        out.append(data[off:off + size])
        off += (size + 3) & ~3
    return out


def collect(disc):
    """Yield one record per distinct (sequence data, bank data)."""
    seen = {}
    for sub in ('COMMON', 'DAT'):
        for name in sorted(os.listdir(os.path.join(disc, sub))):
            if not name.endswith('.BIN'):
                continue
            data = open(os.path.join(disc, sub, name), 'rb').read()
            seqs, banks = [], {}
            for e in archive.entries(data):
                if e.type in SEQ_TYPES:
                    seqs.append(e)
                elif e.type in (5, 0x0e) and e.u16(0x0c) == 4:
                    banks[e.u16(0x0e)] = e
            for e in seqs:
                bgm = e.u16(0x16) if e.type != 9 else 0
                count = e.u16(0x18) if e.type != 9 else 1
                be = banks.get(bgm + 0x20)
                if be is None and len(banks) == 1:
                    # DAT/ST3FT.BIN pairs BGM 0x3a with bank 0x62 (a quieter copy of bank 0x5a)
                    be = next(iter(banks.values()))
                src = '%s/%s' % (sub, name)
                if be is None:
                    print('no bank for BGM %02x in %s' % (bgm, src), file=sys.stderr)
                    continue
                key = (bgm, hashlib.md5(e.data).hexdigest(), hashlib.md5(be.data).hexdigest())
                if key in seen:
                    seen[key]['sources'].append(src)
                    continue
                rec = {'bgm': bgm, 'count': count, 'seq': e.data, 'bank': bankmod.Bank(be),
                       'sources': [src], 'seqType': e.type}
                seen[key] = rec
    return sorted(seen.values(), key=lambda r: (r['bgm'], r['sources'][0]))


def render_one(job_path, wav_path):
    out = subprocess.run(['node', os.path.join(HERE, 'seqrender.mjs'), job_path, wav_path],
                         check=True, capture_output=True, text=True).stdout
    return json.loads(out.strip().splitlines()[-1])


def main():
    disc, out = sys.argv[1], sys.argv[2]
    args = sys.argv[3:]
    only = None
    if '--only' in args:
        only = set(int(x, 16) for x in args[args.index('--only') + 1].split(','))
    keep_wav = '--wav' in args
    jobs = int(args[args.index('--jobs') + 1]) if '--jobs' in args else 6
    gain = float(args[args.index('--gain') + 1]) if '--gain' in args else 0.5
    os.makedirs(out, exist_ok=True)
    tmp = os.path.join(out, '.jobs')
    os.makedirs(tmp, exist_ok=True)

    records = collect(disc)
    by_bgm = {}
    for r in records:
        by_bgm.setdefault(r['bgm'], []).append(r)
    tasks = []
    for bgm, recs in sorted(by_bgm.items()):
        if only is not None and bgm not in only:
            continue
        for vi, r in enumerate(recs):
            parts = split_sequences(r['seq'], r['count'])
            for k, seq in enumerate(parts):
                tid = 'bgm%02x' % bgm
                if len(recs) > 1:
                    tid += chr(ord('a') + vi)
                if len(parts) > 1:
                    tid += '_%d' % k
                tasks.append((tid, r, k, len(parts), seq))

    def run(task):
        tid, r, k, nparts, seq = task
        b = r['bank']
        job = {'seq': base64.b64encode(seq).decode(), 'samples': base64.b64encode(b.samples).decode(),
               'bank': b.to_json(), 'passes': 2, 'tail': 3, 'gain': gain}
        jp = os.path.join(tmp, tid + '.json')
        with open(jp, 'w') as f:
            json.dump(job, f)
        wav = os.path.join(out, tid + '.wav')
        info = render_one(jp, wav)
        applied = gain
        if info['peak'] > 0.98:  # keep the fixed gain unless the track would clip
            applied = gain * 0.98 / info['peak']
            job['gain'] = applied
            with open(jp, 'w') as f:
                json.dump(job, f)
            info = render_one(jp, wav)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', wav, '-c:a', 'libvorbis', '-q:a', '6',
                        os.path.join(out, tid + '.ogg')], check=True)
        if not keep_wav:
            os.remove(wav)
        os.remove(jp)
        size, tempo, ppqn, num, den = struct.unpack_from('<IIHBB', seq, 0)
        bnd = info['boundaries']
        looped = len(bnd) >= 3
        stages, context, origin = describe_sources(r['sources'])
        entry = {
            'id': tid, 'file': tid + '.ogg', 'bgmId': r['bgm'], 'part': k, 'parts': nparts,
            'sources': r['sources'], 'stages': ['%02X' % n for n in stages],
            'context': context, 'contextSource': origin,
            'bankId': b.id, 'bankVolume': b.volume,
            'sampleRate': 44100, 'samples': info['samples'], 'duration': round(info['duration'], 3),
            'loop': looped,
            'loopStart': bnd[1] if looped else None, 'loopEnd': bnd[2] if looped else None,
            'firstLoopStart': bnd[0] if bnd else None,
            'loopCount': info['loopCount'] if bnd else None,
            'tempoBpm': round(60e6 / tempo, 1), 'timeSignature': '%d/%d' % (num, 1 << den),
            'notes': info['notes'], 'peak': round(info['peak'], 4), 'clippedSamples': info['clipped'],
            'gain': round(applied, 4),
            'unmatchedNotes': info['stats']['unmatchedNotes'],
        }
        print('%-10s %6.1fs loop %s peak %.3f clipped %d unmatched %d  %s' % (
            tid, entry['duration'], looped, entry['peak'], entry['clippedSamples'],
            entry['unmatchedNotes'], ' '.join(r['sources'])[:60]), flush=True)
        return entry

    with ThreadPoolExecutor(jobs) as pool:
        index = list(pool.map(run, tasks))
    os.rmdir(tmp)
    staff = os.path.join(out, 'staff_roll.json')  # written by staff.py
    if only is None and os.path.exists(staff):
        extra = json.load(open(staff))
        extra.update({'context': ['staff roll (ending credits)'], 'contextSource': 'disc'})
        index.append(extra)
    with open(os.path.join(out, 'index.json'), 'w') as f:
        json.dump(index, f, indent=1)
    print('%d tracks, %.0f s' % (len(index), sum(e['duration'] for e in index)))


if __name__ == '__main__':
    main()
