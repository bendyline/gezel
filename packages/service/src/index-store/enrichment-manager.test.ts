import type { GezelDetail } from '@bendyline/gezel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import { SystemIdleState } from '../system/idle-state.js';
import type { ContentIndex } from './content-index.js';
import { type EnrichDeps, buildEnrichDeps } from './enrich.js';
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
  const embedOnly = vi.fn().mockResolvedValue({ files: 0, embedded: 0 });
  const embedImages = vi.fn().mockResolvedValue({ files: 0, embedded: 0, unavailable: false });
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
  const contentIndex = { enrich, embedOnly, embedImages } as unknown as ContentIndex;
  const idle = opts.freshBoot ? new SystemIdleState() : agedIdleState();
  const mgr = new IndexEnrichmentManager({
    store,
    chat,
    contentIndex,
    idle,
    resolveBoekwachter: async () => BOOK,
  });
  return { mgr, enrich, embedOnly, embedImages, idle };
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

  it('the embed-only tier runs ahead of the roster gate — no Boekwachter required', async () => {
    const { mgr, enrich, embedOnly } = make({ active: false });
    const withoutRole = mgr as unknown as {
      resolveBoekwachter: (projectId: string) => Promise<GezelDetail | null>;
    };
    withoutRole.resolveBoekwachter = async () => null;
    await mgr.tick();
    // Semantic-search embeddings need no roster opt-in; the LLM tiers do.
    expect(embedOnly).toHaveBeenCalledWith('p1', expect.any(Number));
    expect(enrich).not.toHaveBeenCalled();
  });

  it('the embed-only tier still honors the indexing opt-out', async () => {
    const { mgr, embedOnly } = make({ active: false, indexingEnabled: false });
    await mgr.tick();
    expect(embedOnly).not.toHaveBeenCalled();
  });

  it('the image-embed tier runs ahead of the roster gate too', async () => {
    const { mgr, embedImages, enrich } = make({ active: false });
    const withoutRole = mgr as unknown as {
      resolveBoekwachter: (projectId: string) => Promise<GezelDetail | null>;
    };
    withoutRole.resolveBoekwachter = async () => null;
    await mgr.tick();
    expect(embedImages).toHaveBeenCalledWith('p1', expect.any(Number));
    expect(enrich).not.toHaveBeenCalled();
  });

  it('drainEmbedOnly runs immediately — no OS idle, no boot grace, no roster', async () => {
    // freshBoot: the background tick is blocked by the unreported-boot grace,
    // which is exactly the state a user creating their first project is in.
    const { mgr, embedOnly, embedImages, enrich } = make({ active: false, freshBoot: true });
    const withoutRole = mgr as unknown as {
      resolveBoekwachter: (projectId: string) => Promise<GezelDetail | null>;
    };
    withoutRole.resolveBoekwachter = async () => null;

    const { started } = mgr.drainEmbedOnly('p1');
    expect(started).toBe(true);
    await vi.waitFor(() => expect(embedOnly).toHaveBeenCalledWith('p1', expect.any(Number)));
    await vi.waitFor(() => expect(embedImages).toHaveBeenCalled());
    expect(enrich).not.toHaveBeenCalled();
  });

  it('drainEmbedOnly yields to a live chat turn instead of competing with it', async () => {
    const { mgr, embedOnly } = make({ active: true });
    const { started } = mgr.drainEmbedOnly('p1');
    expect(started).toBe(true);
    // The drain checks chat before the first batch — nothing runs mid-turn.
    await new Promise((r) => setTimeout(r, 20));
    expect(embedOnly).not.toHaveBeenCalled();
  });

  it('drainEmbedOnly is single-flight and defers to a running drive', async () => {
    const { mgr, embedOnly } = make({ active: false });
    let release: () => void = () => {};
    embedOnly.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r({ files: 0, embedded: 0 });
        }),
    );
    const first = mgr.drainEmbedOnly('p1');
    expect(first.started).toBe(true);
    const second = mgr.drainEmbedOnly('p1');
    expect(second).toMatchObject({ started: false, alreadyRunning: true });
    release();
  });

  it('GEZEL_DISABLE_IMAGE_EMBEDDINGS skips the image-embed tier without touching text', async () => {
    process.env.GEZEL_DISABLE_IMAGE_EMBEDDINGS = '1';
    try {
      const { mgr, embedOnly, embedImages } = make({ active: false });
      await mgr.tick();
      expect(embedImages).not.toHaveBeenCalled();
      expect(embedOnly).toHaveBeenCalled();
    } finally {
      delete process.env.GEZEL_DISABLE_IMAGE_EMBEDDINGS;
    }
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

  it('stop stands down an in-flight background tick and refuses new enrichment work', async () => {
    const { mgr, enrich } = make({ active: false });
    (mgr as unknown as { isNightShiftActive: () => boolean }).isNightShiftActive = () => true;
    let release!: (value: { files: number; summarized: number; embedded: number }) => void;
    enrich.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    (
      mgr as unknown as {
        launchBackgroundTick(kind: 'startup' | 'periodic'): void;
      }
    ).launchBackgroundTick('periodic');
    await vi.waitFor(() => expect(enrich).toHaveBeenCalledOnce());

    const stopping = mgr.stop();
    release({ files: 1, summarized: 1, embedded: 1 });
    await stopping;

    // Night mode would immediately request another batch without the stop
    // latch. Once stopped, every public producer stays shut as well.
    expect(enrich).toHaveBeenCalledOnce();
    await mgr.tick();
    expect(enrich).toHaveBeenCalledOnce();
    expect(mgr.drive('p1', { intensity: 'full' })).toEqual({
      started: false,
      alreadyRunning: false,
    });
    expect(mgr.drainEmbedOnly('p1')).toEqual({ started: false, alreadyRunning: false });
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
    const contentIndex = {
      enrich,
      enrichAreas,
      review,
      embedOnly: vi.fn().mockResolvedValue({ files: 0, embedded: 0 }),
      embedImages: vi.fn().mockResolvedValue({ files: 0, embedded: 0, unavailable: false }),
    } as unknown as ContentIndex;
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

describe('AI-shadow tier + review drain event', () => {
  function makeShadowFixture(opts: { withProducers?: boolean; pendingAfter?: number } = {}) {
    const enrich = vi.fn().mockResolvedValue({ files: 0, summarized: 0, embedded: 0 });
    const enrichAreas = vi.fn().mockResolvedValue({ areasUpdated: 0, architectureUpdated: false });
    const review = vi
      .fn()
      .mockResolvedValueOnce({ files: 2, reviewed: 2 })
      .mockResolvedValue({ files: 0, reviewed: 0 });
    const aiShadows = vi.fn().mockResolvedValue({ files: 1, produced: 1, called: 1 });
    const reviewCounts = vi.fn().mockResolvedValue({
      eligible: 2,
      reviewed: 2,
      stale: 0,
      pending: opts.pendingAfter ?? 0,
    });
    const listFileIssues = vi.fn().mockResolvedValue({
      issues: [],
      counts: { total: 3, bySeverity: {}, byCategory: {} },
      truncated: false,
      indexed: true,
      reviewedFiles: 2,
      eligibleFiles: 2,
    });
    const historyLog = vi.fn().mockResolvedValue(undefined);
    const chat = {
      isAnyActive: () => false,
      isProjectActive: () => false,
      oneShotCompletion: vi.fn().mockResolvedValue('ok'),
    } as unknown as ChatManager;
    const store = {
      listProjects: async () => [{ id: 'p1' }],
      readConfig: async () => ({ defaultModel: { mlx: 'enricher' } }),
      listIndexRubrics: async () => ({}),
    } as unknown as Store;
    const contentIndex = {
      enrich,
      enrichAreas,
      review,
      aiShadows,
      reviewCounts,
      listFileIssues,
      embedOnly: vi.fn().mockResolvedValue({ files: 0, embedded: 0 }),
      embedImages: vi.fn().mockResolvedValue({ files: 0, embedded: 0, unavailable: false }),
    } as unknown as ContentIndex;
    const mgr = new IndexEnrichmentManager({
      store,
      chat,
      contentIndex,
      idle: agedIdleState(),
      resolveBoekwachter: async () => BOOK,
      history: { log: historyLog },
      ...(opts.withProducers
        ? { shadowProducers: { describeImage: async () => ({ body: 'x' }) } }
        : {}),
    });
    return { mgr, aiShadows, review, historyLog };
  }

  it('runs the shadow tier before enrichment when producers are wired', async () => {
    const { mgr, aiShadows } = makeShadowFixture({ withProducers: true });
    await mgr.tick();
    expect(aiShadows).toHaveBeenCalledTimes(1);
    const deps = aiShadows.mock.calls[0]![1] as { describeImage?: unknown; provenance?: unknown };
    expect(deps.describeImage).toBeDefined();
    expect(deps.provenance).toMatchObject({ provider: 'mlx', gezelName: 'Noor' });
  });

  it('skips the shadow tier entirely without producers', async () => {
    const { mgr, aiShadows } = makeShadowFixture({ withProducers: false });
    await mgr.tick();
    expect(aiShadows).not.toHaveBeenCalled();
  });

  it('logs project.index.reviewed once on the drain transition', async () => {
    const { mgr, historyLog } = makeShadowFixture();
    await mgr.tick();
    expect(historyLog).toHaveBeenCalledTimes(1);
    expect(historyLog).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'project.index.reviewed',
        projectId: 'p1',
        gezelId: 'noor',
        details: expect.objectContaining({ files: 2, issues: 3 }),
      }),
    );
    // A later tick that stores nothing must not re-emit.
    await mgr.tick();
    expect(historyLog).toHaveBeenCalledTimes(1);
  });

  it('does not log while reviews are still pending', async () => {
    const { mgr, historyLog } = makeShadowFixture({ pendingAfter: 4 });
    await mgr.tick();
    expect(historyLog).not.toHaveBeenCalled();
  });
});

describe('on-demand drives + night catch-up', () => {
  function makeDriveFixture(
    opts: { projects?: Array<{ id: string; indexingEnabled?: boolean }> } = {},
  ) {
    const calls: string[] = [];
    const refreshStatic = vi.fn(async (_id: string) => {
      calls.push('static');
    });
    const oneShotCompletion = vi.fn().mockResolvedValue('a summary');
    // First enrich batch invokes the summarizer once so the test can observe
    // the ambient flag the drive built its deps with, then drains.
    const enrich = vi
      .fn()
      .mockImplementationOnce(async (_id: string, deps: EnrichDeps) => {
        calls.push('enrich');
        await deps.summarize('probe');
        return { files: 1, summarized: 1, embedded: 1 };
      })
      .mockImplementation(async () => {
        calls.push('enrich');
        return { files: 0, summarized: 0, embedded: 0 };
      });
    const enrichAreas = vi.fn(async () => {
      calls.push('areas');
      return { areasUpdated: 1, architectureUpdated: false };
    });
    const review = vi
      .fn()
      .mockImplementationOnce(async () => {
        calls.push('review');
        return { files: 2, reviewed: 2 };
      })
      .mockImplementation(async () => {
        calls.push('review');
        return { files: 0, reviewed: 0 };
      });
    const aiShadows = vi.fn(async () => {
      calls.push('shadow');
      return { files: 0, produced: 0, called: 0 };
    });
    const reviewCounts = vi.fn(async () => ({ eligible: 2, reviewed: 2, stale: 0, pending: 0 }));
    const listFileIssues = vi.fn(async () => ({
      issues: [],
      counts: { total: 0, bySeverity: {}, byCategory: {} },
      truncated: false,
      indexed: true,
      reviewedFiles: 2,
      eligibleFiles: 2,
    }));
    const chat = {
      isAnyActive: () => false,
      isProjectActive: () => false,
      oneShotCompletion,
      oneShotQueueWidth: vi.fn(() => 4),
    } as unknown as ChatManager;
    const store = {
      listProjects: async () => opts.projects ?? [{ id: 'p1' }],
      projectIndexingEnabled: async (id: string) =>
        (opts.projects ?? [{ id: 'p1' }]).find((p) => p.id === id)?.indexingEnabled !== false,
      readConfig: async () => ({ defaultModel: { mlx: 'enricher' } }),
      listIndexRubrics: async () => ({}),
    } as unknown as Store;
    const contentIndex = {
      enrich,
      enrichAreas,
      review,
      aiShadows,
      reviewCounts,
      listFileIssues,
      embedOnly: vi.fn().mockResolvedValue({ files: 0, embedded: 0 }),
      embedImages: vi.fn().mockResolvedValue({ files: 0, embedded: 0, unavailable: false }),
    } as unknown as ContentIndex;
    const mgr = new IndexEnrichmentManager({
      store,
      chat,
      contentIndex,
      idle: agedIdleState(),
      resolveBoekwachter: async () => BOOK,
      refreshStatic,
      shadowProducers: { describeImage: async () => ({ body: 'x' }) },
    });
    return { mgr, calls, refreshStatic, enrich, review, oneShotCompletion };
  }

  it('full drive: static first, then shadows → enrich → areas → reviews, non-ambient night batches', async () => {
    const { mgr, calls, enrich, review, oneShotCompletion } = makeDriveFixture();
    const started = mgr.drive('p1', { intensity: 'full' });
    expect(started).toEqual({ started: true, alreadyRunning: false });
    expect(mgr.isDriving('p1')).toBe(true);
    await vi.waitFor(() => expect(mgr.isDriving('p1')).toBe(false));

    expect(calls[0]).toBe('static');
    expect(calls.indexOf('shadow')).toBeLessThan(calls.indexOf('enrich'));
    expect(calls.indexOf('enrich')).toBeLessThan(calls.indexOf('areas'));
    expect(calls.indexOf('areas')).toBeLessThan(calls.indexOf('review'));
    // Full-bore fills the target's queue — width-many per-file scans at once.
    expect(enrich).toHaveBeenCalledWith(
      'p1',
      expect.anything(),
      25,
      expect.objectContaining({ concurrency: expect.any(Function) }),
    );
    const enrichOpts = enrich.mock.calls[0]?.[3] as { concurrency: () => number };
    expect(enrichOpts.concurrency()).toBe(4);
    expect(review).toHaveBeenCalledWith(
      'p1',
      expect.anything(),
      25,
      expect.anything(),
      expect.objectContaining({ concurrency: expect.any(Function) }),
    );
    // Full-bore competes like interactive work — no ambient hold.
    const opts = oneShotCompletion.mock.calls[0]?.[2] as { ambient?: boolean };
    expect(opts.ambient).toBeUndefined();
  });

  it('background drive stays ambient with day batches', async () => {
    const { mgr, enrich, oneShotCompletion } = makeDriveFixture();
    mgr.drive('p1', { intensity: 'background' });
    await vi.waitFor(() => expect(mgr.isDriving()).toBe(false));
    // Background stays serial — no concurrency opt is passed.
    expect(enrich).toHaveBeenCalledWith('p1', expect.anything(), 5, undefined);
    const opts = oneShotCompletion.mock.calls[0]?.[2] as { ambient?: boolean };
    expect(opts.ambient).toBe(true);
  });

  it('a second drive request joins the running one', async () => {
    const { mgr } = makeDriveFixture();
    expect(mgr.drive('p1', { intensity: 'full' }).started).toBe(true);
    expect(mgr.drive('p1', { intensity: 'full' })).toEqual({
      started: false,
      alreadyRunning: true,
    });
    await vi.waitFor(() => expect(mgr.isDriving()).toBe(false));
  });

  it('driveMode reports the running mode and clears when the drive ends', async () => {
    const { mgr } = makeDriveFixture();
    expect(mgr.driveMode('p1')).toBeNull();
    mgr.drive('p1', { intensity: 'full' });
    expect(mgr.driveMode('p1')).toBe('full');
    expect(mgr.driveMode('other')).toBeNull();
    await vi.waitFor(() => expect(mgr.isDriving()).toBe(false));
    expect(mgr.driveMode('p1')).toBeNull();
  });

  it('stopDrive halts a running drive at the next batch boundary and clears with the drive', async () => {
    const { mgr, calls, enrich } = makeDriveFixture();
    enrich.mockReset().mockImplementation(async () => {
      calls.push('enrich');
      mgr.stopDrive('p1');
      return { files: 1, summarized: 1, embedded: 1 };
    });
    // No drive running yet — nothing to stop.
    expect(mgr.stopDrive('p1')).toBe(false);
    mgr.drive('p1', { intensity: 'full' });
    await vi.waitFor(() => expect(mgr.isDriving()).toBe(false));
    // The stop landed between batches: one enrich call, then the loop halted
    // before the deep passes.
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain('areas');
    expect(calls).not.toContain('review');
    expect(mgr.driveMode('p1')).toBeNull();
    // The stop request died with the drive — a new drive runs again.
    mgr.drive('p1', { intensity: 'full' });
    await vi.waitFor(() => expect(mgr.isDriving()).toBe(false));
    expect(enrich).toHaveBeenCalledTimes(2);
  });

  it('the background loop stands down while a drive runs', async () => {
    const { mgr, enrich } = makeDriveFixture();
    mgr.drive('p1', { intensity: 'full' });
    await mgr.tick();
    await vi.waitFor(() => expect(mgr.isDriving()).toBe(false));
    // Every enrich call came from the drive ('p1', deps, 25) — none from the
    // tick's day-batch path ('p1', deps, 5).
    expect(enrich.mock.calls.every((c) => c[2] === 25)).toBe(true);
  });

  it('catchUpAll raises the dispatch gate synchronously and sweeps projects in order', async () => {
    const { mgr, calls, refreshStatic } = makeDriveFixture({
      projects: [{ id: 'a' }, { id: 'b', indexingEnabled: false }, { id: 'c' }],
    });
    const run = mgr.catchUpAll();
    expect(mgr.isCatchUpActive()).toBe(true);
    await run;
    expect(mgr.isCatchUpActive()).toBe(false);
    // b opted out of indexing entirely; a and c each got a static-first drive.
    expect(refreshStatic.mock.calls.map((c) => c[0])).toEqual(['a', 'c']);
    expect(calls.filter((c) => c === 'static')).toHaveLength(2);
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
        tuningProfileId: 'instruct',
      }),
    );
    // Deadlines are sized per call now (enrich-budget.ts); the historical
    // flat wall is the floor, never the value.
    expect(oneShotCompletion.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(120_000);
  });

  it('runs one-shots as the project Boekwachter persona', async () => {
    delete process.env.GEZEL_ENRICH_MODEL;
    delete process.env.GEZEL_ENRICH_PROVIDER;
    const { chat, store, oneShotCompletion } = makeDepsFixture();
    const deps = await buildEnrichDeps(store, chat, { boekwachter: BOOK, projectId: 'p1' });
    await deps.summarize('p', 'Indexing src/app.ts');
    expect(oneShotCompletion).toHaveBeenCalledWith(
      'p',
      expect.any(Number),
      expect.objectContaining({
        gezelId: 'noor',
        useGezelPersona: true,
        actorLabel: 'Noor',
        projectId: 'p1',
        jobLabel: 'Indexing src/app.ts',
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
    await deps.summarize('p');
    await deps.review!('p');
    expect(oneShotCompletion).toHaveBeenLastCalledWith(
      'p',
      expect.any(Number),
      expect.objectContaining({
        providerName: 'mlx',
        model: 'big-executor',
        actorLabel: 'Boekwachter',
        jobLabel: 'index review',
        tuningProfileId: 'instruct',
      }),
    );
    // Same prompt, same model — a review still outranks a summary because it
    // emits materially more output tokens.
    const [summarizeMs, reviewMs] = oneShotCompletion.mock.calls.map((c) => c[1] as number);
    expect(reviewMs).toBeGreaterThan(summarizeMs!);
    expect(reviewMs).toBeGreaterThanOrEqual(180_000);
  });

  it('omits the review completion when no local model is configured', async () => {
    delete process.env.GEZEL_ENRICH_MODEL;
    const chat = { oneShotCompletion: vi.fn() } as unknown as ChatManager;
    const store = { readConfig: async () => ({}) } as unknown as Store;
    const deps = await buildEnrichDeps(store, chat);
    expect(deps.model).toBeUndefined();
    expect(deps.review).toBeUndefined();
    expect(deps.provenance).toBeUndefined();
  });

  it('provenance reflects the ACTUAL resolved target and boekwachter identity', async () => {
    process.env.GEZEL_ENRICH_MODEL = 'small-enricher';
    process.env.GEZEL_ENRICH_PROVIDER = 'llama-cpp';
    const { chat, store } = makeDepsFixture();
    const deps = await buildEnrichDeps(store, chat, { boekwachter: BOOK });
    expect(deps.provenance).toMatchObject({
      provider: 'llama-cpp',
      gezelId: 'noor',
      gezelName: 'Noor',
    });
    expect(typeof deps.provenance?.appVersion).toBe('string');
  });

  it('provenance carries the Night Shift override target when active', async () => {
    delete process.env.GEZEL_ENRICH_MODEL;
    delete process.env.GEZEL_ENRICH_PROVIDER;
    const chat = { oneShotCompletion: vi.fn() } as unknown as ChatManager;
    const store = {
      readConfig: async () => ({
        defaultModel: { mlx: 'day-model' },
        nightShift: {
          modelOverride: { enabled: true, provider: 'openai', model: 'slow-night-model' },
        },
      }),
    } as unknown as Store;
    const deps = await buildEnrichDeps(store, chat, { nightShift: true });
    expect(deps.provenance?.provider).toBe('openai');
  });

  it('attributes a cloud-policy fallback to the local provider and model that answered', async () => {
    delete process.env.GEZEL_ENRICH_MODEL;
    delete process.env.GEZEL_ENRICH_PROVIDER;
    const oneShotCompletion = vi.fn(
      async (_prompt: string, _timeoutMs: number, completionOpts: { providerName: string }) => {
        if (completionOpts.providerName === 'openai') throw new Error('Request blocked.');
        return 'local review';
      },
    );
    const chat = { oneShotCompletion } as unknown as ChatManager;
    const store = {
      readConfig: async () => ({
        defaultModel: { mlx: 'local-fallback-model' },
        nightShift: {
          modelOverride: { enabled: true, provider: 'openai', model: 'cloud-primary-model' },
        },
      }),
    } as unknown as Store;

    const deps = await buildEnrichDeps(store, chat, { nightShift: true, boekwachter: BOOK });
    const completion = await deps.review!('policy-triggering content');

    expect(deps.model).toBe('cloud-primary-model');
    expect(deps.provenance?.provider).toBe('openai');
    expect(completion).toMatchObject({
      text: 'local review',
      model: 'local-fallback-model',
      provenance: { provider: 'mlx', gezelId: 'noor', gezelName: 'Noor' },
    });
    expect(oneShotCompletion).toHaveBeenCalledTimes(2);
  });
});

/**
 * The 2026-08-21 incident: night shift went OFF at 06:00 and the catch-up
 * sweep it had kicked at 05:34 was still walking the biggest project at
 * 06:40, dispatching one-shots to the night model the whole way. Queued
 * night TASKS stop themselves (the runner re-reads `isActive()` at
 * admission); a loop the activation callback started cannot.
 */
describe('night-shift stand-down', () => {
  function makeSweepFixture(
    opts: {
      projects?: Array<{ id: string }>;
      batchesPerProject?: number;
      night?: () => boolean;
    } = {},
  ) {
    const batches = opts.batchesPerProject ?? 1;
    const seen: Array<{ projectId: string; model: string | undefined }> = [];
    const perProject = new Map<string, number>();
    const oneShotCompletion = vi.fn().mockResolvedValue('a summary');
    const enrich = vi.fn(async (id: string, deps: EnrichDeps) => {
      const n = (perProject.get(id) ?? 0) + 1;
      perProject.set(id, n);
      await deps.summarize('probe');
      seen.push({ projectId: id, model: deps.model });
      return n >= batches
        ? { files: 0, summarized: 0, embedded: 0 }
        : { files: 1, summarized: 1, embedded: 1 };
    });
    const refreshStatic = vi.fn(async (_id: string) => {});
    const chat = {
      isAnyActive: () => false,
      isProjectActive: () => false,
      oneShotCompletion,
      oneShotQueueWidth: vi.fn(() => 4),
    } as unknown as ChatManager;
    const store = {
      listProjects: async () => opts.projects ?? [{ id: 'p1' }],
      projectIndexingEnabled: async () => true,
      readConfig: async () => ({
        defaultModel: { mlx: 'day-enricher' },
        nightShift: { modelOverride: { enabled: true, provider: 'mlx', model: 'night-enricher' } },
      }),
      listIndexRubrics: async () => ({}),
    } as unknown as Store;
    const contentIndex = {
      enrich,
      enrichAreas: vi.fn(async () => ({ areasUpdated: 0, architectureUpdated: false })),
      review: vi.fn(async () => ({ files: 0, reviewed: 0 })),
      aiShadows: vi.fn(async () => ({ files: 0, produced: 0, called: 0 })),
      reviewCounts: vi.fn(async () => ({ eligible: 0, reviewed: 0, stale: 0, pending: 0 })),
      listFileIssues: vi.fn(async () => ({
        issues: [],
        counts: { total: 0, bySeverity: {}, byCategory: {} },
        truncated: false,
        indexed: true,
        reviewedFiles: 0,
        eligibleFiles: 0,
      })),
      embedOnly: vi.fn().mockResolvedValue({ files: 0, embedded: 0 }),
      embedImages: vi.fn().mockResolvedValue({ files: 0, embedded: 0, unavailable: false }),
    } as unknown as ContentIndex;
    const mgr = new IndexEnrichmentManager({
      store,
      chat,
      contentIndex,
      idle: agedIdleState(),
      resolveBoekwachter: async () => BOOK,
      refreshStatic,
      isNightShiftActive: opts.night ?? (() => true),
    });
    return { mgr, enrich, refreshStatic, seen };
  }

  it('cancelCatchUp stops the sweep before the next project', async () => {
    const { mgr, refreshStatic, enrich } = makeSweepFixture({
      projects: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    });
    enrich.mockImplementationOnce(async (_id: string, _deps: EnrichDeps) => {
      mgr.cancelCatchUp();
      return { files: 0, summarized: 0, embedded: 0 };
    });
    await mgr.catchUpAll();
    expect(refreshStatic.mock.calls.map((c) => c[0])).toEqual(['a']);
  });

  it('cancelCatchUp stops the running project between batches', async () => {
    const { mgr, enrich } = makeSweepFixture({ batchesPerProject: 10 });
    let batch = 0;
    enrich.mockImplementation(async () => {
      batch++;
      if (batch === 2) mgr.cancelCatchUp();
      return { files: 1, summarized: 1, embedded: 1 };
    });
    await mgr.catchUpAll();
    // Batch 3 is where the stand-down lands; nothing after it runs.
    expect(enrich).toHaveBeenCalledTimes(2);
  });

  it('a cancel cannot leak onto a sweep started afterwards', async () => {
    const { mgr, refreshStatic } = makeSweepFixture({ projects: [{ id: 'a' }, { id: 'b' }] });
    mgr.cancelCatchUp(); // no sweep running — must be inert
    await mgr.catchUpAll();
    expect(refreshStatic.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('a drive retargets off the night model when the window closes mid-project', async () => {
    let night = true;
    const { mgr, enrich, seen } = makeSweepFixture({
      batchesPerProject: 3,
      night: () => night,
    });
    enrich.mockImplementation(async (id: string, deps: EnrichDeps) => {
      seen.push({ projectId: id, model: deps.model });
      if (seen.length === 1) night = false;
      return seen.length >= 3
        ? { files: 0, summarized: 0, embedded: 0 }
        : { files: 1, summarized: 1, embedded: 1 };
    });
    mgr.drive('p1', { intensity: 'full' });
    await vi.waitFor(() => expect(mgr.isDriving('p1')).toBe(false));
    expect(seen.map((s) => s.model)).toEqual(['night-enricher', 'day-enricher', 'day-enricher']);
  });

  it('cancelCatchUp leaves an on-demand drive alone — the user asked for it', async () => {
    const { mgr, enrich } = makeSweepFixture({ batchesPerProject: 3 });
    let batch = 0;
    enrich.mockImplementation(async () => {
      batch++;
      if (batch === 1) mgr.cancelCatchUp();
      return batch >= 3
        ? { files: 0, summarized: 0, embedded: 0 }
        : { files: 1, summarized: 1, embedded: 1 };
    });
    mgr.drive('p1', { intensity: 'full' });
    await vi.waitFor(() => expect(mgr.isDriving('p1')).toBe(false));
    expect(enrich).toHaveBeenCalledTimes(3);
  });
});
