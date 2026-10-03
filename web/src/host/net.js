// Stand-in for the game's HTTP server, which was shut down long ago.
//
// The game makes three kinds of request (see class `n` in the decompiled game):
//   GET  <source>/data/area<island>_<chunk>_<version>.bin   island data, saved to the SD card as
//                                                           rddata<island-1><chunk>.bin
//   POST <host>/i/party/sreg/isr.php?...&ty=save            back the save data up on the server
//   GET  <host>/i/party/sreg/isr.php?...&ty=load            fetch the backup
// isr.php answers with two status bytes (1 or 3 = ok, 140 = no backup stored), followed by the
// save data for a load. Anything else gets a 404, which the game reports as a network error.

const BACKUP_KEY = 'rdash.backup';

const i8 = (u8) => new Int8Array(u8.buffer, u8.byteOffset, u8.byteLength);

export class Net {
  /** @param {import('./resources.js').Resources} resources */
  constructor(resources) {
    this.resources = resources;
  }

  request(url, method, body, len) {
    let path = url;
    try {
      const u = new URL(url);
      path = u.pathname + u.search;
    } catch {
      // keep the raw string
    }
    const area = /\/area(\d)_(\d)_\d+\.bin$/.exec(path.split('?')[0]);
    if (area) {
      const chunk = this.resources.shipped.get(`rddata${Number(area[1]) - 1}${area[2]}.bin`);
      if (chunk) return { code: 200, body: i8(chunk) };
    }
    if (path.includes('isr.php')) {
      const type = /[?&]ty=(\w+)/.exec(path)?.[1];
      if (type === 'save' && body) {
        const bytes = new Uint8Array(body.buffer, body.byteOffset, len);
        localStorage.setItem(BACKUP_KEY, btoa(String.fromCharCode(...bytes)));
        return { code: 200, body: new Int8Array([1, 0]) };
      }
      if (type === 'load') {
        const stored = localStorage.getItem(BACKUP_KEY);
        if (!stored) return { code: 200, body: new Int8Array([140, 0]) };
        const data = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
        const out = new Uint8Array(2 + data.length);
        out[0] = 1;
        out.set(data, 2);
        return { code: 200, body: i8(out) };
      }
    }
    console.info('[net] no handler for', method, url);
    return { code: 404, body: null };
  }
}
