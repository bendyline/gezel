import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitHubPullFile, MapBlock } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isGitInstalled, runGit } from '../git/git.js';
import { indexWorkspaceContent } from '../index-store/content-indexer.js';
import { refreshGitStats, resetGitProbeForTests } from '../index-store/git-stats.js';
import { IndexStore } from '../index-store/index-store.js';
import { extractImportEdges } from '../index-store/symbols.js';
import { resolveImportEdges, resolveImportEdgesDetailed } from './affinity.js';
import { buildFileMap } from './build.js';
import { civicThreshold, computeHealth, normalizeSeverity } from './health.js';
import { buildPrOverlay } from './pr-overlay.js';
import { isTestFile } from './sections.js';
import { VillageFileStore } from './village-file.js';

const gitOk = await isGitInstalled();

describe('extractImportEdges', () => {
  it('captures TS import/export/require specifiers, ignoring locals', async () => {
    const code = [
      "import { x } from './b';",
      "import fs from 'fs';",
      "const y = require('./c');",
      "export { z } from './d';",
      'export const local = "not-a-specifier";',
    ].join('\n');
    const edges = await extractImportEdges('typescript', code);
    expect(edges).not.toBeNull();
    const set = new Set(edges!.map((e) => e.raw));
    expect(set.has('./b')).toBe(true);
    expect(set.has('fs')).toBe(true);
    expect(set.has('./c')).toBe(true);
    expect(set.has('./d')).toBe(true);
    expect(set.has('not-a-specifier')).toBe(false);
  });

  it('records named/default/namespace/aliased bindings for TS imports', async () => {
    const code = [
      "import { foo, bar as baz } from './b.js';",
      "import def from './c.js';",
      "import * as ns from './d.js';",
      "import type { Shape } from './e.js';",
      "import './side-effect.js';",
    ].join('\n');
    const edges = await extractImportEdges('typescript', code);
    expect(edges).not.toBeNull();
    const byRaw = new Map(edges!.map((e) => [e.raw, e.bindings]));
    expect(byRaw.get('./b.js')).toEqual([
      { name: 'foo', local: 'foo', kind: 'named' },
      { name: 'bar', local: 'baz', kind: 'named' },
    ]);
    expect(byRaw.get('./c.js')).toEqual([{ name: 'default', local: 'def', kind: 'default' }]);
    expect(byRaw.get('./d.js')).toEqual([{ name: '*', local: 'ns', kind: 'namespace' }]);
    // type-only imports are real dependency edges and count as named bindings
    expect(byRaw.get('./e.js')).toEqual([{ name: 'Shape', local: 'Shape', kind: 'named' }]);
    // side-effect import: recorded with an EMPTY bindings list (takes no names),
    // distinct from undefined (whole-module)
    expect(byRaw.get('./side-effect.js')).toEqual([]);
  });

  it('keeps constant template specifiers but drops interpolated ones', async () => {
    const code = [
      'const a = await import(`lodash`);',
      'const b = await import(`./mods/${name}.js`);',
      'const c = require(`${base}/plugin`);',
    ].join('\n');
    const edges = await extractImportEdges('typescript', code);
    expect(edges).not.toBeNull();
    const set = new Set(edges!.map((e) => e.raw));
    expect(set.has('lodash')).toBe(true);
    // Interpolated templates ship unresolvable `${…}` text — no edge at all.
    expect(set.size).toBe(1);
  });

  it('records re-export bindings and treats export * as whole-module', async () => {
    const code = ["export { a, b as c } from './x.js';", "export * from './y.js';"].join('\n');
    const edges = await extractImportEdges('typescript', code);
    const byRaw = new Map(edges!.map((e) => [e.raw, e.bindings]));
    expect(byRaw.get('./x.js')).toEqual([
      { name: 'a', local: 'a', kind: 'named' },
      { name: 'b', local: 'c', kind: 'named' },
    ]);
    expect(byRaw.get('./y.js')).toEqual([{ name: '*', local: '*', kind: 'namespace' }]);
  });

  it('merges duplicate specifiers across statements, deduping bindings', async () => {
    const code = [
      "import { foo } from './b.js';",
      "import { foo, bar } from './b.js';",
      "const dyn = require('./b.js');",
    ].join('\n');
    const edges = await extractImportEdges('typescript', code);
    expect(edges!.length).toBe(1);
    const bindings = edges![0]!.bindings!;
    expect(bindings).toContainEqual({ name: 'foo', local: 'foo', kind: 'named' });
    expect(bindings).toContainEqual({ name: 'bar', local: 'bar', kind: 'named' });
    expect(bindings.filter((b) => b.name === 'foo').length).toBe(1);
    // require() takes the whole module
    expect(bindings).toContainEqual({ name: '*', local: '*', kind: 'namespace' });
  });

  it('records python from-imports best-effort and module imports as namespace', async () => {
    const code = ['import os.path', 'from a.b import c, d as e', 'from f import *'].join('\n');
    const edges = await extractImportEdges('python', code);
    expect(edges).not.toBeNull();
    const byRaw = new Map(edges!.map((e) => [e.raw, e.bindings]));
    expect(byRaw.get('os.path')).toEqual([{ name: '*', local: 'os', kind: 'namespace' }]);
    expect(byRaw.get('a.b')).toEqual([
      { name: 'c', local: 'c', kind: 'named' },
      { name: 'd', local: 'e', kind: 'named' },
    ]);
    expect(byRaw.get('f')).toEqual([{ name: '*', local: '*', kind: 'namespace' }]);
  });

  it('leaves bindings unrecorded for languages we do not dissect', async () => {
    const edges = await extractImportEdges('go', 'package x\nimport "fmt"\n');
    expect(edges).not.toBeNull();
    const fmt = edges!.find((e) => e.raw === 'fmt');
    expect(fmt).toBeDefined();
    expect(fmt!.bindings).toBeUndefined();
  });
});

