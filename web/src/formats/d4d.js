/**
 * d4d.js -- parser for the ".d4d" 3D map files of "Rockman DASH: Great Adventure
 * on 5 Islands" (NTT DoCoMo i-appli, DoJa 5.x, 2008).
 *
 * Dependency-free ES module. Does NOT import three.js; it returns plain data
 * (typed arrays + descriptors) from which three.js objects can be built.
 *
 * =============================================================================
 * 1. WHAT THE FORMAT IS
 * =============================================================================
 * A .d4d is the data HI Corporation's "Micro3D D4" engine accepts in
 * com.nttdocomo.ui.graphics3d.Object3D.createInstance(byte[]) when the result is
 * a scene Group. It is a **JSR-184 (M3G 1.0) object stream with a custom 10-byte
 * "D4" file header** in place of the 12-byte M3G file identifier:
 *
 *   - the section framing (compression byte / lengths / checksum),
 *   - the per-object framing (type byte + u32 length),
 *   - the object type numbers (1 AnimationController ... 22 World),
 *   - every object body layout, and all enum values (64 ALPHA, 160 CULL_BACK, ...)
 *
 * are exactly those of the public M3G 1.0 file format specification. All
 * multi-byte values are LITTLE-endian. (The "big-endian looking" runs such as
 * `00 00 00 03 00 00 00 03` are misaligned little-endian u32 strip lengths.)
 *
 * -----------------------------------------------------------------------------
 * 1.1 File header (10 bytes)                                    [confidence]
 * -----------------------------------------------------------------------------
 *   off size field
 *   0   2    magic "D4" (0x44 0x34)                             [confirmed: DLL + game code]
 *   2   1    always 0x00; the DLL rejects anything else         [confirmed: DLL]
 *   3   1    container variant. 1 = "M3G sections" (all 35      [confirmed: DLL accepts 0 or 1,
 *            samples). 0 selects a different native layout in     variant 0 body NOT reversed]
 *            the DLL that this parser does not implement.
 *   4   4    u32 total byte size of all sections = fileSize-10  [confirmed: data (35/35), DLL
 *            (DLL rejects > 0x80000)                              range check, game code]
 *   8   2    u16 total number of objects in all sections        [confirmed: data (35/35), DLL
 *            (DLL rejects > 0x400)                                allocates count*4 table]
 *
 * -----------------------------------------------------------------------------
 * 1.2 Sections (repeat until end of file; every sample has exactly 3)
 * -----------------------------------------------------------------------------
 *   off size field
 *   0   1    compressionScheme; 0 = uncompressed. The DLL       [confirmed: DLL]
 *            rejects non-zero in this container.
 *   1   4    u32 totalSectionLength, including these 9 header   [confirmed: DLL (>= 13), data]
 *            bytes and the 4 checksum bytes
 *   5   4    u32 uncompressedLength = totalSectionLength - 13   [confirmed: data, game code]
 *   9   n    objects (n = uncompressedLength)
 *   9+n 4    u32 checksum                                       [see below]
 *
 *   Checksum = Adler-32 (seed 1) over the FIRST `uncompressedLength` BYTES OF THE
 *   SECTION COUNTED FROM THE COMPRESSION BYTE -- i.e. the 9 header bytes plus all
 *   but the last 9 object bytes. That is an off-by-9 quirk relative to M3G (which
 *   covers the whole section minus the checksum), but it reproduces all 105
 *   stored checksums and is literally what the game's own Java re-packer does
 *   (class `bq`: `bq.a(1L, sectionBuffer, uncompressedLength)`).   [confirmed: data + game code]
 *   The DLL does not appear to compare it against the data for these files: the
 *   section loader only reads the 4 bytes and adds them to a running sum; the
 *   one extra call on that path is gated on a type-0x7F object that never occurs
 *   in the samples.                    [read from DLL disassembly; not exhaustively traced]
 *
 *   Section layout in every sample:
 *     section 0: empty (13 bytes, checksum 1). It stands where M3G keeps its
 *                Header object; there is no Header object in a .d4d.
 *     section 1: all "leaf" objects (images, modes, textures, appearances, index
 *                buffers, vertex arrays, vertex buffer, animation objects)
 *     section 2: the Mesh and the root World.
 *
 * -----------------------------------------------------------------------------
 * 1.3 Objects
 * -----------------------------------------------------------------------------
 *   off size field
 *   0   1    object type (M3G numbering, table below)           [confirmed: DLL jump table]
 *   1   4    u32 length of the body that follows
 *   5   len  body
 *
 *   Object references inside bodies are u32 "object indices": 0 = null, and the
 *   first object of the file has index **2** (index 1 is reserved for the M3G
 *   Header object that a .d4d omits; the DLL resolves a reference r as
 *   table[r - 2]). References only point backwards.               [confirmed: DLL + data]
 *
 *   Types present in the 35 maps (count over all maps), body after the common
 *   Object3D prefix. "T" = Transformable prefix, "N" = Node prefix (see below).
 *
 *    1 AnimationController (15)  f32 speed, f32 weight, i32 activeStart,
 *                                i32 activeEnd, f32 refSequenceTime, i32 refWorldTime
 *    2 AnimationTrack      (20)  ref keyframeSequence, ref controller, u32 property
 *    3 Appearance         (269)  u8 layer, ref compositingMode, ref fog,
 *                                ref polygonMode, ref material, u32 n, ref texture[n]
 *    6 CompositingMode    (269)  u8 depthTest, u8 depthWrite, u8 colorWrite,
 *                                u8 alphaWrite, u8 blending, u8 alphaThreshold(/255),
 *                                f32 depthOffsetFactor, f32 depthOffsetUnits
 *    8 PolygonMode        (269)  u8 culling, u8 shading, u8 winding,
 *                                u8 twoSidedLighting, u8 localCameraLighting,
 *                                u8 perspectiveCorrection
 *   10 Image2D            (267)  u8 format, u8 isMutable, u32 width, u32 height,
 *                                [if !isMutable: u32 n, u8 palette[n], u32 m, u8 pixels[m]]
 *   11 TriangleStripArray (269)  u8 encoding; 0/1/2: u32/u8/u16 startIndex (implicit);
 *                                128/129/130: u32 n, then n indices as u32/u8/u16;
 *                                then u32 k, u32 stripLength[k]
 *   14 Mesh                (35)  N, ref vertexBuffer, u32 n, n * (ref indexBuffer, ref appearance)
 *   17 Texture2D          (269)  T, ref image, u8 blendColor[3], u8 blending,
 *                                u8 wrapS, u8 wrapT, u8 levelFilter, u8 imageFilter
 *   19 KeyframeSequence    (20)  u8 interpolation, u8 repeatMode, u8 encoding,
 *                                u32 duration, u32 validFirst, u32 validLast,
 *                                u32 componentCount, u32 keyframeCount,
 *                                enc 0: k * (u32 time, f32 value[cc])
 *                                enc 1/2: f32 bias[cc], f32 scale[cc], k * (u32 time, u8/u16 value[cc])
 *   20 VertexArray        (105)  u8 componentSize(1|2), u8 componentCount, u8 encoding
 *                                (0 raw, 1 delta), u16 vertexCount, then data
 *   21 VertexBuffer        (35)  u8 defaultColor[4] RGBA, ref positions, f32 bias[3],
 *                                f32 scale, ref normals, ref colors, u32 n,
 *                                n * (ref texCoords, f32 bias[3], f32 scale)
 *   22 World               (35)  N, u32 n, ref child[n], ref activeCamera, ref background
 *
 *   Common prefixes:
 *     Object3D      u32 userID, u32 n, ref animationTrack[n],
 *                   u32 p, p * (u32 parameterID, u32 len, u8 value[len])
 *     Transformable Object3D, u8 hasComponentTransform,
 *                   [f32 translation[3], f32 scale[3], f32 angleDegrees, f32 axis[3]],
 *                   u8 hasGeneralTransform, [f32 matrix[16] row-major]
 *     Node          Transformable, u8 enableRendering, u8 enablePicking,
 *                   u8 alphaFactor(/255), u32 scope, u8 hasAlignment,
 *                   [u8 zTarget, u8 yTarget, ref zReference, ref yReference]
 *
 *   These 13 layouts are [confirmed]: every one of the 35 files parses with zero
 *   leftover bytes and all references/indices in range, and the order/width of
 *   the stream reads in the DLL's per-type loader functions matches.
 *
 *   The remaining M3G types the DLL's loader also dispatches (0 Header,
 *   4 Background, 5 Camera, 7 Fog, 9 Group, 12 Light, 13 Material,
 *   15 MorphingMesh, 16 SkinnedMesh, 18 Sprite3D, 255 ExternalReference) are
 *   implemented here straight from the M3G 1.0 specification and are
 *   [UNTESTED]: no sample contains them. Unknown types are kept as raw bytes and
 *   counted in `unparsedBytes`.
 *
 * =============================================================================
 * 2. WHAT THE MAPS ACTUALLY CONTAIN
 * =============================================================================
 *   World -> one Mesh -> one VertexBuffer shared by N submeshes (3..13), each
 *   submesh = (TriangleStripArray, Appearance). No Group/Camera/Light/Fog/
 *   Material/Background/normals anywhere; every transform is identity.
 *
 *   Geometry    positions: int16 xyz, world = raw * scale + bias (file's native
 *               units, kept as-is in `positions`). colors: uint8 RGB or RGBA per
 *               vertex (pre-baked lighting). texcoords: int16 st, uv = raw*scale+bias,
 *               heavily tiled (roughly -30..40), all textures WRAP_REPEAT.
 *               Indices: explicit u8 or u16; every "strip" has length 3, i.e. the
 *               files are plain triangle lists. General strips are still handled.
 *   Lighting    none (no Material => M3G lighting off): colour = vertexColor,
 *               modulated by the texture (Texture2D.blending is always MODULATE).
 *   Blending    CompositingMode.blending: REPLACE (opaque, 227x), ALPHA (13x),
 *               ALPHA_ADD (29x). alphaThreshold 0, 2/255, 12/255 or 204/255
 *               (cut-out). depthWrite off on 3 additive layers. depthOffsetFactor
 *               -0.35..-0.65 on decal layers. Appearance.layer 0..4 = draw order.
 *   Culling     CULL_BACK with CCW front faces, or CULL_NONE (10x) = double sided.
 *
 * =============================================================================
 * 3. TEXTURES -- EXTERNAL, RESOLVED THROUGH Image2D.userID
 * =============================================================================
 *   Every Image2D in a .d4d is a 1x1 RGBA placeholder (pixel 00 00 00 FF). Its
 *   Object3D.userID is the texture number. Before handing the file to
 *   createInstance() the game's own loader (obfuscated class `j`,
 *   "LoadAddTextureD4D") rewrites the byte stream: for each Image2D it loads
 *
 *       <first 3 chars of the d4d file name> + userID + ".bmp"
 *       e.g. a1_3.d4d, userID 7  ->  "a1_7.bmp"   (same directory)
 *
 *   and replaces the placeholder with a real Image2D:           [confirmed: game code]
 *     - the BMP must be 8-bit, 256-colour, pixel data at offset 1078 (true for
 *       every a*_*.bmp);
 *     - palette entry i -> R,G,B from the BMP's B,G,R and **alpha = the BMP
 *       palette's 4th ("reserved") byte**; the result is a paletted RGBA
 *       Image2D (format 100). Rows are flipped to top-down.
 *     (If the placeholder's format byte were not 100 the palette would be
 *      stripped to RGB / format 99; never happens in the samples.)
 *   That 4th palette byte is real data: opaque textures have it 0 everywhere
 *   (they are only used with REPLACE, where alpha is ignored), cut-out textures
 *   have exactly one entry with 0 and 255 elsewhere, additive ones are all 255.
 *   A browser's BMP decoder discards it, so use decodeD4DTextureBMP() below.
 *   Several Texture2D objects may share one Image2D. Not every a<i>_<n>.bmp is
 *   referenced by a map.
 *
 *   UV convention: M3G. (s,t) = (0,0) is the TOP-left texel of the image, t grows
 *   downwards. `uvs` are returned unmodified. For three.js either upload the
 *   texture with flipY = false, or keep flipY = true and use v = 1 - t.
 *
 * =============================================================================
 * 4. COORDINATE SYSTEM
 * =============================================================================
 *   Positions are in a right-handed, **Y-up** world (floors sit at y ~ 0 and their
 *   CCW front faces point to +Y; verified statistically on all maps). Units are
 *   the game's world units; a room is typically 50..250 units across and 24..60
 *   high. This matches three.js conventions, so positions/indices can be used
 *   unchanged with FrontSide + CCW.                              [confirmed: data]
 *   At draw time the DLL pre-multiplies the caller's transform by
 *   diag(1,-1,-1,1) to go from DoJa camera space (y down, z into the screen) to
 *   its internal OpenGL-style camera space; that is a pure rotation and does not
 *   change handedness or winding.                                [confirmed: DLL]
 *   [assumption] that the game's own view transform is likewise a proper
 *   rotation (not checked here; it lives in game code, not in this format).
 *
 * =============================================================================
 * 5. ANIMATION (what Group.setTime(int) drives)
 * =============================================================================
 *   15 of the 35 maps contain M3G animation: AnimationTrack objects attached to
 *   Texture2D objects, always property 275 (TRANSLATION), LINEAR, LOOP,
 *   duration 967, one shared AnimationController (speed 1, always active).
 *   I.e. UV scrolling (water/lava/conveyors): typically t goes 0 -> 1 (one full
 *   texture period) per 967 time units; a few tracks are constant offsets.
 *   The DLL passes the Group's time straight to the M3G animate(worldTime) call
 *   [confirmed: DLL], and the game calls setTime(t) once per frame with
 *   t += 33, wrapping t -= 4004 when t > 4004 [confirmed: game code], so the unit
 *   is effectively milliseconds at ~30 fps. Because 4004 is not a multiple of
 *   967 the original shows a small scroll hitch every ~4 s.
 *   While a track is active its sampled value REPLACES the Texture2D's stored
 *   translation. Use sampleD4DTrack() / d4dTextureTranslationAt().
 *   [assumption] the Java-to-native glue of Group.setTime (inside doja.exe, not
 *   inspected) hands the int over unscaled.
 *
 * =============================================================================
 * 5b. SUGGESTED three.js MAPPING (not done here; this module only returns data)
 * =============================================================================
 *   geometry   one BufferGeometry per mesh: position <- positions (itemSize 3),
 *              color <- colors (Uint8, normalized, itemSize colorItemSize),
 *              uv <- uvs; one group / index array per submesh.
 *   material   MeshBasicMaterial({ vertexColors: true, map }) -- unlit, the
 *              texture is MODULATEd with the vertex colour (colours are already
 *              display-referred: keep them out of sRGB->linear conversion or the
 *              baked lighting gets darker than the original).
 *   blendMode  'replace'  -> transparent:false (alpha ignored; give those
 *                            textures alpha 255, see decodeD4DTextureBMP forceOpaque)
 *              'alpha'    -> transparent:true, NormalBlending   (src*a + dst*(1-a))
 *              'alphaAdd' -> transparent:true, AdditiveBlending (src*a + dst)
 *              'modulate' -> MultiplyBlending; 'modulateX2' -> custom (2*src*dst)
 *   alphaTest  <- alphaThreshold (fragment kept when alpha >= threshold)
 *   side       doubleSided ? DoubleSide : FrontSide
 *   depthWrite / depthTest as given; polygonOffset: true with
 *              polygonOffsetFactor/Units <- depthOffsetFactor/Units
 *   renderOrder <- layer (M3G draws layers in ascending order, and inside a layer
 *              opaque submeshes before blended ones)
 *   texture    wrapS/wrapT RepeatWrapping, mag/min NearestFilter, no mipmaps
 *              ('nearest' + 'baseLevel' in every sample); texture.offset <-
 *              d4dTextureTranslationAt(scene, textureIndex, timeMs)
 *
 * =============================================================================
 * 6. UNKNOWN / NOT COVERED
 * =============================================================================
 *   - header byte 3 == 0 container variant (never seen; throws).
 *   - object type 0x7F (20-byte body; some kind of digest the DLL special-cases)
 *     never seen; kept raw.
 *   - compressed sections (zlib in M3G) are rejected by the DLL for this
 *     container; this parser throws on them.
 *   - SPLINE/SLERP/SQUAD keyframe interpolation is sampled as LINEAR (unused).
 *   - byte/short normal decoding scale is taken from the spec (unused).
 */

