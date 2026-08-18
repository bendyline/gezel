import { describe, expect, it } from 'vitest';

import {
  CANONICAL_PROFILES,
  KNOWN_PROFILE_IDS,
  profileKind,
  resolveProfileChain,
} from './tuning-profile-registry.js';

describe('thinking-deep tuning profile', () => {
  it('is a canonical thinking profile with a general fallback', () => {
    expect(KNOWN_PROFILE_IDS).toContain('thinking-deep');
    expect(CANONICAL_PROFILES['thinking-deep']).toMatchObject({
      label: 'Thinking — Deep',
      kind: 'thinking',
      fallbackChain: ['thinking-general', 'instruct'],
    });
    expect(profileKind('thinking-deep')).toBe('thinking');
    expect(resolveProfileChain('thinking-deep', ['thinking-deep', 'thinking-general'])).toBe(
      'thinking-deep',
    );
    expect(resolveProfileChain('thinking-deep', ['thinking-general'])).toBe('thinking-general');
  });
});
