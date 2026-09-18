#!/usr/bin/env node
/**
 * Regression checks for yacht screen-space proportions across orientation cycles.
 * Requires: node, playwright (npx playwright install chromium).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || 8765);
const baseUrl = `http://127.0.0.1:${port}/`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

function startServer() {
  return new Promise(resolve => {
    const server = createServer(async (req, res) => {
      try {
        const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
        const file = join(root, decodeURIComponent(path));
        const info = await stat(file);
        if (!info.isFile()) {
          res.writeHead(404); res.end('Not found'); return;
        }
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404); res.end('Not found');
      }
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const DEVICES = [
  { id: 'iphone-se', label: 'Small phone', portrait: { w: 375, h: 667 }, landscape: { w: 667, h: 375 } },
  { id: 'iphone-14', label: 'Modern phone', portrait: { w: 393, h: 852 }, landscape: { w: 852, h: 393 } },
  { id: 'iphone-14-pro-max', label: 'Large phone', portrait: { w: 430, h: 932 }, landscape: { w: 932, h: 430 } },
  { id: 'ipad-mini', label: 'Small tablet', portrait: { w: 768, h: 1024 }, landscape: { w: 1024, h: 768 } },
  { id: 'ipad-pro-12', label: 'Large tablet', portrait: { w: 1024, h: 1366 }, landscape: { w: 1366, h: 1024 } },
  { id: 'laptop', label: 'Desktop', portrait: { w: 1280, h: 800 }, landscape: { w: 1440, h: 900 } }
];

const SAFARI_STRESS = [
  { inner: [852, 393], canvas: [393, 760], label: 'stale-landscape-inner/portrait-canvas-760' },
  { inner: [852, 393], canvas: [393, 804], label: 'stale-landscape-inner/portrait-canvas-804' },
  { inner: [852, 393], canvas: [393, 852], label: 'stale-landscape-inner/portrait-canvas-852' }
];

async function waitReady(page) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 120000 });
  await page.waitForFunction(() => window.__projectionTest?.snapshot()?.projected?.normalizedAspect != null, null, { timeout: 30000 });
}

async function settle(page) {
  await page.evaluate(() => {
    window.__projectionTest?.refresh?.();
    return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await page.waitForTimeout(80);
}

async function assertAt(page, tag) {
  await settle(page);
  const result = await page.evaluate(t => window.__projectionTest.assertStable(t), tag);
  return result;
}

async function setViewport(page, size) {
  await page.setViewportSize({ width: size.w, height: size.h });
  await settle(page);
}

async function runMatrix(page) {
  const results = [];
  for (const device of DEVICES) {
    const phases = [
      ['P1', device.portrait],
      ['L1', device.landscape],
      ['P2', device.portrait],
      ['L2', device.landscape],
      ['P3', device.portrait]
    ];
    for (const [phase, size] of phases) {
      await setViewport(page, size);
      const tag = `${device.id}:${phase}:${size.w}x${size.h}`;
      const result = await assertAt(page, tag);
      results.push({ device: device.id, label: device.label, phase, expectedOrient: size.h >= size.w ? 'portrait' : 'landscape', ...result });
    }
  }
  return results;
}

async function runSafariStress(page) {
  const results = [];
  await setViewport(page, { w: 393, h: 852 });
  for (const step of SAFARI_STRESS) {
    const tag = `safari-stress:${step.label}`;
    const result = await page.evaluate(({ inner, canvas, tag: t }) => {
      const canvasEl = document.getElementById('c');
      const origRect = canvasEl.getBoundingClientRect.bind(canvasEl);
      const origInner = { w: window.innerWidth, h: window.innerHeight };
      canvasEl.getBoundingClientRect = () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: canvas[0],
        bottom: canvas[1],
        width: canvas[0],
        height: canvas[1],
        toJSON() { return this; }
      });
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: inner[0] });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: inner[1] });
      window.__projectionTest.refresh();
      const stale = window.__projectionTest.assertStable(`${t}:stale`);
      canvasEl.getBoundingClientRect = origRect;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: origInner.w });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: origInner.h });
      window.__projectionTest.refresh();
      const settled = window.__projectionTest.assertStable(`${t}:settled`);
      return { stale, settled };
    }, { inner: step.inner, canvas: step.canvas, tag });
    results.push({ tag, ...result.stale, phase: 'stale', expectPass: false });
    results.push({ tag, ...result.settled, phase: 'settled', expectPass: true });
  }
  return results;
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await waitReady(page);
    const matrix = await runMatrix(page);
    const stress = await runSafariStress(page);
    const all = [...matrix, ...stress];

    const failed = all.filter(r => {
      if (r.expectPass === false) return false;
      return !r.pass;
    });
    const summary = {
      total: all.length,
      passed: all.length - failed.length,
      failed: failed.map(f => ({
        tag: f.tag,
        phase: f.phase,
        pass: f.pass,
        modelOk: f.modelOk,
        aspectOk: f.aspectOk,
        bufferOk: f.bufferOk,
        offsetOk: f.offsetOk,
        styleOk: f.styleOk,
        baselineOk: f.baselineOk,
        normalizedAspect: f.normalizedAspect
      }))
    };

    console.log(JSON.stringify(summary, null, 2));
    if (failed.length) process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
