/**
 * mbac.js -- parser + poser for HI Corporation "MascotCapsule Micro3D v3" figure
 * (MBAC, ".mba"/".mbac") and action-table (MTRA, ".mtr"/".mtra") files as used by
 * "Rockman DASH: Great Adventure on 5 Islands" (NTT DoCoMo i-appli, DoJa 5.x, 2008),
 * plus the 8-bit BMP texture loader that goes with them.
 *
 * Dependency-free ES module. Does NOT import three.js; it returns plain data
 * (typed arrays + descriptors) from which three.js objects can be built.
 *
 * =============================================================================
 * 0. ATTRIBUTION / LICENCE
 * =============================================================================
 * This file is a JavaScript port of parts of the micro3d implementation in
 * JL-Mod (https://github.com/woesss/JL-Mod), package ru.woesss.j2me.micro3d:
 *   Loader.java, Model.java, Action.java, FigureImpl.java, ActTableImpl.java,
 *   MathUtil.java, Render.java (material interpretation only) and
 *   cpp/micro3d/src/utils.cpp (bone transform).
 *   Copyright 2020-2023 Yury Kharchenko.
 *   Licensed under the Apache License, Version 2.0
 *   (http://www.apache.org/licenses/LICENSE-2.0). The reference is distributed on
 *   an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
 * Changes relative to the reference: re-expressed in JavaScript; polygons are
 * returned as material-keyed draw batches instead of GL sub-mesh length tables;
 * the bone matrices of an action are evaluated without the per-bone frame cache
 * objects; a few fields the reference reads and discards are kept.
 *
 * =============================================================================
 * 1. MBAC (figure) FILE LAYOUT, as implemented (all multi-byte values LITTLE-endian)
 * =============================================================================
 *   off size field
 *   0   2    magic "MB"
 *   2   1    version (2..5; every sample of this game is 5, six are 4)
 *   3   1    0
 *   -- version >= 4 only (else vertexFormat=1 normalFormat=0 polygonFormat=1 boneFormat=1)
 *   4   1    vertexFormat   1 = raw s16 xyz, 2 = bit-packed chunks
 *   5   1    normalFormat   0 = none, 1 = raw s16 xyz, 2 = bit-packed
 *   6   1    polygonFormat  1, 2 (textured only) or 3 (textured + coloured, patterns)
 *   7   1    boneFormat     must be 1
 *   --
 *       2    numVertices          (<= 21845)
 *       2    numPolyT3            textured triangles
 *       2    numPolyT4            textured quads
 *       2    numBones
 *   -- polygonFormat >= 3 only (else numTextures=1, numPatterns=1, others 0)
 *       2    numPolyC3            flat-coloured triangles
 *       2    numPolyC4            flat-coloured quads
 *       2    numTextures          (<= 16)
 *       2    numPatterns          (<= 33)
 *       2    numColors            (<= 256)
 *   -- version == 5 only: numPatterns x pattern record
 *       2,2  numC3, numC4                          coloured polys in this pattern
 *       numTextures x (2,2)  numT3, numT4          textured polys per texture
 *      (for version < 5 one implicit pattern {C3,C4},{T3,T4} is used)
 *   -- vertices
 *      format 1: numVertices x (s16 x, s16 y, s16 z)
 *      format 2: bit stream (LSB first). Repeated chunks until numVertices read:
 *                8 bits header: top 2 bits -> component width {8,10,13,16} bits,
 *                low 6 bits + 1 = vertex count; then count x 3 signed components.
 *      -> byte align
 *   -- normals (normalFormat != 0), unit length == 4096
 *      format 1: numVertices x (s16 x, s16 y, s16 z)
 *      format 2: bit stream, per vertex: 7 bits X. If X == 64: 3 bits selecting an
 *                axis normal (0:+X 1:+Y 2:+Z 3:-X 4:-Y 5:-Z). Otherwise x = sext7(X)*64,
 *                7 bits Y -> y likewise, 1 bit sign, z = +-round(sqrt(4096^2-x^2-y^2)).
 *      -> byte align
 *   -- coloured polygons (only if numPolyC3 + numPolyC4 > 0)
 *      u8 materialBits, u8 vertexIndexBits, u8 colorBits, u8 colorIdBits, u8 unknown(0)
 *      bit stream: numColors x 3 x colorBits (R,G,B)
 *        numPolyC3 x { material(materialBits), a, b, c (vertexIndexBits), colorId(colorIdBits) }
 *        numPolyC4 x { material, a, b, c, d, colorId }
 *      the stored material is shifted left by one to line up with the textured
 *      flag layout below (so coloured polygons never have the colour-key bit).
 *      NOT byte-aligned afterwards: the textured block continues the same bit stream.
 *   -- textured polygons (only if numPolyT3 + numPolyT4 > 0)
 *      format 3: 8 bits materialBits, 8 bits vertexIndexBits, 8 bits uvBits, 8 bits unknown(0)
 *        numPolyT3 x { material, a, b, c, (u,v) x 3 (uvBits each) }
 *        numPolyT4 x { material, a, b, c, d, (u,v) x 4 }
 *      format 2: u8 materialBits, u8 vertexIndexBits, same records with 7-bit u/v
 *      format 1: byte records: u16 material, u16 indices, s8 u/v
 *      -> byte align
 *   -- bones: numBones x 28 bytes
 *      u16 numVertices   (bones own CONSECUTIVE vertex runs, in bone order; the sum
 *                         over all bones must equal the header's numVertices)
 *      s16 parent        (-1 = root; a parent always precedes its children)
 *      12 x s16          3x4 matrix, row-major: m00 m01 m02 m03 / m10.. / m20..
 *                        rotation part is 4096 = 1.0, translation (m03,m13,m23) is
 *                        in model units. This is the bone's REST transform RELATIVE
 *                        TO ITS PARENT.
 *   -- version >= 4: 20 trailing bytes the reference skips (kept as `trailer`).
 *
 * IMPORTANT: vertices and normals are stored in BONE-LOCAL space. The bind pose
 * is obtained by transforming each vertex with the accumulated rest matrix of its
 * bone (the reference does this once at load time); `model.positions` is that
 * bind pose, `model.localPositions` is the raw file data.
 *
 * Material flags (textured layout; `material` on batches/polygons):
 *   0x01 TRANSPARENT  colour key: texels with palette index 0 are discarded
 *   0x06 blend mode   0x00 none, 0x02 half (0.5*src + 0.5*dst), 0x04 add (src+dst),
 *                     0x06 sub (dst - src). Blending is only performed when the
 *                     application enables ENV_ATTR_SEMI_TRANSPARENT on the effect/
 *                     Graphics3D; otherwise all polygons are drawn opaque.
 *   0x10 DOUBLE_FACE  back-face culling disabled
 *   0x20 LIGHTING     polygon is lit (needs normals + ENV_ATTR_LIGHTING)
 *   0x40 SPECULAR     sphere/environment map highlight (ENV_ATTR_SPHERE_MAP)
 *   0x08 and 0xFC00 must be zero (the reference rejects the file); 0x80, 0x100 and
 *   0x200 are accepted but not interpreted by the reference.
 *
 * Patterns: pattern record i tags its polygons with mask (i == 0 ? 0 : 1 << i).
 * A polygon is visible for an application pattern value P iff (mask & P) == mask,
 * so group 0 is always visible. See isPatternVisible().
 *
 * =============================================================================
 * 2. MTRA (action table) FILE LAYOUT
 * =============================================================================
 *   0   2    magic "MT"
 *   2   1    version (2..5), 3: 0
 *   4   2    numActions
 *   6   2    numBones
 *   8   16   8 x u16 transTypeCounts (number of bone tracks of each type, summed
 *            over all actions; index 7 unused)
 *   24  4    u32 dataSize (not needed for parsing)
 *   per action:
 *     u16 keyframes  (the action's length in whole frames)
 *     numBones x bone track: u8 type, then
 *       0: 12 x s16 fixed matrix (same encoding as a bone matrix)
 *       1: nothing (identity)
 *       2: translate keys, scale keys, rotate keys, roll keys
 *       3: s16 x,y,z constant translate; rotate keys; s16 constant roll
 *       4: rotate keys, roll keys
 *       5: rotate keys
 *       6: translate keys, rotate keys, roll keys
 *       where "xyz keys" = u16 count, count x { u16 frame, s16 x, s16 y, s16 z }
 *       and  "roll keys" = u16 count, count x { u16 frame, s16 angle }
 *       translate: model units; scale: 4096 = 1.0; rotate: a direction vector (the
 *       bone's new local Z axis, any length); roll: angle about that axis, 4096 =
 *       full turn.
 *     version 5: u16 count, count x { u16 frame, s32 pattern }  ("dynamic" pattern
 *       keys: at integer frame >= key.frame the figure's pattern becomes key.pattern)
 *   version >= 4: 20 trailing bytes (kept as `trailer`).
 *
 * =============================================================================
 * 3. COORDINATE CONVENTIONS
 * =============================================================================
 *  - Units: positions are the file's integers, unscaled (bone translations and
 *    translate keys use the same unit). Normals are in 4096 = unit length and are
 *    NOT renormalised after posing (exactly like the reference, whose shader
 *    normalises); scale tracks therefore also scale normals.
 *  - Axes / handedness: positions are returned exactly as stored (no axis flip).
 *    The coordinates are RIGHT-HANDED. In this game's character models the bind
 *    pose stands on y = 0 with the head at +Y and the toes pointing to +Z (so the
 *    character's left hand is at +X) -- i.e. already the three.js convention
 *    (Y up, right-handed); no conversion is needed.   [data: rock.mba, roll.mba]
 *    (Micro3D's own VIEW space, after the application's view transform, is
 *    +X right, +Y DOWN, +Z into the screen; that flip lives in the game's camera
 *    matrix, not in the model data.)
 *  - Winding: polygons are emitted in file order (a,b,c); quads as (a,b,c),(c,b,d)
 *    exactly like the reference (quad corners are stored in "Z"/strip order
 *    a b / c d). In file order FRONT faces are CLOCKWISE when seen from outside,
 *    i.e. the outward normal is -(b-a)x(c-a)   [data: agrees with the stored vertex
 *    normals for > 99% of all triangles; reference: GL counter-clockwise front
 *    faces in a clip space whose image is flipped vertically on read-back].
 *    three.js expects counter-clockwise, so either pass { flipWinding: true } to
 *    parseMBAC (emits (a,c,b),(c,d,b)) or render with side: THREE.BackSide.
 *    Stored vertex normals point outwards regardless of this option.
 *  - UVs: in TEXELS (integer 0..255), u to the right, v DOWN, origin = top-left
 *    pixel of the BMP as displayed. Normalise with u / texWidth, v / texHeight
 *    (the reference shader does exactly that, no half-texel offset, nearest
 *    filtering, clamp-to-edge). With parseBMP()'s top-down rows uploaded as a
 *    DataTexture with flipY = false no further V flip is needed.
 *
 * =============================================================================
 * 4. FRAME / TIME UNITS
 * =============================================================================
 *  `frame` passed to poseModel() is the same 16.16 fixed-point value the Java API
 *  takes in Figure.setPosture(actionTable, action, frame): 65536 = one keyframe
 *  unit. action.maxFrame = keyframes << 16 is what ActionTable.getNumFrames(action)
 *  returns. Negative frames are clamped to 0; frames past the last key hold the
 *  last key (no wrap-around -- looping is the application's business). Key values
 *  are linearly interpolated per component (rotate direction vectors too, then
 *  normalised); everything is evaluated in float32 like the reference.
 *  Keys are stored at integer frames 0..keyframes INCLUSIVE in the sample data, so
 *  frame == maxFrame is a real pose (the last key), not a wrap to frame 0.
 *
 *  One deliberate deviation from the reference: a zero-length rotate vector is
 *  treated as identity rotation instead of producing NaN (see setRotate()).
 *
 *  poseModel() only moves vertices. The pattern (polygon visibility) change that
 *  Figure.setPosture(table, action, frame) also performs is exposed separately as
 *  getActionPattern(); apply it with batch.trianglePattern + isPatternVisible().
 *
 * =============================================================================
 * 5. THREE.JS WIRING SKETCH
 * =============================================================================
 *   const model = parseMBAC(bytes, { flipWinding: true });   // CCW front faces
 *   const table = parseMTRA(animBytes);
 *   const posed = new Float32Array(model.numVertices * 3);
 *   for (const b of model.batches) {
 *     // geometry: non-indexed, b.numCorners vertices
 *     //   position[c] = posed[b.cornerVertex[c]]   (expandToCorners(b, posed, out))
 *     //   uv[c]       = (b.uvs[2c] / texW, b.uvs[2c+1] / texH), texture.flipY = false
 *     //   color[c]    = b.colors[3c..] / 255       (untextured batches)
 *     // material: side = b.doubleSided ? DoubleSide : FrontSide,
 *     //   alphaTest 0.5 if b.transparent, blending from b.blend, map = textures[b.textureIndex]
 *   }
 *   each tick: poseModel(model, table, action, frame16_16, posed); re-expand; and
 *   hide triangles with !isPatternVisible(b.trianglePattern[t], pattern).
 *   Reference draw order: opaque pass = all batches with blendMode 0 (depth write
 *   on); then, depth write off, the blended batches in batch order.
 */

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const fround = Math.fround;

