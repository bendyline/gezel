import { describe, expect, it } from 'vitest';
import {
  type RunReadinessClient,
  canOfferRunSetup,
  checkRunReadiness,
  formatRunSetupMessage,
} from './run-readiness.js';

interface FakeState {
  provider?: string;
  pinned?: string;
  installed?: string[];
  llamaServer?: boolean;
  uv?: boolean;
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
        engines: [
          { name: 'llama-server', installed: state.llamaServer ?? false },
          { name: 'uv', installed: state.uv ?? false },
        ],
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

  it('treats a toolkit without uv as a missing engine for MLX, even with the model downloaded', async () => {
    const result = await checkRunReadiness(
      fakeClient({ provider: 'mlx', pinned: 'gemma4-12b-q4', installed: ['gemma4-12b-q4'] }),
      undefined,
      NO_MOCK,
    );
    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.message).toContain("Gezel's on-device engine isn't installed yet.");
    expect(result.message).toContain('--download');
    expect(result.message).toContain('gezel native install');
  });

  it('is ready for MLX once uv and the model are installed, whatever llama-server says', async () => {
    const result = await checkRunReadiness(
      fakeClient({
        provider: 'mlx',
        pinned: 'gemma4-12b-q4',
        installed: ['gemma4-12b-q4'],
        uv: true,
        llamaServer: false,
      }),
      undefined,
      NO_MOCK,
    );
    expect(result).toEqual({ ready: true });
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

describe('formatRunSetupMessage', () => {
  it('offers a model already downloaded before pulling the pinned one', () => {
    const message = formatRunSetupMessage({
      provider: 'mlx',
      engineMissing: false,
      pinned: 'qwen3.8-27b-q4',
      installedIds: ['qwen3.5-0.8b-q4'],
      platformDefault: 'mlx',
    });
    expect(message).toContain('gezel model use qwen3.5-0.8b-q4');
    expect(message).toContain('gezel model pull qwen3.8-27b-q4');
  });

  it('sends a person with no model to the catalog listing', () => {
    const message = formatRunSetupMessage({
      provider: 'llama-cpp',
      engineMissing: true,
      pinned: undefined,
      installedIds: [],
      platformDefault: 'mlx',
    });
    expect(message).toContain('gezel model list --available --provider llama-cpp');
    expect(message).toContain('gezel model pull <id> --provider llama-cpp');
  });
});

describe('canOfferRunSetup', () => {
  const tty = { isTTY: true };
  const pipe = {};

  it('offers the setup screens to a person at a terminal', () => {
    expect(canOfferRunSetup({ stdin: tty, stderr: tty }, {})).toBe(true);
  });

  it('keeps the message when the prompt is piped in, since the choices need the keyboard', () => {
    expect(canOfferRunSetup({ stdin: pipe, stderr: tty }, {})).toBe(false);
  });

  it('keeps the message when stderr is captured, since the screens have nowhere to draw', () => {
    expect(canOfferRunSetup({ stdin: tty, stderr: pipe }, {})).toBe(false);
  });

  it('never offers setup under CI, even with a pseudo-terminal', () => {
    expect(canOfferRunSetup({ stdin: tty, stderr: tty }, { CI: 'true' })).toBe(false);
  });
});
