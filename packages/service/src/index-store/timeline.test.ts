import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyFile } from './classify.js';
import { IndexStore } from './index-store.js';
import { buildTimeline, buildTimelineBucket } from './timeline.js';

let home: string;
let store: IndexStore;
const NONE = { ignoredPaths: new Set<string>() };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-timeline-'));
  const opened = await IndexStore.open(join(home, 'index.db'), {
    collectionId: 'p',
    kind: 'workspace',
    rootPath: home,
  });
  if (!opened) throw new Error('index unavailable');
  store = opened;
});

afterEach(async () => {
  store.close();
  await rm(home, { recursive: true, force: true });
});

/** Local wall-clock time, as the person's machine reads it. */
const at = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h).getTime();

function file(path: string, opts: { mtimeMs?: number; meta?: Record<string, string> } = {}) {
  const cls = classifyFile(path, 100);
  store.upsertFile({
    path,
    hash: `h:${path}`,
    size: 100,
    mtimeMs: opts.mtimeMs ?? at(2026, 1, 1),
    lang: cls.lang,
    kind: cls.kind,
    modality: cls.modality,
    trivial: cls.trivial,
    indexedAt: '2026-01-01T00:00:00Z',
    loc: 5,
  });
  if (opts.meta) {
    store.setMetadata(
      path,
      Object.entries(opts.meta).map(([key, value]) => ({ key, value })),
    );
  }
}

describe('the timeline of a git repository', () => {
  beforeEach(() => {
    for (const p of [
      'src/parser.ts',
      'src/lexer.ts',
      'docs/guide.md',
      'README.md',
      'pnpm-lock.yaml',
    ]) {
      file(p);
    }
    store.gitHistory.replace([
      { sha: 'c3', at: at(2026, 10, 20), subject: 'Tidy the guide', files: ['docs/guide.md'] },
      {
        sha: 'c2',
        at: at(2026, 10, 7),
        subject: 'Teach the parser lists',
        files: ['src/parser.ts', 'src/lexer.ts', 'pnpm-lock.yaml'],
      },
      { sha: 'c1', at: at(2026, 10, 5), subject: 'Start', files: ['src/parser.ts', 'README.md'] },
      { sha: 'c0', at: at(2026, 10, 6), subject: 'Bump the lockfile', files: ['pnpm-lock.yaml'] },
    ]);
  });

  it('buckets commits by week, empty weeks included, with a lane per area', () => {
    const res = buildTimeline(store, {}, NONE);
    expect(res).toMatchObject({ indexed: true, source: 'git', bucket: 'week', truncated: false });
    expect(res.lanes).toEqual([
      { id: 'src', label: 'src' },
      { id: '.', label: 'Top level' },
      { id: 'docs', label: 'docs' },
    ]);
    expect(res.buckets.map((b) => [b.start, b.end, b.label, b.commits, b.files, b.lanes])).toEqual([
      ['2026-10-05', '2026-10-12', 'Week of October 5, 2026', 2, 3, { src: 3, '.': 1 }],
      ['2026-10-12', '2026-10-19', 'Week of October 12, 2026', 0, 0, {}],
      ['2026-10-19', '2026-10-26', 'Week of October 19, 2026', 1, 1, { docs: 1 }],
    ]);
  });

  it('answers months or years when asked', () => {
    const months = buildTimeline(store, { bucket: 'month' }, NONE);
    expect(months.buckets.map((b) => [b.label, b.commits])).toEqual([['October 2026', 3]]);
    expect(buildTimeline(store, { bucket: 'year' }, NONE).buckets[0]!.label).toBe('2026');
  });

  it('lists a stretch: its commits newest first, and the files changed most', () => {
    const detail = buildTimelineBucket(store, { start: '2026-10-05', end: '2026-10-12' }, NONE);
    expect(detail.source).toBe('git');
    expect(detail.commits.map((c) => [c.sha, c.subject, c.files, c.fileCount])).toEqual([
      ['c2', 'Teach the parser lists', ['src/lexer.ts', 'src/parser.ts'], 2],
      ['c1', 'Start', ['README.md', 'src/parser.ts'], 2],
    ]);
    expect(detail.files.map((f) => [f.path, f.changes])).toEqual([
      ['src/parser.ts', 2],
      ['README.md', 1],
      ['src/lexer.ts', 1],
    ]);
  });
});

describe('the timeline of a folder without history', () => {
  beforeEach(() => {
    file('2024/beach.jpg', { meta: { taken_at: '2024-07-14T16:40:00', camera_make: 'Apple' } });
    file('2024/canal.jpg', { meta: { taken_at: '2024-09-02T09:00:00', camera_make: 'Apple' } });
    file('notes/trip.md', { mtimeMs: at(2024, 9, 20) });
  });

  it('places each file at its own date, a photo when it was taken, by kind of file', () => {
    expect(buildTimeline(store, {}, NONE).bucket).toBe('week');
    const res = buildTimeline(store, { bucket: 'month' }, NONE);
    expect(res.source).toBe('files');
    expect(res.lanes).toEqual([
      { id: 'photos', label: 'Photos' },
      { id: 'documents', label: 'Documents' },
    ]);
    expect(res.buckets.map((b) => [b.start, b.files, b.lanes])).toEqual([
      ['2024-07-01', 1, { photos: 1 }],
      ['2024-08-01', 0, {}],
      ['2024-09-01', 2, { photos: 1, documents: 1 }],
    ]);
    const detail = buildTimelineBucket(
      store,
      { start: '2024-09-01', end: '2024-10-01', source: 'files' },
      NONE,
    );
    expect(detail.commits).toEqual([]);
    expect(detail.files.map((f) => f.path)).toEqual(['notes/trip.md', '2024/canal.jpg']);
  });

  it('is empty, not an error, before anything is dated', () => {
    store.close();
    return IndexStore.open(join(home, 'empty.db'), {
      collectionId: 'q',
      kind: 'workspace',
      rootPath: home,
    }).then((opened) => {
      store = opened!;
      expect(buildTimeline(store, {}, NONE)).toMatchObject({ indexed: true, buckets: [] });
    });
  });
});
