import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const catalogRequire = createRequire(import.meta.resolve('@bendyline/gezel-catalog'));
const gildeRoot = dirname(catalogRequire.resolve('@bendyline/gilde/package.json'));
const gilde = JSON.parse(await readFile(join(gildeRoot, 'package.json'), 'utf8'));
const catalog = JSON.parse(
  await readFile(new URL('../../catalog/package.json', import.meta.url), 'utf8'),
);
if (gilde.version !== catalog.devDependencies['@bendyline/gilde'])
  throw new Error('Inference catalog must be built from the pinned Gilde release');
await mkdir('dist/catalog', { recursive: true });
for (const kind of ['chat-models', 'knowledge-catalogs'])
  await cp(join(gildeRoot, 'data', kind), join('dist/catalog', kind), { recursive: true });
await cp(join(gildeRoot, 'LICENSE'), 'dist/catalog/LICENSE');
await writeFile(
  'dist/catalog/provenance.json',
  `${JSON.stringify(
    { package: gilde.name, version: gilde.version, kinds: ['chat-models', 'knowledge-catalogs'] },
    null,
    2,
  )}\n`,
);
await cp('src/providers/mlx/python', 'dist/providers/mlx/python', { recursive: true });
await cp('assets/kokoro', 'dist/kokoro-lexicon', { recursive: true });