/** fixed-point -> float factor for matrix rotation parts and scale keys */
const TO_FLOAT = 1 / 4096;
/** (float)(Math.PI / 2048.0): roll angle unit -> radians */
const TO_RADIANS = fround(Math.PI / 2048.0);

/** Unit length of normals as returned by parseMBAC()/poseModel(). */
export const NORMAL_SCALE = 4096;
/** One keyframe in the 16.16 frame units of poseModel(). */
export const FRAME_ONE = 65536;

export const MATERIAL_TRANSPARENT = 0x01;
export const MATERIAL_BLEND_MASK = 0x06;
export const MATERIAL_BLEND_HALF = 0x02;
export const MATERIAL_BLEND_ADD = 0x04;
export const MATERIAL_BLEND_SUB = 0x06;
export const MATERIAL_DOUBLE_FACE = 0x10;
export const MATERIAL_LIGHTING = 0x20;
export const MATERIAL_SPECULAR = 0x40;

/** blendMode (0..3) -> name */
export const BLEND_NAMES = ['none', 'half', 'add', 'sub'];

const POOL_NORMALS = [0, 0, 4096, 0, 0, -4096, 0, 0];
const VERTEX_BIT_SIZES = [8, 10, 13, 16];
const IDENTITY_AFFINE = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

// ---------------------------------------------------------------------------
// byte / bit reader (port of the private readers of Loader.java)
// ---------------------------------------------------------------------------

class Reader {
  /** @param {Uint8Array} data */
  constructor(data) {
    this.data = data;
    this.length = data.length;
    this.pos = 0;
    this.cached = 0; // number of valid bits in `cache`
    this.cache = 0;
  }

  eof() {
    return new RangeError(`unexpected end of data at offset ${this.pos} (length ${this.length})`);
  }

  u8() {
    if (this.pos >= this.length) throw this.eof();
    return this.data[this.pos++];
  }

  s8() {
    return (this.u8() << 24) >> 24;
  }

  u16() {
    if (this.pos + 2 > this.length) throw this.eof();
    const d = this.data;
    const v = d[this.pos] | (d[this.pos + 1] << 8);
    this.pos += 2;
    return v;
  }

  s16() {
    return (this.u16() << 16) >> 16;
  }

  s32() {
    if (this.pos + 4 > this.length) throw this.eof();
    const d = this.data;
    const v = d[this.pos] | (d[this.pos + 1] << 8) | (d[this.pos + 2] << 16) | (d[this.pos + 3] << 24);
    this.pos += 4;
    return v;
  }

  skip(n) {
    if (this.pos + n > this.length) throw this.eof();
    this.pos += n;
  }

  available() {
    return this.length - this.pos;
  }

  /** LSB-first bit reader, size <= 25 */
  ubits(size) {
    if (size > 25) throw new RangeError(`invalid bit size ${size}`);
    while (size > this.cached) {
      this.cache |= this.u8() << this.cached;
      this.cached += 8;
    }
    const mask = ~(0xffffffff << size);
    const result = this.cache & mask;
    this.cached -= size;
    this.cache >>>= size;
    return result;
  }

  /** signed variant of ubits() */
  bits(size) {
    const lzb = 32 - size;
    return (this.ubits(size) << lzb) >> lzb;
  }

  clearCache() {
    this.cache = 0;
    this.cached = 0;
  }
}

function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('expected Uint8Array / ArrayBuffer');
}

// ---------------------------------------------------------------------------
// MBAC
// ---------------------------------------------------------------------------

/**
 * Parse an MBAC figure.
 *
 * @param {Uint8Array} bytes
 * @param {{flipWinding?: boolean}} [opts]  flipWinding: emit triangles as (a,c,b)
 *        / (c,d,b) so that front faces are counter-clockwise (three.js default).
 *        Affects `batches` only (model.polygons keeps file order).
 * @returns {MbacModel} see the bottom of this file for the object shape.
 */
