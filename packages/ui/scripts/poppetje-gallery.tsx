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
 * rendering strategy in docs/poppetje-rendering.md.
 *
 * Run: pnpm poppetje:review (gallery, category sheets, and evaluation).
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ACCESSORY_OPTIONS,
  BANGS_OPTIONS,
  BODY_SHAPE_KEYS,
  DRESS_OPTIONS,
  EXPRESSION_OPTIONS,
  FACIAL_HAIR_OPTIONS,
  FIGURE_SCALE_KEYS,
  GRAIN_PRESETS,
  type GrainStyle,
  HAIR_PART_OPTIONS,
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
  grainStyle?: GrainStyle;
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
    bodyShape: 'tapered',
    figureScale: 'adult',
    facialHair: null,
    hat: null,
    dress: null,
    accessory: null,
    mark: null,
    hairShape: 'short',
    bangs: null,
    hairPart: 'none',
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
      poppetje: override(bodyFixed, { bodyShape: shape, key: 'catalog-comparison' }),
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
        key: 'catalog-comparison',
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
        key: 'catalog-comparison',
      }),
    });
  }

  // ── 4. Hats — fixed body, no dress/accessory.
  for (const bangs of [null, ...BANGS_OPTIONS]) {
    tiles.push({
      id: `bangs-${bangs ?? 'none'}`,
      label: `bangs / ${bangs ?? 'none'}`,
      group: 'Bangs',
      poppetje: override(bodyFixed, { hairShape: 'medium', bangs, key: 'catalog-comparison' }),
    });
  }
  for (const hairPart of HAIR_PART_OPTIONS) {
    tiles.push({
      id: `part-${hairPart}`,
      label: `part / ${hairPart}`,
      group: 'Hair parts',
      poppetje: override(bodyFixed, { hairShape: 'long', hairPart, key: 'catalog-comparison' }),
    });
  }
  // Every length/fringe/part combination uses the same color and wood key.
  for (const hairShape of HAIR_SHAPES.filter((h) => h !== 'bald' && h !== 'shaved')) {
    for (const bangs of [null, ...BANGS_OPTIONS]) {
      for (const hairPart of HAIR_PART_OPTIONS) {
        tiles.push({
          id: `hair-matrix-${hairShape}-${bangs ?? 'none'}-${hairPart}`,
          label: `${bangs ?? 'no bangs'} / ${hairPart} part`,
          group: `Hair combinations - ${hairShape}`,
          variant: 'headshot',
          size: 120,
          poppetje: override(bodyFixed, { hairShape, bangs, hairPart, key: 'catalog-comparison' }),
          evaluate: false,
        });
      }
    }
  }

  for (const hat of HAT_OPTIONS) {
    tiles.push({
      id: `hat-${hat}`,
      label: `hat / ${hat}`,
      group: 'Hats',
      poppetje: override(bodyFixed, { hat, key: 'catalog-comparison' }),
    });
  }

  // ── 5. Dresses — fixed body, no hat/accessory.
  for (const dress of DRESS_OPTIONS) {
    tiles.push({
      id: `dress-${dress}`,
      label: `dress / ${dress}`,
      group: 'Dress overlays',
      poppetje: override(bodyFixed, { dress, key: 'catalog-comparison' }),
    });
  }

  // ── 6. Accessories — fixed body, no hat/dress.
  for (const accessory of ACCESSORY_OPTIONS) {
    tiles.push({
      id: `accessory-${accessory}`,
      label: `accessory / ${accessory}`,
      group: 'Accessories',
      poppetje: override(bodyFixed, { accessory, key: 'catalog-comparison' }),
    });
  }

  // ── 6b. Facial hair + marks — physical features in their own slots.
  for (const facialHair of FACIAL_HAIR_OPTIONS) {
    tiles.push({
      id: `facial-${facialHair}`,
      label: `facialHair / ${facialHair}`,
      group: 'Facial features',
      poppetje: override(bodyFixed, { facialHair, key: 'catalog-comparison' }),
    });
  }
  for (const mark of MARK_OPTIONS) {
    tiles.push({
      id: `mark-${mark}`,
      label: `mark / ${mark}`,
      group: 'Facial features',
      poppetje: override(bodyFixed, { mark, key: 'catalog-comparison' }),
    });
  }

  // ── 7. Expressions — face only.
  for (const expression of EXPRESSION_OPTIONS) {
    tiles.push({
      id: `expr-${expression}`,
      label: `expression / ${expression}`,
      group: 'Expressions',
      poppetje: override(bodyFixed, { expression, key: 'catalog-comparison' }),
    });
  }

  // ── 7b. Shirt patterns — painted garment structure on a fixed body.
  for (const shirtPattern of SHIRT_PATTERN_OPTIONS) {
    tiles.push({
      id: `pattern-${shirtPattern}`,
      label: `pattern / ${shirtPattern}`,
      group: 'Shirt patterns',
      poppetje: override(bodyFixed, { shirtPattern, key: 'catalog-comparison' }),
    });
  }

  // ── 8. Grain styles — one identical figure, varying only the finish.
  for (const grain of Object.keys(GRAIN_PRESETS)) {
    tiles.push({
      id: `grain-${grain}`,
      label: `grain / ${grain}`,
      group: 'Wood grain',
      poppetje: override(bodyFixed, { key: 'grain-preset-comparison' }),
      grainStyle: grain as GrainStyle,
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

  // Same slots and default finish; only the stable individual key changes.
  // This catches a material pass that keeps variety in code but loses it in pixels.
  for (let n = 0; n < 12; n++) {
    tiles.push({
      id: `wood-individual-${n}`,
      label: `wood / individual ${n + 1}`,
      group: 'Seeded wood variation',
      poppetje: override(bodyFixed, { key: `wood-variation-${n}` }),
    });
  }

  // ── 9. Skin tones (head-and-shoulders crop).
  PALETTE.skins.forEach((s, i) => {
    tiles.push({
      id: `skin-${i}`,
      label: `skin #${i}`,
      group: 'Skins',
      poppetje: override(bodyFixed, {
        skin: s.skin,
        skin2: s.skin2,
        key: 'catalog-comparison',
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
        key: 'catalog-comparison',
      }),
    });
  });

  PALETTE.hairs.forEach((hair, i) => {
    tiles.push({
      id: `hair-color-${i}`,
      label: `hair color / ${i + 1}`,
      group: 'Hair colors',
      poppetje: override(bodyFixed, {
        hair,
        hairShape: i % 2 ? 'braids' : 'extra-long',
        bangs: BANGS_OPTIONS[i % BANGS_OPTIONS.length]!,
        hairPart: HAIR_PART_OPTIONS[i % HAIR_PART_OPTIONS.length]!,
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
    { hat: 'beanie', accessory: 'headphones', hairShape: 'halo' },
    { hat: 'cap', accessory: 'hearing-aid', facialHair: 'mustache' },
    { hat: 'hood', accessory: 'safety-glasses', dress: 'scarf' },
    { hat: null, accessory: 'pencil', hairShape: 'bun' },
    { hat: null, accessory: 'necktie', facialHair: 'beard', dress: 'collar' },
    { hat: null, accessory: 'lanyard', dress: 'apron' },
    {
      hairShape: 'extra-long',
      bangs: 'curtain',
      hairPart: 'left',
      dress: 'scarf',
      accessory: 'glasses',
    },
    { hairShape: 'bob', bangs: 'straight', hairPart: 'right', accessory: 'headphones' },
    { hairShape: 'braids', bangs: 'side-swept', hairPart: 'right', accessory: 'ribbon' },
    { hairShape: 'extra-long', bangs: 'short', hairPart: 'center', hat: 'straw' },
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

  for (const surface of ['light', 'dark'] as const) {
    for (const size of [16, 24, 32, 40, 56]) {
      for (const [i, skin] of PALETTE.skins.entries()) {
        tiles.push({
          id: `size-${surface}-${size}-skin-${i}`,
          label: `${size}px / skin ${i + 1} / ${surface}`,
          group: 'Actual avatar sizes',
          poppetje: override(bodyFixed, { ...skin, key: 'avatar-size-comparison' }),
          variant: 'icon',
          size,
          surface,
          evaluate: false,
        });
      }
    }
  }
  const silhouettes: Array<Partial<PoppetjeStruct>> = [
    ...HAT_OPTIONS.map((hat) => ({ hat })),
    ...HAIR_SHAPES.map((hairShape) => ({ hairShape })),
    ...BANGS_OPTIONS.map((bangs) => ({ bangs, hairShape: 'medium' as const })),
    ...HAIR_PART_OPTIONS.map((hairPart) => ({ hairPart, hairShape: 'extra-long' as const })),
    { accessory: 'headphones' },
    { accessory: 'feather' },
  ];
  for (const [i, patch] of silhouettes.entries()) {
    for (const surface of ['light', 'dark'] as const) {
      for (const variant of ['icon', 'headshot'] as const) {
        tiles.push({
          id: `silhouette-${i}-${variant}-${surface}`,
          label: `${Object.values(patch)[0]} / ${variant} / ${surface}`,
          group: 'Silhouette crops',
          poppetje: override(bodyFixed, patch),
          variant,
          size: variant === 'icon' ? 40 : 56,
          surface,
          evaluate: false,
        });
      }
    }
  }
  return tiles;
}

function renderHtml(tiles: Tile[], compact = false): string {
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
              size: tile.size ?? (compact ? 88 : 180),
              grainStyle: tile.grainStyle ?? 'wavy',
              variant: tile.variant ?? 'full',
              // Every tile is a separate renderToStaticMarkup call, so
              // useId would hand all figures the same def ids and the
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
  <figure class="tile${tile.evaluate === false ? ' context-tile' : ''}${tile.surface === 'dark' ? ' tile-dark' : ''}" data-tile-id="${tile.id}" id="tile-${tile.id}">
    <div class="art">${art}</div>
    <figcaption>${tile.label}</figcaption>
  </figure>`;
        })
        .join('\n');
      return `
<section class="group${group.startsWith('Hair combinations') ? ' hair-matrix' : ''}">
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
  .hair-matrix .tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); }
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
  .context-tile .art { min-height: 80px; }
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
  .compact { padding: 24px; }
  .compact .tiles { grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 8px; }
  .compact .tile { padding: 6px; gap: 4px; }
  .compact .art { min-height: 196px; }
  .compact figcaption { font-size: 10px; }
  .compact h2 { margin-top: 20px; }
</style>
</head>
<body class="${compact ? 'compact' : ''}">
<h1>Poppetje diversity ${compact ? 'sheet' : 'gallery'}</h1>
<p>${tiles.length} deterministic examples. Every catalog option, independent of gender or craft.</p>
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
  await writeFile(
    join(outDir, 'manifest.json'),
    JSON.stringify(
      {
        tiles: tiles.map(
          ({ id, label, group, poppetje, variant, size, grainStyle, evaluate, surface }) => ({
            id,
            label,
            group,
            poppetje,
            variant: variant ?? 'full',
            grainStyle: grainStyle ?? 'wavy',
            size: size ?? 180,
            surface: surface ?? 'light',
            evaluate: evaluate !== false,
            path: `${evaluate === false ? 'contexts' : 'tiles'}/${id}.png`,
          }),
        ),
      },
      null,
      2,
    ),
  );
  const sheetPath = join(outDir, 'sheet.html');
  await writeFile(
    sheetPath,
    renderHtml(
      tiles.filter((t) => t.evaluate !== false),
      true,
    ),
    'utf8',
  );
  const hairSheetPath = join(outDir, 'hair-sheet.html');
  await writeFile(
    hairSheetPath,
    renderHtml(tiles.filter((t) => ['Hair shapes', 'Bangs', 'Hair parts'].includes(t.group))),
    'utf8',
  );
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

  await page.goto(pathToFileURL(sheetPath).toString(), { waitUntil: 'load' });
  await page.screenshot({ path: join(outDir, 'diversity-sheet.png'), fullPage: true });
  await page.goto(pathToFileURL(hairSheetPath).toString(), { waitUntil: 'load' });
  await page.screenshot({ path: join(outDir, 'hair-sheet.png'), fullPage: true });
  console.log('[gallery] diversity-sheet.png + hair-sheet.png + manifest.json written');
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
