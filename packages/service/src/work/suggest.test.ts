import type { CraftbookSuggestion, SuggestedWorkItem } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import {
  type SuggestWorkInput,
  type WorkSuggestionDeps,
  suggestWork as suggestWorkWith,
} from './suggest.js';

const TYPES = [
  {
    id: 'trip-planner',
    name: 'Trip planner',
    description: 'A day-by-day plan and a packing list, on a trip board.',
    tags: ['trip', 'travel'],
    gezels: [{ templateId: 'reisleider', voorman: true }],
  },
  {
    id: 'language-trainer',
    name: 'Language trainer',
    tags: ['language', 'learning', 'tutor', 'conversation'],
    gezels: [{ templateId: 'tutor', voorman: true }],
  },
];

function deps(extra: Partial<WorkSuggestionDeps> = {}): WorkSuggestionDeps {
  const catalog = {
    list: async (kind: string) =>
      kind === 'project-type' ? TYPES.map((manifest) => ({ manifest })) : [],
  } as unknown as CatalogService;
  return { catalog, store: {} as Store, ...extra };
}

/** No type leads on meaning unless a test says so; the real ranker would load the embedder. */
const noTypes: NonNullable<SuggestWorkInput['rankTypes']> = async () => [];
const suggestWork = (d: WorkSuggestionDeps, input: SuggestWorkInput) =>
  suggestWorkWith(d, { rankTypes: noTypes, ...input });

function typeScores(...rows: Array<{ id: string; score: number; semantic?: number }>) {
  return async () =>
    rows.map(
      (row) =>
        ({
          name: row.id,
          source: 'bundled',
          stepCount: 1,
          lexical: 0,
          ...row,
        }) as CraftbookSuggestion,
    );
}

function books(...rows: Array<Partial<CraftbookSuggestion> & { id: string }>) {
  return async () =>
    rows.map(
      (row) =>
        ({
          name: row.id,
          source: 'bundled',
          stepCount: 2,
          score: 0.5,
          lexical: 0.2,
          ...row,
        }) as CraftbookSuggestion,
    );
}

