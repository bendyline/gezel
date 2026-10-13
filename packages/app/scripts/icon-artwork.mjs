import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';

// The shared vector source for launcher, toolbar and template icons.
// Regenerate the checked-in assets with generate:icons after editing this file.
export const ICON_GREEN = '#48583c';
const IVORY = '#f3ede0';

function benchArtwork(size, { monochrome = false, template = false } = {}) {
  const small = size <= 32;
  const scale = template ? 1.2 : 1;
  const offsetX = template ? -6.4 : 0;
  const offsetY = template ? -9.4 : 0;
  const snap = (v) => (small ? Math.round((v * size) / 64) * (64 / size) : v);
  const x = (v) => snap(v * scale + offsetX);
  const y = (v) => snap(v * scale + offsetY);
  const ink = monochrome ? '#000' : IVORY;
  const rect = (left, top, width, height, radius, fill = ink) =>
    `<rect x="${x(left)}" y="${y(top)}" width="${x(left + width) - x(left)}" height="${y(top + height) - y(top)}" rx="${small ? Math.min(radius * scale, 32 / size) : radius * scale}" fill="${fill}"/>`;
  const polygon = (points) =>
    `<path d="M${points.map(([px, py]) => `${x(px)} ${y(py)}`).join('L')}Z" fill="${ink}"/>`;

  // Overlapping joinery keeps the silhouette continuous at native shell sizes.
  const parts = [
    polygon([
      [18, 25],
      [25, 25],
      [21, 50],
      [14, 50],
    ]),
    polygon([
      [43, 25],
      [50, 25],
      [54, 50],
      [47, 50],
    ]),
    rect(20, 39, 28, 5, 1),
    rect(13, 19, 42, 8, 1.5),
  ];
  if (!small && !monochrome) parts.push(rect(14, 19, 40, 1.2, 0.6, '#fff6e5'));
  parts.push(rect(9, 21, 4, 6, 1), rect(7, 24, 3, 2, 0.6));

  // An odd-pixel stroke sits on a half-pixel centre, avoiding a blurred vise.
  const handleWidth = (size <= 20 ? 2.5 : 2) * scale;
  const pixels = Math.max(1, Math.round((handleWidth * size) / 64));
  const phase = pixels % 2 ? 0.5 : 0;
  const center = (v) => (small ? (Math.round((v * size) / 64 - phase) + phase) * (64 / size) : v);
  const handleX = center(7 * scale + offsetX);
  parts.push(
    `<path d="M${handleX} ${center(22 * scale + offsetY)}V${center(31 * scale + offsetY)}" fill="none" stroke="${ink}" stroke-width="${small ? pixels * (64 / size) : handleWidth}" stroke-linecap="round"/>`,
  );
  return parts.join('\n');
}

export function iconSvg({ size, variant = 'desktop', workingFrame = 0 }) {
  const template = variant === 'template';
  const monochrome = template || variant === 'android-monochrome';
  const bench = benchArtwork(size, { monochrome, template });
  const defs = `<defs><linearGradient id="sage" x1="0" y1="0" x2=".8" y2="1"><stop stop-color="#526346"/><stop offset="1" stop-color="#3e4e34"/></linearGradient></defs>`;
  const field = size <= 32 ? ICON_GREEN : 'url(#sage)';
  let viewBox = '0 0 64 64';
  let art;
  if (variant.startsWith('android-')) {
    viewBox = '0 0 108 108';
    // The entire mark fits inside the central 66-dp circle, even under round masks.
    art =
      variant === 'android-background'
        ? `<rect width="108" height="108" fill="${ICON_GREEN}"/>`
        : `<g transform="translate(18.8 18.8) scale(1.1)">${bench}</g>`;
  } else if (template) {
    assert.ok(Number.isInteger(workingFrame) && workingFrame >= 0 && workingFrame <= 5);
    art = bench;
    if (workingFrame) {
      const fillWidth = ((workingFrame - 1) / 4) * 36;
      art +=
        '\n<rect x="16" y="1" width="40" height="8" rx="2" fill="none" stroke="#000" stroke-width="2"/>';
      if (fillWidth)
        art += `\n<rect x="18" y="3" width="${fillWidth}" height="4" rx="1" fill="#000"/>`;
    }
  } else if (variant === 'ios') {
    art = `<rect width="64" height="64" fill="${field}"/>\n${bench}`;
  } else if (variant === 'mac') {
    art = `<g transform="translate(5 5) scale(.84375)"><rect width="64" height="64" rx="14.5" fill="${field}"/>\n${bench}</g>`;
  } else {
    assert.equal(variant, 'desktop');
    art = `<rect x="2" y="2" width="60" height="60" rx="13" fill="${field}"/>\n${bench}`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">\n${defs}\n${art}\n</svg>\n`;
}

export function renderIcon(spec) {
  const image = new Resvg(iconSvg(spec)).render();
  assert.equal(image.width, spec.size);
  assert.equal(image.height, spec.size);
  return image;
}

// App Store validation requires RGB, rather than opaque pixels in an RGBA PNG.
export function opaquePng({ width, height, pixels }) {
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
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function writeIconAsset(path, data, checkOnly) {
  if (checkOnly) {
    const committed = await readFile(path);
    assert.ok(
      committed.equals(Buffer.from(data)),
      `${path} is stale; run pnpm --filter @bendyline/gezel-app generate:icons`,
    );
  } else {
    await writeFile(path, data);
  }
}