describe('resolveImportEdges', () => {
  it('resolves relative specifiers (with extension + index probing) and drops bare ones', () => {
    const paths = ['src/a.ts', 'src/b.ts', 'src/util/index.ts'];
    const edges = resolveImportEdges(paths, [
      { srcPath: 'src/a.ts', raw: './b' },
      { srcPath: 'src/a.ts', raw: './util' },
      { srcPath: 'src/a.ts', raw: 'react' },
    ]);
    expect(edges).toContainEqual({ src: 'src/a.ts', dst: 'src/b.ts' });
    expect(edges).toContainEqual({ src: 'src/a.ts', dst: 'src/util/index.ts' });
    expect(edges.some((e) => e.dst === 'react')).toBe(false);
  });

  it("resolves NodeNext '.js' specifiers to the '.ts' sources on disk", () => {
    const paths = ['src/a.ts', 'src/chat/manager.ts', 'src/ui/Panel.tsx'];
    const edges = resolveImportEdges(paths, [
      { srcPath: 'src/a.ts', raw: './chat/manager.js' },
      { srcPath: 'src/a.ts', raw: './ui/Panel.jsx' },
    ]);
    expect(edges).toContainEqual({ src: 'src/a.ts', dst: 'src/chat/manager.ts' });
    expect(edges).toContainEqual({ src: 'src/a.ts', dst: 'src/ui/Panel.tsx' });
  });
});

describe('resolveImportEdgesDetailed', () => {
  it('carries bindings through resolution, merging per (src, dst) pair', () => {
    const paths = ['src/a.ts', 'src/b.ts', 'src/b-extra.ts'];
    const edges = resolveImportEdgesDetailed(paths, [
      {
        srcPath: 'src/a.ts',
        raw: './b.js',
        bindings: [{ name: 'foo', local: 'foo', kind: 'named' }],
      },
      {
        srcPath: 'src/a.ts',
        raw: './b', // same target via a different spelling
        bindings: [{ name: 'bar', local: 'bar', kind: 'named' }],
      },
      { srcPath: 'src/a.ts', raw: 'react', bindings: null },
    ]);
    expect(edges.length).toBe(1);
    expect(edges[0]!.dst).toBe('src/b.ts');
    expect(edges[0]!.bindings).toContainEqual({ name: 'foo', local: 'foo', kind: 'named' });
    expect(edges[0]!.bindings).toContainEqual({ name: 'bar', local: 'bar', kind: 'named' });
  });

  it('null bindings are absorbing (whole-module wins over named info)', () => {
    const paths = ['src/a.ts', 'src/b.ts'];
    const edges = resolveImportEdgesDetailed(paths, [
      {
        srcPath: 'src/a.ts',
        raw: './b.js',
        bindings: [{ name: 'foo', local: 'foo', kind: 'named' }],
      },
      { srcPath: 'src/a.ts', raw: './b', bindings: null },
    ]);
    expect(edges.length).toBe(1);
    expect(edges[0]!.bindings).toBeNull();
  });
});

describe('section classification', () => {
  it('detects test files by name and by folder', () => {
    expect(isTestFile('src/a.test.ts')).toBe(true);
    expect(isTestFile('src/a.spec.tsx')).toBe(true);
    expect(isTestFile('packages/x/__tests__/a.ts')).toBe(true);
    expect(isTestFile('e2e/login.ts')).toBe(true);
    expect(isTestFile('test/helpers/util.ts')).toBe(true);
    expect(isTestFile('src/a.ts')).toBe(false);
    expect(isTestFile('src/contest/a.ts')).toBe(true); // "*test*" folder, by design
  });
});

