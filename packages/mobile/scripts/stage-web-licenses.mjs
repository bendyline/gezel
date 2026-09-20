import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(mobile, 'dist/licenses');
const require = createRequire(resolve(mobile, 'package.json'));
await mkdir(output, { recursive: true });
await copyFile(resolve(mobile, '../../LICENSE'), resolve(output, 'LICENSE-gezel.txt'));
for (const font of ['hanken-grotesk', 'pt-serif']) {
  const name = `LICENSE-${font}.txt`;
  await copyFile(resolve(mobile, '../ui/src/assets/fonts/licenses', name), resolve(output, name));
}
for (const name of ['react', 'react-dom', '@capacitor/core']) {
  await copyFile(
    resolve(dirname(require.resolve(`${name}/package.json`)), 'LICENSE'),
    resolve(output, `LICENSE-${name.replaceAll('/', '-').replace('@', '')}.txt`),
  );
}
const core = createRequire(resolve(mobile, '../core/package.json'));
await copyFile(
  resolve(dirname(core.resolve('zod/package.json')), 'LICENSE'),
  resolve(output, 'LICENSE-zod.txt'),
);

const copied = new Set();
async function copyPrimitiveLicenses(name, from) {
  if (copied.has(name)) return;
  let directory = dirname(from.resolve(name));
  let manifest;
  while (true) {
    try {
      manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
      if (manifest.name === name) break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate license for ${name}`);
    directory = parent;
  }
  copied.add(name);
  await copyFile(
    resolve(directory, 'LICENSE'),
    resolve(output, `LICENSE-${name.replaceAll('/', '-').replace('@', '')}.txt`),
  );
  const dependencyRequire = createRequire(resolve(directory, 'package.json'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await copyPrimitiveLicenses(dependency, dependencyRequire);
  }
}
await copyPrimitiveLicenses(
  '@radix-ui/react-tabs',
  createRequire(resolve(mobile, '../ui/package.json')),
);