describe('suggestWork', () => {
  it('offers the named project type first in Default, then the new-project path', async () => {
    const result = await suggestWork(deps(), {
      request: 'Plan a trip to Lisbon next spring for the four of us, with a packing list.',
      projectId: 'default',
      tools: ['consult_researcher', 'search'],
      rankCraftbooks: books(),
    });
    expect(result.options.map((o) => o.id)).toEqual(['type:trip-planner', 'new-project']);
    expect(result.guidance).toEqual([{ kind: 'self', tools: ['consult_researcher', 'search'] }]);
  });

  it('returns an exact-format route alone, without ranking anything else', async () => {
    let ranked = false;
    const result = await suggestWork(deps(), {
      request: 'Can you create a PowerPoint about Alaska?',
      projectId: 'default',
      rankCraftbooks: async () => {
        ranked = true;
        return [];
      },
    });
    expect(result.options.map((o) => o.id)).toEqual(['craftbook:powerpoint-deck']);
    expect(result.options[0]).toMatchObject({ params: { topic: 'Alaska' } });
    expect(ranked).toBe(false);
  });

  it('drops craftbooks under their floor and marks strong ones', async () => {
    const result = await suggestWork(deps(), {
      request: 'Write a status report for my team.',
      projectId: 'default',
      rankCraftbooks: books(
        { id: 'status-report', score: 0.6, semantic: 0.7, lexical: 0.3 },
        { id: 'noise', score: 0.26, semantic: 0.3, lexical: 0 },
      ),
    });
    expect(result.options.map((o) => o.id)).toEqual(['craftbook:status-report']);
  });

  it('cuts books that trail the best one', async () => {
    const result = await suggestWork(deps(), {
      request: 'Write a status report for my team.',
      projectId: 'default',
      rankCraftbooks: books(
        { id: 'status-report', score: 0.6, semantic: 0.7, lexical: 0.3 },
        { id: 'onboarding-checklist', score: 0.57, semantic: 0.66, lexical: 0.1 },
        { id: 'release-notes', score: 0.52, semantic: 0.6, lexical: 0.1 },
      ),
    });
    expect(result.options.map((o) => o.id)).toEqual([
      'craftbook:status-report',
      'craftbook:onboarding-checklist',
    ]);
  });

  it('offers a type that clearly leads on meaning, though no tag names it', async () => {
    const request = "I'd like to practice my Spanish. I know the basics.";
    const leading = await suggestWork(deps(), {
      request,
      projectId: 'default',
      rankCraftbooks: books(),
      rankTypes: typeScores(
        { id: 'type:language-trainer', score: 0.413, semantic: 0.575 },
        { id: 'type:trip-planner', score: 0.33, semantic: 0.47 },
      ),
    });
    expect(leading.options[0]?.id).toBe('type:language-trainer');

    const close = await suggestWork(deps(), {
      request,
      projectId: 'default',
      rankCraftbooks: books(),
      rankTypes: typeScores(
        { id: 'type:language-trainer', score: 0.413, semantic: 0.575 },
        { id: 'type:trip-planner', score: 0.39, semantic: 0.55 },
      ),
    });
    expect(close.options.some((o) => o.kind === 'project-type')).toBe(false);
  });

  it('asks instead of guessing when a short request fits no book well', async () => {
    const result = await suggestWork(deps(), {
      request: 'Help me with my thing for work.',
      projectId: 'default',
      rankCraftbooks: books({
        id: 'knowledge-base-article',
        score: 0.417,
        semantic: 0.527,
        lexical: 0.16,
      }),
    });
    expect(result.options).toEqual([]);
    expect(result.guidance[0]?.kind).toBe('ask');
  });

  it('never offers a project type inside an existing project', async () => {
    const result = await suggestWork(deps(), {
      request: 'Plan a trip to Lisbon next spring for the four of us.',
      projectId: 'bakery-site',
      rankCraftbooks: books(),
    });
    expect(result.options.map((o) => o.id)).toEqual(['task-here']);
  });

  it('matches recurring work only for recurring or stopping wording', async () => {
    const item: SuggestedWorkItem = {
      key: 'gezel-template:cso:security-review',
      source: { kind: 'gezel-template', templateId: 'cso' },
      craftbookId: 'security-review',
      craftbookName: 'Security review',
      runMode: 'night-shift',
      state: 'enabled',
    } as SuggestedWorkItem;
    const withWork = deps({ listSuggestedWork: async () => [item] });
    const stop = await suggestWork(withWork, {
      request: 'Please stop the nightly security review',
      projectId: 'shop',
      rankCraftbooks: books(),
    });
    expect(stop.options[0]?.id).toBe('recurring-pause:gezel-template:cso:security-review');

    const plain = await suggestWork(withWork, {
      request: 'Review the security of the checkout code',
      projectId: 'shop',
      rankCraftbooks: books(),
    });
    expect(plain.options.some((o) => o.kind === 'recurring')).toBe(false);
  });

  it('answers a question first and names only the tools the session has', async () => {
    const result = await suggestWork(deps(), {
      request: 'What can you do?',
      projectId: 'default',
      tools: ['search_memory', 'list_tasks'],
      rankCraftbooks: books({ id: 'weak', score: 0.31, semantic: 0.4, lexical: 0 }),
    });
    expect(result.question).toBe(true);
    expect(result.options).toEqual([]);
    expect(result.guidance[0]).toEqual({ kind: 'self', tools: ['search_memory', 'list_tasks'] });
  });

  it('points implementation in a project at the on-roster developer', async () => {
    const result = await suggestWork(deps(), {
      request: 'Fix the checkout bug in the cart code',
      projectId: 'shop',
      tools: ['delegate_developer'],
      rankCraftbooks: books(),
    });
    expect(result.guidance[0]).toEqual({
      kind: 'specialist',
      role: 'developer',
      tool: 'delegate_developer',
    });
  });
});
