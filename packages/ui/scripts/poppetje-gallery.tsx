/**
 * Poppetje visual-QA gallery harness.
 *
 * Renders every catalog combination we care about into a single static HTML
 * page (one tile per variant), then launches a headless Chromium via
 * Playwright and emits PNG screenshots — one overview shot plus one
 * close-up per tile — into `tmp/poppetjes/`.
 *
 * Used to iterate on the Poppetje SVG's visual quality: wood material,
 * shine, body silhouettes, hair, hat/accessory fit. See the user-facing
 * brief in this commit's PR for the issues being addressed.
 *
 * Run:  pnpm --filter @bendyline/gezel-ui exec tsx scripts/poppetje-gallery.tsx
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ACCESSORY_OPTIONS,
  BODY_SHAPE_KEYS,
  DRESS_OPTIONS,
  EXPRESSION_OPTIONS,
  FACIAL_HAIR_OPTIONS,
  FIGURE_SCALE_KEYS,
  GRAIN_PRESETS,
  HAIR_SHAPES,
  HAT_OPTIONS,
  MARK_OPTIONS,
  PALETTE,
  type Poppetje as PoppetjeStruct,
  SHIRT_PATTERN_OPTIONS,
  poppetjeFromSeed,
} from '@bendyline/gezel';
import { chromium } from 'playwright';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Poppetje, type PoppetjeVariant } from '../src/poppetje/Poppetje.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(_dirname, '..', '..', '..', 'tmp', 'poppetjes');
const htmlPath = join(outDir, 'index.html');

interface Tile {
  id: string;
  label: string;
  group: string;
  poppetje: PoppetjeStruct;
  size?: number;
  grainStyle?: keyof typeof GRAIN_PRESETS;
  variant?: PoppetjeVariant;
  surface?: 'light' | 'dark';
  /** Context-only tiles belong in the gallery but not the full-body image eval. */
  evaluate?: boolean;
}

function override(base: PoppetjeStruct, patch: Partial<PoppetjeStruct>): PoppetjeStruct {
  return { ...base, ...patch };
}

