// Optional lighting, cel shading and shadows, plus the shader hook that lets figures be shown
// between two animation poses. The phone game is unlit: every surface shows its texture or
// vertex colour as is. All options are off by default and change nothing when off.
//
// Lighting: opaque model and map materials get a flat-shaded term from one fixed directional
// light. The face normal comes from screen-space derivatives of the view-space position, so no
// normals are needed in the geometry.
//
// Cel shading (characters only: the player, people, enemies; not doors, crates or effects): the
// light term is cut into two flat tones, and every opaque mesh is drawn a second time in black,
// pushed slightly away from the camera and widened in screen space along its normals, which
// leaves a constant-width outline around silhouettes. Two sets of normals are used: `normal`
// keeps hard edges (faces meeting at more than CREASE_ANGLE are not averaged), so a boxy part is
// shaded face by face while a rounded one gets a smooth boundary; `rdSmooth` averages every face
// at a vertex, so the outline shell does not split open at hard edges. The cel light follows the
// camera (from above, in front and to the left of the view) so the side facing the viewer is
// lit, whichever way the scene happens to face.
//
// Shadows: a soft dark disc on the ground under every animated figure, found by casting a ray
// down onto the map meshes drawn in the same batch.

import * as THREE from 'three';

/** Direction towards the light, world space (y up). */
const WORLD_LIGHT = new THREE.Vector3(0.35, 0.85, 0.4).normalize();
/** Brightness of a face turned away from / fully towards the light. */
const SHADE_DARK = 0.62;
const SHADE_LIT = 1.15;
/** Cel shading: the two tones, and how far towards the light a surface must face to be lit. */
const CEL_DARK = 0.72;
const CEL_LIT = 1.06;
const CEL_EDGE = 0.0;
/** Faces meeting at a sharper angle than this keep a hard shading edge between them. */
const CREASE_COS = Math.cos((55 * Math.PI) / 180);
/** Cel light: world "up" plus this view-space direction (x right, y down, z into the screen). */
const CEL_UP = 0.75;
const CEL_VIEW = new THREE.Vector3(-0.4, 0, -0.65);
/** Outline width in phone pixels, and how far (world units) the outline shell sits behind. */
const OUTLINE_WIDTH = 0.75;
const OUTLINE_PUSH = 0.12;

const uniforms = {
  uRdLight: { value: new THREE.Vector3(0, -1, 0) },
  uRdAmount: { value: 0 },
  uRdCel: { value: 0 },
  uRdCelLight: { value: new THREE.Vector3(0, -1, 0) },
  uRdOutline: { value: new THREE.Vector2() },
  uRdTween: { value: 1 },
};

const f2 = (v) => v.toFixed(3);
const TWEEN_DECL = '\nattribute vec3 rdPrev;\nuniform float uRdTween;';
// figures keep the previous frame's posed vertices in rdPrev (figure.js)
const TWEEN_BEGIN = 'vec3 transformed = mix(rdPrev, position, uRdTween);';
const VIEW_NORMAL = `
  #ifdef USE_SKINNING
    vec3 rdNormal = transformedNormal;
  #else
    vec3 rdNormal = normalMatrix * normal;
  #endif`;

/**
 * Hook a MeshBasicMaterial into the optional rendering features.
 * @param {object} [o]
 * @param {boolean} [o.light=true]      takes part in lighting (opaque surfaces)
 * @param {boolean} [o.character=false] a character model: cel shading applies, and the geometry
 *                                      has a `normal` attribute (zero = not computed)
 * @param {boolean} [o.tween=false]     the geometry has `rdPrev` (previous pose) to blend from
 */