export function parseMBAC(bytes, opts = {}) {
  const flipWinding = !!opts.flipWinding;
  const r = new Reader(toBytes(bytes));
  const warnings = [];

  if (r.u8() !== 0x4d || r.u8() !== 0x42) throw new Error('Not a MBAC file');
  const version = r.u8();
  if (r.u8() !== 0 || version < 2 || version > 5) throw new Error(`Unsupported MBAC version: ${version}`);

  let vertexFormat = 1;
  let normalFormat = 0;
  let polygonFormat = 1;
  let boneFormat = 1;
  if (version > 3) {
    vertexFormat = r.u8();
    normalFormat = r.u8();
    polygonFormat = r.u8();
    boneFormat = r.u8();
  }
  if (boneFormat !== 1) throw new Error(`Unexpected bone format: ${boneFormat}`);

  const numVertices = r.u16();
  const numPolyT3 = r.u16();
  const numPolyT4 = r.u16();
  const numBones = r.u16();

  let numTextures = 1;
  let numColors = 0;
  let numPolyC3 = 0;
  let numPolyC4 = 0;
  let numPatterns = 1;
  if (polygonFormat >= 3) {
    numPolyC3 = r.u16();
    numPolyC4 = r.u16();
    numTextures = r.u16();
    numPatterns = r.u16();
    numColors = r.u16();
  }
  if (numVertices > 21845 || numTextures > 16 || numPatterns > 33 || numColors > 256) {
    throw new Error(`MBAC format error: numVertices=${numVertices} numTextures=${numTextures} ` +
      `numPatterns=${numPatterns} numColors=${numColors}`);
  }

  // ---- pattern records -----------------------------------------------------
  // patternCounts[i] = { c3, c4, tex: [[t3, t4] x numTextures] }
  const patternCounts = [];
  for (let i = 0; i < numPatterns; i++) {
    const tex = [];
    for (let j = 0; j < numTextures; j++) tex.push([0, 0]);
    patternCounts.push({ c3: 0, c4: 0, tex });
  }
  if (version === 5) {
    for (let i = 0; i < numPatterns; i++) {
      const p = patternCounts[i];
      p.c3 = r.u16();
      p.c4 = r.u16();
      for (let j = 0; j < numTextures; j++) {
        p.tex[j][0] = r.u16();
        p.tex[j][1] = r.u16();
      }
    }
  } else {
    // reference: patterns[0] = {{C3, C4}, {T3, T4}} (only texture 0)
    patternCounts[0] = { c3: numPolyC3, c4: numPolyC4, tex: [[numPolyT3, numPolyT4]] };
  }

  // ---- vertices (bone-local) -----------------------------------------------
  const localPositions = new Float32Array(numVertices * 3);
  if (vertexFormat === 1) {
    for (let i = 0; i < localPositions.length; i++) localPositions[i] = r.s16();
  } else if (vertexFormat === 2) {
    let n = 0; // vertices read
    while (n < numVertices) {
      const chunk = r.ubits(8);
      const size = VERTEX_BIT_SIZES[chunk >> 6];
      const count = (chunk & 0x3f) + 1;
      if (count > numVertices - n) throw new Error('Vertex data largest numVertices param');
      for (let i = 0; i < count; i++, n++) {
        localPositions[n * 3] = r.bits(size);
        localPositions[n * 3 + 1] = r.bits(size);
        localPositions[n * 3 + 2] = r.bits(size);
      }
    }
  } else {
    throw new Error(`Unexpected vertexFormat: ${vertexFormat}`);
  }
  r.clearCache();

  // ---- normals (bone-local, 4096 = 1.0) ------------------------------------
  let localNormals = null;
  if (normalFormat !== 0) {
    localNormals = new Float32Array(numVertices * 3);
    if (normalFormat === 1) {
      for (let i = 0; i < localNormals.length; i++) localNormals[i] = r.s16();
    } else if (normalFormat === 2) {
      for (let i = 0; i < numVertices; i++) {
        let x = r.ubits(7);
        let y;
        let z;
        if (x === 64) {
          const type = r.ubits(3);
          if (type > 5) throw new Error('Normal read error');
          z = POOL_NORMALS[type];
          y = POOL_NORMALS[type + 1];
          x = POOL_NORMALS[type + 2];
        } else {
          x = (x << 25) >> 19;
          y = (r.ubits(7) << 25) >> 19;
          const sign = r.ubits(1);
          const dq = 4096 * 4096 - x * x - y * y;
          // Java Math.round(double) == floor(v + 0.5); v >= 0 here so identical
          z = dq > 0 ? Math.round(Math.sqrt(dq)) : 0;
          if (sign === 1) z = -z;
        }
        localNormals[i * 3] = x;
        localNormals[i * 3 + 1] = y;
        localNormals[i * 3 + 2] = z;
      }
    } else {
      throw new Error(`Unsupported normalFormat: ${normalFormat}`);
    }
  }
  r.clearCache();

  // ---- polygons ------------------------------------------------------------
  // Each polygon: { textured, material, indices:[3|4], uvs:[6|8]|null, color:[r,g,b]|null,
  //                 texture, pattern }
  const polygonsC = [];
  const polygonsT = [];
  const polyInfo = { colored: null, textured: null };

  const checkIdx = (...idx) => {
    for (const i of idx) {
      if (i >= numVertices) throw new Error('Format error: indices greatest or equal num vertices');
    }
  };

  let palette = null;
  if (numPolyC3 + numPolyC4 > 0) {
    const materialBits = r.u8();
    const vertexIndexBits = r.u8();
    const colorBits = r.u8();
    const colorIdBits = r.u8();
    const unknownByte = r.u8();
    if (unknownByte !== 0) warnings.push(`PolyC unknownByte = ${unknownByte}`);
    polyInfo.colored = { materialBits, vertexIndexBits, colorBits, colorIdBits, unknownByte };

    palette = new Uint8Array(numColors * 3);
    for (let i = 0; i < palette.length; i++) palette[i] = r.ubits(colorBits);

    const total = numPolyC3 + numPolyC4;
    for (let i = 0; i < total; i++) {
      const quad = i >= numPolyC3;
      const material = r.ubits(materialBits) << 1;
      if ((material & 0xfc09) !== 0) throw new Error(`Unexpected material: ${material}`);
      const a = r.ubits(vertexIndexBits);
      const b = r.ubits(vertexIndexBits);
      const c = r.ubits(vertexIndexBits);
      const indices = [a, b, c];
      if (quad) indices.push(r.ubits(vertexIndexBits));
      checkIdx(...indices);
      const colorId = r.ubits(colorIdBits);
      if (colorId >= numColors) throw new Error(`Format error: color index ${colorId} >= ${numColors}`);
      polygonsC.push({
        textured: false,
        material,
        indices,
        uvs: null,
        colorId,
        color: [palette[colorId * 3], palette[colorId * 3 + 1], palette[colorId * 3 + 2]],
        texture: -1,
        pattern: 0,
      });
    }
  }

  if (numPolyT3 + numPolyT4 > 0) {
    const total = numPolyT3 + numPolyT4;
    if (polygonFormat === 1) {
      polyInfo.textured = { materialBits: 16, vertexIndexBits: 16, uvBits: 8, unknownByte: 0 };
      for (let i = 0; i < total; i++) {
        const quad = i >= numPolyT3;
        const raw = r.u16();
        if (!quad && (raw & 0xfff9) !== 0) throw new Error(`Unexpected material: ${raw}`);
        if (quad && ((raw & 0xfff8) !== 0 || (raw & 1) === 0)) throw new Error(`Unexpected material: ${raw}`);
        const indices = [r.u16(), r.u16(), r.u16()];
        if (quad) indices.push(r.u16());
        checkIdx(...indices);
        const uvs = [];
        // the reference keeps these as signed bytes and hands them to GL as
        // GL_UNSIGNED_BYTE, i.e. they are unsigned texel coordinates
        for (let k = 0; k < indices.length * 2; k++) uvs.push(r.u8());
        // v1 layout: bit 2 -> DOUBLE_FACE, bit 1 -> TRANSPARENT
        const material = ((raw & 4) << 2) | ((raw & 2) >> 1);
        polygonsT.push({ textured: true, material, indices, uvs, colorId: -1, color: null, texture: -1, pattern: 0 });
      }
    } else if (polygonFormat === 2 || polygonFormat === 3) {
      let materialBits;
      let vertexIndexBits;
      let uvBits;
      let unknownByte = 0;
      let reject;
      if (polygonFormat === 2) {
        materialBits = r.u8();
        vertexIndexBits = r.u8();
        uvBits = 7;
        reject = 0xff88;
      } else {
        materialBits = r.ubits(8);
        vertexIndexBits = r.ubits(8);
        uvBits = r.ubits(8);
        unknownByte = r.ubits(8);
        if (unknownByte !== 0) warnings.push(`PolyT v3: unknownByte = ${unknownByte}`);
        reject = 0xfc08;
      }
      polyInfo.textured = { materialBits, vertexIndexBits, uvBits, unknownByte };
      for (let i = 0; i < total; i++) {
        const quad = i >= numPolyT3;
        const material = r.ubits(materialBits);
        if ((material & reject) !== 0) throw new Error(`Unexpected material: ${material}`);
        const a = r.ubits(vertexIndexBits);
        const b = r.ubits(vertexIndexBits);
        const c = r.ubits(vertexIndexBits);
        const indices = [a, b, c];
        if (quad) indices.push(r.ubits(vertexIndexBits));
        checkIdx(...indices);
        const uvs = [];
        for (let k = 0; k < indices.length * 2; k++) uvs.push(r.ubits(uvBits) & 0xff);
        polygonsT.push({ textured: true, material, indices, uvs, colorId: -1, color: null, texture: -1, pattern: 0 });
      }
    } else {
      throw new Error(`Unexpected polygonFormat: ${polygonFormat}`);
    }
  }
  r.clearCache();

  // ---- assign pattern masks / texture indices -------------------------------
  {
    let c3 = 0;
    let c4 = numPolyC3;
    let t3 = 0;
    let t4 = numPolyT3;
    const take = (list, idx, what) => {
      if (idx >= list.length) throw new Error(`MBAC format error: pattern table overruns ${what} polygon list`);
      return list[idx];
    };
    for (let i = 0; i < numPatterns; i++) {
      const pc = patternCounts[i];
      const mask = i === 0 ? 0 : (1 << i) >>> 0; // Java: 1 << i (wraps at 32)
      for (let j = 0; j < pc.c3; j++) take(polygonsC, c3++, 'coloured').pattern = mask;
      for (let j = 0; j < pc.c4; j++) take(polygonsC, c4++, 'coloured').pattern = mask;
      for (let j = 0; j < pc.tex.length; j++) {
        for (let k = 0; k < pc.tex[j][0]; k++) {
          const p = take(polygonsT, t3++, 'textured');
          p.pattern = mask;
          p.texture = j;
        }
        for (let k = 0; k < pc.tex[j][1]; k++) {
          const p = take(polygonsT, t4++, 'textured');
          p.pattern = mask;
          p.texture = j;
        }
      }
    }
    if (c3 !== numPolyC3 || c4 !== numPolyC3 + numPolyC4 || t3 !== numPolyT3 || t4 !== numPolyT3 + numPolyT4) {
      // The reference would crash later (texture index -1) for unassigned textured polygons.
      warnings.push(`pattern table does not cover all polygons (C3 ${c3}/${numPolyC3}, ` +
        `C4 ${c4 - numPolyC3}/${numPolyC4}, T3 ${t3}/${numPolyT3}, T4 ${t4 - numPolyT3}/${numPolyT4})`);
    }
  }

  // ---- bones -----------------------------------------------------------------
  const bones = [];
  const boneParents = new Int16Array(numBones);
  const boneVertexStart = new Uint32Array(numBones);
  const boneVertexCount = new Uint32Array(numBones);
  const boneMatrices = new Float32Array(numBones * 12);
  const vertexBone = new Uint16Array(numVertices);
  let boneVertexSum = 0;
  for (let i = 0; i < numBones; i++) {
    const count = r.u16();
    const parent = r.s16();
    if (parent < -1) throw new Error('Format error (negative parent)');
    if (parent >= i) {
      // utils.cpp evaluates bones in file order and would read an uninitialised
      // matrix; no known file does this.
      throw new Error(`Format error: bone ${i} has parent ${parent} that does not precede it`);
    }
    const o = i * 12;
    for (let k = 0; k < 12; k++) {
      const v = r.s16();
      boneMatrices[o + k] = (k & 3) === 3 ? v : v * TO_FLOAT;
    }
    boneParents[i] = parent;
    boneVertexStart[i] = boneVertexSum;
    boneVertexCount[i] = count;
    for (let v = boneVertexSum, e = Math.min(numVertices, boneVertexSum + count); v < e; v++) vertexBone[v] = i;
    bones.push({
      index: i,
      parent,
      vertexStart: boneVertexSum,
      vertexCount: count,
      matrix: boneMatrices.subarray(o, o + 12),
    });
    boneVertexSum += count;
  }
  if (boneVertexSum !== numVertices) {
    throw new Error(`Bones vertices = ${boneVertexSum}, but all vertices = ${numVertices}`);
  }

  // ---- trailer ---------------------------------------------------------------
  let trailer = null;
  let available = r.available();
  if (version >= 4) {
    const n = Math.min(20, available);
    trailer = r.data.slice(r.pos, r.pos + n);
    available -= 20;
  }
  if (available !== 0) warnings.push(`${available} uninterpreted bytes at end of MBAC (version ${version})`);

  // ---- draw batches ------------------------------------------------------------
  // file order: textured (T3 then T4), then coloured (C3 then C4) -- the same order
  // as the reference's vertex array before its stable sort.
  const polygons = polygonsT.concat(polygonsC);
  const batches = buildBatches(polygons, flipWinding);

  const model = {
    version,
    vertexFormat,
    normalFormat,
    polygonFormat,
    boneFormat,
    numVertices,
    numBones,
    numTextures,
    numPatterns,
    numColors,
    numPolyT3,
    numPolyT4,
    numPolyC3,
    numPolyC4,
    localPositions,
    localNormals,
    positions: new Float32Array(numVertices * 3),
    normals: localNormals ? new Float32Array(numVertices * 3) : null,
    bones,
    boneParents,
    boneVertexStart,
    boneVertexCount,
    boneMatrices,
    vertexBone,
    patternCounts,
    patternMasks: Array.from({ length: numPatterns }, (_, i) => (i === 0 ? 0 : (1 << i) >>> 0)),
    palette,
    polygonEncoding: polyInfo,
    polygons,
    batches,
    flipWinding,
    trailer,
    trailingBytes: available,
    warnings,
    bounds: null,
  };

  // bind pose = bone rest matrices applied (reference: FigureImpl.init)
  transformVertices(model, null, 0, model.positions, model.normals);
  model.bounds = computeBounds(model.positions);
  return model;
}

