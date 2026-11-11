import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BootMaintenanceDeps, startBootMaintenance } from './boot-maintenance.js';

vi.mock('@bendyline/gezel-inference/internal/memory/embeddings', () => ({
  warmEmbeddings: vi.fn(async () => false),
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fakeDeps(isStopping: () => boolean = () => false) {
  const deps = {
    store: {
      refreshStartupHome: vi.fn(async () => {}),
      listProjects: vi.fn(async () => []),
      readTask: vi.fn(async () => null),
      listProjectQuestions: vi.fn(async () => []),
      updateProjectQuestions: vi.fn(async () => {}),
    },
    chat: {
      runIdleSummarizationSweep: vi.fn(async () => {}),
      releaseIdleSessions: vi.fn(async () => []),
    },
    chatEvents: { publishProjectEvent: vi.fn() },
    projectTypeUpgrader: { requestSweep: vi.fn() },
    relevance: { bootWarm: vi.fn(async () => {}) },
    mediaSearch: { bootWarm: vi.fn(async () => {}) },
    optionalDownloads: { boot: vi.fn(async () => {}) },
    isStopping,
  };
  return { deps, typed: deps as unknown as BootMaintenanceDeps };
}

describe('boot maintenance', () => {
  it('runs the deferred boot work and the idle timers on schedule', () => {
    const { deps, typed } = fakeDeps();
    startBootMaintenance(typed);
    vi.advanceTimersByTime(2_000);
    expect(deps.projectTypeUpgrader.requestSweep).toHaveBeenCalledWith('startup');
    vi.advanceTimersByTime(18_000);
    expect(deps.relevance.bootWarm).toHaveBeenCalledOnce();
    expect(deps.mediaSearch.bootWarm).toHaveBeenCalledWith({ install: false });
    vi.advanceTimersByTime(40_000);
    expect(deps.store.refreshStartupHome).toHaveBeenCalledOnce();
    expect(deps.chat.runIdleSummarizationSweep).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(4 * 60_000);
    expect(deps.chat.releaseIdleSessions).toHaveBeenCalledOnce();
  });

  it('stop() cancels the deferred work and the idle timers', () => {
    const { deps, typed } = fakeDeps();
    startBootMaintenance(typed).stop();
    vi.advanceTimersByTime(2 * 60 * 60_000);
    expect(deps.projectTypeUpgrader.requestSweep).not.toHaveBeenCalled();
    expect(deps.relevance.bootWarm).not.toHaveBeenCalled();
    expect(deps.store.refreshStartupHome).not.toHaveBeenCalled();
    expect(deps.chat.runIdleSummarizationSweep).not.toHaveBeenCalled();
    expect(deps.chat.releaseIdleSessions).not.toHaveBeenCalled();
  });

  it('skips deferred work that comes due after shutdown has begun', () => {
    let stopping = false;
    const { deps, typed } = fakeDeps(() => stopping);
    startBootMaintenance(typed);
    stopping = true;
    vi.advanceTimersByTime(60_000);
    expect(deps.projectTypeUpgrader.requestSweep).not.toHaveBeenCalled();
    expect(deps.store.refreshStartupHome).not.toHaveBeenCalled();
  });
});
