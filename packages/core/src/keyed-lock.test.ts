import { describe, expect, it } from 'vitest';
import { KeyedLock } from './keyed-lock.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('KeyedLock', () => {
  it('serializes callers on the same key in submission order', async () => {
    const lock = new KeyedLock();
    const order: number[] = [];
    let firstRunning = false;
    const first = lock.run('k', async () => {
      firstRunning = true;
      await tick();
      order.push(1);
    });
    const second = lock.run('k', async () => {
      order.push(2);
    });
    expect(firstRunning).toBe(false); // fn is never invoked synchronously
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it('does not serialize across different keys', async () => {
    const lock = new KeyedLock();
    let released = false;
    let releaseA!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const a = lock.run('a', () => gate);
    const b = lock.run('b', async () => {
      released = true;
    });
    await b;
    expect(released).toBe(true);
    releaseA();
    await a;
  });

  it('a rejecting body does not poison subsequent callers', async () => {
    const lock = new KeyedLock();
    await expect(
      lock.run('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(lock.run('k', async () => 42)).resolves.toBe(42);
  });

  it('propagates each rejection only to its own caller', async () => {
    const lock = new KeyedLock();
    const failing = lock.run('k', async () => {
      throw new Error('first');
    });
    const following = lock.run('k', async () => 'ok');
    await expect(failing).rejects.toThrow('first');
    await expect(following).resolves.toBe('ok');
  });

  it('releases the map entry after settle, on both outcomes', async () => {
    const lock = new KeyedLock();
    await lock.run('good', async () => 1);
    await lock
      .run('bad', async () => {
        throw new Error('x');
      })
      .catch(() => {});
    await tick();
    expect(lock.size).toBe(0);
  });

  it('a rejecting body leaves no unhandled rejection behind', async () => {
    const prior = process.listeners('unhandledRejection');
    for (const listener of prior) process.off('unhandledRejection', listener);
    const seen: unknown[] = [];
    const capture = (reason: unknown) => {
      seen.push(reason);
    };
    process.on('unhandledRejection', capture);
    try {
      const lock = new KeyedLock();
      await expect(
        lock.run('k', async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      // Give the microtask queue and a macrotask turn a chance to surface
      // the rejected-tail hazard this class exists to prevent.
      await tick();
      await tick();
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', capture);
      for (const listener of prior) process.on('unhandledRejection', listener);
    }
  });

  it('a later run on the same key is not deleted by an earlier settle', async () => {
    const lock = new KeyedLock();
    let releaseSecond!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const first = lock.run('k', async () => 'a');
    const second = lock.run('k', () => gate);
    await first;
    await tick();
    expect(lock.size).toBe(1); // second still queued; first's cleanup must not evict it
    releaseSecond();
    await second;
    await tick();
    expect(lock.size).toBe(0);
  });

  it('drain waits for in-flight work and never rejects', async () => {
    const lock = new KeyedLock();
    let done = false;
    void lock
      .run('k', async () => {
        await tick();
        done = true;
        throw new Error('still fine');
      })
      .catch(() => {});
    await lock.drain();
    expect(done).toBe(true);
  });

  it('accepts synchronous bodies', async () => {
    const lock = new KeyedLock();
    await expect(lock.run('k', () => 7)).resolves.toBe(7);
  });
});
