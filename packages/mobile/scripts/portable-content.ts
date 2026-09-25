import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { BundledSource } from '../../catalog/src/source.js';
import { craftbookFromDoc, parseCraftbookDoc } from '../../core/src/browser.js';
import { portableToolNames } from '../../core/src/runtime/product-tools.js';
import { supportsPortableContent } from './portable-content-support.js';
import { portableCatalogModels } from './portable-models.js';

const ID = 'virtual:gezel-portable-content';
const require = createRequire(new URL('../../catalog/package.json', import.meta.url));
/** Catalog content stays in Gilde; mobile includes only recipes its host can execute. */
export function portableContentPlugin(): Plugin {
  return {
    name: 'gezel-portable-content',
    resolveId(id) {
      return id === ID ? `\0${ID}` : null;
    },
    async load(id) {
      if (id !== `\0${ID}`) return null;
      const dataDir =
        process.env.GEZEL_GILDE_DATA_DIR ??
        join(dirname(require.resolve('@bendyline/gilde/package.json')), 'data');
      const source = new BundledSource({ dataDir });
      const templates = [];
      for (const item of await source.list('gezel-template')) {
        const detail = await source.get('gezel-template', item.manifest.id, item.manifest.version);
        if (detail?.about) templates.push({ ...detail, logoUrl: undefined });
      }
      const craftbooks = [];
      for (const item of await source.list('craftbook-template')) {
        const raw = await source.readItemFile(
          'craftbook-template',
          item.manifest.id,
          'craftbook.json',
          item.manifest.version,
        );
        if (!raw) continue;
        const parsed = parseCraftbookDoc(raw.toString('utf8'));
        if (!parsed.ok) continue;
        const compiled = craftbookFromDoc(parsed.doc, {
          id: item.manifest.id,
          now: item.manifest.releasedAt,
        });
        if (!compiled.ok) continue;
        const book = { ...compiled.craftbook, version: item.manifest.version };
        if (!supportsPortableContent(book, portableToolNames())) continue;
        const detail = await source.get(
          'craftbook-template',
          item.manifest.id,
          item.manifest.version,
        );
        if (detail) craftbooks.push({ item: { ...detail, logoUrl: undefined }, book });
      }
      const models = portableCatalogModels(await source.list('chat-model'));
      return `export default ${JSON.stringify({ templates, craftbooks, models })};`;
    },
  };
}
