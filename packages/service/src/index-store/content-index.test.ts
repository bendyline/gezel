import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { ContentIndex } from './content-index.js';
import { IndexStore } from './index-store.js';

let dir: string;
let home: string;
let ci: ContentIndex;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-cidx-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-cidx-home-'));
  const fakeStore = {
    projectIndexingEnabled: async () => true,
    projectWorkspaceDir: async () => dir,
    projectArtifactsDir: () => join(home, 'artifacts'),
  } as unknown as Store;
  ci = new ContentIndex(fakeStore, home);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('ContentIndex (code-intel façade)', () => {
  it('does not open or update an index for an opted-out project', async () => {
    let workspaceResolved = false;
    const disabled = new ContentIndex(
      {
        projectIndexingEnabled: async () => false,
        projectWorkspaceDir: async () => {
          workspaceResolved = true;
          return dir;
        },
        projectArtifactsDir: () => join(home, 'artifacts'),
      } as unknown as Store,
      home,
    );

    await expect(disabled.refresh('p1')).resolves.toBeNull();
    expect(workspaceResolved).toBe(false);
  });

  it('refreshes then answers outline/find/read/map', async () => {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'src', 'a.ts'),
      [
        'export function alpha(a: number) {',
        '  return a;',
        '}',
        'class Beta {',
        '  go() {}',
        '}',
      ].join('\n'),
    );
    await writeFile(join(dir, 'README.md'), '# Title\nbody\n');

    const stats = await ci.refresh('p1');
    expect(stats).not.toBeNull();
    expect(stats!.symbols).toBeGreaterThanOrEqual(3);

    const outline = await ci.outlineFile('p1', 'src/a.ts');
    expect(outline.engine).toBe('index');
    expect(outline.lang).toBe('typescript');
    expect(outline.symbols.map((s) => s.name)).toEqual(
      expect.arrayContaining(['alpha', 'Beta', 'go']),
    );
    const alpha = outline.symbols.find((s) => s.name === 'alpha')!;
    expect(alpha).toMatchObject({
      kind: 'function',
      lineStart: 1,
      lineEnd: 3,
      id: 'src/a.ts#alpha',
    });

    const find = await ci.findSymbol('p1', 'alpha');
    expect(find.engine).toBe('index');
    expect(find.matches[0]).toMatchObject({ path: 'src/a.ts', kind: 'function' });

    const read = await ci.readSymbol('p1', 'alpha');
    expect(read.found).toBe(true);
    expect(read.source).toContain('function alpha');
    expect(read.lineStart).toBe(1);

    const map = await ci.mapRepo('p1');
    expect(map.indexed).toBe(true);
    expect(map.languages.find((l) => l.lang === 'typescript')?.fileCount).toBeGreaterThanOrEqual(1);
    expect(map.keyFiles).toContain('README.md');
  });

  it('outline_file falls back to live extraction for an un-indexed file', async () => {
    // Nothing indexed yet — query a file directly.
    await writeFile(join(dir, 'fresh.ts'), 'export function brandNew() { return 42; }\n');
    const outline = await ci.outlineFile('p1', 'fresh.ts');
    expect(outline.engine).toBe('live');
    expect(outline.symbols.map((s) => s.name)).toContain('brandNew');
  });

  it('searches deep-pass area and architecture rollups for bigger-picture context', async () => {
    await writeFile(join(dir, 'README.md'), '# Driving game\n');
    await ci.refresh('p1');
    const index = (await IndexStore.open(join(dir, '.gezel', 'index', 'index.db'), {
      collectionId: 'p1',
      kind: 'workspace',
      rootPath: dir,
    }))!;
    index.upsertAreaSummary({
      areaPath: '::project',
      inputHash: 'h1',
      summaryMd: 'Vehicle physics separates tire grip, suspension damping, and steering input.',
      model: 'test',
    });
    index.upsertAreaSummary({
      areaPath: 'docs',
      inputHash: 'h2',
      summaryMd: 'Release notes and contributor guidelines.',
      model: 'test',
    });
    index.close();

    const hits = await ci.searchAreaSummaries('p1', 'improve the vehicle physics', 5);
    expect(hits[0]).toMatchObject({ areaPath: '::project' });
    expect(hits.some((hit) => hit.areaPath === 'docs')).toBe(false);
  });

  it('guards against path traversal', async () => {
    const outline = await ci.outlineFile('p1', '../../etc/passwd');
    expect(outline.symbols).toHaveLength(0);
    expect(outline.totalLines).toBe(0);
  });
});

