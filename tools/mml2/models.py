#!/usr/bin/env python3
"""Mega Man Legends 2 (PSX) models and animations -> glTF 2.0 (.glb) + preview renders.

Usage:
    python3 tools/mml2/models.py <disc dir> <out dir>          # e.g. $S/disc build/mml2/models
    python3 tools/mml2/models.py <disc dir> <out dir> ST0301   # only archives matching a prefix

FORMAT (C = confirmed here against the disc, D = taken from the DashGL notes and found to hold,
A = assumption).  All values little-endian.

Entity lists live in archive entries of type 0x0a (scene files DAT/STxxyy.BIN, TITLE, DEMO,
SUBSCN) and type 0x0c (stage files DAT/STxx.BIN; same data, compressed).  Offsets inside an
entry are relative to the start of its payload.

    u32 count
    count x { u32 id; u32 model; u32 tracks; u32 control }                              (D, C)

`id` is the game's entity/object id (low byte 0x20 = animated character, 0x60 = static prop on
the files inspected; A).  `tracks`/`control` are 0 for static props.

Model header, 15 u32 at `model`                                                           (C)
    +0x00 u8 strips in LOD0, LOD1, LOD2; u8 ?
    +0x04 u32 strip table for LOD0, LOD1, LOD2 (usually the same table three times)
    +0x10 u32 skeleton (0 = none)       bones: 3 x i16 offset from the parent bone        (D, C)
    +0x14 u32 hierarchy (0 = none)      one record per strip:                             (D, C)
                                        u8 strip, u8 parent bone (>= bone count = none),
                                        u8 bone, u8 flags (0x80 hidden by default,
                                        0x40 on trunk/leg segments, 1/2 on face parts; A)
    +0x18 u32 materials                 u16 tpage, u16 clut (standard PSX encodings:      (C)
                                        page x = (tpage & 15) * 64, y = (tpage & 16) * 16;
                                        clut x = (clut & 63) * 16, y = clut >> 6)
    +0x1c u32 ? (non-zero on 48 of 356 entities; not decoded)
    +0x20 u32 x3 per-LOD table of RGBX bytes (vertex/face shading colours; not decoded)
    +0x2c ..  LOD switch distances and other constants (not decoded)

Strip header, 16 bytes                                                                    (D, C)
    u8 triangles, u8 quads, u8 vertices, i8 shift; u32 triangle offset, quad offset, vertex offset
Vertex, u32: x = bits 0-9, y = bits 10-19, z = bits 20-29, each 10-bit two's complement,
    multiplied by 2**shift; local to the strip's bone.  Bits 30-31 are always 0.          (D, C)
Face, 12 bytes: u8 u0, v0, u1, v1, u2, v2, u3, v3 (texel coordinates in the 256x256 texture
    page); u32: vertex indices in bits 0-6, 7-13, 14-20, 21-27, material index in bits 28-29,
    bits 30-31 = flags (not decoded).  Quads are stored A, B, C, D with triangles ABC + CBD
    (the PSX quad order).                                                                (D, C)

The player (COMMON/PLxxPyyy.BIN) has no entity list: three type 1 entries loaded at
0x80110800 / 0x80113a00 / 0x80123000 whose internal offsets are relative to 0x80110800.   (C)
  entry 0: +0x00 15 bones (i16 x3, padded to 0x60), +0x60 4 materials, then five groups of
           24-byte strip headers (as above plus two more u32 offsets: per-vertex normals and a
           second per-vertex table, 4 bytes per vertex each; not used here):
           body x6 at +0x80 (body, hip, right thigh, right shin, left thigh, left shin; names
           from the Miku-Legends-2 fixtures), then head x3 (hair/helmet, face, mouth), feet x2,
           left arm x3, buster arm x3, right arm x3.  Group positions differ per file and are
           found by scanning.  Which strip hangs off which bone is hard-coded in the game; the
           mapping used here is in PLAYER_GROUPS (C by rendering).
  entry 1: animation tracks, entry 2: control sequences (same layouts as entities).

Animation                                                                                 (C)
    tracks:  table of u32 offsets, one per track; a track is a run of frames, each frame
             (1 + bones) u32: first the root translation, then one rotation per bone, each
             packed as three 10-bit signed fields like a vertex, with bits 30-31 a left shift
             applied to all three.  Rotation unit after the shift: 4096 per turn (the PSX
             convention).  The shift is confirmed statistically: shift 1 or 2 only occurs when a
             component would not fit in 10 bits at the next smaller shift, and shift 3 never
             occurs for rotations (shift 2 already spans +-180 degrees).  The translation is
             added to the root bone's rest offset (DashGL forum notes).
    control: table of u32 offsets, one per sequence (0x8455 = unused slot);
             u8 track, u8 steps, u8 ?, u8 ?; steps x { u8 frame, u8 ticks, u8 ?, u8 flags
             (0xff on the last step) }.
    Euler composition order and the tick length are not stored in the data: see ROT_ORDER and
    TICK below for what is used and how it was chosen.

Scale: 1 unit = 0.00125 m (DashGL convention; MegaMan comes out ~1.3 m tall).  PSX axes are
x right, y down, z forward; exports are rotated 180 degrees about x to glTF's y up.
"""
import glob
import json
import math
import os
import struct
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import archive  # noqa: E402
import gltf  # noqa: E402
import textures  # noqa: E402