export function makeLit(material, { light = true, character = false, tween = false } = {}) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let vs = shader.vertexShader.replace('#include <common>',
      `#include <common>\nvarying vec3 vRdView;${character ? '\nvarying vec3 vRdNormal;' : ''}${tween ? TWEEN_DECL : ''}`);
    if (tween) vs = vs.replace('#include <begin_vertex>', TWEEN_BEGIN);
    shader.vertexShader = vs.replace('#include <project_vertex>',
      `#include <project_vertex>\nvRdView = mvPosition.xyz;${character ? `${VIEW_NORMAL}\nvRdNormal = rdNormal;` : ''}`);
    if (!light) return;
    const flat = `
          vec3 rdN = normalize(cross(dFdx(vRdView), dFdy(vRdView)));
          if (rdN.z > 0.0) rdN = -rdN; // towards the viewer (view space looks down +z)`;
    const cel = character ? `
        if (uRdCel > 0.0) {
          vec3 rdS = vRdNormal;
          if (dot(rdS, rdS) < 1e-6) {${flat}
            rdS = rdN;
          }
          float rdC = dot(normalize(rdS), uRdCelLight);
          outgoingLight *= mix(${f2(CEL_DARK)}, ${f2(CEL_LIT)}, smoothstep(-0.02, 0.02, rdC - ${f2(CEL_EDGE)}));
        } else` : '';
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vRdView;${character ? '\nvarying vec3 vRdNormal;' : ''}
        uniform vec3 uRdLight;\nuniform float uRdAmount;\nuniform float uRdCel;\nuniform vec3 uRdCelLight;`)
      .replace('#include <opaque_fragment>', `${cel}
        if (uRdAmount > 0.0) {${flat}
          float rdL = max(dot(rdN, uRdLight), 0.0);
          outgoingLight *= mix(1.0, ${f2(SHADE_DARK)} + ${f2(SHADE_LIT - SHADE_DARK)} * rdL, uRdAmount);
        }
        #include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => `rdash-${light ? 'l' : ''}${character ? 'c' : ''}${tween ? 't' : ''}`;
  return material;
}

/**
 * Turn a (black) MeshBasicMaterial into the cel-shading outline shell: drawn a little behind the
 * mesh and widened in screen space along the normals, so only a rim shows.
 */
export function makeOutline(material, { tween = false } = {}) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let vs = shader.vertexShader.replace('#include <common>',
      `#include <common>\nuniform vec2 uRdOutline;\nattribute vec3 rdSmooth;${tween ? TWEEN_DECL : ''}`);
    if (tween) vs = vs.replace('#include <begin_vertex>', TWEEN_BEGIN);
    // the shell is widened along the fully smoothed normals (skinned like the ordinary ones)
    vs = vs.replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(rdSmooth);');
    shader.vertexShader = vs.replace('#include <project_vertex>', `#include <project_vertex>
      #ifdef USE_SKINNING
        vec3 rdNormal = transformedNormal;
      #else
        vec3 rdNormal = normalMatrix * rdSmooth;
      #endif
      vec4 rdBack = mvPosition;
      rdBack.xyz += normalize(rdBack.xyz) * ${f2(OUTLINE_PUSH)};
      gl_Position = projectionMatrix * rdBack;
      vec2 rdDir = (projectionMatrix * vec4(rdNormal, 0.0)).xy;
      float rdLen = length(rdDir);
      if (rdLen > 1e-6) gl_Position.xy += rdDir / rdLen * uRdOutline * gl_Position.w;`);
  };
  material.customProgramCacheKey = () => `rdash-outline${tween ? 't' : ''}`;
  return material;
}

/** Cel shading state, read where figures and character models are built. */
export const cel = { enabled: false };

/** Content keys (contentkey.js) of models that are scenery or effects rather than characters. */
const scenery = new Set();

export function markScenery(key) {
  scenery.add(key);
}

/** Characters get cel shading and cast shadows; anything not marked as scenery is one. */
export function isCharacter(key) {
  return !scenery.has(key);
}

export function setLighting(on) {
  uniforms.uRdAmount.value = on ? 1 : 0;
}

export function setCelShading(on) {
  cel.enabled = !!on;
  uniforms.uRdCel.value = on ? 1 : 0;
}

/**
 * Call before rendering a batch.
 * @param {THREE.Matrix4} viewMatrix  the light is fixed in the world, the shader works in view space
 * @param {number} tween              0..1: how far figures are from their previous pose to the current
 * @param {number} width              viewport size in phone pixels (outline width)
 * @param {number} height
 */