/**
 * Group polygons into draw batches. Key = (textured, blend, texture, doubleSided,
 * full material value). Batch order follows the reference's draw order: textured
 * before coloured, then blend mode, texture index, single- before double-sided;
 * remaining material bits (colour key / lighting / specular / uninterpreted) only
 * split batches further. Polygon order inside a batch is file order.
 */
function buildBatches(polygons, flipWinding) {
  const groups = new Map();
  polygons.forEach((p, polygonIndex) => {
    const key = `${p.textured ? 0 : 1}/${p.material}/${p.texture}`;
    let g = groups.get(key);
    if (!g) {
      g = { textured: p.textured, material: p.material, texture: p.texture, list: [], first: polygonIndex, corners: 0 };
      groups.set(key, g);
    }
    g.list.push(polygonIndex);
    g.corners += p.indices.length === 4 ? 6 : 3;
  });

  const sorted = [...groups.values()].sort((a, b) =>
    (Number(b.textured) - Number(a.textured)) ||
    ((a.material & MATERIAL_BLEND_MASK) - (b.material & MATERIAL_BLEND_MASK)) ||
    (a.texture - b.texture) ||
    ((a.material & MATERIAL_DOUBLE_FACE) - (b.material & MATERIAL_DOUBLE_FACE)) ||
    (a.first - b.first));

  // corner order within a polygon (indices into polygon.indices)
  const TRI = flipWinding ? [0, 2, 1] : [0, 1, 2];
  const QUAD = flipWinding ? [0, 2, 1, 2, 3, 1] : [0, 1, 2, 2, 1, 3];

  return sorted.map((g) => {
    const numCorners = g.corners;
    const numTriangles = numCorners / 3;
    const cornerVertex = new Uint32Array(numCorners);
    const uvs = g.textured ? new Float32Array(numCorners * 2) : null;
    const colors = g.textured ? null : new Uint8Array(numCorners * 3);
    const trianglePattern = new Uint32Array(numTriangles);
    const trianglePolygon = new Uint32Array(numTriangles);
    let c = 0;
    let patternUnion = 0;
    for (const polygonIndex of g.list) {
      const p = polygons[polygonIndex];
      const order = p.indices.length === 4 ? QUAD : TRI;
      for (let t = 0; t < order.length / 3; t++) {
        trianglePattern[c / 3 + t] = p.pattern;
        trianglePolygon[c / 3 + t] = polygonIndex;
      }
      patternUnion |= p.pattern;
      for (const k of order) {
        cornerVertex[c] = p.indices[k];
        if (uvs) {
          uvs[c * 2] = p.uvs[k * 2];
          uvs[c * 2 + 1] = p.uvs[k * 2 + 1];
        } else {
          colors[c * 3] = p.color[0];
          colors[c * 3 + 1] = p.color[1];
          colors[c * 3 + 2] = p.color[2];
        }
        c++;
      }
    }
    const blendMode = (g.material & MATERIAL_BLEND_MASK) >> 1;
    return {
      textured: g.textured,
      textureIndex: g.texture,
      material: g.material,
      blendMode,
      blend: BLEND_NAMES[blendMode],
      transparent: (g.material & MATERIAL_TRANSPARENT) !== 0,
      doubleSided: (g.material & MATERIAL_DOUBLE_FACE) !== 0,
      lighting: (g.material & MATERIAL_LIGHTING) !== 0,
      specular: (g.material & MATERIAL_SPECULAR) !== 0,
      numPolygons: g.list.length,
      numTriangles,
      numCorners,
      cornerVertex,
      uvs,
      colors,
      trianglePattern,
      trianglePolygon,
      patternUnion: patternUnion >>> 0,
    };
  });
}

