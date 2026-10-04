#!/usr/bin/env python3
"""Contact sheets of the model previews written by models.py, for identifying entities by eye.

Usage:
    python3 tools/mml2/contact.py <models dir> [min bones [max bones]]   # e.g. build/mml2/models 8

Identical previews (the same entity reused in several scenes) are shown once; the label is the
first archive it appears in, the entity id, and its bone / animation counts.  Writes
`<models dir>/contact_b<min>-<max>_NN.png` and `<models dir>/unique.json` (preview hash -> every occurrence).
"""
import hashlib
import json
import os
import sys

from PIL import Image, ImageDraw

CELL, COLS, ROWS = 192, 8, 5


def main():
    root = sys.argv[1]
    min_bones = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    max_bones = int(sys.argv[3]) if len(sys.argv) > 3 else 99
    index = json.load(open(os.path.join(root, 'index.json')))
    unique = {}
    for r in index:
        if 'error' in r or r.get('kind') == 'player':
            continue
        h = hashlib.md5(open(os.path.join(root, r['preview']), 'rb').read()).hexdigest()
        unique.setdefault(h, []).append(r)
    with open(os.path.join(root, 'unique.json'), 'w') as f:
        json.dump({h: [{'glb': r['glb'], 'id': r['id']} for r in v] for h, v in unique.items()}, f, indent=1)
    items = [v[0] for v in unique.values() if min_bones <= v[0]['bones'] <= max_bones]
    items.sort(key=lambda r: (r['archive'], r['entry'], r['index']))
    per = COLS * ROWS
    for page in range((len(items) + per - 1) // per):
        sheet = Image.new('RGB', (COLS * CELL, ROWS * (CELL + 14)), (20, 20, 24))
        draw = ImageDraw.Draw(sheet)
        for k, r in enumerate(items[page * per:(page + 1) * per]):
            x, y = (k % COLS) * CELL, (k // COLS) * (CELL + 14)
            sheet.paste(Image.open(os.path.join(root, r['preview'])), (x, y + 14))
            draw.text((x + 2, y + 2), '%s %s b%d a%d' % (r['archive'], r['id'][2:], r['bones'], r['animations']),
                      fill=(255, 255, 120))
        sheet.save(os.path.join(root, 'contact_b%d-%d_%02d.png' % (min_bones, max_bones, page)))
    print('%d entities, %d unique previews, %d shown on %d sheets' % (
        sum(len(v) for v in unique.values()), len(unique), len(items), (len(items) + per - 1) // per))


if __name__ == '__main__':
    main()
