#!/usr/bin/env python3
"""Render the phone game's models to pictures (references for the AI model remake).

    .venv/bin/python tools/ai/phone_models.py [name ...] [--views hero|front|turn|sheet] [--size 1024]

Needs the dev server (cd web && npm run dev) and the unpacked game data (tools/extract_assets.py).
Pictures go to build/ai/models/<name>/phone_<view>.png; `--views sheet` instead writes one
contact sheet of every model, build/ai/models/phone_sheet.png, for choosing by eye.

The rendering is done by web/modelview.html (the game's own parsers on three.js) in Playwright's
Chromium. Which texture files belong to a model follows the game's naming, see textures_of().
"""
import argparse
import base64
import glob
import os
import re

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ASSETS = os.path.join(ROOT, 'build', 'assets')
OUT = os.path.join(ROOT, 'build', 'ai', 'models')
VIEWS = {'front': [[0, 8]], 'hero': [[28, 12]], 'turn': [[0, 0], [90, 0], [180, 0], [270, 0]], 'sheet': [[25, 12]]}


def find(name):
    """Every copy of a game data file is the same; take the first."""
    for pattern in ('localized/jar', 'localized/sp/data', 'sdcard/*'):
        hits = sorted(glob.glob(os.path.join(ASSETS, pattern, name)))
        if hits:
            return hits[0]
    return None


def models():
    names = set()
    for pattern in ('localized/jar', 'localized/sp/data', 'sdcard/*'):
        for f in glob.glob(os.path.join(ASSETS, pattern, '*.mba*')):
            names.add(os.path.basename(f))
    return sorted(names)


def split(name):
    """'o07@02' -> ('o07', '02'): a model drawn with one particular texture of several."""
    stem, _, variant = name.split('.')[0].partition('@')
    return stem, variant or None


def model_file(name):
    stem = split(name)[0]
    return next((m for m in models() if m.split('.')[0] == stem), None)


def texture_sets(model, count):
    """The texture sets a model is drawn with: {variant or None: [files in texture-index order]}.

    A model that uses `count` textures and has more numbered files than that is one the game
    reuses with a different picture each time (doors, wall pieces, recoloured enemies).
    """
    files = textures_of(model)
    if count == 1 and len(files) > 1:
        return {os.path.basename(f).rsplit('_', 1)[1].split('.')[0]: [f] for f in files}
    return {None: files[:max(count, 1)]}


def textures_of(model):
    """Texture files of a model, in texture-index order (the game's naming convention)."""
    stem = model.split('.')[0]
    m = re.match(r'e(\d\d)_\d', stem)
    if m:  # enemies share one sheet per group of three
        n = int(m.group(1))
        stem = 'e0002' if n <= 2 else 'e0305' if n <= 5 else 'e0608'
    m = re.match(r'(b\d\d)_\d', stem)
    if m:  # every form of a boss uses the boss's sheet
        stem = m.group(1)
    if stem.startswith('r_'):  # the player's parts
        stem = 'rock'
    numbered = [f for f in (find(f'{stem}_{i:02d}.bmp') for i in range(8)) if f]
    if numbered:
        return numbered
    single = find(f'{stem}.bmp')
    return [single] if single else []


def poses_of(stem, limit=6):
    """A few poses of a model's animations: [{action: base64 action table, index, where}].

    A character has one table <name>.mtr(a) with several actions; an enemy or boss part
    <e|b><NN>_<part> has one file per action, <e|b><NN>_<action>_<part>.mtr.
    """
    m = re.fullmatch(r'([be]\d\d)_(\d)', stem)
    if m:
        files = sorted({os.path.basename(f): f for pattern in ('localized/jar', 'localized/sp/data', 'sdcard/*')
                        for f in glob.glob(os.path.join(ASSETS, pattern, f'{m.group(1)}_??_{m.group(2)}.mtr'))}.values())
        return [{'action': b64(f), 'index': 0, 'where': 0.5} for f in files[:limit]]
    table = find(stem + '.mtr') or find(stem + '.mtra')
    return [{'action': b64(table), 'index': i, 'where': 0.5} for i in range(limit)] if table else []


