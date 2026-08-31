import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OG_HEADLINES_FILE,
  emptyOgHeadlineFile,
  hashArticleBody,
  ogHeadlineSource,
  ogKicker,
  readOgHeadlines,
  resolveOgHeadline,
} from './og-headlines.js';

const DISTILLED = 'Your crew proposes changes before they land.';
const ENTRY = {
  id: 'whats-new/1.26237',
  title: '1.26237 — 25 August 2026',
  summary: 'Change proposals you read before any file is edited.',
};
const LOCK = {
  version: 1 as const,
  entries: {
    [ENTRY.id]: { sourceHash: hashArticleBody(ogHeadlineSource(ENTRY)), headline: DISTILLED },
  },
};

describe('resolveOgHeadline', () => {
  it('uses a matching lockfile entry', () => {
    expect(resolveOgHeadline(ENTRY, LOCK)).toBe(DISTILLED);
  });

  it('lets an authored ogHeadline win over the lockfile', () => {
    expect(resolveOgHeadline({ ...ENTRY, ogHeadline: 'Mine' }, LOCK)).toBe('Mine');
  });

  it('falls back to the title once the summary is rewritten', () => {
    // A stale distillation describes an article that no longer says that. A
    // plain title is duller and correct, which is the right trade for the
    // first thing a reader sees about a link.
    const moved = { ...ENTRY, summary: 'Something else entirely.' };
    expect(resolveOgHeadline(moved, LOCK)).toBe(ENTRY.title);
  });

  it('falls back to the title when there is no entry at all', () => {
    expect(resolveOgHeadline(ENTRY, emptyOgHeadlineFile())).toBe(ENTRY.title);
  });

  it('gives a catalog page its own name, which is the templated card', () => {
    const craftbook = { id: 'craftbook/powerpoint-deck', title: 'PowerPoint Deck' };
    expect(resolveOgHeadline(craftbook, emptyOgHeadlineFile())).toBe('PowerPoint Deck');
  });
});

describe('ogHeadlineSource', () => {
  it('ignores the rendered body, so a gilde bump cannot invalidate the lockfile', () => {
    // Only authored fields participate: catalog content is macro-expanded
    // against whichever gilde release is pinned.
    expect(ogHeadlineSource(ENTRY)).toBe(`${ENTRY.title}\n${ENTRY.summary}`);
  });

  it('is stable for an article with no summary', () => {
    expect(ogHeadlineSource({ title: 'A' })).toBe('A\n');
  });
});

describe('ogKicker', () => {
  it('names the release on a what’s-new article', () => {
    expect(ogKicker({ id: 'whats-new/1.26237', area: 'whats-new' })).toBe(
      "gezel · What's New · 1.26237",
    );
  });

  it('does not version the section index', () => {
    expect(ogKicker({ id: 'whats-new-index', area: 'whats-new' })).toBe("gezel · What's New");
  });

  it('names the area for every other page', () => {
    expect(ogKicker({ id: 'craftbook/powerpoint-deck', area: 'craftbooks' })).toBe(
      'gezel · Craftbooks',
    );
  });
});

describe('readOgHeadlines', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-og-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty file when none is committed', () => {
    expect(readOgHeadlines(dir)).toEqual(emptyOgHeadlineFile());
  });

  it('degrades to empty rather than throwing on a corrupt file', async () => {
    // A docs publish must never be blocked by a bad lockfile; every article
    // still has its title.
    await writeFile(join(dir, OG_HEADLINES_FILE), '{ not json', 'utf8');
    expect(readOgHeadlines(dir)).toEqual(emptyOgHeadlineFile());
  });

  it('round-trips a committed file', async () => {
    await writeFile(join(dir, OG_HEADLINES_FILE), JSON.stringify(LOCK), 'utf8');
    expect(readOgHeadlines(dir).entries[ENTRY.id]?.headline).toBe(DISTILLED);
  });
});