describe('ContentIndex.fileContext', () => {
  const seedMiniRepo = async () => {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'src', 'a.ts'),
      [
        "import { foo } from './b.js';",
        'export function runA() {',
        "  return foo('hi');",
        '}',
      ].join('\n'),
    );
    await writeFile(
      join(dir, 'src', 'b.ts'),
      [
        'export function foo(x: string) {',
        '  return x.length;',
        '}',
        'export function bar() {',
        "  return foo('hi');",
        '}',
        'export function danger(input: string) {',
        '  return eval(input);',
        '}',
      ].join('\n'),
    );
    await ci.refresh('p1');
  };

  it('attributes inbound importers to symbols via named bindings', async () => {
    await seedMiniRepo();
    const ctx = await ci.fileContext('p1', 'src/b.ts');
    expect(ctx.engine).toBe('index');
    expect(ctx.lang).toBe('typescript');
    expect(ctx.totalLines).toBe(9);

    // File-level: a.ts imports { foo } from b.
    expect(ctx.importedBy).toEqual([{ path: 'src/a.ts', names: ['foo'] }]);

    const foo = ctx.symbols.find((s) => s.name === 'foo')!;
    expect(foo.importedBy).toEqual([{ path: 'src/a.ts', viaBinding: true }]);
    // bar is not named by a.ts's import, and a.ts is not a whole-file importer.
    const bar = ctx.symbols.find((s) => s.name === 'bar')!;
    expect(bar.importedBy).toEqual([]);
    // Within-file usage: bar calls foo.
    expect(foo.usedInFileBy).toContain('bar');
    expect(bar.usedInFileBy).toEqual([]);
  });

  it('reports outbound uses per symbol from imported bindings', async () => {
    await seedMiniRepo();
    const ctx = await ci.fileContext('p1', 'src/a.ts');
    const runA = ctx.symbols.find((s) => s.name === 'runA')!;
    expect(runA.uses).toEqual([{ name: 'foo', from: 'src/b.ts', inRepo: true }]);
    expect(ctx.imports).toEqual([
      {
        specifier: './b.js',
        resolvedPath: 'src/b.ts',
        names: ['foo'],
        default: false,
        namespace: false,
      },
    ]);
  });

  it('assigns findings to the innermost containing symbol', async () => {
    await seedMiniRepo();
    const ctx = await ci.fileContext('p1', 'src/b.ts');
    const danger = ctx.symbols.find((s) => s.name === 'danger')!;
    expect(danger.findings.some((f) => f.ruleId === 'sink.eval')).toBe(true);
    const foo = ctx.symbols.find((s) => s.name === 'foo')!;
    expect(foo.findings).toEqual([]);
  });

  it('returns facts without summaries when unenriched', async () => {
    await seedMiniRepo();
    const ctx = await ci.fileContext('p1', 'src/b.ts');
    expect(ctx.summary).toBeNull();
    for (const s of ctx.symbols) expect(s.summary).toBeUndefined();
  });

  it('guards against path traversal and degrades on unknown files', async () => {
    await seedMiniRepo();
    const traversal = await ci.fileContext('p1', '../../etc/passwd');
    expect(traversal.symbols).toHaveLength(0);
    expect(traversal.totalLines).toBe(0);
    const missing = await ci.fileContext('p1', 'src/nope.ts');
    expect(missing.symbols).toHaveLength(0);
    expect(missing.importedBy).toEqual([]);
  });
});
