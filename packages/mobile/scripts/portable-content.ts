import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';
import { BundledSource } from '../../catalog/src/source.js';
import { type Craftbook, craftbookFromDoc, parseCraftbookDoc } from '../../core/src/browser.js';
import { portableCatalogModels } from '../../core/src/runtime/portable-catalog.js';
import { portableToolNames } from '../../core/src/runtime/product-tools.js';
import { supportsPortableContent } from './portable-content-support.js';
import { supportsPortableScriptSource } from './portable-script-support.js';

const ID = 'virtual:gezel-portable-content';
/** Project types are their own chunk, loaded the first time a gallery or project needs one. */
const PROJECT_TYPES_ID = 'virtual:gezel-portable-project-types';
const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'ico',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'mp3',
  'wav',
  'ogg',
  'mp4',
  'webm',
]);
const require = createRequire(new URL('../../catalog/package.json', import.meta.url));
/** Catalog content stays in Gilde; mobile includes only recipes its host can execute. */
export function portableContentPlugin(): Plugin {
  return {
    name: 'gezel-portable-content',
    resolveId(id) {
      return id === ID || id === PROJECT_TYPES_ID ? `\0${id}` : null;
    },
    async load(id) {
      const dataDir =
        process.env.GEZEL_GILDE_DATA_DIR ??
        join(dirname(require.resolve('@bendyline/gilde/package.json')), 'data');
      const source = new BundledSource({ dataDir });
      if (id === `\0${PROJECT_TYPES_ID}`)
        return `export default ${JSON.stringify(await portableProjectTypes(source, dataDir))};`;
      if (id !== `\0${ID}`) return null;
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

/**
 * The craftbooks a type carries in its own `craftbooks/<id>.json` that a phone
 * can run. Like the desktop's install, an embedded book wins over a catalog
 * book of the same id.
 */
function embeddedCraftbooks(
  type: { id: string; craftbooks: readonly string[]; releasedAt: string },
  files: Record<string, string>,
): Record<string, Craftbook> {
  const books: Record<string, Craftbook> = {};
  for (const id of type.craftbooks) {
    const text = files[`craftbooks/${id}.json`];
    if (text === undefined) continue;
    const parsed = parseCraftbookDoc(text, 'json');
    const compiled = parsed.ok
      ? craftbookFromDoc(parsed.doc, { id, now: type.releasedAt })
      : undefined;
    if (!compiled?.ok) {
      console.warn(`[portable-content] project type ${type.id}: craftbooks/${id}.json is invalid`);
      continue;
    }
    const book = { ...compiled.craftbook, version: compiled.craftbook.version ?? '1.0.0' };
    if (supportsPortableContent(book, portableToolNames())) books[id] = book;
  }
  return books;
}

/** Every file of a type version except its manifest, as text or base64. */
async function versionFiles(versionDir: string) {
  const files: Record<string, string> = {};
  const binaryFiles: Record<string, string> = {};
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const key = relative(versionDir, path).split(sep).join('/');
      if (key === 'manifest.json') continue;
      const bytes = await readFile(path);
      const extension = key.split('.').at(-1)?.toLowerCase() ?? '';
      if (BINARY_EXTENSIONS.has(extension)) binaryFiles[key] = bytes.toString('base64');
      else files[key] = bytes.toString('utf8');
    }
  };
  await walk(versionDir);
  return { files, ...(Object.keys(binaryFiles).length ? { binaryFiles } : {}) };
}

/**
 * The project types a phone can apply: their scripts run in the phone's
 * script runtime, and a type built around craftbooks has at least one this
 * host can run. The email type has its own kind on desktop.
 */
async function portableProjectTypes(source: BundledSource, dataDir: string) {
  const runnable = new Set<string>();
  for (const item of await source.list('craftbook-template')) {
    const raw = await source.readItemFile(
      'craftbook-template',
      item.manifest.id,
      'craftbook.json',
      item.manifest.version,
    );
    const parsed = raw ? parseCraftbookDoc(raw.toString('utf8')) : undefined;
    if (!parsed?.ok) continue;
    const compiled = craftbookFromDoc(parsed.doc, {
      id: item.manifest.id,
      now: item.manifest.releasedAt,
    });
    if (compiled.ok && supportsPortableContent(compiled.craftbook, portableToolNames()))
      runnable.add(item.manifest.id);
  }
  const types = [];
  for (const item of await source.list('project-type')) {
    const detail = await source.get('project-type', item.manifest.id, item.manifest.version);
    const manifest = detail?.manifest;
    if (!detail || manifest?.kind !== 'project-type') continue;
    if (manifest.id === 'email' || manifest.extends === 'email') continue;
    const scripts = Object.entries(manifest.scripts ?? {});
    if (scripts.some(([name, body]) => !supportsPortableScriptSource(name, body))) {
      console.warn(
        `[portable-content] project type ${manifest.id}: a script needs a capability phones lack; not bundled`,
      );
      continue;
    }
    const versionDir = join(
      dataDir,
      'project-types',
      manifest.id.slice(0, 2).toLowerCase(),
      manifest.id,
      'versions',
      manifest.version,
    );
    const files = await versionFiles(versionDir);
    const craftbooks = embeddedCraftbooks(manifest, files.files);
    // A type that exists to run craftbooks (a software project) has nothing to
    // offer here when none of them can run on a phone.
    if (
      manifest.craftbooks.length > 0 &&
      !manifest.tools.length &&
      !manifest.pages &&
      !manifest.craftbooks.some((id) => runnable.has(id) || craftbooks[id])
    )
      continue;
    types.push({
      item: { ...detail, logoUrl: undefined },
      ...files,
      ...(Object.keys(craftbooks).length ? { craftbooks } : {}),
    });
  }
  return types;
}
