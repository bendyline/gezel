import { describe, expect, it } from 'vitest';
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
  reasoning?: string;
  calls?: ExternalToolCall[];
  fail?: string;
  hang?: boolean;
}

class FakeSession {
  disconnected = false;
  private turnIdx = 0;
  private lastTurn: ScriptedTurn | undefined;
  private statsHandlers: Array<(ev: { tokensPerSec?: number }) => void> = [];

  constructor(private readonly turns: ScriptedTurn[]) {}

  onTurnStats(handler: (ev: { tokensPerSec?: number }) => void): () => void {
    this.statsHandlers.push(handler);
    return () => {};
  }

  async sendAndWait(_prompt: string): Promise<string> {
    const turn = this.turns[this.turnIdx++];
    if (!turn) throw new Error('unscripted turn');
    this.lastTurn = turn;
    if (turn.hang) return new Promise<string>(() => {});
    if (turn.fail) throw new Error(turn.fail);
    if (turn.tokensPerSec != null) {
      for (const h of this.statsHandlers) h({ tokensPerSec: turn.tokensPerSec });
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
    env: {},
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