SCALE = 0.00125
NULL_SEQ = 0x8455
# R = Rx * Ry * Rz (z applied first).  Not stored in the data; chosen by a foot-planting test on
# the player's idle and walk tracks: with this order the lowest foot vertex stays within about
# one unit of y = 0 through the idle track and the soles are flat; the other five orders give
# 2-30x the spread.
ROT_ORDER = 'XYZ'
TICK = 1 / 30.0     # seconds per control tick (assumed: the game runs at 30 fps)

PLAYER_BASE = 0x80110800
# (group name, [(strip name, bone)]) in file order; bones: 0 root/body, 1 head, 2-4 right arm,
# 5-7 left arm, 8 hip, 9-11 right leg, 12-14 left leg
PLAYER_GROUPS = [
    ('body', [('body', 0), ('hip', 8), ('thigh_r', 9), ('shin_r', 10), ('thigh_l', 12), ('shin_l', 13)]),
    ('head', [('hair', 1), ('face', 1), ('mouth', 1)]),
    ('feet', [('foot_r', 11), ('foot_l', 14)]),
    ('arm_l', [('shoulder_l', 5), ('arm_l', 6), ('hand_l', 7)]),
    ('buster', [('buster_shoulder', 5), ('buster', 6), ('buster_muzzle', 7)]),
    ('arm_r', [('shoulder_r', 2), ('arm_r', 3), ('hand_r', 4)]),
]
PLAYER_PARENTS = [-1, 0, 0, 2, 3, 0, 5, 6, 0, 8, 9, 10, 8, 12, 13]


def s10(v):
    v &= 0x3ff
    return v - 0x400 if v & 0x200 else v


