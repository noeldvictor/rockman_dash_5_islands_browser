#!/usr/bin/env python3
"""Remake one of the phone game's models with Tripo: pictures -> HD pictures -> 3D model.

    .venv/bin/python tools/ai/remake.py <model> [<model> ...]
        [--image-model banana2]   image model for the redraws (see the Tripo pricing page)
        [--faces 8000]            triangle budget of the result
        [--views front,back]      which sides to show Tripo (front, back, left, right)
        [--force]                 redo steps whose output already exists

A model is named like its file (o01, kobun); one the game draws with several textures takes
the texture's number after an @ (o07@02; `phone_models.py --views sheet` shows them all).

Per model, in build/ai/models/<model>/ (git-ignored, never committed: derived from the game):

  phone_*.png      the phone model, rendered (tools/ai/phone_models.py; needs the dev server)
  art_<side>.png   each side redrawn as clean HD art by an image model (image-to-image)
  model.glb        the 3D model Tripo built from those (multiview-to-model, low poly, textured)
  compare.png      side by side: phone model, the redraws, the new model from two sides
  tasks.json       the Tripo task of each step and what it cost

A model with a file called `skip` in its folder is left alone (a part that another model's
remake stands in for, see install_remake.py, or one judged not worth it).

Only what a picture shows is reliable, so at least the front and the back are given. Steps whose
output exists are skipped, and a task that was paid for is fetched again rather than started
twice, so a run can be repeated or continued. Costs credits: about 10 per picture, 50 per model.
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
    'Redraw this picture of a low-polygon video game 3D model as clean, high-resolution concept art '
    'of exactly the same subject, seen from exactly the same side and angle, for a modern remake. '
    'Do not turn it, do not change which parts are visible, and do not add or remove any part: '
    'every shape, colour and marking stays where it is. Look: smooth cel-shaded anime 3D in the '
    'style of Mega Man Legends 3: rounded smooth surfaces, crisp flat colours, clean panel lines, '
    'no texture noise, no pixelation, no blur. Show the whole subject, centred, on a plain white '
    'background, with no shadow, no text and nothing else in the picture.'
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
        task_id = start()
        # noted at once: if this run is stopped while waiting, the next one picks the task up
        record(folder, step, {'task_id': task_id})
        task = tripo.wait(task_id)
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
    raise KeyError(f'none of {names} in {json.dumps(output)[:400]}')


def remake(name, args):
    folder = os.path.join(OUT, name)
    if os.path.exists(os.path.join(folder, 'skip')):
        print(f'{name}: marked not to be remade (build/ai/models/{name}/skip)')
        return
    sides = args.views.split(',')
    phone = {s: os.path.join(folder, f'phone_view_{s}.png') for s in sides}
    if args.force or not all(os.path.exists(p) for p in phone.values()) or not os.path.exists(os.path.join(folder, 'phone_hero.png')):
        for views in ('turn', 'hero'):
            subprocess.run([PY, os.path.join(ROOT, 'tools', 'ai', 'phone_models.py'), name, '--views', views], check=True)
    art = {s: os.path.join(folder, f'art_{s}.png') for s in sides}
    for side in sides:
        if os.path.exists(art[side]) and not args.force:
            continue
        print(f'{name}: redrawing the {side} ({args.image_model})')

        # the side is not named to the image model: told "this is the front", it draws a front
        # (the car's rear came back with headlights). Each side is redrawn on its own.
        task = run(folder, f'art_{side}', lambda side=side: tripo.submit(
            'generation/image-to-image', model=args.image_model, input=tripo.upload(phone[side]), prompt=REDRAW),
            args.force)
        tripo.download(url_of(task['output'], 'generated_image_url', 'image_url'), art[side])
    glb = os.path.join(folder, 'model.glb')
    step = 'model_' + '_'.join(sides)
    log = os.path.join(folder, 'tasks.json')
    built = os.path.exists(log) and step in json.load(open(log))
    if args.force or not built or not os.path.exists(glb):
        print(f'{name}: building the model from {len(sides)} pictures')
        task = run(folder, step, lambda: tripo.submit(
            'generation/multiview-to-model', inputs=[{s: tripo.upload(art[s])} for s in sides],
            model='v3.1-20260211', smart_low_poly=True, face_limit=args.faces,
            texture=True, pbr=False, texture_quality='detailed', texture_alignment='original_image',
        ), args.force)
        tripo.download(url_of(task['output'], 'model_url', 'pbr_model_url', 'base_model_url', 'model'), glb)
    compare(name, folder, glb, [art[s] for s in sides], args)


def compare(name, folder, glb, pictures, args):
    """phone model | the redraws | new model from two sides, as one picture."""
    from PIL import Image
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        page = browser.new_page()
        page.goto(args.url)
        page.wait_for_function('window.modelviewReady === true')
        data = base64.b64encode(open(glb, 'rb').read()).decode()
        # Tripo's models face +x: a three-quarter view of the front, and the opposite one
        urls = page.evaluate('(o) => window.renderGlb(o)', {'glb': data, 'views': [[118, 12], [298, 12]], 'size': 1024})
        info = page.evaluate('(o) => window.glbInfo(o)', {'glb': data})
        browser.close()
    shots = []
    for i, url in enumerate(urls):
        shots.append(os.path.join(folder, f'model_{i}.png'))
        open(shots[-1], 'wb').write(base64.b64decode(url.split(',')[1]))
    tiles = [os.path.join(folder, 'phone_hero.png')] + pictures + shots
    images = [Image.open(t).convert('RGB').resize((512, 512), Image.LANCZOS) for t in tiles]
    sheet = Image.new('RGB', (512 * len(images), 512), 'white')
    for i, im in enumerate(images):
        sheet.paste(im, (512 * i, 0))
    out = os.path.join(folder, 'compare.png')
    sheet.save(out)
    print(f"{name}: {info['triangles']} triangles, {info['textures']} texture(s) {info['textureSize']} -> {out}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('names', nargs='+')
    ap.add_argument('--image-model', default='banana2')
    ap.add_argument('--faces', type=int, default=8000)
    ap.add_argument('--views', default='front,back')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--url', default='http://localhost:5173/modelview.html')
    args = ap.parse_args()
    before = tripo.balance()
    for name in args.names:
        try:
            remake(name.split('.')[0], args)
        except Exception as e:  # one model failing should not stop the rest of a batch
            print(f'{name}: FAILED: {e}')
    print(f'credits used: {before - tripo.balance()} (balance {tripo.balance()})')


if __name__ == '__main__':
    main()
