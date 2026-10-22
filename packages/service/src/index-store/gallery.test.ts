import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GalleryResponse } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyFile } from './classify.js';
import { buildGallery, buildGalleryShelf, eventLabel } from './gallery.js';
import { IndexStore } from './index-store.js';

let home: string;
let store: IndexStore;
const NONE = { ignoredPaths: new Set<string>() };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-gallery-'));
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

let clock = Date.parse('2026-01-01T00:00:00Z');

function file(
  path: string,
  opts: { hash?: string; size?: number; meta?: Record<string, string>; summary?: string } = {},
): void {
  const cls = classifyFile(path, opts.size ?? 1000);
  const hash = opts.hash ?? `h:${path}`;
  clock += 60_000;
  store.upsertFile({
    path,
    hash,
    size: opts.size ?? 1000,
    mtimeMs: clock,
    lang: cls.lang,
    kind: cls.kind,
    modality: cls.modality,
    trivial: cls.trivial,
    indexedAt: new Date(clock).toISOString(),
    loc: 10,
  });
  if (opts.meta) {
    store.setMetadata(
      path,
      Object.entries(opts.meta).map(([key, value]) => ({ key, value })),
    );
  }
  if (opts.summary) {
    store.upsertSummary({ contentHash: hash, filePath: path, summaryMd: opts.summary, model: 'm' });
  }
}

function photo(path: string, takenAt: string | null, extra: Record<string, string> = {}) {
  file(path, {
    meta: { ...(takenAt ? { taken_at: takenAt } : {}), camera_make: 'Apple', ...extra },
  });
}

const labels = (res: GalleryResponse) => res.shelves.map((s) => `${s.label} (${s.count})`);

describe('buildGallery by type', () => {
  beforeEach(() => {
    file('notes/plan.md', { summary: 'The launch plan for the bakery.\n\nMore detail.' });
    store.putSymbols('notes/plan.md', 'h:notes/plan.md', [
      { name: 'Launch plan', kind: 'h1', lineStart: 1, lineEnd: 9 },
      { name: 'Later', kind: 'h1', lineStart: 10, lineEnd: 12 },
    ]);
    file('notes/ideas.md', { meta: { title: 'Ideas from frontmatter' } });
    file('budget.xlsx');
    file('deck.pptx');
    photo('pics/a.jpg', '2025-03-01T10:00:00');
    file('pics/diagram.svg');
    file('src/app.ts');
    file('src/app.test.ts');
    file('pnpm-lock.yaml');
    file('secret/keys.txt');
  });

  it('shelves files by what they are, largest first, with titles and summary leads', () => {
    const res = buildGallery(store, {}, { ignoredPaths: new Set(['secret/keys.txt']) });
    expect(res.group).toBe('type');
    expect(res.groups).toEqual(['folder', 'type']);
    expect(labels(res)).toEqual([
      'Notes (2)',
      'Drawings (1)',
      'Photos (1)',
      'Slides (1)',
      'Spreadsheets (1)',
      'Tests (1)',
      'TypeScript (1)',
    ]);
    const notes = res.shelves[0]!.items;
    expect(notes.map((i) => i.title)).toEqual(['Ideas from frontmatter', 'Launch plan']);
    expect(notes[1]!.lead).toBe('The launch plan for the bakery.');
    expect(res.families).toEqual({ documents: 3, photos: 2, data: 1, code: 2 });
    expect(res.total).toBe(8);
  });

  it('filters by family and by words in the summary', () => {
    const photos = buildGallery(store, { filter: 'photos' }, NONE);
    expect(labels(photos)).toEqual(['Drawings (1)', 'Photos (1)']);
    const bakery = buildGallery(store, { q: 'bakery launch' }, NONE);
    expect(bakery.shelves.flatMap((s) => s.items.map((i) => i.path))).toEqual(['notes/plan.md']);
    expect(bakery.families).toEqual({ documents: 1 });
  });

  it('pages a shelf by id, and answers null for one that is gone', () => {
    for (let i = 0; i < 5; i++) file(`more/n${i}.md`);
    const first = buildGallery(store, { perShelf: 3 }, NONE);
    const notes = first.shelves.find((s) => s.id === 'type:note')!;
    expect(notes.items).toHaveLength(3);
    const next = buildGalleryShelf(
      store,
      { group: 'type', shelf: 'type:note', offset: 3, limit: 3 },
      NONE,
    );
    expect(next).toMatchObject({ shelf: 'type:note', offset: 3, count: 7 });
    expect(next!.items).toHaveLength(3);
    expect(next!.items.map((i) => i.path)).not.toContain(notes.items[0]!.path);
    expect(buildGalleryShelf(store, { group: 'type', shelf: 'type:nope' }, NONE)).toBeNull();
  });
});