class Strip:
    def __init__(self, data, tri_n, quad_n, vert_n, shift, tri_o, quad_o, vert_o):
        self.name = ''
        self.bone = -1
        self.flags = 0
        mul = 2.0 ** shift
        words = struct.unpack_from('<%dI' % vert_n, data, vert_o)
        self.verts = np.array([[s10(w), s10(w >> 10), s10(w >> 20)] for w in words],
                              dtype=np.float32).reshape(-1, 3) * mul
        self.tris = []   # (indices[3], uv[3][2], material, flags)
        for i in range(tri_n):
            uv = data[tri_o + i * 12:tri_o + i * 12 + 8]
            w = struct.unpack_from('<I', data, tri_o + i * 12 + 8)[0]
            idx = (w & 127, (w >> 7) & 127, (w >> 14) & 127)
            self.tris.append((idx, [(uv[0], uv[1]), (uv[2], uv[3]), (uv[4], uv[5])],
                              (w >> 28) & 3, w >> 30))
        self.quads = tri_n
        for i in range(quad_n):
            uv = data[quad_o + i * 12:quad_o + i * 12 + 8]
            w = struct.unpack_from('<I', data, quad_o + i * 12 + 8)[0]
            a, b, c, d = w & 127, (w >> 7) & 127, (w >> 14) & 127, (w >> 21) & 127
            t = [(uv[0], uv[1]), (uv[2], uv[3]), (uv[4], uv[5]), (uv[6], uv[7])]
            m, f = (w >> 28) & 3, w >> 30
            self.tris.append(((a, b, c), [t[0], t[1], t[2]], m, f))
            self.tris.append(((c, b, d), [t[2], t[1], t[3]], m, f))
        self.counts = (tri_n, quad_n, vert_n)


class Model:
    def __init__(self):
        self.name = ''
        self.id = 0
        self.bones = np.zeros((0, 3), dtype=np.float32)
        self.parents = []
        self.strips = []
        self.materials = []     # (tpage, clut)
        self.tracks = []        # list of arrays (frames, 1 + bones, 4): x, y, z, top bits
        self.sequences = []     # (track, [(frame, ticks, flags)])
        self.notes = []

    def world_rest(self):
        out = np.zeros_like(self.bones)
        for i, p in enumerate(self.parents):
            out[i] = self.bones[i] + (out[p] if p >= 0 else 0)
        return out


def read_tracks(data, off, nbones, limit, base=0):
    """Track table at `off`; pointers are relative to `base` bytes before the payload."""
    if off is None:
        return []
    size = 4 * (1 + nbones)
    first = struct.unpack_from('<I', data, off)[0] - base
    n = (first - off) // 4
    if n <= 0 or n > 512:
        return []
    ptrs = [p - base for p in struct.unpack_from('<%dI' % n, data, off)]
    ends = sorted(set(p for p in ptrs if p > 0) | {limit})
    tracks = []
    for p in ptrs:
        if p <= 0 or p >= limit:
            tracks.append(None)
            continue
        end = ends[ends.index(p) + 1]
        frames = (end - p) // size
        words = np.frombuffer(data, dtype='<u4', count=frames * (1 + nbones), offset=p)
        words = words.reshape(frames, 1 + nbones).astype(np.int64)
        comp = np.stack([words & 0x3ff, (words >> 10) & 0x3ff, (words >> 20) & 0x3ff], axis=-1)
        comp = np.where(comp & 0x200, comp - 0x400, comp)
        tracks.append(np.concatenate([comp, (words >> 30)[..., None]], axis=-1))
    return tracks


def read_control(data, off, limit, base=0):
    if off is None:
        return []
    first = struct.unpack_from('<I', data, off)[0] - base
    n = (first - off) // 4
    if n <= 0 or n > 1024:
        return []
    seqs = []
    for p in struct.unpack_from('<%dI' % n, data, off):
        if p == NULL_SEQ or p - base <= 0 or p - base + 4 > limit:
            seqs.append(None)
            continue
        p -= base
        track, steps = data[p], data[p + 1]
        if p + 4 + steps * 4 > limit:
            seqs.append(None)
            continue
        rec = [(data[p + 4 + i * 4], data[p + 5 + i * 4], data[p + 7 + i * 4]) for i in range(steps)]
        seqs.append((track, rec))
    return seqs


