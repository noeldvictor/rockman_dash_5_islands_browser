#!/usr/bin/env python3
"""Minimal ISO9660 reader for a raw (2352-byte sector) PlayStation MODE2 disc image.

Usage:
    python3 tools/mml2/iso.py list  <image.bin>
    python3 tools/mml2/iso.py extract <image.bin> <outdir>

Every sector of a MODE2 track is 2352 bytes: 12 sync, 4 header (min, sec, frame, mode), then an
8-byte XA subheader (file, channel, submode, coding info, repeated twice).  Form 1 sectors carry
2048 bytes of user data at offset 24; Form 2 sectors (submode bit 0x20; XA audio and STR video)
carry 2324 bytes at offset 24.  Ordinary files are extracted as their 2048-byte user data.  Files
whose sectors are Form 2 (XA/STR streams) are extracted as raw 2352-byte sectors so that the
subheaders survive (they are needed to demultiplex the interleaved channels).
"""
import os
import struct
import sys

SECTOR = 2352


class Iso:
    def __init__(self, path):
        self.f = open(path, 'rb')
        self.f.seek(0, 2)
        self.sectors = self.f.tell() // SECTOR

    def raw(self, lba, count=1):
        self.f.seek(lba * SECTOR)
        return self.f.read(count * SECTOR)

    def user(self, lba, count=1):
        out = bytearray()
        data = self.raw(lba, count)
        for i in range(count):
            out += data[i * SECTOR + 24:i * SECTOR + 24 + 2048]
        return bytes(out)

    def submode(self, lba):
        return self.raw(lba)[18]

    def walk(self):
        pvd = self.user(16)
        assert pvd[1:6] == b'CD001', 'no ISO9660 primary volume descriptor'
        root = pvd[156:190]
        lba, size = struct.unpack_from('<I', root, 2)[0], struct.unpack_from('<I', root, 10)[0]
        yield from self._dir('', lba, size)

    def _dir(self, prefix, lba, size):
        data = self.user(lba, (size + 2047) // 2048)
        pos = 0
        while pos < len(data):
            n = data[pos]
            if n == 0:  # records never span sectors; skip to the next one
                pos = (pos // 2048 + 1) * 2048
                continue
            rec = data[pos:pos + n]
            pos += n
            elba, esize = struct.unpack_from('<I', rec, 2)[0], struct.unpack_from('<I', rec, 10)[0]
            flags = rec[25]
            name = rec[33:33 + rec[32]]
            if name in (b'\x00', b'\x01'):
                continue
            name = name.decode('ascii', 'replace').split(';')[0]
            # CD-XA system-use area: 'XA' signature at +6 after the (padded) name; attributes at +4
            su = rec[33 + rec[32] + (1 - rec[32] % 2):]
            xa_attr = struct.unpack_from('>H', su, 4)[0] if len(su) >= 8 and su[6:8] == b'XA' else 0
            path = prefix + name
            if flags & 2:
                yield from self._dir(path + '/', elba, esize)
            else:
                yield {'path': path, 'lba': elba, 'size': esize, 'xa_attr': xa_attr}


def is_stream(iso, e):
    """True for Form 2 / interleaved files (XA audio, STR video)."""
    if e['xa_attr'] & 0x3000:  # Mode2Form2 or interleaved
        return True
    return bool(iso.submode(e['lba']) & 0x20)


def main():
    cmd, image = sys.argv[1], sys.argv[2]
    iso = Iso(image)
    entries = sorted(iso.walk(), key=lambda e: e['lba'])
    if cmd == 'list':
        for e in entries:
            print('%8d %10d %04x %s%s' % (e['lba'], e['size'], e['xa_attr'], e['path'],
                                          '  [stream]' if is_stream(iso, e) else ''))
        print('%d files, image has %d sectors' % (len(entries), iso.sectors))
    elif cmd == 'extract':
        out = sys.argv[3]
        for e in entries:
            dst = os.path.join(out, e['path'])
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            nsec = (e['size'] + 2047) // 2048
            with open(dst, 'wb') as f:
                if is_stream(iso, e):
                    f.write(iso.raw(e['lba'], nsec))
                else:
                    f.write(iso.user(e['lba'], nsec)[:e['size']])
        print('extracted %d files to %s' % (len(entries), out))


if __name__ == '__main__':
    main()
