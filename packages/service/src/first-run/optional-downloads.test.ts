import type { GezelConfig } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { OptionalDownloads } from './optional-downloads.js';

function harness(initial: Partial<GezelConfig>, held = true) {
  let config = { ...initial } as GezelConfig;
  const startShared = vi.fn(async () => {});
  const startDeferred = vi.fn(async () => {});
  const downloads = new OptionalDownloads({
    readConfig: async () => config,
    writeConfig: async (patch) => {
      config = { ...config, ...patch };
    },
    firstUseHeld: async () => held,
    startShared,
    startDeferred,
  });
  return { downloads, startShared, startDeferred, config: () => config };
}

describe('OptionalDownloads', () => {
  it('holds a new install until its first project finishes, then starts both once', async () => {
    const h = harness({ firstUseAt: '2026-10-12T10:00:00.000Z' });
    await h.downloads.boot();
    expect(h.startShared).not.toHaveBeenCalled();

    await h.downloads.firstProjectDone();
    expect(h.startShared).toHaveBeenCalledTimes(1);
    expect(h.startDeferred).toHaveBeenCalledTimes(1);
    expect(h.config().onboarding?.firstProjectDoneAt).toBeTruthy();
    expect(h.config().onboarding?.optionalDownloadsAt).toBeTruthy();

    await h.downloads.firstProjectDone();
    expect(h.startShared).toHaveBeenCalledTimes(1);
    h.downloads.stop();
  });

  it('starts an established install at boot without the deferred image reader', async () => {
    const h = harness({}, true);
    await h.downloads.boot();
    expect(h.startShared).toHaveBeenCalledTimes(1);
    expect(h.startDeferred).not.toHaveBeenCalled();
  });

  it('never pulls the deferred image reader twice for one install', async () => {
    const h = harness({
      firstUseAt: '2026-10-12T10:00:00.000Z',
      onboarding: {
        firstProjectDoneAt: '2026-10-12T10:20:00.000Z',
        optionalDownloadsAt: '2026-10-12T10:20:01.000Z',
      },
    });
    await h.downloads.boot();
    expect(h.startShared).toHaveBeenCalledTimes(1);
    expect(h.startDeferred).not.toHaveBeenCalled();
  });

  it('releases once the first-use hold does, with no project finished', async () => {
    const h = harness({ firstUseAt: '2026-10-12T10:00:00.000Z' }, false);
    await h.downloads.boot();
    expect(h.startShared).toHaveBeenCalledTimes(1);
    expect(h.startDeferred).toHaveBeenCalledTimes(1);
  });
});
