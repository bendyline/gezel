import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectArtifactsIndexDbFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import {
  indexArtifactsContent,
  indexProjectArtifacts,
  openArtifactsIndex,
} from './artifacts-indexer.js';
import { ContentIndex } from './content-index.js';

const PROJECT = 'p1';

let home: string;
let artifacts: string;
let store: Store;
let ci: ContentIndex;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-artidx-home-'));
  artifacts = await mkdtemp(join(tmpdir(), 'gezel-artidx-art-'));
  store = {
    projectIndexingEnabled: async () => true,
    projectArtifactsDir: () => artifacts,
  } as unknown as Store;
  ci = new ContentIndex(store, home, { artifactsDebounceMs: 0 });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(artifacts, { recursive: true, force: true });
});

async function seedRecord(rel: string, body: string): Promise<void> {
  const abs = join(artifacts, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, body);
}

const POST_1 = 'data/bluesky/posts/2026-08/001--first-light.md';
const POST_2 = 'data/bluesky/posts/2026-08/002--second-note.md';

describe('indexProjectArtifacts', () => {
  it('indexes markdown records under data/** and serves FTS + listing', async () => {
    await seedRecord(
      POST_1,
      '---\ntrust: untrusted-external\ndate: 2026-08-01\n---\n\n# First light\nThe zonnebloem stood tall.\n',
    );
    await seedRecord(POST_2, '# Second note\nNothing remarkable.\n');

    const stats = await indexProjectArtifacts(store, home, PROJECT);
    expect(stats).toEqual({ files: 2, indexed: 2, removed: 0 });

    const search = await ci.searchArtifacts(PROJECT, 'zonnebloem');
    expect(search.truncated).toBe(false);
    expect(search.results).toHaveLength(1);
    expect(search.results[0]).toMatchObject({ path: POST_1 });
    expect(search.results[0]!.snippet).toContain('zonnebloem');
    expect(search.results[0]!.lineStart).toBeGreaterThanOrEqual(1);

    await expect(ci.listArtifactIndexFiles(PROJECT)).resolves.toEqual([POST_1, POST_2]);
    // The catalog cap applies.
    await expect(ci.listArtifactIndexFiles(PROJECT, 1)).resolves.toEqual([POST_1]);
  });

  it('lifts record frontmatter into filterable metadata', async () => {
    await seedRecord(POST_1, '---\nsubject: Sunrise report\n---\n\nbody text\n');
    await indexProjectArtifacts(store, home, PROJECT);
    const index = (await openArtifactsIndex(home, PROJECT, artifacts))!;
    try {
      expect(index.getMetadata(POST_1).subject).toBe('Sunrise report');
      expect(index.getFile(POST_1)).toMatchObject({
        kind: 'markdown',
        modality: 'text',
        trivial: false,
      });
    } finally {
      index.close();
    }
  });

  it('skips underscore entries, attachments, shadow, and non-markdown files', async () => {
    await seedRecord('data/mail/inbox/001--hello.md', '# Hello\nfindable greeting\n');
    await seedRecord('data/mail/_meta.json', '{"binding":"b1"}');
    await seedRecord('data/mail/_actions/_drafts/d1.md', '# Draft\nnot a record\n');
    await seedRecord('data/mail/inbox/_flags.json', '{}');
    await seedRecord('data/mail/inbox/_997--held.md', 'underscore file skipped');
    await seedRecord('data/mail/inbox/attachments/001/raw.md', 'attachment payload');
    await seedRecord('data/mail/shadow/x.md', 'reserved subtree');
    await seedRecord('data/mail/inbox/002--payload.json', '{"not":"markdown"}');
    await seedRecord('outside/data-like.md', 'not under data/');

    const stats = await indexProjectArtifacts(store, home, PROJECT);
    expect(stats).toEqual({ files: 1, indexed: 1, removed: 0 });
    await expect(ci.listArtifactIndexFiles(PROJECT)).resolves.toEqual([
      'data/mail/inbox/001--hello.md',
    ]);
    const hit = await ci.searchArtifacts(PROJECT, 'findable greeting');
    expect(hit.results).toHaveLength(1);
  });

  it('re-index is incremental: unchanged skip, mtime touches skip, edits re-ingest', async () => {
    await seedRecord(POST_1, '# One\nalpha body\n');
    await seedRecord(POST_2, '# Two\nbeta body\n');
    await indexProjectArtifacts(store, home, PROJECT);

    const second = await indexProjectArtifacts(store, home, PROJECT);
    expect(second).toEqual({ files: 2, indexed: 0, removed: 0 });

    // mtime-only touch: the hash gate keeps the content work at zero.
    const future = new Date(Date.now() + 60_000);
    await utimes(join(artifacts, POST_1), future, future);
    const touched = await indexProjectArtifacts(store, home, PROJECT);
    expect(touched).toEqual({ files: 2, indexed: 0, removed: 0 });

    await seedRecord(POST_1, '# One\nalpha body, revised with gierzwaluw\n');
    const edited = await indexProjectArtifacts(store, home, PROJECT);
    expect(edited).toEqual({ files: 2, indexed: 1, removed: 0 });
    const hits = await ci.searchArtifacts(PROJECT, 'gierzwaluw');
    expect(hits.results[0]).toMatchObject({ path: POST_1 });
  });

  it('drops rows for removed records', async () => {
    await seedRecord(POST_1, '# One\nkeep me\n');
    await seedRecord(POST_2, '# Two\nprune me later\n');
    await indexProjectArtifacts(store, home, PROJECT);

    await rm(join(artifacts, POST_2));
    const pruned = await indexProjectArtifacts(store, home, PROJECT);
    expect(pruned).toEqual({ files: 1, indexed: 0, removed: 1 });
    await expect(ci.listArtifactIndexFiles(PROJECT)).resolves.toEqual([POST_1]);
    const gone = await ci.searchArtifacts(PROJECT, 'prune me later');
    expect(gone.results).toEqual([]);
  });

  it('a capped walk indexes what it saw but never prunes', async () => {
    await seedRecord(POST_1, '# One\n');
    await seedRecord(POST_2, '# Two\n');
    await seedRecord('data/bluesky/posts/2026-08/003--third.md', '# Three\n');
    await indexProjectArtifacts(store, home, PROJECT);

    const index = (await openArtifactsIndex(home, PROJECT, artifacts))!;
    try {
      const capped = await indexArtifactsContent(index, artifacts, 2);
      expect(capped.files).toBe(2);
      // Record 3 fell past the cap; an incomplete walk must not sweep it.
      expect(capped.removed).toBe(0);
      expect(index.allFilePaths()).toHaveLength(3);
    } finally {
      index.close();
    }
  });

  it('a project with no corpus is a zero-stat no-op that mints no database', async () => {
    const stats = await indexProjectArtifacts(store, home, PROJECT);
    expect(stats).toEqual({ files: 0, indexed: 0, removed: 0 });
    expect(existsSync(projectArtifactsIndexDbFile(home, PROJECT))).toBe(false);
  });
});

