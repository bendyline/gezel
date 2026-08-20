import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMarkdownCatalog } from './load.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezk-mdadapter-'));
  await mkdir(join(dir, 'Woodworking', 'Joinery'), { recursive: true });
  await mkdir(join(dir, 'Metals'), { recursive: true });
  await mkdir(join(dir, '.hidden'), { recursive: true });
  await writeFile(
    join(dir, 'welcome.md'),
    '# Welcome\n\nThis is the intro paragraph for the corpus.\n',
  );
  await writeFile(
    join(dir, 'Woodworking', 'planes.md'),
    '---\ntitle: Hand Planes\nsummary: A survey of bench planes.\naliases: plane, jack plane\n---\n# Ignored Heading\n\nBody text about planes.\n',
  );
  await writeFile(
    join(dir, 'Woodworking', 'Joinery', 'dovetails.md'),
    '# Dovetail Joints\n\nTails and pins.\n',
  );
  await writeFile(join(dir, 'Metals', 'copper.md'), 'No heading here, just prose.\n');
  await writeFile(join(dir, '.hidden', 'skipped.md'), '# Skipped\n');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadMarkdownCatalog', () => {
  it('derives the topic tree from folders and a root topic for loose files', async () => {
    const source = await loadMarkdownCatalog(dir, { language: 'en' });
    const byId = new Map(source.topics.map((t) => [t.id, t]));
    expect(byId.get('general')?.name).toBe('General');
    expect(byId.get('woodworking')?.parentId).toBeUndefined();
    expect(byId.get('joinery')?.parentId).toBe('woodworking');
    expect(byId.get('metals')).toBeDefined();
    expect(byId.has('hidden')).toBe(false);
  });

  it('maps files to documents with path ids, titles, and front matter', async () => {
    const source = await loadMarkdownCatalog(dir, { language: 'en' });
    const byId = new Map(source.documents.map((d) => [d.id, d]));
    expect(byId.size).toBe(4);

    const welcome = byId.get('welcome');
    expect(welcome?.title).toBe('Welcome');
    expect(welcome?.topicPath).toEqual(['general']);
    expect(welcome?.summary).toContain('intro paragraph');

    const planes = byId.get('Woodworking/planes');
    expect(planes?.title).toBe('Hand Planes');
    expect(planes?.summary).toBe('A survey of bench planes.');
    expect(planes?.aliases).toEqual(['plane', 'jack plane']);
    expect(planes?.markdown).not.toContain('title: Hand Planes');
    expect(planes?.topicPath).toEqual(['woodworking']);

    const dovetails = byId.get('Woodworking/Joinery/dovetails');
    expect(dovetails?.topicPath).toEqual(['woodworking', 'joinery']);

    const copper = byId.get('Metals/copper');
    expect(copper?.title).toBe('copper');
  });

  it('is deterministic across runs', async () => {
    const a = await loadMarkdownCatalog(dir, { language: 'en' });
    const b = await loadMarkdownCatalog(dir, { language: 'en' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('rejects an empty tree', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'gezk-mdadapter-empty-'));
    try {
      await expect(loadMarkdownCatalog(empty, { language: 'en' })).rejects.toThrow(/no Markdown/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
