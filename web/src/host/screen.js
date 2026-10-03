// The phone display: one WebGL canvas (three.js) onto which the game's 2D drawing and 3D rendering
// are composited in the order the game issued them.
//
// 2D calls draw into an off-screen Canvas2D "layer". Whenever 3D geometry is flushed, the layer
// accumulated so far is uploaded and drawn as a full-screen quad first, then cleared; the 3D batch
// is rendered on top with its own depth buffer; later 2D (HUD) lands in the fresh layer and is
// composited when the frame is presented. The WebGL back buffer is preserved between frames, like
// the phone's.

import * as THREE from 'three';
import { G2D, Img, makeCanvas } from './g2d.js';
import { G3D } from './g3d.js';

export const WIDTH = 240;
export const HEIGHT = 240;

export class Screen {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.autoClear = false;
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // colours are passed through as-is
    this.lockCount = 0;
    this.dirty2D = false;
    this.scale = 0;

    this.layer = makeCanvas(WIDTH, HEIGHT);
    this.layerTexture = new THREE.CanvasTexture(this.layer);
    this.layerTexture.colorSpace = THREE.NoColorSpace;
    this.layerTexture.generateMipmaps = false;
    this.layerTexture.minFilter = THREE.NearestFilter;
    this.layerTexture.magFilter = THREE.NearestFilter;
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadScene.add(new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({
        map: this.layerTexture, transparent: true, depthTest: false, depthWrite: false,
      }),
    ));

    this.g3d = new G3D(this);
    this.graphics = new G2D(this.layer.getContext('2d'), 1, this);
    this.setScale(1);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
  }

  /** Canvas pixels per phone pixel (integer). 1 = the phone's native 240x240. */
  setScale(scale) {
    scale = Math.max(1, Math.floor(scale));
    if (scale === this.scale) return;
    this.scale = scale;
    this.renderer.setSize(WIDTH * scale, HEIGHT * scale, false);
    this.layer.width = WIDTH * scale;
    this.layer.height = HEIGHT * scale;
    this.layerTexture.dispose();
    this.graphics.bind(this.layer.getContext('2d'), scale);
    this.dirty2D = false;
  }

  /** Scale used for new off-screen images, so text drawn into them stays sharp. */
  createImage(w, h) {
    const k = this.scale;
    return new Img(makeCanvas(Math.max(1, w * k), Math.max(1, h * k)), w, h, k);
  }

  /** Composite the pending 2D layer onto the frame and clear it. */
  flush2D() {
    if (!this.dirty2D) return;
    this.dirty2D = false;
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, WIDTH * this.scale, HEIGHT * this.scale);
    this.layerTexture.needsUpdate = true;
    r.render(this.quadScene, this.quadCamera);
    this.graphics.clearSurface();
  }

  present() {
    this.g3d.flush();
    this.flush2D();
  }
}
