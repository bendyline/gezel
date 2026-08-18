import { describe, expect, it } from 'vitest';
import type { ResolvedModelProfile } from '../../model-profile/types.js';
import { profileForCallerOwnedInference } from './caller-owned-profile.js';

function profileWith(...behaviorIds: string[]): ResolvedModelProfile {
  return {
    catalogId: 'test-model',
    tier: 'small',
    style: { family: 'qwen', traits: [] },
    behaviors: behaviorIds.map((id) => ({ id, config: undefined, behavior: { id } })),
  } as unknown as ResolvedModelProfile;
}

describe('profileForCallerOwnedInference', () => {
  it('removes Gezel-owned action enforcement while retaining compatibility behaviors', () => {
    const source = profileWith(
      'turn.ramble-detection',
      'turn.preamble-folding',
      'tools.mlx-grammar',
      'parse.gemma-special-token',
      'provider.flatten-tool-transcript',
    );

    const filtered = profileForCallerOwnedInference(source);

    expect(filtered.behaviors.map((entry) => entry.id)).toEqual([
      'turn.preamble-folding',
      'tools.mlx-grammar',
      'parse.gemma-special-token',
      'provider.flatten-tool-transcript',
    ]);
    expect(source.behaviors.map((entry) => entry.id)).toContain('turn.ramble-detection');
  });

  it('preserves object identity when the profile needs no filtering', () => {
    const source = profileWith('tools.mlx-grammar');
    expect(profileForCallerOwnedInference(source)).toBe(source);
  });
});
