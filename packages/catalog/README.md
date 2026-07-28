# @bendyline/gezel-catalog

Catalog loader for [gezel](https://github.com/bendyline/gezel) — resolves the
chat, image and video model catalogs, toolsets, connector types, project types,
gezel role templates and craftbooks that the daemon serves.

```bash
npm install @bendyline/gezel-catalog
```

## Content lives elsewhere

This package is the **loader**, not the content. The catalog data ships as
[`@bendyline/gilde`](https://www.npmjs.com/package/@bendyline/gilde), an
exact-pinned dependency resolved at runtime through `gildeDataDir()`.

```ts
import { CatalogService } from '@bendyline/gezel-catalog';

const catalog = new CatalogService();
const models = await catalog.listChatModels();
```

Override the content root with `GEZEL_GILDE_DATA_DIR` for tests, evals or
operator-supplied catalogs.

Gilde takes open-source contributions — new models, toolsets and craftbooks are
proposed there, not here.

## Stability

Public API under semver. The catalog *schemas* are defined in
[`@bendyline/gezel`](https://www.npmjs.com/package/@bendyline/gezel) and follow
its versioning.

MIT © Bendyline