def b64(path):
    with open(path, 'rb') as f:
        return base64.b64encode(f.read()).decode()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('names', nargs='*')
    ap.add_argument('--views', default='hero', choices=VIEWS)
    ap.add_argument('--size', type=int, default=1024)
    ap.add_argument('--variants', action='store_true', help='every texture variant of the named models')
    ap.add_argument('--url', default='http://localhost:5173/modelview.html')
    args = ap.parse_args()
    names = args.names or models()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        page = browser.new_page()
        page.goto(args.url)
        page.wait_for_function('window.modelviewReady === true')
        sheet = []
        todo = []
        for name in names:
            phone = model_file(name)
            if not phone:
                print('missing', name)
                continue
            info = page.evaluate('(o) => window.modelInfo(o)', {'model': b64(find(phone))})
            sets = texture_sets(phone, info['textures'])
            stem, variant = split(name)
            if variant:
                todo.append((f'{stem}@{variant}', phone, sets.get(variant, [])))
            elif args.views == 'sheet' or args.variants:
                todo += [(stem if v is None else f'{stem}@{v}', phone, files) for v, files in sets.items()]
            else:
                todo.append((stem, phone, next(iter(sets.values()))))
        for label, name, files in todo:
            path = find(name)
            options = {'model': b64(path), 'textures': [b64(t) for t in files],
                       'views': VIEWS[args.views], 'size': 256 if args.views == 'sheet' else args.size}
            # a character's face is one of several polygon groups, chosen by its animation:
            # without one the head is drawn with no face at all
            action = find(name.split('.')[0] + '.mtr') or find(name.split('.')[0] + '.mtra')
            if action and info['patterns'] > 1:
                options.update(action=b64(action), actionIndex=0, frame=0)
            try:
                urls = page.evaluate('(o) => window.renderPhoneModel(o)', options)
                info = page.evaluate('(o) => window.modelInfo(o)', {'model': options['model']})
            except Exception as e:
                print('failed', name, str(e)[:200])
                continue
            stem = label
            if args.views == 'sheet':
                sheet.append((stem, base64.b64decode(urls[0].split(',')[1]), info))
                continue
            os.makedirs(os.path.join(OUT, stem), exist_ok=True)
            for (yaw, _), url in zip(VIEWS[args.views], urls):
                view = {0: 'front', 28: 'hero', 90: 'left', 180: 'back', 270: 'right'}.get(yaw, str(yaw))
                if args.views == 'turn':
                    view = 'view_' + view
                out = os.path.join(OUT, stem, f'phone_{view}.png')
                with open(out, 'wb') as f:
                    f.write(base64.b64decode(url.split(',')[1]))
            print(f"{stem}: {info['triangles']} triangles, {info['bones']} bones, {len(options['textures'])} textures -> {os.path.join(OUT, stem)}")
        browser.close()
    if sheet:
        import io
        from PIL import Image, ImageDraw
        cols = 10
        rows = (len(sheet) + cols - 1) // cols
        im = Image.new('RGB', (cols * 256, rows * 276), 'white')
        d = ImageDraw.Draw(im)
        for i, (stem, png, info) in enumerate(sheet):
            x, y = (i % cols) * 256, (i // cols) * 276
            im.paste(Image.open(io.BytesIO(png)).convert('RGB'), (x, y))
            d.text((x + 4, y + 258), f"{stem}  {info['triangles']}t {info['bones']}b", fill=(0, 0, 0))
        os.makedirs(OUT, exist_ok=True)
        im.save(os.path.join(OUT, 'phone_sheet.png'))
        print('wrote', os.path.join(OUT, 'phone_sheet.png'))


if __name__ == '__main__':
    main()
