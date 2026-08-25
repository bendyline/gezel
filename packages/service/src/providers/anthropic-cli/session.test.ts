import { describe, expect, it } from 'vitest';
import { ProviderQueue } from '../queue.js';
import { SessionResumeError } from '../types.js';
import type { ClaudeReasoningEffort } from './reasoning.js';
import { AnthropicCliSession, isResumeFailureSignal } from './session.js';
import type { ClaudeWorkerPool, ClaudeWorkerSpec, PoolSnapshot } from './worker-pool.js';
import type { WorkerTurnHooks } from './worker.js';

/**
 * The session class is a thin façade over `ClaudeWorkerPool` after the
 * worker-pool refactor. End-to-end CLI behavior (stream parsing, multi-turn
 * reuse, crash recovery, resume failure) is covered in worker.test.ts and
 * worker-pool.test.ts. This file's job is just to lock in the façade
 * contract.
 */

interface MockPoolControl {
  pool: ClaudeWorkerPool;
  runTurnCalls: Array<{
    spec: ClaudeWorkerSpec;
    prompt: string;
    sendOpts?: { timeoutMs?: number; signal?: AbortSignal };
  }>;
  evictCalls: string[];
  /** Function used to fulfill the next `runTurn` call. Throws or returns. */
  nextRunTurn: () => Promise<string> | string;
  /** Optional per-session captured upstream id, surfaced via snapshot(). */
  capturedClaudeSessionId?: string;
  /** Hooks handed to the most recent `runTurn`, so tests can drive them. */
  lastHooks?: WorkerTurnHooks;
}

function makeMockPool(): MockPoolControl {
  const ctrl: MockPoolControl = {
    pool: {} as ClaudeWorkerPool,
    runTurnCalls: [],
    evictCalls: [],
    nextRunTurn: () => 'reply',
  };
  const fakePool: Partial<ClaudeWorkerPool> = {
    runTurn: async (spec, prompt, hooks, sendOpts) => {
      ctrl.lastHooks = hooks;
      ctrl.runTurnCalls.push({
        spec,
        prompt,
        sendOpts: sendOpts as { timeoutMs?: number; signal?: AbortSignal } | undefined,
      });
      return ctrl.nextRunTurn();
    },
    evict: async (sessionId) => {
      ctrl.evictCalls.push(sessionId);
    },
    shutdown: async () => {},
    snapshot: (): PoolSnapshot => ({
      size: 1,
      workers: [
        {
          sessionId: 'sess-1',
          idle: true,
          alive: true,
          lastUsedAt: Date.now(),
          claudeSessionId: ctrl.capturedClaudeSessionId ?? null,
        },
      ],
    }),
    size: () => 1,
  };
  ctrl.pool = fakePool as ClaudeWorkerPool;
  return ctrl;
}

function buildSession(
  pool: ClaudeWorkerPool,
  initialResumeId?: string,
  reasoningEffort?: ClaudeReasoningEffort,
  allowedMcpTools?: string[],
): AnthropicCliSession {
  const queue = new ProviderQueue({ concurrency: 4 });
  return new AnthropicCliSession({
    binaryPath: '/fake/claude',
    model: 'sonnet',
    ...(reasoningEffort ? { reasoningEffort } : {}),
    permissionMode: 'acceptEdits',
    systemMessage: 'You are a test gezel.',
    context: {
      sessionId: 'sess-1',
      gezelId: 'g-1',
      projectId: 'p-1',
      cwd: '/tmp',
      ...(allowedMcpTools ? { allowedMcpTools } : {}),
    },
    runtimeDir: '/tmp/runtime',
    manageRuntimeFiles: false,
    queue,
    pool,
    ...(initialResumeId ? { initialResumeId } : {}),
  });
}

