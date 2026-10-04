#!/usr/bin/env python3
"""Like shotgrid.py but keeps each screenshot's aspect ratio: wgrid.py out.png name... [--cols N] [--h PX]"""
import sys
from PIL import Image

args = sys.argv[1:]
cols, h = None, 270
names = []
i = 0
while i < len(args):
    if args[i] == "--cols":
        cols = int(args[i + 1]); i += 2
    elif args[i] == "--h":
        h = int(args[i + 1]); i += 2
    else:
        names.append(args[i]); i += 1
out, names = names[0], names[1:]
ims = [Image.open(f"build/shots/{n}.png") for n in names]
w = max(round(im.width * h / im.height) for im in ims)
cols = cols or min(len(ims), 3)
rows = (len(ims) + cols - 1) // cols
sheet = Image.new("RGB", (cols * w, rows * h))
for n, im in enumerate(ims):
    im = im.resize((round(im.width * h / im.height), h), Image.LANCZOS)
    sheet.paste(im, ((n % cols) * w + (w - im.width) // 2, (n // cols) * h))
sheet.save(f"build/shots/{out}")
