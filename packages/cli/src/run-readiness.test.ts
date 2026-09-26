import { describe, expect, it } from 'vitest';
import { type RunReadinessClient, checkRunReadiness } from './run-readiness.js';

interface FakeState {
  provider?: string;
  pinned?: string;
  installed?: string[];
  llamaServer?: boolean;
  platformKey?: string | null;
  gezelProvider?: string;
  llamaCppBaseUrl?: string;
}

function fakeClient(state: FakeState): RunReadinessClient {
  const provider = state.provider ?? 'llama-cpp';
  return {
    getConfig: async () =>
      ({
        provider,
        firstRunCompleted: true,
        defaultModel: state.pinned ? { [provider]: state.pinned } : {},
        ...(state.llamaCppBaseUrl ? { llamaCppBaseUrl: state.llamaCppBaseUrl } : {}),
      }) as never,
    getGezel: async () => ({ parsed: { frontmatter: { provider: state.gezelProvider } } }) as never,
    getNativeEngineStatus: async () =>
      ({
        release: '0.1.46',
        pinned: true,
        platformKey: state.platformKey === undefined ? 'win32-x64' : state.platformKey,
        engines: [{ name: 'llama-server', installed: state.llamaServer ?? false }],
      }) as never,
    listLlamaCppModels: async () =>
      ({ models: (state.installed ?? []).map((id) => ({ id })) }) as never,
    listMlxModels: async () => ({ models: (state.installed ?? []).map((id) => ({ id })) }) as never,
  };
}

const NO_MOCK = {};

describe('checkRunReadiness', () => {
  it('stops a fresh machine before any download, with CLI-native next steps', async () => {
    const result = await checkRunReadiness(
      fakeClient({ pinned: 'gemma4-e4b-q4' }),
      'senna',
      NO_MOCK,
    );
    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.message).toContain('gezel native install');
    expect(result.message).toContain('gezel model pull gemma4-e4b-q4');
    expect(result.message).toContain('Nothing was downloaded.');
    expect(result.message).not.toContain('Settings');
  });

  it('is ready when the engine and the pinned model are installed', async () => {
    const result = await checkRunReadiness(
      fakeClient({ pinned: 'gemma4-e4b-q4', installed: ['gemma4-e4b-q4'], llamaServer: true }),
      undefined,
      NO_MOCK,
    );
    expect(result).toEqual({ ready: true });
  });

  it('does not count some other installed model as the pinned one', async () => {
    const result = await checkRunReadiness(
      fakeClient({ pinned: 'gemma4-e4b-q4', installed: ['qwen3.6-27b-q4'], llamaServer: true }),
      undefined,
      NO_MOCK,
    );
    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.message).toContain("gemma4-e4b-q4, isn't downloaded yet");
  });

  it('passes cloud providers straight through', async () => {
    const result = await checkRunReadiness(fakeClient({ provider: 'openai' }), undefined, NO_MOCK);
    expect(result).toEqual({ ready: true });
  });

  it("uses the gezel's own provider over the install default", async () => {
    const result = await checkRunReadiness(
      fakeClient({ provider: 'llama-cpp', gezelProvider: 'anthropic' }),
      'ada',
      NO_MOCK,
    );
    expect(result).toEqual({ ready: true });
  });

  it('trusts an external engine URL', async () => {
    const result = await checkRunReadiness(
      fakeClient({ llamaCppBaseUrl: 'http://127.0.0.1:8080' }),
      undefined,
      NO_MOCK,
    );
    expect(result).toEqual({ ready: true });
  });

  it('stays out of the way in mock-provider mode', async () => {
    const result = await checkRunReadiness(fakeClient({}), undefined, {
      GEZEL_MOCK_PROVIDER: '1',
    });
    expect(result).toEqual({ ready: true });
  });
});
