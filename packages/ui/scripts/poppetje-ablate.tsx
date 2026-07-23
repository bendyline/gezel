/**
 * One-off ablation probe: render variants of a single poppetje and report
 * edge/harsh-edge densities per variant, to localize which feature drives
 * the harsh-edge metric. Not part of the regular QA pipeline.
 *
 *   pnpm --filter @bendyline/gezel-ui exec tsx scripts/poppetje-ablate.tsx <seed>
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Poppetje as PoppetjeStruct, poppetjeFromSeed } from '@bendyline/gezel';
import { chromium } from 'playwright';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Poppetje } from '../src/poppetje/Poppetje.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(_dirname, '..', '..', '..', 'tmp', 'poppetjes-ablate');

const seed = Number(process.argv[2] ?? 1);
const base = poppetjeFromSeed(seed, { key: `sample-${seed}` });

const variants: Array<{ id: string; p: PoppetjeStruct; grain?: 'none' | 'wavy' }> = [
  { id: 'full', p: base },
  { id: 'no-pattern', p: { ...base, shirtPattern: 'plain' } },
  { id: 'no-dress', p: { ...base, dress: null } },
  { id: 'no-hair', p: { ...base, hairShape: 'bald' } },
  { id: 'no-accessory', p: { ...base, accessory: null } },
  { id: 'adult-scale', p: { ...base, figureScale: 'adult' } },
  { id: 'no-grain', p: base, grain: 'none' },
  {
    id: 'bare',
    p: { ...base, shirtPattern: 'plain', dress: null, hairShape: 'bald', accessory: null },
  },
];

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const tiles = variants
    .map((v) => {
      const svg = renderToStaticMarkup(
        React.createElement(Poppetje, {
          poppetje: v.p,
          size: 180,
          grainStyle: v.grain ?? 'wavy',
          variant: 'full',
          svgId: v.id,
        }),
      );
      return `<figure id="t-${v.id}" style="margin:0;padding:12px;background:#fbf6ea;display:inline-block">${svg}</figure>`;
    })
    .join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f1ece2">${tiles}</body></html>`;
  const htmlPath = join(outDir, 'index.html');
  await writeFile(htmlPath, html, 'utf8');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 600 } });
  await page.goto(pathToFileURL(htmlPath).toString(), { waitUntil: 'load' });
  await page.evaluate('globalThis.__name = (fn) => fn');

  for (const v of variants) {
    const buf = await page.locator(`#t-${v.id}`).screenshot();
    const metrics = await page.evaluate(async (b64) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = `data:image/png;base64,${b64}`;
      });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const w = c.width;
      const h = c.height;
      const bg = { r: 251, g: 246, b: 234 };
      const lum = (i: number) =>
        0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0);
      const isFg = (x: number, y: number) => {
        const i = (y * w + x) * 4;
        return Math.hypot((d[i] ?? 0) - bg.r, (d[i + 1] ?? 0) - bg.g, (d[i + 2] ?? 0) - bg.b) > 28;
      };
      let fg = 0;
      let edges = 0;
      let harsh = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!isFg(x, y)) continue;
          fg++;
          const i = (y * w + x) * 4;
          const g1 = Math.abs(lum(i) - lum((y * w + x + 1) * 4));
          const g2 = Math.abs(lum(i) - lum(((y + 1) * w + x) * 4));
          const grad = Math.max(g1, g2);
          if (grad > 14) edges++;
          if (grad > 42) harsh++;
        }
      }
      return { fg, edge: edges / fg, harsh: harsh / fg };
    }, buf.toString('base64'));
    console.log(
      v.id.padEnd(14),
      'fg',
      String(metrics.fg).padStart(7),
      'edge',
      metrics.edge.toFixed(4),
      'harsh',
      metrics.harsh.toFixed(4),
    );
  }
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
