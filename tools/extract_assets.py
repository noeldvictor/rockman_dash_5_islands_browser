#!/usr/bin/env python3
"""Unpack the original game files into build/assets/ for inspection and tooling.

  original/<variant>/RockmanDASH.jar   -> build/assets/<variant>/jar/
  original/<variant>/RockmanDASH.sp    -> build/assets/<variant>/sp/{data,sound}/ + seg1.bin, seg2.bin
  original/sdcard/RDDATA<i><n>.BIN     -> build/assets/sdcard/island<i>/   (chunks concatenated = one zip)

The scratchpad (.sp) is a 64-byte header of little-endian int32 segment sizes
(-1 terminated) followed by the segments. Segments 0 and 3 hold
[int32 length][zip]; segment 1 is the save data, segment 2 the last
"membership check" year*100+month.
"""
import io, struct, sys, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build" / "assets"


def sp_segments(data: bytes):
    sizes = [s for s in struct.unpack("<16i", data[:64]) if s != -1]
    off, segs = 64, []
    for s in sizes:
        segs.append(data[off:off + s])
        off += s
    return segs


def unzip_prefixed(seg: bytes, dest: Path):
    n = struct.unpack("<i", seg[:4])[0]
    if n <= 0 or seg[4:6] != b"PK":
        return 0
    dest.mkdir(parents=True, exist_ok=True)
    z = zipfile.ZipFile(io.BytesIO(seg[4:4 + n]))
    z.extractall(dest)
    return len(z.namelist())


def main():
    for variant in ("delocalized", "localized"):
        src = ROOT / "original" / variant
        dst = OUT / variant
        with zipfile.ZipFile(src / "RockmanDASH.jar") as z:
            (dst / "jar").mkdir(parents=True, exist_ok=True)
            z.extractall(dst / "jar")
            print(f"{variant}: jar {len(z.namelist())} entries")
        segs = sp_segments((src / "RockmanDASH.sp").read_bytes())
        print(f"{variant}: sp data {unzip_prefixed(segs[0], dst / 'sp' / 'data')} files,"
              f" sound {unzip_prefixed(segs[3], dst / 'sp' / 'sound')} files")
        (dst / "sp" / "seg1.bin").write_bytes(segs[1])
        (dst / "sp" / "seg2.bin").write_bytes(segs[2])
    sd = ROOT / "original" / "sdcard"
    for island in range(5):
        count = (sd / f"RDDATA{island}.BIN").read_bytes()[0]
        blob = b"".join((sd / f"RDDATA{island}{n}.BIN").read_bytes() for n in range(count))
        dest = OUT / "sdcard" / f"island{island}"
        dest.mkdir(parents=True, exist_ok=True)
        try:
            with zipfile.ZipFile(io.BytesIO(blob)) as z:
                z.extractall(dest)
                print(f"sdcard island{island}: {count} chunks, {len(blob)} bytes, {len(z.namelist())} files")
        except zipfile.BadZipFile as e:
            print(f"sdcard island{island}: {count} chunks, {len(blob)} bytes, NOT a plain zip ({e}); head={blob[:8].hex()}")
            (dest / "raw.bin").write_bytes(blob)


if __name__ == "__main__":
    sys.exit(main())
