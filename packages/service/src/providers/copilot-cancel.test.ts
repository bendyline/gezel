import { describe, expect, it, vi } from 'vitest';
import { CopilotProvider } from './copilot.js';

/**
 * A Copilot SDK whose `sendAndWait` never settles on its own — the shape
 * that matters here, since the SDK's `timeout` argument documents itself
 * as "does not abort in-flight agent work". Only `abort()` ends it.
 */
function stallingSdk(): {
  mod: Record<string, unknown>;
  aborted: () => number;
  settleSend: () => void;
} {
  let abortCount = 0;
  let resolveSend = (): void => {};
  const sendSettled = new Promise<void>((resolve) => {
    resolveSend = resolve;
  });
  const session = {
    sessionId: 'cancel-test',
    on: () => () => {},
    sendAndWait: async () => {
      await sendSettled;
      return { data: { content: 'too late' } };
    },
    abort: async () => {
      abortCount += 1;
      resolveSend();
    },
    disconnect: async () => {},
  };
  return {
    aborted: () => abortCount,
    settleSend: () => resolveSend(),
    mod: {
      approveAll: () => ({ kind: 'approve-once' }),
      CopilotClient: class {
        async start() {}
        async stop() {}
        async createSession() {
          return session;
        }
        async resumeSession() {
          return session;
        }
        async listModels() {
          return [];
        }
        async getAuthStatus() {
          return { isAuthenticated: true };
        }
      },
    },
  };
}

async function providerWith(mod: Record<string, unknown>): Promise<CopilotProvider> {
  const provider = new CopilotProvider({});
  vi.spyOn(provider as unknown as { loadSdk: () => Promise<unknown> }, 'loadSdk').mockResolvedValue(
    mod,
  );
  return provider;
}

describe('Copilot cancellation', () => {
  it('calls session.abort() and unwinds when the caller aborts mid-send', async () => {
    // Before this, cancel only flagged the turn and the CLI ran the whole
    // response to completion — 16s in the observed case, during which the
    // manager had already freed the slot and started the next turn.
    const sdk = stallingSdk();
    const provider = await providerWith(sdk.mod);
    const session = await provider.createSession({ systemMessage: 'go' });
    const ctrl = new AbortController();

    const pending = session.sendAndWait('hello', {
      queue: { lane: 'interactive', signal: ctrl.signal },
    });
    const settled = vi.fn();
    void pending.then(settled, settled);

    // Still in flight — nothing has resolved it.
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(sdk.aborted()).toBe(0);

    ctrl.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
    expect(sdk.aborted()).toBe(1);

    await provider.shutdown();
  });

  it('aborts immediately when the signal is already fired before the send', async () => {
    const sdk = stallingSdk();
    const provider = await providerWith(sdk.mod);
    const session = await provider.createSession({ systemMessage: 'go' });
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(
      session.sendAndWait('hello', { queue: { lane: 'interactive', signal: ctrl.signal } }),
    ).rejects.toThrow(/aborted/i);

    await provider.shutdown();
  });
});