describe('AnthropicCliSession — façade contract', () => {
  it('reports the configured MCP roster for turn-level prompt guards', () => {
    const ctrl = makeMockPool();
    const session = buildSession(ctrl.pool, undefined, undefined, ['mcp__gezel__start_project']);
    expect(session.getRegisteredToolNames()).toContain('mcp__gezel__start_project');
  });

  it('routes sendAndWait through pool.runTurn with the correct spec', async () => {
    const ctrl = makeMockPool();
    const session = buildSession(ctrl.pool);
    const out = await session.sendAndWait('hello');
    expect(out).toBe('reply');
    expect(ctrl.runTurnCalls).toHaveLength(1);
    expect(ctrl.runTurnCalls[0]?.prompt).toBe('hello');
    expect(ctrl.runTurnCalls[0]?.spec.context.sessionId).toBe('sess-1');
    expect(ctrl.runTurnCalls[0]?.spec.model).toBe('sonnet');
  });

  it('passes the configured reasoning effort to the worker spec', async () => {
    const ctrl = makeMockPool();
    const session = buildSession(ctrl.pool, undefined, 'xhigh');
    await session.sendAndWait('think carefully');
    expect(ctrl.runTurnCalls[0]?.spec.reasoningEffort).toBe('xhigh');
  });

  it('refreshes the cached claudeSessionId from the pool snapshot after each turn', async () => {
    const ctrl = makeMockPool();
    ctrl.capturedClaudeSessionId = 'cli-sess-AAA';
    const session = buildSession(ctrl.pool);
    expect(session.providerState()).toEqual({});
    await session.sendAndWait('first');
    expect(session.providerState()).toEqual({ claudeCliSessionId: 'cli-sess-AAA' });
  });

  it('passes initialResumeId through to the worker spec', async () => {
    const ctrl = makeMockPool();
    const session = buildSession(ctrl.pool, 'cli-sess-resumed');
    expect(session.providerState()).toEqual({ claudeCliSessionId: 'cli-sess-resumed' });
    await session.sendAndWait('hi');
    expect(ctrl.runTurnCalls[0]?.spec.initialResumeId).toBe('cli-sess-resumed');
  });

  it('clears the cached id locally when the pool surfaces a SessionResumeError', async () => {
    const ctrl = makeMockPool();
    const session = buildSession(ctrl.pool, 'cli-sess-stale');
    ctrl.nextRunTurn = () => {
      throw new SessionResumeError('upstream session gone');
    };
    await expect(session.sendAndWait('hi')).rejects.toBeInstanceOf(SessionResumeError);
    expect(session.providerState()).toEqual({});
  });

  it("disconnect() evicts THIS session's worker only", async () => {
    const ctrl = makeMockPool();
    const session = buildSession(ctrl.pool);
    await session.disconnect();
    expect(ctrl.evictCalls).toEqual(['sess-1']);
  });

  it('rejects sends made after disconnect', async () => {
    const ctrl = makeMockPool();
    const session = buildSession(ctrl.pool);
    await session.disconnect();
    await expect(session.sendAndWait('hi')).rejects.toThrow(/disconnected/);
  });
});

describe('isResumeFailureSignal', () => {
  it('matches expected upstream phrases', () => {
    expect(isResumeFailureSignal({ stderr: 'session not found', exitCode: 1 })).toBe(true);
    expect(isResumeFailureSignal({ stderr: 'No such session.', exitCode: 1 })).toBe(true);
    expect(isResumeFailureSignal({ stderr: 'session has expired', exitCode: 1 })).toBe(true);
    expect(isResumeFailureSignal({ stderr: 'unrelated network blip', exitCode: 1 })).toBe(false);
  });
});

describe('AnthropicCliSession — reasoning capture', () => {
  it('accumulates thinking across the turn and republishes it on the reasoning channel', async () => {
    const ctrl = makeMockPool();
    const session = buildSession(ctrl.pool);
    const streamed: string[] = [];
    session.onReasoningDelta((chunk) => streamed.push(chunk));

    ctrl.nextRunTurn = () => {
      // One `sendAndWait` spans the whole agentic loop, so a turn routinely
      // carries several thinking blocks.
      ctrl.lastHooks?.emitReasoningDelta('first block. ');
      ctrl.lastHooks?.emitReasoningDelta('second block.');
      return 'the reply';
    };

    const text = await session.sendAndWait('go');
    expect(text).toBe('the reply');
    expect(streamed.join('')).toBe('first block. second block.');
    expect(session.getLastTurnReasoning()).toBe('first block. second block.');
  });

  it('returns undefined rather than an empty string when nothing was captured', async () => {
    const ctrl = makeMockPool();
    const session = buildSession(ctrl.pool);
    await session.sendAndWait('go');
    expect(session.getLastTurnReasoning()).toBeUndefined();
  });

  it('resets between turns so a quiet turn does not inherit the previous trace', async () => {
    const ctrl = makeMockPool();
    const session = buildSession(ctrl.pool);

    ctrl.nextRunTurn = () => {
      ctrl.lastHooks?.emitReasoningDelta('turn one thinking');
      return 'a';
    };
    await session.sendAndWait('go');
    expect(session.getLastTurnReasoning()).toBe('turn one thinking');

    ctrl.nextRunTurn = () => 'b';
    await session.sendAndWait('again');
    expect(session.getLastTurnReasoning()).toBeUndefined();
  });

  it('keeps the partial trace when the turn fails, for cancel-time salvage', async () => {
    const ctrl = makeMockPool();
    const session = buildSession(ctrl.pool);

    ctrl.nextRunTurn = () => {
      ctrl.lastHooks?.emitReasoningDelta('got this far');
      throw new Error('turn timed out');
    };
    await expect(session.sendAndWait('go')).rejects.toThrow('turn timed out');
    expect(session.getLastTurnReasoning()).toBe('got this far');
  });

  it('forwards tool-arg fragments and warnings to their own channels', async () => {
    const ctrl = makeMockPool();
    const session = buildSession(ctrl.pool);
    const args: Array<{ name: string; chunk: string }> = [];
    const warnings: string[] = [];
    session.onToolArgsDelta((name, chunk) => args.push({ name, chunk }));
    session.onWarning((message) => warnings.push(message));

    ctrl.nextRunTurn = () => {
      ctrl.lastHooks?.emitToolArgsDelta('write_artifact', '{"content":"…', { id: 'toolu_a' });
      ctrl.lastHooks?.emitWarning('Claude subscription rate limit (five-hour): rejected.');
      return 'ok';
    };
    await session.sendAndWait('go');

    expect(args).toEqual([{ name: 'write_artifact', chunk: '{"content":"…' }]);
    expect(warnings).toEqual(['Claude subscription rate limit (five-hour): rejected.']);
  });
});
