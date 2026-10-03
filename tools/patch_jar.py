#!/usr/bin/env python3
"""Make a build-time copy of the game jar with one call redirected.

    Thread.sleep(long)  ->  rdash.GameHooks.sleep(long)

so the runtime can skip the game's 15 fps frame limiter while a loading screen is showing (the
original spends ~25 s per area on them). Only the Methodref's
class is repointed in the constant pool; no bytecode changes, so method bodies are untouched.

Usage: patch_jar.py <in.jar> <out.jar>
"""
import struct
import sys
import zipfile

HOOK_CLASS = b"rdash/GameHooks"
TARGET = (b"java/lang/Thread", b"sleep", b"(J)V")


def patch_class(data: bytes) -> tuple[bytes, int]:
    if data[:4] != b"\xca\xfe\xba\xbe":
        return data, 0
    count = struct.unpack(">H", data[8:10])[0]
    pos = 10
    entries = [None] * count  # (tag, offset, parsed)
    i = 1
    while i < count:
        tag = data[pos]
        start = pos
        if tag == 1:  # Utf8
            n = struct.unpack(">H", data[pos + 1:pos + 3])[0]
            entries[i] = (tag, start, data[pos + 3:pos + 3 + n])
            pos += 3 + n
        elif tag in (3, 4):
            pos += 5
            entries[i] = (tag, start, None)
        elif tag in (5, 6):
            pos += 9
            entries[i] = (tag, start, None)
            i += 1
        elif tag in (7, 8):
            entries[i] = (tag, start, struct.unpack(">H", data[pos + 1:pos + 3])[0])
            pos += 3
        elif tag in (9, 10, 11, 12):
            entries[i] = (tag, start, struct.unpack(">HH", data[pos + 1:pos + 5]))
            pos += 5
        else:
            raise ValueError(f"unexpected constant pool tag {tag}")
        i += 1
    pool_end = pos

    def utf8(index):
        return entries[index][2]

    hits = []
    for index, e in enumerate(entries):
        if e and e[0] == 10:
            cls, nat = e[2]
            name, desc = entries[nat][2]
            if (utf8(entries[cls][2]), utf8(name), utf8(desc)) == TARGET:
                hits.append(e[1])
    if not hits:
        return data, 0
    # append Utf8 + Class for the hook, then repoint each matching Methodref's class index
    utf8_index, class_index = count, count + 1
    extra = b"\x01" + struct.pack(">H", len(HOOK_CLASS)) + HOOK_CLASS + b"\x07" + struct.pack(">H", utf8_index)
    out = bytearray(data[:pool_end] + extra + data[pool_end:])
    out[8:10] = struct.pack(">H", count + 2)
    for off in hits:
        out[off + 1:off + 3] = struct.pack(">H", class_index)
    return bytes(out), len(hits)


def main():
    src, dst = sys.argv[1:3]
    total = 0
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info)
            if info.filename.endswith(".class"):
                data, n = patch_class(data)
                total += n
            zout.writestr(info, data)
    if total == 0:
        sys.exit("patch_jar: no Thread.sleep call found; the jar is not what this tool expects")
    print(f"patch_jar: redirected {total} Thread.sleep call(s) in {dst}")


if __name__ == "__main__":
    main()
