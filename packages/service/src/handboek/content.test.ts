import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HandboekArea } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CuratedArticle,
  WHATS_NEW_INDEX_ID,
  findHandboekContent,
  listReleaseNotes,
  loadCuratedArticles,
  parseCuratedArticle,
} from './content.js';

describe('parseCuratedArticle', () => {
  it('reads frontmatter fields and keeps the body', () => {
    const source = [
      '---',
      'id: role/meester',
      'title: The Meester',
      'order: 1',
      'summary: The guildmaster.',
      'defaultDuration: 7',
      'subcategory:',
      '  id: crew-leads',
      '  title: Crew leads',
      '  order: 2',
      '---',
      '',
      '# The Meester',
      '',
      'Body.',
    ].join('\n');
    const article = parseCuratedArticle(source, 'gezel-roles', 'role-meester.md');
    expect(article).toMatchObject({
      id: 'role/meester',
      area: 'gezel-roles',
      title: 'The Meester',
      order: 1,
      summary: 'The guildmaster.',
      defaultDuration: 7,
      subcategory: { id: 'crew-leads', title: 'Crew leads', order: 2 },
      siteVisible: true,
    });
    expect(article?.body).toContain('# The Meester');
  });

  it('defaults id to the filename stem and title to the first heading', () => {
    const article = parseCuratedArticle(
      '# Welcome {[titleBlock]}\n\nHi.',
      'conceptual',
      'welcome.md',
    );
    expect(article).toMatchObject({ id: 'welcome', title: 'Welcome', order: 999 });
  });

  it('honors siteVisible: false and skips empty bodies', () => {
    const hidden = parseCuratedArticle(
      '---\nsiteVisible: false\n---\n\nBody.',
      'technical',
      'x.md',
    );
    expect(hidden?.siteVisible).toBe(false);
    expect(parseCuratedArticle('---\ntitle: Empty\n---\n', 'technical', 'y.md')).toBeNull();
  });
});

describe('content tree resolution', () => {
  let dir: string | undefined;

  afterEach(async () => {
    delete process.env.GEZEL_HANDBOEK_DIR;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('GEZEL_HANDBOEK_DIR overrides probing and loadCuratedArticles reads areas', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-handboek-'));
    await mkdir(join(dir, 'conceptual'), { recursive: true });
    await mkdir(join(dir, 'technical'), { recursive: true });
    await writeFile(
      join(dir, 'conceptual', 'b.md'),
      '---\ntitle: Second\norder: 2\n---\n\nTwo.',
      'utf8',
    );
    await writeFile(
      join(dir, 'conceptual', 'a.md'),
      '---\ntitle: First\norder: 1\n---\n\nOne.',
      'utf8',
    );
    await writeFile(join(dir, 'technical', 'broken.md'), '---\ntitle: Empty\n---\n', 'utf8');
    process.env.GEZEL_HANDBOEK_DIR = dir;
    expect(findHandboekContent()).toBe(dir);
    const articles = loadCuratedArticles(dir);
    expect(articles.map((a) => a.id)).toEqual(['a', 'b']);
    expect(articles[0]).toMatchObject({ area: 'conceptual', title: 'First' });
  });

  it('finds the repo docs/handboek tree when no override is set', () => {
    delete process.env.GEZEL_HANDBOEK_DIR;
    const found = findHandboekContent();
    expect(found).toBeTruthy();
    const articles = loadCuratedArticles(found!);
    expect(articles.some((a) => a.id === 'welcome')).toBe(true);
    expect(articles.some((a) => a.id === 'role/meester')).toBe(true);
  });
});

describe('listReleaseNotes', () => {
  const article = (id: string, area: HandboekArea, order: number): CuratedArticle => ({
    id,
    area,
    title: id,
    order,
    body: 'x',
    siteVisible: true,
  });

  it('drops the section index and orders newest first', () => {
    // Release order is the negated calendar line, so ascending order is
    // reverse chronological — the convention the whole section relies on.
    const notes = listReleaseNotes([
      article('technical-thing', 'technical', 1),
      article('whats-new/1.26219', 'whats-new', -26219),
      article(WHATS_NEW_INDEX_ID, 'whats-new', -999999),
      article('whats-new/1.26224', 'whats-new', -26224),
    ]);
    expect(notes.map((n) => n.id)).toEqual(['whats-new/1.26224', 'whats-new/1.26219']);
  });
});
