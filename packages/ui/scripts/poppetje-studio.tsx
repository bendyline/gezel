/**
 * Close-up harness for poppetje lighting and material work: a dozen seeded
 * figures rendered large, four larger still, headshots, and real icon crops
 * on light and dark surfaces (plus those icon pixels enlarged). The compact
 * gallery sheet hides material problems at 88px; these sizes show them. The
 * full gallery takes minutes; this takes seconds.
 *
 * Run: node packages/ui/scripts/poppetje-review.mjs studio [seeds] [outDir]
 * Seeds are comma-separated `poppetjeFromSeed` numbers. Point outDir at a
 * second folder to keep a before/after pair.
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
const seeds = (process.argv[2] ?? '3,5,8,11,14,16,21,24,29,31,36,42').split(',').map(Number);
const outDir = resolve(
  process.argv[3] ?? resolve(_dirname, '..', '..', '..', 'tmp', 'poppetjes', 'studio'),
);

const figures: PoppetjeStruct[] = seeds.map((n) =>
  poppetjeFromSeed(n, { key: `sample-${n}`, name: `Sample ${n}` }),
);

let uid = 0;
const svg = (p: PoppetjeStruct, variant: 'full' | 'headshot' | 'icon', size: number) =>
  renderToStaticMarkup(
    React.createElement(Poppetje, { poppetje: p, variant, size, svgId: `s${uid++}` }),
  );

const hero = figures.map((p) => `<div class="cell">${svg(p, 'full', 200)}</div>`).join('');
// The default seeds put a goatee, two knotty figures, and a cathedral body here.
const zoom = [0, 3, 9, 11]
  .filter((i) => i < figures.length)
  .map((i) => `<div class="cell">${svg(figures[i]!, 'full', 330)}</div>`)
  .join('');
const heads = figures
  .slice(0, 6)
  .map((p) => `<div class="cell">${svg(p, 'headshot', 200)}</div>`)
  .join('');
const iconRow = (bg: string) =>
  `<div class="icons" style="background:${bg}">${figures
    .map(
      (p) =>
        `<div class="ic">${[24, 32, 40, 56]
          .map(
            (s) =>
              `<div class="clip" style="width:${s}px;height:${s}px">${svg(p, 'icon', s)}</div>`,
          )
          .join('')}</div>`,
    )
    .join('')}</div>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#f3eee4;font-family:system-ui}
.grid{display:grid;grid-template-columns:repeat(6,220px);gap:12px;padding:20px}
.cell{display:flex;justify-content:center;align-items:flex-end;padding:8px 0}
#heads .cell{overflow:hidden}
.zgrid{display:grid;grid-template-columns:repeat(4,350px);gap:12px;padding:20px}
.icons{display:flex;flex-wrap:wrap;gap:18px;padding:18px 20px}
.ic{display:flex;gap:8px;align-items:center}
.clip{border-radius:6px;overflow:hidden}
</style></head><body>
<div id="hero" class="grid">${hero}</div>
<div id="zoom" class="zgrid">${zoom}</div>
<div id="heads" class="grid">${heads}</div>
<div id="icons">${iconRow('#f3eee4')}${iconRow('#1f1b18')}</div>
</body></html>`;

await mkdir(outDir, { recursive: true });
const htmlPath = join(outDir, 'studio.html');
await writeFile(htmlPath, html);
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
await page.goto(pathToFileURL(htmlPath).href);
await page.locator('#hero').screenshot({ path: join(outDir, 'hero.png') });
await page.locator('#zoom').screenshot({ path: join(outDir, 'zoom.png') });
await page.locator('#heads').screenshot({ path: join(outDir, 'heads.png') });
await page.locator('#icons').screenshot({ path: join(outDir, 'icons.png') });
// Enlarge the real 1x pixels so small-size legibility can be judged.
await writeFile(
  join(outDir, 'icons-zoom.html'),
  `<body style="margin:0"><div id="z" style="width:1440px;height:996px;overflow:hidden"><img src="icons.png" style="width:4320px;image-rendering:pixelated"></div></body>`,
);
await page.goto(pathToFileURL(join(outDir, 'icons-zoom.html')).href);
await page.locator('#z').screenshot({ path: join(outDir, 'icons-zoom.png') });
await browser.close();
console.log(`[studio] wrote ${outDir}`);
