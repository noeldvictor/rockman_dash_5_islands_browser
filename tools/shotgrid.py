#!/usr/bin/env python3
"""Tile screenshots from build/shots into one image: shotgrid.py out.png name1 name2 ... [--cols N] [--size PX]"""
import sys
from PIL import Image

args = sys.argv[1:]
cols, size = None, 300
names = []
i = 0
while i < len(args):
    if args[i] == "--cols":
        cols = int(args[i + 1]); i += 2
    elif args[i] == "--size":
        size = int(args[i + 1]); i += 2
    else:
        names.append(args[i]); i += 1
out, names = names[0], names[1:]
cols = cols or min(len(names), 4)
rows = (len(names) + cols - 1) // cols
sheet = Image.new("RGB", (cols * size, rows * size))
for n, name in enumerate(names):
    im = Image.open(f"build/shots/{name}.png").resize((size, size), Image.LANCZOS)
    sheet.paste(im, ((n % cols) * size, (n // cols) * size))
sheet.save(f"build/shots/{out}")