def read_entity(data, ent_id, off, tracks, control):
    m = Model()
    m.id = ent_id
    h = struct.unpack_from('<15I', data, off)
    count = h[0] & 255
    table, skel, hier, mats = h[1], h[4], h[5], h[6]
    for k in range(count):
        tn, qn, vn, shift, to, qo, vo = struct.unpack_from('<BBBbIII', data, table + k * 16)
        m.strips.append(Strip(data, tn, qn, vn, shift, to, qo, vo))
    nb = 0
    if skel and hier:
        recs = [data[hier + k * 4:hier + k * 4 + 4] for k in range(count)]
        nb = max(r[2] for r in recs) + 1
        m.bones = np.array(struct.unpack_from('<%dh' % (nb * 3), data, skel),
                           dtype=np.float32).reshape(nb, 3)
        m.parents = [-1] * nb
        for strip, parent, bone, flags in recs:
            if strip < count:
                m.strips[strip].bone = bone
                m.strips[strip].flags = flags
            m.parents[bone] = parent if parent < nb and parent != bone else -1
    nmat = max([t[2] for s in m.strips for t in s.tris] or [0]) + 1
    m.materials = [struct.unpack_from('<HH', data, mats + i * 4) for i in range(nmat)]
    if tracks and nb:
        m.tracks = read_tracks(data, tracks, nb, control or len(data))
        m.sequences = read_control(data, control or None, len(data))
    return m


def entity_lists(data):
    """Yield (entry, [(id, model, tracks, control)]) for every entity list in an archive."""
    for e in archive.entries(data):
        if e.type not in (0x0a, 0x0c) or len(e.data) < 20:
            continue
        n = struct.unpack_from('<I', e.data, 0)[0]
        if not 0 < n <= 255 or 4 + n * 16 > len(e.data):
            continue
        ents = [struct.unpack_from('<4I', e.data, 4 + i * 16) for i in range(n)]
        if any(x[1] < 4 + n * 16 or x[1] + 60 > len(e.data) for x in ents):
            continue
        yield e, ents


def read_player(data):
    es = [e for e in archive.entries(data) if e.type == 1]
    body, anim, ctrl = es[0], es[1], es[2]
    d = body.data
    m = Model()
    m.bones = np.array(struct.unpack_from('<45h', d, 0), dtype=np.float32).reshape(15, 3)
    m.parents = list(PLAYER_PARENTS)
    m.materials = [struct.unpack_from('<HH', d, 0x60 + i * 4) for i in range(4)]
    # strip-header groups: runs of plausible 24-byte headers
    groups, o, n = [], 0x80, len(d)
    while o + 24 <= n:
        run = []
        while o + 24 <= n:
            tn, qn, vn, shift = struct.unpack_from('<BBBb', d, o)
            offs = struct.unpack_from('<5I', d, o + 4)
            ok = vn and (tn or qn) and 0 <= shift <= 4 and all(0 < x < n for x in offs) and \
                offs[0] <= offs[1] <= offs[2] < offs[3] < offs[4]
            if not ok:
                break
            run.append((tn, qn, vn, shift, offs[0], offs[1], offs[2]))
            o += 24
        if run:
            groups.append(run)
            o = (max(r[6] + r[2] * 4 for r in run) + 3) & ~3   # skip past this group's data
        else:
            o += 4
    for (gname, parts), run in zip(PLAYER_GROUPS, groups):
        for (pname, bone), hdr in zip(parts, run):
            s = Strip(d, *hdr)
            s.name, s.bone, s.group = pname, bone, gname
            m.strips.append(s)
    if len(groups) != len(PLAYER_GROUPS):
        m.notes.append('found %d strip groups, expected %d' % (len(groups), len(PLAYER_GROUPS)))
    a_base = anim.u32(0x0c) - PLAYER_BASE
    c_base = ctrl.u32(0x0c) - PLAYER_BASE
    m.tracks = read_tracks(anim.data, 0, 15, len(anim.data), a_base)
    m.sequences = read_control(ctrl.data, 0, len(ctrl.data), c_base)
    return m


# ---------------------------------------------------------------- posing

