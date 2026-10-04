#!/usr/bin/env python3
"""Mega Man Legends 2 (PSX) textures -> PNG.

Usage:
    python3 tools/mml2/textures.py <disc dir> <out dir>      # e.g. $S/disc build/mml2/textures

Texture entries of a `.BIN` archive (see archive.py for the container):

    type 2  uncompressed.  Either a palette only (image width/height are 0; payload = the
            colours), or palette + image: the palette sits at payload +0 and the pixels start at
            payload +0x7d0 (i.e. on the next CD sector; the gap is zero).
    type 3  compressed.  Payload = palette immediately followed by the pixels.

    header +0x0c u16 clutX, clutY      where the palette is uploaded in VRAM
           +0x10 u16 colours, rows     palette is `colours` x `rows` 16-bit words
           +0x14 u16 imageX, imageY    where the pixels are uploaded in VRAM
           +0x18 u16 width, height     width in 16-bit VRAM words

Colours are PSX 15-bit: r = bits 0-4, g = 5-9, b = 10-14, bit 15 = semi-transparency flag;
the word 0x0000 is fully transparent.

Bits per pixel are not stored.  Rule used here (confirmed on the disc: for every entry with
16..128 colours the pixel bytes exceed the colour count, so they cannot be 8-bit indices):
colours < 256 -> 4bpp, with colours/16 sub-palettes per row; colours == 256 or no palette ->
decided per image by comparing horizontal run statistics of the 4-bit and 8-bit readings.

Output per archive: one palette-mode PNG per image per embedded sub-palette
(`eNNN_pK.png`), a greyscale PNG for images without a palette, `vram.png` (the 1024x512 VRAM
after uploading every entry of the archive in order, shown as direct 15-bit colour) and
`vram.u16` (the same as raw little-endian words, for tools).  `index.json` lists everything.

Header layout and compression facts: DashGL notes (docs.dashgl.com, "Mega Man Legends 2 /
Textures"); the type 2 +0x7d0 image offset, the palette row count and the bpp rule were worked
out here against the disc.
"""
import glob
import json
import os
import struct
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import archive  # noqa: E402

VRAM_W, VRAM_H = 1024, 512


class Tex:
    """One texture/palette entry."""

    def __init__(self, e):
        self.entry = e
        (self.clut_x, self.clut_y, self.colours, self.rows,
         self.img_x, self.img_y, self.w, self.h) = struct.unpack_from('<8H', e.header, 0x0c)
        npal = self.colours * self.rows * 2
        self.palette = np.frombuffer(e.data[:npal], dtype='<u2').reshape(self.rows, self.colours) \
            if npal else np.zeros((0, 0), dtype='<u2')
        if self.w * self.h:
            start = 0x7d0 if e.type == 2 else npal
            self.pixels = e.data[start:start + self.w * 2 * self.h]
            assert len(self.pixels) == self.w * 2 * self.h
        else:
            self.pixels = b''

    @property
    def has_image(self):
        return bool(self.pixels)

    def bpp(self):
        if not self.has_image:
            return 0
        if 0 < self.colours < 256:
            return 4
        raw = np.frombuffer(self.pixels, dtype=np.uint8)
        nib = np.empty(raw.size * 2, dtype=np.uint8)
        nib[0::2] = raw & 15
        nib[1::2] = raw >> 4
        eq8 = np.count_nonzero(raw[1:] == raw[:-1]) / raw.size
        eq4 = np.count_nonzero(nib[1:] == nib[:-1]) / nib.size
        return 8 if eq8 > eq4 + 0.05 else 4

    def indices(self, bpp):
        raw = np.frombuffer(self.pixels, dtype=np.uint8).reshape(self.h, self.w * 2)
        if bpp == 8:
            return raw
        out = np.empty((self.h, self.w * 4), dtype=np.uint8)
        out[:, 0::2] = raw & 15
        out[:, 1::2] = raw >> 4
        return out


def rgba_table(words):
    """15-bit PSX colours -> (n, 4) uint8 RGBA."""
    w = np.asarray(words, dtype=np.uint32)
    out = np.empty((w.size, 4), dtype=np.uint8)
    for i, shift in enumerate((0, 5, 10)):
        c = (w >> shift) & 31
        out[:, i] = (c << 3) | (c >> 2)
    out[:, 3] = np.where(w == 0, 0, 255)
    return out


