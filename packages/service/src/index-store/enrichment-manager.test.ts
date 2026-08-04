import type { GezelDetail } from '@bendyline/gezel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import { SystemIdleState } from '../system/idle-state.js';
import type { ContentIndex } from './content-index.js';
import { buildEnrichDeps } from './enrich.js';
import { IndexEnrichmentManager } from './enrichment-manager.js';

const BOOK = {
  id: 'noor',
  name: 'Noor',
  role: 'Boekwachter',
  about: 'Keep summaries concise.',
  parsed: { frontmatter: { name: 'Noor' } },
} as unknown as GezelDetail;

/**
 * An idle state whose unreported-boot grace has already lapsed — the
 * steady-state headless daemon most of these tests model. The injected
 * clock answers the constructor's start-time capture with "31 minutes
 * ago" and real time afterwards.
 */
function agedIdleState(): SystemIdleState {
  let constructing = true;
  return new SystemIdleState(() => {
    if (constructing) {
      constructing = false;
      return Date.now() - 31 * 60_000;
    }
    return Date.now();
  });
}

function make(opts: { active: boolean; indexingEnabled?: boolean; freshBoot?: boolean }) {
  const enrich = vi.fn().mockResolvedValue({ files: 1, summarized: 1, embedded: 1 });
  const chat = {
    isAnyActive: () => opts.active,
    isProjectActive: () => false,
  } as unknown as ChatManager;
  const store = {
    listProjects: async () => [
      {
        id: 'p1',
        ...(opts.indexingEnabled !== undefined ? { indexingEnabled: opts.indexingEnabled } : {}),
      },
    ],
    readConfig: async () => ({}),
  } as unknown as Store;
  const contentIndex = { enrich } as unknown as ContentIndex;
  const idle = opts.freshBoot ? new SystemIdleState() : agedIdleState();
  const mgr = new IndexEnrichmentManager({
    store,
    chat,
    contentIndex,
    idle,
    resolveBoekwachter: async () => BOOK,
  });
  return { mgr, enrich, idle };
}