def euler_matrix(rx, ry, rz, order=None):
    order = order or ROT_ORDER
    cx, sx, cy, sy, cz, sz = math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)
    mats = {'X': np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]]),
            'Y': np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]),
            'Z': np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])}
    out = np.eye(3)
    for axis in order:
        out = out @ mats[axis]
    return out


def frame_local(model, frame, order=None):
    """(rotations (n,3,3), translations (n,3)) in PSX space for one track frame (None = rest)."""
    n = len(model.parents)
    rot = np.tile(np.eye(3), (n, 1, 1))
    pos = model.bones.astype(np.float64).copy()
    if frame is not None:
        t = frame[0]
        pos[0] = pos[0] + t[:3] * (2.0 ** t[3])
        for b in range(n):
            a = frame[1 + b][:3] * (2.0 ** frame[1 + b][3]) * (2 * math.pi / 4096)
            rot[b] = euler_matrix(a[0], a[1], a[2], order)
    return rot, pos


def pose(model, frame=None, order=None):
    """World (rotation, position) per bone in PSX space."""
    rot, pos = frame_local(model, frame, order)
    n = len(model.parents)
    wr = np.zeros((n, 3, 3))
    wp = np.zeros((n, 3))
    for b, p in enumerate(model.parents):
        if p < 0:
            wr[b], wp[b] = rot[b], pos[b]
        else:
            wr[b] = wr[p] @ rot[b]
            wp[b] = wp[p] + wr[p] @ pos[b]
    return wr, wp


def visible(strip, variant=None):
    return not strip.flags & 0x80


def triangles(model, frame=None, order=None, strips=None):
    """Posed triangle soup in PSX space: positions (n,3,3), uv (n,3,2), material (n,), bone (n,)."""
    if len(model.parents):
        wr, wp = pose(model, frame, order)
    P, UV, M, B = [], [], [], []
    for s in (strips if strips is not None else [s for s in model.strips if visible(s)]):
        v = s.verts.astype(np.float64)
        if s.bone >= 0 and len(model.parents):
            v = v @ wr[s.bone].T + wp[s.bone]
        for idx, uv, mat, _ in s.tris:
            P.append(v[list(idx)])
            UV.append(uv)
            M.append(mat)
            B.append(max(s.bone, 0))
    if not P:
        return np.zeros((0, 3, 3)), np.zeros((0, 3, 2)), np.zeros(0, int), np.zeros(0, int)
    return np.array(P), np.array(UV, dtype=np.float64), np.array(M), np.array(B)


# ---------------------------------------------------------------- textures

def material_images(model, vram):
    out = []
    for tpage, clut in model.materials:
        px, py = (tpage & 15) * 64, (tpage & 16) * 16
        bpp = 8 if (tpage >> 7) & 3 == 1 else 4
        cx, cy = (clut & 63) * 16, clut >> 6
        out.append(Image.fromarray(vram.page(px, py, cx, cy, bpp), 'RGBA'))
    return out


# ---------------------------------------------------------------- software preview

