import { describe, expect, it } from 'vitest';
import type { TurnStatsEvent } from '../providers/streaming-session.js';
import type { ExternalToolCall, LLMProvider, LLMSession } from '../providers/types.js';
import { type FitnessProbeDeps, runFitnessProbe } from './probe.js';

/**
 * One scripted probe turn. `hang` never settles (drives the hard-cap
 * path); `fail` rejects; otherwise resolves `text` after firing the
 * scripted turn stats.
 */
interface ScriptedTurn {
  text?: string;
  tokensPerSec?: number;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  ttftMs?: number;
  promptTokensPerSec?: number;
  cachedPromptTokens?: number;
  reasoning?: string;
  calls?: ExternalToolCall[];
  fail?: string;
  hang?: boolean;
}

class FakeSession {
  disconnected = false;
  prompts: string[] = [];
  private turnIdx = 0;
  private lastTurn: ScriptedTurn | undefined;
  private statsHandlers: Array<(ev: TurnStatsEvent) => void> = [];

  constructor(private readonly turns: ScriptedTurn[]) {}

  onTurnStats(handler: (ev: TurnStatsEvent) => void): () => void {
    this.statsHandlers.push(handler);
    return () => {};
  }

  async sendAndWait(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const turn = this.turns[this.turnIdx++];
    if (!turn) throw new Error('unscripted turn');
    this.lastTurn = turn;
    if (turn.hang) return new Promise<string>(() => {});
    if (turn.fail) throw new Error(turn.fail);
    if (turn.tokensPerSec != null) {
      for (const h of this.statsHandlers) {
        h({
          provider: 'llama-cpp',
          promptTokens: turn.promptTokens ?? 100,
          completionTokens: turn.completionTokens ?? 100,
          durationMs: turn.durationMs ?? 1_000,
          tokensPerSec: turn.tokensPerSec,
          ...(turn.ttftMs !== undefined ? { ttftMs: turn.ttftMs } : {}),
          ...(turn.promptTokensPerSec !== undefined
            ? { promptTokensPerSec: turn.promptTokensPerSec }
            : {}),
          ...(turn.cachedPromptTokens !== undefined
            ? { cachedPromptTokens: turn.cachedPromptTokens }
            : {}),
        });
      }
    }
    return turn.text ?? '';
  }

  capturedToolCalls(): ExternalToolCall[] {
    return this.lastTurn?.calls ?? [];
  }

