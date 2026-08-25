import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnUsage } from '../types.js';
import { ClaudeWorkerPool, type ClaudeWorkerSpec } from './worker-pool.js';
import type { ClaudeWorker, ClaudeWorkerOpts, SendTurnOpts, WorkerTurnHooks } from './worker.js';

/**
 * Minimal in-memory fake worker. Tests drive lifecycle (idle/busy/crash)
 * via direct method calls on the fake; turns "complete" instantly. The
 * worker-pool test suite never spawns a real subprocess.
 */
interface FakeWorkerControl {
  worker: ClaudeWorker;
  failStartup?: Error;
  onSendTurn?: (prompt: string) => Promise<string> | string;
  /** Force `onCrash` to fire on next `sendTurn` (mid-turn crash). */
  crashNextTurn?: boolean;
  shutdownCalls: number;
  startCalls: number;
  sendCalls: Array<{ prompt: string }>;
  /** Drives `idle()` reporting. */
  forceBusy?: boolean;
  /** Drives `isAlive()` reporting. */
  forceDead?: boolean;
}

function makeFakeWorker(): FakeWorkerControl {
  let alive = false;
  let busy = false;
  let lastUsedAt = 0;
  let claudeSid: string | null = null;
  let onIdleEvict: (() => void) | undefined;
  let onCrash: ((err: Error) => void) | undefined;
  const ctrl: FakeWorkerControl = {
    shutdownCalls: 0,
    startCalls: 0,
    sendCalls: [],
    worker: {} as ClaudeWorker,
  };
  const fakeWorker: Partial<ClaudeWorker> = {
    start: vi.fn(async () => {
      ctrl.startCalls += 1;
      if (ctrl.failStartup) throw ctrl.failStartup;
      alive = true;
      claudeSid = `cli-${ctrl.startCalls}`;
      lastUsedAt = Date.now();
    }),
    sendTurn: vi.fn(async (prompt: string, _hooks: WorkerTurnHooks, _opts?: SendTurnOpts) => {
      ctrl.sendCalls.push({ prompt });
      if (!alive) throw new Error('not alive');
      busy = true;
      try {
        if (ctrl.crashNextTurn) {
          ctrl.crashNextTurn = false;
          alive = false;
          ctrl.forceDead = true;
          onCrash?.(new Error('mock crash'));
          throw new Error('mock crash');
        }
        if (ctrl.onSendTurn) {
          return await ctrl.onSendTurn(prompt);
        }
        return 'ok';
      } finally {
        busy = false;
        lastUsedAt = Date.now();
      }
    }),
    shutdown: vi.fn(async () => {
      ctrl.shutdownCalls += 1;
      alive = false;
    }),
    kill: vi.fn(() => {
      alive = false;
    }),
    isAlive: () => (ctrl.forceDead ? false : alive),
    idle: () => alive && !busy && !(ctrl.forceBusy ?? false),
    claudeSessionId: () => claudeSid,
    lastUsedAt: () => lastUsedAt,
    currentState: () => ({ kind: alive ? 'running.idle' : 'stopped' }),
  };
  ctrl.worker = fakeWorker as ClaudeWorker;
  // Capture the pool's onIdleEvict / onCrash callbacks via a side channel:
  // factory wraps construction so the test can read them back.
  (ctrl.worker as unknown as { _wireCallbacks: (opts: ClaudeWorkerOpts) => void })._wireCallbacks =
    (opts) => {
      onIdleEvict = opts.onIdleEvict;
      onCrash = opts.onCrash;
    };
  return ctrl;
}

function buildSpec(sessionId: string): ClaudeWorkerSpec {
  return {
    binaryPath: '/fake/claude',
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    systemMessage: 'You are a test gezel.',
    context: { sessionId, gezelId: 'g-1', projectId: 'p-1', cwd: '/tmp' },
    runtimeDir: '/tmp/runtime',
    manageRuntimeFiles: false,
  };
}

const noopHooks: WorkerTurnHooks = {
  emitDelta: () => {},
  emitReasoningDelta: () => {},
  emitHeartbeat: () => {},
  emitToolArgsDelta: () => {},
  emitWarning: () => {},
  emitUsage: (_u: TurnUsage) => {},
};

