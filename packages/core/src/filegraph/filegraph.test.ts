import { describe, expect, it } from 'vitest';
import type { FileGraphEdge, FileGraphNode } from '../schemas/api/project-views.js';
import { redundantEdges, stronglyConnected } from './graph-algorithms.js';
import { folderNodeId, shapeDiagram, visibleIdForPath } from './shape.js';
import { buildDiagramTree, defaultDiagramExpansion, displayAncestors } from './tree.js';

function file(id: string, extra: Partial<FileGraphNode> = {}): FileGraphNode {
  const slash = id.lastIndexOf('/');
  return {
    id,
    label: id.slice(slash + 1),
    folder: slash < 0 ? '' : id.slice(0, slash),
    lang: 'typescript',
    modality: 'code',
    use: 'code',
    test: false,
    loc: 10,
    fanIn: 0,
    fanOut: 0,
    importance: 0.1,
    findings: 0,
    maxSeverity: null,
    ...extra,
  };
}

function edge(source: string, target: string, extra: Partial<FileGraphEdge> = {}): FileGraphEdge {
  return {
    source,
    target,
    kind: 'import',
    names: [],
    nameCount: 0,
    typeOnly: false,
    dynamic: false,
    reexport: false,
    ...extra,
  };
}

function graph(
  nodes: FileGraphNode[],
  edges: FileGraphEdge[],
  extra: {
    packageRoots?: { folder: string; name: string }[];
    purposes?: Record<string, string>;
  } = {},
) {
  return {
    nodes,
    edges,
    packageRoots: extra.packageRoots ?? [],
    folders: Object.entries(extra.purposes ?? {}).map(([path, purpose]) => ({
      path,
      parent: null,
      fileCount: 0,
      purpose,
    })),
  };
}

const monorepo = graph(
  [
    file('packages/core/src/index.ts'),
    file('packages/core/src/paths.ts'),
    file('packages/ui/src/app.tsx'),
    file('packages/ui/src/views/home.tsx'),
    file('packages/ui/src/views/settings.tsx'),
    file('scripts/build.mjs'),
    file('README.md', { use: null, lang: 'markdown' }),
  ],
  [
    edge('packages/ui/src/app.tsx', 'packages/core/src/index.ts'),
    edge('packages/ui/src/views/home.tsx', 'packages/core/src/paths.ts'),
    edge('packages/ui/src/views/settings.tsx', 'packages/core/src/paths.ts', { typeOnly: true }),
    edge('packages/ui/src/app.tsx', 'packages/ui/src/views/home.tsx'),
    edge('packages/core/src/index.ts', 'packages/core/src/paths.ts'),
    edge('scripts/build.mjs', 'packages/core/src/index.ts'),
  ],
  {
    packageRoots: [{ folder: 'packages/core', name: '@acme/core' }],
    purposes: { 'packages/ui/src': 'The app' },
  },
);

describe('buildDiagramTree', () => {
  const tree = buildDiagramTree(monorepo);

  it('folds pass-through chains and names package roots', () => {
    const packages = tree.folders.get('packages')!;
    expect(packages.folders).toEqual(['packages/core/src', 'packages/ui/src']);
    expect(tree.folders.get('packages/core/src')!.label).toBe('@acme/core');
    expect(tree.folders.get('packages/ui/src')!.label).toBe('ui/src');
    expect(tree.folders.get('packages/ui/src')!.purpose).toBe('The app');
    expect(tree.folders.has('packages/core')).toBe(false);
    expect(tree.folders.get('')!.files).toEqual(['README.md']);
    expect(tree.folders.get('')!.fileCount).toBe(7);
    expect(tree.folderOfFile.get('packages/ui/src/views/home.tsx')).toBe('packages/ui/src/views');
  });

  it('lists a file’s display folders from the top', () => {
    expect(displayAncestors(tree, 'packages/ui/src/views/home.tsx')).toEqual([
      'packages',
      'packages/ui/src',
      'packages/ui/src/views',
    ]);
  });

  it('opens a small project all the way and a large one within its budget', () => {
    expect([...defaultDiagramExpansion(tree)].sort()).toEqual([
      'packages',
      'packages/core/src',
      'packages/ui/src',
      'packages/ui/src/views',
      'scripts',
    ]);
    const tight = defaultDiagramExpansion(tree, 4);
    expect(tight.has('packages')).toBe(true);
    expect(tight.size).toBeLessThan(5);

    const big = buildDiagramTree(
      graph(
        Array.from({ length: 400 }, (_, i) => file(`src/area${i % 8}/f${i}.ts`)),
        [],
      ),
    );
    const open = defaultDiagramExpansion(big, 150);
    const shape = shapeDiagram({ nodes: [], edges: [] }, big, { expanded: open });
    expect(shape.nodes.length).toBeLessThanOrEqual(150);
    expect(open).toEqual(defaultDiagramExpansion(big, 150));
  });
});

