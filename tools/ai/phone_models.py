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
VIEWS = {'front': [[0, 8]], 'hero': [[28, 12]], 'turn': [[0, 8], [90, 8], [180, 8], [270, 8]], 'sheet': [[25, 12]]}


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


def b64(path):
    with open(path, 'rb') as f:
        return base64.b64encode(f.read()).decode()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('names', nargs='*')
    ap.add_argument('--views', default='hero', choices=VIEWS)
    ap.add_argument('--size', type=int, default=1024)
    ap.add_argument('--url', default='http://localhost:5173/modelview.html')
    args = ap.parse_args()
    names = [n if '.' in n else next((m for m in models() if m.split('.')[0] == n), n) for n in args.names] or models()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        page = browser.new_page()
        page.goto(args.url)
        page.wait_for_function('window.modelviewReady === true')
        sheet = []
        for name in names:
            path = find(name)
            if not path:
                print('missing', name)
                continue
            options = {'model': b64(path), 'textures': [b64(t) for t in textures_of(name)],
                       'views': VIEWS[args.views], 'size': 256 if args.views == 'sheet' else args.size}
            action = find(name.split('.')[0] + '.mtr') or find(name.split('.')[0] + '.mtra')
            if action and name in ('rock.mba', 'roll.mba', 'toron.mba', 'tisel.mba', 'kobun.mba'):
                options.update(action=b64(action), actionIndex=0, frame=0)  # for the default face
            try:
                urls = page.evaluate('(o) => window.renderPhoneModel(o)', options)
                info = page.evaluate('(o) => window.modelInfo(o)', {'model': options['model']})
            except Exception as e:
                print('failed', name, str(e)[:200])
                continue
            stem = name.split('.')[0]
            if args.views == 'sheet':
                sheet.append((stem, base64.b64decode(urls[0].split(',')[1]), info))
                continue
            os.makedirs(os.path.join(OUT, stem), exist_ok=True)
            for (yaw, _), url in zip(VIEWS[args.views], urls):
                view = {0: 'front', 28: 'hero', 90: 'left', 180: 'back', 270: 'right'}.get(yaw, str(yaw))
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