  getLastTurnReasoning(): string | undefined {
    return this.lastTurn?.reasoning;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

function fakeProvider(session: FakeSession): LLMProvider {
  return {
    name: 'llama-cpp',
    async initialize() {},
    async shutdown() {},
    async createSession() {
      return session as unknown as LLMSession;
    },
    async listModels() {
      return [];
    },
  } as unknown as LLMProvider;
}

function deps(overrides: Partial<FitnessProbeDeps> = {}): FitnessProbeDeps {
  return {
    getProviderForModel: async () => {
      throw new Error('getProviderForModel not scripted');
    },
    resolveInstalled: async () => ({
      sha256: 'abc123',
      catalogVersion: '1.2.0',
      contextWindow: 32_768,
    }),
    resolveReasoningBudget: async () => 6144,
    detectMemory: async () => ({
      totalRamBytes: 128 * 1024 ** 3,
      gpuVramBytes: null,
      source: 'test',
    }),
    configuredNumCtx: async () => undefined,
    env: { GEZEL_FITNESS_REPRESENTATIVE_TOKENS: '0' },
    ...overrides,
  };
}

const VALID_CALL: ExternalToolCall = {
  id: 'call_1',
  name: 'write_file',
  arguments: '{"path":"proeve.txt","content":"PROEVE OK"}',
};

describe('runFitnessProbe', () => {
  it('happy path: two turns, admitted record with measured t/s and staleness keys', async () => {
    const session = new FakeSession([
      { text: 'a story about a carpenter', tokensPerSec: 25.2 },
      { calls: [VALID_CALL] },
    ]);
    const record = await runFitnessProbe(
      deps({ getProviderForModel: async () => fakeProvider(session) }),
      { provider: 'llama-cpp', modelId: 'gemma4-e4b-q4', trigger: 'manual' },
    );
    expect(record.status).toBe('probed');
    expect(record.admitted).toBe(true);
    expect(record.genTokensPerSec).toBeCloseTo(25.2);
    expect(record.sha256).toBe('abc123');
    expect(record.catalogVersion).toBe('1.2.0');
    expect(record.contextWindow).toBe(32_768);
    expect(record.trigger).toBe('manual');
    for (const check of Object.values(record.checks)) expect(check.ok).toBe(true);
    expect(session.disconnected).toBe(true);
  });

  it('records warm short-prompt speed plus practical 20K-context TTFT, prefill, and decode', async () => {
    const session = new FakeSession([
      {
        text: 'short story',
        tokensPerSec: 130,
        promptTokens: 349,
        completionTokens: 180,
        durationMs: 2_000,
        ttftMs: 400,
      },
      {
        text: 'representative story',
        tokensPerSec: 25,
        promptTokens: 19_804,
        completionTokens: 160,
        durationMs: 37_000,
        ttftMs: 31_000,
        promptTokensPerSec: 635,
        cachedPromptTokens: 420,
      },
      { calls: [VALID_CALL] },
    ]);
    const record = await runFitnessProbe(
      deps({
        getProviderForModel: async () => fakeProvider(session),
        env: { GEZEL_FITNESS_REPRESENTATIVE_TOKENS: '64' },
      }),
      { provider: 'llama-cpp', modelId: 'qwen3.6-27b-q4', trigger: 'manual' },
    );

    expect(record.genTokensPerSec).toBe(25);
    expect(record.shortPromptGenTokensPerSec).toBe(130);
    expect(record.representativeContext).toEqual({
      targetPromptTokens: 64,
      promptTokens: 19_804,
      cachedPromptTokens: 420,
      completionTokens: 160,
      durationMs: 37_000,
      ttftMs: 31_000,
      promptTokensPerSec: 635,
      genTokensPerSec: 25,
    });
    expect(session.prompts).toHaveLength(3);
    expect(session.prompts[1]).toContain('neutral workshop ledger');
    expect(record.checks.throughput.detail).toContain('25.0 t/s');
  });

  // Regression: native engines start lazily on the FIRST TURN, not in
  // createSession, so a launch failure arrives as a turn rejection. Filed
  // under `throughput` it left `spawn` reading "engine spawned and served
  // the probe session" — which is what the badge shows as the failure
  // reason. Every packaged machine-service install reported an engine that
  // had never started as a healthy spawn.
  it('lazy engine-launch failure lands on spawn, not the turn that surfaced it', async () => {
    const session = new FakeSession([
      {
        fail:
          '[llama-server] could not launch gezel-llama-server.exe (EPERM). ' +
          'Executable: C:\\native-bin\\win32-x64-cuda\\gezel-llama-server.exe. spawn EPERM',
      },
    ]);
    const record = await runFitnessProbe(
      deps({ getProviderForModel: async () => fakeProvider(session) }),
      { provider: 'llama-cpp', modelId: 'gemma4-e4b-q4', trigger: 'install' },
    );
    expect(record.status).toBe('failed');
    expect(record.checks.spawn.ok).toBe(false);
    expect(record.checks.spawn.detail).toContain('could not launch');
    expect(record.checks.throughput.detail).toBe('not reached — an earlier probe stage failed');
  });

  it('spawn throw (capacity denial) → status failed with the denial in spawn.detail', async () => {
    const record = await runFitnessProbe(
      deps({
        getProviderForModel: async () => {
          throw new Error('Not enough memory to run gemma4-31b: it needs about 25 GB');
        },
      }),
      { provider: 'llama-cpp', modelId: 'gemma4-31b-q4', trigger: 'install' },
    );
    expect(record.status).toBe('failed');
    expect(record.admitted).toBe(false);
    expect(record.checks.spawn.ok).toBe(false);
    expect(record.checks.spawn.detail).toContain('Not enough memory');
  });

  it('engine-busy contention (typed code) → status blocked, not failed', async () => {
    const busy = Object.assign(
      new Error('engine llama-cpp:gemma4-12b-q4:0 is busy serving requests — not evicting'),
      { code: 'engine-busy' },
    );
    const record = await runFitnessProbe(
      deps({
        getProviderForModel: async () => {
          throw busy;
        },
      }),
      { provider: 'llama-cpp', modelId: 'gemma4-12b-q4', trigger: 'manual' },
    );
    expect(record.status).toBe('blocked');
    expect(record.admitted).toBe(false);
    expect(record.checks.spawn.ok).toBe(false);
  });

  it('engine-busy contention (message fallback) → status blocked', async () => {
    const record = await runFitnessProbe(
      deps({
        getProviderForModel: async () => {
          throw new Error('engine is busy serving requests and did not drain within 30s');
        },
      }),
      { provider: 'llama-cpp', modelId: 'gemma4-12b-q4', trigger: 'manual' },
    );
    expect(record.status).toBe('blocked');
  });

  it('invalid tool args → probed but not admitted (toolRoundTrip fails)', async () => {
    const session = new FakeSession([
      { text: 'story', tokensPerSec: 20 },
      { calls: [{ id: 'c', name: 'write_file', arguments: '{broken proeve' }] },
    ]);
    const record = await runFitnessProbe(
      deps({ getProviderForModel: async () => fakeProvider(session) }),
      { provider: 'llama-cpp', modelId: 'm', trigger: 'manual' },
    );
    expect(record.status).toBe('probed');
    expect(record.admitted).toBe(false);
    expect(record.checks.toolRoundTrip.ok).toBe(false);
    expect(record.checks.throughput.ok).toBe(true);
    expect(session.disconnected).toBe(true);
  });

  it('prose instead of a call → probed, toolRoundTrip fail quoting the prose', async () => {
    const session = new FakeSession([
      { text: 'story', tokensPerSec: 20 },
      { text: 'I am unable to create files.' },
    ]);
    const record = await runFitnessProbe(
      deps({ getProviderForModel: async () => fakeProvider(session) }),
      { provider: 'llama-cpp', modelId: 'm', trigger: 'manual' },
    );
    expect(record.status).toBe('probed');
    expect(record.checks.toolRoundTrip.ok).toBe(false);
    expect(record.checks.toolRoundTrip.detail).toContain('unable to create files');
  });

  it('generation-turn failure → status failed, disconnect still runs', async () => {
    const session = new FakeSession([{ fail: 'timeout waiting for completion' }]);
    const record = await runFitnessProbe(
      deps({ getProviderForModel: async () => fakeProvider(session) }),
      { provider: 'llama-cpp', modelId: 'm', trigger: 'manual' },
    );
    expect(record.status).toBe('failed');
    expect(record.checks.throughput.detail).toMatch(/generation turn failed: timeout/);
    expect(session.disconnected).toBe(true);
  });

  it('hard cap fires on a hung turn → status failed with the cap in the detail', async () => {
    const session = new FakeSession([{ hang: true }]);
    const record = await runFitnessProbe(
      deps({ getProviderForModel: async () => fakeProvider(session) }),
      {
        provider: 'llama-cpp',
        modelId: 'm',
        trigger: 'manual',
        timeouts: { hardCapMs: 40 },
      },
    );
    expect(record.status).toBe('failed');
    expect(record.admitted).toBe(false);
    expect(record.checks.throughput.detail).toMatch(/hard cap/);
  });

  it('observed thinking with no manifest budget fails the reasoningBudget check', async () => {
    const session = new FakeSession([
      { text: 'story', tokensPerSec: 20, reasoning: 'let me think…' },
      { calls: [VALID_CALL] },
    ]);
    const record = await runFitnessProbe(
      deps({
        getProviderForModel: async () => fakeProvider(session),
        resolveReasoningBudget: async () => undefined,
      }),
      { provider: 'llama-cpp', modelId: 'm', trigger: 'manual' },
    );
    expect(record.status).toBe('probed');
    expect(record.admitted).toBe(false);
    expect(record.checks.reasoningBudget.ok).toBe(false);
  });

  it('mlx probes ask for the mlx launch ctx and ignore GEZEL_LLAMA_NUM_CTX', async () => {
    const session = new FakeSession([{ text: 'story', tokensPerSec: 42 }, { calls: [VALID_CALL] }]);
    const asked: string[] = [];
    const record = await runFitnessProbe(
      deps({
        getProviderForModel: async () => fakeProvider(session),
        resolveInstalled: async () =>
          ({ catalogVersion: '2.0.0', contextWindow: 256_000 }) as never,
        configuredNumCtx: async (engine) => {
          asked.push(engine);
          return 40_960;
        },
        // Only the llama.cpp supervisor reads this; MLX never does.
        env: {
          GEZEL_LLAMA_NUM_CTX: '8192',
          GEZEL_FITNESS_REPRESENTATIVE_TOKENS: '0',
        },
      }),
      { provider: 'mlx', modelId: 'gemma4-12b-q4', trigger: 'manual' },
    );
    expect(asked).toEqual(['mlx']);
    expect(record.provider).toBe('mlx');
    expect(record.status).toBe('probed');
    expect(record.admitted).toBe(true);
    expect(record.genTokensPerSec).toBeCloseTo(42);
    expect(record.checks.contextFit.detail).toContain('40,960');
  });

  it('ds4 probes use the ds4 launch ctx and ignore GEZEL_LLAMA_NUM_CTX', async () => {
    const session = new FakeSession([{ text: 'story', tokensPerSec: 42 }, { calls: [VALID_CALL] }]);
    const asked: string[] = [];
    const record = await runFitnessProbe(
      deps({
        getProviderForModel: async () => fakeProvider(session),
        resolveInstalled: async () => ({ catalogVersion: '1.0.0', contextWindow: 65_536 }) as never,
        configuredNumCtx: async (engine) => {
          asked.push(engine);
          return 32_768;
        },
        env: {
          GEZEL_LLAMA_NUM_CTX: '8192',
          GEZEL_FITNESS_REPRESENTATIVE_TOKENS: '0',
        },
      }),
      { provider: 'ds4', modelId: 'glm-5.2-754b-q2', trigger: 'manual' },
    );
    expect(asked).toEqual(['ds4']);
    expect(record.provider).toBe('ds4');
    expect(record.status).toBe('probed');
    expect(record.admitted).toBe(true);
    expect(record.checks.contextFit.detail).toContain('32,768');
  });

  it('context fit uses min(GGUF ctx, launch ctx): small GGUF window fails the floor', async () => {
    const session = new FakeSession([{ text: 'story', tokensPerSec: 20 }, { calls: [VALID_CALL] }]);
    const record = await runFitnessProbe(
      deps({
        getProviderForModel: async () => fakeProvider(session),
        resolveInstalled: async () => ({ contextWindow: 8192, approxSizeBytes: 1 }) as never,
      }),
      { provider: 'llama-cpp', modelId: 'm', trigger: 'manual' },
    );
    expect(record.checks.contextFit.ok).toBe(false);
    expect(record.admitted).toBe(false);
  });
});
