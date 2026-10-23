import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectContentIndexDbFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../fs/store.js';
import { ContentIndex } from './content-index.js';
import { runWorkspaceContentIndex } from './content-indexer.js';
import type { EnrichDeps } from './enrich.js';

let dir: string;
let home: string;
let artifacts: string;
let ci: ContentIndex;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-area-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-area-home-'));
  artifacts = join(home, 'artifacts');
  ci = new ContentIndex(
    {
      projectWorkspaceDir: async () => dir,
      projectArtifactsDir: () => artifacts,
    } as unknown as Store,
    home,
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const noEmbed = async () => [];

async function seedWorkspace(): Promise<void> {
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, 'src', 'engine.ts'), 'export function ignite() { return 1; }\n');
  await writeFile(join(dir, 'src', 'wheels.ts'), 'export function roll() { return 2; }\n');
  await writeFile(join(dir, 'docs', 'a.md'), '# A\nmanual part one\n');
  await writeFile(join(dir, 'docs', 'b.md'), '# B\nmanual part two\n');
  await runWorkspaceContentIndex(dir, 'p1', artifacts, {
    dbPath: projectContentIndexDbFile(home, 'p1', dir),
  });
}

function deps(summarize: EnrichDeps['summarize']): EnrichDeps {
  return { summarize, embed: noEmbed, model: 'test' };
}