def render(model, images, size=256, yaw=0.0, frame=None, order=None, strips=None, bg=(40, 44, 52)):
    """Orthographic textured z-buffer render; yaw in degrees about the vertical axis."""
    P, UV, M, _ = triangles(model, frame, order, strips)
    img = np.empty((size, size, 3), dtype=np.uint8)
    img[:] = bg
    if not len(P):
        return Image.fromarray(img)
    c, s = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
    # view: PSX y is down already (screen y), look along +z after yaw
    X = P[..., 0] * c + P[..., 2] * s
    Z = -P[..., 0] * s + P[..., 2] * c
    Y = P[..., 1]
    lo = np.array([X.min(), Y.min()])
    hi = np.array([X.max(), Y.max()])
    span = max((hi - lo).max(), 1e-6)
    k = (size - 12) / span
    ox = (size - (hi[0] - lo[0]) * k) / 2 - lo[0] * k
    oy = (size - (hi[1] - lo[1]) * k) / 2 - lo[1] * k
    SX, SY = X * k + ox, Y * k + oy
    zbuf = np.full((size, size), np.inf)
    tex = [np.asarray(im) for im in images]
    for t in range(len(P)):
        x0, x1 = int(max(math.floor(SX[t].min()), 0)), int(min(math.ceil(SX[t].max()), size - 1))
        y0, y1 = int(max(math.floor(SY[t].min()), 0)), int(min(math.ceil(SY[t].max()), size - 1))
        if x1 < x0 or y1 < y0:
            continue
        ax, ay, bx, by, cx, cy = SX[t][0], SY[t][0], SX[t][1], SY[t][1], SX[t][2], SY[t][2]
        den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(den) < 1e-9:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        w0 = ((by - cy) * (gx - cx) + (cx - bx) * (gy - cy)) / den
        w1 = ((cy - ay) * (gx - cx) + (ax - cx) * (gy - cy)) / den
        w2 = 1 - w0 - w1
        inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not inside.any():
            continue
        z = w0 * Z[t][0] + w1 * Z[t][1] + w2 * Z[t][2]
        u = np.clip(w0 * UV[t][0][0] + w1 * UV[t][1][0] + w2 * UV[t][2][0], 0, 255).astype(int)
        v = np.clip(w0 * UV[t][0][1] + w1 * UV[t][1][1] + w2 * UV[t][2][1], 0, 255).astype(int)
        texel = tex[M[t]][v, u] if M[t] < len(tex) else np.full(u.shape + (4,), 255, dtype=np.uint8)
        zb = zbuf[y0:y1 + 1, x0:x1 + 1]
        ok = inside & (z < zb) & (texel[..., 3] > 0)
        zb[ok] = z[ok]
        img[y0:y1 + 1, x0:x1 + 1][ok] = texel[..., :3][ok]
    return Image.fromarray(img)


# ---------------------------------------------------------------- glTF export

def to_gl(v):
    """PSX (x right, y down, z forward) -> glTF (y up): rotate 180 degrees about x, scale."""
    v = np.asarray(v, dtype=np.float64) * SCALE
    return np.stack([v[..., 0], -v[..., 1], -v[..., 2]], axis=-1)


def quat_from_matrix(m):
    t = m[0, 0] + m[1, 1] + m[2, 2]
    if t > 0:
        s = math.sqrt(t + 1) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, s / 4]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [s / 4, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 1] + m[1, 0]) / s, s / 4, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = math.sqrt(1 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, s / 4, (m[1, 0] - m[0, 1]) / s]
    return q


FLIP = np.diag([1.0, -1.0, -1.0])


