import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexWorkspaceContent } from '../content-indexer.js';
import { IndexStore } from '../index-store.js';
import { EDGES_FINGERPRINT_META, fileEdgeCoverage, fileEdgesAvailable } from './refresh.js';

let ws: string;
let home: string;
let store: IndexStore;

async function put(rel: string, body: string): Promise<void> {
  await mkdir(dirname(join(ws, rel)), { recursive: true });
  await writeFile(join(ws, rel), body);
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'gezel-edges-ws-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-edges-home-'));
  const opened = await IndexStore.open(join(home, 'index.db'), {
    collectionId: 'p',
    kind: 'workspace',
    rootPath: ws,
  });
  if (!opened) throw new Error('index unavailable');
  store = opened;
});

afterEach(async () => {
  store.close();
  await rm(ws, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const index = () => indexWorkspaceContent(store, ws, join(home, 'artifacts'));
const edges = () =>
  store.fileEdges.all().map((e) => `${e.src} -> ${e.dst} (${e.kind}/${e.resolver})`);

describe('the stored dependency graph', () => {
  it('is resolved at the end of a pass, across packages and documents', async () => {
    await put(
      'packages/core/package.json',
      JSON.stringify({ name: '@acme/core', exports: { '.': { types: './dist/index.d.ts' } } }),
    );
    await put('packages/core/src/index.ts', 'export const core = 1;\n');
    await put('packages/app/src/main.ts', "import { core } from '@acme/core';\nexport { core };\n");
    await put('README.md', '# Acme\n\nStart at [the app](packages/app/src/main.ts).\n');
    expect(fileEdgesAvailable(store)).toBe(false);

    await index();

    expect(edges()).toEqual([
      'README.md -> packages/app/src/main.ts (link/md-link)',
      'packages/app/src/main.ts -> packages/core/src/index.ts (import/workspace)',
    ]);
    expect(fileEdgesAvailable(store)).toBe(true);
    expect(fileEdgeCoverage(store)?.typescript).toEqual({
      files: 2,
      filesWithImports: 1,
      filesWithEdges: 1,
      edges: 1,
    });
    expect(store.fileEdges.to('packages/core/src/index.ts')[0]?.bindings).toEqual([
      { name: 'core', local: 'core', kind: 'named' },
    ]);
  });

  it('resolves AMD module ids from the page that loads RequireJS', async () => {
    await put('src/index.html', '<script src="thirdparty/require.js" data-main="main"></script>\n');
    await put(
      'src/main.js',
      'require.config({ paths: { "fsImpl": "filesystem/impl" } });\ndefine(function (require) { require("app/boot"); });\n',
    );
    await put(
      'src/app/boot.js',
      'define(function (require) { var s = require("utils/strings"); var f = require("fsImpl"); });\n',
    );
    await put('src/utils/strings.js', 'define({ hello: "hi" });\n');
    await put('src/filesystem/impl.js', 'define({});\n');

    await index();

    expect(edges()).toEqual([
      'src/app/boot.js -> src/filesystem/impl.js (import/requirejs)',
      'src/app/boot.js -> src/utils/strings.js (import/requirejs)',
      'src/main.js -> src/app/boot.js (import/requirejs)',
    ]);
  });

  it('is left alone by an unchanged pass, and rebuilt when a new file completes an edge', async () => {
    await put('src/a.ts', "import { b } from './b';\nexport const a = b;\n");
    await index();
    expect(edges()).toEqual([]);
    const fingerprint = store.getMeta(EDGES_FINGERPRINT_META);

    await index();
    expect(store.getMeta(EDGES_FINGERPRINT_META)).toBe(fingerprint);

    await put('src/b.ts', 'export const b = 2;\n');
    await index();
    expect(edges()).toEqual(['src/a.ts -> src/b.ts (import/relative)']);
    expect(store.getMeta(EDGES_FINGERPRINT_META)).not.toBe(fingerprint);
  });

  it('drops every edge that touched a deleted file', async () => {
    await put('src/a.ts', "import { b } from './b';\n");
    await put('src/b.ts', 'export const b = 2;\n');
    await index();
    expect(edges()).toHaveLength(1);

    await rm(join(ws, 'src/b.ts'));
    await index();
    expect(edges()).toEqual([]);
  });
});
