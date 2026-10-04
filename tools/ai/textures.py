#!/usr/bin/env python3
"""Upscale the game's 3D textures 4x with an image model on a ComfyUI server (comfy.py) and write
them as a texture pack the web host can load (Settings > Video > Textures > AI upscaled).

    python3 tools/ai/textures.py [--model 4x-AnimeSharp.pth] [--batch 24] [--limit N]

Every 8-bit BMP texture found in the unpacked game data (build/assets/, from
tools/extract_assets.py: the jar, the scratchpad's data and every island on the SD card) is
upscaled once per distinct picture. Textures repeat, so each is sent with a border of its own
wrapped-around pixels and the border is cropped off afterwards; that keeps the tiling seamless.

A texture whose palette index 0 is used gets a second version, `<key>.k.png`, for when the game
draws it colour-keyed (index 0 transparent): there the key colour is first replaced by the
colours around it, so the upscaler does not smear it into the visible edges.

Output: web/public/hd/<key>.png and manifest.json. <key> is "<width>x<height>:<crc32 of the RGB
pixels>", which the host computes from the texture the game hands it (texfilter.js).
Everything written is derived from the game's art: web/public/hd/ is git-ignored.
"""
import argparse
import json
import struct
import sys
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import comfy  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "web" / "public" / "hd"
WORK = ROOT / "build" / "ai" / "textures"
PAD = 8
SCALE = 4


def decode_bmp(data: bytes):
    """8-bit uncompressed BMP -> (indices[h, w], palette[256, 3] RGB), rows top-down; None otherwise."""
    if data[:2] != b"BM":
        return None
    offset, header = struct.unpack_from("<II", data, 10)
    core = header == 12
    width, height = struct.unpack_from("<HH" if core else "<ii", data, 18)
    bpp = struct.unpack_from("<H", data, 24 if core else 28)[0]
    if bpp != 8 or (not core and struct.unpack_from("<I", data, 30)[0] != 0):
        return None
    top_down, height = height < 0, abs(height)
    entry = 3 if core else 4
    colors = min(256, (offset - 14 - header) // entry)
    raw = np.frombuffer(data, np.uint8, colors * entry, 14 + header).reshape(colors, entry)
    palette = np.zeros((256, 3), np.uint8)
    palette[:colors] = raw[:, 2::-1]  # stored blue, green, red
    stride = (width + 3) & ~3
    rows = np.frombuffer(data, np.uint8, stride * height, offset).reshape(height, stride)[:, :width]
    return (rows if top_down else rows[::-1]).copy(), palette


def spread(rgb, hole):
    """Fill the `hole` pixels with the average of their filled neighbours, repeatedly, wrapping at the edges."""
    rgb = rgb.astype(np.float32)
    filled = ~hole
    for _ in range(max(rgb.shape[:2])):
        if filled.all() or not filled.any():
            break
        total = np.zeros_like(rgb)
        count = np.zeros(rgb.shape[:2], np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                f = np.roll(filled, (dy, dx), (0, 1))
                total += np.roll(rgb, (dy, dx), (0, 1)) * f[..., None]
                count += f
        grow = ~filled & (count > 0)
        rgb[grow] = total[grow] / count[grow][:, None]
        filled |= grow
    return rgb.astype(np.uint8)


def wrap_pad(rgb):
    return np.pad(rgb, ((PAD, PAD), (PAD, PAD), (0, 0)), mode="wrap")


def collect():
    """Every distinct texture picture: key -> {rgb, keyed (index 0 is used), name}."""
    textures = {}
    for path in sorted((ROOT / "build" / "assets").rglob("*.bmp")):
        decoded = decode_bmp(path.read_bytes())
        if not decoded:
            continue
        indices, palette = decoded
        rgb = palette[indices]
        key = f"{rgb.shape[1]}x{rgb.shape[0]}:{zlib.crc32(rgb.tobytes()) & 0xffffffff}"
        textures.setdefault(key, {"rgb": rgb, "hole": indices == 0, "name": path.stem})
    return textures


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--model", default="4x-AnimeSharp.pth")
    p.add_argument("--batch", type=int, default=24)
    p.add_argument("--limit", type=int, default=0)
    args = p.parse_args()

    textures = collect()
    if not textures:
        sys.exit("no textures under build/assets: run python3 tools/extract_assets.py first")
    jobs = []  # (file stem, padded RGB picture)
    manifest = {"model": args.model, "scale": SCALE, "textures": {}}
    for key, t in textures.items():
        stem = key.replace(":", "_")
        keyed = bool(t["hole"].any()) and not t["hole"].all()
        manifest["textures"][key] = {"file": f"{stem}.png", "name": t["name"], **({"keyed": f"{stem}.k.png"} if keyed else {})}
        jobs.append((stem, wrap_pad(t["rgb"])))
        if keyed:
            jobs.append((f"{stem}.k", wrap_pad(spread(t["rgb"], t["hole"]))))
    if args.limit:
        jobs = jobs[:args.limit]
    OUT.mkdir(parents=True, exist_ok=True)
    total = len(jobs)
    jobs = [j for j in jobs if not (OUT / f"{j[0]}.png").exists()]  # resume: skip what is already there
    (WORK / "in").mkdir(parents=True, exist_ok=True)
    print(f"{len(textures)} distinct textures, {total} pictures, {len(jobs)} still to upscale with {args.model}", flush=True)
    done = total - len(jobs)
    for start in range(0, len(jobs), args.batch):
        batch = jobs[start:start + args.batch]
        graph = {"m": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": args.model}}}
        for i, (stem, picture) in enumerate(batch):
            local = WORK / "in" / f"{stem}.png"
            Image.fromarray(picture).save(local)
            remote = comfy.upload(local, f"rdash_tex_{stem}.png")
            graph[f"l{i}"] = {"class_type": "LoadImage", "inputs": {"image": remote}}
            graph[f"u{i}"] = {"class_type": "ImageUpscaleWithModel", "inputs": {"upscale_model": ["m", 0], "image": [f"l{i}", 0]}}
            graph[f"s{i}"] = {"class_type": "SaveImage", "inputs": {"images": [f"u{i}", 0], "filename_prefix": f"rdash/hd/b{start}_{i:02d}"}}
        result = comfy.run(graph, f"textures {start}", timeout=7200)
        files = {f[2].split("_")[1]: f for f in result["files"] if f[0] == "images"}
        for i, (stem, picture) in enumerate(batch):
            up = Image.open(comfy.download(files[f"{i:02d}"], WORK / "out" / f"{stem}.png")).convert("RGB")
            pad = PAD * SCALE
            up.crop((pad, pad, up.size[0] - pad, up.size[1] - pad)).save(OUT / f"{stem}.png", optimize=True)
            done += 1
        print(f"  {done}/{total} ({result['seconds']} s)", flush=True)
    (OUT / "manifest.json").write_text(json.dumps(manifest))
    size = sum(f.stat().st_size for f in OUT.glob("*.png")) / 1048576
    print(f"wrote {OUT.relative_to(ROOT)}: {done} pictures, {size:.1f} MB")


if __name__ == "__main__":
    main()
