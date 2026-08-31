import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(appDir, 'assets');
const outputPath = join(assetsDir, 'icon.ico');
const checkOnly = process.argv.includes('--check');

// Windows uses native-size drawings for the tiny shell frames. Explorer-size
// frames come from a separate vector master with rounded transparent corners.
const frameSpecs = [
  [16, 'icon-windows-small.svg'],
  [20, 'icon-windows-20.svg'],
  [24, 'icon-windows-24.svg'],
  [32, 'icon-windows-32.svg'],
  [40, 'icon-windows-medium.svg'],
  [48, 'icon-windows-medium.svg'],
  [64, 'icon-windows-large.svg'],
  [128, 'icon-windows-large.svg'],
  [256, 'icon-windows-large.svg'],
];

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

async function renderFrame(size, sourceName) {
  const svg = await readFile(join(assetsDir, sourceName), 'utf8');
  const png = Buffer.from(
    new Resvg(svg, {
      fitTo: { mode: 'width', value: size },
    })
      .render()
      .asPng(),
  );
  assert.ok(png.subarray(0, pngSignature.length).equals(pngSignature));
  assert.equal(png.readUInt32BE(16), size, `${sourceName} rendered at the wrong width`);
  assert.equal(png.readUInt32BE(20), size, `${sourceName} rendered at the wrong height`);
  return { size, png };
}

function assembleIco(frames) {
  const directorySize = 6 + frames.length * 16;
  const header = Buffer.alloc(directorySize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // image type: icon
  header.writeUInt16LE(frames.length, 4);

  let imageOffset = directorySize;
  frames.forEach(({ size, png }, index) => {
    const offset = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, offset);
    header.writeUInt8(size === 256 ? 0 : size, offset + 1);
    header.writeUInt8(0, offset + 2); // PNG supplies its own color table
    header.writeUInt8(0, offset + 3); // reserved
    header.writeUInt16LE(1, offset + 4); // color planes
    header.writeUInt16LE(32, offset + 6); // RGBA
    header.writeUInt32LE(png.length, offset + 8);
    header.writeUInt32LE(imageOffset, offset + 12);
    imageOffset += png.length;
  });

  return Buffer.concat([header, ...frames.map(({ png }) => png)]);
}

const frames = await Promise.all(
  frameSpecs.map(([size, sourceName]) => renderFrame(size, sourceName)),
);
const generated = assembleIco(frames);

if (checkOnly) {
  const committed = await readFile(outputPath);
  assert.ok(
    committed.equals(generated),
    'assets/icon.ico is stale; run pnpm --filter @bendyline/gezel-app generate:icon:win',
  );
  console.log(`Verified ${outputPath} (${frames.map(({ size }) => size).join(', ')} px)`);
} else {
  await writeFile(outputPath, generated);
  console.log(`Wrote ${outputPath} (${frames.map(({ size }) => size).join(', ')} px)`);
}
