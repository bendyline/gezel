# @bendyline/gezel-catalog

Catalog loader for [gezel](https://github.com/bendyline/gezel) — resolves the
chat, image and video model catalogs, toolsets, connector types, project types,
gezel role templates and craftbooks that the daemon serves.

```bash
npm install @bendyline/gezel-catalog @bendyline/gilde
```

## Content lives elsewhere

This package is the **loader**, not the content. The catalog data ships as
[`@bendyline/gilde`](https://www.npmjs.com/package/@bendyline/gilde), an optional
peer resolved at runtime through `gildeDataDir()`. Install it explicitly when
using the default catalog source, as in the example below.

```ts
import { CatalogService } from '@bendyline/gezel-catalog';

const catalog = new CatalogService();
const models = await catalog.list('chat-model');
```

Override the content root with `GEZEL_GILDE_DATA_DIR` for tests, evals or
operator-supplied catalogs. Hosts providing their own content root through
this variable or `BundledSource`'s `dataDir` option do not need Gilde installed.

When upgrading from releases that included Gilde as a runtime dependency,
add it to your application's dependencies if you use the default source.
Gezel's full service keeps an exact Gilde pin. The inference package instead
ships a model-only snapshot generated from that same pinned content and
passes its root to this loader; there is no separate catalog implementation.

Gilde takes open-source contributions — new models, toolsets and craftbooks are
proposed there, not here.

## Stability

Public API under semver. The catalog *schemas* are defined in
[`@bendyline/gezel`](https://www.npmjs.com/package/@bendyline/gezel) and follow
its versioning.

MIT © Bendyline
