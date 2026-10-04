// Sound: DoJa AudioPresenter on Web Audio. The game's sounds are MFi (.mld) files; they are parsed
// by ../formats/mfi.js and played by the software synthesiser in ./audio/synth.js, which runs in
// an AudioWorklet (or, where that is unavailable, in a ScriptProcessorNode on the main thread).
//
// How the game drives this (decompiled sound manager, class `m`):
//   - four presenters (ports 0..3); per sound: setSound(), setAttribute(SET_VOLUME = 4, 0..100),
//     play(); stop() to cut a sound or free a port. No other attribute is ever set.
//   - it listens for AUDIO_COMPLETE (3): a sound it flagged as looping is started again, any other
//     releases its port. Without that event ports are never freed, so it must always arrive.
//     (AUDIO_PAUSED (5) is handled too, but only a phone call would cause it.)
//   - the sounds it flags as looping are exactly the files that contain a "repeat forever" loop
//     point (all BGM, se01/04/06/09/11/16). Those are looped here inside the synthesiser,
//     seamlessly, as the file says — so they never complete and the game's restart path stays
//     idle; it stops them itself. `new Audio({ fileLoops: false })` plays them through to the end
//     of the track instead and lets the game restart them on AUDIO_COMPLETE.
//
// Only AUDIO_COMPLETE is delivered; PLAYING / STOPPED / LOOPED are not (the game ignores them).
// Events are delivered from a message / timer callback, never from inside play() or stop().
//
// Browsers keep audio locked until a user gesture: the AudioContext is created on the first
// keydown / pointerdown (or lazily by play() once the page has been interacted with). Until then
// sounds are "played" silently — finite ones still complete on time, looping ones start for real
// as soon as audio unlocks.

import { parseMFi } from '../formats/mfi.js';
import { compileMFi, MfiMixer, WORKLET_NAME } from './audio/synth.js';

const AUDIO_COMPLETE = 3;
const ATTR_SET_VOLUME = 4;
/** An effect requested while audio was still starting up is played late rather than dropped. */
const LATE_START_MS = 250;
/** Sounds longer than this (or looping) count as music for the volume sliders. */
const MUSIC_SECONDS = 6;

/** SET_VOLUME percent -> gain. GM-style square law (assumption; the phone's table is unknown). */
const volumeGain = (percent) => {
  const v = Math.min(100, Math.max(0, percent)) / 100;
  return v * v;
};

function hashBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return `${bytes.length}:${(h >>> 0).toString(16)}`;
}

export class Audio {
  /** Set by the game (rdash.Host): (port, event, param) => void */
  handler = null;
  ports = new Map();

  #options;
  #sounds = new Map(); // content hash -> sound
  #ctx = null;
  #engine = null; // { kind, post(msg), loaded:Set }
  #engineStarting = false;
  #generation = 0;
  #master = 1;
  #muted = false;
  #musicVolume = 1;
  #effectsVolume = 1;
  #soundfont = null; // sampled instrument set, once fetched: { programs, drums, samples, pcm }
  #sampled = true;
  #peak = 0;
  #counters = { played: 0, audible: 0, completed: 0, stopped: 0 };

  /**
   * @param {{ports?: number, fileLoops?: boolean, engine?: 'worklet'|'script'}} [options]
   *   fileLoops (default true): honour the "repeat forever" loop points inside the files.
   *   engine: 'script' forces the main-thread ScriptProcessor fallback.
   * For testing, the page URL can override both: ?audio=script,gameloops
   */
  constructor(options = {}) {
    this.#options = { ports: 4, fileLoops: true, engine: 'worklet', ...options };
    if (typeof window !== 'undefined') {
      const flags = (new URLSearchParams(window.location.search).get('audio') ?? '').split(',');
      if (flags.includes('script')) this.#options.engine = 'script';
      if (flags.includes('gameloops')) this.#options.fileLoops = false;
      const unlock = () => this.#ensureContext(true);
      for (const type of ['keydown', 'pointerdown', 'mousedown', 'touchend']) {
        window.addEventListener(type, unlock, { capture: true, passive: true });
      }
    }
  }

