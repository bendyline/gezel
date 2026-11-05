import { describe, expect, it, vi } from 'vitest';
import {
  ProcessIdentityCache,
  VERIFIED_IDENTITY_TTL_MS,
  readProcessIdentities,
} from './process-identity.js';

describe('OS process birth stamps', () => {
  it('reads a stable birth stamp for this process', async () => {
    const first = await readProcessIdentities([process.pid]);
    expect(first.get(process.pid)).toBeTruthy();
    expect((await readProcessIdentities([process.pid])).get(process.pid)).toBe(
      first.get(process.pid),
    );
  });
  it('keeps live process rows when another PID is absent', async () => {
    expect((await readProcessIdentities([process.pid, 2147483647])).get(process.pid)).toBeTruthy();
  });
  it('ignores invalid process IDs', async () => {
    expect(await readProcessIdentities([-1, 0, Number.NaN, 1.2])).toEqual(new Map());
  });
});

describe('cached birth stamps', () => {
  function fixture() {
    const live = new Set([10, 11, 12]);
    const births = new Map([...live].map((pid) => [pid, `birth-${pid}`]));
    let clock = 0;
    const read = vi.fn(async (pids: readonly number[]) => {
      const found = new Map<number, string>();
      for (const pid of pids) if (births.has(pid)) found.set(pid, births.get(pid)!);
      return found;
    });
    const cache = new ProcessIdentityCache({
      read,
      alive: (pid) => live.has(pid),
      now: () => clock,
    });
    const advance = (ms: number) => {
      clock += ms;
    };
    return { cache, read, live, births, advance };
  }
  const recorded = (stamps: Record<number, string>) =>
    new Map(Object.entries(stamps).map(([pid, stamp]) => [Number(pid), [stamp]]));

  it('reads a live PID once, however often it is confirmed', async () => {
    const { cache, read, advance } = fixture();
    expect((await cache.lookup([], recorded({ 10: 'birth-10' }))).get(10)).toBe('birth-10');
    for (let i = 0; i < 20; i++) {
      advance(VERIFIED_IDENTITY_TTL_MS / 40);
      expect((await cache.lookup([], recorded({ 10: 'birth-10' }))).get(10)).toBe('birth-10');
    }
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads every PID that needs it in one batch', async () => {
    const { cache, read } = fixture();
    await cache.lookup([12], recorded({ 10: 'birth-10', 11: 'birth-11' }));
    expect(read).toHaveBeenCalledTimes(1);
    expect([...read.mock.calls[0]![0]].sort()).toEqual([10, 11, 12]);
  });

  it('reads a stamp it is about to record, even one it has cached', async () => {
    const { cache, read } = fixture();
    await cache.lookup([10], new Map());
    await cache.lookup([10], new Map());
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('catches a reused PID once its cached stamp expires', async () => {
    const { cache, births, read, advance } = fixture();
    await cache.lookup([], recorded({ 10: 'birth-10' }));
    // The engine died and a new process took its PID between two liveness checks.
    births.set(10, 'birth-of-a-stranger');
    advance(VERIFIED_IDENTITY_TTL_MS);
    expect((await cache.lookup([], recorded({ 10: 'birth-10' }))).get(10)).toBe(
      'birth-of-a-stranger',
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads a PID again at once after seeing it dead', async () => {
    const { cache, births, live, read } = fixture();
    await cache.lookup([], recorded({ 10: 'birth-10' }));
    live.delete(10);
    expect((await cache.lookup([], recorded({ 10: 'birth-10' }))).has(10)).toBe(false);
    births.set(10, 'birth-of-a-stranger');
    live.add(10);
    expect((await cache.lookup([], recorded({ 10: 'birth-10' }))).get(10)).toBe(
      'birth-of-a-stranger',
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never lets a cached stamp contradict one recorded elsewhere', async () => {
    const { cache, births, read } = fixture();
    await cache.lookup([], recorded({ 10: 'birth-10' }));
    // Another coordinator recorded the process that now holds PID 10.
    births.set(10, 'birth-of-the-new-engine');
    expect((await cache.lookup([], recorded({ 10: 'birth-of-the-new-engine' }))).get(10)).toBe(
      'birth-of-the-new-engine',
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('neither reads dead PIDs nor remembers a stamp it could not read', async () => {
    const { cache, births, live, read } = fixture();
    live.delete(11);
    births.delete(12);
    const found = await cache.lookup([11], recorded({ 12: 'birth-12' }));
    expect(found.size).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toEqual([12]);
    births.set(12, 'birth-12');
    expect((await cache.lookup([], recorded({ 12: 'birth-12' }))).get(12)).toBe('birth-12');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
