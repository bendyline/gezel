import { readFile, writeFile } from 'node:fs/promises';
/** Producer-only refresh. Consumers use the snapshot exported by the installed SDK. */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { BundledSource } from '../../catalog/src/source.js';
import { portableCatalogModels } from '../../core/src/runtime/portable-catalog.js';
const require = createRequire(new URL('../../catalog/package.json', import.meta.url));
const gildePath = require.resolve('@bendyline/gilde/package.json');
const { version } = JSON.parse(await readFile(gildePath, 'utf8'));
const items = await new BundledSource({ dataDir: join(dirname(gildePath), 'data') }).list(
  'chat-model',
);
const models = portableCatalogModels(items).map(
  ({ name, license, approxSizeBytes, contextWindow, source }) => ({
    name,
    license,
    approxSizeBytes,
    contextWindow,
    source,
  }),
);
await writeFile(
  new URL('../src/catalog.json', import.meta.url),
  `${JSON.stringify({ package: '@bendyline/gilde', version, models }, null, 2)}\n`,
);
