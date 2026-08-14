import { describe, expect, it, vi } from 'vitest';
import {
  RootTurnInvocationCache,
  invocationSignature,
  rootTurnIdFromMessages,
  rootTurnInvocationKey,
} from './craftbook-invocation-idempotency.js';

describe('rootTurnIdFromMessages', () => {
  it('stays anchored to the latest persisted user message across continuations', () => {
    const before = [
      { role: 'user' as const, at: '2026-08-14T10:00:00.000Z' },
      { role: 'assistant' as const, at: '2026-08-14T10:00:01.000Z' },
    ];
    const afterContinuation = [
      ...before,
      { role: 'assistant' as const, at: '2026-08-14T10:00:02.000Z' },
    ];
    expect(rootTurnIdFromMessages('s1', before)).toBe(
      rootTurnIdFromMessages('s1', afterContinuation),
    );
  });
});

describe('RootTurnInvocationCache', () => {
  it('returns the first successful identical invocation within one root turn', async () => {
    const cache = new RootTurnInvocationCache<{ task: string }>();
    const execute = vi.fn(async () => ({ task: 'cli/1' }));
    const first = await cache.run({
      rootTurnId: 's1:0:t1',
      invocation: { craftbookId: 'build-loop', params: { b: '2', a: '1' } },
      execute,
    });
    const second = await cache.run({
      rootTurnId: 's1:0:t1',
      invocation: { params: { a: '1', b: '2' }, craftbookId: 'build-loop' },
      execute,
    });

    expect(first).toEqual({ value: { task: 'cli/1' }, reused: false });
    expect(second).toEqual({ value: { task: 'cli/1' }, reused: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('allows the same invocation on a later root turn', async () => {
    const cache = new RootTurnInvocationCache<number>();
    const execute = vi.fn(async () => 1);
    await cache.run({ rootTurnId: 'turn-1', invocation: { craftbookId: 'ship' }, execute });
    await cache.run({ rootTurnId: 'turn-2', invocation: { craftbookId: 'ship' }, execute });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not retain failed or explicitly non-cacheable launches', async () => {
    const cache = new RootTurnInvocationCache<string>();
    const failed = vi.fn(async () => {
      throw new Error('setup failed');
    });
    await expect(
      cache.run({ rootTurnId: 'turn', invocation: { craftbookId: 'ship' }, execute: failed }),
    ).rejects.toThrow('setup failed');
    await expect(
      cache.run({ rootTurnId: 'turn', invocation: { craftbookId: 'ship' }, execute: failed }),
    ).rejects.toThrow('setup failed');
    expect(failed).toHaveBeenCalledTimes(2);

    const blocked = vi.fn(async () => 'setup-required');
    await cache.run({
      rootTurnId: 'turn',
      invocation: { craftbookId: 'ship' },
      execute: blocked,
      cacheResult: (value) => value !== 'setup-required',
    });
    await cache.run({
      rootTurnId: 'turn',
      invocation: { craftbookId: 'ship' },
      execute: blocked,
      cacheResult: (value) => value !== 'setup-required',
    });
    expect(blocked).toHaveBeenCalledTimes(2);
  });

  it('canonicalizes nested invocation argument order', () => {
    expect(invocationSignature({ z: 1, params: { b: 2, a: 1 } })).toBe(
      invocationSignature({ params: { a: 1, b: 2 }, z: 1 }),
    );
  });

  it('derives a stable opaque key that changes with the root turn', () => {
    const invocation = { craftbookId: 'build-loop', params: { outputPath: 'index.html' } };
    expect(rootTurnInvocationKey('turn-1', invocation)).toBe(
      rootTurnInvocationKey('turn-1', invocation),
    );
    expect(rootTurnInvocationKey('turn-1', invocation)).not.toBe(
      rootTurnInvocationKey('turn-2', invocation),
    );
  });
});
