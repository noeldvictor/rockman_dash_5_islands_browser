#!/usr/bin/env python3
"""Install the remade models for the game: build/ai/models/ -> web/public/remake/.

    .venv/bin/python tools/ai/install_remake.py [name ...] [--texture 1024]
    .venv/bin/python tools/ai/install_remake.py b02_2=b02_1      b02_1's model for b02_2 too

For every model that has been remade (build/ai/models/<name>/model.glb, see remake.py):

  - fit it to the phone model it replaces (same bounding box; which way it faces is found by
    comparing pictures of the two from three sides, in web/modelview.html);
  - shrink its texture (Tripo's are 4096x4096; the handhelds want far less);
  - write web/public/remake/<name>.glb and list it in manifest.json with the fit matrix, and
    build/ai/models/<name>/fit.png: the phone model above, the fitted one below, to check;
    for a model that moves in pieces also poses.png: both in a few poses of the phone animation.

A phone model made of several rigid pieces also gets, per vertex, the piece it moves with
(`skin`), and one the game draws in several colours gets the new picture recoloured for each.

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
            if im.mode in ('RGBA', 'LA', 'P') and im.convert('RGBA').getextrema()[3][0] < 255:
                im.save(buf, 'PNG', optimize=True)  # it has transparency: keep it
                pictures[i]['mimeType'] = 'image/png'
            else:
                im.convert('RGB').save(buf, 'JPEG', quality=90)
                pictures[i]['mimeType'] = 'image/jpeg'
            data = buf.getvalue()
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


def picture_of(glb):
    """The first picture embedded in a .glb, as an RGB image."""
    length = struct.unpack_from('<I', glb, 12)[0]
    doc = json.loads(glb[20:20 + length])
    blob = glb[20 + length + 8:]
    view = doc['bufferViews'][doc['images'][0]['bufferView']]
    start = view.get('byteOffset', 0)
    return Image.open(io.BytesIO(blob[start:start + view['byteLength']])).convert('RGB')


def to_hsv(rgb):
    """RGB 0..255 (n x 3 float) -> hue 0..360, saturation 0..1, value 0..1."""
    import numpy as np
    c = rgb / 255.0
    v = c.max(axis=1)
    d = v - c.min(axis=1)
    s = np.where(v > 0, d / np.maximum(v, 1e-6), 0)
    safe = np.maximum(d, 1e-6)
    r, g, b = c[:, 0], c[:, 1], c[:, 2]
    h = np.where(v == r, (g - b) / safe % 6, np.where(v == g, (b - r) / safe + 2, (r - g) / safe + 4)) * 60
    return np.where(d > 0, h % 360, 0), s, v


def to_rgb(h, s, v):
    import numpy as np
    k = (np.stack([5, 3, 1])[None, :] + (h / 60)[:, None]) % 6
    return 255 * (v[:, None] - (v * s)[:, None] * np.clip(np.minimum(k, 4 - k), 0, 1))


def recolour(picture, base, target):
    """`picture` (painted after the phone texture `base`) in the colours of the phone texture `target`.

    The game recolours a model by swapping its texture for one with the same drawing in other
    colours. The remade model's picture is a different drawing, so the change is carried over
    as colour: from the two phone textures, how each hue is turned, and how much more or less
    saturated and bright it becomes; a texel of the new picture gets the change of the phone
    hues nearest its own, in proportion to how coloured it is (greys stay grey).
    """
    import numpy as np
    from textures import decode_bmp
    i0, p0 = decode_bmp(open(base, 'rb').read())
    i1, p1 = decode_bmp(open(target, 'rb').read())
    if i0.shape != i1.shape:
        return None
    pairs, counts = np.unique(np.concatenate([p0[i0].reshape(-1, 3), p1[i1].reshape(-1, 3)], axis=1), axis=0, return_counts=True)
    pairs = pairs.astype(np.float32)
    h0, s0, v0 = to_hsv(pairs[:, :3])
    h1, s1, v1 = to_hsv(pairs[:, 3:])
    coloured = (s0 > 0.2) & (v0 > 0.15)
    if not coloured.any():
        return picture
    h0, s0, v0, h1, s1, v1, weight = (a[coloured] for a in (h0, s0, v0, h1, s1, v1, np.sqrt(counts.astype(np.float32))))
    # per degree of hue: the turn, and the change of saturation and value, of the phone hues around it
    bins = np.arange(360, dtype=np.float32)
    away = np.abs((bins[:, None] - h0[None, :] + 180) % 360 - 180)
    w = weight[None, :] * np.exp(-(away - away.min(axis=1, keepdims=True)) ** 2 / (2 * 18.0 ** 2))
    w /= w.sum(axis=1, keepdims=True)
    turn = np.deg2rad((h1 - h0 + 180) % 360 - 180)
    turn = np.rad2deg(np.arctan2((w * np.sin(turn)[None]).sum(1), (w * np.cos(turn)[None]).sum(1)))
    more = (w * np.clip(s1 / np.maximum(s0, 0.05), 0, 3)[None]).sum(1)
    lighter = (w * np.clip(v1 / np.maximum(v0, 0.05), 0.3, 3)[None]).sum(1)
    h, sat, val = to_hsv(np.asarray(picture, np.float32).reshape(-1, 3))
    at = np.clip(h.astype(int), 0, 359)
    t = np.clip((sat - 0.08) / 0.22, 0, 1)
    t = t * t * (3 - 2 * t)
    out = to_rgb((h + t * turn[at]) % 360, np.clip(sat * (1 + t * (more[at] - 1)), 0, 1), np.clip(val * (1 + t * (lighter[at] - 1)), 0, 1))
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8).reshape(picture.height, picture.width, 3))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('names', nargs='*')
    ap.add_argument('--texture', type=int, default=1024)
    ap.add_argument('--url', default='http://localhost:5173/modelview.html')
    args = ap.parse_args()
    names = args.names or sorted(n for n in os.listdir(SRC) if os.path.exists(os.path.join(SRC, n, 'model.glb')))
    if not args.names:
        # twins noted by an earlier run: build/ai/models/<name>/skip holds "=<source>"
        for n in sorted(os.listdir(SRC)):
            marker = os.path.join(SRC, n, 'skip')
            if os.path.exists(marker):
                source = open(marker).read().strip().lstrip('=')
                if source and os.path.exists(os.path.join(SRC, source, 'model.glb')):
                    names.append(f'{n}={source}')
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
            # "b02_2=b02_1": the phone model b02_2 gets the model made for b02_1 (a mirrored twin)
            name, _, source = name.partition('=')
            source = source or name
            phone = phone_models.model_file(name)
            if not phone:
                print('no phone model called', name)
                continue
            glb = open(os.path.join(SRC, source, 'model.glb'), 'rb').read()
            small = shrink(glb, args.texture)
            stem, variant = phone_models.split(name)
            info = page.evaluate('(o) => window.modelInfo(o)', {'model': phone_models.b64(phone_models.find(phone))})
            sets = phone_models.texture_sets(phone, info['textures'])
            files = sets.get(variant) if variant else next(iter(sets.values()))
            fit = page.evaluate('(o) => window.fitGlb(o)', {
                'model': phone_models.b64(phone_models.find(phone)),
                'textures': [phone_models.b64(t) for t in files],
                'glb': base64.b64encode(small).decode(),
                'mirror': source != name,
            })
            # phone model above, fitted model below, from two opposite corners: they should agree
            tiles = [Image.open(io.BytesIO(base64.b64decode(u.split(',')[1]))).convert('RGB') for u in fit['pictures']]
            check = Image.new('RGB', (1024, 1024), 'white')
            for i, tile in enumerate(tiles):
                check.paste(tile, ((i % 2) * 512, (i // 2) * 512))
            os.makedirs(os.path.join(SRC, name), exist_ok=True)
            check.save(os.path.join(SRC, name, 'fit.png'))
            open(os.path.join(DST, f'{source}.glb'), 'wb').write(small)
            entry = {'url': f'{source}.glb', 'fit': fit['matrix']}
            if fit.get('flat'):
                entry['flat'] = True  # a panel: drawn like the phone's, see mods/remake.js
            if fit.get('skin'):
                # the phone model is several rigid pieces: which one each vertex follows
                entry['skin'] = fit['skin']
                entry['bones'] = fit['bones']
                if fit.get('hidden'):
                    entry['hidden'] = fit['hidden']  # pieces the model lacks; the game draws the phone's
                # for checking by eye: both models in a few poses of the phone animation
                poses = phone_models.poses_of(stem)
                if poses:
                    shots = page.evaluate('(o) => window.poseCheck(o)', {
                        'model': phone_models.b64(phone_models.find(phone)),
                        'textures': [phone_models.b64(t) for t in files],
                        'glb': base64.b64encode(small).decode(),
                        'fit': fit['matrix'], 'skin': fit['skin'], 'poses': poses,
                    })
                    if shots:
                        tiles = [Image.open(io.BytesIO(base64.b64decode(u.split(',')[1]))).convert('RGB') for u in shots]
                        sheet = Image.new('RGB', (384 * (len(tiles) // 2), 768), 'white')
                        for i, tile in enumerate(tiles):
                            sheet.paste(tile, ((i // 2) * 384, (i % 2) * 384))
                        sheet.save(os.path.join(SRC, name, 'poses.png'))
            extra = []
            if variant:
                entry['texture'] = os.path.basename(files[0])  # this model is for that texture only
            elif len(sets) > 1:
                # the game draws this model with several textures (an enemy in three colours):
                # the model was made from the first; the others get its picture recoloured
                entry['texture'] = os.path.basename(files[0])
                for other, other_files in list(sets.items())[1:]:
                    if os.path.exists(os.path.join(SRC, f'{stem}@{other}', 'model.glb')):
                        continue  # that one has been remade on its own
                    picture = recolour(picture_of(small), files[0], other_files[0])
                    if picture is None:
                        continue
                    picture.save(os.path.join(DST, f'{stem}@{other}.jpg'), quality=90)
                    extra.append({**entry, 'texture': os.path.basename(other_files[0]), 'map': f'{stem}@{other}.jpg'})
            entries = [e for e in manifest['models'].get(phone, []) if e['url'] != entry['url']]
            manifest['models'][phone] = entries + [entry] + extra
            print(f"{name}: {'the model of ' + source + ', ' if source != name else ''}"
                  f"turned {fit['turn'] * 90} degrees{' and mirrored' if fit.get('mirrored') else ''} (difference {fit['score']:.1f}), "
                  f"{'moves in ' + str(fit['bones']) + ' pieces, ' if fit.get('skin') else ''}"
                  f"{'hidden pieces ' + str(fit['hidden']) + ', ' if fit.get('hidden') else ''}"
                  f"{str(len(extra)) + ' recolour(s), ' if extra else ''}"
                  f"{len(glb) // 1024} KB -> {len(small) // 1024} KB; check {os.path.join(SRC, name, 'fit.png')}")
        browser.close()
    json.dump(manifest, open(path, 'w'), indent=1)
    print('wrote', path)


if __name__ == '__main__':
    main()