function buildTiles(): Tile[] {
  const tiles: Tile[] = [];

  // ── 1. Body shapes — fixed neutral skin/hair/shirt, isolate silhouette.
  const baseBody = poppetjeFromSeed(7, { key: 'body-base', name: 'Body Base' });
  const bodyFixed = override(baseBody, {
    hat: null,
    dress: null,
    accessory: null,
    mark: null,
    hairShape: 'short',
    expression: 'smile',
    // Pin the pattern too — isolation tiles should vary exactly one slot,
    // and the base seed happens to roll `twotone`.
    shirtPattern: 'plain',
  });
  for (const shape of BODY_SHAPE_KEYS) {
    tiles.push({
      id: `body-${shape}`,
      label: `body / ${shape}`,
      group: 'Body shapes',
      poppetje: override(bodyFixed, { bodyShape: shape, key: `body-${shape}` }),
    });
  }

  // ── 2. Figure scales — all `tapered` body, vary scale.
  for (const scale of FIGURE_SCALE_KEYS) {
    tiles.push({
      id: `scale-${scale}`,
      label: `scale / ${scale}`,
      group: 'Figure scales',
      poppetje: override(bodyFixed, {
        bodyShape: 'tapered',
        figureScale: scale,
        key: `scale-${scale}`,
      }),
    });
  }

  // ── 3. Hair shapes — adult tapered body, no hat.
  for (const hairShape of HAIR_SHAPES) {
    tiles.push({
      id: `hair-${hairShape}`,
      label: `hair / ${hairShape}`,
      group: 'Hair shapes',
      poppetje: override(bodyFixed, {
        hairShape,
        hat: null,
        key: `hair-${hairShape}`,
      }),
    });
  }

  // ── 4. Hats — fixed body, no dress/accessory.
  for (const hat of HAT_OPTIONS) {
    tiles.push({
      id: `hat-${hat}`,
      label: `hat / ${hat}`,
      group: 'Hats',
      poppetje: override(bodyFixed, { hat, key: `hat-${hat}` }),
    });
  }

  // ── 5. Dresses — fixed body, no hat/accessory.
  for (const dress of DRESS_OPTIONS) {
    tiles.push({
      id: `dress-${dress}`,
      label: `dress / ${dress}`,
      group: 'Dress overlays',
      poppetje: override(bodyFixed, { dress, key: `dress-${dress}` }),
    });
  }

  // ── 6. Accessories — fixed body, no hat/dress.
  for (const accessory of ACCESSORY_OPTIONS) {
    tiles.push({
      id: `accessory-${accessory}`,
      label: `accessory / ${accessory}`,
      group: 'Accessories',
      poppetje: override(bodyFixed, { accessory, key: `acc-${accessory}` }),
    });
  }

  // ── 6b. Facial hair + marks — physical features in their own slots.
  for (const facialHair of FACIAL_HAIR_OPTIONS) {
    tiles.push({
      id: `facial-${facialHair}`,
      label: `facialHair / ${facialHair}`,
      group: 'Facial features',
      poppetje: override(bodyFixed, { facialHair, key: `fh-${facialHair}` }),
    });
  }
  for (const mark of MARK_OPTIONS) {
    tiles.push({
      id: `mark-${mark}`,
      label: `mark / ${mark}`,
      group: 'Facial features',
      poppetje: override(bodyFixed, { mark, key: `mark-${mark}` }),
    });
  }

  // ── 7. Expressions — face only.
  for (const expression of EXPRESSION_OPTIONS) {
    tiles.push({
      id: `expr-${expression}`,
      label: `expression / ${expression}`,
      group: 'Expressions',
      poppetje: override(bodyFixed, { expression, key: `expr-${expression}` }),
    });
  }

  // ── 7b. Shirt patterns — painted garment structure on a fixed body.
  for (const shirtPattern of SHIRT_PATTERN_OPTIONS) {
    tiles.push({
      id: `pattern-${shirtPattern}`,
      label: `pattern / ${shirtPattern}`,
      group: 'Shirt patterns',
      poppetje: override(bodyFixed, { shirtPattern, key: `pattern-${shirtPattern}` }),
    });
  }

  // ── 8. Grain styles — one identical figure, varying only the finish.
  for (const grain of Object.keys(GRAIN_PRESETS)) {
    tiles.push({
      id: `grain-${grain}`,
      label: `grain / ${grain}`,
      group: 'Wood grain',
      poppetje: override(bodyFixed, { key: 'grain-preset-comparison' }),
      grainStyle: grain as keyof typeof GRAIN_PRESETS,
    });
  }
  // The finish preset is only half of the material story. These figures all
  // use the default finish, while their stable keys deliberately exercise the
  // four material characters and both single/double knot variants.
  [
    { key: 'grain-character-4', label: 'fine lines' },
    { key: 'grain-character-266', label: 'flowing waves' },
    { key: 'grain-character-0', label: 'cathedral figure' },
    { key: 'grain-character-267', label: 'single knot' },
    { key: 'grain-character-117', label: 'double knot' },
  ].forEach(({ key, label }, i) => {
    tiles.push({
      id: `grain-key-${i + 1}`,
      label: `wavy / ${label}`,
      group: 'Wood grain',
      poppetje: override(bodyFixed, { key }),
      grainStyle: 'wavy',
    });
  });

  // ── 9. Skin tones (head-and-shoulders crop).
  PALETTE.skins.forEach((s, i) => {
    tiles.push({
      id: `skin-${i}`,
      label: `skin #${i}`,
      group: 'Skins',
      poppetje: override(bodyFixed, {
        skin: s.skin,
        skin2: s.skin2,
        key: `skin-${i}`,
      }),
    });
  });

  // ── 10. Shirt palettes.
  PALETTE.shirts.forEach((s, i) => {
    tiles.push({
      id: `shirt-${i}`,
      label: `shirt #${i}`,
      group: 'Shirts',
      poppetje: override(bodyFixed, {
        shirt: s.shirt,
        shirtAccent: s.accent,
        key: `shirt-${i}`,
      }),
    });
  });

  // ── 11. Random sampler — seeds 0..31 with full slot rolls.
  for (let n = 0; n < 32; n++) {
    tiles.push({
      id: `sample-${n}`,
      label: `seed ${n}`,
      group: 'Sampler',
      poppetje: poppetjeFromSeed(n, { key: `sample-${n}`, name: `Sample ${n}` }),
    });
  }

  // ── 12. Tricky combos — accessory + hat + dress overlap stress test.
  const stressList: Array<Partial<PoppetjeStruct>> = [
    { hat: 'hood', accessory: 'glasses', hairShape: 'long' },
    { hat: 'straw', facialHair: 'beard', dress: 'turtleneck' },
    { hat: 'beanie', facialHair: 'mustache', hairShape: 'braids' },
    { hat: 'newsboy', accessory: 'monocle', dress: 'collar' },
    { hat: 'kerchief', accessory: 'earrings', hairShape: 'bun' },
    { hat: 'cap', mark: 'freckles', dress: 'scarf' },
    // Wearable + facial hair now coexist — the split lets a gezel have
    // both glasses and a beard, which the old single slot couldn't hold.
    { hat: null, accessory: 'glasses', facialHair: 'beard', hairShape: 'long' },
    { hat: 'hood', accessory: 'earrings', facialHair: 'mustache', dress: 'turtleneck' },
    // New-accessory stress: eyewear under a hat brim, chest jewelry over a
    // beard + garment, and a hat suppressing a hair-zone accessory.
    { hat: 'cap', accessory: 'eyepatch', facialHair: 'beard' },
    { hat: null, accessory: 'necklace', facialHair: 'beard', dress: 'turtleneck' },
    { hat: 'straw', accessory: 'headband', hairShape: 'braids' },
    { hat: 'beanie', accessory: 'headphones', hairShape: 'waves' },
    { hat: 'cap', accessory: 'hearing-aid', facialHair: 'stubble' },
    { hat: 'hood', accessory: 'safety-glasses', dress: 'scarf' },
    { hat: null, accessory: 'pencil', hairShape: 'bun' },
    { hat: null, accessory: 'necktie', facialHair: 'beard', dress: 'collar' },
    { hat: null, accessory: 'lanyard', dress: 'apron' },
  ];
  stressList.forEach((patch, i) => {
    tiles.push({
      id: `combo-${i}`,
      label: `combo ${i}`,
      group: 'Hard combos',
      poppetje: override(bodyFixed, { ...patch, key: `combo-${i}` }),
    });
  });

  // ── 13. Real application crops. The original harness rendered every
  // catalog slot as a generous 180px full figure, while the product mostly
  // uses 28–56px icon/headshot crops. Keep these in the visual gallery but
  // out of the full-body metric, whose occupancy bounds assume visible feet.
  const contextSeeds = [0, 8, 13, 16, 29, 31];
  for (const seed of contextSeeds) {
    const poppetje = poppetjeFromSeed(seed, { key: `context-${seed}`, name: `Context ${seed}` });
    for (const surface of ['light', 'dark'] as const) {
      tiles.push({
        id: `context-icon-${surface}-${seed}`,
        label: `icon / ${surface} / ${seed}`,
        group: 'Application crops',
        poppetje,
        variant: 'icon',
        size: 44,
        surface,
        evaluate: false,
      });
      tiles.push({
        id: `context-headshot-${surface}-${seed}`,
        label: `headshot / ${surface} / ${seed}`,
        group: 'Application crops',
        poppetje,
        variant: 'headshot',
        size: 72,
        surface,
        evaluate: false,
      });
    }
  }

  return tiles;
}

