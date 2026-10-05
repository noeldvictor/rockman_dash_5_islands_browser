// The "3D sky" option: an area's sky as a dome around the camera.
//
// The game's sky is a flat picture, 480 pixels wide (two 240x240 images side by side), that
// it scrolls sideways with the player's heading and draws behind the 3D world. It was made for
// a camera that never tilts and a square screen: stretched across a wide picture it distorts,
// it does not follow the free-look camera up or down, and below the horizon it is still sky,
// which is what shows wherever the camera can see past the edge of a map.
//
// Here the same picture is wrapped around the camera instead, at the scale the game shows it
// (240 pixels across its 60 degree view, so the panorama fits three times round), with its top
// edge where the top of the phone's screen was (23 degrees up: the game's camera looks 7 down).
// Above that the sky runs on in the picture's top colour, darkening towards the zenith; a few
// degrees below the horizon the picture's haze gives way to sea, as around an island.
//
// Mods.sky (Java) hands the two images over each frame (Host.skyDome); G3D draws the dome
// first in the batch that follows, with the batch's camera turned but not moved.

import * as THREE from 'three';
import { crc32 } from './contentkey.js';

const TOP = (23 * Math.PI) / 180; // elevation of the picture's top row
const SPAN = (60 * Math.PI) / 180; // elevation the picture's height covers
const AROUND = 3; // times the panorama fits round the full circle

const VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  // the camera's turn without its position: the dome is always centred on the viewer
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
}`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D map;
uniform vec3 topColor;
uniform vec3 hazeColor;
varying vec3 vDir;
const float PI = 3.141592653589793;
void main() {
  vec3 d = normalize(vDir);
  float around = atan(d.z, d.x);
  float up = asin(clamp(d.y, -1.0, 1.0));
  float v = (${TOP.toFixed(6)} - up) / ${SPAN.toFixed(6)};
  // sample at a fixed level of detail: the wrap of atan() behind the viewer would otherwise
  // pick the smallest mip level along one line
  vec3 color = texture2D(map, vec2(around * ${(AROUND / (2 * Math.PI)).toFixed(6)}, clamp(v, 0.004, 0.996))).rgb;
  // the picture's top edge cuts through its clouds: let them fade into the open sky above
  color = mix(topColor, color, smoothstep(0.0, 0.16, v));
  // higher still, towards the zenith
  color = mix(color, topColor * vec3(0.62, 0.74, 0.92), smoothstep(${TOP.toFixed(6)}, 1.45, up));
  // below the horizon: haze, then the sea, darker straight down
  vec3 sea = mix(hazeColor * vec3(0.30, 0.52, 0.78), hazeColor * vec3(0.16, 0.30, 0.52), smoothstep(-0.12, -1.3, up));
  color = mix(color, sea, smoothstep(-0.035, -0.11, up));
  gl_FragColor = vec4(color, 1.0);
}`;

/** Average colour of one row of a canvas, as [r, g, b] in 0..1. */
function rowColor(ctx, y, width) {
  const data = ctx.getImageData(0, y, width, 1).data;
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += data[i + c];
  return sum.map((v) => v / (width * 255));
}

export class SkyDome {
  #cache = new WeakMap(); // left picture -> { texture, top, haze }

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { map: { value: null }, topColor: { value: new THREE.Color() }, hazeColor: { value: new THREE.Color() } },
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    /** An HD picture for a panorama, if there is one: (key) => Promise<ImageBitmap|null>. */
    this.lookup = null;
  }

  /**
   * The sky for a pair of the game's pictures (host Img objects, the left and right halves).
   * @returns {object} an opaque sky to pass to draw()
   */
  get(left, right) {
    let sky = this.#cache.get(left);
    if (!sky) {
      const w = left.canvas.width;
      const h = left.canvas.height;
      const canvas = new OffscreenCanvas(w * 2, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(left.canvas, 0, 0);
      ctx.drawImage(right.canvas, w, 0);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.NoColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearFilter; // no mip levels: see the note in the shader
      texture.generateMipmaps = false;
      texture.flipY = false; // row 0 is the top of the picture; v grows downwards in the shader
      sky = { texture, top: rowColor(ctx, 0, w * 2), haze: rowColor(ctx, h - 1, w * 2) };
      this.#cache.set(left, sky);
      // an HD version of the same picture, if one has been made (tools/ai/skies.py)
      const key = skyKey(ctx.getImageData(0, 0, w * 2, h).data, w * 2, h);
      this.lookup?.(key).then((bitmap) => {
        if (!bitmap) return;
        const hd = new THREE.Texture(bitmap);
        hd.colorSpace = THREE.NoColorSpace;
        hd.wrapS = THREE.RepeatWrapping;
        hd.wrapT = THREE.ClampToEdgeWrapping;
        hd.magFilter = THREE.LinearFilter;
        hd.minFilter = THREE.LinearFilter;
        hd.generateMipmaps = false;
        hd.flipY = false;
        hd.needsUpdate = true;
        sky.texture.dispose();
        sky.texture = hd;
      }).catch(() => {});
    }
    return sky;
  }

  /** Draw `sky` with `camera`'s projection and orientation into the current viewport. */
  draw(renderer, camera, sky) {
    const u = this.material.uniforms;
    u.map.value = sky.texture;
    u.topColor.value.setRGB(...sky.top);
    u.hazeColor.value.setRGB(...sky.haze);
    renderer.render(this.scene, camera);
  }
}

/** "<width>x<height>:<crc32 of the RGB pixels>", as tools/ai/skies.py names its pictures. */
export function skyKey(rgba, width, height) {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, n = width * height; i < n; i++) {
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return `${width}x${height}:${crc32(rgb)}`;
}
