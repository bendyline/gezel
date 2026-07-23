/**
 * Poppetje visual-quality eval.
 *
 * Reads the PNG tiles emitted by `poppetje-gallery.tsx` and scores the
 * rendered figures with deterministic image metrics. The rubric is tuned for
 * the poppetje design goal: friendly carved figures that read clearly as small
 * avatars with subtle material texture, without noisy literal wood grain.
 *
 * Run after the gallery:
 *   pnpm --filter @bendyline/gezel-ui exec tsx scripts/poppetje-eval.ts
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const _dirname = dirname(fileURLToPath(import.meta.url));
const defaultOutDir = resolve(_dirname, '..', '..', '..', 'tmp', 'poppetjes');
const outDir = process.argv[2] ? resolve(process.argv[2]) : defaultOutDir;
const tilesDir = join(outDir, 'tiles');
const reportPath = join(outDir, 'eval-report.json');

interface TileEval {
  id: string;
  file: string;
  score: number;
  metrics: {
    readability: number;
    material: number;
    woodiness: number;
    woodTargetFit: number;
    woodSoftness: number;
    hatFit: number;
    hatSkinSpill: number;
    face: number;
    scale: number;
    width: number;
    centering: number;
    margins: number;
    occupancy: number;
    textureBalance: number;
    noiseControl: number;
    tonalSeparation: number;
    colorSeparation: number;
    faceMarks: number;
    bbox: { x: number; y: number; width: number; height: number };
    edgeDensity: number;
    harshEdgeDensity: number;
    luminanceStdDev: number;
    meanSaturation: number;
    foregroundRatio: number;
  };
}

interface EvalReport {
  generatedAt: string;
  outDir: string;
  tileCount: number;
  score: number;
  averageTileScore: number;
  weakTileScore: number;
  p10TileScore: number;
  averageWoodiness: number;
  averageHatFit: number;
  weakestTiles: Array<Pick<TileEval, 'id' | 'score'>>;
  tiles: TileEval[];
}

async function main(): Promise<void> {
  const files = (await readdir(tilesDir))
    .filter((file) => file.endsWith('.png'))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    throw new Error(`No PNG tiles found in ${tilesDir}; run poppetje-gallery.tsx first.`);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(pathToFileURL(join(outDir, 'index.html')).toString(), { waitUntil: 'load' });
  await page.evaluate('globalThis.__name = (fn) => fn');

  const inputs = await Promise.all(
    files.map(async (file) => {
      const bytes = await readFile(join(tilesDir, file));
      return {
        id: file.replace(/\.png$/u, ''),
        file,
        url: `data:image/png;base64,${bytes.toString('base64')}`,
      };
    }),
  );

  const tiles = await page.evaluate(async (items): Promise<TileEval[]> => {
    const bg = { r: 251, g: 246, b: 234 };

    function clamp01(value: number): number {
      return Math.max(0, Math.min(1, value));
    }

    function band(
      value: number,
      goodMin: number,
      goodMax: number,
      failMin: number,
      failMax: number,
    ): number {
      if (value >= goodMin && value <= goodMax) return 1;
      if (value < goodMin) return clamp01((value - failMin) / (goodMin - failMin));
      return clamp01((failMax - value) / (failMax - goodMax));
    }

    function distanceFromBg(r: number, g: number, b: number): number {
      return Math.hypot(r - bg.r, g - bg.g, b - bg.b);
    }

    function luminance(r: number, g: number, b: number): number {
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function saturation(r: number, g: number, b: number): number {
      const max = Math.max(r, g, b) / 255;
      const min = Math.min(r, g, b) / 255;
      return max === 0 ? 0 : (max - min) / max;
    }

    function loadImage(src: string): Promise<HTMLImageElement> {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load ${src}`));
        img.src = src;
      });
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2d canvas unavailable');

    const results: TileEval[] = [];
    for (const item of items) {
      const img = await loadImage(item.url);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const artBottom = Math.floor(h - 46);

      canvas.width = w;
      canvas.height = h;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, w, h).data;

      const mask = new Uint8Array(w * h);
      let minX = w;
      let minY = h;
      let maxX = 0;
      let maxY = 0;
      let fg = 0;
      let lumSum = 0;
      let lumSqSum = 0;
      let satSum = 0;

      for (let y = 6; y < artBottom; y++) {
        for (let x = 6; x < w - 6; x++) {
          const i = (y * w + x) * 4;
          const a = data[i + 3] ?? 0;
          if (a < 32) continue;
          const r = data[i] ?? 0;
          const g = data[i + 1] ?? 0;
          const b = data[i + 2] ?? 0;
          if (distanceFromBg(r, g, b) <= 28) continue;

          const p = y * w + x;
          mask[p] = 1;
          fg++;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);

          const lum = luminance(r, g, b);
          lumSum += lum;
          lumSqSum += lum * lum;
          if (lum > 32 && lum < 235) satSum += saturation(r, g, b);
        }
      }

      if (fg === 0) {
        results.push({
          id: item.id,
          file: item.file,
          score: 0,
          metrics: {
            readability: 0,
            material: 0,
            woodiness: 100,
            woodTargetFit: 0,
            woodSoftness: 0,
            hatFit: 0,
            hatSkinSpill: 1,
            face: 0,
            scale: 0,
            width: 0,
            centering: 0,
            margins: 0,
            occupancy: 0,
            textureBalance: 0,
            noiseControl: 0,
            tonalSeparation: 0,
            colorSeparation: 0,
            faceMarks: 0,
            bbox: { x: 0, y: 0, width: 0, height: 0 },
            edgeDensity: 0,
            harshEdgeDensity: 0,
            luminanceStdDev: 0,
            meanSaturation: 0,
            foregroundRatio: 0,
          },
        });
        continue;
      }

      let edgeCount = 0;
      let harshEdgeCount = 0;
      for (let y = minY + 1; y < maxY - 1; y++) {
        for (let x = minX + 1; x < maxX - 1; x++) {
          const p = y * w + x;
          if (!mask[p]) continue;
          const i = p * 4;
          const lum = luminance(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
          const right = (y * w + x + 1) * 4;
          const down = ((y + 1) * w + x) * 4;
          const gx = Math.abs(
            lum - luminance(data[right] ?? 0, data[right + 1] ?? 0, data[right + 2] ?? 0),
          );
          const gy = Math.abs(
            lum - luminance(data[down] ?? 0, data[down + 1] ?? 0, data[down + 2] ?? 0),
          );
          const gradient = Math.max(gx, gy);
          if (gradient > 14) edgeCount++;
          if (gradient > 42) harshEdgeCount++;
        }
      }

      const bboxW = maxX - minX + 1;
      const bboxH = maxY - minY + 1;
      const figureArea = bboxW * bboxH;
      const foregroundRatio = fg / Math.max(1, figureArea);
      const edgeDensity = edgeCount / fg;
      const harshEdgeDensity = harshEdgeCount / fg;
      const meanLum = lumSum / fg;
      const lumVariance = Math.max(0, lumSqSum / fg - meanLum * meanLum);
      const luminanceStdDev = Math.sqrt(lumVariance);
      const meanSaturation = satSum / fg;

      const scale = band(bboxH / artBottom, 0.68, 0.88, 0.48, 1.0);
      const width = band(bboxW / w, 0.3, 0.56, 0.18, 0.72);
      const centering = clamp01(1 - Math.abs((minX + bboxW / 2) / w - 0.5) / 0.14);
      const margins = Math.min(
        band(minX, 12, 60, 0, 90),
        band(w - maxX, 12, 60, 0, 90),
        band(minY, 12, 90, 0, 130),
        band(artBottom - maxY, 5, 55, -8, 90),
      );
      const occupancy = band(foregroundRatio, 0.36, 0.72, 0.18, 0.9);

      // Edge/noise bands are calibrated to the CURRENT design language:
      // figures carry crisp painted detail (glasses rims, garment patterns,
      // apron boundaries, hat felts) on a soft-grained substrate. Ablation
      // shows the grain itself contributes almost nothing to these counts —
      // grain-none vs grain-character differ by <0.004 edge density — so
      // the old bands (tuned for featureless single-color robes) were
      // punishing legitimate iconic paint as if it were texture noise.
      // The bands still fail on real blowups: scratchy filters, dense
      // stroke spam, or tonal chaos push edge/harsh well past 0.13/0.05.
      const textureBalance = band(edgeDensity, 0.04, 0.125, 0.015, 0.24);
      const noiseControl = band(harshEdgeDensity, 0.008, 0.045, 0, 0.09);
      const tonalSeparation = band(luminanceStdDev, 30, 62, 12, 92);
      const colorSeparation = band(meanSaturation, 0.18, 0.52, 0.06, 0.82);
      const woodiness =
        100 *
        (0.42 * clamp01((edgeDensity - 0.025) / 0.1) +
          0.38 * clamp01((harshEdgeDensity - 0.015) / 0.06) +
          0.2 * clamp01((luminanceStdDev - 18) / 55));
      const woodTargetFit = 100 * band(woodiness, 20, 58, 8, 82);
      const woodSoftness = 100 - woodiness;

      let faceDark = 0;
      let faceZone = 0;
      const faceMinX = Math.floor(minX + bboxW * 0.28);
      const faceMaxX = Math.ceil(minX + bboxW * 0.72);
      const faceMinY = Math.floor(minY + bboxH * 0.08);
      const faceMaxY = Math.ceil(minY + bboxH * 0.42);
      for (let y = faceMinY; y <= faceMaxY; y++) {
        for (let x = faceMinX; x <= faceMaxX; x++) {
          const i = (y * w + x) * 4;
          const lum = luminance(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
          const dist = distanceFromBg(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
          if (dist > 28) faceZone++;
          // Dark threshold 32 sits between the painted features (#1a1410,
          // lum ≈ 21) and the deepest catalog skin edge (#3d2418, lum ≈ 40).
          // The old threshold of 48 counted the entire face of deep-skinned
          // figures as "marks" — invisible until the gallery's def-id
          // collision was fixed and tiles started rendering true skins.
          if (lum < 32 && dist > 28) faceDark++;
        }
      }
      const faceMarks = band(faceDark / Math.max(1, faceZone), 0.008, 0.08, 0.001, 0.18);

      let hatTopSkin = 0;
      let hatTopForeground = 0;
      const isHatTile = item.id.startsWith('hat-');
      if (isHatTile) {
        let skinR = 0;
        let skinG = 0;
        let skinB = 0;
        let skinCount = 0;
        // Sample the central upper face, staying clear of hoods, hair sides,
        // glasses temples, and the torso. A broad 22–36% Y band used to pull
        // shirt/hood paint into the "skin" average once materials gained
        // modeled gradients, then falsely penalized dimensional hats.
        const faceSampleMinX = Math.floor(minX + bboxW * 0.38);
        const faceSampleMaxX = Math.ceil(minX + bboxW * 0.62);
        const faceSampleMinY = Math.floor(minY + bboxH * 0.23);
        const faceSampleMaxY = Math.ceil(minY + bboxH * 0.31);
        for (let y = faceSampleMinY; y <= faceSampleMaxY; y++) {
          for (let x = faceSampleMinX; x <= faceSampleMaxX; x++) {
            const i = (y * w + x) * 4;
            const r = data[i] ?? 0;
            const g = data[i + 1] ?? 0;
            const b = data[i + 2] ?? 0;
            const lum = luminance(r, g, b);
            if (distanceFromBg(r, g, b) <= 28 || lum < 60 || lum > 220) continue;
            skinR += r;
            skinG += g;
            skinB += b;
            skinCount++;
          }
        }
        const sampledSkin =
          skinCount > 0
            ? { r: skinR / skinCount, g: skinG / skinCount, b: skinB / skinCount }
            : null;
        const hatMinY = minY;
        const hatMaxY = Math.floor(minY + bboxH * 0.1);
        const hatMinX = Math.floor(minX + bboxW * 0.08);
        const hatMaxX = Math.ceil(maxX - bboxW * 0.08);
        for (let y = hatMinY; y <= hatMaxY; y++) {
          for (let x = hatMinX; x <= hatMaxX; x++) {
            const i = (y * w + x) * 4;
            const r = data[i] ?? 0;
            const g = data[i + 1] ?? 0;
            const b = data[i + 2] ?? 0;
            if (distanceFromBg(r, g, b) <= 28) continue;
            hatTopForeground++;
            if (
              sampledSkin &&
              // True exposed head pixels stay close to the central skin
              // sample. A tighter threshold avoids treating a warm highlight
              // on green/purple painted cloth as leaked skin.
              Math.hypot(r - sampledSkin.r, g - sampledSkin.g, b - sampledSkin.b) < 34
            ) {
              hatTopSkin++;
            }
          }
        }
      }
      const hatSkinSpill = isHatTile ? hatTopSkin / Math.max(1, hatTopForeground) : 0;
      const hatFit = isHatTile ? 100 * (1 - clamp01((hatSkinSpill - 0.08) / 0.24)) : 100;

      const readability =
        100 * (0.28 * scale + 0.22 * width + 0.24 * centering + 0.16 * margins + 0.1 * occupancy);
      const material =
        100 *
        (0.48 * (woodTargetFit / 100) +
          0.28 * noiseControl +
          0.12 * tonalSeparation +
          0.12 * colorSeparation);
      const face = 100 * faceMarks;
      const score = 0.42 * readability + 0.3 * material + 0.15 * face + 0.13 * hatFit;

      results.push({
        id: item.id,
        file: item.file,
        score: Number(score.toFixed(2)),
        metrics: {
          readability: Number(readability.toFixed(2)),
          material: Number(material.toFixed(2)),
          woodiness: Number(woodiness.toFixed(2)),
          woodTargetFit: Number(woodTargetFit.toFixed(2)),
          woodSoftness: Number(woodSoftness.toFixed(2)),
          hatFit: Number(hatFit.toFixed(2)),
          hatSkinSpill: Number(hatSkinSpill.toFixed(4)),
          face: Number(face.toFixed(2)),
          scale: Number((scale * 100).toFixed(2)),
          width: Number((width * 100).toFixed(2)),
          centering: Number((centering * 100).toFixed(2)),
          margins: Number((margins * 100).toFixed(2)),
          occupancy: Number((occupancy * 100).toFixed(2)),
          textureBalance: Number((textureBalance * 100).toFixed(2)),
          noiseControl: Number((noiseControl * 100).toFixed(2)),
          tonalSeparation: Number((tonalSeparation * 100).toFixed(2)),
          colorSeparation: Number((colorSeparation * 100).toFixed(2)),
          faceMarks: Number((faceMarks * 100).toFixed(2)),
          bbox: { x: minX, y: minY, width: bboxW, height: bboxH },
          edgeDensity: Number(edgeDensity.toFixed(4)),
          harshEdgeDensity: Number(harshEdgeDensity.toFixed(4)),
          luminanceStdDev: Number(luminanceStdDev.toFixed(2)),
          meanSaturation: Number(meanSaturation.toFixed(4)),
          foregroundRatio: Number(foregroundRatio.toFixed(4)),
        },
      });
    }
    return results;
  }, inputs);

  await browser.close();

  const sorted = [...tiles].sort((a, b) => a.score - b.score);
  const averageTileScore = mean(tiles.map((tile) => tile.score));
  const weakTileScore = mean(sorted.slice(0, Math.min(8, sorted.length)).map((tile) => tile.score));
  const averageWoodiness = mean(tiles.map((tile) => tile.metrics.woodiness));
  const hatTiles = tiles.filter((tile) => tile.id.startsWith('hat-'));
  const averageHatFit = mean(hatTiles.map((tile) => tile.metrics.hatFit));
  const p10TileScore = percentile(
    tiles.map((tile) => tile.score).sort((a, b) => a - b),
    0.1,
  );
  const score = Number((averageTileScore * 0.35 + weakTileScore * 0.65).toFixed(2));

  const report: EvalReport = {
    generatedAt: new Date().toISOString(),
    outDir,
    tileCount: tiles.length,
    score,
    averageTileScore: Number(averageTileScore.toFixed(2)),
    weakTileScore: Number(weakTileScore.toFixed(2)),
    p10TileScore: Number(p10TileScore.toFixed(2)),
    averageWoodiness: Number(averageWoodiness.toFixed(2)),
    averageHatFit: Number(averageHatFit.toFixed(2)),
    weakestTiles: sorted.slice(0, 12).map((tile) => ({ id: tile.id, score: tile.score })),
    tiles,
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`[poppetje-eval] score ${report.score}/100`);
  console.log(
    `[poppetje-eval] average ${report.averageTileScore}/100, weak ${report.weakTileScore}/100, p10 ${report.p10TileScore}/100, tiles ${report.tileCount}`,
  );
  console.log(
    `[poppetje-eval] woodiness ${report.averageWoodiness}/100 (target 20-58), hat-fit ${report.averageHatFit}/100`,
  );
  console.log(
    `[poppetje-eval] weakest: ${report.weakestTiles
      .slice(0, 6)
      .map((tile) => `${tile.id} ${tile.score}`)
      .join(', ')}`,
  );
  console.log(`[poppetje-eval] wrote ${reportPath}`);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index] ?? 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