/**
 * Pattern visibility test of the reference (FigureImpl.applyPattern):
 * a polygon tagged `polygonPattern` is drawn for application pattern value
 * `pattern` iff all of its bits are set in `pattern`. Mask 0 is always visible.
 */
export function isPatternVisible(polygonPattern, pattern) {
  return ((polygonPattern & pattern) >>> 0) === (polygonPattern >>> 0);
}

/**
 * Convenience: expand a per-vertex array (e.g. poseModel output) to the
 * per-corner layout of a batch. `itemSize` is 3 for positions/normals.
 * Returns `out` (allocated if omitted).
 */
export function expandToCorners(batch, perVertex, out, itemSize = 3) {
  const cv = batch.cornerVertex;
  if (!out) out = new Float32Array(cv.length * itemSize);
  for (let c = 0, o = 0; c < cv.length; c++) {
    const s = cv[c] * itemSize;
    for (let k = 0; k < itemSize; k++) out[o++] = perVertex[s + k];
  }
  return out;
}

function computeBounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

// ---------------------------------------------------------------------------
// MTRA
// ---------------------------------------------------------------------------

function readVecKeys(r, scale) {
  const count = r.u16();
  const keys = new Uint16Array(count);
  const values = new Float32Array(count * 3);
  for (let j = 0; j < count; j++) {
    keys[j] = r.u16();
    values[j * 3] = r.s16() * scale;
    values[j * 3 + 1] = r.s16() * scale;
    values[j * 3 + 2] = r.s16() * scale;
  }
  return { keys, values };
}

function readRollKeys(r) {
  const count = r.u16();
  const keys = new Uint16Array(count);
  const values = new Float32Array(count);
  for (let j = 0; j < count; j++) {
    keys[j] = r.u16();
    values[j] = fround(r.s16() * TO_RADIANS); // float * float in the reference
  }
  return { keys, values };
}

/**
 * Parse an MTRA action table.
 * @param {Uint8Array} bytes
 * @returns {MtraActionTable} see the bottom of this file for the object shape.
 */
export function parseMTRA(bytes) {
  const r = new Reader(toBytes(bytes));
  const warnings = [];
  if (r.u8() !== 0x4d || r.u8() !== 0x54) throw new Error('Not a MTRA file');
  const version = r.u8();
  if (r.u8() !== 0 || version < 2 || version > 5) throw new Error(`Unsupported MTRA version: ${version}`);

  const numActions = r.u16();
  const numBones = r.u16();
  const transTypeCounts = [];
  for (let i = 0; i < 8; i++) transTypeCounts.push(r.u16());
  if (transTypeCounts[7] !== 0) warnings.push(`transTypeCounts[7] = ${transTypeCounts[7]}`);
  const dataSize = r.s32();

  const actions = [];
  for (let a = 0; a < numActions; a++) {
    const keyframes = r.u16();
    const matrices = new Float32Array(numBones * 12);
    const boneTracks = [];
    for (let b = 0; b < numBones; b++) {
      const type = r.u8();
      const o = b * 12;
      const track = { type, translate: null, scale: null, rotate: null, roll: null };
      switch (type) {
        case 0:
          for (let k = 0; k < 12; k++) {
            const v = r.s16();
            matrices[o + k] = (k & 3) === 3 ? v : v * TO_FLOAT;
          }
          break;
        case 1:
          matrices.set(IDENTITY_AFFINE, o);
          break;
        case 2:
          track.translate = readVecKeys(r, 1);
          track.scale = readVecKeys(r, TO_FLOAT);
          track.rotate = readVecKeys(r, 1);
          track.roll = readRollKeys(r);
          break;
        case 3: {
          const x = r.s16();
          const y = r.s16();
          const z = r.s16();
          track.translate = { keys: new Uint16Array(1), values: new Float32Array([x, y, z]) };
          track.rotate = readVecKeys(r, 1);
          track.roll = { keys: new Uint16Array(1), values: new Float32Array([fround(r.s16() * TO_RADIANS)]) };
          break;
        }
        case 4:
          track.rotate = readVecKeys(r, 1);
          track.roll = readRollKeys(r);
          break;
        case 5:
          track.rotate = readVecKeys(r, 1);
          break;
        case 6:
          track.translate = readVecKeys(r, 1);
          track.rotate = readVecKeys(r, 1);
          track.roll = readRollKeys(r);
          break;
        default:
          throw new Error(`Animation type ${type} is not supported`);
      }
      boneTracks.push(track);
    }
    let dynamic = null;
    if (version >= 5) {
      const count = r.u16();
      dynamic = [];
      for (let j = 0; j < count; j++) {
        const frame = r.u16();
        const pattern = r.s32();
        dynamic.push({ frame, pattern });
      }
      // the reference stores these in a SparseIntArray (sorted by frame, later
      // duplicates overwrite earlier ones)
      const byFrame = new Map();
      for (const d of dynamic) byFrame.set(d.frame, d.pattern);
      dynamic = [...byFrame.entries()].sort((x, y) => x[0] - y[0]).map(([frame, pattern]) => ({ frame, pattern }));
    }
    actions.push({
      index: a,
      keyframes,
      maxFrame: keyframes << 16,
      boneTracks,
      dynamic,
      matrices, // scratch: per-bone 3x4 action matrices of the last evaluated frame
      _frame: -1,
    });
  }

  let trailer = null;
  let available = r.available();
  if (version >= 4) {
    const n = Math.min(20, available);
    trailer = r.data.slice(r.pos, r.pos + n);
    available -= 20;
  }
  if (available !== 0) warnings.push(`${available} uninterpreted bytes at end of MTRA`);

  return {
    version,
    numActions,
    numBones,
    transTypeCounts,
    dataSize,
    actions,
    trailer,
    trailingBytes: available,
    warnings,
  };
}

/**
 * Port of ActTableImpl.getPattern(): the pattern value the action's "dynamic"
 * chunk prescribes at `frame` (16.16), or `defValue` if there is none.
 */
export function getActionPattern(actionTable, actionIndex, frame, defValue = 0) {
  const dynamic = actionTable.actions[actionIndex].dynamic;
  if (dynamic) {
    const iFrame = frame < 0 ? 0 : frame >> 16;
    for (let i = dynamic.length - 1; i >= 0; i--) {
      if (dynamic[i].frame <= iFrame) return dynamic[i].pattern;
    }
  }
  return defValue;
}

// ---- keyframe evaluation (Action.java) ---------------------------------------

