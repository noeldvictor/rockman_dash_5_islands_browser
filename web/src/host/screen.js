// The phone display: one WebGL canvas (three.js) onto which the game's 2D drawing and 3D rendering
// are composited in the order the game issued them.
//
// A game frame is recorded as a list of steps and then replayed onto the canvas. 2D calls draw
// into an off-screen Canvas2D "layer"; whenever 3D geometry is flushed, the layer accumulated so
// far becomes a step (drawn as a full-screen quad) and a fresh layer is started; the 3D batch is
// the next step, rendered with its own depth buffer; later 2D (HUD) lands in the fresh layer and
// becomes the last step when the frame is presented. The WebGL back buffer is preserved between
// frames, like the phone's.
//
// Widescreen leaves bars either side of pictures that are not full-width 3D (title, menus, the
// map screen). They are filled with an enlarged, blurred, dimmed copy of the picture itself
// (option "sideFill"), or left black.
//
// Normally a frame is replayed once, when the game presents it. With "smooth motion" on, frames
// with full-screen 3D are instead replayed on every display frame with the camera and every
// object moved part of the way from where the previous game frame had them (the game logic runs
// at 15 fps), so the picture trails the game by one game frame.

import * as THREE from 'three';
import { G2D, Img, makeCanvas } from './g2d.js';
import { G3D } from './g3d.js';

/** The phone's display, and the coordinate space of everything the game draws. */
export const WIDTH = 240;
export const HEIGHT = 240;

/** Side bar fill: size of the blurred copy, its blur radius, and how much it is dimmed. */
const FILL_SIZE = 96;
const FILL_BLUR = 5;
const FILL_DIM = 0.55;