describe('buildGallery by folder', () => {
  it('splits the folder that holds most files, puts dot-folders last, and says what each is for', () => {
    file('README.md');
    for (const name of ['a', 'b', 'c']) file(`packages/core/src/${name}.ts`);
    for (const name of ['a', 'b']) file(`packages/ui/src/${name}.tsx`);
    file('docs/guide.md');
    file('.github/workflows/ci.yml');
    store.upsertAreaSummary({
      areaPath: 'packages/core',
      inputHash: 'x',
      summaryMd: 'The shared types every package reads.\n\nMore.',
      model: 'm',
    });
    const res = buildGallery(store, {}, NONE);
    expect(res.group).toBe('folder');
    expect(res.shelves.map((s) => [s.id, s.label, s.count])).toEqual([
      ['folder:.', 'Top level', 1],
      ['folder:docs', 'docs', 1],
      ['folder:packages/core', 'packages/core', 3],
      ['folder:packages/ui', 'packages/ui', 2],
      ['folder:.github', '.github', 1],
    ]);
    expect(res.shelves[2]!.description).toBe('The shared types every package reads.');
  });
});

describe('buildGallery by outing', () => {
  beforeEach(() => {
    photo('2024/beach-1.jpg', '2024-07-14T14:00:00');
    photo('2024/beach-2.jpg', '2024-07-14T15:10:00');
    photo('2024/beach-3.jpg', '2024-07-14T16:40:00');
    file('2024/beach-3-copy.jpg', {
      hash: 'h:2024/beach-3.jpg',
      meta: { taken_at: '2024-07-14T16:40:00', camera_make: 'Apple' },
    });
    photo('2023/canal-1.jpg', '2023-10-08T21:50:00');
    photo('2023/canal-2.jpg', '2023-10-08T23:30:00');
    photo('2023/canal-3.jpg', '2023-10-09T01:20:00');
    photo('loose.jpg', null);
    photo('shot.png', '2024-01-01T12:00:00', { screenshot: '1' });
    file('trip-notes.md');
  });

  it('opens a pictures folder on its outings, exact copies first', () => {
    const res = buildGallery(store, {}, { ...NONE, folderKind: 'pictures' });
    expect(res.group).toBe('event');
    expect(res.groups).toEqual(['event', 'folder', 'type']);
    expect(labels(res)).toEqual([
      'Exact copies (2)',
      'Sunday, July 14, 2024 (4)',
      'October 8–9, 2023 (3)',
      'Screenshots (1)',
      'Other pictures (1)',
      'Notes (1)',
    ]);
    expect(res.shelves[0]!.description).toBe('1 photo is a copy of another · 1 MB could be freed');
    expect(res.shelves[1]!.description).toBe('2:00 PM – 4:40 PM');
    expect(res.shelves[1]!.items.map((i) => i.path)).toEqual([
      '2024/beach-1.jpg',
      '2024/beach-2.jpg',
      '2024/beach-3-copy.jpg',
      '2024/beach-3.jpg',
    ]);
    expect(res.shelves[1]!.items[0]!.takenAt).toBe('2024-07-14T14:00:00');
  });

  it('leaves the copies shelf out when only documents are shown', () => {
    const res = buildGallery(store, { group: 'event', filter: 'documents' }, NONE);
    expect(labels(res)).toEqual(['Notes (1)']);
  });

  it('falls back to types when asked for outings a folder does not have', () => {
    store.close();
    return IndexStore.open(join(home, 'other.db'), {
      collectionId: 'q',
      kind: 'workspace',
      rootPath: home,
    }).then((opened) => {
      store = opened!;
      file('a.md');
      expect(buildGallery(store, { group: 'event' }, NONE).group).toBe('type');
    });
  });
});

describe('eventLabel', () => {
  it('names a day, a span within a month, across months and across years', () => {
    expect(eventLabel('2024-06-01T10:00:00', '2024-06-01T18:00:00')).toBe('Saturday, June 1, 2024');
    expect(eventLabel('2024-06-01T10:00:00', '2024-06-03T08:00:00')).toBe('June 1–3, 2024');
    expect(eventLabel('2024-05-30T10:00:00', '2024-06-02T08:00:00')).toBe('May 30 – June 2, 2024');
    expect(eventLabel('2023-12-30T10:00:00', '2024-01-02T08:00:00')).toBe(
      'December 30, 2023 – January 2, 2024',
    );
  });
});
