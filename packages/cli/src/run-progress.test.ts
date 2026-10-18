import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForMlxRuntime } from './model-pull.js';
import { RunProgress } from './run-progress.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('RunProgress', () => {
  it('stays quiet for a warm engine that answers within a moment', () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const progress = new RunProgress((text) => lines.push(text), 2_000);
    progress.phase({
      provider: 'llama-cpp',
      phase: 'loading_model',
      detail: 'Loading model into memory',
    });
    vi.advanceTimersByTime(500);
    progress.phase({ provider: 'llama-cpp', phase: 'generating' });
    vi.advanceTimersByTime(5_000);
    expect(lines).toEqual([]);
  });

  it('reports each wait of a cold MLX turn once, through its prefill heartbeats', () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const progress = new RunProgress((text) => lines.push(text), 2_000);
    const warmup = 'Warming up…';
    const heartbeat = { provider: 'mlx', phase: 'prefill', detail: 'Preparing…' };
    // The environment install, before the engine exists.
    progress.phase({ provider: 'mlx', phase: 'starting', detail: warmup });
    progress.phase(heartbeat);
    vi.advanceTimersByTime(60_000);
    // The engine starts and loads while the 4 s heartbeat keeps firing.
    progress.phase({ provider: 'mlx', phase: 'starting', detail: 'Mac AI server starting' });
    progress.phase({ provider: 'mlx', phase: 'loading_model', detail: 'Loading weights' });
    vi.advanceTimersByTime(1_000);
    progress.phase(heartbeat);
    vi.advanceTimersByTime(3_000);
    progress.phase({ provider: 'mlx', phase: 'prefill', detail: 'Processing prompt' });
    vi.advanceTimersByTime(3_000);
    progress.phase({ provider: 'mlx', phase: 'prefill', detail: 'Processing prompt' });
    progress.phase({ provider: 'mlx', phase: 'generating' });
    vi.advanceTimersByTime(10_000);
    expect(lines).toEqual([
      `MLX: ${warmup}\n`,
      'MLX: Loading weights\n',
      'MLX: Processing prompt\n',
    ]);
  });
});

describe('waitForMlxRuntime', () => {
  it('shows the install while it runs and returns when it is ready', async () => {
    const phases = ['provisioning', 'provisioning', 'ready'] as const;
    let call = 0;
    const client = {
      getMlxRuntimeStatus: async () => ({
        phase: phases[Math.min(call++, phases.length - 1)]!,
        updatedAt: '',
      }),
    };
    let clock = 0;
    const out: string[] = [];
    await expect(
      waitForMlxRuntime(client, (text) => out.push(text), {
        pollMs: 0,
        now: () => {
          clock += 30_000;
          return clock;
        },
      }),
    ).resolves.toBe('ready');
    expect(out[0]).toContain('preparing the MLX Python runtime');
    expect(out.join('')).toContain('1m 00s');
    expect(out.at(-1)).toContain('MLX runtime ready');
  });

  it('says nothing when there is no install to wait for', async () => {
    const out: string[] = [];
    await expect(
      waitForMlxRuntime(
        { getMlxRuntimeStatus: async () => ({ phase: 'idle', updatedAt: '' }) },
        (text) => out.push(text),
      ),
    ).resolves.toBe('idle');
    expect(out).toEqual([]);
  });

  it('reports a failed install without failing the pull', async () => {
    const out: string[] = [];
    await expect(
      waitForMlxRuntime(
        {
          getMlxRuntimeStatus: async () => ({ phase: 'error', error: 'no network', updatedAt: '' }),
        },
        (text) => out.push(text),
      ),
    ).resolves.toBe('error');
    expect(out.join('')).toContain('the first chat will retry it: no network');
  });
});
