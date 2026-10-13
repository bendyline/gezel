import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { opaquePng, renderIcon, writeIconAsset } from './icon-artwork.mjs';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const mobileDir = join(appDir, '..', 'mobile');
const checkOnly = process.argv.includes('--check');
const androidRes = join(mobileDir, 'android', 'app', 'src', 'main', 'res', 'drawable-nodpi');
const outputs = [
  {
    path: join(
      mobileDir,
      'ios',
      'App',
      'App',
      'Assets.xcassets',
      'AppIcon.appiconset',
      'AppIcon-512@2x.png',
    ),
    size: 1024,
    variant: 'ios',
    opaque: true,
  },
  {
    path: join(androidRes, 'gezel_icon_background.png'),
    size: 512,
    variant: 'android-background',
    opaque: true,
  },
  { path: join(androidRes, 'gezel_icon.png'), size: 512, variant: 'android-foreground' },
  { path: join(androidRes, 'gezel_icon_monochrome.png'), size: 512, variant: 'android-monochrome' },
];

for (const { path, size, variant, opaque } of outputs) {
  const image = renderIcon({ size, variant });
  await writeIconAsset(path, opaque ? opaquePng(image) : image.asPng(), checkOnly);
}
console.log(
  `${checkOnly ? 'Verified' : 'Wrote'} iOS and Android icons from the shared bench artwork`,
);