describe('area pass (deep-pass tier 2)', () => {
  it('rolls file summaries into area summaries + an architecture note, surfaced by mapRepo', async () => {
    await seedWorkspace();
    await ci.enrich(
      'p1',
      deps(async () => 'File summary.'),
      10,
    );

    const summarize = vi.fn(async (prompt: string, _activity?: string) =>
      prompt.includes('top-level folder') ? 'Overall architecture note.' : 'Folder summary.',
    );
    const r = await ci.enrichAreas('p1', deps(summarize));
    expect(r).toMatchObject({ areasUpdated: 2, architectureUpdated: true });

    const map = await ci.mapRepo('p1');
    const src = map.areas.find((a) => a.path === 'src');
    expect(src?.purpose).toBe('Folder summary.');
    expect(map.architecture).toBe('Overall architecture note.');
    expect(summarize.mock.calls.map((call) => call[1])).toEqual([
      'Mapping docs',
      'Mapping src',
      'Mapping the project',
    ]);
  });

  it('is hash-gated: unchanged areas cost no LLM calls on a re-run', async () => {
    await seedWorkspace();
    await ci.enrich(
      'p1',
      deps(async () => 'File summary.'),
      10,
    );
    await ci.enrichAreas(
      'p1',
      deps(async () => 'Folder summary.'),
    );

    const summarize = vi.fn(async () => 'Should not be called.');
    const again = await ci.enrichAreas('p1', deps(summarize));
    expect(again).toMatchObject({ areasUpdated: 0, architectureUpdated: false });
    expect(summarize).not.toHaveBeenCalled();
  });

  it('a file edit invalidates only its own area and the architecture note', async () => {
    await seedWorkspace();
    await ci.enrich(
      'p1',
      deps(async () => 'File summary.'),
      10,
    );
    await ci.enrichAreas(
      'p1',
      deps(async () => 'Folder summary v1.'),
    );

    await writeFile(join(dir, 'src', 'engine.ts'), 'export function ignite() { return 99; }\n');
    await runWorkspaceContentIndex(dir, 'p1', artifacts, {
      dbPath: projectContentIndexDbFile(home, 'p1', dir),
    });
    await ci.enrich(
      'p1',
      deps(async () => 'Updated file summary.'),
      10,
    );

    const summarize = vi.fn(async () => 'Folder summary v2.');
    const r = await ci.enrichAreas('p1', deps(summarize));
    expect(r?.areasUpdated).toBe(1);
    expect(r?.architectureUpdated).toBe(true);

    const map = await ci.mapRepo('p1');
    expect(map.areas.find((a) => a.path === 'src')?.purpose).toBe('Folder summary v2.');
    expect(map.areas.find((a) => a.path === 'docs')?.purpose).toBe('Folder summary v1.');
  });

  it('architectureNote returns just the project note without a file walk', async () => {
    await seedWorkspace();
    expect(await ci.architectureNote('p1')).toBeNull();
    await ci.enrich(
      'p1',
      deps(async () => 'File summary.'),
      10,
    );
    await ci.enrichAreas(
      'p1',
      deps(async (prompt) =>
        prompt.includes('top-level folder') ? 'The architecture note.' : 'Folder summary.',
      ),
    );
    expect(await ci.architectureNote('p1')).toBe('The architecture note.');
  });

  it('maps a large folder through its subfolders, children first', async () => {
    await mkdir(join(dir, 'lib', 'parse'), { recursive: true });
    await mkdir(join(dir, 'lib', 'render'), { recursive: true });
    for (let i = 0; i < 20; i++) {
      await writeFile(join(dir, 'lib', 'parse', `p${i}.ts`), `export const p${i} = ${i};\n`);
    }
    for (let i = 0; i < 15; i++) {
      await writeFile(join(dir, 'lib', 'render', `r${i}.ts`), `export const r${i} = ${i};\n`);
    }
    await writeFile(join(dir, 'lib', 'index.ts'), 'export * from "./parse/p0";\n');
    // A second importer: the map lists only files more than one file leans on.
    await writeFile(
      join(dir, 'lib', 'render', 'r0.ts'),
      'import { p0 } from "../parse/p0";\nexport const r0 = p0;\n',
    );
    await runWorkspaceContentIndex(dir, 'p1', artifacts, {
      dbPath: projectContentIndexDbFile(home, 'p1', dir),
    });
    await ci.enrich(
      'p1',
      deps(async () => 'File summary.'),
      100,
    );

    const prompts = new Map<string, string>();
    const summarize = vi.fn(async (prompt: string, activity?: string) => {
      prompts.set(activity ?? '', prompt);
      if (prompt.includes('top-level folder')) return 'Architecture note.';
      return `Handles ${activity}.\n\n- lib/index.ts — the entry`;
    });
    await ci.enrichAreas('p1', deps(summarize));

    expect(summarize.mock.calls.map((call) => call[1])).toEqual([
      'Mapping lib/parse',
      'Mapping lib/render',
      'Mapping lib',
      'Mapping the project',
    ]);
    const rollup = prompts.get('Mapping lib') ?? '';
    expect(rollup).toContain('directly inside the "lib/" folder');
    expect(rollup).toContain('- lib/parse/: Handles Mapping lib/parse.');
    expect(rollup).toContain('- lib/index.ts:');
    // map_repo carries the purpose, not the key-file list beneath it.
    const map = await ci.mapRepo('p1');
    expect(map.areas.find((a) => a.path === 'lib')?.purpose).toBe('Handles Mapping lib.');

    const codebase = await ci.codebaseMap('p1');
    expect(codebase.indexed).toBe(true);
    expect(codebase.architecture).toBe('Architecture note.');
    expect(codebase.areas.map((a) => [a.path, a.depth])).toEqual([
      ['lib', 0],
      ['lib/parse', 1],
      ['lib/render', 1],
    ]);
    expect(codebase.areas[0]?.keyFiles).toEqual([{ path: 'lib/index.ts', purpose: 'the entry' }]);
    expect(codebase.loadBearing.map((f) => f.path)).toContain('lib/parse/p0.ts');
  });

  it('keeps a large test or fixture folder as one area', async () => {
    for (const sub of ['alpha', 'beta']) {
      await mkdir(join(dir, 'test', sub), { recursive: true });
      for (let i = 0; i < 20; i++) {
        await writeFile(join(dir, 'test', sub, `t${i}.ts`), `export const t${i} = ${i};\n`);
      }
    }
    await runWorkspaceContentIndex(dir, 'p1', artifacts, {
      dbPath: projectContentIndexDbFile(home, 'p1', dir),
    });
    await ci.enrich(
      'p1',
      deps(async () => 'File summary.'),
      100,
    );
    const summarize = vi.fn(async (_prompt: string, _activity?: string) => 'Holds tests.');
    await ci.enrichAreas('p1', deps(summarize));
    expect(summarize.mock.calls.map((call) => call[1])).toEqual([
      'Mapping test',
      'Mapping the project',
    ]);
  });

  it('drops the summaries of folders that are no longer areas', async () => {
    await mkdir(join(dir, 'lib', 'parse'), { recursive: true });
    await mkdir(join(dir, 'lib', 'render'), { recursive: true });
    for (let i = 0; i < 20; i++) {
      await writeFile(join(dir, 'lib', 'parse', `p${i}.ts`), `export const p${i} = ${i};\n`);
      await writeFile(join(dir, 'lib', 'render', `r${i}.ts`), `export const r${i} = ${i};\n`);
    }
    const reindex = async () => {
      await runWorkspaceContentIndex(dir, 'p1', artifacts, {
        dbPath: projectContentIndexDbFile(home, 'p1', dir),
      });
      await ci.enrich(
        'p1',
        deps(async () => 'File summary.'),
        100,
      );
    };
    await reindex();
    await ci.enrichAreas(
      'p1',
      deps(async () => 'Folder summary.'),
    );
    const before = await ci.searchAreaSummaries('p1', 'folder summary', 20);
    const folders = (rows: Array<{ areaPath: string }>) =>
      rows
        .map((a) => a.areaPath)
        .filter((p) => p !== '::project')
        .sort();
    expect(folders(before)).toEqual(['lib', 'lib/parse', 'lib/render']);

    // 20 files left: lib is one area again and its subfolders' rows go.
    await rm(join(dir, 'lib', 'render'), { recursive: true, force: true });
    await reindex();
    await ci.enrichAreas(
      'p1',
      deps(async () => 'Folder summary.'),
    );
    const after = await ci.searchAreaSummaries('p1', 'folder summary', 20);
    expect(folders(after)).toEqual(['lib']);
  });

  it('does nothing when the summarizer yields nothing (no local model)', async () => {
    await seedWorkspace();
    await ci.enrich(
      'p1',
      deps(async () => ''),
      10,
    );
    const r = await ci.enrichAreas(
      'p1',
      deps(async () => ''),
    );
    expect(r).toMatchObject({ areasUpdated: 0, architectureUpdated: false });
  });
});
