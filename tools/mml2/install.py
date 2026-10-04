#!/usr/bin/env python3
"""Copy the Mega Man Legends 2 assets the web host can use into web/public/mml2/.

Everything under web/public/mml2/ is derived from the user's own disc image and is git-ignored.
Run after the extraction tools in this directory have filled build/mml2/ (see CLAUDE.md).

  python3 tools/mml2/install.py
"""
import json
import shutil
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SRC = ROOT / "build" / "mml2"
DST = ROOT / "web" / "public" / "mml2"

# name used by the host -> extracted file
MODELS = {
    "megaman": "models/player/PL00P000_megaman.glb",          # helmet on
    "megaman_nohelmet": "models/player/PL00P010_megaman.glb",  # helmet off
    "roll": "models/player/PL01P000_roll.glb",
    "tron": "models/player/PL02P000_tron.glb",
    "teisel": "models/ST53/e1_04_007220.glb",
    "servbot": "models/ST00/e1_05_000b20.glb",
}


def glb_info(path: Path):
    data = path.read_bytes()
    n = struct.unpack("<I", data[12:16])[0]
    j = json.loads(data[20:20 + n])
    lo, hi = [1e9] * 3, [-1e9] * 3
    for mesh in j["meshes"]:
        for prim in mesh["primitives"]:
            acc = j["accessors"][prim["attributes"]["POSITION"]]
            for c in range(3):
                lo[c] = min(lo[c], acc["min"][c])
                hi[c] = max(hi[c], acc["max"][c])
    return {
        "bones": [n_["name"] for n_ in j["nodes"] if "mesh" not in n_],
        "meshes": [n_["name"] for n_ in j["nodes"] if "mesh" in n_],
        "animations": len(j.get("animations", [])),
        "min": lo,
        "max": hi,
    }


def main():
    if not SRC.is_dir():
        sys.exit(f"{SRC} not found: run the extraction tools first")
    (DST / "models").mkdir(parents=True, exist_ok=True)
    manifest = {"models": {}}
    for name, rel in MODELS.items():
        src = SRC / rel
        if not src.exists():
            print(f"missing {rel}, skipped")
            continue
        shutil.copyfile(src, DST / "models" / f"{name}.glb")
        manifest["models"][name] = {"url": f"models/{name}.glb", **glb_info(src)}
        print(f"{name}: {src.stat().st_size} bytes, height {manifest['models'][name]['max'][1]:.3f}")
    (DST / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"wrote {DST / 'manifest.json'}")


if __name__ == "__main__":
    main()
