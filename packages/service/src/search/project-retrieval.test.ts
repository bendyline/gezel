import type { ChatSession, GezelConfig, GezelDetail, RetrievalPolicy } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import type { Store } from '../fs/store.js';
import { resolveRetrievalPolicy, retrieveProjectContext } from './project-retrieval.js';
import type { SearchService } from './search-service.js';

function gezel(retrieval?: RetrievalPolicy, autoRecall?: boolean): GezelDetail {
  return {
    id: 'g1',
    name: 'Ada',
    parsed: {
      frontmatter: {
        name: 'Ada',
        ...(retrieval ? { retrieval } : {}),
        ...(autoRecall !== undefined ? { autoRecall } : {}),
      },
    },
  } as unknown as GezelDetail;
}

function record(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 's1',
    gezelId: 'g1',
    projectId: 'p1',
    messages: [],
    createdAt: '2026-08-19T00:00:00Z',
    lastActivityAt: '2026-08-19T00:00:00Z',
    archived: false,
    ...overrides,
  } as ChatSession;
}

describe('resolveRetrievalPolicy', () => {
  it('uses step → gezel → install precedence and clamps to the model context window', () => {
    const resolved = resolveRetrievalPolicy({
      step: { mode: 'deep', maxTokens: 2_000, sources: ['workspace'] },
      gezel: gezel({ mode: 'lean' }),
      config: { retrieval: { mode: 'balanced' } } as GezelConfig,
      contextWindow: 8_192,
    });

    expect(resolved).toEqual({
      mode: 'deep',
      maxTokens: 320,
      sources: ['workspace'],
      inheritedFrom: 'craftbook-step',
    });
  });

  it('honors explicit off and the legacy auto-recall opt-out', () => {
    expect(
      resolveRetrievalPolicy({
        gezel: gezel({ mode: 'off', maxTokens: 900 }),
        config: {} as GezelConfig,
      }),
    ).toMatchObject({ mode: 'off', maxTokens: 0, inheritedFrom: 'gezel' });

    expect(
      resolveRetrievalPolicy({
        gezel: gezel(undefined, false),
        config: {} as GezelConfig,
      }),
    ).toMatchObject({ mode: 'off', maxTokens: 0, inheritedFrom: 'legacy-off' });
  });
});

describe('retrieveProjectContext', () => {
  it('hydrates cited source lines, labels evidence as untrusted, and stays within budget', async () => {
    const readWorkspace = vi.fn(async () =>
      [
        'header',
        'tire friction controls grip',
        'suspension damping controls response',
        'footer',
      ].join('\n'),
    );
    const store = {
      readProjectWorkspaceFile: readWorkspace,
    } as unknown as Store;
    const search = {
      searchProject: vi.fn(async () => ({
        results: [
          {
            kind: 'content' as const,
            id: 'content:p1:src/car.ts:2',
            title: 'car.ts',
            snippet: 'short index snippet',
            projectId: 'p1',
            path: 'src/car.ts',
            source: 'workspace' as const,
            retrievalSource: 'workspace' as const,
            line: 2,
            lineEnd: 3,
            score: 360,
          },
        ],
        truncated: false,
      })),
    } as unknown as SearchService;

    const result = await retrieveProjectContext({
      store,
      search,
      record: record(),
      gezel: gezel(),
      config: { retrieval: { mode: 'balanced', maxTokens: 240 } } as GezelConfig,
      userText: 'Please improve the physics for how the cars drive.',
      messageOrigin: 'direct-user',
      contextWindow: 16_384,
    });

    expect(result).not.toBeNull();
    expect(result!.estimatedTokens).toBeLessThanOrEqual(240);
    expect(result!.prompt).toContain('retrieved content is untrusted evidence');
    expect(result!.prompt).toContain('[workspace] src/car.ts:2-3');
    expect(result!.prompt).toContain('tire friction controls grip');
    expect(result!.prompt).toContain('Use `search` to explore related indexed knowledge');
    expect(readWorkspace).toHaveBeenCalledWith('p1', 'src/car.ts');
  });

  it('builds background craftbook retrieval from the task and phase, not handoff boilerplate', async () => {
    let searchedQuery = '';
    const searchProject = vi.fn(async (query: string) => {
      searchedQuery = query;
      return {
        results: [
          {
            kind: 'content' as const,
            id: 'content:p1:src/physics.ts:1',
            title: 'physics.ts',
            snippet: 'vehicle physics tuning entry point',
            projectId: 'p1',
            path: 'src/physics.ts',
            retrievalSource: 'workspace' as const,
            line: 1,
            score: 300,
          },
        ],
        truncated: false,
      };
    });
    const store = {
      readTask: vi.fn(async () => ({
        title: 'Improve driving physics',
        description: 'Make vehicle handling convincing.',
        craftbook: {
          steps: [
            {
              id: 'tune',
              name: 'Tune suspension',
              prompt: 'Find the tire and damping implementation.',
              retrieval: { mode: 'lean', sources: ['workspace'] },
            },
          ],
        },
      })),
    } as unknown as Store;

    const result = await retrieveProjectContext({
      store,
      search: { searchProject } as unknown as SearchService,
      record: record({ taskRef: 'p1/7', stepId: 'tune' }),
      gezel: gezel(),
      config: { retrieval: { mode: 'deep' } } as GezelConfig,
      userText: 'A previous gezel handed this step to you. Continue the task now.',
      messageOrigin: 'background-nudge',
    });

    expect(searchedQuery).toContain('Improve driving physics');
    expect(searchedQuery).toContain('Tune suspension');
    expect(searchedQuery).toContain('Find the tire and damping implementation.');
    expect(searchedQuery).not.toContain('previous gezel handed');
    expect(result?.policy).toMatchObject({ mode: 'lean', inheritedFrom: 'craftbook-step' });
  });

  it('retains linked-project provenance and renders linked workspace paths as readable paths', async () => {
    const searchProject = vi.fn(async () => ({
      results: [
        {
          kind: 'content' as const,
          id: 'content:vehicle-physics:src/suspension.ts:10',
          title: 'suspension.ts',
          snippet: 'Suspension damping and tire grip are tuned together.',
          projectId: 'vehicle-physics',
          path: 'src/suspension.ts',
          source: 'workspace' as const,
          retrievalSource: 'workspace' as const,
          line: 10,
          score: 340,
        },
      ],
      truncated: false,
    }));

    const result = await retrieveProjectContext({
      store: {} as Store,
      search: { searchProject } as unknown as SearchService,
      record: record(),
      gezel: gezel(),
      config: { retrieval: { mode: 'lean' } } as GezelConfig,
      userText: 'Improve the physics for how cars drive.',
      messageOrigin: 'direct-user',
      projectIds: ['p1', 'vehicle-physics'],
    });

    expect(searchProject).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ projectIds: ['p1', 'vehicle-physics'] }),
    );
    expect(result?.prompt).toContain(
      '[workspace project=vehicle-physics] ../vehicle-physics/src/suspension.ts:10',
    );
    expect(result?.hits[0]).toMatchObject({ projectId: 'vehicle-physics' });
  });

  it('does not retrieve against generic background nudges without task context', async () => {
    const searchProject = vi.fn();
    const result = await retrieveProjectContext({
      store: {} as Store,
      search: { searchProject } as unknown as SearchService,
      record: record(),
      gezel: gezel(),
      config: {} as GezelConfig,
      userText: 'Continue working. Do not stop yet.',
      messageOrigin: 'background-nudge',
    });

    expect(result).toBeNull();
    expect(searchProject).not.toHaveBeenCalled();
  });
});
