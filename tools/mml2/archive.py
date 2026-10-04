#!/usr/bin/env python3
"""Mega Man Legends 2 (PSX) `.BIN` archive reader.

A `.BIN` is a run of entries, each starting on a 0x800-byte (CD sector) boundary:

    +0x00 u32 type
    +0x04 u32 size      size of the payload once decompressed
    +0x08 u32 id        small number; for type 1 it differs per entry (resource slot?)
    +0x0c ...           type-specific (see below)
    +0x30 payload

Types seen on the USA disc (every entry on the disc is walked without gaps by this reader):

    0x00  STAFF.BIN stream header (and one stray in ST1F.BIN)
    0x01  raw data loaded at the RAM address in +0x0c: overlay code, model/animation tables.
    0x02  palette(s): +0x0c u16 clutX, clutY, +0x10 u16 colours, palettes (may carry an image
          rect as type 3 does).  Uncompressed.
    0x03  texture: +0x0c u16 clutX, clutY, +0x10 u16 colours, palettes, +0x14 u16 imageX, imageY,
          +0x18 u16 width (in 16-bit VRAM words), height, +0x24 u16 bitfield size.  Compressed.
    0x05  sound bank for effects (see bank.py): +0x0c u16 slot, u16 bank id, +0x14 u32 header
          size, +0x18 u32 sample bytes, +0x1c u16 programs, +0x1e u8 volume.
    0x0e  sound bank for music, same layout as 0x05.
    0x08  music sequence(s), uncompressed (see seq.py): +0x16 u16 BGM id, +0x18 u16 count.
    0x0f  as 0x08 (two entries on the disc).
    0x10  music sequence(s), compressed; +0x10 u32 bitfield size, otherwise as 0x08.
    0x09, 0x0c, 0x0d  compressed stage data (0x0d = stage geometry/tiles); +0x10 u32 bitfield size.
    0x0a  scene data (object placement / scripts), uncompressed.
    0x12  per-stage table (uncompressed).
    0x15  STAFF.BIN stream chunks (staff roll), size may be 0.

Compression (type 3 with a bitfield size at +0x24; types 9, 0xc, 0xd, 0x10 with it at +0x10):
the payload starts with a bitfield
of `bitfield size` bytes, read as little-endian 32-bit words, most significant bit first; one
bit per following 16-bit word.  Bit 0: the word is copied to the output.  Bit 1: if the word is
0xFFFF the window base advances by 0x2000 bytes, otherwise the word is a back reference:
byte offset `window + (word >> 3)`, length `(word & 7) + 2` words.

Format facts come from the DashGL notes (https://docs.dashgl.com/format/psx/megaman-legends-2/)
and were re-derived and verified here against the disc; no code was copied.
"""
import struct
import sys

HEADER = 0x30
PAGE = 0x800


def decompress(data, off, size, bitfield_size):
    """Returns (bytes, end offset in `data`)."""
    p = off + bitfield_size
    out = bytearray()
    window = 0
    bit = 0
    nbits = bitfield_size * 8
    while len(out) < size:
        if bit >= nbits:
            raise ValueError('bitfield exhausted at output 0x%x' % len(out))
        if bit & 31 == 0:
            flags = struct.unpack_from('<I', data, off + (bit >> 5) * 4)[0]
        is_ref = (flags >> (31 - (bit & 31))) & 1
        bit += 1
        word = data[p] | data[p + 1] << 8
        p += 2
        if not is_ref:
            out.append(word & 255)
            out.append(word >> 8)
        elif word == 0xFFFF:
            window += 0x2000
        else:
            src = window + (word >> 3)
            n = ((word & 7) + 2) * 2
            if src >= len(out):
                raise ValueError('bad back reference 0x%x at output 0x%x' % (src, len(out)))
            for i in range(n):
                out.append(out[src + i])
    return bytes(out[:size]), p


class Entry:
    __slots__ = ('index', 'offset', 'type', 'size', 'id', 'header', 'data', 'stored', 'compressed')

    def u16(self, off):
        return struct.unpack_from('<H', self.header, off)[0]

    def u32(self, off):
        return struct.unpack_from('<I', self.header, off)[0]


KNOWN_TYPES = set(range(0, 0x20))
COMPRESSED_AT_10 = (0x09, 0x0c, 0x0d, 0x10)  # bitfield size is a u32 at +0x10 for these types


def plausible(data, off):
    if off + HEADER > len(data):
        return False
    t, size = struct.unpack_from('<II', data, off)
    return t in KNOWN_TYPES and size < 0x400000 and (size > 0 or t == 0x15)


def entries(data, strict=False):
    """Yield every entry of an archive."""
    off = 0
    index = 0
    while off + HEADER <= len(data):
        if not plausible(data, off):
            if strict and any(data[off:off + HEADER]):
                raise ValueError('unrecognised header at 0x%x' % off)
            off += PAGE
            continue
        e = Entry()
        e.index = index
        e.offset = off
        e.header = data[off:off + HEADER]
        e.type, e.size, e.id = struct.unpack_from('<III', data, off)
        if e.type == 3:
            bitfield = e.u16(0x24)
        elif e.type in COMPRESSED_AT_10:
            bitfield = e.u32(0x10)
        else:
            bitfield = 0
        e.compressed = bitfield != 0 and e.size > 0
        if e.compressed:
            e.data, end = decompress(data, off + HEADER, e.size, bitfield)
        else:
            end = off + HEADER + e.size
            e.data = data[off + HEADER:end]
        e.stored = end - off - HEADER
        yield e
        index += 1
        off = (end + PAGE - 1) & ~(PAGE - 1)


def main():
    for path in sys.argv[1:]:
        data = open(path, 'rb').read()
        print(path, len(data))
        for e in entries(data):
            print('  #%-2d @%06x type %x size %6x stored %6x id %x  %s' % (
                e.index, e.offset, e.type, e.size, e.stored, e.id, e.header[0x0c:0x28].hex()))


if __name__ == '__main__':
    main()