// ----------------------------------------------------------------------------
// Constants (JSR-184 values)
// ----------------------------------------------------------------------------

export const D4D_OBJECT_TYPE_NAMES = Object.freeze({
  0: 'Header', 1: 'AnimationController', 2: 'AnimationTrack', 3: 'Appearance',
  4: 'Background', 5: 'Camera', 6: 'CompositingMode', 7: 'Fog', 8: 'PolygonMode',
  9: 'Group', 10: 'Image2D', 11: 'TriangleStripArray', 12: 'Light', 13: 'Material',
  14: 'Mesh', 15: 'MorphingMesh', 16: 'SkinnedMesh', 17: 'Texture2D', 18: 'Sprite3D',
  19: 'KeyframeSequence', 20: 'VertexArray', 21: 'VertexBuffer', 22: 'World',
  255: 'ExternalReference',
});

const BLENDING = { 64: 'alpha', 65: 'alphaAdd', 66: 'modulate', 67: 'modulateX2', 68: 'replace' };
const CULLING = { 160: 'back', 161: 'front', 162: 'none' };
const SHADING = { 164: 'flat', 165: 'smooth' };
const WINDING = { 168: 'ccw', 169: 'cw' };
const TEX_BLENDING = { 224: 'add', 225: 'blend', 226: 'decal', 227: 'modulate', 228: 'replace' };
const TEX_WRAP = { 240: 'clamp', 241: 'repeat' };
const TEX_FILTER = { 208: 'baseLevel', 209: 'linear', 210: 'nearest' };
const IMAGE_FORMAT = { 96: 'alpha', 97: 'luminance', 98: 'luminanceAlpha', 99: 'rgb', 100: 'rgba' };
const IMAGE_BPP = { 96: 1, 97: 1, 98: 2, 99: 3, 100: 4 };
const INTERPOLATION = { 176: 'linear', 177: 'slerp', 178: 'spline', 179: 'squad', 180: 'step' };
const REPEAT_MODE = { 192: 'constant', 193: 'loop' };
const ANIM_PROPERTY = {
  256: 'alpha', 257: 'ambientColor', 258: 'color', 259: 'crop', 260: 'density',
  261: 'diffuseColor', 262: 'emissiveColor', 263: 'farDistance', 264: 'fieldOfView',
  265: 'intensity', 266: 'morphWeights', 267: 'nearDistance', 268: 'orientation',
  269: 'pickability', 270: 'scale', 271: 'shininess', 272: 'specularColor',
  273: 'spotAngle', 274: 'spotExponent', 275: 'translation', 276: 'visibility',
};

