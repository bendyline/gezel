import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  await runWorkspaceContentIndex(dir, 'p1', artifacts);
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
    await runWorkspaceContentIndex(dir, 'p1', artifacts);
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
