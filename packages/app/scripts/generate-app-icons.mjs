import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconSvg, renderIcon, writeIconAsset } from './icon-artwork.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = join(scriptDir, '..');
const assetsDir = join(appDir, 'assets');
const checkOnly = process.argv.includes('--check');
const save = (name, bytes) => writeIconAsset(join(assetsDir, name), bytes, checkOnly);

await save('icon.svg', iconSvg({ size: 1024 }));
await save('icon.png', renderIcon({ size: 512 }).asPng());
await save('icon-1024.png', renderIcon({ size: 1024, variant: 'mac' }).asPng());
await save('icon-mac.png', renderIcon({ size: 1024, variant: 'mac' }).asPng());
await save('tray.png', renderIcon({ size: 22 }).asPng());

// Preserve the existing standard and Retina ICNS representations.
const macFrames = [
  [32, 'ic11'],
  [64, 'ic12'],
  [128, 'ic07'],
  [256, 'ic08'],
  [256, 'ic13'],
  [512, 'ic09'],
  [512, 'ic14'],
  [1024, 'ic10'],
];
const chunks = macFrames.map(([size, type]) => {
  const png = renderIcon({ size, variant: 'mac' }).asPng();
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([header, png]);
});
const header = Buffer.alloc(8);
header.write('icns');
header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
await save('icon.icns', Buffer.concat([header, ...chunks]));

for (let workingFrame = 0; workingFrame <= 5; workingFrame++) {
  const stem = workingFrame ? `trayWorking${workingFrame}Template` : 'trayTemplate';
  const spec = { variant: 'template', workingFrame };
  await save(`${stem}.svg`, iconSvg({ ...spec, size: 16 }));
  await save(`${stem}.png`, renderIcon({ ...spec, size: 16 }).asPng());
  await save(`${stem}@2x.png`, renderIcon({ ...spec, size: 32 }).asPng());
}
for (const size of [16, 32, 64, 80]) {
  await writeIconAsset(
    join(appDir, '..', 'ui', 'office-pages', 'public', 'icons', `icon-${size}.png`),
    renderIcon({ size }).asPng(),
    checkOnly,
  );
}
for (const size of [16, 26, 42]) {
  await writeIconAsset(
    join(appDir, '..', 'libreoffice-extension', 'src', 'icons', `gezel_${size}.png`),
    renderIcon({ size }).asPng(),
    checkOnly,
  );
}
for (const script of ['generate-windows-icon.mjs', 'generate-mobile-icons.mjs']) {
  execFileSync(process.execPath, [join(scriptDir, script), ...(checkOnly ? ['--check'] : [])], {
    stdio: 'inherit',
  });
}
console.log(
  `${checkOnly ? 'Verified' : 'Wrote'} desktop, tray and Office icons from the shared bench artwork`,
);