/** Action.Animation.get: leaves `arr` untouched when kgf precedes the first key. */
function animGet(anim, kgf, arr) {
  const keys = anim.keys;
  const values = anim.values;
  const max = keys.length - 1;
  if (max < 0) throw new RangeError('MTRA track without keys (the reference throws here too)');
  if (kgf >= keys[max]) {
    arr[0] = values[max * 3];
    arr[1] = values[max * 3 + 1];
    arr[2] = values[max * 3 + 2];
    return;
  }
  for (let i = max - 1; i >= 0; i--) {
    const prevKey = keys[i];
    if (prevKey > kgf) continue;
    const x = values[i * 3];
    const y = values[i * 3 + 1];
    const z = values[i * 3 + 2];
    if (prevKey === kgf) {
      arr[0] = x;
      arr[1] = y;
      arr[2] = z;
      return;
    }
    const nextKey = keys[i + 1];
    const n = (i + 1) * 3;
    const delta = fround(fround(kgf - prevKey) / (nextKey - prevKey));
    arr[0] = fround(x + fround(fround(values[n] - x) * delta));
    arr[1] = fround(y + fround(fround(values[n + 1] - y) * delta));
    arr[2] = fround(z + fround(fround(values[n + 2] - z) * delta));
    return;
  }
}

/** Action.RollAnim.get */
function rollGet(anim, kgf) {
  const keys = anim.keys;
  const values = anim.values;
  const max = keys.length - 1;
  if (max < 0) throw new RangeError('MTRA roll track without keys (the reference throws here too)');
  if (kgf >= keys[max]) return values[max];
  for (let i = max - 1; i >= 0; i--) {
    const key = keys[i];
    if (key > kgf) continue;
    const value = values[i];
    if (key === kgf) return value;
    const nextKey = keys[i + 1];
    const nextValue = values[i + 1];
    return fround(value + fround(fround(fround(nextValue - value) / (nextKey - key)) * fround(kgf - key)));
  }
  return 0;
}

/**
 * Action.Bone.rotate: build the rotation that takes +Z to the direction (x,y,z).
 *
 * DEVIATION FROM THE REFERENCE: for a zero-length direction the reference divides
 * by zero and produces NaN matrix entries (the bone and all its descendants then
 * have NaN vertices and silently disappear in GL). Such keys do occur in this
 * game (rock.mtr action 11 bone 5, e01_06_0.mtr bone 5, r_10_2_arm_blade.mtra
 * bone 3), always where an identity rotation is the only sensible reading (e.g.
 * the alternative forearm that is scaled in while the normal one is scaled out),
 * so a zero vector is treated as "no rotation" here. Everything else is
 * identical to the reference.
 */
function setRotate(m, o, x, y, z) {
  const len2 = fround(fround(fround(x * x) + fround(y * y)) + fround(z * z));
  if (len2 === 0) {
    m[o] = 1; m[o + 1] = 0; m[o + 2] = 0;
    m[o + 4] = 0; m[o + 5] = 1; m[o + 6] = 0;
    m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = 1;
    return;
  }
  const rld = fround(1 / fround(Math.sqrt(len2)));
  x = fround(x * rld);
  y = fround(y * rld);
  z = fround(z * rld);
  const xx = fround(x * x);
  const yy = fround(y * y);
  if (xx > 0 || yy > 0) {
    const a = fround(fround(1 - z) / fround(yy + xx));
    const b = fround(a * -fround(x * y));
    m[o] = fround(z + fround(yy * a));
    m[o + 1] = b;
    m[o + 2] = x;
    m[o + 4] = b;
    m[o + 5] = fround(z + fround(xx * a));
    m[o + 6] = y;
    m[o + 8] = -x;
    m[o + 9] = -y;
  } else {
    m[o] = 1;
    m[o + 1] = 0;
    m[o + 2] = 0;
    m[o + 4] = 0;
    m[o + 5] = z;
    m[o + 6] = 0;
    m[o + 8] = 0;
    m[o + 9] = 0;
  }
  m[o + 10] = z;
}

/** Action.Bone.roll: post-multiply by a rotation about local Z. */
function applyRoll(m, o, angle) {
  const s = fround(Math.sin(angle));
  const c = fround(Math.cos(angle));
  const m00 = m[o];
  const m01 = m[o + 1];
  const m10 = m[o + 4];
  const m11 = m[o + 5];
  const m20 = m[o + 8];
  const m21 = m[o + 9];
  m[o] = fround(fround(m00 * c) + fround(m01 * s));
  m[o + 1] = fround(fround(m01 * c) - fround(m00 * s));
  m[o + 4] = fround(fround(m10 * c) + fround(m11 * s));
  m[o + 5] = fround(fround(m11 * c) - fround(m10 * s));
  m[o + 8] = fround(fround(m20 * c) + fround(m21 * s));
  m[o + 9] = fround(fround(m21 * c) - fround(m20 * s));
}

const tmpArr = new Float32Array(3);

/**
 * Evaluate the per-bone action matrices of `action` at `frame` (16.16, >= 0)
 * into action.matrices (Float32Array, 12 per bone, row-major 3x4) and return it.
 * Port of Action.Bone.setFrame for every bone.
 */
export function evaluateAction(action, frame) {
  if (frame < 0) frame = 0;
  const m = action.matrices;
  if (action._frame === frame) return m;
  const kgf = fround(frame) / 65536; // float kgf = frame / 65536f
  const arr = tmpArr;
  const tracks = action.boneTracks;
  for (let b = 0; b < tracks.length; b++) {
    const t = tracks[b];
    const o = b * 12;
    switch (t.type) {
      case 2: {
        arr[0] = arr[1] = arr[2] = 0;
        animGet(t.translate, kgf, arr);
        m[o + 3] = arr[0];
        m[o + 7] = arr[1];
        m[o + 11] = arr[2];
        animGet(t.rotate, kgf, arr);
        setRotate(m, o, arr[0], arr[1], arr[2]);
        applyRoll(m, o, rollGet(t.roll, kgf));
        animGet(t.scale, kgf, arr);
        const x = arr[0];
        const y = arr[1];
        const z = arr[2];
        m[o] = fround(m[o] * x);
        m[o + 1] = fround(m[o + 1] * y);
        m[o + 2] = fround(m[o + 2] * z);
        m[o + 4] = fround(m[o + 4] * x);
        m[o + 5] = fround(m[o + 5] * y);
        m[o + 6] = fround(m[o + 6] * z);
        m[o + 8] = fround(m[o + 8] * x);
        m[o + 9] = fround(m[o + 9] * y);
        m[o + 10] = fround(m[o + 10] * z);
        break;
      }
      case 3: {
        arr[0] = t.translate.values[0];
        arr[1] = t.translate.values[1];
        arr[2] = t.translate.values[2];
        m[o + 3] = arr[0];
        m[o + 7] = arr[1];
        m[o + 11] = arr[2];
        animGet(t.rotate, kgf, arr);
        setRotate(m, o, arr[0], arr[1], arr[2]);
        applyRoll(m, o, t.roll.values[0]);
        break;
      }
      case 4: {
        arr[0] = arr[1] = arr[2] = 0;
        animGet(t.rotate, kgf, arr);
        setRotate(m, o, arr[0], arr[1], arr[2]);
        applyRoll(m, o, rollGet(t.roll, kgf));
        break;
      }
      case 5: {
        arr[0] = arr[1] = arr[2] = 0;
        animGet(t.rotate, kgf, arr);
        setRotate(m, o, arr[0], arr[1], arr[2]);
        break;
      }
      case 6: {
        arr[0] = arr[1] = arr[2] = 0;
        animGet(t.translate, kgf, arr);
        m[o + 3] = arr[0];
        m[o + 7] = arr[1];
        m[o + 11] = arr[2];
        animGet(t.rotate, kgf, arr);
        setRotate(m, o, arr[0], arr[1], arr[2]);
        applyRoll(m, o, rollGet(t.roll, kgf));
        break;
      }
      default: // 0 and 1: constant, filled in by parseMTRA
        break;
    }
  }
  action._frame = frame;
  return m;
}

// ---------------------------------------------------------------------------
// posing (utils.cpp: Java_..._Utils_transform)
// ---------------------------------------------------------------------------

let scratchMatrices = new Float32Array(0);

