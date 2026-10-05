#!/usr/bin/env node
// Packs the built web app (web/dist, from `npm run build`) into ONE self-contained HTML file: the
// page, its script, the recompiled game and all the game's data, so it can be copied to another
// device or archived and opened straight from disk, with no server.
//
//   node tools/package/single_html.mjs [--out build/package/name.html] [--small] [--full]
//                                      [--hd] [--legends2] [--remake] [--variant localized|delocalized]
//
//   (default)  both variants, game data, sampled music instruments if they were generated
//   --small    no sampled instruments (music uses the built-in synthesiser)
//   --hd       also the AI-upscaled texture pack (web/public/hd), if present
//   --legends2 also the installed Legends 2 models (web/public/mml2), if present
//   --remake   also the remade models (web/public/remake), if present
//   --full     everything: --hd --legends2 --remake
//   --variant  only one variant of the English patch
//
// How: every file the page would fetch is embedded as base64 in a <script type=
// "application/x-rdash-file" data-path="..."> element. A small script replaces fetch() so that
// requests for those paths are answered from the page (anything else under the page's folder is
// "404", which is how the optional packs report themselves absent), and defines
// rdashResolve(url) for the two places that need a URL rather than a fetch: a blob: URL for the
// game module's import(), a data: URL for the audio worklet. The app's own module is inlined.
//
// The output contains the user's game files: it is for personal use, not for sharing.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dist = resolve(root, 'web/dist');
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback) => (has(flag) ? args[args.indexOf(flag) + 1] : fallback);
const out = resolve(root, value('--out', 'build/package/Rockman-DASH-5-Islands.html'));
const variants = has('--variant') ? [value('--variant')] : ['localized', 'delocalized'];
const want = {
  soundfont: !has('--small'),
  hd: has('--hd') || has('--full'),
  mml2: has('--legends2') || has('--full'),
  remake: has('--remake') || has('--full'),
};

if (!existsSync(join(dist, 'index.html'))) {
  console.error('web/dist not found: run (cd web && npm run build) first, or use ./package_html.sh');
  process.exit(1);
}

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const files = walk(dist).map((p) => relative(dist, p).split('\\').join('/')).filter((path) => {
  if (path === 'index.html' || /^assets\/index-.*\.js$/.test(path)) return false; // inlined below
  if (path.startsWith('assets/')) return true;
  if (path.startsWith('game/')) return variants.some((v) => path.startsWith(`game/${v}/`));
  if (path.startsWith('data/sdcard/')) return true;
  if (path.startsWith('data/')) return variants.some((v) => path.startsWith(`data/${v}/`)) && !path.endsWith('.jar.bak');
  if (path.startsWith('soundfont/')) return want.soundfont;
  if (path.startsWith('hd/') || path.startsWith('redraw/')) return want.hd;
  if (path.startsWith('mml2/')) return want.mml2;
  if (path.startsWith('remake/')) return want.remake;
  return false;
});

const SHIM = `
(() => {
  // Files embedded in this page (see tools/package/single_html.mjs), served to fetch() and as blob: URLs.
  const base = new URL('.', document.baseURI).href;
  const nodes = new Map();
  for (const el of document.querySelectorAll('script[type="application/x-rdash-file"]')) nodes.set(el.dataset.path, el);
  const blobs = new Map();
  const TYPES = { js: 'text/javascript', json: 'application/json', png: 'image/png', glb: 'model/gltf-binary' };
  const keyOf = (url) => {
    const u = new URL(url, document.baseURI);
    u.search = '';
    u.hash = '';
    if (!u.href.startsWith(base)) return null;
    const key = decodeURIComponent(u.href.slice(base.length));
    // the app's script was built to live in assets/, so what it asks for next to itself is there
    const known = (k) => nodes.has(k) || blobs.has(k);
    return !known(key) && known('assets/' + key) ? 'assets/' + key : key;
  };
  const blobOf = (key) => {
    let blob = blobs.get(key);
    const el = nodes.get(key);
    if (!blob && el) {
      const text = atob(el.textContent);
      const bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
      blob = new Blob([bytes], { type: TYPES[key.slice(key.lastIndexOf('.') + 1)] || 'application/octet-stream' });
      blobs.set(key, blob);
      el.remove(); // the base64 text is no longer needed
    }
    return blob || null;
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const key = keyOf(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (key === null) return realFetch(input, init);
    const blob = blobOf(key);
    return Promise.resolve(blob
      ? new Response(blob, { status: 200, headers: { 'Content-Type': blob.type } })
      : new Response('', { status: 404, statusText: 'Not in this file' }));
  };
  // inline: a data: URL instead of a blob: one. A page opened from disk has no origin of its
  // own, and an audio worklet refuses a blob: module there, but accepts the code inline.
  window.rdashResolve = (url, inline = false) => {
    const key = keyOf(url);
    if (key === null) return url;
    const el = nodes.get(key);
    if (inline && el) return 'data:text/javascript;base64,' + el.textContent;
    const blob = blobOf(key);
    return blob ? URL.createObjectURL(blob) : url;
  };
})();`;

let html = readFileSync(join(dist, 'index.html'), 'utf8');
const entry = html.match(/<script type="module"[^>]*src="\.?\/?(assets\/index-[^"]+\.js)"[^>]*><\/script>/);
if (!entry) {
  console.error('could not find the app script in web/dist/index.html');
  process.exit(1);
}
const inlineSafe = (code) => code.replace(/<\/script/gi, '<\\/script');
const embedded = files.map((path) => `<script type="application/x-rdash-file" data-path="${path}">${readFileSync(join(dist, path)).toString('base64')}</script>`);
const app = inlineSafe(readFileSync(join(dist, entry[1]), 'utf8'));
html = html
  .replace(/<link rel="modulepreload"[^>]*>\s*/g, '')
  .replace(entry[0], '')
  // a function as the replacement: the code may contain "$&" and the like
  .replace('</body>', () => `${embedded.join('\n')}\n<script>${SHIM}\n</script>\n<script type="module">${app}</script>\n</body>`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const groups = {};
for (const path of files) {
  const group = path.split('/')[0];
  groups[group] = (groups[group] ?? 0) + statSync(join(dist, path)).size;
}
console.log(`${relative(root, out)}: ${mb(statSync(out).size)}  (${files.length} files embedded: ${Object.entries(groups).map(([g, n]) => `${g} ${mb(n)}`).join(', ')})`);
