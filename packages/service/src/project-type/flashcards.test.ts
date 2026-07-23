import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { applyProjectType } from './apply.js';
import { resolvePageTools, resolveProjectScriptTools } from './script-tools.js';

/**
 * The Flashcards mini exemplar — proves the interactive-page rails
 * generalize beyond games: page-driven reviews plus a coaching reaction on
 * `finish_session`. Includes the shipped Leitner rules block, executed via
 * sentinel extraction (all platforms).
 */

interface LeitnerCard {
  id: string;
  box: number;
  lastReviewedAt: string | null;
  createdAt: string;
  stats?: { gotIt: number; missed: number };
}

interface Leitner {
  isDue(card: LeitnerCard, nowMs: number): boolean;
  computeDueIds(cards: LeitnerCard[], nowMs: number): string[];
  applyReview(card: LeitnerCard, verdict: string, nowIso: string): LeitnerCard;
  nextCardId(cards: Array<{ id: string }>): string;
}

let leitner: Leitner;

beforeAll(async () => {
  const catalog = new CatalogService();
  const detail = await catalog.get('project-type', 'flashcards');
  if (!detail || detail.manifest.kind !== 'project-type')
    throw new Error('flashcards not resolved');
  const source = detail.manifest.scripts?.['deck-store'];
  if (!source) throw new Error('deck-store script missing');
  const start = source.indexOf('// ── leitner-rules-start ──');
  const end = source.indexOf('// ── leitner-rules-end ──');
  leitner = new Function(
    `${source.slice(start, end)}; return { isDue, computeDueIds, applyReview, nextCardId };`,
  )() as Leitner;
});

const DAY = 24 * 60 * 60 * 1000;

describe('flashcards Leitner rules (shipped bytes)', () => {
  const at = (ms: number) => new Date(ms).toISOString();

  it('never-reviewed cards are always due; boxes space 1/3/7 days', () => {
    const now = Date.parse('2026-07-18T12:00:00Z');
    const card = (box: number, reviewedDaysAgo: number | null): LeitnerCard => ({
      id: 'card-1',
      box,
      lastReviewedAt: reviewedDaysAgo === null ? null : at(now - reviewedDaysAgo * DAY),
      createdAt: at(now - 30 * DAY),
    });
    expect(leitner.isDue(card(3, null), now)).toBe(true);
    expect(leitner.isDue(card(1, 0.5), now)).toBe(false);
    expect(leitner.isDue(card(1, 1), now)).toBe(true);
    expect(leitner.isDue(card(2, 2), now)).toBe(false);
    expect(leitner.isDue(card(2, 3), now)).toBe(true);
    expect(leitner.isDue(card(3, 6), now)).toBe(false);
    expect(leitner.isDue(card(3, 7), now)).toBe(true);
  });

  it('got-it promotes (capped at 3); missed demotes to box 1', () => {
    const now = at(Date.now());
    const card: LeitnerCard = { id: 'c', box: 1, lastReviewedAt: null, createdAt: now };
    leitner.applyReview(card, 'got-it', now);
    expect(card.box).toBe(2);
    leitner.applyReview(card, 'got-it', now);
    expect(card.box).toBe(3);
    leitner.applyReview(card, 'got-it', now);
    expect(card.box).toBe(3);
    leitner.applyReview(card, 'missed', now);
    expect(card.box).toBe(1);
    expect(card.stats).toEqual({ gotIt: 3, missed: 1 });
  });

  it('due ordering: lower boxes first, then oldest', () => {
    const now = Date.parse('2026-07-18T12:00:00Z');
    const cards: LeitnerCard[] = [
      { id: 'c-weekly', box: 3, lastReviewedAt: at(now - 8 * DAY), createdAt: at(now - 20 * DAY) },
      { id: 'c-new', box: 1, lastReviewedAt: null, createdAt: at(now - 1 * DAY) },
      { id: 'c-old', box: 1, lastReviewedAt: null, createdAt: at(now - 10 * DAY) },
      { id: 'c-fresh', box: 2, lastReviewedAt: at(now - DAY), createdAt: at(now - 10 * DAY) },
    ];
    expect(leitner.computeDueIds(cards, now)).toEqual(['c-old', 'c-new', 'c-weekly']);
  });

  it('mints counter ids past custom entries', () => {
    expect(leitner.nextCardId([])).toBe('card-1');
    expect(leitner.nextCardId([{ id: 'card-7' }, { id: 'custom' }])).toBe('card-8');
  });
});

describe('Flashcards bundled project type', () => {
  let home: string;
  let store: Store;
  let catalog: CatalogService;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'flashcards-'));
    store = new Store({ home });
    await store.ensureLayout();
    catalog = new CatalogService();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('resolves with the reaction on finish_session, page-listed', async () => {
    const detail = await catalog.get('project-type', 'flashcards');
    if (!detail || detail.manifest.kind !== 'project-type') throw new Error('did not resolve');
    expect(detail.manifest.category).toBe('growth');
    expect(detail.manifest.pages?.tools).toEqual(['record_review', 'finish_session']);
    const finish = detail.manifest.tools.find((t) => t.name === 'finish_session');
    expect(finish?.reaction?.gezel).toBe('study-buddy');
    for (const tool of detail.manifest.tools) {
      if (tool.reaction) expect(detail.manifest.pages?.tools).toContain(tool.name);
    }
  });

  it('applies: Studiemaat voorman, templated empty deck, split surfaces', async () => {
    const project = await store.createProject({ name: 'Learn Kanji' });
    const applied = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'flashcards', params: { subject: 'Kanji radicals' } },
    );

    expect(applied.gezelsCreated).toHaveLength(1);
    const buddy = await store.getGezel(applied.gezelsCreated[0]!.id);
    expect(buddy?.role).toBe('Studiemaat');

    const workspaceDir = await store.projectWorkspaceDir(project.id);
    const deck = JSON.parse(await readFile(join(workspaceDir, 'deck.json'), 'utf8'));
    expect(deck.subject).toBe('Kanji radicals');
    expect(deck.cards).toEqual([]);

    const detail = await store.getProject(project.id);
    expect(detail?.about ?? '').toContain('Kanji radicals');
    expect(detail?.about ?? '').not.toContain('{{');

    const modelTools = await resolveProjectScriptTools(catalog, detail);
    expect(modelTools.map((t) => t.name)).toEqual(['add_cards', 'deck_status', 'list_deck']);
    const pageTools = await resolvePageTools(catalog, detail);
    expect(pageTools?.tools.map((t) => t.name)).toEqual(['record_review', 'finish_session']);
  });
});