def export_glb(model, images, path, strips=None, name='model'):
    g = gltf.Glb()
    strips = strips if strips is not None else model.strips
    nb = len(model.parents)
    nodes = []
    bone_names = getattr(model, 'bone_names', None) or ['bone%02d' % i for i in range(nb)]
    for b in range(nb):
        nodes.append({'name': bone_names[b], 'translation': [float(x) for x in to_gl(model.bones[b])]})
    for b, p in enumerate(model.parents):
        if p >= 0:
            nodes[p].setdefault('children', []).append(b)
    g.json['nodes'] = nodes
    world = model.world_rest() if nb else np.zeros((0, 3))

    samplers = [{'magFilter': 9728, 'minFilter': 9728, 'wrapS': 33071, 'wrapT': 33071}]
    g.json['samplers'] = samplers
    mats = []
    for i, im in enumerate(images):
        tex = g.add('textures', {'sampler': 0, 'source': g.png(im)})
        mats.append(g.add('materials', {
            'name': 'mat%d' % i, 'alphaMode': 'MASK', 'alphaCutoff': 0.5, 'doubleSided': True,
            'pbrMetallicRoughness': {'baseColorTexture': {'index': tex}, 'metallicFactor': 0.0,
                                     'roughnessFactor': 1.0}}))

    mesh_nodes = []
    # hidden / alternative strips go to separate meshes so a viewer can toggle them
    groups = {}
    for s in strips:
        key = 'hidden' if s.flags & 0x80 else getattr(s, 'group', 'main')
        groups.setdefault(key, []).append(s)
    for key, group in groups.items():
        prims = []
        by_mat = {}
        for s in group:
            base = s.verts.astype(np.float64) + (world[s.bone] if nb and s.bone >= 0 else 0)
            for idx, uv, mat, _ in s.tris:
                d = by_mat.setdefault(mat, ([], [], []))
                for k in range(3):
                    d[0].append(base[idx[k]])
                    d[1].append(((uv[k][0] + 0.5) / 256, (uv[k][1] + 0.5) / 256))
                    d[2].append(max(s.bone, 0))
        for mat, (pos, uv, joint) in sorted(by_mat.items()):
            pos = to_gl(np.array(pos)).astype(np.float32)
            attrs = {'POSITION': g.accessor(pos, 'VEC3', gltf.FLOAT, gltf.ARRAY_BUFFER, minmax=True),
                     'TEXCOORD_0': g.accessor(np.array(uv, dtype=np.float32), 'VEC2', gltf.FLOAT,
                                              gltf.ARRAY_BUFFER)}
            if nb:
                j = np.zeros((len(joint), 4), dtype=np.uint8)
                j[:, 0] = joint
                w = np.zeros((len(joint), 4), dtype=np.float32)
                w[:, 0] = 1
                attrs['JOINTS_0'] = g.accessor(j, 'VEC4', gltf.UBYTE, gltf.ARRAY_BUFFER)
                attrs['WEIGHTS_0'] = g.accessor(w, 'VEC4', gltf.FLOAT, gltf.ARRAY_BUFFER)
            prim = {'attributes': attrs, 'mode': 4}
            if mat < len(mats):
                prim['material'] = mats[mat]
            prims.append(prim)
        if not prims:
            continue
        node = {'name': '%s_%s' % (name, key), 'mesh': g.add('meshes', {'name': key, 'primitives': prims})}
        if nb:
            node['skin'] = 0
        nodes.append(node)
        mesh_nodes.append(len(nodes) - 1)

    if nb:
        ibm = np.tile(np.eye(4, dtype=np.float32), (nb, 1, 1))
        ibm[:, 3, :3] = -to_gl(world)     # column-major storage: translation in the last row
        g.json['skins'] = [{'joints': list(range(nb)),
                            'inverseBindMatrices': g.accessor(ibm.reshape(nb, 16), 'MAT4', gltf.FLOAT)}]
    roots = [b for b, p in enumerate(model.parents) if p < 0] + mesh_nodes
    g.json['scenes'] = [{'nodes': roots}]
    g.json['scene'] = 0

    nanim = 0
    for si, seq in enumerate(model.sequences):
        if not seq or seq[0] >= len(model.tracks) or model.tracks[seq[0]] is None:
            continue
        track, steps = model.tracks[seq[0]], seq[1]
        if not steps or any(f >= len(track) for f, _, _ in steps):
            continue
        times, t = [], 0.0
        for f, ticks, _ in steps:
            times.append(t)
            t += max(ticks, 1) * TICK
        tacc = g.accessor(np.array(times, dtype=np.float32), 'SCALAR', gltf.FLOAT, minmax=True)
        samplers_, channels = [], []
        frames = [frame_local(model, track[f]) for f, _, _ in steps]
        for b in range(nb):
            q = np.array([quat_from_matrix(FLIP @ fr[0][b] @ FLIP) for fr in frames], dtype=np.float32)
            for k in range(1, len(q)):          # keep neighbouring quaternions in one hemisphere
                if np.dot(q[k], q[k - 1]) < 0:
                    q[k] = -q[k]
            samplers_.append({'input': tacc, 'output': g.accessor(q, 'VEC4', gltf.FLOAT),
                              'interpolation': 'LINEAR'})
            channels.append({'sampler': len(samplers_) - 1, 'target': {'node': b, 'path': 'rotation'}})
        tr = to_gl(np.array([fr[1][0] for fr in frames])).astype(np.float32)
        samplers_.append({'input': tacc, 'output': g.accessor(tr, 'VEC3', gltf.FLOAT),
                          'interpolation': 'LINEAR'})
        channels.append({'sampler': len(samplers_) - 1, 'target': {'node': 0, 'path': 'translation'}})
        g.add('animations', {'name': 'seq%03d_track%03d' % (si, seq[0]), 'samplers': samplers_,
                             'channels': channels})
        nanim += 1
    g.write(path)
    return nanim