describe('shapeDiagram', () => {
  const tree = buildDiagramTree(monorepo);

  it('sums file imports into one weighted edge between closed folders', () => {
    const shape = shapeDiagram(monorepo, tree, { expanded: new Set(['packages']) });
    const ids = shape.nodes.map((n) => n.id);
    expect(ids).toEqual([
      folderNodeId('packages'),
      folderNodeId('packages/core/src'),
      folderNodeId('packages/ui/src'),
      folderNodeId('scripts'),
      'README.md',
    ]);
    const ui = shape.nodes.find((n) => n.id === folderNodeId('packages/ui/src'))!;
    expect(ui).toMatchObject({ parent: folderNodeId('packages'), open: false, fileCount: 3 });
    const uiToCore = shape.edges.find((e) => e.source === folderNodeId('packages/ui/src'))!;
    expect(uiToCore).toMatchObject({
      target: folderNodeId('packages/core/src'),
      weight: 3,
      typeOnly: false,
      bidirectional: false,
    });
    expect(uiToCore.sample).toHaveLength(3);
    expect(shape.stats.internalEdges).toBe(2);
    // README is a document, not code, but it is not an asset either.
    expect(shape.stats.files).toBe(7);
  });

  it('shows files inside open folders and keeps edge facts', () => {
    const shape = shapeDiagram(monorepo, tree, {
      expanded: defaultDiagramExpansion(tree),
      hideShortcuts: false,
    });
    const settings = shape.edges.find((e) => e.source === 'packages/ui/src/views/settings.tsx')!;
    expect(settings.typeOnly).toBe(true);
    const home = shape.nodes.find((n) => n.id === 'packages/ui/src/views/home.tsx')!;
    expect(home).toMatchObject({ kind: 'file', parent: folderNodeId('packages/ui/src/views') });
    expect(visibleIdForPath(tree, new Set(), 'packages/ui/src/views/home.tsx')).toBe(
      folderNodeId('packages'),
    );
    expect(
      visibleIdForPath(tree, defaultDiagramExpansion(tree), 'packages/ui/src/views/home.tsx'),
    ).toBe('packages/ui/src/views/home.tsx');
  });

  it('leaves data, config and style files out unless asked', () => {
    const g = graph(
      [file('a.ts'), file('theme.css', { use: 'style' })],
      [edge('a.ts', 'theme.css')],
    );
    const t = buildDiagramTree(g);
    expect(shapeDiagram(g, t, { expanded: new Set() }).nodes.map((n) => n.id)).toEqual(['a.ts']);
    expect(shapeDiagram(g, t, { expanded: new Set(), includeAssets: true }).edges).toHaveLength(1);
  });

  it('merges mutual use into one two-way edge and marks runtime cycles', () => {
    const g = graph(
      [file('a.ts'), file('b.ts'), file('c.ts')],
      [
        edge('a.ts', 'b.ts'),
        edge('b.ts', 'a.ts'),
        edge('b.ts', 'c.ts'),
        edge('c.ts', 'b.ts', { typeOnly: true }),
      ],
    );
    const shape = shapeDiagram(g, buildDiagramTree(g), { expanded: new Set() });
    expect(shape.edges).toHaveLength(2);
    const ab = shape.edges.find((e) => [e.source, e.target].sort().join() === 'a.ts,b.ts')!;
    expect(ab).toMatchObject({ bidirectional: true, cycle: true, weight: 2 });
    const bc = shape.edges.find((e) => [e.source, e.target].sort().join() === 'b.ts,c.ts')!;
    expect(bc.cycle).toBe(false);
    expect(shape.nodes.filter((n) => n.inCycle).map((n) => n.id)).toEqual(['a.ts', 'b.ts']);
    expect(shape.stats.cycles).toBe(1);
  });

  it('hides an edge a longer path already implies, but never a cycle', () => {
    const g = graph(
      [file('a.ts'), file('b.ts'), file('c.ts')],
      [edge('a.ts', 'b.ts'), edge('b.ts', 'c.ts'), edge('a.ts', 'c.ts')],
    );
    const t = buildDiagramTree(g);
    const shape = shapeDiagram(g, t, { expanded: new Set() });
    expect(shape.edges.map((e) => e.id)).toEqual(['a.ts>b.ts', 'b.ts>c.ts']);
    expect(shape.stats.shortcutsHidden).toBe(1);
    expect(shapeDiagram(g, t, { expanded: new Set(), hideShortcuts: false }).edges).toHaveLength(3);
  });

  it('keeps every line into and out of the focus file, even a shortcut', () => {
    const g = graph(
      [file('a.ts'), file('b.ts'), file('c.ts')],
      [edge('a.ts', 'b.ts'), edge('b.ts', 'c.ts'), edge('a.ts', 'c.ts')],
    );
    const t = buildDiagramTree(g);
    const shape = shapeDiagram(g, t, { expanded: new Set(), focus: { path: 'c.ts', usedBy: 2 } });
    expect(shape.edges.map((e) => e.id).sort()).toEqual(['a.ts>b.ts', 'a.ts>c.ts', 'b.ts>c.ts']);
  });

  it('stubs a hub everything uses', () => {
    const users = Array.from({ length: 14 }, (_, i) => file(`u${String(i).padStart(2, '0')}.ts`));
    const g = graph(
      [...users, file('log.ts'), file('main.ts')],
      [...users.map((u) => edge(u.id, 'log.ts')), edge('main.ts', 'u00.ts')],
    );
    const shape = shapeDiagram(g, buildDiagramTree(g), { expanded: new Set() });
    const log = shape.nodes.find((n) => n.id === 'log.ts')!;
    expect(log).toMatchObject({ hub: true, stubbedIn: 14 });
    expect(shape.edges.map((e) => e.id)).toEqual(['main.ts>u00.ts']);
    expect(shape.stats.hubs).toEqual(['log.ts']);
  });

  it('focuses on one file and what it uses and is used by', () => {
    const g = graph(
      [file('src/a.ts'), file('src/b.ts'), file('lib/c.ts'), file('lib/d.ts'), file('e.ts')],
      [
        edge('src/a.ts', 'src/b.ts'),
        edge('src/b.ts', 'lib/c.ts'),
        edge('lib/c.ts', 'lib/d.ts'),
        edge('e.ts', 'src/b.ts'),
      ],
    );
    const t = buildDiagramTree(g);
    const shape = shapeDiagram(g, t, { expanded: new Set(), focus: { path: 'src/b.ts' } });
    const files = shape.nodes.filter((n) => n.kind === 'file').map((n) => n.id);
    expect(files.sort()).toEqual(['e.ts', 'lib/c.ts', 'src/a.ts', 'src/b.ts']);
    expect(shape.nodes.filter((n) => n.kind === 'folder').every((n) => n.open)).toBe(true);
    expect(shape.nodes.find((n) => n.id === 'lib/c.ts')!.hiddenNeighbors).toBe(1);

    const deeper = shapeDiagram(g, t, {
      expanded: new Set(),
      focus: { path: 'src/b.ts', uses: 2, usedBy: 0 },
    });
    expect(
      deeper.nodes
        .filter((n) => n.kind === 'file')
        .map((n) => n.id)
        .sort(),
    ).toEqual(['lib/c.ts', 'lib/d.ts', 'src/b.ts']);
  });

  it('gives the same answer every time, and stays fast on a large project', () => {
    const files = Array.from({ length: 5000 }, (_, i) =>
      file(`pkg${i % 12}/src/area${i % 40}/f${i}.ts`, { importance: (i % 97) / 97 }),
    );
    const edges: FileGraphEdge[] = [];
    for (let i = 0; i < 15000; i++) {
      edges.push(edge(files[(i * 7) % 5000]!.id, files[(i * 13 + 5) % 5000]!.id));
    }
    const g = graph(files, edges);
    const started = performance.now();
    const t = buildDiagramTree(g);
    const shape = shapeDiagram(g, t, { expanded: defaultDiagramExpansion(t) });
    const elapsed = performance.now() - started;
    expect(shape.nodes.length).toBeLessThanOrEqual(150);
    expect(elapsed).toBeLessThan(1500);
    expect(shapeDiagram(g, t, { expanded: defaultDiagramExpansion(t) })).toEqual(shape);
  });
});

describe('graph algorithms', () => {
  it('finds strongly connected components without recursion', () => {
    const n = 20000;
    const succ = Array.from({ length: n }, (_, i) => (i + 1 < n ? [i + 1] : [0]));
    const { size } = stronglyConnected(n, succ);
    expect(size).toEqual([n]);
  });

  it('flags only edges a longer path implies', () => {
    expect(
      redundantEdges(4, [
        [0, 1],
        [1, 2],
        [0, 2],
        [2, 3],
        [0, 3],
      ]),
    ).toEqual([false, false, true, false, true]);
  });
});
