import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexWorkspaceContent } from './content-indexer.js';
import { buildFileGraph } from './file-graph.js';
import { buildFileInsight } from './file-insight.js';
import { IndexStore } from './index-store.js';

let ws: string;
let home: string;
let store: IndexStore;

async function put(rel: string, body: string): Promise<void> {
  await mkdir(dirname(join(ws, rel)), { recursive: true });
  await writeFile(join(ws, rel), body);
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'gezel-graph-ws-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-graph-home-'));
  await put(
    'packages/core/package.json',
    JSON.stringify({ name: '@acme/core', main: 'dist/index.js' }),
  );
  await put(
    'packages/core/src/index.ts',
    "export type { Money } from './money';\nexport function total(): number { return 1; }\n",
  );
  await put('packages/core/src/money.ts', 'export interface Money { cents: number }\n');
  await put(
    'packages/app/src/main.ts',
    "import { total } from '@acme/core';\nimport type { Money } from '@acme/core';\nimport chalk from 'chalk';\nimport { readFile } from 'node:fs/promises';\nconst lazy = () => import('./lazy');\nexport const run = (): number => total();\n",
  );
  await put('packages/app/src/lazy.ts', 'export const later = 2;\n');
  await put('packages/app/src/main.test.ts', "import { run } from './main';\nrun();\n");
  await put(
    'docs/guide.md',
    '---\ntitle: The guide\n---\n# Guide\n\nRun [the app](../packages/app/src/main.ts).\n',
  );
  await put(
    'docs/copy-of-guide.md',
    '---\ntitle: The guide\n---\n# Guide\n\nRun [the app](../packages/app/src/main.ts).\n',
  );
  const opened = await IndexStore.open(join(home, 'index.db'), {
    collectionId: 'p',
    kind: 'workspace',
    rootPath: ws,
  });
  if (!opened) throw new Error('index unavailable');
  store = opened;
  await indexWorkspaceContent(store, ws, join(home, 'artifacts'));
});

afterEach(async () => {
  store.close();
  await rm(ws, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('buildFileGraph', () => {
  it('draws code files and their imports, flags merged per pair', () => {
    const graph = buildFileGraph(
      store,
      {},
      {
        packageRoots: [{ folder: 'packages/core', name: '@acme/core' }],
      },
    );
    expect(graph.resolved).toBe(true);
    expect(graph.nodes.map((n) => n.id)).toEqual([
      'packages/app/src/lazy.ts',
      'packages/app/src/main.ts',
      'packages/core/src/index.ts',
      'packages/core/src/money.ts',
    ]);
    const edge = (s: string, t: string) =>
      graph.edges.find((e) => e.source === s && e.target === t);
    // A runtime import and a type-only import of the same package: one runtime edge.
    expect(edge('packages/app/src/main.ts', 'packages/core/src/index.ts')).toMatchObject({
      kind: 'import',
      names: ['Money', 'total'],
      typeOnly: false,
    });
    expect(edge('packages/app/src/main.ts', 'packages/app/src/lazy.ts')?.dynamic).toBe(true);
    expect(edge('packages/core/src/index.ts', 'packages/core/src/money.ts')).toMatchObject({
      reexport: true,
      typeOnly: true,
    });
    // Node's built-ins group as one package rather than one per module.
    expect(graph.externals).toEqual([
      { from: 'packages/app/src/main.ts', pkg: 'chalk' },
      { from: 'packages/app/src/main.ts', pkg: 'node' },
    ]);
    expect(graph.packageRoots).toEqual([{ folder: 'packages/core', name: '@acme/core' }]);
    expect(graph.nodes.find((n) => n.id === 'packages/core/src/index.ts')?.fanIn).toBe(1);
    expect(graph.folders.map((f) => f.path)).toContain('packages/app/src');
    expect(graph.truncated).toBeNull();
  });

  it('keeps tests apart unless asked, and draws document links on their own', () => {
    expect(buildFileGraph(store, { scope: 'tests' }).nodes.map((n) => n.id)).toEqual([
      'packages/app/src/main.test.ts',
    ]);
    const docs = buildFileGraph(store, { kind: 'docs' });
    expect(docs.edges.map((e) => `${e.source} -> ${e.target} (${e.kind})`)).toEqual([
      'docs/copy-of-guide.md -> packages/app/src/main.ts (link)',
      'docs/guide.md -> packages/app/src/main.ts (link)',
    ]);
    expect(docs.externals).toEqual([]);
  });

  it('caps the busiest files and keeps the focus neighborhood whole', () => {
    const capped = buildFileGraph(store, { max: 1 });
    expect(capped.nodes.map((n) => n.id)).toHaveLength(1);
    expect(capped.truncated?.nodes).toBe(3);
    const focused = buildFileGraph(store, { max: 1, focus: 'packages/app/src/lazy.ts' });
    expect(focused.nodes.map((n) => n.id).sort()).toEqual([
      'packages/app/src/lazy.ts',
      'packages/app/src/main.ts',
    ]);
  });

  it('signs the graph by its shape, so an unchanged graph keeps its signature', () => {
    expect(buildFileGraph(store, {}).signature).toBe(buildFileGraph(store, {}).signature);
    expect(buildFileGraph(store, { kind: 'docs' }).signature).not.toBe(
      buildFileGraph(store, {}).signature,
    );
  });
});

describe('buildFileInsight', () => {
  it('says what a code file imports and what imports it', () => {
    const insight = buildFileInsight(store, 'packages/core/src/index.ts');
    expect(insight.indexed).toBe(true);
    expect(insight.file).toMatchObject({ lang: 'typescript', kind: 'code', use: 'code' });
    expect(insight.connections.imports).toEqual([
      { path: 'packages/core/src/money.ts', names: ['Money'] },
    ]);
    expect(insight.connections.importedBy).toEqual([
      { path: 'packages/app/src/main.ts', names: ['Money', 'total'] },
    ]);
    expect(insight.folder.path).toBe('packages/core/src');
  });

  it('gives a document its title, frontmatter, links and copies', () => {
    const insight = buildFileInsight(store, 'docs/guide.md');
    expect(insight.doc).toEqual({ title: 'The guide', frontmatter: { title: 'The guide' } });
    expect(insight.connections.links).toEqual([{ path: 'packages/app/src/main.ts', names: [] }]);
    expect(insight.connections.duplicates).toEqual(['docs/copy-of-guide.md']);
    const target = buildFileInsight(store, 'packages/app/src/main.ts');
    expect(target.connections.linkedFrom.map((c) => c.path)).toEqual([
      'docs/copy-of-guide.md',
      'docs/guide.md',
    ]);
  });

  it('answers for a path the index has never seen', () => {
    const insight = buildFileInsight(store, 'nope.ts');
    expect(insight.indexed).toBe(false);
    expect(insight.file).toBeNull();
    expect(insight.connections.imports).toEqual([]);
  });
});
