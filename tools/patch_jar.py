#!/usr/bin/env python3
"""Make a build-time copy of the game jar with two mechanical changes.

1. Every field is made public, so the port's own classes in the default package (Mods.java)
   can read and write game state. Field access is resolved statically, so this cannot change
   behaviour. Methods are left alone: widening them could turn private methods into overrides.

2. One call is redirected:

    Thread.sleep(long)  ->  rdash.GameHooks.sleep(long)

so the runtime can skip the game's 15 fps frame limiter while a loading screen is showing (the
original spends ~25 s per area on them). Only the Methodref's
class is repointed in the constant pool; no bytecode changes, so method bodies are untouched.

Classes named with --drop are left out of the copy: they are replaced by modified decompiled
sources compiled from runtime/src/main/java (see ax.java, s.java there).

Usage: patch_jar.py <in.jar> <out.jar> [--drop name1,name2]
"""
import struct
import sys
import zipfile

HOOK_CLASS = b"rdash/GameHooks"
TARGET = (b"java/lang/Thread", b"sleep", b"(J)V")


def publicize_fields(out: bytearray, pool_end: int) -> None:
    """Set ACC_PUBLIC (and clear private/protected) on every field, in place."""
    pos = pool_end + 6  # access_flags, this_class, super_class
    interfaces = struct.unpack(">H", out[pos:pos + 2])[0]
    pos += 2 + 2 * interfaces
    fields = struct.unpack(">H", out[pos:pos + 2])[0]
    pos += 2
    for _ in range(fields):
        flags = struct.unpack(">H", out[pos:pos + 2])[0]
        out[pos:pos + 2] = struct.pack(">H", (flags & ~0x0006) | 0x0001)
        attrs = struct.unpack(">H", out[pos + 6:pos + 8])[0]
        pos += 8
        for _ in range(attrs):
            pos += 6 + struct.unpack(">I", out[pos + 2:pos + 6])[0]


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
        out = bytearray(data)
        publicize_fields(out, pool_end)
        return bytes(out), 0
    # append Utf8 + Class for the hook, then repoint each matching Methodref's class index
    utf8_index, class_index = count, count + 1
    extra = b"\x01" + struct.pack(">H", len(HOOK_CLASS)) + HOOK_CLASS + b"\x07" + struct.pack(">H", utf8_index)
    out = bytearray(data[:pool_end] + extra + data[pool_end:])
    out[8:10] = struct.pack(">H", count + 2)
    for off in hits:
        out[off + 1:off + 3] = struct.pack(">H", class_index)
    publicize_fields(out, pool_end + len(extra))
    return bytes(out), len(hits)


def main():
    src, dst = sys.argv[1:3]
    drop = set()
    if "--drop" in sys.argv:
        drop = {n + ".class" for n in sys.argv[sys.argv.index("--drop") + 1].split(",") if n}
    total = 0
    dropped = []
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            if info.filename in drop:
                dropped.append(info.filename)
                continue
            data = zin.read(info)
            if info.filename.endswith(".class"):
                data, n = patch_class(data)
                total += n
            zout.writestr(info, data)
    if total == 0:
        sys.exit("patch_jar: no Thread.sleep call found; the jar is not what this tool expects")
    if set(dropped) != drop:
        sys.exit(f"patch_jar: classes to drop not found in the jar: {sorted(drop - set(dropped))}")
    print(f"patch_jar: redirected {total} Thread.sleep call(s), dropped {len(dropped)} overridden class(es) in {dst}")


if __name__ == "__main__":
    main()
