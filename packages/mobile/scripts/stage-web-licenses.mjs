import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProductionLicenseInventory } from '../../../scripts/production-dependency-inventory.mjs';
import { stageDependencyLicenses } from '../../../scripts/stage-third-party-licenses.mjs';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(mobile, 'dist/licenses');
await mkdir(output, { recursive: true });
await copyFile(resolve(mobile, '../../LICENSE'), resolve(output, 'LICENSE-gezel.txt'));
for (const name of await readdir(resolve(mobile, '../ui/src/assets/fonts/licenses'))) {
  await copyFile(resolve(mobile, '../ui/src/assets/fonts/licenses', name), resolve(output, name));
}
// Vite compiles shared UI sources directly, and the build embeds Gilde content.
// Include their exact production graphs as a conservative legal inventory;
// the mobile package's declared dependencies alone miss both payloads.
const installed = JSON.parse(
  await readFile(resolve(mobile, '../../node_modules/.modules.yaml'), 'utf8'),
);
const inventory = readProductionLicenseInventory({
  storeDir: installed.storeDir,
  filters: ['@bendyline/gezel-mobile...', '@bendyline/gezel-ui...', '@bendyline/gezel-catalog...'],
});
await stageDependencyLicenses(output, inventory);
