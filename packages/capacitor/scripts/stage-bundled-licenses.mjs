/**
 * License texts for the third-party code compiled into dist/: the tokenizer in
 * index.js, and sqlite-wasm (with sqlite3.wasm), brotli, base64-js and zod in
 * knowledge-worker.js. Minification drops their license comments, and an app
 * that installs this package never installs those packages, so dist/ carries
 * them as the service carries its bundles' licenses
 * (scripts/service-bundled-licenses.mjs): dist/licenses/npm/manifest.json and
 * content-addressed texts. Reads the build's esbuild metafiles, then removes
 * them so they do not ship.
 */
import { readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inventoryFromBundledPackages,
  packageRootOf,
} from '../../../scripts/service-bundled-licenses.mjs';
import { stageDependencyLicenses } from '../../../scripts/stage-third-party-licenses.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(packageRoot, 'dist');
const metafiles = (await readdir(dist)).filter((name) => /^metafile-.*\.json$/.test(name));
if (metafiles.length < 2) throw new Error('Build dist/ before staging its bundled licenses');
const packages = new Map();
for (const name of metafiles) {
  const { inputs } = JSON.parse(await readFile(path.join(dist, name), 'utf8'));
  for (const input of Object.keys(inputs)) {
    // Inputs are relative to the package; first-party workspace sources sit outside node_modules.
    const file = await realpath(path.resolve(packageRoot, input)).catch(() => null);
    const owner = file && packageRootOf(file);
    if (!owner || packages.has(owner.root)) continue;
    const packageJson = JSON.parse(await readFile(path.join(owner.root, 'package.json'), 'utf8'));
    packages.set(owner.root, {
      name: packageJson.name,
      version: packageJson.version,
      path: owner.root,
      packageJson,
    });
  }
  await rm(path.join(dist, name));
}
await rm(path.join(dist, 'licenses'), { recursive: true, force: true });
const count = await stageDependencyLicenses(
  path.join(dist, 'licenses'),
  inventoryFromBundledPackages(packages),
);
console.log(`Staged license texts for ${count} bundled packages in dist/licenses/npm.`);