# ---------------------------------------------------------------- driver

def vram_for(disc, names):
    v = textures.Vram()
    used = []
    for n in names:
        for sub in ('COMMON', 'DAT'):
            p = os.path.join(disc, sub, n + '.BIN')
            if os.path.exists(p):
                v.load_archive(open(p, 'rb').read())
                used.append(n)
    return v, used


def summary(model):
    return {'bones': len(model.parents), 'strips': len(model.strips),
            'triangles': sum(s.counts[0] for s in model.strips),
            'quads': sum(s.counts[1] for s in model.strips),
            'vertices': sum(s.counts[2] for s in model.strips),
            'materials': [{'tpage': '0x%04x' % t, 'clut': '0x%04x' % c,
                           'page': [(t & 15) * 64, (t & 16) * 16],
                           'clut_xy': [(c & 63) * 16, c >> 6]} for t, c in model.materials],
            'tracks': len([t for t in model.tracks if t is not None]),
            'sequences': len([s for s in model.sequences if s])}


def main():
    disc, out_root = sys.argv[1], sys.argv[2]
    prefix = sys.argv[3] if len(sys.argv) > 3 else ''
    index = []
    for path in sorted(glob.glob(os.path.join(disc, '*', '*.BIN'))):
        stem = os.path.splitext(os.path.basename(path))[0]
        if not stem.startswith(prefix):
            continue
        data = open(path, 'rb').read()
        lists = list(entity_lists(data))
        if not lists:
            continue
        # stage ST12 -> textures ST12T; scene ST1201 -> ST12T then ST1201T
        tex_names = [stem[:4] + 'T', stem + 'T'] if stem.startswith('ST') else [stem]
        vram, used = vram_for(disc, tex_names)
        out = os.path.join(out_root, stem)
        os.makedirs(out, exist_ok=True)
        for e, ents in lists:
            for i, (ent_id, moff, toff, coff) in enumerate(ents):
                try:
                    m = read_entity(e.data, ent_id, moff, toff, coff)
                    images = material_images(m, vram)
                    name = 'e%d_%02d_%06x' % (e.index, i, ent_id)
                    nanim = export_glb(m, images, os.path.join(out, name + '.glb'), name=name)
                    render(m, images, 192, yaw=25).save(os.path.join(out, name + '.png'))
                    rec = {'archive': stem, 'entry': e.index, 'index': i, 'id': '0x%06x' % ent_id,
                           'glb': '%s/%s.glb' % (stem, name), 'preview': '%s/%s.png' % (stem, name),
                           'textures_from': used, 'animations': nanim}
                    rec.update(summary(m))
                    index.append(rec)
                except Exception as ex:  # keep going; record what failed
                    index.append({'archive': stem, 'entry': e.index, 'index': i,
                                  'id': '0x%06x' % ent_id, 'error': repr(ex)})
    with open(os.path.join(out_root, 'index.json' if not prefix else 'index_%s.json' % prefix), 'w') as f:
        json.dump(index, f, indent=1)
    ok = [r for r in index if 'error' not in r]
    print('%d entities exported, %d failed, %d animations' % (
        len(ok), len(index) - len(ok), sum(r['animations'] for r in ok)))


if __name__ == '__main__':
    main()