class Vram:
    def __init__(self):
        self.words = np.zeros((VRAM_H, VRAM_W), dtype='<u2')

    def upload(self, tex):
        if tex.palette.size:
            y, x = tex.clut_y, tex.clut_x
            r, c = tex.palette.shape
            r, c = min(r, VRAM_H - y), min(c, VRAM_W - x)
            self.words[y:y + r, x:x + c] = tex.palette[:r, :c]
        if tex.has_image:
            img = np.frombuffer(tex.pixels, dtype='<u2').reshape(tex.h, tex.w)
            h, w = min(tex.h, VRAM_H - tex.img_y), min(tex.w, VRAM_W - tex.img_x)
            self.words[tex.img_y:tex.img_y + h, tex.img_x:tex.img_x + w] = img[:h, :w]

    def load_archive(self, data):
        for e in archive.entries(data):
            if e.type in (2, 3):
                self.upload(Tex(e))
        return self

    def page(self, page_x, page_y, clut_x, clut_y, bpp=4, size=256):
        """RGBA (size, size, 4) of the texture page at VRAM (page_x, page_y) through a CLUT."""
        if bpp == 4:
            raw = self.words[page_y:page_y + size, page_x:page_x + size // 4]
            idx = np.empty((raw.shape[0], raw.shape[1] * 4), dtype=np.uint8)
            for k in range(4):
                idx[:, k::4] = (raw >> (4 * k)) & 15
            n = 16
        else:
            raw = self.words[page_y:page_y + size, page_x:page_x + size // 2]
            idx = np.empty((raw.shape[0], raw.shape[1] * 2), dtype=np.uint8)
            idx[:, 0::2] = raw & 255
            idx[:, 1::2] = raw >> 8
            n = 256
        clut = rgba_table(self.words[clut_y, clut_x:clut_x + n])
        if clut.shape[0] < n:
            clut = np.vstack([clut, np.zeros((n - clut.shape[0], 4), dtype=np.uint8)])
        return clut[idx]

    def image(self):
        return Image.fromarray(rgba_table(self.words.reshape(-1)).reshape(VRAM_H, VRAM_W, 4)[:, :, :3])


def save_indexed(path, idx, colours):
    """Palette PNG; `colours` are 15-bit words (None -> greyscale ramp)."""
    im = Image.fromarray(np.ascontiguousarray(idx), 'P')
    n = 256 if idx.max(initial=0) > 15 else 16
    if colours is None:
        step = 255 // (n - 1)
        im.putpalette(sum(([i * step] * 3 for i in range(n)), []))
        im.save(path, optimize=False)
        return
    table = rgba_table(colours)
    pal = np.zeros((n, 3), dtype=np.uint8)
    alpha = np.full(n, 255, dtype=np.uint8)
    k = min(n, table.shape[0])
    pal[:k] = table[:k, :3]
    alpha[:k] = table[:k, 3]
    im.putpalette(pal.reshape(-1).tolist())
    im.save(path, transparency=bytes(alpha.tolist()), optimize=False)


def export_archive(path, out_root):
    name = os.path.splitext(os.path.basename(path))[0]
    data = open(path, 'rb').read()
    texs = [Tex(e) for e in archive.entries(data) if e.type in (2, 3)]
    if not texs:
        return None
    out = os.path.join(out_root, name)
    os.makedirs(out, exist_ok=True)
    vram = Vram()
    records = []
    for t in texs:
        vram.upload(t)
        e = t.entry
        rec = {'entry': e.index, 'offset': e.offset, 'type': e.type,
               'clut': {'x': t.clut_x, 'y': t.clut_y, 'colours': t.colours, 'rows': t.rows}
               if t.palette.size else None}
        if t.has_image:
            bpp = t.bpp()
            idx = t.indices(bpp)
            rec['image'] = {'x': t.img_x, 'y': t.img_y, 'vram_words': t.w, 'height': t.h,
                            'bpp': bpp, 'width': idx.shape[1]}
            pngs = []
            per = 16 if bpp == 4 else 256
            flat = t.palette.reshape(-1)
            if flat.size:
                for k in range(max(1, flat.size // per)):
                    fn = 'e%03d_p%d.png' % (e.index, k)
                    save_indexed(os.path.join(out, fn), idx, flat[k * per:(k + 1) * per])
                    pngs.append(fn)
            else:
                fn = 'e%03d_grey.png' % e.index
                save_indexed(os.path.join(out, fn), idx, None)
                pngs.append(fn)
            rec['png'] = pngs
        records.append(rec)
    vram.image().save(os.path.join(out, 'vram.png'))
    return {'archive': os.path.relpath(path, os.path.dirname(os.path.dirname(path))),
            'dir': name, 'entries': records}


def main():
    disc, out_root = sys.argv[1], sys.argv[2]
    os.makedirs(out_root, exist_ok=True)
    index = []
    images = pngs = palettes = 0
    for path in sorted(glob.glob(os.path.join(disc, '*', '*.BIN'))):
        rec = export_archive(path, out_root)
        if rec:
            index.append(rec)
            for r in rec['entries']:
                if 'image' in r:
                    images += 1
                    pngs += len(r['png'])
                else:
                    palettes += 1
    with open(os.path.join(out_root, 'index.json'), 'w') as f:
        json.dump({'archives': index}, f, indent=1)
    print('%d archives, %d images -> %d PNGs, %d palette-only entries' % (
        len(index), images, pngs, palettes))


if __name__ == '__main__':
    main()