describe('map health policy', () => {
  const base = { loc: 100, symbolCount: 3, findings: 0, maxSeverity: null, fanIn: 1, fanOut: 2 };

  it('grades vibe from findings, size, and structure', () => {
    expect(computeHealth(base, 8).vibe).toBe('lush');
    expect(computeHealth({ ...base, fanIn: 0 }, 8).vibe).toBe('tidy');
    expect(computeHealth({ ...base, symbolCount: 0, fanIn: 0, fanOut: 0 }, 8).vibe).toBe('plain');
    expect(computeHealth({ ...base, loc: 900 }, 8).vibe).toBe('scruffy');
    expect(computeHealth({ ...base, findings: 2, maxSeverity: 'low' as const }, 8).vibe).toBe(
      'scruffy',
    );
    expect(computeHealth({ ...base, findings: 1, maxSeverity: 'critical' as const }, 8).vibe).toBe(
      'blighted',
    );
  });

  it('zones by dependency role: houses, shops, civic hubs, industry', () => {
    expect(computeHealth(base, 8).zone).toBe('residential');
    expect(computeHealth({ ...base, fanIn: 3 }, 8).zone).toBe('commercial');
    expect(computeHealth({ ...base, fanIn: 8 }, 8).zone).toBe('civic');
    expect(computeHealth({ ...base, loc: 1500 }, 8).zone).toBe('industrial');
    // a hub everyone imports is civic even when it's huge
    expect(computeHealth({ ...base, loc: 1500, fanIn: 9 }, 8).zone).toBe('civic');
  });

  it('civicThreshold is the p95 of positive fan-ins, floored at 8', () => {
    expect(civicThreshold([])).toBe(8);
    expect(civicThreshold([0, 1, 2])).toBe(8);
    expect(civicThreshold(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(96);
  });

  it('normalizeSeverity clamps unknown tool severities to null', () => {
    expect(normalizeSeverity('HIGH')).toBe('high');
    expect(normalizeSeverity('weird')).toBeNull();
    expect(normalizeSeverity(null)).toBeNull();
  });
});

describe('buildPrOverlay', () => {
  const f = (
    filename: string,
    status: string,
    additions = 1,
    deletions = 0,
    previousFilename?: string,
  ): GitHubPullFile => ({
    filename,
    status,
    additions,
    deletions,
    changes: additions + deletions,
    ...(previousFilename ? { previousFilename } : {}),
  });

  const blk = (id: string): MapBlock => ({
    id,
    districtId: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
    rect: { x: 0, y: 0, w: 10, h: 10 },
    label: id,
    weight: 5,
    state: 'live',
    buildingCount: 0,
  });
  const map = {
    blocks: [blk('src/a.ts'), blk('src/b.ts'), blk('src/old.ts')],
    districts: [
      {
        id: 'src',
        parentId: null,
        rect: { x: 0, y: 0, w: 100, h: 100 },
        label: 'src',
        depth: 1,
        fileCount: 3,
        weight: 15,
      },
    ],
    bounds: { x: 0, y: 0, w: 100, h: 100 },
  };

  it('maps GitHub statuses to change kinds and only keeps blocks in the map', () => {
    const { overlay } = buildPrOverlay({
      prNumber: 7,
      title: 'My PR',
      map,
      files: [
        f('src/a.ts', 'modified', 10, 2),
        f('src/b.ts', 'removed', 0, 5),
        f('src/new.ts', 'renamed', 1, 1, 'src/old.ts'), // new path absent → match old
      ],
    });
    expect(overlay.prNumber).toBe(7);
    expect(overlay.title).toBe('My PR');
    const byId = new Map(overlay.changedBlocks.map((c) => [c.blockId, c]));
    expect(byId.get('src/a.ts')?.change).toBe('modified');
    expect(byId.get('src/b.ts')?.change).toBe('deleted');
    // renamed file's new path isn't indexed → it lands on the old block, with fromPath
    expect(byId.get('src/old.ts')?.change).toBe('renamed');
    expect(byId.get('src/old.ts')?.fromPath).toBe('src/old.ts');
  });

  it('synthesizes a non-overlapping phantom block for a PR-added file', () => {
    const { overlay, phantomBlocks } = buildPrOverlay({
      prNumber: 9,
      map,
      files: [f('src/added.ts', 'added', 30, 0)],
    });
    expect(phantomBlocks).toHaveLength(1);
    const ghost = phantomBlocks[0]!;
    expect(ghost.id).toBe('src/added.ts');
    expect(ghost.phantom).toBe(true);
    expect(ghost.state).toBe('new');
    // placed clear of the existing block at (0,0,10,10)
    const overlaps =
      ghost.rect.x < 10 &&
      ghost.rect.x + ghost.rect.w > 0 &&
      ghost.rect.y < 10 &&
      ghost.rect.y + ghost.rect.h > 0;
    expect(overlaps).toBe(false);
    // and it's reported as an 'added' change
    expect(overlay.changedBlocks.find((c) => c.blockId === 'src/added.ts')?.change).toBe('added');
  });
});

describe('buildFileMap (end-to-end over a real index)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-filemap-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('produces districts, blocks, buildings, and import roads', async () => {
    await mkdir(join(dir, 'src', 'util'), { recursive: true });
    await writeFile(
      join(dir, 'src', 'a.ts'),
      "import { b } from './b';\nimport { c } from './util/c';\nexport function alpha() { return b() + c(); }\n",
    );
    await writeFile(join(dir, 'src', 'b.ts'), 'export function b() { return 1; }\n');
    await writeFile(join(dir, 'src', 'util', 'c.ts'), 'export function c() { return 2; }\n');
    await writeFile(join(dir, 'src', 'a.test.ts'), "import { alpha } from './a';\nalpha();\n");
    await writeFile(join(dir, 'tsconfig.json'), '{ "compilerOptions": {} }\n');

    const store = (await IndexStore.open(join(dir, '.gezel', 'index.db'), {
      collectionId: 'proj-1',
      kind: 'workspace',
      rootPath: dir,
    }))!;
    expect(store).not.toBeNull();
    try {
      await indexWorkspaceContent(store, dir, join(dir, '.gezel', 'artifacts'));
      const map = await buildFileMap(store, dir, { persist: true });

      expect(map.indexed).toBe(true);
      const blockIds = new Set(map.blocks.map((b) => b.id));
      expect(blockIds.has('src/a.ts')).toBe(true);
      expect(blockIds.has('src/b.ts')).toBe(true);
      expect(blockIds.has('src/util/c.ts')).toBe(true);
      // default 'core' scope excludes tests; config joins the map as a tower
      expect(blockIds.has('src/a.test.ts')).toBe(false);
      expect(blockIds.has('tsconfig.json')).toBe(true);
      expect(map.blocks.find((b) => b.id === 'tsconfig.json')!.levels).toBeGreaterThanOrEqual(3);

      // districts for both folders, nested
      const districtIds = new Set(map.districts.map((d) => d.id));
      expect(districtIds.has('src')).toBe(true);
      expect(districtIds.has('src/util')).toBe(true);

      // import roads resolved a→b and a→util/c
      const roadKey = (a: string, b: string) => [a, b].sort().join('|');
      const roads = new Set(map.roads.map((r) => roadKey(r.a, r.b)));
      expect(roads.has(roadKey('src/a.ts', 'src/b.ts'))).toBe(true);
      expect(roads.has(roadKey('src/a.ts', 'src/util/c.ts'))).toBe(true);

      // buildings: at least the three exported functions
      expect(map.buildings.length).toBeGreaterThanOrEqual(3);

      // re-build is stable: a.ts block keeps its coordinate
      const before = map.blocks.find((b) => b.id === 'src/a.ts')!.rect;
      const map2 = await buildFileMap(store, dir, { persist: true });
      const after = map2.blocks.find((b) => b.id === 'src/a.ts')!.rect;
      expect(after.x).toBe(before.x);
      expect(after.y).toBe(before.y);

      // 'tests' scope is the test city — only test files, no core
      const tests = await buildFileMap(store, dir, { scope: 'tests', persist: true });
      const testIds = new Set(tests.blocks.map((b) => b.id));
      expect(testIds.has('src/a.test.ts')).toBe(true);
      expect(testIds.has('src/a.ts')).toBe(false);

      // 'all' scope includes core + tests
      const all = await buildFileMap(store, dir, { scope: 'all', persist: true });
      const allIds = new Set(all.blocks.map((b) => b.id));
      expect(allIds.has('src/a.ts')).toBe(true);
      expect(allIds.has('src/a.test.ts')).toBe(true);
      expect(allIds.has('tsconfig.json')).toBe(true);

      // "All" composes the two durable neighborhoods instead of packing a
      // third city. Code stays put; Tests moves as one rigid body, preserving
      // every internal distance and shape from its standalone view.
      expect(all.domain).toBe('code:all');
      expect(all.districts.some((d) => d.displayLabel === 'Code')).toBe(true);
      expect(all.districts.some((d) => d.displayLabel === 'Tests')).toBe(true);
      const codeBefore = map.blocks.find((b) => b.id === 'src/a.ts')!;
      const codeInAll = all.blocks.find((b) => b.id === 'src/a.ts')!;
      expect(codeInAll.rect).toEqual(codeBefore.rect);
      expect(codeInAll.lot).toEqual(codeBefore.lot);
      const testBefore = tests.blocks.find((b) => b.id === 'src/a.test.ts')!;
      const testInAll = all.blocks.find((b) => b.id === 'src/a.test.ts')!;
      const testDx = testInAll.rect.x - testBefore.rect.x;
      const testDy = testInAll.rect.y - testBefore.rect.y;
      expect(testInAll.rect.w).toBe(testBefore.rect.w);
      expect(testInAll.rect.h).toBe(testBefore.rect.h);
      expect(testDx).not.toBe(0);
      expect(testInAll.lot).toEqual({
        x: testBefore.lot!.x + testDx,
        y: testBefore.lot!.y + testDy,
        w: testBefore.lot!.w,
        h: testBefore.lot!.h,
      });
      const shifted = (rect: { x: number; y: number; w: number; h: number }) => ({
        x: rect.x + testDx,
        y: rect.y + testDy,
        w: rect.w,
        h: rect.h,
      });
      for (const district of tests.districts) {
        const composed = all.districts.find((d) => d.id === `scope:tests:${district.id}`)!;
        expect(composed.rect).toEqual(shifted(district.rect));
        if (district.labelPlate) expect(composed.labelPlate).toEqual(shifted(district.labelPlate));
      }
      for (const building of tests.buildings) {
        expect(all.buildings.find((b) => b.id === building.id)?.rect).toEqual(
          shifted(building.rect),
        );
      }
      for (const street of tests.streets ?? []) {
        expect(all.streets?.find((s) => s.id === `scope:tests:${street.id}`)?.rect).toEqual(
          shifted(street.rect),
        );
      }
      for (const plaza of tests.plazas ?? []) {
        expect(all.plazas?.find((p) => p.id === `scope:tests:${plaza.id}`)?.rect).toEqual(
          shifted(plaza.rect),
        );
      }
      expect(new Set(all.districts.map((d) => d.id)).size).toBe(all.districts.length);

      // a persisted row that the scope now excludes (a test file in the core
      // city) is purged, not shown as a tombstone, and removed from the layout
      // cache entirely.
      store.replaceLayout('code', [
        ...store.layoutNodes('code'),
        {
          nodeKind: 'block',
          nodeId: 'src/legacy.test.ts',
          parentId: null,
          contentHash: 'h',
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          weight: 5,
          placedAt: '2026-01-01T00:00:00.000Z',
          removedAt: null,
        },
      ]);
      const purged = await buildFileMap(store, dir, { scope: 'core', persist: true });
      expect(purged.blocks.some((b) => b.id === 'src/legacy.test.ts')).toBe(false);
      expect(store.layoutNodes('code').some((r) => r.nodeId === 'src/legacy.test.ts')).toBe(false);

      // v4 city layout: streets are materialized and every block has a lot
      // (persistence unit) enclosing its footprint (`rect`)
      expect(purged.streets?.length ?? 0).toBeGreaterThan(0);
      for (const b of purged.blocks) {
        expect(b.lot).toBeDefined();
        expect(b.rect.x).toBeGreaterThanOrEqual(b.lot!.x);
        expect(b.rect.y).toBeGreaterThanOrEqual(b.lot!.y);
        expect(b.rect.x + b.rect.w).toBeLessThanOrEqual(b.lot!.x + b.lot!.w + 0.001);
        expect(b.rect.y + b.rect.h).toBeLessThanOrEqual(b.lot!.y + b.lot!.h + 0.001);
      }
      expect(store.layoutNodes('code').some((r) => r.nodeKind === 'street')).toBe(true);

      // health rides on every live block; b.ts is imported by a.ts → lush yard
      for (const b of purged.blocks.filter((x) => x.state !== 'tombstoned')) {
        expect(b.health).toBeDefined();
      }
      const bTs = purged.blocks.find((b) => b.id === 'src/b.ts')!;
      expect(bTs.health?.fanIn).toBe(1);
      expect(bTs.health?.vibe).toBe('lush');
      expect(bTs.health?.zone).toBe('residential');

      // V3 signals: no git repo in this fixture → gitAvailable false, no churn
      // or lastTouchedAt anywhere, but levels + importance still flow.
      expect(purged.signals).toEqual({ gitAvailable: false, churnWindowDays: 365 });
      for (const b of purged.blocks.filter((x) => x.state !== 'tombstoned')) {
        expect(b.levels).toBeGreaterThanOrEqual(1);
        expect(b.levels).toBeLessThanOrEqual(5);
        expect(b.lastTouchedAt).toBeUndefined();
        expect(b.health?.churn).toBeUndefined();
        expect(b.health?.importance).toBeDefined();
      }
      // b.ts (imported) outranks a.ts (importer-only) in centrality
      const aTs = purged.blocks.find((b) => b.id === 'src/a.ts')!;
      expect(bTs.health!.importance!).toBeGreaterThan(aTs.health!.importance!);
      // determinism: an immediate rebuild yields identical levels/importance
      const again = await buildFileMap(store, dir, { persist: false });
      for (const b of again.blocks) {
        const prev = purged.blocks.find((p) => p.id === b.id)!;
        expect(b.levels).toBe(prev.levels);
        expect(b.health?.importance).toBe(prev.health?.importance);
      }

      // a layout-version bump re-seeds coordinates but carries placedAt
      // forward, so the age lens doesn't reset to "everything new"
      const oldPlaced = '2025-12-25T00:00:00.000Z';
      store.replaceLayout(
        'code',
        store
          .layoutNodes('code')
          .map((r) => (r.nodeKind === 'block' ? { ...r, placedAt: oldPlaced } : r)),
      );
      store.setMeta('map_layout_version:code', '0');
      const reseeded = await buildFileMap(store, dir, { persist: true });
      for (const b of reseeded.blocks) {
        expect(b.placedAt).toBe(oldPlaced);
      }
      expect(store.getMeta('map_layout_version:code')).not.toBe('0');
    } finally {
      store.close();
    }
  });

  it.skipIf(!gitOk)(
    'excludes .gitignore matches and purges blocks placed before the rule existed',
    async () => {
      await mkdir(join(dir, 'src'), { recursive: true });
      await mkdir(join(dir, 'generated'), { recursive: true });
      await writeFile(join(dir, 'src', 'kept.ts'), 'export const kept = true;\n');
      await writeFile(join(dir, 'generated', 'hidden.ts'), 'export const hidden = true;\n');
      await runGit(['init', '-q'], { cwd: dir });

      const store = (await IndexStore.open(join(dir, '.gezel', 'index.db'), {
        collectionId: 'proj-1',
        kind: 'workspace',
        rootPath: dir,
      }))!;
      try {
        await indexWorkspaceContent(store, dir, join(dir, '.gezel', 'artifacts'));
        const beforeIgnore = await buildFileMap(store, dir, { persist: true });
        expect(beforeIgnore.blocks.some((block) => block.id === 'generated/hidden.ts')).toBe(true);
        expect(
          store.layoutNodes('code').some((node) => node.nodeId === 'generated/hidden.ts'),
        ).toBe(true);

        // The ignore rule is read live by Village; no content re-index is
        // necessary for an updated `.gitignore` to take effect.
        await writeFile(join(dir, '.gitignore'), 'generated/\n');
        const afterIgnore = await buildFileMap(store, dir, { persist: true });

        expect(afterIgnore.blocks.some((block) => block.id === 'src/kept.ts')).toBe(true);
        expect(afterIgnore.blocks.some((block) => block.id === 'generated/hidden.ts')).toBe(false);
        expect(
          store.layoutNodes('code').some((node) => node.nodeId === 'generated/hidden.ts'),
        ).toBe(false);
      } finally {
        store.close();
      }
    },
  );

  it.skipIf(!gitOk)(
    'carries git churn + last-commit onto the wire when the workspace is a repo',
    async () => {
      resetGitProbeForTests();
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
      await runGit(['init', '-q'], { cwd: dir });
      await runGit(['config', 'user.email', 'test@example.com'], { cwd: dir });
      await runGit(['config', 'user.name', 'Test'], { cwd: dir });
      const date = '2026-06-15T00:00:00Z';
      await runGit(['add', '-A'], { cwd: dir });
      await runGit(['commit', '-m', 'seed', '-q'], {
        cwd: dir,
        env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });

      const store = (await IndexStore.open(join(dir, '.gezel', 'index.db'), {
        collectionId: 'proj-1',
        kind: 'workspace',
        rootPath: dir,
      }))!;
      try {
        await indexWorkspaceContent(store, dir, join(dir, '.gezel', 'artifacts'));
        await refreshGitStats(store, dir, { now: () => Date.parse('2026-07-01T00:00:00Z') });
        const map = await buildFileMap(store, dir, { persist: false });
        expect(map.signals?.gitAvailable).toBe(true);
        const aTs = map.blocks.find((b) => b.id === 'src/a.ts')!;
        expect(aTs.lastTouchedAt).toBe('2026-06-15T00:00:00.000Z');
        expect(aTs.health?.churn).toBe(1);
      } finally {
        store.close();
      }
    },
  );

  async function seedWorkspace(): Promise<void> {
    await mkdir(join(dir, 'src', 'util'), { recursive: true });
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(
      join(dir, 'src', 'a.ts'),
      "import { b } from './b';\nexport const a = () => b();\n",
    );
    await writeFile(join(dir, 'src', 'b.ts'), 'export function b() { return 1; }\n');
    await writeFile(join(dir, 'src', 'util', 'c.ts'), 'export const c = 2;\n');
    await writeFile(join(dir, 'docs', 'readme.md'), '# readme\n\nwords\n');
  }

  function makeCityStore(): VillageFileStore {
    return new VillageFileStore({
      workspaceDir: dir,
      primaryPath: join(dir, '.gezel', 'village.json'),
      fallbackPath: join(dir, 'fallback-home', 'village.json'),
    });
  }

  async function openIndex(name: string): Promise<IndexStore> {
    const store = (await IndexStore.open(join(dir, '.gezel', name), {
      collectionId: 'proj-1',
      kind: 'workspace',
      rootPath: dir,
    }))!;
    expect(store).not.toBeNull();
    return store;
  }

  it('assigns urbanity to live blocks and reports the field on the response', async () => {
    await seedWorkspace();
    const store = await openIndex('index.db');
    try {
      await indexWorkspaceContent(store, dir, join(dir, '.gezel', 'artifacts'));
      const map = await buildFileMap(store, dir, { persist: true });

      const live = map.blocks.filter((b) => b.state !== 'tombstoned' && !b.phantom);
      expect(live.length).toBeGreaterThan(0);
      for (const b of live) {
        expect(b.urbanity, `block ${b.id} has no urbanity`).toBeDefined();
        expect(b.settlement, `block ${b.id} has no settlement`).toBeDefined();
        expect(b.urbanity!).toBeGreaterThanOrEqual(0);
        expect(b.urbanity!).toBeLessThanOrEqual(1);
      }
      for (const b of map.blocks) {
        if (b.state === 'tombstoned') expect(b.urbanity).toBeUndefined();
      }

      expect(map.urbanity).toBeDefined();
      expect(map.urbanity!.fileCount).toBe(live.length);
      expect(map.urbanity!.peak).toBe(Math.max(...live.map((b) => b.urbanity!)));
      // A handful of files is a hamlet, never a city.
      expect(map.urbanity!.settlement).toBe('hamlet');
    } finally {
      store.close();
    }
  });

  it('rebuilding an unchanged workspace leaves urbanity and the city file untouched', async () => {
    // The git-churn guard. The urbanity field's parameters are global
    // normalizers recomputed each build; if they were not sticky, ordinary
    // rebuilds would rewrite a file we ask users to commit.
    await seedWorkspace();
    const city = makeCityStore();
    const store = await openIndex('index.db');
    try {
      await indexWorkspaceContent(store, dir, join(dir, '.gezel', 'artifacts'));
      const first = await buildFileMap(store, dir, {
        persist: true,
        villageFile: city,
        userFacing: true,
      });
      const cityPath = join(dir, '.gezel', 'village.json');
      const rawAfterFirst = await readFile(cityPath, 'utf8');
      const parsed = JSON.parse(rawAfterFirst);
      expect(parsed.domains.code.downtown).toBeDefined();
      // No provenance timestamps anywhere: not on the file, not on a domain,
      // not on an anchor, not on the downtown.
      expect(parsed.updatedAt).toBeUndefined();
      expect(parsed.domains.code.seededAt).toBeUndefined();
      expect(parsed.domains.code.downtown.recordedAt).toBeUndefined();
      for (const a of parsed.domains.code.anchors) expect(a.recordedAt).toBeUndefined();
      // Derived geometry carries no timestamp; only blocks do, because only a
      // block's placement and removal are read back (age lens, tombstone TTL).
      const journal = parsed.domains.code.journal as Array<Record<string, unknown>>;
      expect(journal.some((n) => n.k === 'plate' || n.k === 'street')).toBe(true);
      for (const n of journal) {
        if (n.k === 'block') continue;
        expect(n.a, `${String(n.k)} ${String(n.id)} carries a timestamp`).toBeUndefined();
        expect(n.d).toBeUndefined();
      }
      expect(journal.some((n) => n.k === 'block' && typeof n.a === 'string')).toBe(true);

      const second = await buildFileMap(store, dir, {
        persist: true,
        villageFile: city,
        userFacing: true,
      });
      for (const b of first.blocks) {
        const again = second.blocks.find((x) => x.id === b.id)!;
        expect(again.urbanity).toBe(b.urbanity);
        expect(again.settlement).toBe(b.settlement);
      }
      // The whole file, byte for byte. This used to compare only the domain
      // state because `updatedAt` was stamped on every write — which meant the
      // committed file got a diff on every background indexer tick regardless.
      // With provenance timestamps gone, the real guarantee is testable.
      expect(await readFile(cityPath, 'utf8')).toBe(rawAfterFirst);
    } finally {
      store.close();
    }
  });

  it('recovers the whole city from the journal after index-db loss', async () => {
    await seedWorkspace();
    const city = makeCityStore();

    const store1 = await openIndex('index.db');
    let firstBlocks: Map<string, { x: number; y: number }>;
    let firstStreets: string[];
    try {
      await indexWorkspaceContent(store1, dir, join(dir, '.gezel', 'artifacts'));
      // user-facing build → creates .gezel/village.json with anchors + journal
      const map = await buildFileMap(store1, dir, {
        persist: true,
        villageFile: city,
        userFacing: true,
      });
      firstBlocks = new Map(map.blocks.map((b) => [b.id, { x: b.lot!.x, y: b.lot!.y }]));
      firstStreets = (map.streets ?? []).map((s) => s.id).sort();
      expect(map.plazas).toBeDefined();
    } finally {
      store1.close();
    }
    const cityRaw = JSON.parse(await readFile(join(dir, '.gezel', 'village.json'), 'utf8'));
    expect(cityRaw.domains.code.layoutVersion).toBe(6);
    expect(cityRaw.domains.code.journal.length).toBeGreaterThan(0);
    expect(cityRaw.domains.code.anchors.length).toBeGreaterThan(0);

    // "Delete" the index db: a fresh store with no layout rows at all.
    const store2 = await openIndex('rebuilt.db');
    try {
      await indexWorkspaceContent(store2, dir, join(dir, '.gezel', 'artifacts'));
      const rebuilt = await buildFileMap(store2, dir, {
        persist: true,
        villageFile: city,
        userFacing: false,
      });
      // Coordinates survive to the journal's 0.1 rounding (a one-time,
      // sub-pixel shift); street ids survive exactly by design.
      for (const b of rebuilt.blocks) {
        const prev = firstBlocks.get(b.id);
        expect(prev, `block ${b.id} missing after recovery`).toBeDefined();
        expect(b.lot!.x).toBeCloseTo(prev!.x, 1);
        expect(b.lot!.y).toBeCloseTo(prev!.y, 1);
      }
      expect((rebuilt.streets ?? []).map((s) => s.id).sort()).toEqual(firstStreets);
    } finally {
      store2.close();
    }
  });

  it('derives compass anchors from a v4 layout so the re-seed keeps the mental map', async () => {
    await seedWorkspace();
    const store = await openIndex('index.db');
    try {
      await indexWorkspaceContent(store, dir, join(dir, '.gezel', 'artifacts'));
      // Fake a v4-era layout: src far NW, docs far SE, old version stamp.
      const oldPlaced = '2025-11-01T00:00:00.000Z';
      store.replaceLayout('code', [
        ...['src/a.ts', 'src/b.ts', 'src/util/c.ts'].map((id, i) => ({
          nodeKind: 'block' as const,
          nodeId: id,
          parentId: 'src',
          contentHash: null,
          x: 10 + i * 20,
          y: 10,
          w: 15,
          h: 15,
          weight: 10,
          placedAt: oldPlaced,
          removedAt: null,
        })),
        {
          nodeKind: 'block' as const,
          nodeId: 'docs/readme.md',
          parentId: 'docs',
          contentHash: null,
          x: 900,
          y: 900,
          w: 15,
          h: 15,
          weight: 10,
          placedAt: oldPlaced,
          removedAt: null,
        },
      ]);
      store.setMeta('map_layout_version:code', '4');

      const city = makeCityStore();
      const map = await buildFileMap(store, dir, {
        persist: true,
        villageFile: city,
        userFacing: true,
      });
      // placedAt carried across the re-seed
      for (const b of map.blocks) expect(b.placedAt).toBe(oldPlaced);
      // anchors derived from the OLD centroids: src NW of docs
      const cityRaw = JSON.parse(await readFile(join(dir, '.gezel', 'village.json'), 'utf8'));
      const anchors = new Map(
        (cityRaw.domains.code.anchors as Array<{ path: string; region: string }>).map((a) => [
          a.path,
          a.region,
        ]),
      );
      expect(anchors.get('src')).toBe('NW');
      expect(anchors.get('docs')).toBe('SE');
      const centroid = (prefix: string) => {
        const list = map.blocks.filter((b) => b.id.startsWith(`${prefix}/`));
        return {
          x: list.reduce((s, b) => s + b.lot!.x, 0) / list.length,
          y: list.reduce((s, b) => s + b.lot!.y, 0) / list.length,
        };
      };
      const src = centroid('src');
      const docs = centroid('docs');
      expect(src.x).toBeLessThan(docs.x);
      expect(src.y).toBeLessThan(docs.y);
      expect(store.getMeta('map_layout_version:code')).toBe('6');
    } finally {
      store.close();
    }
  });

  it('does not create a city file on background builds without one', async () => {
    await seedWorkspace();
    const store = await openIndex('index.db');
    try {
      await indexWorkspaceContent(store, dir, join(dir, '.gezel', 'artifacts'));
      const city = makeCityStore();
      await buildFileMap(store, dir, { persist: true, villageFile: city, userFacing: false });
      await expect(readFile(join(dir, '.gezel', 'village.json'), 'utf8')).rejects.toThrow();
    } finally {
      store.close();
    }
  });
});
