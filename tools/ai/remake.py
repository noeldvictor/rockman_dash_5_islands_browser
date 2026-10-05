#!/usr/bin/env python3
"""Remake one of the phone game's models with Tripo: picture -> HD picture -> 3D model.

    .venv/bin/python tools/ai/remake.py <model> [<model> ...]
        [--image-model banana2]   image model for the redraw (see the Tripo pricing page)
        [--faces 8000]            triangle budget of the result
        [--raw]                   skip the redraw: build straight from the phone render
        [--force]                 redo steps whose output already exists

Per model, in build/ai/models/<model>/ (git-ignored, never committed: derived from the game):

  phone_hero.png   the phone model, rendered (tools/ai/phone_models.py; needs the dev server)
  art.png          that picture redrawn as clean HD art by an image model (image-to-image)
  model.glb        the 3D model Tripo built from art.png (image-to-model, low poly, textured)
  compare.png      the three side by side: phone model, redraw, new model
  tasks.json       the Tripo task of each step and what it cost

Steps whose output exists are skipped, so a run can be repeated or continued. Costs credits:
about 10 for the picture and 50 for the model.
"""
import argparse
import base64
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tripo  # noqa: E402

ROOT = tripo.ROOT
OUT = os.path.join(ROOT, 'build', 'ai', 'models')
PY = sys.executable

REDRAW = (
    'Redraw this low-polygon video game 3D model as clean, high-resolution concept art of the same '
    'subject for a modern remake. Keep its design, colours, proportions, pose and viewing angle '
    'exactly. Look: smooth cel-shaded anime 3D in the style of Mega Man Legends 3: rounded smooth '
    'surfaces, crisp flat colours, clean panel lines, no texture noise, no pixelation, no blur. '
    'Show the whole subject, centred, on a plain white background, with no shadow, no text and '
    'nothing else in the picture.'
)


def record(folder, step, task):
    path = os.path.join(folder, 'tasks.json')
    log = json.load(open(path)) if os.path.exists(path) else {}
    log[step] = {'task_id': task['task_id'], 'credits': task.get('credits_consumed'), 'output': task.get('output')}
    json.dump(log, open(path, 'w'), indent=1)


def run(folder, step, start, force=False):
    """The finished task of a step: the one recorded in tasks.json if there is one (a task that
    was paid for is not started twice), otherwise a new one from start()."""
    path = os.path.join(folder, 'tasks.json')
    log = json.load(open(path)) if os.path.exists(path) else {}
    if step in log and not force:
        task = tripo.wait(log[step]['task_id'], quiet=True)
    else:
        task = tripo.wait(start())
    record(folder, step, task)
    return task


def url_of(output, *names):
    """The first of the named URLs in a task's output (their names vary by task type)."""
    for n in names:
        v = output.get(n)
        if isinstance(v, str):
            return v
        if isinstance(v, dict) and isinstance(v.get('url'), str):
            return v['url']
        if isinstance(v, list) and v:
            return v[0]['url'] if isinstance(v[0], dict) else v[0]
    raise KeyError(f'none of {names} in {json.dumps(output)[:400]}')


def remake(name, args):
    folder = os.path.join(OUT, name)
    hero = os.path.join(folder, 'phone_hero.png')
    art = os.path.join(folder, 'art.png')
    glb = os.path.join(folder, 'raw.glb' if args.raw else 'model.glb')
    if args.force or not os.path.exists(hero):
        subprocess.run([PY, os.path.join(ROOT, 'tools', 'ai', 'phone_models.py'), name, '--views', 'hero'], check=True)
    source = hero
    if not args.raw:
        if args.force or not os.path.exists(art):
            print(f'{name}: redrawing the picture ({args.image_model})')
            task = run(folder, 'art', lambda: tripo.submit(
                'generation/image-to-image', model=args.image_model, input=tripo.upload(hero), prompt=REDRAW), args.force)
            tripo.download(url_of(task['output'], 'generated_image_url', 'image_url'), art)
        source = art
    if args.force or not os.path.exists(glb):
        print(f'{name}: building the model from {os.path.basename(source)}')
        task = run(folder, 'raw' if args.raw else 'model', lambda: tripo.submit(
            'generation/image-to-model', input=tripo.upload(source), model='v3.1-20260211',
            smart_low_poly=True, face_limit=args.faces,
            texture=True, pbr=False, texture_quality='detailed', texture_alignment='original_image',
        ), args.force)
        tripo.download(url_of(task['output'], 'model_url', 'pbr_model_url', 'base_model_url', 'model'), glb)
    compare(name, folder, glb, args)


def compare(name, folder, glb, args):
    """phone model | redraw | new model, as one picture."""
    from PIL import Image
    from playwright.sync_api import sync_playwright
    shot = os.path.join(folder, 'raw_hero.png' if args.raw else 'model_hero.png')
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        page = browser.new_page()
        page.goto(args.url)
        page.wait_for_function('window.modelviewReady === true')
        data = base64.b64encode(open(glb, 'rb').read()).decode()
        urls = page.evaluate('(o) => window.renderGlb(o)', {'glb': data, 'views': [[args.yaw, 12]], 'size': 1024})
        info = page.evaluate('(o) => window.glbInfo(o)', {'glb': data})
        open(shot, 'wb').write(base64.b64decode(urls[0].split(',')[1]))
        browser.close()
    tiles = [os.path.join(folder, 'phone_hero.png')] + ([] if args.raw else [os.path.join(folder, 'art.png')]) + [shot]
    images = [Image.open(t).convert('RGB').resize((640, 640), Image.LANCZOS) for t in tiles]
    sheet = Image.new('RGB', (640 * len(images), 640), 'white')
    for i, im in enumerate(images):
        sheet.paste(im, (640 * i, 0))
    out = os.path.join(folder, 'compare_raw.png' if args.raw else 'compare.png')
    sheet.save(out)
    print(f"{name}: {info['triangles']} triangles, {info['textures']} texture(s) {info['textureSize']} -> {out}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('names', nargs='+')
    ap.add_argument('--image-model', default='banana2')
    ap.add_argument('--faces', type=int, default=8000)
    ap.add_argument('--raw', action='store_true')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--yaw', type=float, default=118, help='view of the new model in the comparison (Tripo models face +x)')
    ap.add_argument('--url', default='http://localhost:5173/modelview.html')
    args = ap.parse_args()
    before = tripo.balance()
    for name in args.names:
        remake(name.split('.')[0], args)
    print(f'credits used: {before - tripo.balance()} (balance {tripo.balance()})')


if __name__ == '__main__':
    main()