export function updateDraw(viewMatrix, tween, width, height) {
  uniforms.uRdLight.value.copy(WORLD_LIGHT).transformDirection(viewMatrix);
  uniforms.uRdCelLight.value.set(0, 1, 0).transformDirection(viewMatrix).multiplyScalar(CEL_UP)
    .add(CEL_VIEW).normalize();
  uniforms.uRdTween.value = tween;
  uniforms.uRdOutline.value.set((2 * OUTLINE_WIDTH) / width, (2 * OUTLINE_WIDTH) / height);
}

/**
 * Normals for a geometry whose faces do not share vertices (the Legends 2 models). Corners at the
 * same position are treated as one vertex.
 *   shading: per corner, the sum of the faces at that vertex within CREASE_ANGLE of the corner's
 *            own face (hard edges stay hard)
 *   smooth:  per corner, the sum of all faces at that vertex (for the outline shell)
 * The winding of those models is not known in advance, so the normals are pointed outwards by
 * the sign of the mesh's volume.
 * @returns {{shading: THREE.BufferAttribute, smooth: THREE.BufferAttribute}}
 */
export function computeNormals(geometry) {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const corners = index ? index.count : pos.count;
  const at = (i) => (index ? index.getX(i) : i);
  const faces = Math.floor(corners / 3);
  const weighted = new Float32Array(faces * 3); // area-weighted face normals
  const unit = new Float32Array(faces * 3);
  const around = new Map(); // position key -> faces meeting there
  const keys = new Array(pos.count);
  const key = (i) => (keys[i] ??= `${Math.round(pos.getX(i) * 4096)},${Math.round(pos.getY(i) * 4096)},${Math.round(pos.getZ(i) * 4096)}`);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  geometry.computeBoundingBox();
  const centre = geometry.boundingBox.getCenter(new THREE.Vector3());
  let volume = 0; // six times the signed volume, measured from the centre
  for (let f = 0; f < faces; f++) {
    const ids = [at(f * 3), at(f * 3 + 1), at(f * 3 + 2)];
    a.fromBufferAttribute(pos, ids[0]);
    b.fromBufferAttribute(pos, ids[1]).sub(a);
    c.fromBufferAttribute(pos, ids[2]).sub(a);
    b.cross(c);
    volume += b.dot(c.copy(a).sub(centre));
    b.toArray(weighted, f * 3);
    b.normalize().toArray(unit, f * 3);
    for (const v of ids) {
      const list = around.get(key(v));
      if (list) list.push(f);
      else around.set(key(v), [f]);
    }
  }
  const sign = volume < 0 ? -1 : 1;
  const shading = new Float32Array(pos.count * 3);
  const smooth = new Float32Array(pos.count * 3);
  for (let f = 0; f < faces; f++) {
    for (let k = 0; k < 3; k++) {
      const v = at(f * 3 + k);
      a.set(0, 0, 0);
      b.set(0, 0, 0);
      for (const g of around.get(keys[v])) {
        c.fromArray(weighted, g * 3);
        a.add(c);
        const cos = unit[f * 3] * unit[g * 3] + unit[f * 3 + 1] * unit[g * 3 + 1] + unit[f * 3 + 2] * unit[g * 3 + 2];
        if (cos > CREASE_COS) b.add(c);
      }
      a.normalize().multiplyScalar(sign).toArray(smooth, v * 3);
      b.normalize().multiplyScalar(sign).toArray(shading, v * 3);
    }
  }
  return { shading: new THREE.BufferAttribute(shading, 3), smooth: new THREE.BufferAttribute(smooth, 3) };
}

/** Cosine of the crease angle, for figure.js (which computes its normals per frame). */
export const CREASE = CREASE_COS;

// ---- shadows -----------------------------------------------------------------------------------

