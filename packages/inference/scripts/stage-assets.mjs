import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { collectLinks, isEnforcing } from '../../../scripts/local-link-guard.mjs';
const catalogRequire = createRequire(import.meta.resolve('@bendyline/gezel-catalog'));
const gildeRoot = dirname(catalogRequire.resolve('@bendyline/gilde/package.json'));
const gilde = JSON.parse(await readFile(join(gildeRoot, 'package.json'), 'utf8'));
const catalog = JSON.parse(
  await readFile(new URL('../../catalog/package.json', import.meta.url), 'utf8'),
);
const pinned = catalog.devDependencies['@bendyline/gilde'];
// A `pnpm link:gilde` checkout carries only the minor line (the patch is
// injected at publish), so it never equals the pin. Like check:local-links,
// that is the supported local flow: stage from the checkout and warn, and
// refuse only in CI or a release, where the published snapshot must be pinned.
const [link] = collectLinks('@bendyline/gilde');
if (gilde.version !== pinned) {
  if (!link || isEnforcing())
    throw new Error(
      `Inference catalog must be built from the pinned Gilde release (resolved ${gilde.version}, pinned ${pinned})`,
    );
  console.warn(
    `[stage-assets] staging the inference catalog from linked Gilde ${gilde.version} (${link.spec}), not the pinned ${pinned}`,
  );
}
await mkdir('dist/catalog', { recursive: true });
for (const kind of ['chat-models', 'knowledge-catalogs'])
  await cp(join(gildeRoot, 'data', kind), join('dist/catalog', kind), { recursive: true });
await cp(join(gildeRoot, 'LICENSE'), 'dist/catalog/LICENSE');
await writeFile(
  'dist/catalog/provenance.json',
  `${JSON.stringify(
    {
      package: gilde.name,
      version: gilde.version,
      ...(gilde.version !== pinned && link ? { linked: link.spec } : {}),
      kinds: ['chat-models', 'knowledge-catalogs'],
    },
    null,
    2,
  )}\n`,
);
await cp('src/providers/mlx/python', 'dist/providers/mlx/python', { recursive: true });
await cp('assets/kokoro', 'dist/kokoro-lexicon', { recursive: true });
