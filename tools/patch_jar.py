#!/usr/bin/env python3
"""Make a build-time copy of the game jar with a few mechanical changes.

1. Every field is made public, so the port's own classes in the default package (Mods.java)
   can read and write game state. Field access is resolved statically, so this cannot change
   behaviour. Methods are left alone: widening them could turn private methods into overrides.

2. One call is redirected:

    Thread.sleep(long)  ->  rdash.GameHooks.sleep(long)

so the runtime can skip the game's 15 fps frame limiter while a loading screen is showing (the
original spends ~25 s per area on them). Only the Methodref's
class is repointed in the constant pool; no bytecode changes, so method bodies are untouched.

3. Three instance-method calls are redirected to static port methods that take the receiver as
   their first argument, each at its single call site (the first two in the mission class, bp,
   the third in the player class, av):

    world.a(Graphics, bn)          [bh, the mission HUD]  ->  Mods.hud(world, Graphics, bn)
    map.a(Graphics, av, int, int)  [ao, the 2D sky]       ->  Mods.sky(map, Graphics, av, int, int)
    player.R()                     [h, walk forward]      ->  Mods.walk(player)

so the port can draw the HUD gauges at the screen edges in widescreen, turn the sky with the
free-look camera, and scale the walking speed with an analog stick. Here the instruction's opcode changes too (invokevirtual -> invokestatic, same
length, same operand stack effect) and it points at a Methodref appended to the constant pool.

Classes named with --drop are left out of the copy: they are replaced by modified decompiled
sources compiled from runtime/src/main/java (see ax.java, s.java there).

Usage: patch_jar.py <in.jar> <out.jar> [--drop name1,name2]
"""
import struct
import sys
import zipfile

HOOK_CLASS = b"rdash/GameHooks"
TARGET = (b"java/lang/Thread", b"sleep", b"(J)V")

# invokevirtual of the first method becomes invokestatic of the second (receiver passed as the
# first argument); each must occur exactly once in the jar
REDIRECTS = [
    ((b"bh", b"a", b"(Lcom/nttdocomo/ui/Graphics;Lbn;)V"),
     (b"Mods", b"hud", b"(Lbh;Lcom/nttdocomo/ui/Graphics;Lbn;)V")),
    ((b"ao", b"a", b"(Lcom/nttdocomo/ui/Graphics;Lav;II)V"),
     (b"Mods", b"sky", b"(Lao;Lcom/nttdocomo/ui/Graphics;Lav;II)V")),
    ((b"h", b"R", b"()V"), (b"Mods", b"walk", b"(Lh;)V")),
]

INVOKEVIRTUAL, INVOKESTATIC = 0xB6, 0xB8


def instruction_length(code: bytes, pc: int) -> int:
    """Length in bytes of the JVM instruction at `pc`."""
    op = code[pc]
    if op in (0xAA, 0xAB):  # tableswitch, lookupswitch: padded to a multiple of 4
        base = (pc + 4) & ~3
        if op == 0xAA:
            low, high = struct.unpack(">ii", code[base + 4:base + 12])
            return base + 12 + 4 * (high - low + 1) - pc
        return base + 8 + 8 * struct.unpack(">i", code[base + 4:base + 8])[0] - pc
    if op == 0xC4:  # wide
        return 6 if code[pc + 1] == 0x84 else 4
    if op in (0x10, 0x12, 0xA9, 0xBC) or 0x15 <= op <= 0x19 or 0x36 <= op <= 0x3A:
        return 2
    if op in (0x11, 0x13, 0x14, 0x84, 0xBB, 0xBD, 0xC0, 0xC1, 0xC6, 0xC7) \
            or 0x99 <= op <= 0xA8 or 0xB2 <= op <= 0xB8:
        return 3
    if op == 0xC5:
        return 4
    if op in (0xB9, 0xBA, 0xC8, 0xC9):
        return 5
    return 1


