import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

import { Resvg } from '@resvg/resvg-js';

/*
 * The phone icons, drawn from the desktop's textured mark (assets/icon-mac.png).
 * That art is a macOS icon: a rounded card on a transparent margin. Copied as-is,
 * iOS filled the margin into a thick border around the icon and Android's
 * launcher mask cut into the card, leaving the bench against the edges. So the
 * paper is laid full-bleed and the bench is set at a size each platform's mask
 * leaves room for.
 */

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = join(appDir, '..', '..');
const mobileDir = join(repoDir, 'packages', 'mobile');
const checkOnly = process.argv.includes('--check');

// Measured on icon-mac.png at 1024 px: the bench's bounds, with a few pixels
// of margin for its anti-aliased edge, and the paper's average colour.
const SOURCE_CENTER = 512;
const BENCH = { x: 192, y: 265, width: 596, height: 502 };
const PAPER = { r: 125, g: 140, b: 113 };

// The bench keeps its own colours, grain lines included; only its alpha is
// keyed off luminance, from 0 at 0.56 to 1 at 0.75. The paper tops out near
// 0.57 and the bench's faintest grain sits near 0.75.
const BENCH_KEY = '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  1.119 3.764 0.380 0 -2.947';

// The paper's grain, drawn rather than copied. The card has no bare stretch
// big enough to tile, and mirrored tiles of the band above the bench repeated
// as visible blotches. Two noise scales, mottling and fine grain, sized to the
// card's own variation (about 3.5 levels of luminance, most of it mottling).
function paperGrain() {
  const spread = 0.16;
  const row = (channel) => `${spread} 0 0 0 ${(channel / 255 - spread / 2).toFixed(4)}`;
  return `<filter id="paper" x="0" y="0" width="1024" height="1024" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.014" numOctaves="4" seed="7" result="mottle"/>
    <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="1" seed="3" result="grain"/>
    <feComposite in="mottle" in2="grain" operator="arithmetic" k2="0.8" k3="1.0"/>
    <feColorMatrix type="matrix" values="${row(PAPER.r)}  ${row(PAPER.g)}  ${row(PAPER.b)}  0 0 0 0 1"/>
  </filter>`;
}

const sourceHref = `data:image/png;base64,${(await readFile(join(appDir, 'assets', 'icon-mac.png'))).toString('base64')}`;

/**
 * @param {{ size: number, paper: boolean, bench?: number }} spec `bench` is the
 *   bench's width as a fraction of the canvas.
 */
function iconSvg({ size, paper, bench }) {
  const layers = [];
  if (paper) {
    // Drawn in the card's 1024-unit space and scaled, so the grain matches at
    // every output size.
    layers.push(`<defs>${paperGrain()}</defs>
<g transform="scale(${size / 1024})"><rect width="1024" height="1024" filter="url(#paper)"/></g>`);
  }
  if (bench) {
    // Scaled about the card's centre, so the bench keeps the offset its vise
    // gives it in the desktop art.
    const scale = (bench * size) / (BENCH.width - 12);
    const x = size / 2 + (BENCH.x - SOURCE_CENTER) * scale;
    const y = size / 2 + (BENCH.y - SOURCE_CENTER) * scale;
    layers.push(`<defs>
  <filter id="bench" color-interpolation-filters="sRGB">
    <feColorMatrix type="matrix" values="${BENCH_KEY}"/>
  </filter>
</defs>
<g filter="url(#bench)">
  <svg x="${x}" y="${y}" width="${BENCH.width * scale}" height="${BENCH.height * scale}" viewBox="${BENCH.x} ${BENCH.y} ${BENCH.width} ${BENCH.height}"><use href="#source"/></svg>
</g>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<defs><image id="source" width="1024" height="1024" href="${sourceHref}"/></defs>
${layers.join('\n')}
</svg>`;
}

function render(spec) {
  const image = new Resvg(iconSvg(spec), { fitTo: { mode: 'width', value: spec.size } }).render();
  assert.equal(image.width, spec.size);
  assert.equal(image.height, spec.size);
  return image;
}

/** App Store icons must be opaque, and a PNG that merely has no transparent
 * pixel still carries the alpha channel the validator rejects. */
function opaquePng({ width, height, pixels }) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      assert.equal(pixels[from + 3], 255, 'an opaque icon has a transparent pixel');
      raw.set(pixels.subarray(from, from + 3), y * stride + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const androidRes = join(mobileDir, 'android', 'app', 'src', 'main', 'res', 'drawable-nodpi');
const outputs = [
  {
    // iOS masks the whole square itself and shows all of it, so the bench can
    // run larger than Android's; at 60% it read small on an iPhone home screen.
    path: join(
      mobileDir,
      'ios',
      'App',
      'App',
      'Assets.xcassets',
      'AppIcon.appiconset',
      'AppIcon-512@2x.png',
    ),
    png: () => opaquePng(render({ size: 1024, paper: true, bench: 0.65 })),
  },
  {
    // Adaptive icon layers. A launcher shows only the middle 72 of 108 dp, and
    // its mask may be a circle, so the bench stays inside the 66 dp safe zone.
    path: join(androidRes, 'gezel_icon_background.png'),
    png: () => opaquePng(render({ size: 512, paper: true })),
  },
  {
    path: join(androidRes, 'gezel_icon.png'),
    png: () => render({ size: 512, paper: false, bench: 0.4 }).asPng(),
  },
];

for (const output of outputs) {
  const generated = output.png();
  const shown = relative(repoDir, output.path);
  if (checkOnly) {
    const committed = await readFile(output.path);
    assert.ok(
      committed.equals(generated),
      `${shown} is stale; run pnpm --filter @bendyline/gezel-app generate:icon:mobile`,
    );
    console.log(`Verified ${shown}`);
  } else {
    await writeFile(output.path, generated);
    console.log(`Wrote ${shown}`);
  }
}
