import { describe, expect, it } from 'vitest';
import { staleLiveSessionIds } from './chat-live-slot.js';

describe('staleLiveSessionIds', () => {
  it('retires only clean slots observed before the in-flight request', () => {
    const stale = {};
    const active = {};
    const errored = { error: 'provider failed' };
    const replacedBeforeResponse = {};
    const current = new Map<string, { error?: string }>([
      ['stale', stale],
      ['active', active],
      ['errored', errored],
      ['replaced', replacedBeforeResponse],
      ['new-after-request', {}],
    ]);
    const observed = new Map<string, object>([
      ['stale', stale],
      ['active', active],
      ['errored', errored],
      ['replaced', {}],
    ]);

    expect(staleLiveSessionIds(current, observed, new Set(['active']))).toEqual(['stale']);
  });
});