const SHADOW_OPACITY = 0.45;
/** Height above the ground at which a shadow has faded to its minimum. */
const SHADOW_FADE_HEIGHT = 10;
const RAY_START = 1.5; // above the figure's origin, so feet slightly below the floor still hit
const RAY_LENGTH = 60;
const DOWN = new THREE.Vector3(0, -1, 0);

/** A black disc that fades out towards its rim, drawn on a unit quad. */
function discMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: SHADOW_OPACITY } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float d = length(vUv * 2.0 - 1.0);
        gl_FragColor = vec4(0.0, 0.0, 0.0, uOpacity * (1.0 - smoothstep(0.3, 1.0, d)));
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

export class Shadows {
  enabled = false;
  /** Diagnostics for the last batch that had figures in it. */
  stats = { casters: 0, ground: 0, shadows: 0 };
  #casters = [];
  #pool = [];
  #used = 0;
  #ray = new THREE.Raycaster();
  #geometry = new THREE.PlaneGeometry(2, 2);

  /**
   * A figure is being drawn at `matrix` (model -> world).
   * @param {{min: number[], max: number[]}} bounds  bind-pose bounds in world units
   */
  add(matrix, bounds) {
    if (!this.enabled) return;
    const e = matrix.elements;
    // the disc fades out towards its rim, so it is drawn wider than the figure
    const radius = Math.min(4, Math.max(0.5,
      0.85 * Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2])));
    // parts of one character (the player is several figures) share a position: one shadow
    const same = this.#casters.find((c) => Math.abs(c.x - e[12]) < 0.05 && Math.abs(c.y - e[13]) < 0.05
      && Math.abs(c.z - e[14]) < 0.05);
    if (same) same.radius = Math.max(same.radius, radius);
    else this.#casters.push({ x: e[12], y: e[13], z: e[14], radius });
  }

  /**
   * Turn the figures collected since the last call into shadow meshes.
   * @param {THREE.Object3D[]} queue  everything drawn in this batch; map meshes are the ground
   */
  finish(queue) {
    const casters = this.#casters;
    if (casters.length === 0) return [];
    const ground = queue.filter((m) => m.userData.ground);
    const out = [];
    if (ground.length) {
      const ray = this.#ray;
      const origin = new THREE.Vector3();
      const normal = new THREE.Vector3();
      const tangent = new THREE.Vector3();
      const bitangent = new THREE.Vector3();
      ray.far = RAY_LENGTH;
      for (const c of casters) {
        ray.set(origin.set(c.x, c.y + RAY_START, c.z), DOWN);
        const hit = ray.intersectObjects(ground, false)[0];
        if (!hit || !hit.face) continue;
        normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
        if (normal.y < 0) normal.negate();
        if (normal.y < 0.3) continue; // a wall, not a floor
        const height = Math.max(0, c.y - hit.point.y);
        const fade = Math.max(0.3, 1 - height / SHADOW_FADE_HEIGHT);
        const radius = c.radius * (1 + 0.03 * height);
        tangent.set(1, 0, 0).addScaledVector(normal, -normal.x).normalize();
        bitangent.crossVectors(normal, tangent);
        const mesh = this.#mesh(this.#used++);
        mesh.material.uniforms.uOpacity.value = SHADOW_OPACITY * fade;
        mesh.matrix.makeBasis(tangent.multiplyScalar(radius), bitangent.multiplyScalar(radius), normal);
        mesh.matrix.setPosition(hit.point.addScaledVector(normal, 0.03));
        mesh.matrixWorld.copy(mesh.matrix);
        out.push(mesh);
      }
    }
    this.stats = { casters: casters.length, ground: ground.length, shadows: out.length };
    casters.length = 0;
    return out;
  }

  /** The frame has been presented: the discs can be reused for the next one. */
  endFrame() {
    this.#used = 0;
  }

  #mesh(index) {
    let mesh = this.#pool[index];
    if (!mesh) {
      mesh = new THREE.Mesh(this.#geometry, discMaterial());
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      this.#pool[index] = mesh;
    }
    return mesh;
  }
}

export const shadows = new Shadows();