function renderHtml(tiles: Tile[]): string {
  const groups = new Map<string, Tile[]>();
  for (const t of tiles) {
    if (!groups.has(t.group)) groups.set(t.group, []);
    groups.get(t.group)!.push(t);
  }

  const groupsHtml = Array.from(groups.entries())
    .map(([group, list]) => {
      const tileHtml = list
        .map((tile) => {
          const svg = renderToStaticMarkup(
            React.createElement(Poppetje, {
              poppetje: tile.poppetje,
              size: tile.size ?? 180,
              grainStyle: tile.grainStyle ?? 'wavy',
              variant: tile.variant ?? 'full',
              // Every tile is a separate renderToStaticMarkup call, so
              // useId would hand all 93 figures the same def ids and the
              // browser would resolve every gradient/filter to the FIRST
              // tile's defs (one shirt color, one skin for the whole
              // gallery). The tile id namespaces them.
              svgId: tile.id,
            }),
          );
          const art =
            tile.evaluate === false
              ? `<div class="context-frame" style="width:${tile.size ?? 56}px;height:${tile.size ?? 56}px">${svg}</div>`
              : svg;
          return `
  <figure class="tile${tile.surface === 'dark' ? ' tile-dark' : ''}" data-tile-id="${tile.id}" id="tile-${tile.id}">
    <div class="art">${art}</div>
    <figcaption>${tile.label}</figcaption>
  </figure>`;
        })
        .join('\n');
      return `
<section class="group">
  <h2>${group}</h2>
  <div class="tiles">${tileHtml}</div>
</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Poppetje gallery</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f1ece2;
    --card: #fbf6ea;
    --ink: #2b231a;
    --rule: #d5c7af;
  }
  body {
    margin: 0;
    padding: 32px;
    background: var(--bg);
    color: var(--ink);
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  h1 { margin: 0 0 8px; font-size: 22px; }
  h2 { margin: 32px 0 12px; font-size: 16px; color: #6b5a40; border-bottom: 1px solid var(--rule); padding-bottom: 6px; }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 16px;
  }
  .tile {
    margin: 0;
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: 8px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .tile-dark {
    background: #29251f;
    border-color: #4b4439;
  }
  .art {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 220px;
  }
  .context-frame {
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .context-frame svg {
    width: auto;
    max-width: 100%;
    height: 100%;
    max-height: 100%;
  }
  figcaption {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    color: #6b5a40;
    text-align: center;
  }
  .tile-dark figcaption { color: #d7c9ae; }
</style>
</head>
<body>
<h1>Poppetje gallery — visual QA</h1>
${groupsHtml}
</body>
</html>`;
}

async function main(): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await mkdir(join(outDir, 'tiles'), { recursive: true });
  await mkdir(join(outDir, 'contexts'), { recursive: true });

  const tiles = buildTiles();
  const html = renderHtml(tiles);
  await writeFile(htmlPath, html, 'utf8');
  console.log(`[gallery] wrote ${htmlPath} (${tiles.length} tiles)`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(pathToFileURL(htmlPath).toString(), { waitUntil: 'load' });

  // Overview screenshot — the full page, one PNG.
  await page.screenshot({
    path: join(outDir, 'overview.png'),
    fullPage: true,
  });
  console.log('[gallery] overview.png written');

  // Per-tile close-ups.
  for (const tile of tiles) {
    const locator = page.locator(`#tile-${tile.id}`);
    await locator.scrollIntoViewIfNeeded();
    const tileDir = tile.evaluate === false ? 'contexts' : 'tiles';
    await locator.screenshot({ path: join(outDir, tileDir, `${tile.id}.png`) });
  }
  const evalCount = tiles.filter((tile) => tile.evaluate !== false).length;
  const contextCount = tiles.length - evalCount;
  console.log(
    `[gallery] ${evalCount} eval tile PNGs + ${contextCount} context PNGs written to ${outDir}`,
  );

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
