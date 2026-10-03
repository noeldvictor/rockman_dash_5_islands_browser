#!/usr/bin/env node
// Loads the real game in headless Chrome and reports what the audio host is doing: engine kind,
// AudioContext state, what each port plays and the output peak level, sampled a few times.
//   node tools/mfi/browser_check.mjs [--variant delocalized] [--url http://localhost:5173/]
//                                    [--audio script,gameloops] [step...]
// Steps as in tools/play.mjs (wait:<ms>, key:<name>[:<ms>], shot:<name>) plus  info  (print
// DOJA.audio.info()).
// Default steps: wait:2500 info key:Enter wait:1500 info wait:2000 info
// Needs the dev server (cd web && npx vite --port 5173). Exits non-zero on console errors (other
// than 404s for missing static files) or if no sound reaches the output after the key press.
import { chromium } from '../../web/node_modules/playwright-core/index.mjs';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = { variant: 'delocalized', url: 'http://localhost:5173/' };
let steps = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[++i];
  else steps.push(args[i]);
}
if (!steps.length) steps = ['wait:2500', 'info', 'key:Enter', 'wait:1500', 'info', 'wait:2000', 'info'];

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 720, height: 800 } });
let errors = 0;
page.on('console', (m) => {
  const t = m.type();
  const text = m.text();
  if (t === 'error' && !/Failed to load resource.*404/.test(text)) errors++;
  if (t === 'error' || t === 'warning' || /\[audio\]/.test(text)) console.log(`[${t}] ${text} ${m.location()?.url ?? ''}`.slice(0, 400));
});
page.on('pageerror', (e) => {
  errors++;
  console.log(`[pageerror] ${e.message}`);
});
page.on('response', (r) => {
  if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`);
});
await page.goto(`${opt.url}?variant=${opt.variant}&scale=2${opt.audio ? `&audio=${opt.audio}` : ''}`);
await page.waitForSelector('#stage:not([hidden])', { timeout: 30000 });

let heard = 0, pressed = false;
for (const step of steps) {
  const [cmd, a, b] = step.split(':');
  if (cmd === 'wait') await page.waitForTimeout(Number(a));
  else if (cmd === 'key') {
    await page.keyboard.down(a);
    await page.waitForTimeout(Number(b || 120));
    await page.keyboard.up(a);
    await page.waitForTimeout(80);
    pressed = true;
  } else if (cmd === 'shot') {
    mkdirSync('build/shots', { recursive: true });
    await page.locator('#screen').screenshot({ path: `build/shots/${a}.png` });
    console.log(`shot build/shots/${a}.png`);
  } else if (cmd === 'info') {
    const info = await page.evaluate(() => globalThis.DOJA?.audio?.info?.() ?? null);
    if (!info) {
      console.log('info: DOJA.audio.info() is not available');
      errors++;
      continue;
    }
    if (pressed && info.peak > 0.001) heard++;
    console.log(`info: context ${info.context}, engine ${info.engine}, ${info.sampleRate} Hz, peak ${info.peak.toFixed(3)}, ${info.sounds} sounds, muted ${info.muted}, ` +
      `played ${info.counters.played} (audible ${info.counters.audible}), completed ${info.counters.completed}, stopped ${info.counters.stopped}`);
    for (const p of info.ports) console.log(`   port ${p.port}: ${p.playing ? 'playing' : 'idle   '} ${p.audible ? 'audible' : 'silent '} vol ${p.volume} ${p.sound ?? '-'}${p.loops ? ' (loops)' : ''}`);
  } else console.log(`unknown step ${step}`);
}
await browser.close();
if (pressed && !heard) {
  console.log('no sound reached the output after the key press');
  errors++;
}
console.log(errors ? `${errors} problem(s)` : 'ok');
process.exit(errors ? 1 : 0);