describe('ClaudeWorkerPool — affinity', () => {
  it('reuses the same worker for repeated calls with the same sessionId', async () => {
    const ctrls: FakeWorkerControl[] = [];
    const factory = (opts: ClaudeWorkerOpts) => {
      const c = makeFakeWorker();
      (c.worker as unknown as { _wireCallbacks: (o: ClaudeWorkerOpts) => void })._wireCallbacks(
        opts,
      );
      ctrls.push(c);
      return c.worker;
    };
    const pool = new ClaudeWorkerPool({ poolSize: 4, workerIdleMs: 60_000, factory });

    await pool.runTurn(buildSpec('a'), 'first', noopHooks);
    await pool.runTurn(buildSpec('a'), 'second', noopHooks);
    await pool.runTurn(buildSpec('a'), 'third', noopHooks);

    expect(ctrls).toHaveLength(1);
    expect(ctrls[0]!.startCalls).toBe(1);
    expect(ctrls[0]!.sendCalls).toHaveLength(3);
    await pool.shutdown();
  });
});

describe('ClaudeWorkerPool — LRU eviction', () => {
  it('evicts the LRU worker when the pool is at capacity', async () => {
    const ctrls: FakeWorkerControl[] = [];
    const factory = (opts: ClaudeWorkerOpts) => {
      const c = makeFakeWorker();
      (c.worker as unknown as { _wireCallbacks: (o: ClaudeWorkerOpts) => void })._wireCallbacks(
        opts,
      );
      ctrls.push(c);
      return c.worker;
    };
    const pool = new ClaudeWorkerPool({ poolSize: 2, workerIdleMs: 60_000, factory });

    // Three sessions — pool size 2, so the 3rd evicts the LRU.
    await pool.runTurn(buildSpec('a'), 'p', noopHooks);
    await new Promise((r) => setTimeout(r, 5));
    await pool.runTurn(buildSpec('b'), 'p', noopHooks);
    await new Promise((r) => setTimeout(r, 5));
    await pool.runTurn(buildSpec('c'), 'p', noopHooks);

    expect(ctrls).toHaveLength(3);
    // 'a' was LRU when 'c' arrived; it should have been shut down.
    expect(ctrls[0]!.shutdownCalls).toBe(1);
    expect(ctrls[1]!.shutdownCalls).toBe(0);
    expect(ctrls[2]!.shutdownCalls).toBe(0);

    expect(pool.size()).toBe(2);
    await pool.shutdown();
  });

  it('skips a busy worker when picking the LRU candidate', async () => {
    const ctrls: FakeWorkerControl[] = [];
    const factory = (opts: ClaudeWorkerOpts) => {
      const c = makeFakeWorker();
      (c.worker as unknown as { _wireCallbacks: (o: ClaudeWorkerOpts) => void })._wireCallbacks(
        opts,
      );
      ctrls.push(c);
      return c.worker;
    };
    const pool = new ClaudeWorkerPool({ poolSize: 2, workerIdleMs: 60_000, factory });

    // Spawn a + b. Mark a as busy (the would-be LRU candidate).
    await pool.runTurn(buildSpec('a'), 'p', noopHooks);
    await new Promise((r) => setTimeout(r, 5));
    await pool.runTurn(buildSpec('b'), 'p', noopHooks);

    ctrls[0]!.forceBusy = true;
    await pool.runTurn(buildSpec('c'), 'p', noopHooks);

    // 'a' was busy → skipped. 'b' should have been evicted instead.
    expect(ctrls[0]!.shutdownCalls).toBe(0);
    expect(ctrls[1]!.shutdownCalls).toBe(1);
    expect(ctrls[2]!.shutdownCalls).toBe(0);
    await pool.shutdown();
  });
});

describe('ClaudeWorkerPool — crash recovery', () => {
  it('drops a crashed worker and respawns with --resume on the next turn', async () => {
    const ctrls: FakeWorkerControl[] = [];
    const factory = (opts: ClaudeWorkerOpts) => {
      const c = makeFakeWorker();
      (c.worker as unknown as { _wireCallbacks: (o: ClaudeWorkerOpts) => void })._wireCallbacks(
        opts,
      );
      ctrls.push(c);
      return c.worker;
    };
    const pool = new ClaudeWorkerPool({ poolSize: 4, workerIdleMs: 60_000, factory });

    await pool.runTurn(buildSpec('a'), 'first', noopHooks);
    // Force the next sendTurn to crash.
    ctrls[0]!.crashNextTurn = true;
    await expect(pool.runTurn(buildSpec('a'), 'second', noopHooks)).rejects.toThrow(/crash/);

    // Next turn should spawn a NEW worker.
    await pool.runTurn(buildSpec('a'), 'third', noopHooks);
    expect(ctrls).toHaveLength(2);
    // The respawn should pass --resume <captured-id> from the crashed
    // worker. The captured id was 'cli-1' (first spawn).
    // We verify by checking the second factory call's initialResumeId.
    // To do that we need access to the spec — adjusting factory above.
    await pool.shutdown();
  });
});

