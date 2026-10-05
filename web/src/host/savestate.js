// Save states: an exact copy of the running game, taken and put back between two frames.
//
// The game is not emulated, so there is no machine memory to dump. Its state is the recompiled
// module's object graph: instances of the game's classes and of the Java library, arrays, and
// the static fields. Mods.saveStates (Java) calls in here from the single place the game
// presents a frame, where the game thread is always at the same point of the same loop; it
// hands over the static values and the root object (StateRoots.capture), since statics are
// module-level variables that cannot be reached from outside.
//
// save() walks everything reachable from those roots and remembers, for every object, the value
// of each of its fields: numbers as they are, references as references, array contents copied.
// load() writes all of it back into the same objects. Objects made after the save are simply no
// longer referenced; the ones the save refers to are kept alive by the copy. Nothing is
// serialised, so a state lives only as long as the page.
//
// What counts as "an object of the game": anything whose constructor carries the TeaVM class
// metadata (Symbol("teavm_meta")); Java arrays are such objects with a `data` field holding a
// typed array or a JS array. Everything else a field may point to (three.js objects, canvases,
// sounds, 64-bit number objects) belongs to the host or is immutable: it is kept by reference
// and not looked into. The host-side state the game depends on is saved next to the copy by
// the pieces passed in: storage (scratchpad and SD card contents), audio (what each port is
// playing) and the free-look camera.
//
// The game disposes pictures and models when it leaves a screen or an area, and the host then
// frees their contents. A saved state may still refer to them, so disposal comes through
// dispose() here: what the state refers to is set aside instead, and really freed only when a
// newer save replaces that state.

/** A copied array: `ref` is the live array, `copy` its contents when saved. */
class Saved {
  constructor(ref, copy) {
    this.ref = ref;
    this.copy = copy;
  }
}

export class SaveStates {
  #request = 0;
  #slot = null;
  #meta = null; // Symbol("teavm_meta"), found on the first save
  #parts;
  #deferred = new Set(); // disposed by the game after the save, but part of the saved state

  /**
   * @param {object} parts  host-side state saved with the game's memory; each has
   *                        snapshot() -> data and restore(data)
   * @param {{snapshot: Function, restore: Function}[]} parts.list
   * @param {() => void} parts.afterLoad   called once the state is back
   * @param {(kind: 'saved'|'loaded'|'refused'|'empty', info?: object) => void} parts.notify
   */
  constructor(parts) {
    this.#parts = parts;
  }

  /** True once there is a state to load. */
  get available() {
    return this.#slot !== null;
  }

  /** Diagnostics for the last save: objects, array bytes copied, milliseconds. */
  stats = null;

  /** Page side: ask for a save at the next frame the game presents. */
  requestSave() {
    this.#request = 1;
  }

  /** Page side: ask for the saved state to be put back at the next frame. */
  requestLoad() {
    if (!this.#slot) {
      this.#parts.notify('empty');
      return;
    }
    this.#request = 2;
  }

  // ---- called by the game (rdash.Host) -------------------------------------------------------

  takeRequest() {
    const r = this.#request;
    this.#request = 0;
    return r;
  }

  /** The game disposes a picture or a 3D object. */
  dispose(object) {
    if (this.#slot?.hosts.has(object)) {
      this.#deferred.add(object);
      this.stats.deferred = this.#deferred.size;
    } else {
      object.dispose();
    }
  }

  save(roots, allowed) {
    if (!allowed || !roots) {
      this.#parts.notify('refused');
      return false;
    }
    const t0 = performance.now();
    this.#meta ??= Object.getOwnPropertySymbols(roots.constructor).find((s) => s.description === 'teavm_meta');
    const meta = this.#meta;
    if (!meta) {
      console.error('[states] this build has no class metadata to recognise game objects by');
      this.#parts.notify('refused');
      return false;
    }
    const isJava = (v) => v !== null && typeof v === 'object' && v.constructor !== undefined && v.constructor[meta] !== undefined;
    const objects = [];
    const fields = []; // per object: [key, value, key, value, ...]
    const seen = new Set([roots]);
    const queue = [roots];
    const hosts = new Set(); // host objects the state refers to that can be disposed
    let bytes = 0;
    for (let head = 0; head < queue.length; head++) {
      const o = queue[head];
      const record = [];
      for (const key of Object.keys(o)) {
        let v = o[key];
        if (v !== null && typeof v === 'object') {
          if (ArrayBuffer.isView(v)) {
            bytes += v.byteLength;
            v = new Saved(v, v.slice());
          } else if (key === 'data' && Array.isArray(v)) {
            // a Java array of references (or of 64-bit numbers, which are immutable objects)
            for (const item of v) {
              if (isJava(item) && !seen.has(item)) {
                seen.add(item);
                queue.push(item);
              }
            }
            bytes += v.length * 8;
            v = new Saved(v, v.slice());
          } else if (isJava(v)) {
            if (!seen.has(v)) {
              seen.add(v);
              queue.push(v);
            }
          } else if (typeof v.dispose === 'function') {
            hosts.add(v);
          }
        }
        record.push(key, v);
      }
      objects.push(o);
      fields.push(record);
    }
    // what the game disposed since the previous save is not part of this one: free it now
    for (const object of this.#deferred) object.dispose();
    this.#deferred.clear();
    this.#slot = { objects, fields, hosts, parts: this.#parts.list.map((p) => p.snapshot()) };
    this.stats = { objects: objects.length, hosts: hosts.size, bytes, ms: Math.round(performance.now() - t0) };
    this.#parts.notify('saved', this.stats);
    return true;
  }

  load() {
    const slot = this.#slot;
    if (!slot) {
      this.#parts.notify('empty');
      return false;
    }
    const t0 = performance.now();
    const { objects, fields } = slot;
    for (let i = 0; i < objects.length; i++) {
      const o = objects[i];
      const record = fields[i];
      for (let j = 0; j < record.length; j += 2) {
        let v = record[j + 1];
        if (v instanceof Saved) {
          const { ref, copy } = v;
          if (Array.isArray(ref)) {
            ref.length = copy.length;
            for (let n = 0; n < copy.length; n++) ref[n] = copy[n];
          } else {
            ref.set(copy);
          }
          v = ref;
        }
        o[record[j]] = v;
      }
    }
    this.#deferred.clear(); // in use again
    slot.parts.forEach((data, i) => this.#parts.list[i].restore(data));
    this.#parts.afterLoad();
    this.#parts.notify('loaded', { ms: Math.round(performance.now() - t0) });
    return true;
  }
}
