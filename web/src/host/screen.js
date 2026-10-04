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

/** The phone's display, and the coordinate space of everything the game draws. */
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
    this.frames = 0; // presented frames, for measuring the game's frame rate
    // Widescreen: the canvas is `viewWidth` logical pixels wide (>= 240). The game's 240-wide
    // coordinate space sits centred in it at x offset `xoff`; full-screen 3D fills the width.
    this.viewWidth = WIDTH;
    this.xoff = 0;
    this.wide3D = false; // a full-width 3D batch was drawn since the last present

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
    this.setLayout(1, 1);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
  }

  /** Display width / height. */
  get aspect() {
    return this.viewWidth / HEIGHT;
  }

  /**
   * @param {number} scale   canvas pixels per phone pixel (integer); 1 = the phone's native size
   * @param {number} aspect  display aspect ratio, >= 1 (1 = the phone's square screen)
   */
  setLayout(scale, aspect = 1) {
    scale = Math.max(1, Math.floor(scale));
    const viewWidth = Math.max(WIDTH, Math.round((HEIGHT * aspect) / 2) * 2);
    if (scale === this.scale && viewWidth === this.viewWidth) return;
    this.scale = scale;
    this.viewWidth = viewWidth;
    this.xoff = (viewWidth - WIDTH) / 2;
    this.renderer.setSize(viewWidth * scale, HEIGHT * scale, false);
    this.layer.width = viewWidth * scale;
    this.layer.height = HEIGHT * scale;
    this.layerTexture.dispose();
    this.graphics.bind(this.layer.getContext('2d'), scale, this.xoff);
    this.dirty2D = false;
    this.renderer.setScissorTest(false);
    this.renderer.clear();
  }

  setScale(scale) {
    this.setLayout(scale, this.aspect);
  }

  /** Scale used for new off-screen images, so text drawn into them stays sharp. */
  createImage(w, h) {
    const k = this.scale;
    return new Img(makeCanvas(Math.max(1, w * k), Math.max(1, h * k)), w, h, k);
  }

  /**
   * Composite the pending 2D layer onto the frame and clear it.
   * @param {boolean} stretch  widescreen only: stretch the game's 240-wide picture across the
   *                           whole width (used for the backdrop behind full-width 3D, e.g. the
   *                           sky) instead of drawing it centred
   */
  flush2D(stretch = false) {
    if (!this.dirty2D) return;
    this.dirty2D = false;
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.viewWidth * this.scale, HEIGHT * this.scale);
    const t = this.layerTexture;
    if (stretch && this.xoff > 0) {
      t.repeat.set(WIDTH / this.viewWidth, 1);
      t.offset.set(this.xoff / this.viewWidth, 0);
    } else {
      t.repeat.set(1, 1);
      t.offset.set(0, 0);
    }
    t.needsUpdate = true;
    r.render(this.quadScene, this.quadCamera);
    this.graphics.clearSurface();
  }

  present() {
    this.g3d.flush();
    if (this.xoff > 0 && !this.wide3D) {
      // a 2D-only frame (menus, title): keep the side bars black
      const r = this.renderer;
      const k = this.scale;
      r.setScissorTest(true);
      r.setClearColor(0x000000, 1);
      r.setScissor(0, 0, this.xoff * k, HEIGHT * k);
      r.clearColor();
      r.setScissor((this.xoff + WIDTH) * k, 0, this.xoff * k, HEIGHT * k);
      r.clearColor();
      r.setScissorTest(false);
    }
    this.wide3D = false;
    this.flush2D();
    this.frames++;
  }
}
