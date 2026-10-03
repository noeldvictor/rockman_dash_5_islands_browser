#!/usr/bin/env node
// Headless driver for the browser build: loads the game, feeds it key presses and saves
// screenshots. Used to check rendering without a display.
//
//   node tools/play.mjs [--variant localized] [--scale 2] [--out build/shots]
//                        [--gpu 1] [--headed 1] <step>...
//
// By default Chrome runs headless with the software renderer (works anywhere). --gpu 1 uses the
// machine's GPU instead; --headed 1 opens a visible window (needs a display; implies --gpu).
//
// Interactive sessions: `--serve 1` launches Chrome, loads the game and stays running;
// `--attach 1 <step>...` then runs steps against that same page (state is kept between calls)
// and prints any page errors collected since the last call.
//
// Steps run in order:
//   wait:<ms>            let the game run
//   key:<name>[:<ms>]    hold a key (Playwright key name, e.g. Enter, ArrowUp, Digit5) for <ms> (default 120)
//   shot:<name>          save build/shots/<name>.png (the game canvas)
//   page:<name>          save build/shots/<name>.png (the whole page)
//   eval:<js>            evaluate an expression in the page and print the result
//   mash:<ms>            press random game keys for <ms> (soak test)
//   reload               reload the page (same browser profile, so saves persist)
//
// Expects a dev server (cd web && npx vite) on --url (default http://localhost:5173/).

import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = { variant: 'localized', scale: '2', out: 'build/shots', url: 'http://localhost:5173/' };
const steps = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[++i];
  else steps.push(args[i]);
}
mkdirSync(opt.out, { recursive: true });

const CDP_PORT = 9333;
const headed = opt.headed === '1';
const gpu = headed || opt.gpu === '1';
const attach = opt.attach === '1';
const serve = opt.serve === '1';

let browser;
let page;
let errors = 0;
if (attach) {
  browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  page = browser.contexts()[0].pages()[0];
  const collected = await page.evaluate(() => (window.__errors || []).splice(0));
  for (const e of collected) console.log(`[page error] ${e}`.slice(0, 600));
  errors += collected.length;
} else {
  const args = gpu
    ? ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=gl', '--autoplay-policy=no-user-gesture-required']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  if (serve) {
    // keep the game running at full speed even when the window is covered or unfocused
    args.push(`--remote-debugging-port=${CDP_PORT}`, '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--disable-background-timer-throttling');
  }
  browser = await chromium.launch({ channel: 'chrome', headless: !headed, args });
  page = await browser.newPage({ viewport: { width: 720, height: 800 } });
  await page.addInitScript(() => {
    window.__errors = [];
    window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));
    const error = console.error.bind(console);
    console.error = (...a) => {
      window.__errors.push(a.map(String).join(' '));
      error(...a);
    };
  });
}
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error') errors++;
  if (t !== 'debug') console.log(`[${t}] ${m.text()}`.slice(0, 600));
});
page.on('pageerror', (e) => {
  errors++;
  console.log(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 6).join('\n')}`);
});
if (!attach) {
  await page.goto(`${opt.url}?variant=${opt.variant}&scale=${opt.scale}`);
  await page.waitForSelector('#stage:not([hidden])', { timeout: 30000 });
}

for (const step of steps) {
  const [cmd, a, b] = step.split(':');
  if (cmd === 'wait') {
    await page.waitForTimeout(Number(a));
  } else if (cmd === 'key') {
    await page.keyboard.down(a);
    await page.waitForTimeout(Number(b || 120));
    await page.keyboard.up(a);
    await page.waitForTimeout(80);
  } else if (cmd === 'page') {
    const file = resolve(opt.out, `${a}.png`);
    await page.screenshot({ path: file });
    console.log(`shot ${file}`);
  } else if (cmd === 'reload') {
    await page.reload();
    await page.waitForSelector('#stage:not([hidden])', { timeout: 30000 });
  } else if (cmd === 'eval') {
    console.log('eval ->', JSON.stringify(await page.evaluate(step.slice(5))));
  } else if (cmd === 'mash') {
    const keys = ['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'KeyZ', 'KeyZ', 'Space', 'KeyC', 'ShiftLeft', 'Enter'];
    const end = Date.now() + Number(a);
    let seed = 12345;
    while (Date.now() < end) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const k = keys[seed % keys.length];
      await page.keyboard.down(k);
      await page.waitForTimeout(100 + (seed % 700));
      await page.keyboard.up(k);
    }
  } else if (cmd === 'shot') {
    const file = resolve(opt.out, `${a}.png`);
    await page.locator('#screen').screenshot({ path: file });
    console.log(`shot ${file}`);
  } else {
    console.log(`unknown step ${step}`);
  }
}
if (serve) {
  console.log(`serving; attach with: node tools/play.mjs --attach 1 <step>...`);
  await new Promise(() => {}); // until killed
}
if (attach) process.exit(errors ? 1 : 0); // leave the browser running
await browser.close();
process.exit(errors ? 1 : 0);