  // ---- DoJa side (called through rdash.Host) ---------------------------------------------------

  /** MediaSound.use(): parse once per distinct file content; cheap enough for a loading screen. */
  createSound(data, len) {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, Math.min(len ?? data.byteLength, data.byteLength))
      : Uint8Array.from(data).subarray(0, len);
    const key = hashBytes(bytes);
    let sound = this.#sounds.get(key);
    if (!sound) {
      sound = { key, title: null, duration: 0, loops: false, song: null, error: null };
      try {
        const mfi = parseMFi(bytes);
        sound.song = compileMFi(mfi);
        sound.title = mfi.header.title;
        sound.duration = mfi.duration;
        sound.loops = sound.song.loops;
        for (const w of mfi.warnings) console.warn(`[audio] ${sound.title ?? key}: ${w}`);
      } catch (e) {
        // an unplayable sound must not take the game down: it plays as silence
        sound.error = e;
        console.warn(`[audio] cannot decode sound (${len} bytes): ${e.message}`);
      }
      this.#sounds.set(key, sound);
    }
    return sound;
  }

  setSound(port, sound) {
    this.#port(port).sound = sound ?? null;
  }

  play(port) {
    const p = this.#port(port);
    const wasInEngine = p.inEngine;
    this.#cancel(p);
    p.gen = ++this.#generation;
    const sound = p.sound;
    if (sound) {
      p.playing = true;
      p.startedAt = performance.now();
      this.#counters.played++;
      this.#ensureContext(false);
      if (this.#running() && sound.song) {
        this.#startInEngine(port, p); // replaces whatever the port was playing
        return;
      }
      if (!sound.song || !this.#loops(sound)) {
        // silent stand-in: the sound still ends when it should
        const gen = p.gen;
        p.timer = setTimeout(() => this.#complete(port, gen), Math.max(0, sound.duration * 1000));
      }
      // else: a looping sound waits for the audio to unlock (see #resumePending)
    }
    if (wasInEngine && this.#engine) this.#engine.post({ type: 'stop', port, gen: p.gen });
  }

  stop(port) {
    const p = this.#port(port);
    const wasInEngine = p.inEngine;
    if (p.playing) this.#counters.stopped++;
    this.#cancel(p);
    p.gen = ++this.#generation; // drop any completion that is already on its way
    if (wasInEngine && this.#engine) this.#engine.post({ type: 'stop', port, gen: p.gen });
  }

  setAttribute(port, attr, value) {
    const p = this.#port(port);
    p.attrs[attr] = value;
    if (attr === ATTR_SET_VOLUME) {
      p.volume = Math.min(100, Math.max(0, value));
      if (p.inEngine && this.#engine) this.#engine.post({ type: 'volume', port, value: this.#portGain(p) });
    }
    // PRIORITY, SYNC_MODE, TRANSPOSE_KEY, CHANGE_TEMPO, LOOP_COUNT: stored, not implemented
    // (this game never sets them).
  }

  // ---- page side -------------------------------------------------------------------------------

  setMuted(muted) {
    this.#muted = !!muted;
    this.#postMaster();
  }

  get muted() {
    return this.#muted;
  }

  /** @param {number} volume 0..1 (slider position; applied as a square law) */
  setMasterVolume(volume) {
    this.#master = Math.min(1, Math.max(0, Number(volume) || 0));
    this.#postMaster();
  }

  get masterVolume() {
    return this.#master;
  }

  /**
   * Separate levels for music and sound effects (slider positions 0..1, applied as a square
   * law). Music is anything that loops or runs longer than MUSIC_SECONDS; the rest are effects.
   */
  setCategoryVolumes(music, effects) {
    const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
    this.#musicVolume = clamp(music);
    this.#effectsVolume = clamp(effects);
    if (!this.#engine) return;
    for (const [port, p] of this.ports) {
      if (p.inEngine) this.#engine.post({ type: 'volume', port, value: this.#portGain(p) });
    }
  }

  /** Gain of a port: the game's own volume times the user's level for that kind of sound. */
  #portGain(p) {
    const s = p.sound;
    const music = !!s && (s.loops || s.duration > MUSIC_SECONDS);
    const user = music ? this.#musicVolume : this.#effectsVolume;
    return volumeGain(p.volume) * user * user;
  }

  /**
   * Fetch the sampled instrument set (gm.json + gm.bin, made by tools/soundfont/extract.mjs) if
   * it has been generated. Music then plays with it instead of the FM patches.
   * @param {string} base  URL of the folder
   * @returns {Promise<boolean>} whether a set was found
   */
  async loadSoundfont(base) {
    try {
      const [json, bin] = await Promise.all([fetch(`${base}/gm.json`), fetch(`${base}/gm.bin`)]);
      if (!json.ok || !bin.ok) return false;
      const set = await json.json();
      const pcm = new Int16Array(await bin.arrayBuffer());
      this.#soundfont = { programs: set.programs, drums: set.drums, samples: set.samples, pcm };
    } catch {
      return false;
    }
    this.#postSoundfont();
    return true;
  }

  get hasSoundfont() {
    return !!this.#soundfont;
  }

  /** Play music with the sampled instruments (when loaded) or with the FM patches. */
  setSampled(on) {
    this.#sampled = !!on;
    this.#engine?.post({ type: 'options', sampled: this.#sampled });
  }

  #postSoundfont() {
    if (!this.#engine) return;
    this.#engine.post({ type: 'options', sampled: this.#sampled });
    if (this.#soundfont) this.#engine.post({ type: 'soundfont', ...this.#soundfont });
  }

  /**
   * Try to start audio now (call from a click handler of the page, e.g. an "enable sound" button).
   * `force` skips the "has the user interacted with the page" check: for the Android app, where
   * playback needs no gesture and a controller's buttons never count as one.
   */
  unlock(force = false) {
    this.#ensureContext(true, force);
  }

  /** State for the page UI / tests. `peak` is the output peak since the previous call. */
  info() {
    if (this.#engine?.kind === 'script') this.#peak = Math.max(this.#peak, this.#engine.mixer.takePeak());
    const peak = this.#peak;
    this.#peak = 0;
    return {
      context: this.#ctx?.state ?? 'none',
      engine: this.#engine?.kind ?? 'none',
      sampleRate: this.#ctx?.sampleRate ?? 0,
      muted: this.#muted,
      masterVolume: this.#master,
      instruments: this.#soundfont && this.#sampled ? 'sampled' : 'fm',
      peak,
      sounds: this.#sounds.size,
      counters: { ...this.#counters },
      ports: [...this.ports.entries()].map(([port, p]) => ({
        port, playing: p.playing, audible: p.inEngine, volume: p.volume,
        sound: p.sound ? p.sound.title ?? p.sound.key : null, loops: p.sound ? this.#loops(p.sound) : false,
      })),
    };
  }

  // ---- internals -------------------------------------------------------------------------------

  #port(port) {
    let p = this.ports.get(port);
    if (!p) {
      p = { sound: null, attrs: {}, volume: 100, gen: 0, playing: false, inEngine: false, timer: 0, startedAt: 0 };
      this.ports.set(port, p);
    }
    return p;
  }

  #loops(sound) {
    return this.#options.fileLoops && sound.loops;
  }

  #cancel(p) {
    if (p.timer) clearTimeout(p.timer);
    p.timer = 0;
    p.playing = false;
    p.inEngine = false;
  }

  #running() {
    return !!this.#engine && this.#ctx?.state === 'running';
  }

  #startInEngine(port, p) {
    const engine = this.#engine, sound = p.sound;
    if (!engine.loaded.has(sound.key)) {
      engine.post({ type: 'load', key: sound.key, song: sound.song });
      engine.loaded.add(sound.key);
    }
    engine.post({ type: 'play', port, key: sound.key, gen: p.gen, volume: this.#portGain(p) });
    p.inEngine = true;
    this.#counters.audible++;
  }

  #complete(port, gen) {
    const p = this.ports.get(port);
    if (!p || p.gen !== gen || !p.playing) return; // stopped or restarted in the meantime
    p.timer = 0;
    p.playing = false;
    p.inEngine = false;
    this.#counters.completed++;
    this.#deliver(port, AUDIO_COMPLETE, 0);
  }

  #deliver(port, event, param) {
    if (!this.handler) return;
    try {
      this.handler(port, event, param);
    } catch (e) {
      console.error('[audio] media listener failed', e);
    }
  }

  #postMaster() {
    if (!this.#engine) return;
    this.#engine.post({ type: 'master', value: this.#muted ? 0 : this.#master * this.#master });
  }

  #ensureContext(fromGesture, force = false) {
    if (typeof window === 'undefined') return;
    if (!this.#ctx) {
      // creating a context before the page has been activated only earns a console warning
      // (not every key counts: a lone modifier key does not activate the page)
      const activation = navigator.userActivation;
      if (!force && (activation ? !activation.hasBeenActive : !fromGesture)) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.#ctx = new AC({ latencyHint: 'interactive' });
      } catch (e) {
        console.warn(`[audio] no AudioContext: ${e.message}`);
        return;
      }
      this.#ctx.addEventListener('statechange', () => this.#resumePending());
    }
    if (this.#ctx.state !== 'running' && this.#ctx.state !== 'closed') this.#ctx.resume().catch(() => {});
    if (!this.#engine && !this.#engineStarting) this.#startEngine();
  }

  async #startEngine() {
    const ctx = this.#ctx;
    const { ports, fileLoops, engine: wanted } = this.#options;
    this.#engineStarting = true;
    let engine;
    try {
      if (wanted === 'script') throw new Error('requested');
      if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') throw new Error('AudioWorklet is not available');
      // the synthesiser module has no imports, so it can be loaded as a worklet module as it is
      const module = new URL('./audio/synth.js', import.meta.url).href;
      await ctx.audioWorklet.addModule(globalThis.rdashResolve?.(module, true) ?? module);
      const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { ports, fileLoops },
      });
      node.port.onmessage = (e) => this.#onEngineMessage(e.data);
      node.onprocessorerror = (e) => console.error('[audio] synthesiser crashed', e);
      node.connect(ctx.destination);
      engine = { kind: 'worklet', node, loaded: new Set(), post: (msg) => node.port.postMessage(msg) };
      engine.post({ type: 'meter', enable: true });
    } catch (err) {
      if (wanted !== 'script') console.warn(`[audio] mixing on the main thread (${err.message})`);
      try {
        const mixer = new MfiMixer(ctx.sampleRate, ports, { fileLoops });
        const node = ctx.createScriptProcessor(2048, 0, 2);
        node.onaudioprocess = (e) => {
          const out = e.outputBuffer;
          const events = mixer.render(out.getChannelData(0), out.getChannelData(1), out.length);
          if (events.length) setTimeout(() => this.#onEngineMessage({ type: 'events', events }), 0);
        };
        node.connect(ctx.destination);
        engine = { kind: 'script', node, mixer, loaded: new Set(), post: (msg) => mixer.handle(msg) };
      } catch (e) {
        console.warn(`[audio] no audio output: ${e.message}`);
        return; // #engineStarting stays set: do not try again, sounds keep "playing" silently
      }
    }
    this.#engine = engine;
    this.#engineStarting = false;
    this.#postSoundfont();
    this.#postMaster();
    this.#resumePending();
  }

  /**
   * Audio has become available: start the looping sounds that were requested while it was not,
   * and any effect requested a moment ago (typically by the very key press that unlocked audio).
   */
  #resumePending() {
    if (!this.#running()) return;
    const now = performance.now();
    for (const [port, p] of this.ports) {
      if (!p.playing || p.inEngine || !p.sound?.song) continue;
      if (p.timer) {
        if (now - p.startedAt > LATE_START_MS) continue; // too late: let it finish silently
        clearTimeout(p.timer);
        p.timer = 0;
      }
      this.#startInEngine(port, p);
    }
  }

  #onEngineMessage(msg) {
    if (msg.type === 'events') {
      for (const e of msg.events) if (e.type === 'complete') this.#complete(e.port, e.gen);
    } else if (msg.type === 'meter') {
      if (msg.peak > this.#peak) this.#peak = msg.peak;
    }
  }
}
