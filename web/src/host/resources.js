// Game data: the application jar (resource:///), the scratchpad (scratchpad:///N) and the SD card.
//
// Everything is fetched up front so the recompiled game can read it synchronously. Scratchpad and
// SD-card writes are kept in memory and mirrored to IndexedDB so saves survive a reload.

import { unzipSync } from 'fflate';

const DB_NAME = 'rdash';
const STORE = 'files';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll(db) {
  return new Promise((resolve, reject) => {
    const out = new Map();
    const req = db.transaction(STORE).objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out);
      out.set(cur.key, cur.value);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

function parseJam(bytes) {
  // The .jam is Shift_JIS; only AppName is non-ASCII.
  const text = new TextDecoder('shift_jis').decode(bytes);
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const i8 = (u8) => new Int8Array(u8.buffer, u8.byteOffset, u8.byteLength);

export class Resources {
  /**
   * @param {string} variant   'localized' | 'delocalized'
   * @param {string} base      URL prefix of the data directory
   * @param {(done:number,total:number)=>void} [progress]
   */
  static async load(variant, base, progress = () => {}) {
    const res = new Resources();
    const sdNames = [];
    for (let island = 0; island < 5; island++) {
      sdNames.push(`RDDATA${island}.BIN`);
      for (let chunk = 0; chunk < 5; chunk++) sdNames.push(`RDDATA${island}${chunk}.BIN`);
    }
    const urls = [
      `${base}/${variant}/RockmanDASH.jar`,
      `${base}/${variant}/RockmanDASH.jam`,
      `${base}/${variant}/RockmanDASH.sp`,
      ...sdNames.map((n) => `${base}/sdcard/${n}`),
    ];
    let done = 0;
    const files = await Promise.all(urls.map(async (u) => {
      const b = await fetchBytes(u);
      progress(++done, urls.length);
      return b;
    }));
    res.jar = unzipSync(files[0]);
    res.jam = parseJam(files[1]);
    res.#initScratchpad(files[2]);
    // FAT names are case-insensitive: the dump is upper-case, the game asks for lower-case
    sdNames.forEach((n, i) => {
      res.sd.set(n.toLowerCase(), files[3 + i]);
      res.shipped.set(n.toLowerCase(), files[3 + i]);
    });

    try {
      res.db = await openDB();
      const saved = await idbGetAll(res.db);
      for (const [key, value] of saved) {
        if (key.startsWith('sp:')) {
          const seg = Number(key.slice(3));
          if (res.segments[seg] && value.length === res.segments[seg].length) res.segments[seg].set(value);
        } else if (key.startsWith('sd:')) {
          res.sd.set(key.slice(3).toLowerCase(), value);
        }
      }
    } catch (e) {
      console.warn('IndexedDB unavailable; saves will not persist', e);
    }
    res.#stampMembership();
    return res;
  }

  jar = {};
  jam = {};
  /** @type {Uint8Array[]} */
  segments = [];
  /** @type {Map<string, Uint8Array>} */
  sd = new Map();
  /** SD-card files as shipped (what the game server used to hand out); never modified */
  shipped = new Map();
  db = null;

  #initScratchpad(sp) {
    // 64-byte header: little-endian int32 segment sizes, -1 terminated.
    const dv = new DataView(sp.buffer, sp.byteOffset, sp.byteLength);
    let off = 64;
    for (let i = 0; i < 16; i++) {
      const size = dv.getInt32(i * 4, true);
      if (size < 0) break;
      this.segments.push(sp.slice(off, off + size));
      off += size;
    }
  }

  /**
   * Segment 2 holds year*100+month of the last successful subscription check (LE int32). When it
   * is not the current month the game "verifies membership" on start-up; with the server gone the
   * English patch skips that but then shows the storage-location prompt on every launch. Stamping
   * the current month makes the game start as it did for a subscriber in good standing.
   */
  #stampMembership() {
    const seg = this.segments[2];
    if (!seg || seg.length < 4) return;
    const now = new Date();
    new DataView(seg.buffer, seg.byteOffset).setInt32(0, now.getFullYear() * 100 + now.getMonth() + 1, true);
  }

  #persist(key, bytes) {
    if (!this.db) return;
    try {
      const tx = this.db.transaction(STORE, 'readwrite');
      if (bytes) tx.objectStore(STORE).put(bytes.slice(), key);
      else tx.objectStore(STORE).delete(key);
    } catch (e) {
      console.warn('persist failed', key, e);
    }
  }

  // ---- host interface (called from the recompiled game through rdash.Host) -------------------
  resource(name) {
    const f = this.jar[name];
    return f ? i8(f) : null;
  }

  spRead(seg, pos, len) {
    const s = this.segments[seg];
    if (!s) return null;
    const end = len < 0 ? s.length : Math.min(s.length, pos + len);
    return i8(s.slice(pos, end));
  }

  spWrite(seg, pos, data, len) {
    const s = this.segments[seg];
    if (!s) return;
    const n = Math.min(len, s.length - pos);
    for (let i = 0; i < n; i++) s[pos + i] = data[i];
    this.#persist(`sp:${seg}`, s);
  }

  sdRead(name) {
    name = name.toLowerCase();
    const f = this.sd.get(name);
    return f ? i8(f) : null;
  }

  sdWrite(name, data, len) {
    name = name.toLowerCase();
    if (len < 0) {
      this.sd.delete(name);
      this.#persist(`sd:${name}`, null);
      return;
    }
    const copy = new Uint8Array(len);
    for (let i = 0; i < len; i++) copy[i] = data[i];
    this.sd.set(name, copy);
    this.#persist(`sd:${name}`, copy);
  }

  unzip(data, len) {
    const u8 = new Uint8Array(data.buffer, data.byteOffset, len);
    try {
      return unzipSync(u8);
    } catch (e) {
      console.error('unzip failed', e);
      return {};
    }
  }

  zipEntry(zip, name) {
    const f = zip[name];
    return f ? i8(f) : null;
  }

  /** Forget persisted scratchpad/SD changes (next load starts from the shipped data). */
  async reset() {
    if (!this.db) return;
    await new Promise((resolve) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }
}