/** Longest game frame interval interpolated over; slower than this is a pause, not motion. */
const MAX_INTERVAL = 150;

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
    this.wide3D = false; // a full-width 3D batch was recorded in the current frame
    /**
     * Pictures per second (Settings > Video): 15 = one per game frame; 30, 60 or 0 (every
     * display frame) interpolate between game frames.
     */
    this.frameRate = 15;
    this.lastReplay = 0;
    /** Diagnostics: pictures drawn, and how many of them were in-between ones. */
    this.stats = { replays: 0, interpolated: 0 };

    this.layers = []; // spare 2D layers: { canvas, texture }
    this.layer = null; // the one being drawn into
    this.steps = []; // the frame being recorded
    this.shown = null; // the last presented frame: { steps, wide, interpolate, time }
    this.interval = 1000 / 15; // measured time between game frames
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.quadMaterial));

    /** Fill the widescreen side bars of 2D screens with a blurred copy of the picture. */
    this.sideFill = true;
    this.fillCanvas = makeCanvas(FILL_SIZE, FILL_SIZE);
    this.fillTexture = new THREE.CanvasTexture(this.fillCanvas);
    this.fillTexture.colorSpace = THREE.NoColorSpace;
    this.fillScene = new THREE.Scene();
    const fillMaterial = new THREE.MeshBasicMaterial({ map: this.fillTexture, depthTest: false, depthWrite: false });
    fillMaterial.color.setScalar(FILL_DIM); // colours pass through as they are: no sRGB conversion
    this.fillScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fillMaterial));

    this.g3d = new G3D(this);
    this.graphics = new G2D(makeCanvas(1, 1).getContext('2d'), 1, this);
    this.setLayout(1, 1);
    this.quadMaterial.map = this.layer.texture; // so the material is compiled with a map
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    const tick = () => {
      this.#display();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
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
    // every layer has the old size: drop them, and with them whatever was recorded
    for (const step of [...this.steps, ...(this.shown?.steps ?? [])]) step.layer?.texture.dispose();
    for (const layer of this.layers) layer.texture.dispose();
    this.layer?.texture.dispose();
    this.layers = [];
    this.steps = [];
    this.shown = null;
    this.layer = this.#takeLayer();
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

  /** A cleared 2D layer, with the game's Graphics bound to it. */
  #takeLayer() {
    let layer = this.layers.pop();
    if (layer) {
      layer.canvas.width = layer.canvas.width; // clears the canvas and resets its context state
    } else {
      const canvas = makeCanvas(this.viewWidth * this.scale, HEIGHT * this.scale);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.NoColorSpace;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      layer = { canvas, texture };
    }
    this.graphics.bind(layer.canvas.getContext('2d'), this.scale, this.xoff);
    return layer;
  }

  /**
   * The game is about to draw its mission HUD. In widescreen, over full-width 3D, the side
   * gauges are moved out to the screen edges (see Mods.hud).
   * @returns {number} how far they move, in phone pixels (0 = stay put)
   */
  hudBegin() {
    if (this.xoff === 0 || !this.wide3D) return 0;
    this.graphics.setWide(true);
    return this.xoff;
  }

  /**
   * End the pending 2D layer: it becomes a step of the frame and a fresh one is started.
   * @param {boolean} stretch  widescreen only: stretch the game's 240-wide picture across the
   *                           whole width (used for the backdrop behind full-width 3D, e.g. the
   *                           sky) instead of drawing it centred
   */
  flush2D(stretch = false) {
    if (!this.dirty2D) return;
    this.dirty2D = false;
    this.layer.texture.needsUpdate = true;
    this.steps.push({ layer: this.layer, stretch: stretch && this.xoff > 0 });
    this.layer = this.#takeLayer();
  }

  /** Called by G3D.flush(): a batch of 3D objects is the next step of the frame. */
  record3D(step) {
    this.steps.push(step);
  }

  present() {
    this.g3d.flush();
    this.flush2D();
    const now = performance.now();
    const previous = this.shown;
    const frame = { steps: this.steps, wide: this.wide3D, interpolate: false, time: now };
    this.steps = [];
    this.wide3D = false;
    this.g3d.endFrame();
    this.frames++;
    if (previous) {
      const dt = now - previous.time;
      if (dt < MAX_INTERVAL) this.interval += (dt - this.interval) * 0.2;
      // interpolate only between two consecutive frames whose 3D belongs together
      frame.interpolate = this.frameRate !== 15 && dt < MAX_INTERVAL
        && this.g3d.link(previous.steps, frame.steps);
      for (const step of previous.steps) if (step.layer) this.layers.push(step.layer);
    }
    this.shown = frame;
    if (!frame.interpolate) this.#replay(frame, 1);
  }

  /** Display-rate loop: shows the in-between pictures while a frame is being interpolated. */
  #display() {
    const frame = this.shown;
    if (!frame || !frame.interpolate) return;
    const now = performance.now();
    const t = (now - frame.time) / this.interval;
    // a frame rate below the display's: skip display frames (2 ms slack for timer jitter)
    if (t < 1 && this.frameRate > 0 && now - this.lastReplay < 1000 / this.frameRate - 2) return;
    this.#replay(frame, Math.min(1, Math.max(0, t)));
    this.stats.interpolated++;
    if (t >= 1) frame.interpolate = false;
  }

  /** Draw a recorded frame; `t` (0..1) is how far its 3D has moved on from the previous frame. */
  #replay(frame, t) {
    const r = this.renderer;
    const k = this.scale;
    this.stats.replays++;
    this.lastReplay = performance.now();
    const bars = this.xoff > 0 && !frame.wide; // no full-width 3D (menus, title): bars at the sides
    if (bars && !this.sideFill) {
      r.setScissorTest(true);
      r.setClearColor(0x000000, 1);
      r.setScissor(0, 0, this.xoff * k, HEIGHT * k);
      r.clearColor();
      r.setScissor((this.xoff + WIDTH) * k, 0, this.xoff * k, HEIGHT * k);
      r.clearColor();
    }
    for (const step of frame.steps) {
      if (!step.layer) {
        this.g3d.draw(step, t);
        continue;
      }
      r.setScissorTest(false);
      r.setViewport(0, 0, this.viewWidth * k, HEIGHT * k);
      const texture = step.layer.texture;
      if (step.stretch) {
        texture.repeat.set(WIDTH / this.viewWidth, 1);
        texture.offset.set(this.xoff / this.viewWidth, 0);
      } else {
        texture.repeat.set(1, 1);
        texture.offset.set(0, 0);
      }
      this.quadMaterial.map = texture;
      r.render(this.quadScene, this.quadCamera);
    }
    if (bars && this.sideFill) this.#fillSideBars();
    r.setScissorTest(false);
  }

  /** Draw an enlarged, blurred, dimmed copy of the 240-wide picture into the bars beside it. */
  #fillSideBars() {
    const r = this.renderer;
    const k = this.scale;
    const ctx = this.fillCanvas.getContext('2d');
    ctx.filter = `blur(${FILL_BLUR}px)`;
    // drawn a little oversize, so the blur does not fade out towards the edges
    const pad = FILL_BLUR * 2;
    ctx.drawImage(this.canvas, this.xoff * k, 0, WIDTH * k, HEIGHT * k, -pad, -pad, FILL_SIZE + 2 * pad, FILL_SIZE + 2 * pad);
    const t = this.fillTexture;
    // "cover": the square picture is as wide as the whole view, so only a middle band shows
    t.repeat.set(1, HEIGHT / this.viewWidth);
    t.offset.set(0, (1 - HEIGHT / this.viewWidth) / 2);
    t.needsUpdate = true;
    r.setViewport(0, 0, this.viewWidth * k, HEIGHT * k);
    r.setScissorTest(true);
    for (const x of [0, this.xoff + WIDTH]) {
      r.setScissor(x * k, 0, this.xoff * k, HEIGHT * k);
      r.render(this.fillScene, this.quadCamera);
    }
  }
}
