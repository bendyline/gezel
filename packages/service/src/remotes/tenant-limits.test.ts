import { describe, expect, it } from 'vitest';
import { type TenantAdmission, createTenantLimiter } from './tenant-limits.js';

function admitted(a: TenantAdmission): () => void {
  if (!a.ok) throw new Error(`expected admission, got ${a.reason}`);
  return a.release;
}

describe('createTenantLimiter', () => {
  it('caps total concurrent requests per device and frees on release', () => {
    const lim = createTenantLimiter({ maxConcurrentPerDevice: 2 });
    const r1 = admitted(lim.tryAcquire('A', 'chat'));
    admitted(lim.tryAcquire('A', 'chat'));
    const denied = lim.tryAcquire('A', 'chat');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('concurrency');
    expect(lim.inFlight('A')).toBe(2);
    r1();
    expect(admitted(lim.tryAcquire('A', 'chat'))).toBeTypeOf('function');
  });

  it('tracks devices independently', () => {
    const lim = createTenantLimiter({ maxConcurrentPerDevice: 1 });
    admitted(lim.tryAcquire('A', 'chat'));
    expect(lim.tryAcquire('A', 'chat').ok).toBe(false);
    expect(lim.tryAcquire('B', 'chat').ok).toBe(true);
  });

  it('enforces the chat-specific cap under the total cap', () => {
    const lim = createTenantLimiter({ maxConcurrentPerDevice: 5, maxChatPerDevice: 1 });
    admitted(lim.tryAcquire('A', 'chat'));
    const denied = lim.tryAcquire('A', 'chat');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('concurrency');
    expect(lim.tryAcquire('A', 'generation').ok).toBe(true);
  });

  it('release is idempotent', () => {
    const lim = createTenantLimiter({ maxConcurrentPerDevice: 1 });
    const r = admitted(lim.tryAcquire('A', 'chat'));
    r();
    r();
    expect(lim.inFlight('A')).toBe(0);
    expect(lim.tryAcquire('A', 'chat').ok).toBe(true);
  });

  it('enforces requestsPerMinute over a sliding window with a real Retry-After', () => {
    let clock = 1_000_000;
    const lim = createTenantLimiter({ requestsPerMinute: 2 }, { now: () => clock });
    admitted(lim.tryAcquire('A', 'chat'))();
    clock += 10_000;
    admitted(lim.tryAcquire('A', 'chat'))();
    clock += 10_000;
    const denied = lim.tryAcquire('A', 'chat');
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.reason).toBe('rate_limit');
      // Oldest admission was 20s ago; the window frees it in 40s.
      expect(denied.retryAfterSec).toBe(40);
    }
    // Rate limit is per device — B is unaffected.
    expect(lim.tryAcquire('B', 'chat').ok).toBe(true);
    // Slide past the window: the oldest stamp ages out and A admits again.
    clock += 41_000;
    expect(lim.tryAcquire('A', 'chat').ok).toBe(true);
  });

  it('rate-limits only admitted requests (denials do not consume the window)', () => {
    let clock = 0;
    const lim = createTenantLimiter(
      { maxConcurrentPerDevice: 1, requestsPerMinute: 5 },
      { now: () => clock },
    );
    admitted(lim.tryAcquire('A', 'chat'));
    for (let i = 0; i < 10; i++) expect(lim.tryAcquire('A', 'chat').ok).toBe(false);
    clock += 1_000;
    // Only ONE admission counted; concurrency denials must not have
    // consumed the 5-per-minute budget.
    expect((lim.tryAcquire('B', 'chat') as { ok: boolean }).ok).toBe(true);
  });

  it('setLimits swaps caps in place while preserving in-flight counters', () => {
    const lim = createTenantLimiter({ maxConcurrentPerDevice: 1 });
    const r = admitted(lim.tryAcquire('A', 'chat'));
    expect(lim.tryAcquire('A', 'chat').ok).toBe(false);
    lim.setLimits({ maxConcurrentPerDevice: 2 });
    // The original in-flight request still counts against the new cap...
    expect(lim.inFlight('A')).toBe(1);
    expect(lim.tryAcquire('A', 'chat').ok).toBe(true);
    // ...and releasing it decrements the same counter it incremented.
    r();
    expect(lim.inFlight('A')).toBe(1);
    lim.setLimits({ maxConcurrentPerDevice: 1 });
    expect(lim.tryAcquire('A', 'chat').ok).toBe(false);
  });

  it('setLimits can introduce a rate limit that sees prior admissions', () => {
    const clock = 0;
    const lim = createTenantLimiter(undefined, { now: () => clock });
    admitted(lim.tryAcquire('A', 'chat'))();
    lim.setLimits({ requestsPerMinute: 1 });
    const denied = lim.tryAcquire('A', 'chat');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('rate_limit');
  });
});