/** dst[d..] = l[lo..] * r[ro..] for row-major 3x4 affine matrices (dst may alias l). */
function mulAffine(dst, d, l, lo, r, ro) {
  const l00 = l[lo], l01 = l[lo + 1], l02 = l[lo + 2], l03 = l[lo + 3];
  const l10 = l[lo + 4], l11 = l[lo + 5], l12 = l[lo + 6], l13 = l[lo + 7];
  const l20 = l[lo + 8], l21 = l[lo + 9], l22 = l[lo + 10], l23 = l[lo + 11];
  const r00 = r[ro], r01 = r[ro + 1], r02 = r[ro + 2], r03 = r[ro + 3];
  const r10 = r[ro + 4], r11 = r[ro + 5], r12 = r[ro + 6], r13 = r[ro + 7];
  const r20 = r[ro + 8], r21 = r[ro + 9], r22 = r[ro + 10], r23 = r[ro + 11];
  const f = fround;
  dst[d] = f(f(f(l00 * r00) + f(l01 * r10)) + f(l02 * r20));
  dst[d + 1] = f(f(f(l00 * r01) + f(l01 * r11)) + f(l02 * r21));
  dst[d + 2] = f(f(f(l00 * r02) + f(l01 * r12)) + f(l02 * r22));
  dst[d + 3] = f(f(f(f(l00 * r03) + f(l01 * r13)) + f(l02 * r23)) + l03);
  dst[d + 4] = f(f(f(l10 * r00) + f(l11 * r10)) + f(l12 * r20));
  dst[d + 5] = f(f(f(l10 * r01) + f(l11 * r11)) + f(l12 * r21));
  dst[d + 6] = f(f(f(l10 * r02) + f(l11 * r12)) + f(l12 * r22));
  dst[d + 7] = f(f(f(f(l10 * r03) + f(l11 * r13)) + f(l12 * r23)) + l13);
  dst[d + 8] = f(f(f(l20 * r00) + f(l21 * r10)) + f(l22 * r20));
  dst[d + 9] = f(f(f(l20 * r01) + f(l21 * r11)) + f(l22 * r21));
  dst[d + 10] = f(f(f(l20 * r02) + f(l21 * r12)) + f(l22 * r22));
  dst[d + 11] = f(f(f(f(l20 * r03) + f(l21 * r13)) + f(l22 * r23)) + l23);
}

/**
 * Compute the accumulated (model-space) 3x4 matrix of every bone:
 *   world[i] = world[parent] * rest[i] * action[i]      (action[i] only if i < numActionBones)
 * @returns {Float32Array} numBones*12, row-major; valid until the next call unless `out` given.
 */
export function computeBoneMatrices(model, actionMatrices, numActionBones, out) {
  const n = model.numBones;
  if (!out) {
    if (scratchMatrices.length < n * 12) scratchMatrices = new Float32Array(n * 12);
    out = scratchMatrices;
  }
  const rest = model.boneMatrices;
  const parents = model.boneParents;
  for (let i = 0; i < n; i++) {
    const o = i * 12;
    const parent = parents[i];
    if (parent === -1) {
      for (let k = 0; k < 12; k++) out[o + k] = rest[o + k];
    } else {
      mulAffine(out, o, out, parent * 12, rest, o);
    }
    if (actionMatrices && i < numActionBones) mulAffine(out, o, out, o, actionMatrices, o);
  }
  return out;
}

function transformVertices(model, actionMatrices, numActionBones, outPositions, outNormals) {
  const world = computeBoneMatrices(model, actionMatrices, numActionBones);
  const src = model.localPositions;
  const srcN = model.localNormals;
  const doNormals = !!(outNormals && srcN);
  const starts = model.boneVertexStart;
  const counts = model.boneVertexCount;
  const f = fround;
  for (let i = 0; i < model.numBones; i++) {
    const o = i * 12;
    const m00 = world[o], m01 = world[o + 1], m02 = world[o + 2], m03 = world[o + 3];
    const m10 = world[o + 4], m11 = world[o + 5], m12 = world[o + 6], m13 = world[o + 7];
    const m20 = world[o + 8], m21 = world[o + 9], m22 = world[o + 10], m23 = world[o + 11];
    for (let v = starts[i] * 3, e = v + counts[i] * 3; v < e; v += 3) {
      const x = src[v];
      const y = src[v + 1];
      const z = src[v + 2];
      outPositions[v] = f(f(f(f(x * m00) + f(y * m01)) + f(z * m02)) + m03);
      outPositions[v + 1] = f(f(f(f(x * m10) + f(y * m11)) + f(z * m12)) + m13);
      outPositions[v + 2] = f(f(f(f(x * m20) + f(y * m21)) + f(z * m22)) + m23);
      if (doNormals) {
        const nx = srcN[v];
        const ny = srcN[v + 1];
        const nz = srcN[v + 2];
        outNormals[v] = f(f(f(nx * m00) + f(ny * m01)) + f(nz * m02));
        outNormals[v + 1] = f(f(f(nx * m10) + f(ny * m11)) + f(nz * m12));
        outNormals[v + 2] = f(f(f(nx * m20) + f(ny * m21)) + f(nz * m22));
      }
    }
  }
}

/**
 * Pose a model (port of FigureImpl.setPosture + Utils.transform).
 *
 * @param {MbacModel} model            result of parseMBAC()
 * @param {MtraActionTable|null} actionTable  result of parseMTRA(), or null for the bind pose
 * @param {number} actionIndex         0 .. actionTable.numActions-1 (ignored for null table)
 * @param {number} frame               16.16 fixed point (65536 = 1 keyframe), clamped to >= 0
 * @param {Float32Array} outPositions  numVertices*3, receives posed positions (model units)
 * @param {Float32Array} [outNormals]  numVertices*3, receives posed normals (4096 = 1.0);
 *                                     left untouched if the model has no normals
 * @returns {Float32Array} outPositions
 *
 * If the action table has fewer bones than the model, the remaining bones keep
 * their rest transform; extra action bones are ignored (same as the reference).
 */
export function poseModel(model, actionTable, actionIndex, frame, outPositions, outNormals) {
  if (outPositions.length < model.numVertices * 3) throw new RangeError('outPositions too small');
  if (outNormals && model.localNormals && outNormals.length < model.numVertices * 3) {
    throw new RangeError('outNormals too small');
  }
  if (!actionTable) {
    transformVertices(model, null, 0, outPositions, outNormals);
    return outPositions;
  }
  if (!(actionIndex >= 0 && actionIndex < actionTable.numActions)) {
    throw new RangeError(`action ${actionIndex} out of range (0..${actionTable.numActions - 1})`);
  }
  const action = actionTable.actions[actionIndex];
  if (action.boneTracks.length === 0) {
    // reference: applyBoneAction returns early, vertices keep their previous pose
    transformVertices(model, null, 0, outPositions, outNormals);
    return outPositions;
  }
  const matrices = evaluateAction(action, frame < 0 ? 0 : frame);
  transformVertices(model, matrices, action.boneTracks.length, outPositions, outNormals);
  return outPositions;
}

// ---------------------------------------------------------------------------
// BMP (Loader.loadBmpData)
// ---------------------------------------------------------------------------

/**
 * Decode an uncompressed 8-bit paletted BMP the way the reference does.
 *
 * @param {Uint8Array} bytes
 * @returns {{width:number, height:number, palette:Uint8Array, indices:Uint8Array,
 *            colorKeyIndex:number, paletteEntries:number, topDownFile:boolean}}
 *   palette: 256 x RGBA. Entry `colorKeyIndex` (always 0) has alpha 0, every other
 *            entry alpha 255 -- exactly the alpha channel the reference bakes into
 *            its RGBA raster. The alpha must only be honoured (alpha test, discard
 *            < 0.5) for polygons whose material has the TRANSPARENT bit; other
 *            polygons draw index 0 with its palette colour, opaque.
 *   indices: width*height palette indices, rows TOP-DOWN (row 0 = top of image).
 */
export function parseBMP(bytes) {
  const data = toBytes(bytes);
  const r = new Reader(data);
  if (r.u8() !== 0x42 || r.u8() !== 0x4d) throw new Error('Not a BMP!');
  r.skip(14 - 6);
  const rasterOffset = r.s32();
  const dibHeaderSize = r.s32();

  let width;
  let height;
  let reversed; // true: file rows are bottom-up
  let colorsUsed = 0;
  if (dibHeaderSize === 12) {
    width = r.u16();
    height = r.u16();
    r.skip(2);
    const bpp = r.u16();
    if (bpp !== 8) throw new Error(`Unsupported BMP format: bpp = ${bpp}`);
    reversed = true;
  } else if (dibHeaderSize === 40) {
    width = r.s32();
    const h = r.s32();
    if (h < 0) {
      height = -h;
      reversed = false;
    } else {
      height = h;
      reversed = true;
    }
    r.skip(2);
    const bpp = r.u16();
    if (bpp !== 8) throw new Error(`Unsupported BMP format: bpp = ${bpp}`);
    const compression = r.s32();
    if (compression !== 0) throw new Error(`Unsupported BMP format: compression = ${compression}`);
    r.skip(12);
    colorsUsed = r.s32();
    r.skip(4);
  } else {
    throw new Error(`Unsupported BMP version = ${dibHeaderSize}`);
  }

  // NB: the reference indexes 4-byte BGRX palette entries even for the 12-byte
  // core header (whose real palettes are 3-byte); kept as is.
  const paletteOffset = 14 + dibHeaderSize;
  const palette = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const p = paletteOffset + i * 4;
    if (p + 2 < data.length) {
      palette[i * 4] = data[p + 2];
      palette[i * 4 + 1] = data[p + 1];
      palette[i * 4 + 2] = data[p];
    }
    palette[i * 4 + 3] = i === 0 ? 0 : 255;
  }

  const remainder = width % 4;
  const stride = remainder === 0 ? width : width + 4 - remainder;
  if (rasterOffset + stride * (height - 1) + width > data.length) throw new RangeError('BMP raster truncated');
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const srcRow = reversed ? height - 1 - y : y;
    const s = rasterOffset + srcRow * stride;
    indices.set(data.subarray(s, s + width), y * width);
  }

  return {
    width,
    height,
    palette,
    indices,
    colorKeyIndex: 0,
    paletteEntries: colorsUsed > 0 ? colorsUsed : Math.min(256, Math.max(0, (rasterOffset - paletteOffset) >> 2)),
    topDownFile: !reversed,
  };
}

