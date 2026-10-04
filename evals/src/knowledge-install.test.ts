import type { GezelClient } from '@bendyline/gezel-client/node';
import { describe, expect, it, vi } from 'vitest';
import { waitForKnowledgeInstall } from './knowledge-install.ts';
import {
  ScenarioSetupTimeoutError,
  runScenarioSetupWithTimeout,
} from './runner.ts';

function clientWith(
  getKnowledgeJob: () => Promise<{
    id: string;
    startedAt: string;
    finished: boolean;
    error?: string;
    events: Array<{ type: string }>;
  }>,
  cancelKnowledgeJob = vi.fn(async () => ({ cancelled: true })),
): GezelClient {
  return { getKnowledgeJob, cancelKnowledgeJob } as unknown as GezelClient;
}

describe('waitForKnowledgeInstall', () => {
  it('returns only after a successful terminal job snapshot', async () => {
    let polls = 0;
    const client = clientWith(async () => ({
      id: 'job-1',
      startedAt: new Date().toISOString(),
      finished: ++polls >= 2,
      events: [{ type: polls >= 2 ? 'done' : 'progress' }],
    }));

    await expect(
      waitForKnowledgeInstall(client, 'job-1', {
        label: 'test catalog',
        timeoutMs: 100,
        pollIntervalMs: 1,
      }),
    ).resolves.toEqual({ durationMs: expect.any(Number) });
  });

  it('cancels and throws when the install never becomes terminal', async () => {
    const cancel = vi.fn(async () => ({ cancelled: true }));
    const log = vi.fn();
    const client = clientWith(
      async () => ({
        id: 'job-2',
        startedAt: new Date().toISOString(),
        finished: false,
        events: [{ type: 'progress' }],
      }),
      cancel,
    );

    await expect(
      waitForKnowledgeInstall(client, 'job-2', {
        label: 'slow catalog',
        timeoutMs: 12,
        pollIntervalMs: 1,
        progressLogIntervalMs: 2,
        log,
      }),
    ).rejects.toThrow(/slow catalog install timed out.*cancelled/);
    expect(cancel).toHaveBeenCalledWith('job-2');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('install still running'));
  });
});

describe('runScenarioSetupWithTimeout', () => {
  it('rejects a setup hook that exceeds its independent ceiling', async () => {
    await expect(
      runScenarioSetupWithTimeout(() => new Promise(() => {}), 5),
    ).rejects.toBeInstanceOf(ScenarioSetupTimeoutError);
  });
});
