#!/usr/bin/env python3
"""Redraw the game's sky panoramas in HD for the "3D sky" option (web/src/host/sky.js).

    .venv/bin/python tools/ai/skies.py [--image-model banana2] [--force]

A sky is two 240x240 GIFs side by side (sky<N>_0.gif, sky<N>_1.gif in an island's data), 480
pixels that repeat sideways. Each distinct one is sent to an image model (Tripo's
image-to-image) twice side by side, so the model sees how it joins up, and is redrawn larger
and cleaner. The middle of the answer is cut out and its ends are cross-faded so that it still
repeats, then written to web/public/redraw/sky_<key>.png and listed under "skies" in that
folder's manifest. <key> is "<width>x<height>:<crc32 of the RGB pixels>" of the original
panorama, which the host computes from the pictures the game hands it.

Work files and the Tripo tasks are kept in build/ai/skies/<name>/; a task that was paid for is
not started twice. About 10 credits per sky. Everything written is derived from the game's art:
web/public/redraw/ is git-ignored.
"""
import argparse
import json
import sys
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tripo  # noqa: E402
from remake import run, url_of  # noqa: E402

ROOT = Path(tripo.ROOT)
WORK = ROOT / 'build' / 'ai' / 'skies'
OUT = ROOT / 'web' / 'public' / 'redraw'

PROMPT = (
    'This picture is the sky backdrop of a video game, a panorama that repeats sideways, shown '
    'twice side by side. Redraw it as a clean, high-resolution painted anime sky for a modern '
    'remake: the same clouds in the same places, the same colours and the same gradient from the '
    'blue at the top to the pale haze at the bottom, with soft, detailed, well-shaped clouds '
    'instead of pixels and banding. Sky only: no ground, no sea, no sun, no birds, no text, no '
    'border. The left half and the right half must stay identical, so that it still repeats.'
)


def skies():
    """Every distinct panorama: key -> (name, RGB array 240 x 480)."""
    found = {}
    for left in sorted((ROOT / 'build' / 'assets').rglob('sky*_0.gif')):
        right = left.with_name(left.name.replace('_0.gif', '_1.gif'))
        if not right.exists():
            continue
        pano = np.concatenate([np.asarray(Image.open(p).convert('RGB')) for p in (left, right)], axis=1)
        key = f'{pano.shape[1]}x{pano.shape[0]}:{zlib.crc32(pano.tobytes()) & 0xffffffff}'
        found.setdefault(key, (left.name.replace('_0.gif', ''), pano))
    return found


def blurred(image, radius, wrap):
    """Gaussian blur of a float RGB array; `wrap` continues it sideways as a repeating picture."""
    from PIL import ImageFilter
    pad = int(radius * 3) if wrap else 0
    wide = np.concatenate([image[:, -pad:], image, image[:, :pad]], axis=1) if pad else image
    out = np.asarray(Image.fromarray(np.clip(wide, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius)), np.float32)
    return out[:, pad:pad + image.shape[1]] if pad else out


def seamless(answer, original, width, height):
    """One repeating tile from the model's two-tiles-wide answer.

    The model returns detail worth having but not the picture's colours (it shifts hues and
    paints each half with its own slow gradient, which shows as a step where they meet). So
    only the fine detail is taken from it; everything coarser than a cloud comes from the
    original, enlarged, which repeats without a seam by construction.
    """
    big = np.asarray(answer.convert('RGB').resize((width * 2, height), Image.LANCZOS), np.float32)
    radius = width / 30
    # detail of each half on its own, so the step between the halves stays out of it
    detail = np.concatenate([half - blurred(half, radius, False) for half in (big[:, :width], big[:, width:])], axis=1)
    half = width // 2
    tile = detail[:, half:half + width].copy()
    margin = width // 12
    ramp = np.linspace(0, 1, margin, dtype=np.float32)[None, :, None]
    # towards the right end, fade into what lies just left of the tile (one period away)
    tile[:, width - margin:] = tile[:, width - margin:] * (1 - ramp) + detail[:, half - margin:half] * ramp
    tile = np.roll(tile, half, axis=1)  # back to the original's starting column
    # the tile's own ends are where the model's two halves met, and they do not quite agree:
    # let the detail die away over the last few columns on either side, leaving the coarse layer
    edge = np.minimum(np.arange(width), np.arange(width)[::-1]).astype(np.float32) / (width / 80)
    tile *= np.clip(edge, 0, 1)[None, :, None] ** 2 * (3 - 2 * np.clip(edge, 0, 1)[None, :, None])
    coarse = blurred(np.asarray(Image.fromarray(original).resize((width, height), Image.BICUBIC), np.float32), radius, True)
    return Image.fromarray(np.clip(coarse + tile, 0, 255).astype(np.uint8))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--image-model', default='banana2')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--width', type=int, default=1920, help='width of a redrawn panorama (4x the original)')
    args = ap.parse_args()
    found = skies()
    if not found:
        sys.exit('no sky pictures under build/assets: run python3 tools/extract_assets.py first')
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / 'manifest.json'
    manifest = json.loads(path.read_text()) if path.exists() else {'model': args.image_model, 'scale': 4, 'textures': {}, 'models': {}}
    manifest.setdefault('skies', {})
    before = tripo.balance()
    for key, (name, pano) in found.items():
        folder = WORK / name
        folder.mkdir(parents=True, exist_ok=True)
        sent = folder / 'sent.png'
        Image.fromarray(np.tile(pano, (1, 2, 1))).resize((1920, 480), Image.LANCZOS).save(sent)
        answer = folder / 'answer.png'
        try:
            if args.force or not answer.exists():
                print(f'{name}: redrawing ({args.image_model})')
                task = run(str(folder), 'redraw', lambda: tripo.submit(
                    'generation/image-to-image', model=args.image_model, input=tripo.upload(str(sent)),
                    prompt=PROMPT, aspect_ratio='4:1'), args.force)
                tripo.download(url_of(task['output'], 'generated_image_url', 'image_url'), str(answer))
        except Exception as e:  # one sky failing should not stop the rest
            print(f'{name}: FAILED: {e}')
            continue
        got = Image.open(answer)
        tile = seamless(got, pano, args.width, args.width // 2)
        file = f"sky_{key.replace(':', '_')}.png"
        tile.save(OUT / file)
        manifest['skies'][key] = file
        path.write_text(json.dumps(manifest))
        pair = Image.new('RGB', (1920, 960))
        pair.paste(Image.fromarray(np.tile(pano, (1, 2, 1))).resize((1920, 480), Image.NEAREST), (0, 0))
        pair.paste(Image.fromarray(np.tile(np.asarray(tile), (1, 2, 1))).resize((1920, 480), Image.LANCZOS), (0, 480))
        pair.save(folder / 'compare.png')
        print(f'{name}: answer {got.width}x{got.height} -> {tile.width}x{tile.height}  {key}')
    print(f'credits used: {before - tripo.balance()} (balance {tripo.balance()})')


if __name__ == '__main__':
    main()
