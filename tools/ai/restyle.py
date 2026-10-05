#!/usr/bin/env python3
"""Redraw the game's map textures in the look of the remade models (clean, cel-shaded, HD).

    .venv/bin/python tools/ai/restyle.py --area a1_5          the textures one area uses
    .venv/bin/python tools/ai/restyle.py a1_0 a1_2 ...        named textures
        [--image-model banana2] [--force]

Each texture is sent to an image model (Tripo's image-to-image) repeated 2x2, so the model sees
how it tiles, with a prompt to redraw it without changing its layout. One tile is cut from the
middle of the answer, half a tile in from the corner, and its edges are cross-faded into what
lay just outside them, so the result still repeats without a seam. It is written 4x the
original size to web/public/redraw/<key>.png with a manifest in the format of the AI texture
pack (tools/ai/textures.py); the host shows it under Settings > Video > Textures > AI redrawn.

The model does not always keep to the picture: plain gravel has come back as cobblestones, a
rough wall as a carved maze. Look at build/ai/textures/<name>/compare.png and throw such ones
out with `restyle.py --drop <name> ...`; the upscaled texture is shown for them instead.

Work files and the Tripo tasks are kept in build/ai/textures/<name>/, and a task that was paid
for is not started twice. Costs credits (about 10 per texture with banana2). Everything written
is derived from the game's art: web/public/redraw/ is git-ignored.
"""
import argparse
import json
import os
import subprocess
import sys
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tripo  # noqa: E402
from remake import run, url_of  # noqa: E402
from textures import decode_bmp, spread  # noqa: E402

ROOT = Path(tripo.ROOT)
WORK = ROOT / 'build' / 'ai' / 'textures'
OUT = ROOT / 'web' / 'public' / 'redraw'
SCALE = 4
SEND = 1024  # the 2x2 picture is sent at this size

PROMPT = (
    'This picture is a tiling surface texture from a video game, shown repeated 2 by 2. Redraw it '
    'as a clean, high-resolution hand-painted texture for a modern cel-shaded anime remake (the '
    'look of Mega Man Legends 3): the same layout, the same colours, the same repeating pattern in '
    'the same places, but with crisp shapes, flat colours and simple soft shading instead of '
    'pixels and noise. It must stay a flat, front-on texture that fills the whole picture from '
    'edge to edge and still repeats 2 by 2: no perspective, no border, no frame, no text, and '
    'nothing added that is not in the original. If it is a plain, even surface (gravel, sand, '
    'dirt, concrete, plain metal), keep it plain and even: do not invent tiles, carvings, symbols '
    'or patterns.'
)


def find(name):
    for path in sorted((ROOT / 'build' / 'assets').rglob(f'{name}.bmp')):
        return path
    return None


def area_textures(area):
    """The textures a scene file refers to: <first 3 characters of the map><image id>.bmp."""
    scene = next(iter(sorted((ROOT / 'build' / 'assets').rglob(f'{area}.d4d'))), None)
    if not scene:
        sys.exit(f'no scene file {area}.d4d under build/assets')
    code = ("import { readFileSync } from 'node:fs';"
            "import { parseD4D } from './web/src/formats/d4d.js';"
            f"const s = parseD4D(new Uint8Array(readFileSync('{scene}')));"
            "console.log(JSON.stringify(s.images.map((i) => i.userID)));")
    out = subprocess.run(['node', '--input-type=module', '-e', code], cwd=ROOT, capture_output=True, text=True)
    if out.returncode:
        sys.exit(f'could not read {scene}: {out.stderr[-400:]}')
    return [f'{area[:3]}{i}' for i in sorted(json.loads(out.stdout.strip().splitlines()[-1]))]