/**
 * Expand parseBMP() output to RGBA8 (top-down rows), identical to the raster the
 * reference uploads to GL: alpha 0 for palette index 0, 255 otherwise.
 */
export function bmpToRGBA(bmp, out) {
  const n = bmp.width * bmp.height;
  if (!out) out = new Uint8Array(n * 4);
  const pal = bmp.palette;
  const idx = bmp.indices;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const p = idx[i] * 4;
    out[o] = pal[p];
    out[o + 1] = pal[p + 1];
    out[o + 2] = pal[p + 2];
    out[o + 3] = pal[p + 3];
  }
  return out;
}

// ---------------------------------------------------------------------------
// ".all" archive (game-specific container, e.g. r_mtra.all) -- NOT part of the
// reference; layout derived from the sample file:
//   u16 count
//   count x { u32 size, file name bytes, 0x0A, 0x00 }
//   payloads, concatenated in table order (no padding)
// ---------------------------------------------------------------------------

/**
 * @param {Uint8Array} bytes
 * @returns {{name:string, offset:number, size:number, bytes:Uint8Array}[]}
 */
export function parseALL(bytes) {
  const data = toBytes(bytes);
  const r = new Reader(data);
  const count = r.u16();
  const entries = [];
  for (let i = 0; i < count; i++) {
    const size = r.s32() >>> 0;
    let name = '';
    for (;;) {
      const c = r.u8();
      if (c === 0x0a) break;
      name += String.fromCharCode(c);
    }
    const terminator = r.u8();
    if (terminator !== 0) throw new Error(`.all: unexpected byte ${terminator} after name "${name}"`);
    entries.push({ name, offset: 0, size, bytes: null });
  }
  let offset = r.pos;
  for (const e of entries) {
    if (offset + e.size > data.length) throw new RangeError(`.all: entry "${e.name}" exceeds the file`);
    e.offset = offset;
    e.bytes = data.subarray(offset, offset + e.size);
    offset += e.size;
  }
  if (offset !== data.length) throw new Error(`.all: ${data.length - offset} trailing bytes`);
  return entries;
}

// ---------------------------------------------------------------------------
// Object shapes
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} MbacBone
 * @property {number} index
 * @property {number} parent        -1 for a root, otherwise an index < this bone's index
 * @property {number} vertexStart   first vertex owned by this bone
 * @property {number} vertexCount   number of consecutive vertices owned
 * @property {Float32Array} matrix  12 floats, row-major 3x4 rest matrix RELATIVE TO THE PARENT
 *                                  (view into model.boneMatrices)
 *
 * @typedef {Object} MbacBatch
 * @property {boolean} textured
 * @property {number} textureIndex      index into the application's texture array, -1 if !textured
 * @property {number} material          raw material flags (MATERIAL_* bits, textured layout)
 * @property {number} blendMode         0 none, 1 half, 2 add, 3 sub
 * @property {string} blend             'none' | 'half' | 'add' | 'sub'
 * @property {boolean} transparent      colour key (palette index 0) enabled
 * @property {boolean} doubleSided
 * @property {boolean} lighting
 * @property {boolean} specular
 * @property {number} numPolygons
 * @property {number} numTriangles
 * @property {number} numCorners        numTriangles * 3
 * @property {Uint32Array} cornerVertex numCorners source-vertex indices (unindexed draw)
 * @property {Float32Array|null} uvs    numCorners*2, TEXELS, v down (null if !textured)
 * @property {Uint8Array|null} colors   numCorners*3 RGB bytes (null if textured)
 * @property {Uint32Array} trianglePattern  per-triangle pattern mask (see isPatternVisible)
 * @property {Uint32Array} trianglePolygon  per-triangle index into model.polygons
 * @property {number} patternUnion      OR of all trianglePattern values (0 = always fully visible)
 *
 * @typedef {Object} MbacModel
 * @property {number} version
 * @property {number} vertexFormat
 * @property {number} normalFormat
 * @property {number} polygonFormat
 * @property {number} boneFormat
 * @property {number} numVertices
 * @property {number} numBones
 * @property {number} numTextures
 * @property {number} numPatterns
 * @property {number} numColors
 * @property {number} numPolyT3
 * @property {number} numPolyT4
 * @property {number} numPolyC3
 * @property {number} numPolyC4
 * @property {Float32Array} localPositions      numVertices*3, bone-local (raw file data)
 * @property {Float32Array|null} localNormals   numVertices*3, bone-local, 4096 = 1.0
 * @property {Float32Array} positions           numVertices*3, BIND POSE (model space)
 * @property {Float32Array|null} normals        numVertices*3, bind pose, 4096 = 1.0
 * @property {MbacBone[]} bones
 * @property {Int16Array} boneParents
 * @property {Uint32Array} boneVertexStart
 * @property {Uint32Array} boneVertexCount
 * @property {Float32Array} boneMatrices        numBones*12 rest matrices (parent-relative)
 * @property {Uint16Array} vertexBone           per-vertex bone index
 * @property {{c3:number,c4:number,tex:number[][]}[]} patternCounts  raw pattern records
 * @property {number[]} patternMasks            mask of pattern record i (0, 2, 4, 8, ...)
 * @property {Uint8Array|null} palette          numColors*3 RGB of the coloured-polygon palette
 * @property {Object} polygonEncoding           bit widths read from the polygon block headers
 * @property {Object[]} polygons                file order (T3, T4, C3, C4): {textured, material,
 *                                              indices[3|4], uvs[6|8]|null, colorId, color|null,
 *                                              texture, pattern}
 * @property {MbacBatch[]} batches
 * @property {boolean} flipWinding
 * @property {Uint8Array|null} trailer          20 trailing bytes (version >= 4)
 * @property {number} trailingBytes             bytes left over after everything above (expect 0)
 * @property {string[]} warnings
 * @property {{min:number[],max:number[]}} bounds  bind-pose bounding box
 *
 * @typedef {Object} MtraTrack
 * @property {number} type   0 fixed matrix, 1 identity, 2 T+S+R+roll, 3 const T + R + const roll,
 *                           4 R+roll, 5 R, 6 T+R+roll
 * @property {{keys:Uint16Array, values:Float32Array}|null} translate  values xyz per key, model units
 * @property {{keys:Uint16Array, values:Float32Array}|null} scale      values xyz per key, 1.0 = unscaled
 * @property {{keys:Uint16Array, values:Float32Array}|null} rotate     values xyz per key: direction of
 *                                                                     the bone's local +Z axis
 * @property {{keys:Uint16Array, values:Float32Array}|null} roll       values: radians, one per key
 *
 * @typedef {Object} MtraAction
 * @property {number} index
 * @property {number} keyframes       length in whole keyframes
 * @property {number} maxFrame        keyframes << 16 (what ActionTable.getNumFrames returns)
 * @property {MtraTrack[]} boneTracks one per action-table bone (bone i drives model bone i)
 * @property {{frame:number, pattern:number}[]|null} dynamic  pattern keys (version 5), sorted by frame
 * @property {Float32Array} matrices  numBones*12 action matrices; constant for types 0/1, otherwise
 *                                    filled by evaluateAction()/poseModel()
 *
 * @typedef {Object} MtraActionTable
 * @property {number} version
 * @property {number} numActions
 * @property {number} numBones
 * @property {number[]} transTypeCounts
 * @property {number} dataSize
 * @property {MtraAction[]} actions
 * @property {Uint8Array|null} trailer
 * @property {number} trailingBytes
 * @property {string[]} warnings
 */
