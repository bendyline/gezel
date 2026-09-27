/**
 * Collapse the deployed `@bendyline/gilde` community tier into one content
 * pack.
 *
 * The community tier is ~30k tiny MCP-registry manifests — more than half of
 * a service bundle's files. Every file is a tar extraction, and on Windows a
 * Defender scan, wherever the bundle is unpacked per account: the v1.26270.76
 * first launch without the machine service spent 4m47s on 52,311 files, and
 * 29,710 of them were this tier. The catalog loader reads a packed root in
 * place (packages/catalog/src/content-pack.ts), so the tier ships as one file.
 *
 * The pack is written by the catalog package deployed into the bundle, so the
 * format always matches the reader that ships beside it, and the collapse
 * verifies every byte against the tree before removing it.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function deployedGildeCommunityDir(root) {
  return join(root, 'node_modules', '@bendyline', 'gilde', 'data', 'community');
}

function deployedCatalogEntry(root) {
  return join(root, 'node_modules', '@bendyline', 'gezel-catalog', 'dist', 'index.js');
}

/**
 * Replace the deployed community tier with a verified `content.pack`.
 * `catalog` overrides the deployed `@bendyline/gezel-catalog` module (tests).
 */
export async function packDeployedGildeCommunity(root, { label, catalog } = {}) {
  const dir = deployedGildeCommunityDir(root);
  if (!existsSync(dir)) {
    throw new Error(
      `[${label}] expected the gilde community tier at ${dir}; the @bendyline/gilde content package did not deploy where the catalog loader looks for it`,
    );
  }
  let module = catalog;
  if (!module) {
    const entry = deployedCatalogEntry(root);
    if (!existsSync(entry)) {
      throw new Error(`[${label}] expected the deployed catalog loader at ${entry}`);
    }
    module = await import(pathToFileURL(entry).href);
  }
  if (typeof module.collapseToContentPack !== 'function') {
    throw new Error(`[${label}] the deployed catalog loader cannot write content packs`);
  }
  const started = Date.now();
  const result = await module.collapseToContentPack(dir);
  console.log(
    `[${label}] packed the gilde community tier: ${result.files} files -> 1 ${module.CONTENT_PACK_FILENAME} ` +
      `(${(result.bytes / 1048576).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
  return result;
}

/**
 * The in-process half of `verifyPackedGildeCommunity`: through `catalog` (a
 * loaded `@bendyline/gezel-catalog`), the community directory the loader
 * resolves must sit inside `root` and hold only the pack, and the tier must
 * list and resolve an item through the pack's per-item files, not just its
 * index.
 */
export async function probePackedGildeCommunity(catalog, root) {
  const dir = join(catalog.gildeDataDir(), 'community');
  const within = relative(root, dir);
  if (within.startsWith('..') || isAbsolute(within)) {
    throw new Error(`gilde resolved outside ${root}: ${dir}`);
  }
  const entries = await readdir(dir);
  if (entries.length !== 1 || entries[0] !== catalog.CONTENT_PACK_FILENAME) {
    throw new Error(
      `${dir} should hold only ${catalog.CONTENT_PACK_FILENAME}; found ${entries.slice(0, 8).join(', ')}`,
    );
  }
  const source = new catalog.CommunitySource();
  const items = await source.list('toolset');
  if (items.length === 0) throw new Error('the packed community tier lists no toolsets');
  for (const item of items.slice(0, 50)) {
    if (await source.get('toolset', item.manifest.id)) return { listed: items.length };
  }
  throw new Error('the packed community tier resolves none of its first 50 toolsets');
}

/**
 * Prove a shipped tree reads its packed community tier, in a fresh process
 * that imports the deployed loader and so resolves gilde exactly as the
 * daemon does.
 */
export async function verifyPackedGildeCommunity(root, { label }) {
  const probe = [
    `const { probePackedGildeCommunity } = await import(${JSON.stringify(import.meta.url)});`,
    `const catalog = await import(${JSON.stringify(pathToFileURL(deployedCatalogEntry(root)).href)});`,
    `const result = await probePackedGildeCommunity(catalog, ${JSON.stringify(root)});`,
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  const env = { ...process.env, GEZEL_LOG_LEVEL: 'error' };
  // The daemon resolves gilde through node resolution; an operator override
  // in the build environment would point the probe somewhere else entirely.
  delete env.GEZEL_GILDE_DATA_DIR;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: root,
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  const { listed } = JSON.parse(stdout);
  console.log(`[${label}] verified the packed gilde community tier (${listed} toolsets)`);
  return { listed };
}