describe('IndexEnrichmentManager idle gating', () => {
  it('does not run while a chat turn is in flight', async () => {
    const { mgr, enrich } = make({ active: true });
    await mgr.tick();
    expect(enrich).not.toHaveBeenCalled();
  });

  it('runs when session-idle and OS-idle is unknown, once past the boot grace (headless)', async () => {
    const { mgr, enrich } = make({ active: false });
    await mgr.tick();
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  // The 2026-08-03 regression: a machine service that never hears an idle
  // report used to conclude "user away" the moment it booted, firing
  // enrichment one-shots ~20s after start and cold-loading a multi-GB
  // model while the user was actively logging in / installing.
  it('holds off during the unreported boot grace on a freshly started daemon', async () => {
    const { mgr, enrich, idle } = make({ active: false, freshBoot: true });
    await mgr.tick();
    expect(enrich).not.toHaveBeenCalled();
    // A real idle report ends the grace immediately — the desktop is
    // connected and the normal OS-idle gate takes over.
    idle.report(600);
    await mgr.tick();
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  it('skips AI indexing when the project crew has no Boekwachter', async () => {
    const { mgr, enrich } = make({ active: false });
    const withoutRole = mgr as unknown as {
      resolveBoekwachter: (projectId: string) => Promise<GezelDetail | null>;
    };
    withoutRole.resolveBoekwachter = async () => null;
    await mgr.tick();
    expect(enrich).not.toHaveBeenCalled();
  });

  it('skips AI indexing when workspace indexing is disabled', async () => {
    const { mgr, enrich } = make({ active: false, indexingEnabled: false });
    await mgr.tick();
    expect(enrich).not.toHaveBeenCalled();
  });

  it('waits for OS idle to exceed the threshold', async () => {
    const { mgr, enrich, idle } = make({ active: false });
    idle.report(5); // 5s idle — below the 3-min threshold
    await mgr.tick();
    expect(enrich).not.toHaveBeenCalled();

    idle.report(600); // 10 min idle
    await mgr.tick();
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  it('keeps a live activity snapshot for the full indexing tick', async () => {
    let release!: (value: { files: number; summarized: number; embedded: number }) => void;
    const { mgr, enrich } = make({ active: false });
    enrich.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const tick = mgr.tick();
    await vi.waitFor(() => expect(enrich).toHaveBeenCalled());
    expect(mgr.getActivity()).toEqual({
      id: 'index-enrichment',
      title: 'Workspace indexing',
      detail: 'Studying workspace files',
      projectId: 'p1',
    });

    release({ files: 1, summarized: 1, embedded: 1 });
    await tick;
    expect(mgr.getActivity()).toBeNull();
  });
});

describe('review tier scheduling', () => {
  function makeReviewFixture(
    opts: { drained: boolean; paused?: boolean; night?: boolean } = { drained: true },
  ) {
    const enrich = vi
      .fn()
      .mockResolvedValue(
        opts.drained
          ? { files: 0, summarized: 0, embedded: 0 }
          : { files: 1, summarized: 1, embedded: 1 },
      );
    const enrichAreas = vi.fn().mockResolvedValue({ areasUpdated: 0, architectureUpdated: false });
    const review = vi.fn().mockResolvedValue({ files: 0, reviewed: 0 });
    const chat = {
      isAnyActive: () => false,
      isProjectActive: () => false,
      oneShotCompletion: vi.fn().mockResolvedValue('ok'),
    } as unknown as ChatManager;
    const store = {
      listProjects: async () => [{ id: 'p1' }],
      // A configured local model — without one the review tier must no-op.
      readConfig: async () => ({ defaultModel: { mlx: 'enricher' } }),
      listIndexRubrics: async () => ({}),
    } as unknown as Store;
    const contentIndex = { enrich, enrichAreas, review } as unknown as ContentIndex;
    const idle = agedIdleState();
    const mgr = new IndexEnrichmentManager({
      store,
      chat,
      contentIndex,
      idle,
      ...(opts.night ? { isNightShiftActive: () => true } : {}),
      ...(opts.paused ? { isPaused: () => true } : {}),
      resolveBoekwachter: async () => BOOK,
    });
    return { mgr, enrich, enrichAreas, review };
  }

  it('runs one review batch after the file tier drains (day)', async () => {
    const { mgr, review } = makeReviewFixture({ drained: true });
    await mgr.tick();
    expect(review).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledWith('p1', expect.anything(), 5, expect.any(Map));
    const rubrics = review.mock.calls[0]![3] as Map<string, unknown>;
    expect(rubrics.size).toBeGreaterThan(0);
  });

  it('does not review while the file tier still has work (day)', async () => {
    const { mgr, review } = makeReviewFixture({ drained: false });
    await mgr.tick();
    expect(review).not.toHaveBeenCalled();
  });

  it('paused → neither enrich nor review runs', async () => {
    const { mgr, enrich, review } = makeReviewFixture({ drained: true, paused: true });
    await mgr.tick();
    expect(enrich).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it('GEZEL_FILE_REVIEWS=0 disables the review tier', async () => {
    process.env.GEZEL_FILE_REVIEWS = '0';
    try {
      const { mgr, review } = makeReviewFixture({ drained: true });
      await mgr.tick();
      expect(review).not.toHaveBeenCalled();
    } finally {
      delete process.env.GEZEL_FILE_REVIEWS;
    }
  });

  it('night mode drains reviews batch after batch', async () => {
    const { mgr, review } = makeReviewFixture({ drained: true, night: true });
    review
      .mockResolvedValueOnce({ files: 25, reviewed: 25 })
      .mockResolvedValueOnce({ files: 3, reviewed: 3 })
      .mockResolvedValue({ files: 0, reviewed: 0 });
    await mgr.tick();
    expect(review).toHaveBeenCalledTimes(3);
    expect(review).toHaveBeenCalledWith('p1', expect.anything(), 25, expect.any(Map));
  });
});

describe('buildEnrichDeps enricher override', () => {
  const priorModel = process.env.GEZEL_ENRICH_MODEL;
  const priorProvider = process.env.GEZEL_ENRICH_PROVIDER;
  afterEach(() => {
    if (priorModel === undefined) delete process.env.GEZEL_ENRICH_MODEL;
    else process.env.GEZEL_ENRICH_MODEL = priorModel;
    if (priorProvider === undefined) delete process.env.GEZEL_ENRICH_PROVIDER;
    else process.env.GEZEL_ENRICH_PROVIDER = priorProvider;
  });

  function makeDepsFixture() {
    const oneShotCompletion = vi.fn().mockResolvedValue('a summary');
    const chat = { oneShotCompletion } as unknown as ChatManager;
    const store = {
      readConfig: async () => ({ defaultModel: { mlx: 'big-executor' } }),
    } as unknown as Store;
    return { chat, store, oneShotCompletion };
  }

  it('defaults the summarizer to the first configured local provider model', async () => {
    delete process.env.GEZEL_ENRICH_MODEL;
    delete process.env.GEZEL_ENRICH_PROVIDER;
    const { chat, store, oneShotCompletion } = makeDepsFixture();
    const deps = await buildEnrichDeps(store, chat);
    expect(deps.model).toBe('big-executor');
    await deps.summarize('p');
    expect(oneShotCompletion).toHaveBeenCalledWith(
      'p',
      expect.any(Number),
      expect.objectContaining({
        providerName: 'mlx',
        model: 'big-executor',
        actorLabel: 'Boekwachter',
      }),
    );
  });

  it('runs one-shots as the project Boekwachter persona', async () => {
    delete process.env.GEZEL_ENRICH_MODEL;
    delete process.env.GEZEL_ENRICH_PROVIDER;
    const { chat, store, oneShotCompletion } = makeDepsFixture();
    const deps = await buildEnrichDeps(store, chat, { boekwachter: BOOK });
    await deps.summarize('p');
    expect(oneShotCompletion).toHaveBeenCalledWith(
      'p',
      expect.any(Number),
      expect.objectContaining({
        gezelId: 'noor',
        useGezelPersona: true,
        actorLabel: 'Noor',
      }),
    );
  });

  it('uses the specific Night Shift provider/model for bulk enrichment', async () => {
    delete process.env.GEZEL_ENRICH_MODEL;
    delete process.env.GEZEL_ENRICH_PROVIDER;
    const oneShotCompletion = vi.fn().mockResolvedValue('a summary');
    const chat = { oneShotCompletion } as unknown as ChatManager;
    const store = {
      readConfig: async () => ({
        defaultModel: { mlx: 'day-model' },
        nightShift: {
          modelOverride: { enabled: true, provider: 'openai', model: 'slow-night-model' },
        },
      }),
    } as unknown as Store;

    const deps = await buildEnrichDeps(store, chat, { nightShift: true });
    expect(deps.model).toBe('slow-night-model');
    await deps.summarize('p');
    expect(oneShotCompletion).toHaveBeenCalledWith(
      'p',
      expect.any(Number),
      expect.objectContaining({ providerName: 'openai', model: 'slow-night-model' }),
    );
  });

  it('GEZEL_ENRICH_MODEL swaps the summarizer model, keeping the configured provider', async () => {
    process.env.GEZEL_ENRICH_MODEL = 'small-enricher';
    delete process.env.GEZEL_ENRICH_PROVIDER;
    const { chat, store, oneShotCompletion } = makeDepsFixture();
    const deps = await buildEnrichDeps(store, chat);
    expect(deps.model).toBe('small-enricher');
    await deps.summarize('p');
    expect(oneShotCompletion).toHaveBeenCalledWith(
      'p',
      expect.any(Number),
      expect.objectContaining({ providerName: 'mlx', model: 'small-enricher' }),
    );
  });

  it('GEZEL_ENRICH_PROVIDER overrides the provider when it is a known local provider', async () => {
    process.env.GEZEL_ENRICH_MODEL = 'small-enricher';
    process.env.GEZEL_ENRICH_PROVIDER = 'llama-cpp';
    const { chat, store, oneShotCompletion } = makeDepsFixture();
    await (await buildEnrichDeps(store, chat)).summarize('p');
    expect(oneShotCompletion).toHaveBeenCalledWith(
      'p',
      expect.any(Number),
      expect.objectContaining({ providerName: 'llama-cpp', model: 'small-enricher' }),
    );
  });

  it('builds a review completion on the same model with a longer timeout and its own job label', async () => {
    delete process.env.GEZEL_ENRICH_MODEL;
    delete process.env.GEZEL_ENRICH_PROVIDER;
    const { chat, store, oneShotCompletion } = makeDepsFixture();
    const deps = await buildEnrichDeps(store, chat);
    expect(deps.review).toBeDefined();
    await deps.review!('p');
    expect(oneShotCompletion).toHaveBeenCalledWith(
      'p',
      60_000,
      expect.objectContaining({
        providerName: 'mlx',
        model: 'big-executor',
        actorLabel: 'Boekwachter',
        jobLabel: 'index review',
      }),
    );
  });

  it('omits the review completion when no local model is configured', async () => {
    delete process.env.GEZEL_ENRICH_MODEL;
    const chat = { oneShotCompletion: vi.fn() } as unknown as ChatManager;
    const store = { readConfig: async () => ({}) } as unknown as Store;
    const deps = await buildEnrichDeps(store, chat);
    expect(deps.model).toBeUndefined();
    expect(deps.review).toBeUndefined();
  });
});