def redirect_invokes(out: bytearray, pool_end: int, utf8, old_index: int, new_index: int) -> int:
    """Turn every `invokevirtual #old_index` in the class's methods into `invokestatic #new_index`."""
    pos = pool_end + 6
    pos += 2 + 2 * struct.unpack(">H", out[pos:pos + 2])[0]  # interfaces
    fields = struct.unpack(">H", out[pos:pos + 2])[0]
    pos += 2
    for _ in range(fields):
        attrs = struct.unpack(">H", out[pos + 6:pos + 8])[0]
        pos += 8
        for _ in range(attrs):
            pos += 6 + struct.unpack(">I", out[pos + 2:pos + 6])[0]
    methods = struct.unpack(">H", out[pos:pos + 2])[0]
    pos += 2
    done = 0
    for _ in range(methods):
        attrs = struct.unpack(">H", out[pos + 6:pos + 8])[0]
        pos += 8
        for _ in range(attrs):
            name, length = struct.unpack(">HI", out[pos:pos + 6])
            if utf8(name) == b"Code":
                start = pos + 14
                code = bytes(out[start:start + struct.unpack(">I", out[pos + 10:pos + 14])[0]])
                pc = 0  # relative to the method's code: switch padding depends on it
                while pc < len(code):
                    if code[pc] == INVOKEVIRTUAL and struct.unpack(">H", code[pc + 1:pc + 3])[0] == old_index:
                        out[start + pc] = INVOKESTATIC
                        out[start + pc + 1:start + pc + 3] = struct.pack(">H", new_index)
                        done += 1
                    pc += instruction_length(code, pc)
                if pc != len(code):
                    raise ValueError("bytecode walk did not end on an instruction boundary")
            pos += 6 + length
    return done


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


def patch_class(data: bytes) -> tuple[bytes, int, list[int]]:
    """@returns the patched class, the number of sleep calls redirected in it, and the number of
    calls redirected for each entry of REDIRECTS"""
    if data[:4] != b"\xca\xfe\xba\xbe":
        return data, 0, [0] * len(REDIRECTS)
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

    def methodref(index):
        e = entries[index]
        if not e or e[0] != 10:
            return None
        cls, nat = e[2]
        name, desc = entries[nat][2]
        return (utf8(entries[cls][2]), utf8(name), utf8(desc))

    sleeps = [e[1] for i, e in enumerate(entries) if methodref(i) == TARGET]
    targets = [t for t, _ in REDIRECTS]
    calls = [(i, targets.index(methodref(i))) for i in range(count) if methodref(i) in targets]

    # constant pool entries are appended; nothing existing moves
    extra = bytearray()
    added = 0

    def add(entry: bytes) -> int:
        nonlocal added
        extra.extend(entry)
        added += 1
        return count + added - 1

    def add_utf8(text: bytes) -> int:
        return add(b"\x01" + struct.pack(">H", len(text)) + text)

    def add_class(name: bytes) -> int:
        return add(b"\x07" + struct.pack(">H", add_utf8(name)))

    sleep_class = add_class(HOOK_CLASS) if sleeps else 0
    hooks = []  # (old Methodref index, new Methodref index, which redirect)
    for index, which in calls:
        hook = REDIRECTS[which][1]
        cls = add_class(hook[0])
        nat = add(b"\x0c" + struct.pack(">HH", add_utf8(hook[1]), add_utf8(hook[2])))
        hooks.append((index, add(b"\x0a" + struct.pack(">HH", cls, nat)), which))

    out = bytearray(data[:pool_end] + bytes(extra) + data[pool_end:])
    out[8:10] = struct.pack(">H", count + added)
    for off in sleeps:  # repoint each matching Methodref's class index
        out[off + 1:off + 3] = struct.pack(">H", sleep_class)
    pool_end += len(extra)
    redirected = [0] * len(REDIRECTS)
    for old, new, which in hooks:
        redirected[which] += redirect_invokes(out, pool_end, utf8, old, new)
    publicize_fields(out, pool_end)
    return bytes(out), len(sleeps), redirected


def main():
    src, dst = sys.argv[1:3]
    drop = set()
    if "--drop" in sys.argv:
        drop = {n + ".class" for n in sys.argv[sys.argv.index("--drop") + 1].split(",") if n}
    total = 0
    redirected = [0] * len(REDIRECTS)
    dropped = []
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            if info.filename in drop:
                dropped.append(info.filename)
                continue
            data = zin.read(info)
            if info.filename.endswith(".class"):
                data, n, r = patch_class(data)
                total += n
                redirected = [a + b for a, b in zip(redirected, r)]
            zout.writestr(info, data)
    if total == 0:
        sys.exit("patch_jar: no Thread.sleep call found; the jar is not what this tool expects")
    for (target, hook), n in zip(REDIRECTS, redirected):
        if n != 1:
            sys.exit(f"patch_jar: expected exactly one call of {target[0].decode()}.{target[1].decode()}"
                     f"{target[2].decode()} (for {hook[0].decode()}.{hook[1].decode()}), found {n}")
    if set(dropped) != drop:
        sys.exit(f"patch_jar: classes to drop not found in the jar: {sorted(drop - set(dropped))}")
    print(f"patch_jar: redirected {total} Thread.sleep call(s) and {len(REDIRECTS)} port hook(s), dropped {len(dropped)} overridden class(es) in {dst}")


if __name__ == "__main__":
    main()
