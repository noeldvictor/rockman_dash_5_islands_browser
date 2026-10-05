#!/usr/bin/env python3
"""Install the remade models for the game: build/ai/models/ -> web/public/remake/.

    .venv/bin/python tools/ai/install_remake.py [name ...] [--texture 1024]

For every model that has been remade (build/ai/models/<name>/model.glb, see remake.py):

  - fit it to the phone model it replaces (same bounding box; which way it faces is found by
    comparing pictures of the two from three sides, in web/modelview.html);
  - shrink its texture (Tripo's are 4096x4096; the handhelds want far less);
  - write web/public/remake/<name>.glb and list it in manifest.json with the fit matrix, and
    build/ai/models/<name>/fit.png: the phone model above, the fitted one below, to check.

The host (web/src/mods/remake.js) draws these in place of the phone models when the folder is
there. Like everything derived from the game, the folder is git-ignored. Needs the dev server.
"""
import argparse
import base64
import io
import json
import os
import struct
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import phone_models  # noqa: E402

ROOT = phone_models.ROOT
SRC = phone_models.OUT
DST = os.path.join(ROOT, 'web', 'public', 'remake')


def shrink(glb, limit):
    """The .glb with every embedded picture scaled down to at most `limit` pixels a side."""
    length = struct.unpack_from('<I', glb, 12)[0]
    doc = json.loads(glb[20:20 + length])
    blob = glb[20 + length + 8:]
    views = doc['bufferViews']
    pictures = {im['bufferView']: im for im in doc.get('images', []) if 'bufferView' in im}
    out = bytearray()
    for i, view in enumerate(views):
        data = blob[view.get('byteOffset', 0):view.get('byteOffset', 0) + view['byteLength']]
        if i in pictures:
            im = Image.open(io.BytesIO(data))
            if max(im.size) > limit:
                im = im.resize((max(1, im.width * limit // max(im.size)), max(1, im.height * limit // max(im.size))), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, 'PNG', optimize=True)
            data = buf.getvalue()
            pictures[i]['mimeType'] = 'image/png'
        while len(out) % 4:
            out.append(0)
        view['byteOffset'] = len(out)
        view['byteLength'] = len(data)
        out += data
    while len(out) % 4:
        out.append(0)
    doc['buffers'] = [{'byteLength': len(out)}]
    text = json.dumps(doc, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    total = 12 + 8 + len(text) + 8 + len(out)
    return (struct.pack('<4sII', b'glTF', 2, total) + struct.pack('<I4s', len(text), b'JSON') + text
            + struct.pack('<I4s', len(out), b'BIN\0') + bytes(out))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('names', nargs='*')
    ap.add_argument('--texture', type=int, default=1024)
    ap.add_argument('--url', default='http://localhost:5173/modelview.html')
    args = ap.parse_args()
    names = args.names or sorted(n for n in os.listdir(SRC) if os.path.exists(os.path.join(SRC, n, 'model.glb')))
    os.makedirs(DST, exist_ok=True)
    path = os.path.join(DST, 'manifest.json')
    manifest = json.load(open(path)) if os.path.exists(path) else {'models': {}}
    # one phone model -> a list of remade ones (one per texture it is drawn with)
    manifest['models'] = {k: v if isinstance(v, list) else [v] for k, v in manifest['models'].items()}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        page = browser.new_page()
        page.goto(args.url)
        page.wait_for_function('window.modelviewReady === true')
        for name in names:
            phone = phone_models.model_file(name)
            if not phone:
                print('no phone model called', name)
                continue
            glb = open(os.path.join(SRC, name, 'model.glb'), 'rb').read()
            small = shrink(glb, args.texture)
            stem, variant = phone_models.split(name)
            info = page.evaluate('(o) => window.modelInfo(o)', {'model': phone_models.b64(phone_models.find(phone))})
            if info['bones'] > 1:
                print(f"{name}: the phone model bends ({info['bones']} bones); only rigid models can be installed so far")
                continue
            sets = phone_models.texture_sets(phone, info['textures'])
            files = sets.get(variant) if variant else next(iter(sets.values()))
            fit = page.evaluate('(o) => window.fitGlb(o)', {
                'model': phone_models.b64(phone_models.find(phone)),
                'textures': [phone_models.b64(t) for t in files],
                'glb': base64.b64encode(small).decode(),
            })
            # phone model above, fitted model below, from two opposite corners: they should agree
            tiles = [Image.open(io.BytesIO(base64.b64decode(u.split(',')[1]))).convert('RGB') for u in fit['pictures']]
            check = Image.new('RGB', (1024, 1024), 'white')
            for i, tile in enumerate(tiles):
                check.paste(tile, ((i % 2) * 512, (i // 2) * 512))
            check.save(os.path.join(SRC, name, 'fit.png'))
            open(os.path.join(DST, f'{name}.glb'), 'wb').write(small)
            entry = {'url': f'{name}.glb', 'fit': fit['matrix']}
            if variant:
                entry['texture'] = os.path.basename(files[0])  # this model is for that texture only
            entries = [e for e in manifest['models'].get(phone, []) if e['url'] != entry['url']]
            manifest['models'][phone] = entries + [entry]
            print(f"{name}: turned {fit['turn'] * 90} degrees (difference {fit['score']:.1f}), "
                  f"{len(glb) // 1024} KB -> {len(small) // 1024} KB; check {os.path.join(SRC, name, 'fit.png')}")
        browser.close()
    json.dump(manifest, open(path, 'w'), indent=1)
    print('wrote', path)


if __name__ == '__main__':
    main()
