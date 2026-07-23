import { describe, expect, it } from 'vitest';
import { createTenantLimiter } from './tenant-limits.js';

describe('tenant limiter', () => {
  it('caps concurrent requests per device and frees on release', () => {
    const lim = createTenantLimiter({ maxConcurrentPerDevice: 2 });
    const r1 = lim.tryAcquire('A', 'chat');
    const r2 = lim.tryAcquire('A', 'chat');
    expect(r1).toBeTruthy();
    expect(r2).toBeTruthy();
    expect(lim.tryAcquire('A', 'chat')).toBeNull(); // at cap
    expect(lim.inFlight('A')).toBe(2);
    r1!();
    expect(lim.tryAcquire('A', 'chat')).toBeTruthy(); // a slot freed
  });

  it('isolates devices from each other', () => {
    const lim = createTenantLimiter({ maxConcurrentPerDevice: 1 });
    expect(lim.tryAcquire('A', 'chat')).toBeTruthy();
    expect(lim.tryAcquire('A', 'chat')).toBeNull();
    expect(lim.tryAcquire('B', 'chat')).toBeTruthy(); // B independent of A
  });

  it('applies a separate chat cap within the total', () => {
    const lim = createTenantLimiter({ maxConcurrentPerDevice: 5, maxChatPerDevice: 1 });
    expect(lim.tryAcquire('A', 'chat')).toBeTruthy();
    expect(lim.tryAcquire('A', 'chat')).toBeNull(); // chat-specific cap hit
    expect(lim.tryAcquire('A', 'generation')).toBeTruthy(); // generation still allowed
  });

  it('treats double-release as idempotent', () => {
    const lim = createTenantLimiter({ maxConcurrentPerDevice: 1 });
    const r = lim.tryAcquire('A', 'chat')!;
    r();
    r();
    expect(lim.inFlight('A')).toBe(0);
    expect(lim.tryAcquire('A', 'chat')).toBeTruthy();
  });
});