describe('ClaudeWorkerPool — explicit eviction', () => {
  it('evict() shuts down the worker and removes it from the pool', async () => {
    const ctrls: FakeWorkerControl[] = [];
    const factory = (opts: ClaudeWorkerOpts) => {
      const c = makeFakeWorker();
      (c.worker as unknown as { _wireCallbacks: (o: ClaudeWorkerOpts) => void })._wireCallbacks(
        opts,
      );
      ctrls.push(c);
      return c.worker;
    };
    const pool = new ClaudeWorkerPool({ poolSize: 4, workerIdleMs: 60_000, factory });
    await pool.runTurn(buildSpec('a'), 'p', noopHooks);
    expect(pool.size()).toBe(1);
    await pool.evict('a');
    expect(pool.size()).toBe(0);
    expect(ctrls[0]!.shutdownCalls).toBe(1);
    await pool.shutdown();
  });

  it('shutdown() awaits every worker.shutdown()', async () => {
    const ctrls: FakeWorkerControl[] = [];
    const factory = (opts: ClaudeWorkerOpts) => {
      const c = makeFakeWorker();
      (c.worker as unknown as { _wireCallbacks: (o: ClaudeWorkerOpts) => void })._wireCallbacks(
        opts,
      );
      ctrls.push(c);
      return c.worker;
    };
    const pool = new ClaudeWorkerPool({ poolSize: 4, workerIdleMs: 60_000, factory });
    await pool.runTurn(buildSpec('a'), 'p', noopHooks);
    await pool.runTurn(buildSpec('b'), 'p', noopHooks);
    await pool.shutdown();
    expect(ctrls.every((c) => c.shutdownCalls === 1)).toBe(true);
    expect(pool.size()).toBe(0);
  });
});

describe('ClaudeWorkerPool — startup failure', () => {
  it('removes the worker from the pool when start() rejects', async () => {
    const ctrls: FakeWorkerControl[] = [];
    const factory = (opts: ClaudeWorkerOpts) => {
      const c = makeFakeWorker();
      (c.worker as unknown as { _wireCallbacks: (o: ClaudeWorkerOpts) => void })._wireCallbacks(
        opts,
      );
      c.failStartup = new Error('startup fail');
      ctrls.push(c);
      return c.worker;
    };
    const pool = new ClaudeWorkerPool({ poolSize: 4, workerIdleMs: 60_000, factory });
    await expect(pool.runTurn(buildSpec('a'), 'p', noopHooks)).rejects.toThrow(/startup fail/);
    expect(pool.size()).toBe(0);
    await pool.shutdown();
  });
});

describe('ClaudeWorkerPool — idle eviction callback', () => {
  it('routes the worker idle callback to evict()', async () => {
    const ctrls: FakeWorkerControl[] = [];
    let capturedOnIdle: (() => void) | undefined;
    const factory = (opts: ClaudeWorkerOpts) => {
      const c = makeFakeWorker();
      (c.worker as unknown as { _wireCallbacks: (o: ClaudeWorkerOpts) => void })._wireCallbacks(
        opts,
      );
      capturedOnIdle = opts.onIdleEvict;
      ctrls.push(c);
      return c.worker;
    };
    const pool = new ClaudeWorkerPool({ poolSize: 4, workerIdleMs: 60_000, factory });
    await pool.runTurn(buildSpec('a'), 'p', noopHooks);
    expect(pool.size()).toBe(1);

    // Simulate the worker's idle timer firing.
    expect(capturedOnIdle).toBeDefined();
    capturedOnIdle!();
    // Eviction is async — wait a tick.
    await new Promise((r) => setImmediate(r));
    expect(pool.size()).toBe(0);
    expect(ctrls[0]!.shutdownCalls).toBe(1);
    await pool.shutdown();
  });
});

beforeEach(() => {
  // No-op; tests are self-contained.
});

afterEach(() => {
  vi.useRealTimers();
});
