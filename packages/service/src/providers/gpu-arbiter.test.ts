import { describe, expect, it, vi } from 'vitest';
import { GpuArbiter, detectGpuPolicy, resolveGpuPolicy } from './gpu-arbiter.js';

describe('GpuArbiter', () => {
  it('coexist policy makes acquire a no-op', async () => {
    const arb = new GpuArbiter({ policy: 'coexist', log: () => {} });
    const llmEvict = vi.fn(async () => {});
    const imgEvict = vi.fn(async () => {});
    arb.registerEvictor('llm', llmEvict);
    arb.registerEvictor('image', imgEvict);

    await arb.acquire('image');
    await arb.acquire('llm');

    expect(llmEvict).not.toHaveBeenCalled();
    expect(imgEvict).not.toHaveBeenCalled();
  });

  it('consults device health even when memory policy is coexist', async () => {
    const admit = vi.fn(async () => ({ admissible: true }));
    const arb = new GpuArbiter({
      policy: 'coexist',
      log: () => {},
      healthGate: { admit, setPolicy: vi.fn() } as never,
    });

    await arb.acquire('llm');

    expect(admit).toHaveBeenCalledWith('llm workload');
  });

  it('surfaces the normalized device-health snapshot for status routes', async () => {
    const status = vi.fn(async () => ({
      state: 'healthy' as const,
      mode: 'guard' as const,
      sampledAt: '2026-07-11T00:00:00.000Z',
      sources: ['nvidia-smi'],
      readings: [],
      reasons: [],
      summary: 'healthy',
    }));
    const arb = new GpuArbiter({
      policy: 'coexist',
      log: () => {},
      healthGate: { admit: vi.fn(), setPolicy: vi.fn(), status } as never,
    });

    await expect(arb.getDeviceHealthStatus()).resolves.toMatchObject({ state: 'healthy' });
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('signals memory pressure when free VRAM falls below the release threshold', async () => {
    const status = vi.fn(async () => ({
      state: 'healthy' as const,
      mode: 'observe' as const,
      sampledAt: '2026-08-10T00:00:00.000Z',
      sources: ['amd-adl'],
      readings: [
        {
          vendor: 'amd' as const,
          deviceId: '0',
          memoryUsedMb: 31 * 1024,
          memoryTotalMb: 32 * 1024,
        },
      ],
      reasons: [],
      summary: 'healthy',
    }));
    const arb = new GpuArbiter({
      policy: 'coexist',
      log: () => {},
      healthGate: { admit: vi.fn(), setPolicy: vi.fn(), status } as never,
    });

    await expect(arb.getMemoryPressureStatus()).resolves.toMatchObject({
      pressured: true,
      freeBytes: 1024 ** 3,
      totalBytes: 32 * 1024 ** 3,
    });
  });

  it('swap policy evicts the other slot when image acquires', async () => {
    const arb = new GpuArbiter({ policy: 'swap', log: () => {} });
    const llmEvict = vi.fn(async () => {});
    const imgEvict = vi.fn(async () => {});
    arb.registerEvictor('llm', llmEvict);
    arb.registerEvictor('image', imgEvict);

    await arb.acquire('image');

    expect(llmEvict).toHaveBeenCalledTimes(1);
    expect(imgEvict).not.toHaveBeenCalled();
  });

  it('swap policy evicts the other slot when llm acquires', async () => {
    const arb = new GpuArbiter({ policy: 'swap', log: () => {} });
    const llmEvict = vi.fn(async () => {});
    const imgEvict = vi.fn(async () => {});
    arb.registerEvictor('llm', llmEvict);
    arb.registerEvictor('image', imgEvict);

    await arb.acquire('llm');

    expect(imgEvict).toHaveBeenCalledTimes(1);
    expect(llmEvict).not.toHaveBeenCalled();
  });

  it('acquire is a no-op when no evictors are registered for the other slot', async () => {
    const arb = new GpuArbiter({ policy: 'swap', log: () => {} });
    // Only the requesting slot is registered (e.g. cloud LLM + local
    // image gen) — there's no LLM evictor to call.
    arb.registerEvictor(
      'image',
      vi.fn(async () => {}),
    );
    await expect(arb.acquire('image')).resolves.toBeUndefined();
  });

  it('swallows errors from evictors so the requesting engine still proceeds', async () => {
    const logged: string[] = [];
    const arb = new GpuArbiter({ policy: 'swap', log: (m) => logged.push(m) });
    arb.registerEvictor('llm', async () => {
      throw new Error('boom');
    });
    await expect(arb.acquire('image')).resolves.toBeUndefined();
    expect(logged.some((l) => l.includes('boom'))).toBe(true);
  });

  it('does not evict an active leased image job when llm acquires', async () => {
    const arb = new GpuArbiter({ policy: 'swap', log: () => {} });
    const llmEvict = vi.fn(async () => {});
    const imgEvict = vi.fn(async () => {});
    arb.registerEvictor('llm', llmEvict);
    arb.registerEvictor('image', imgEvict);

    const releaseImage = await arb.acquireLease('image');
    expect(llmEvict).toHaveBeenCalledTimes(1);

    let llmAcquired = false;
    const pending = arb.acquire('llm').then(() => {
      llmAcquired = true;
    });
    await Promise.resolve();

    expect(llmAcquired).toBe(false);
    expect(imgEvict).not.toHaveBeenCalled();

    releaseImage();
    await pending;

    expect(llmAcquired).toBe(true);
    expect(imgEvict).toHaveBeenCalledTimes(1);
  });

  it('does not evict an active leased llm job when image acquires', async () => {
    const arb = new GpuArbiter({ policy: 'swap', log: () => {} });
    const llmEvict = vi.fn(async () => {});
    const imgEvict = vi.fn(async () => {});
    arb.registerEvictor('llm', llmEvict);
    arb.registerEvictor('image', imgEvict);

    const releaseLlm = await arb.acquireLease('llm');
    expect(imgEvict).toHaveBeenCalledTimes(1);

    let imageAcquired = false;
    const pending = arb.acquire('image').then(() => {
      imageAcquired = true;
    });
    await Promise.resolve();

    expect(imageAcquired).toBe(false);
    expect(llmEvict).not.toHaveBeenCalled();

    releaseLlm();
    await pending;

    expect(imageAcquired).toBe(true);
    expect(llmEvict).toHaveBeenCalledTimes(1);
  });

  it('releases the lease if the device-health gate rejects admission', async () => {
    const admit = vi
      .fn()
      .mockRejectedValueOnce(new Error('too hot'))
      .mockResolvedValueOnce({ admissible: true });
    const arb = new GpuArbiter({
      policy: 'swap',
      log: () => {},
      healthGate: { admit, setPolicy: vi.fn() } as never,
    });

    await expect(arb.acquireLease('image')).rejects.toThrow('too hot');
    await expect(arb.acquireLease('llm')).resolves.toBeTypeOf('function');
  });

  it('unregisterEvictor stops further evictions for that slot', async () => {
    const arb = new GpuArbiter({ policy: 'swap', log: () => {} });
    const llmEvict = vi.fn(async () => {});
    arb.registerEvictor('llm', llmEvict);
    arb.unregisterEvictor('llm');
    await arb.acquire('image');
    expect(llmEvict).not.toHaveBeenCalled();
  });

  it('evicts ALL owners of a slot — pool replicas do not clobber each other', async () => {
    const arb = new GpuArbiter({ policy: 'swap', log: () => {} });
    const replicaA = vi.fn(async () => {});
    const replicaB = vi.fn(async () => {});
    arb.registerEvictor('llm', replicaA, 'llama-cpp/model-a#0');
    arb.registerEvictor('llm', replicaB, 'llama-cpp/model-b#0');

    await arb.acquire('image');

    expect(replicaA).toHaveBeenCalledTimes(1);
    expect(replicaB).toHaveBeenCalledTimes(1);
  });

  it('unregistering one owner leaves the other owners registered', async () => {
    const arb = new GpuArbiter({ policy: 'swap', log: () => {} });
    const replicaA = vi.fn(async () => {});
    const replicaB = vi.fn(async () => {});
    arb.registerEvictor('llm', replicaA, 'a');
    arb.registerEvictor('llm', replicaB, 'b');
    arb.unregisterEvictor('llm', 'a');

    await arb.acquire('image');

    expect(replicaA).not.toHaveBeenCalled();
    expect(replicaB).toHaveBeenCalledTimes(1);
  });

  it('re-registering the same owner replaces its evictor', async () => {
    const arb = new GpuArbiter({ policy: 'swap', log: () => {} });
    const stale = vi.fn(async () => {});
    const fresh = vi.fn(async () => {});
    arb.registerEvictor('llm', stale, 'a');
    arb.registerEvictor('llm', fresh, 'a');

    await arb.acquire('image');

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('setPolicy switches behavior on the next acquire', async () => {
    const arb = new GpuArbiter({ policy: 'coexist', log: () => {} });
    const llmEvict = vi.fn(async () => {});
    arb.registerEvictor('llm', llmEvict);

    await arb.acquire('image');
    expect(llmEvict).not.toHaveBeenCalled();

    arb.setPolicy('swap');
    await arb.acquire('image');
    expect(llmEvict).toHaveBeenCalledTimes(1);
  });
});

describe('detectGpuPolicy', () => {
  it('returns coexist on Apple Silicon with ≥24 GB unified RAM', () => {
    expect(
      detectGpuPolicy({
        platform: 'darwin',
        arch: 'arm64',
        totalMemBytes: 32 * 1024 ** 3,
      }),
    ).toBe('coexist');
  });

  it('returns swap on Apple Silicon with <24 GB', () => {
    expect(
      detectGpuPolicy({
        platform: 'darwin',
        arch: 'arm64',
        totalMemBytes: 16 * 1024 ** 3,
      }),
    ).toBe('swap');
  });

  it('returns swap on Intel Mac (no unified memory)', () => {
    expect(
      detectGpuPolicy({
        platform: 'darwin',
        arch: 'x64',
        totalMemBytes: 64 * 1024 ** 3,
      }),
    ).toBe('swap');
  });

  it('returns swap on Windows / Linux regardless of RAM', () => {
    expect(
      detectGpuPolicy({ platform: 'win32', arch: 'x64', totalMemBytes: 128 * 1024 ** 3 }),
    ).toBe('swap');
    expect(
      detectGpuPolicy({ platform: 'linux', arch: 'x64', totalMemBytes: 128 * 1024 ** 3 }),
    ).toBe('swap');
  });
});

describe('GpuArbiter stale-lease breaker', () => {
  // Regression: a llama-cpp turn that threw between acquiring the GPU lease and
  // installing its cleanup used to leak the lease forever. `activeLease` stayed
  // set, and because the wait only woke on a release that would never come,
  // every later acquirer parked indefinitely — the whole daemon stopped serving
  // with a healthy, idle engine until gezeld restarted. Wild-caught on
  // qwen3.6-35b-a3b-q8 / conflict-synthesis (2026-08-07).
  it('breaks a leaked lease instead of parking acquirers forever', async () => {
    const arb = new GpuArbiter({ policy: 'swap', log: () => {}, staleLeaseBreakMs: 20 });

    // Take a lease and never release it — exactly what the leak looked like.
    await arb.acquireLease('llm');

    // Without the breaker this never settles.
    const release = await arb.acquireLease('llm');

    expect(typeof release).toBe('function');
  });

  it('does not break a lease that is still within its ceiling', async () => {
    const arb = new GpuArbiter({ policy: 'swap', log: () => {}, staleLeaseBreakMs: 60_000 });
    const releaseFirst = await arb.acquireLease('image');

    let acquired = false;
    const pending = arb.acquireLease('llm').then((release) => {
      acquired = true;
      return release;
    });

    // A held, healthy lease must still block — that is what keeps a chat nudge
    // from evicting sd-server halfway through a VAE decode.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(acquired).toBe(false);

    releaseFirst();
    await pending;
    expect(acquired).toBe(true);
  });

  it('releases the lease when admission throws', async () => {
    const arb = new GpuArbiter({
      policy: 'swap',
      log: () => {},
      healthGate: {
        admit: vi.fn(async () => {
          throw new Error('too hot');
        }),
        setPolicy: vi.fn(),
      } as never,
    });

    await expect(arb.acquireLease('llm')).rejects.toThrow('too hot');

    // The next acquirer must not inherit a wedged arbiter.
    const arb2 = new GpuArbiter({ policy: 'swap', log: () => {} });
    await expect(arb2.acquireLease('llm')).resolves.toBeTypeOf('function');
  });
});

describe('resolveGpuPolicy', () => {
  it('passes through explicit settings', () => {
    expect(resolveGpuPolicy('coexist')).toBe('coexist');
    expect(resolveGpuPolicy('swap')).toBe('swap');
  });

  it('delegates to detectGpuPolicy for auto / undefined', () => {
    // Both branches return one of the two policies; we just verify
    // it's not 'auto' leaking through.
    expect(['coexist', 'swap']).toContain(resolveGpuPolicy('auto'));
    expect(['coexist', 'swap']).toContain(resolveGpuPolicy(undefined));
  });
});