describe('ContentIndex artifacts façade', () => {
  it('pure reads never create the database', async () => {
    await expect(ci.searchArtifacts(PROJECT, 'anything')).resolves.toEqual({
      results: [],
      truncated: false,
    });
    await expect(ci.listArtifactIndexFiles(PROJECT)).resolves.toEqual([]);
    expect(existsSync(projectArtifactsIndexDbFile(home, PROJECT))).toBe(false);
  });

  it('refreshArtifacts builds the index and collapses calls within the window', async () => {
    await seedRecord(POST_1, '# One\nwindmill notes\n');
    const slow = new ContentIndex(store, home, { artifactsDebounceMs: 50 });
    const first = slow.refreshArtifacts(PROJECT);
    const second = slow.refreshArtifacts(PROJECT);
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ files: 1, indexed: 1, removed: 0 });
    const hits = await ci.searchArtifacts(PROJECT, 'windmill');
    expect(hits.results[0]).toMatchObject({ path: POST_1 });
  });

  it('refreshArtifacts respects the project indexing opt-out', async () => {
    await seedRecord(POST_1, '# One\n');
    const disabled = new ContentIndex(
      {
        projectIndexingEnabled: async () => false,
        projectArtifactsDir: () => artifacts,
      } as unknown as Store,
      home,
      { artifactsDebounceMs: 0 },
    );
    await expect(disabled.refreshArtifacts(PROJECT)).resolves.toBeNull();
    expect(existsSync(projectArtifactsIndexDbFile(home, PROJECT))).toBe(false);
  });

  it('searchArtifacts truncates against maxResults', async () => {
    for (let i = 0; i < 4; i++) {
      await seedRecord(`data/notes/00${i}--note.md`, `# Note ${i}\nherringbone pattern\n`);
    }
    await indexProjectArtifacts(store, home, PROJECT);
    const capped = await ci.searchArtifacts(PROJECT, 'herringbone', 2);
    expect(capped.results).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });
});

describe('observation corpora are not text-indexed', () => {
  it('skips the tables/ subtree so partition directories cost nothing', async () => {
    // A normal corpus record, which must still be indexed.
    await seedRecord(POST_1, '# First light\nThe zonnebloem stood tall.\n');

    // An observation corpus. The stray markdown is the point: the subtree is
    // skipped at the directory level, not merely filtered by extension, so a
    // corpus with thousands of partitions never costs a readdir per pass — and
    // log rows never reach the vector index, where near-identical text
    // collapses the space and degrades retrieval for everything else.
    await seedRecord('data/traffic/tables/requests/dt=2026-08-04/notes.md', '# not indexed\n');
    const partition = join(artifacts, 'data/traffic/tables/requests/dt=2026-08-04');
    await writeFile(join(partition, 'part-000000.parquet'), 'PAR1');
    await writeFile(join(partition, 'sealed-000001.ndjson'), '{"a":1}\n');

    const stats = await indexProjectArtifacts(store, home, PROJECT);
    expect(stats).toEqual({ files: 1, indexed: 1, removed: 0 });

    const listed = await ci.listArtifactIndexFiles(PROJECT);
    expect(listed).toEqual([POST_1]);
  });
});
