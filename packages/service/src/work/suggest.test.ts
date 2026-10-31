import {
  type CraftbookSuggestion,
  type SuggestedWorkItem,
  securityPolicyForLevel,
} from '@bendyline/gezel';
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
  {
    id: 'just-chat',
    name: 'Chat',
    category: 'general',
    tags: ['chat', 'casual'],
    gezels: [{ templateId: 'companion', voorman: true }],
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

  it('never offers a book a message cannot start, and measures the rest without it', async () => {
    const book = (id: string, paramSchema: Record<string, unknown>) => ({
      manifest: { kind: 'craftbook-template', id, name: id, paramSchema },
    });
    const listOffer = (async () => ({
      items: [
        book('tidy-spreadsheet', {
          properties: { source: { title: 'Spreadsheet', input: { kind: 'file' } } },
          required: ['source'],
        }),
        book('needs-audience', {
          properties: { topic: { type: 'string' }, audience: { type: 'string' } },
          required: ['topic', 'audience'],
        }),
        book('dataset-clean', {
          properties: { topic: { type: 'string' } },
          required: ['topic'],
        }),
      ],
      missingToolsets: {},
      establishedCodebase: false,
    })) as unknown as NonNullable<SuggestWorkInput['listOffer']>;
    const result = await suggestWork(deps(), {
      request: 'Please clean up the raw customer spreadsheets under data/raw/ and dedupe them.',
      projectId: 'customers',
      listOffer,
      rankCraftbooks: books(
        { id: 'tidy-spreadsheet', score: 0.62, semantic: 0.7, lexical: 0.3 },
        { id: 'needs-audience', score: 0.6, semantic: 0.68, lexical: 0.2 },
        { id: 'dataset-clean', score: 0.53, semantic: 0.6, lexical: 0.2 },
      ),
    });
    expect(result.options.map((o) => o.id)).toEqual(['craftbook:dataset-clean', 'task-here']);
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

  it('measures a lead against the next specific type, not a catch-all', async () => {
    const result = await suggestWork(deps(), {
      request: "Can you help me get better at French conversation? I'm a beginner.",
      projectId: 'default',
      rankCraftbooks: books(),
      rankTypes: typeScores(
        { id: 'type:language-trainer', score: 0.427, semantic: 0.579 },
        { id: 'type:just-chat', score: 0.395, semantic: 0.534 },
        { id: 'type:trip-planner', score: 0.343, semantic: 0.49 },
      ),
    });
    expect(result.options[0]?.id).toBe('type:language-trainer');
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

  // qwen3.8-27b work-routing check, 2026-10-22: bge-small read a cart-total
  // bug as billing, and the only option was Invoice Generator.
  const codeShelf = (async () => ({
    items: [
      { manifest: { kind: 'craftbook-template', id: 'invoice-generator', category: 'business' } },
      { manifest: { kind: 'craftbook-template', id: 'bug-fix-tdd', category: 'code-quality' } },
    ],
    missingToolsets: {},
    establishedCodebase: false,
  })) as unknown as NonNullable<SuggestWorkInput['listOffer']>;
  const billingFirst = books(
    { id: 'invoice-generator', score: 0.55, semantic: 0.6, lexical: 0.1 },
    { id: 'bug-fix-tdd', score: 0.52, semantic: 0.58, lexical: 0.2 },
  );
  const cartBug =
    'There is a bug in src/cart.js — cartTotal ignores item quantity, so three $5 items bill as $5. Can you get that fixed?';

  it('hands a fix to existing code from Default to the developer, with no recipe to start', async () => {
    const result = await suggestWork(deps(), {
      request: cartBug,
      projectId: 'default',
      tools: ['delegate_developer', 'search'],
      listOffer: codeShelf,
      rankCraftbooks: billingFirst,
    });
    expect(result.options).toEqual([]);
    expect(result.guidance[0]).toEqual({
      kind: 'specialist',
      role: 'developer',
      tool: 'delegate_developer',
      otherProject: true,
    });
  });

  it('hands a review of existing code to the reviewer when one is on the roster', async () => {
    const result = await suggestWork(deps(), {
      request: 'Can you get someone to review src/pricing.js and write up the quality risks?',
      projectId: 'default',
      tools: ['delegate_developer', 'delegate_reviewer'],
      listOffer: codeShelf,
      rankCraftbooks: billingFirst,
    });
    expect(result.guidance[0]).toEqual({
      kind: 'specialist',
      role: 'reviewer',
      tool: 'delegate_reviewer',
      otherProject: true,
    });
  });

  it('offers only code recipes for existing code inside a project', async () => {
    const result = await suggestWork(deps(), {
      request: cartBug,
      projectId: 'shop',
      tools: ['delegate_developer'],
      listOffer: codeShelf,
      rankCraftbooks: billingFirst,
    });
    expect(result.options.map((o) => o.id)).toEqual(['craftbook:bug-fix-tdd', 'task-here']);
    expect(result.guidance[0]).toMatchObject({ kind: 'specialist', tool: 'delegate_developer' });
  });

  it('says a book that runs project commands needs package scripts while they are off', async () => {
    const shelf = (async () => ({
      items: [
        {
          manifest: {
            kind: 'craftbook-template',
            id: 'bug-fix-tdd',
            category: 'code-quality',
            commands: [{ scope: 'script', name: 'test' }],
          },
        },
      ],
      missingToolsets: {},
      establishedCodebase: false,
    })) as unknown as NonNullable<SuggestWorkInput['listOffer']>;
    const run = (level: 'lockdown' | 'free') =>
      suggestWork(
        deps({
          store: {
            readConfig: async () => ({ securityPolicy: securityPolicyForLevel(level) }),
          } as unknown as Store,
        }),
        {
          request: cartBug,
          projectId: 'shop',
          listOffer: shelf,
          rankCraftbooks: books({ id: 'bug-fix-tdd', score: 0.52, semantic: 0.58, lexical: 0.2 }),
        },
      );
    const book = (result: Awaited<ReturnType<typeof run>>) =>
      result.options.find((o) => o.id === 'craftbook:bug-fix-tdd');
    expect(book(await run('lockdown'))).toMatchObject({
      setupRequired: ['the "Run package scripts" setting'],
    });
    expect(book(await run('free'))).not.toHaveProperty('setupRequired');
  });

  // qwen3.8-27b work-routing check, 2026-10-22: the request named an existing
  // project, and Default offered a new Data Analysis project instead.
  const withProjects = (...projects: Array<{ id: string; name: string }>) =>
    deps({ store: { listProjects: async () => projects } as unknown as Store });
  const dataShelf = (async () => ({
    items: [
      {
        manifest: {
          kind: 'craftbook-template',
          id: 'dataset-clean',
          category: 'code-data',
          paramSchema: { properties: { topic: { type: 'string' } }, required: ['topic'] },
        },
      },
    ],
    missingToolsets: {},
    establishedCodebase: false,
  })) as unknown as NonNullable<SuggestWorkInput['listOffer']>;

  it('ranks a request inside the existing project it names', async () => {
    const result = await suggestWork(
      withProjects({ id: 'customer-list-cleanup', name: 'Customer List Cleanup' }),
      {
        request:
          'Please clean up the raw customer spreadsheets in the "Customer List Cleanup" project: normalize the emails and dates, and dedupe the records.',
        projectId: 'default',
        listOffer: dataShelf,
        rankCraftbooks: books({ id: 'dataset-clean', score: 0.55, semantic: 0.6, lexical: 0.2 }),
        rankTypes: typeScores({ id: 'trip-planner', score: 0.6, semantic: 0.6 }),
      },
    );
    expect(result.projectId).toBe('customer-list-cleanup');
    expect(result.options.map((o) => o.id)).toEqual(['craftbook:dataset-clean', 'task-here']);
  });

  it('does not move a request for a bare mention of a project name', async () => {
    const result = await suggestWork(withProjects({ id: 'trip-planner-1', name: 'Trip Planner' }), {
      request: 'Plan a week in Rome with the trip planner for the two of us.',
      projectId: 'default',
      rankCraftbooks: books(),
    });
    expect(result.projectId).toBe('default');
  });

  it('offers nothing for a repository named from Default, which has to be fetched first', async () => {
    const result = await suggestWork(deps(), {
      request: 'Can you review the code in https://github.com/bendyline/gezel and list the risks?',
      projectId: 'default',
      tools: ['delegate_developer', 'fetch_repo'],
      listOffer: codeShelf,
      rankCraftbooks: billingFirst,
      rankTypes: typeScores({ id: 'trip-planner', score: 0.6, semantic: 0.6 }),
    });
    expect(result.options).toEqual([]);
    expect(result.guidance.map((g) => g.kind)).toEqual(['self']);
  });
});