def tileable(answer, size):
    """One seamless tile, `size` pixels a side, from the model's 2x2 answer."""
    big = np.asarray(answer.convert('RGB').resize((size * 2, size * 2), Image.LANCZOS), np.float32)
    half = size // 2
    tile = big[half:half + size, half:half + size].copy()
    margin = max(4, size // 8)
    ramp = np.linspace(0, 1, margin, dtype=np.float32)
    # towards the right edge, fade into what lies just left of the tile (one period away), and
    # the same downwards: then each edge continues into the opposite one
    left = big[half:half + size, half - margin:half]
    tile[:, size - margin:] = tile[:, size - margin:] * (1 - ramp)[None, :, None] + left * ramp[None, :, None]
    above = big[half - margin:half, half:half + size].copy()
    above[:, size - margin:] = above[:, size - margin:] * (1 - ramp)[None, :, None] + big[half - margin:half, half - margin:half] * ramp[None, :, None]
    tile[size - margin:] = tile[size - margin:] * (1 - ramp)[:, None, None] + above * ramp[:, None, None]
    # the tile was cut half a tile in: turn it back so its corner is the original's corner
    # (textures that are not plain repeats are addressed by position)
    tile = np.roll(tile, (half, half), (0, 1))
    return Image.fromarray(np.clip(tile, 0, 255).astype(np.uint8))


def restyle(name, args, manifest):
    path = find(name)
    if not path:
        print('no texture called', name)
        return
    indices, palette = decode_bmp(path.read_bytes())
    rgb = palette[indices]
    hole = indices == 0
    keyed = bool(hole.any()) and not hole.all()
    key = f'{rgb.shape[1]}x{rgb.shape[0]}:{zlib.crc32(rgb.tobytes()) & 0xffffffff}'
    if (WORK / name / 'rejected').exists() and not args.force:
        return  # looked at and thrown out (--drop): the upscaled texture is used for it
    if key in manifest['textures'] and not args.force:
        return  # this picture is done (the same one may go by several names)
    folder = WORK / name
    folder.mkdir(parents=True, exist_ok=True)
    # where the colour key shows through, continue the colours around it
    source = spread(rgb, hole) if keyed else rgb
    sent = folder / 'sent.png'
    Image.fromarray(np.tile(source, (2, 2, 1))).resize((SEND, SEND), Image.NEAREST).save(sent)  # square, whatever its shape
    answer = folder / 'answer.png'
    if args.force or not answer.exists():
        print(f'{name}: redrawing ({args.image_model})')
        task = run(str(folder), 'redraw', lambda: tripo.submit(
            'generation/image-to-image', model=args.image_model, input=tripo.upload(str(sent)), prompt=PROMPT), args.force)
        tripo.download(url_of(task['output'], 'generated_image_url', 'image_url'), str(answer))
    size = max(rgb.shape[0], rgb.shape[1]) * SCALE
    tile = tileable(Image.open(answer), size).resize((rgb.shape[1] * SCALE, rgb.shape[0] * SCALE), Image.LANCZOS)
    stem = key.replace(':', '_')
    tile.save(OUT / f'{stem}.png')
    # the host puts the original's transparency back, enlarged: the same picture serves both
    manifest['textures'][key] = {'file': f'{stem}.png', 'name': name, **({'keyed': f'{stem}.png'} if keyed else {})}
    before = Image.fromarray(np.tile(source, (2, 2, 1))).resize((512, 512), Image.NEAREST)
    after = Image.fromarray(np.tile(np.asarray(tile), (2, 2, 1))).resize((512, 512), Image.LANCZOS)
    pair = Image.new('RGB', (1024, 512))
    pair.paste(before, (0, 0))
    pair.paste(after, (512, 0))
    pair.save(folder / 'compare.png')
    print(f'{name}: {rgb.shape[1]}x{rgb.shape[0]} -> {tile.width}x{tile.height}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('names', nargs='*')
    ap.add_argument('--area')
    ap.add_argument('--maps', action='store_true', help='every map texture of the game (a<island>_<n>.bmp)')
    ap.add_argument('--drop', action='store_true',
                    help='throw the redraws of the named textures out (the model invented things): they are '
                         'taken off the manifest and not made again')
    ap.add_argument('--image-model', default='banana2')
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()
    names = list(args.names) + (area_textures(args.area) if args.area else [])
    if args.maps:
        import re
        found = {p.stem for p in (ROOT / 'build' / 'assets').rglob('a?_*.bmp') if re.fullmatch(r'a\d_\d+', p.stem)}
        names += sorted(found, key=lambda n: (n[:2], int(n[3:])))
    if not names:
        sys.exit(__doc__)
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / 'manifest.json'
    manifest = json.loads(path.read_text()) if path.exists() else {'model': args.image_model, 'scale': SCALE, 'textures': {}, 'models': {}}
    if args.drop:
        for name in args.names:
            found = find(name)
            if not found:
                continue
            indices, palette = decode_bmp(found.read_bytes())
            rgb = palette[indices]
            key = f'{rgb.shape[1]}x{rgb.shape[0]}:{zlib.crc32(rgb.tobytes()) & 0xffffffff}'
            entry = manifest['textures'].pop(key, None)
            (WORK / name).mkdir(parents=True, exist_ok=True)
            (WORK / name / 'rejected').write_text('')
            if entry:
                (OUT / entry['file']).unlink(missing_ok=True)
            print(f"{name}: {'dropped' if entry else 'was not in the pack'}")
        path.write_text(json.dumps(manifest))
        return
    before = tripo.balance()
    for name in names:
        try:
            restyle(name, args, manifest)
        except Exception as e:  # one texture failing should not stop the rest
            print(f'{name}: FAILED: {e}')
        path.write_text(json.dumps(manifest))
    print(f'credits used: {before - tripo.balance()} (balance {tripo.balance()})')


if __name__ == '__main__':
    main()