const HEADER_SIZE = 10;
const SECTION_OVERHEAD = 13;

// ----------------------------------------------------------------------------
// Byte reader
// ----------------------------------------------------------------------------

class Reader {
  constructor(bytes, start, end) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = start;
    this.end = end;
  }
  need(n) {
    if (this.pos + n > this.end) {
      throw new Error(`D4D: read of ${n} byte(s) at offset ${this.pos} runs past ${this.end}`);
    }
  }
  u8() { this.need(1); return this.bytes[this.pos++]; }
  i8() { this.need(1); return this.view.getInt8(this.pos++); }
  bool() { return this.u8() !== 0; }
  u16() { this.need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { this.need(2); const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { this.need(4); const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  f32() { this.need(4); const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  f32s(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = this.f32(); return a; }
  raw(n) { this.need(n); const v = this.bytes.slice(this.pos, this.pos + n); this.pos += n; return v; }
  refs() { const n = this.u32(); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = this.u32(); return a; }
  rgb() { return [this.u8(), this.u8(), this.u8()]; }
  rgba() { return [this.u8(), this.u8(), this.u8(), this.u8()]; }
}

/** Plain Uint8Array view over the input (also unwraps Node Buffers, whose slice() aliases). */
function toBytes(input, who) {
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError(`${who}: expected ArrayBuffer or Uint8Array`);
}

/** Adler-32 with seed 1, as used by the section checksum. */
export function adler32(bytes, start = 0, end = bytes.length) {
  let a = 1, b = 0;
  for (let i = start; i < end;) {
    const stop = Math.min(end, i + 5552);
    for (; i < stop; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ----------------------------------------------------------------------------
// M3G object body parsers
// ----------------------------------------------------------------------------

function readObject3D(r, o) {
  o.userID = r.u32();
  o.animationTracks = r.refs();
  const n = r.u32();
  o.userParameters = [];
  for (let i = 0; i < n; i++) {
    const id = r.u32();
    const len = r.u32();
    o.userParameters.push({ id, value: r.raw(len) });
  }
}

function readTransformable(r, o) {
  readObject3D(r, o);
  o.hasComponentTransform = r.bool();
  if (o.hasComponentTransform) {
    o.translation = r.f32s(3);
    o.scale = r.f32s(3);
    o.orientationAngle = r.f32(); // degrees
    o.orientationAxis = r.f32s(3);
  } else {
    o.translation = [0, 0, 0];
    o.scale = [1, 1, 1];
    o.orientationAngle = 0;
    o.orientationAxis = [0, 0, 0];
  }
  o.hasGeneralTransform = r.bool();
  o.generalTransform = o.hasGeneralTransform ? r.f32s(16) : null; // row-major
}

function readNode(r, o) {
  readTransformable(r, o);
  o.enableRendering = r.bool();
  o.enablePicking = r.bool();
  o.alphaFactor = r.u8() / 255;
  o.scope = r.u32();
  o.hasAlignment = r.bool();
  if (o.hasAlignment) {
    o.zTarget = r.u8();
    o.yTarget = r.u8();
    o.zReference = r.u32();
    o.yReference = r.u32();
  }
}

function readMeshBody(r, o) {
  readNode(r, o);
  o.vertexBuffer = r.u32();
  const n = r.u32();
  o.submeshes = [];
  for (let i = 0; i < n; i++) o.submeshes.push({ indexBuffer: r.u32(), appearance: r.u32() });
}

function readGroupBody(r, o) {
  readNode(r, o);
  o.children = r.refs();
}

function readVertexArrayData(r, o) {
  const n = o.vertexCount * o.componentCount;
  let data;
  if (o.componentSize === 1) {
    data = new Int8Array(n);
    for (let i = 0; i < n; i++) data[i] = r.i8();
  } else if (o.componentSize === 2) {
    data = new Int16Array(n);
    for (let i = 0; i < n; i++) data[i] = r.i16();
  } else {
    throw new Error(`D4D: VertexArray componentSize ${o.componentSize} not supported`);
  }
  if (o.encoding === 1) {
    // delta encoding: each vertex stores the difference to the previous one
    // (typed-array stores wrap around, which is the intended modular arithmetic)
    const cc = o.componentCount;
    for (let i = cc; i < n; i++) data[i] = data[i] + data[i - cc];
  } else if (o.encoding !== 0) {
    throw new Error(`D4D: VertexArray encoding ${o.encoding} not supported`);
  }
  o.data = data;
}

const BODY_PARSERS = {
  0(r, o) { // Header [untested]
    o.version = [r.u8(), r.u8()];
    o.hasExternalReferences = r.bool();
    o.totalFileSize = r.u32();
    o.approximateContentSize = r.u32();
    const start = r.pos;
    while (r.pos < r.end && r.bytes[r.pos] !== 0) r.pos++;
    o.authoringField = new TextDecoder().decode(r.bytes.subarray(start, r.pos));
    if (r.pos < r.end) r.pos++;
  },
  1(r, o) { // AnimationController
    readObject3D(r, o);
    o.speed = r.f32();
    o.weight = r.f32();
    o.activeIntervalStart = r.i32();
    o.activeIntervalEnd = r.i32();
    o.referenceSequenceTime = r.f32();
    o.referenceWorldTime = r.i32();
  },
  2(r, o) { // AnimationTrack
    readObject3D(r, o);
    o.keyframeSequence = r.u32();
    o.animationController = r.u32();
    o.propertyID = r.u32();
    o.property = ANIM_PROPERTY[o.propertyID] ?? `unknown(${o.propertyID})`;
  },
  3(r, o) { // Appearance
    readObject3D(r, o);
    o.layer = r.i8();
    o.compositingMode = r.u32();
    o.fog = r.u32();
    o.polygonMode = r.u32();
    o.material = r.u32();
    o.textures = r.refs();
  },
  4(r, o) { // Background [untested]
    readObject3D(r, o);
    o.backgroundColor = r.rgba();
    o.backgroundImage = r.u32();
    o.backgroundImageModeX = r.u8();
    o.backgroundImageModeY = r.u8();
    o.cropX = r.i32(); o.cropY = r.i32(); o.cropWidth = r.i32(); o.cropHeight = r.i32();
    o.depthClearEnabled = r.bool();
    o.colorClearEnabled = r.bool();
  },
  5(r, o) { // Camera [untested]
    readNode(r, o);
    o.projectionType = r.u8(); // 48 generic, 49 parallel, 50 perspective
    if (o.projectionType === 48) {
      o.projectionMatrix = r.f32s(16);
    } else {
      o.fovy = r.f32(); o.aspectRatio = r.f32(); o.near = r.f32(); o.far = r.f32();
    }
  },
  6(r, o) { // CompositingMode
    readObject3D(r, o);
    o.depthTestEnabled = r.bool();
    o.depthWriteEnabled = r.bool();
    o.colorWriteEnabled = r.bool();
    o.alphaWriteEnabled = r.bool();
    o.blendingID = r.u8();
    o.blending = BLENDING[o.blendingID] ?? `unknown(${o.blendingID})`;
    o.alphaThresholdByte = r.u8();
    o.alphaThreshold = o.alphaThresholdByte / 255;
    o.depthOffsetFactor = r.f32();
    o.depthOffsetUnits = r.f32();
  },
  7(r, o) { // Fog [untested]
    readObject3D(r, o);
    o.color = r.rgb();
    o.mode = r.u8(); // 80 exponential, 81 linear
    if (o.mode === 80) o.density = r.f32();
    else if (o.mode === 81) { o.near = r.f32(); o.far = r.f32(); }
  },
  8(r, o) { // PolygonMode
    readObject3D(r, o);
    o.cullingID = r.u8(); o.culling = CULLING[o.cullingID] ?? `unknown(${o.cullingID})`;
    o.shadingID = r.u8(); o.shading = SHADING[o.shadingID] ?? `unknown(${o.shadingID})`;
    o.windingID = r.u8(); o.winding = WINDING[o.windingID] ?? `unknown(${o.windingID})`;
    o.twoSidedLightingEnabled = r.bool();
    o.localCameraLightingEnabled = r.bool();
    o.perspectiveCorrectionEnabled = r.bool();
  },
  9(r, o) { readGroupBody(r, o); }, // Group [untested]
  10(r, o) { // Image2D
    readObject3D(r, o);
    o.formatID = r.u8();
    o.format = IMAGE_FORMAT[o.formatID] ?? `unknown(${o.formatID})`;
    o.isMutable = r.bool();
    o.width = r.u32();
    o.height = r.u32();
    if (!o.isMutable) {
      o.palette = r.raw(r.u32());
      o.pixels = r.raw(r.u32());
    } else {
      o.palette = new Uint8Array(0);
      o.pixels = new Uint8Array(0);
    }
  },
  11(r, o) { // TriangleStripArray
    readObject3D(r, o);
    o.encoding = r.u8();
    const e = o.encoding;
    o.startIndex = null;
    o.indices = null;
    if (e === 0) o.startIndex = r.u32();
    else if (e === 1) o.startIndex = r.u8();
    else if (e === 2) o.startIndex = r.u16();
    else if (e === 128 || e === 129 || e === 130) {
      const n = r.u32();
      const idx = e === 128 ? new Uint32Array(n) : new Uint16Array(n);
      for (let i = 0; i < n; i++) idx[i] = e === 128 ? r.u32() : e === 129 ? r.u8() : r.u16();
      o.indices = idx;
    } else {
      throw new Error(`D4D: TriangleStripArray encoding ${e} not supported`);
    }
    const k = r.u32();
    o.stripLengths = new Uint32Array(k);
    for (let i = 0; i < k; i++) o.stripLengths[i] = r.u32();
  },
  12(r, o) { // Light [untested]
    readNode(r, o);
    o.attenuationConstant = r.f32(); o.attenuationLinear = r.f32(); o.attenuationQuadratic = r.f32();
    o.color = r.rgb();
    o.mode = r.u8(); // 128 ambient, 129 directional, 130 omni, 131 spot
    o.intensity = r.f32();
    o.spotAngle = r.f32();
    o.spotExponent = r.f32();
  },
  13(r, o) { // Material [untested]
    readObject3D(r, o);
    o.ambientColor = r.rgb();
    o.diffuseColor = r.rgba();
    o.emissiveColor = r.rgb();
    o.specularColor = r.rgb();
    o.shininess = r.f32();
    o.vertexColorTrackingEnabled = r.bool();
  },
  14(r, o) { readMeshBody(r, o); }, // Mesh
  15(r, o) { // MorphingMesh [untested]
    readMeshBody(r, o);
    const n = r.u32();
    o.morphTargets = [];
    for (let i = 0; i < n; i++) o.morphTargets.push({ vertexBuffer: r.u32(), initialWeight: r.f32() });
  },
  16(r, o) { // SkinnedMesh [untested]
    readMeshBody(r, o);
    o.skeleton = r.u32();
    const n = r.u32();
    o.transformReferences = [];
    for (let i = 0; i < n; i++) {
      o.transformReferences.push({ transformNode: r.u32(), firstVertex: r.u32(), vertexCount: r.u32(), weight: r.i32() });
    }
  },
  17(r, o) { // Texture2D
    readTransformable(r, o);
    o.image = r.u32();
    o.blendColor = r.rgb();
    o.blendingID = r.u8(); o.blending = TEX_BLENDING[o.blendingID] ?? `unknown(${o.blendingID})`;
    o.wrappingSID = r.u8(); o.wrappingS = TEX_WRAP[o.wrappingSID] ?? `unknown(${o.wrappingSID})`;
    o.wrappingTID = r.u8(); o.wrappingT = TEX_WRAP[o.wrappingTID] ?? `unknown(${o.wrappingTID})`;
    o.levelFilterID = r.u8(); o.levelFilter = TEX_FILTER[o.levelFilterID] ?? `unknown(${o.levelFilterID})`;
    o.imageFilterID = r.u8(); o.imageFilter = TEX_FILTER[o.imageFilterID] ?? `unknown(${o.imageFilterID})`;
  },
  18(r, o) { // Sprite3D [untested]
    readNode(r, o);
    o.image = r.u32();
    o.appearance = r.u32();
    o.isScaled = r.bool();
    o.cropX = r.i32(); o.cropY = r.i32(); o.cropWidth = r.i32(); o.cropHeight = r.i32();
  },
  19(r, o) { // KeyframeSequence
    readObject3D(r, o);
    o.interpolationID = r.u8();
    o.interpolation = INTERPOLATION[o.interpolationID] ?? `unknown(${o.interpolationID})`;
    o.repeatModeID = r.u8();
    o.repeatMode = REPEAT_MODE[o.repeatModeID] ?? `unknown(${o.repeatModeID})`;
    o.encoding = r.u8();
    o.duration = r.u32();
    o.validRangeFirst = r.u32();
    o.validRangeLast = r.u32();
    o.componentCount = r.u32();
    o.keyframeCount = r.u32();
    const cc = o.componentCount, kc = o.keyframeCount;
    r.need(kc * 4); // sanity before allocating
    o.times = new Int32Array(kc);
    o.values = new Float32Array(kc * cc);
    if (o.encoding === 0) {
      for (let k = 0; k < kc; k++) {
        o.times[k] = r.i32();
        for (let c = 0; c < cc; c++) o.values[k * cc + c] = r.f32();
      }
    } else if (o.encoding === 1 || o.encoding === 2) {
      const bias = r.f32s(cc), scale = r.f32s(cc);
      const max = o.encoding === 1 ? 255 : 65535;
      for (let k = 0; k < kc; k++) {
        o.times[k] = r.i32();
        for (let c = 0; c < cc; c++) {
          const q = o.encoding === 1 ? r.u8() : r.u16();
          o.values[k * cc + c] = bias[c] + (scale[c] * q) / max;
        }
      }
    } else {
      throw new Error(`D4D: KeyframeSequence encoding ${o.encoding} not supported`);
    }
  },
  20(r, o) { // VertexArray
    readObject3D(r, o);
    o.componentSize = r.u8();
    o.componentCount = r.u8();
    o.encoding = r.u8();
    o.vertexCount = r.u16();
    readVertexArrayData(r, o);
  },
  21(r, o) { // VertexBuffer
    readObject3D(r, o);
    o.defaultColor = r.rgba();
    o.positions = r.u32();
    o.positionBias = r.f32s(3);
    o.positionScale = r.f32();
    o.normals = r.u32();
    o.colors = r.u32();
    const n = r.u32();
    o.texCoords = [];
    for (let i = 0; i < n; i++) o.texCoords.push({ array: r.u32(), bias: r.f32s(3), scale: r.f32() });
  },
  22(r, o) { // World
    readGroupBody(r, o);
    o.activeCamera = r.u32();
    o.background = r.u32();
  },
  255(r, o) { // ExternalReference [untested]
    o.uri = new TextDecoder().decode(r.bytes.subarray(r.pos, r.end)).replace(/\0+$/, '');
    r.pos = r.end;
  },
};

// ----------------------------------------------------------------------------
// Scene assembly helpers
// ----------------------------------------------------------------------------

/** Column-major 4x4 (three.js Matrix4.fromArray layout) = T * R * S * M. */
function localMatrix(o) {
  const [tx, ty, tz] = o.translation;
  const [sx, sy, sz] = o.scale;
  const [ax, ay, az] = o.orientationAxis;
  const len = Math.hypot(ax, ay, az);
  // rotation (row-major 3x3)
  let r = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (len > 0 && o.orientationAngle !== 0) {
    const x = ax / len, y = ay / len, z = az / len;
    const a = (o.orientationAngle * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    r = [
      t * x * x + c, t * x * y - s * z, t * x * z + s * y,
      t * x * y + s * z, t * y * y + c, t * y * z - s * x,
      t * x * z - s * y, t * y * z + s * x, t * z * z + c,
    ];
  }
  // TRS, row-major 4x4
  const trs = [
    r[0] * sx, r[1] * sy, r[2] * sz, tx,
    r[3] * sx, r[4] * sy, r[5] * sz, ty,
    r[6] * sx, r[7] * sy, r[8] * sz, tz,
    0, 0, 0, 1,
  ];
  let m = trs;
  if (o.generalTransform) {
    const g = o.generalTransform;
    m = new Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let v = 0;
        for (let k = 0; k < 4; k++) v += trs[i * 4 + k] * g[k * 4 + j];
        m[i * 4 + j] = v;
      }
    }
  }
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) out[j * 4 + i] = m[i * 4 + j];
  return out;
}

function transformOf(o) {
  return {
    translation: o.translation.slice(),
    scale: o.scale.slice(),
    rotation: { angleDegrees: o.orientationAngle, axis: o.orientationAxis.slice() },
    generalMatrix: o.generalTransform ? Float32Array.from(o.generalTransform) : null, // row-major, as stored
    matrix: localMatrix(o), // column-major, T*R*S*M
    isIdentity:
      !o.generalTransform && o.orientationAngle === 0 &&
      o.translation.every((v) => v === 0) && o.scale.every((v) => v === 1),
  };
}

/** Expand triangle strips to a triangle list (M3G: winding flips on odd triangles). */
function stripsToTriangles(tsa, vertexCount) {
  const lengths = tsa.stripLengths;
  let total = 0, tris = 0;
  for (const l of lengths) { total += l; tris += Math.max(0, l - 2); }
  let src = tsa.indices;
  if (!src) { // implicit: consecutive indices from startIndex
    src = new Uint32Array(total);
    for (let i = 0; i < total; i++) src[i] = tsa.startIndex + i;
  } else if (src.length < total) {
    throw new Error(`D4D: strip lengths sum to ${total} but only ${src.length} indices are stored`);
  }
  const out = vertexCount > 65535 ? new Uint32Array(tris * 3) : new Uint16Array(tris * 3);
  let p = 0, w = 0, maxIndex = -1, allLists = true;
  for (const l of lengths) {
    if (l !== 3) allLists = false;
    for (let i = 0; i + 2 < l; i++) {
      const a = src[p + i], b = src[p + i + 1], c = src[p + i + 2];
      if (i & 1) { out[w++] = b; out[w++] = a; out[w++] = c; }
      else { out[w++] = a; out[w++] = b; out[w++] = c; }
      if (a > maxIndex) maxIndex = a;
      if (b > maxIndex) maxIndex = b;
      if (c > maxIndex) maxIndex = c;
    }
    p += l;
  }
  return { indices: out, maxIndex, isTriangleList: allLists, stripCount: lengths.length };
}

// ----------------------------------------------------------------------------
// Public: parse
// ----------------------------------------------------------------------------

/**
 * Parse a .d4d file.
 *
 * @param {ArrayBuffer|Uint8Array|ArrayBufferView} input
 * @param {{ texturePrefix?: string }} [options] texturePrefix: first three characters of the
 *        d4d file name (e.g. "a1_"); when given, every image gets `fileName` filled in.
 * @returns {D4DScene} plain data, see the bottom of parseD4D for the exact shape.
 */
export function parseD4D(input, options = {}) {
  const bytes = toBytes(input, 'parseD4D');

  const warnings = [];
  if (bytes.length < HEADER_SIZE || bytes[0] !== 0x44 || bytes[1] !== 0x34) {
    throw new Error('D4D: bad magic (expected "D4")');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = {
    magic: 'D4',
    reserved: bytes[2],
    variant: bytes[3],
    totalSectionBytes: view.getUint32(4, true),
    objectCount: view.getUint16(8, true),
  };
  if (header.reserved !== 0) warnings.push(`header byte 2 is ${header.reserved}, expected 0 (the DLL would reject this)`);
  if (header.variant !== 1) {
    throw new Error(`D4D: container variant ${header.variant} is not supported (only 1 = M3G sections)`);
  }
  if (header.totalSectionBytes !== bytes.length - HEADER_SIZE) {
    warnings.push(`header says ${header.totalSectionBytes} section bytes, file has ${bytes.length - HEADER_SIZE}`);
  }

  // ---- sections & raw objects ------------------------------------------------
  let accounted = HEADER_SIZE;
  let unparsed = 0;
  const unknownRanges = [];
  const sections = [];
  /** objects[i] is the object with M3G index i; 0 (null) and 1 (absent Header) are empty. */
  const objects = [null, null];
  let pos = HEADER_SIZE;
  while (pos < bytes.length) {
    if (pos + SECTION_OVERHEAD > bytes.length) {
      unknownRanges.push({ offset: pos, length: bytes.length - pos, what: 'trailing bytes (too short for a section)' });
      unparsed += bytes.length - pos;
      break;
    }
    const compression = bytes[pos];
    const totalLength = view.getUint32(pos + 1, true);
    const uncompressedLength = view.getUint32(pos + 5, true);
    if (compression !== 0) throw new Error(`D4D: section at ${pos} uses compression scheme ${compression} (unsupported)`);
    if (totalLength < SECTION_OVERHEAD || pos + totalLength > bytes.length) {
      throw new Error(`D4D: section at ${pos} has invalid length ${totalLength}`);
    }
    if (uncompressedLength !== totalLength - SECTION_OVERHEAD) {
      warnings.push(`section at ${pos}: uncompressedLength ${uncompressedLength} != totalLength-13`);
    }
    const dataStart = pos + 9;
    const dataEnd = pos + totalLength - 4;
    const checksum = view.getUint32(dataEnd, true);
    const computed = adler32(bytes, pos, Math.min(pos + uncompressedLength, bytes.length));
    const section = {
      offset: pos, compression, totalLength, uncompressedLength,
      checksum, checksumComputed: computed, checksumValid: checksum === computed,
      firstObjectIndex: objects.length, objectCount: 0,
    };
    if (!section.checksumValid) warnings.push(`section at ${pos}: checksum mismatch (stored ${checksum.toString(16)}, computed ${computed.toString(16)})`);
    accounted += SECTION_OVERHEAD;

    let p = dataStart;
    while (p < dataEnd) {
      if (p + 5 > dataEnd) {
        unknownRanges.push({ offset: p, length: dataEnd - p, what: 'bytes after last object in section' });
        unparsed += dataEnd - p;
        break;
      }
      const type = bytes[p];
      const length = view.getUint32(p + 1, true);
      const bodyStart = p + 5;
      const bodyEnd = bodyStart + length;
      if (bodyEnd > dataEnd) throw new Error(`D4D: object at ${p} (type ${type}) overruns its section`);
      const obj = {
        index: objects.length,
        type,
        typeName: D4D_OBJECT_TYPE_NAMES[type] ?? `Unknown(${type})`,
        offset: p,
        length,
      };
      accounted += 5;
      const parser = BODY_PARSERS[type];
      if (parser) {
        const r = new Reader(bytes, bodyStart, bodyEnd);
        parser(r, obj);
        accounted += r.pos - bodyStart;
        if (r.pos !== bodyEnd) {
          unknownRanges.push({ offset: r.pos, length: bodyEnd - r.pos, what: `unread tail of ${obj.typeName} #${obj.index}` });
          unparsed += bodyEnd - r.pos;
        }
      } else {
        obj.raw = bytes.slice(bodyStart, bodyEnd);
        unknownRanges.push({ offset: bodyStart, length, what: `body of unknown object type ${type} #${obj.index}` });
        unparsed += length;
        warnings.push(`unknown object type ${type} at ${p}`);
      }
      objects.push(obj);
      section.objectCount++;
      p = bodyEnd;
    }
    sections.push(section);
    pos += totalLength;
  }
  const parsedObjectCount = objects.length - 2;
  if (parsedObjectCount !== header.objectCount) {
    warnings.push(`header says ${header.objectCount} objects, found ${parsedObjectCount}`);
  }

  // ---- reference resolution ---------------------------------------------------
  const get = (ref, typeCheck, what) => {
    if (ref === 0) return null;
    const o = objects[ref];
    if (!o) throw new Error(`D4D: ${what} references missing object ${ref}`);
    if (typeCheck && !typeCheck.includes(o.type)) {
      throw new Error(`D4D: ${what} references object ${ref} of type ${o.typeName}`);
    }
    return o;
  };

  // images
  const images = [];
  const imageSlot = new Map();
  for (const o of objects) {
    if (!o || o.type !== 10) continue;
    imageSlot.set(o.index, images.length);
    const bpp = IMAGE_BPP[o.formatID] ?? 0;
    const paletted = o.palette.length > 0;
    images.push({
      objectIndex: o.index,
      /** texture number; external file = <prefix><userID>.bmp */
      userID: o.userID,
      fileName: options.texturePrefix != null ? d4dTextureFileName(options.texturePrefix, o.userID) : null,
      format: o.format,
      formatID: o.formatID,
      width: o.width,
      height: o.height,
      isMutable: o.isMutable,
      isPaletted: paletted,
      bytesPerPixel: bpp,
      /** palette entries of `bytesPerPixel` bytes each (empty if not paletted) */
      palette: o.palette,
      /** palette indices (paletted) or packed pixels, rows top-down */
      pixels: o.pixels,
      /** true for the 1x1 stand-ins the game replaces with <prefix><userID>.bmp */
      isPlaceholder: o.width === 1 && o.height === 1,
    });
  }

  // animation
  const controllers = [];
  const controllerSlot = new Map();
  for (const o of objects) {
    if (!o || o.type !== 1) continue;
    controllerSlot.set(o.index, controllers.length);
    controllers.push({
      objectIndex: o.index,
      speed: o.speed,
      weight: o.weight,
      activeIntervalStart: o.activeIntervalStart,
      activeIntervalEnd: o.activeIntervalEnd,
      referenceSequenceTime: o.referenceSequenceTime,
      referenceWorldTime: o.referenceWorldTime,
    });
  }
  const animations = [];
  const trackSlot = new Map();
  for (const o of objects) {
    if (!o || o.type !== 2) continue;
    const ks = get(o.keyframeSequence, [19], 'AnimationTrack.keyframeSequence');
    const ctl = get(o.animationController, [1], 'AnimationTrack.animationController');
    trackSlot.set(o.index, animations.length);
    animations.push({
      objectIndex: o.index,
      /** filled in below: { kind: 'texture'|'node'|'object', index, objectIndex } */
      targets: [],
      property: o.property,
      propertyID: o.propertyID,
      controller: ctl ? controllerSlot.get(ctl.index) : -1,
      interpolation: ks.interpolation,
      repeatMode: ks.repeatMode,
      duration: ks.duration,
      validRangeFirst: ks.validRangeFirst,
      validRangeLast: ks.validRangeLast,
      componentCount: ks.componentCount,
      keyframeCount: ks.keyframeCount,
      /** Int32Array, keyframe times in sequence-time units (ms) */
      times: ks.times,
      /** Float32Array, keyframeCount * componentCount */
      values: ks.values,
    });
  }
  const tracksOf = (o, kind, index) => o.animationTracks.map((ref) => {
    get(ref, [2], `${o.typeName}.animationTracks`);
    const slot = trackSlot.get(ref);
    animations[slot].targets.push({ kind, index, objectIndex: o.index });
    return slot;
  });

  // textures
  const textures = [];
  const textureSlot = new Map();
  for (const o of objects) {
    if (!o || o.type !== 17) continue;
    const img = get(o.image, [10], 'Texture2D.image');
    const slot = textures.length;
    textureSlot.set(o.index, slot);
    textures.push({
      objectIndex: o.index,
      image: img ? imageSlot.get(img.index) : -1,
      imageUserID: img ? img.userID : -1,
      fileName: img && options.texturePrefix != null ? d4dTextureFileName(options.texturePrefix, img.userID) : null,
      blending: o.blending, // texture environment: 'modulate' in all samples
      blendColor: o.blendColor,
      wrapS: o.wrappingS,
      wrapT: o.wrappingT,
      levelFilter: o.levelFilter, // 'baseLevel' = no mipmapping
      imageFilter: o.imageFilter, // 'nearest' | 'linear'
      /** texture-coordinate transform (applied to (s,t,0,1) after scale/bias) */
      transform: transformOf(o),
      animationTracks: tracksOf(o, 'texture', slot),
    });
  }

  // materials (one per Appearance)
  const materials = [];
  const materialSlot = new Map();
  for (const o of objects) {
    if (!o || o.type !== 3) continue;
    const cm = get(o.compositingMode, [6], 'Appearance.compositingMode');
    const pm = get(o.polygonMode, [8], 'Appearance.polygonMode');
    const mat = get(o.material, [13], 'Appearance.material');
    const fog = get(o.fog, [7], 'Appearance.fog');
    const texSlots = o.textures.map((ref) => {
      get(ref, [17], 'Appearance.textures');
      return textureSlot.get(ref);
    });
    const blending = cm ? cm.blending : 'replace';
    const alphaThreshold = cm ? cm.alphaThreshold : 0;
    const culling = pm ? pm.culling : 'back';
    const slot = materials.length;
    materialSlot.set(o.index, slot);
    const tex0 = texSlots.length ? textures[texSlots[0]] : null;
    materials.push({
      objectIndex: o.index,
      /** draw-order layer (lower first; within a layer opaque before blended) */
      layer: o.layer,
      textures: texSlots,
      /** convenience copies for texture unit 0 (-1 / null if untextured) */
      texture: texSlots.length ? texSlots[0] : -1,
      textureUserID: tex0 ? tex0.imageUserID : -1,
      textureFileName: tex0 ? tex0.fileName : null,
      /** 'replace' | 'alpha' | 'alphaAdd' | 'modulate' | 'modulateX2' */
      blendMode: blending,
      /** fragments with alpha < alphaThreshold are discarded (0 = no test) */
      alphaThreshold,
      /** true when the texture's alpha channel (BMP palette byte 3) affects the result */
      usesTextureAlpha: blending !== 'replace' || alphaThreshold > 0,
      transparent: blending !== 'replace',
      depthTest: cm ? cm.depthTestEnabled : true,
      depthWrite: cm ? cm.depthWriteEnabled : true,
      colorWrite: cm ? cm.colorWriteEnabled : true,
      alphaWrite: cm ? cm.alphaWriteEnabled : true,
      /** glPolygonOffset(factor, units) */
      depthOffsetFactor: cm ? cm.depthOffsetFactor : 0,
      depthOffsetUnits: cm ? cm.depthOffsetUnits : 0,
      culling, // 'back' | 'front' | 'none'
      doubleSided: culling === 'none',
      winding: pm ? pm.winding : 'ccw',
      shading: pm ? pm.shading : 'smooth',
      perspectiveCorrection: pm ? pm.perspectiveCorrectionEnabled : false,
      twoSidedLighting: pm ? pm.twoSidedLightingEnabled : false,
      /** M3G Material (lighting) or null = unlit, vertex colours only (all samples) */
      lighting: mat ? {
        ambientColor: mat.ambientColor, diffuseColor: mat.diffuseColor,
        emissiveColor: mat.emissiveColor, specularColor: mat.specularColor,
        shininess: mat.shininess, vertexColorTracking: mat.vertexColorTrackingEnabled,
      } : null,
      fog: fog ? { color: fog.color, mode: fog.mode === 80 ? 'exponential' : 'linear', density: fog.density, near: fog.near, far: fog.far } : null,
    });
  }

  // vertex buffers -> decoded attribute arrays (cached, shared between meshes)
  const vbCache = new Map();
  const decodeVertexBuffer = (vb) => {
    if (vbCache.has(vb.index)) return vbCache.get(vb.index);
    const pa = get(vb.positions, [20], 'VertexBuffer.positions');
    const na = get(vb.normals, [20], 'VertexBuffer.normals');
    const ca = get(vb.colors, [20], 'VertexBuffer.colors');
    const out = {
      vertexCount: pa ? pa.vertexCount : 0,
      positions: null, positionScale: vb.positionScale, positionBias: vb.positionBias.slice(),
      normals: null, colors: null, colorItemSize: 0, defaultColor: vb.defaultColor.slice(),
      uvs: null, uvSets: [],
      boundsMin: [0, 0, 0], boundsMax: [0, 0, 0],
    };
    if (pa) {
      if (pa.componentCount !== 3) throw new Error('D4D: position array must have 3 components');
      const n = pa.vertexCount;
      const p = new Float32Array(n * 3);
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < n * 3; i++) {
        const c = i % 3;
        const v = pa.data[i] * vb.positionScale + vb.positionBias[c];
        p[i] = v;
        if (v < mn[c]) mn[c] = v;
        if (v > mx[c]) mx[c] = v;
      }
      out.positions = p;
      if (n) { out.boundsMin = mn; out.boundsMax = mx; }
    }
    if (na) {
      // [untested] M3G: signed fixed point mapped to [-1, 1]
      const div = na.componentSize === 1 ? 127 : 32767;
      const nrm = new Float32Array(na.data.length);
      for (let i = 0; i < nrm.length; i++) nrm[i] = Math.max(-1, na.data[i] / div);
      out.normals = nrm;
    }
    if (ca) {
      // colours are unsigned bytes even though VertexArray stores int8
      out.colors = new Uint8Array(ca.data.buffer.slice(ca.data.byteOffset, ca.data.byteOffset + ca.data.byteLength));
      out.colorItemSize = ca.componentCount; // 3 = RGB, 4 = RGBA
    }
    for (const tc of vb.texCoords) {
      const ta = get(tc.array, [20], 'VertexBuffer.texCoords');
      if (!ta) { out.uvSets.push(null); continue; }
      const cc = ta.componentCount;
      const uv = new Float32Array(ta.vertexCount * 2);
      for (let i = 0; i < ta.vertexCount; i++) {
        uv[i * 2] = ta.data[i * cc] * tc.scale + tc.bias[0];
        uv[i * 2 + 1] = ta.data[i * cc + 1] * tc.scale + tc.bias[1];
      }
      out.uvSets.push(uv);
    }
    out.uvs = out.uvSets.length ? out.uvSets[0] : null;
    vbCache.set(vb.index, out);
    return out;
  };

  // meshes + node hierarchy
  const meshes = [];
  const nodes = [];
  const nodeSlot = new Map();
  const NODE_TYPES = [5, 9, 12, 14, 15, 16, 18, 22];
  const referenced = new Set();
  const buildNode = (o, parent) => {
    if (nodeSlot.has(o.index)) return nodeSlot.get(o.index);
    const slot = nodes.length;
    nodeSlot.set(o.index, slot);
    const node = {
      objectIndex: o.index,
      type: o.typeName,
      userID: o.userID,
      parent,
      children: [],
      transform: transformOf(o),
      visible: o.enableRendering,
      pickable: o.enablePicking,
      alphaFactor: o.alphaFactor,
      scope: o.scope,
      mesh: -1,
      animationTracks: [],
    };
    nodes.push(node);
    node.animationTracks = tracksOf(o, 'node', slot);
    if (o.type === 14 || o.type === 15 || o.type === 16) {
      const vb = get(o.vertexBuffer, [21], 'Mesh.vertexBuffer');
      const dec = decodeVertexBuffer(vb);
      const submeshes = o.submeshes.map((s, i) => {
        const ib = get(s.indexBuffer, [11], 'Mesh.indexBuffer');
        const ap = get(s.appearance, [3], 'Mesh.appearance');
        const tri = stripsToTriangles(ib, dec.vertexCount);
        if (tri.maxIndex >= dec.vertexCount) {
          throw new Error(`D4D: submesh ${i} of mesh #${o.index} uses vertex ${tri.maxIndex} of ${dec.vertexCount}`);
        }
        return {
          /** triangle list (Uint16Array, or Uint32Array if > 65535 vertices) */
          indices: tri.indices,
          triangleCount: tri.indices.length / 3,
          material: ap ? materialSlot.get(ap.index) : -1,
          indexBufferObject: ib.index,
          appearanceObject: ap ? ap.index : 0,
          sourceIsTriangleList: tri.isTriangleList,
        };
      });
      node.mesh = meshes.length;
      meshes.push({
        objectIndex: o.index,
        node: slot,
        vertexCount: dec.vertexCount,
        /** Float32Array xyz, file-native units (already scale/bias applied) */
        positions: dec.positions,
        /** Float32Array xyz or null (never present in the samples) */
        normals: dec.normals,
        /** Uint8Array, colorItemSize (3 or 4) bytes per vertex, 0..255, or null */
        colors: dec.colors,
        colorItemSize: dec.colorItemSize,
        /** RGBA used when `colors` is null */
        defaultColor: dec.defaultColor,
        /** Float32Array st for texture unit 0 (M3G convention: t down), or null */
        uvs: dec.uvs,
        /** one Float32Array per texture unit */
        uvSets: dec.uvSets,
        positionScale: dec.positionScale,
        positionBias: dec.positionBias,
        boundsMin: dec.boundsMin,
        boundsMax: dec.boundsMax,
        submeshes,
      });
    }
    if (o.children) {
      for (const ref of o.children) {
        const c = get(ref, NODE_TYPES, `${o.typeName}.children`);
        if (!c) continue;
        referenced.add(c.index);
        node.children.push(buildNode(c, slot));
      }
    }
    return slot;
  };
  for (const o of objects) if (o && o.children) for (const ref of o.children) referenced.add(ref);
  // roots = node objects nobody lists as a child (the DLL requires exactly one root, a World)
  const roots = [];
  for (const o of objects) {
    if (o && NODE_TYPES.includes(o.type) && !referenced.has(o.index)) roots.push(buildNode(o, -1));
  }
  if (roots.length !== 1) warnings.push(`expected exactly one root node, found ${roots.length}`);
  else if (nodes[roots[0]].type !== 'World') warnings.push(`root node is a ${nodes[roots[0]].type}, the DLL expects a World`);

  // overall bounds (node transforms are identity in every sample; they are ignored here)
  const boundsMin = [Infinity, Infinity, Infinity], boundsMax = [-Infinity, -Infinity, -Infinity];
  let vertexCount = 0, triangleCount = 0;
  for (const m of meshes) {
    vertexCount += m.vertexCount;
    for (const s of m.submeshes) triangleCount += s.triangleCount;
    if (!m.vertexCount) continue;
    for (let c = 0; c < 3; c++) {
      if (m.boundsMin[c] < boundsMin[c]) boundsMin[c] = m.boundsMin[c];
      if (m.boundsMax[c] > boundsMax[c]) boundsMax[c] = m.boundsMax[c];
    }
  }
  if (!vertexCount) { boundsMin.fill(0); boundsMax.fill(0); }

  return {
    format: 'D4D (HI Micro3D D4 container around a JSR-184/M3G 1.0 object stream)',
    byteLength: bytes.length,
    /** first 3 chars of the d4d name if options.texturePrefix was given, else null */
    texturePrefix: options.texturePrefix != null ? d4dTextureFileName(options.texturePrefix, '').slice(0, -4) : null,
    header,
    sections,
    /** raw M3G objects by object index (0 and 1 are null); references in here are object indices */
    objects,
    /** node hierarchy; nodes[root] is the World. `children`/`parent` are indices into `nodes` */
    nodes,
    root: roots.length ? roots[0] : -1,
    roots,
    meshes,
    materials,
    textures,
    images,
    animations,
    animationControllers: controllers,
    boundsMin,
    boundsMax,
    vertexCount,
    triangleCount,
    /** bytes not understood by the parser (0 for all 35 game maps) */
    unparsedBytes: unparsed,
    /** every byte is either `accountedBytes` or listed in `unknownRanges` */
    accountedBytes: accounted,
    unknownRanges,
    warnings,
  };
}

// ----------------------------------------------------------------------------
// Public: texture helpers
// ----------------------------------------------------------------------------

/**
 * External texture name rule used by the game.
 * @param {string} d4dNameOrPrefix e.g. "a1_3.d4d", "path/a1_3.d4d" or just "a1_"
 * @param {number} userID Image2D.userID (see `images[i].userID`, `materials[i].textureUserID`)
 * @returns {string} e.g. "a1_7.bmp"
 */
export function d4dTextureFileName(d4dNameOrPrefix, userID) {
  const base = String(d4dNameOrPrefix).split(/[\\/]/).pop();
  return `${base.substring(0, 3)}${userID}.bmp`;
}

/**
 * Decode one of the game's map texture BMPs the way the game does before it
 * patches it into the Image2D: 8-bit paletted, alpha taken from the 4th byte of
 * each palette entry (which ordinary BMP decoders ignore).
 *
 * @param {ArrayBuffer|Uint8Array} input the .bmp file
 * @param {{ forceOpaque?: boolean }} [options] forceOpaque: write alpha 255 everywhere. Use it
 *        for materials with `usesTextureAlpha === false`: those BMPs carry alpha 0 in every
 *        palette entry, which the original ignores (REPLACE blending) but which would make a
 *        WebGL canvas with an alpha channel see-through.
 * @returns {{ width: number, height: number, rgba: Uint8Array, palette: Uint8Array,
 *             indices: Uint8Array, hasAlpha: boolean, alphaValues: number[] }}
 *          `rgba`/`indices` rows are top-down (row 0 = t 0). `palette` is 256 * RGBA.
 */
export function decodeD4DTextureBMP(input, options = {}) {
  const b = toBytes(input, 'decodeD4DTextureBMP');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 54 || b[0] !== 0x42 || b[1] !== 0x4d) throw new Error('decodeD4DTextureBMP: not a BMP');
  const dataOffset = dv.getUint32(10, true);
  const infoSize = dv.getUint32(14, true);
  const width = dv.getInt32(18, true);
  const rawHeight = dv.getInt32(22, true);
  const bpp = dv.getUint16(28, true);
  const compression = dv.getUint32(30, true);
  if (bpp !== 8 || compression !== 0) throw new Error(`decodeD4DTextureBMP: only uncompressed 8-bit BMPs are supported (bpp ${bpp}, compression ${compression})`);
  const height = Math.abs(rawHeight);
  const bottomUp = rawHeight > 0;
  const palOffset = 14 + infoSize; // the game hard-codes 54 and data offset 1078
  const palCount = Math.min(256, (dataOffset - palOffset) >> 2);
  const palette = new Uint8Array(256 * 4);
  const alphaSeen = new Set();
  for (let i = 0; i < palCount; i++) {
    const s = palOffset + i * 4;
    palette[i * 4] = b[s + 2];
    palette[i * 4 + 1] = b[s + 1];
    palette[i * 4 + 2] = b[s];
    palette[i * 4 + 3] = options.forceOpaque ? 255 : b[s + 3];
  }
  const stride = (width + 3) & ~3;
  const indices = new Uint8Array(width * height);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const src = dataOffset + (bottomUp ? height - 1 - y : y) * stride;
    for (let x = 0; x < width; x++) {
      const idx = b[src + x];
      const d = (y * width + x) * 4;
      indices[y * width + x] = idx;
      rgba[d] = palette[idx * 4];
      rgba[d + 1] = palette[idx * 4 + 1];
      rgba[d + 2] = palette[idx * 4 + 2];
      rgba[d + 3] = palette[idx * 4 + 3];
      alphaSeen.add(rgba[d + 3]);
    }
  }
  const alphaValues = [...alphaSeen].sort((p, q) => p - q);
  return { width, height, rgba, palette, indices, hasAlpha: alphaValues.some((a) => a !== 255), alphaValues };
}

// ----------------------------------------------------------------------------
// Public: animation helpers
// ----------------------------------------------------------------------------

/**
 * Sample an animation track at a world time (the integer the game passes to
 * Group.setTime, i.e. milliseconds), following M3G semantics.
 *
 * @param {D4DScene} scene result of parseD4D
 * @param {number} trackIndex index into scene.animations
 * @param {number} worldTime
 * @returns {number[]|null} componentCount values, or null when the controller is inactive
 */
export function sampleD4DTrack(scene, trackIndex, worldTime) {
  const tr = scene.animations[trackIndex];
  const ctl = tr.controller >= 0 ? scene.animationControllers[tr.controller] : null;
  if (!ctl) return null;
  if (ctl.activeIntervalStart !== ctl.activeIntervalEnd &&
      (worldTime < ctl.activeIntervalStart || worldTime >= ctl.activeIntervalEnd)) return null;
  if (ctl.weight === 0) return null;
  let t = ctl.referenceSequenceTime + ctl.speed * (worldTime - ctl.referenceWorldTime);
  const cc = tr.componentCount;
  const first = tr.validRangeFirst, last = tr.validRangeLast;
  // valid range may wrap (first > last); collect the keyframe order
  const order = [];
  if (first <= last) for (let k = first; k <= last; k++) order.push(k);
  else {
    for (let k = first; k < tr.keyframeCount; k++) order.push(k);
    for (let k = 0; k <= last; k++) order.push(k);
  }
  const value = (k) => Array.from(tr.values.subarray(k * cc, k * cc + cc));
  if (order.length === 0) return null;
  const loop = tr.repeatMode === 'loop' && tr.duration > 0;
  if (loop) { t %= tr.duration; if (t < 0) t += tr.duration; }
  const tFirst = tr.times[order[0]], tLast = tr.times[order[order.length - 1]];
  let k0, k1, t0, t1;
  if (t < tFirst) {
    if (!loop) return value(order[0]);
    k0 = order[order.length - 1]; k1 = order[0]; t0 = tLast - tr.duration; t1 = tFirst;
  } else if (t >= tLast) {
    if (!loop) return value(order[order.length - 1]);
    k0 = order[order.length - 1]; k1 = order[0]; t0 = tLast; t1 = tFirst + tr.duration;
  } else {
    let i = 0;
    while (i + 1 < order.length && tr.times[order[i + 1]] <= t) i++;
    k0 = order[i]; k1 = order[i + 1]; t0 = tr.times[k0]; t1 = tr.times[k1];
  }
  if (tr.interpolation === 'step' || t1 === t0) return value(k0);
  const f = (t - t0) / (t1 - t0);
  const a = value(k0), b = value(k1);
  for (let c = 0; c < cc; c++) a[c] += (b[c] - a[c]) * f; // spline/slerp/squad fall back to linear
  return a;
}

/**
 * Texture-coordinate translation of a texture at a world time: the sampled
 * TRANSLATION track if the texture has an active one, else its stored value.
 * Apply as st' = st + [x, y] (three.js: texture.offset.set(x, y) with
 * flipY = false, or offset.set(x, -y) if you flipped v = 1 - t).
 *
 * @returns {number[]} [x, y, z]
 */
export function d4dTextureTranslationAt(scene, textureIndex, worldTime) {
  const tex = scene.textures[textureIndex];
  let out = tex.transform.translation.slice();
  let sum = null, wsum = 0;
  for (const ti of tex.animationTracks) {
    const tr = scene.animations[ti];
    if (tr.propertyID !== 275) continue;
    const v = sampleD4DTrack(scene, ti, worldTime);
    if (!v) continue;
    const w = scene.animationControllers[tr.controller].weight;
    if (!sum) sum = [0, 0, 0];
    for (let c = 0; c < 3; c++) sum[c] += (v[c] ?? 0) * w;
    wsum += w;
  }
  if (sum && wsum !== 0) out = sum; // M3G: weighted sum of all active tracks replaces the property
  return out;
}

/**
 * @typedef {ReturnType<typeof parseD4D>} D4DScene
 */
