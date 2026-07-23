/**
 * Smoke tests for the registry skeleton — exercises the resolver
 * paths that exist before any behavior is migrated. The actual
 * behavior file tests live alongside their implementations under
 * `behaviors/__tests__/`.
 */

import type { ChatModelManifest } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { resolveProfile } from './registry.js';
import type { Behavior } from './types.js';

// Sanity check that the type surface compiles. Not exported.
const _NeverConstructed: Behavior<{ count: number }> | null = null;
void _NeverConstructed;

function manifest(overrides: Partial<ChatModelManifest>): ChatModelManifest {
  return {
    schemaVersion: 1,
    kind: 'chat-model',
    id: 'test-model',
    name: 'Test',
    description: 'Test model',
    tags: [],
    maintainer: { name: 'Tester' },
    version: '1.0.0',
    releasedAt: '2026-05-07T00:00:00Z',
    parameterSize: '8B',
    approxSizeBytes: 1_000_000_000,
    supportsTools: true,
    availableVersions: ['1.0.0'],
    ...overrides,
  };
}

describe('resolveProfile — skeleton path (no behaviors registered yet)', () => {
  it('falls back to the tier-default list when the manifest has no behaviors', () => {
    const profile = resolveProfile({
      manifest: manifest({}),
      tier: 'small',
      providerName: 'mlx',
    });
    // Tier-default for `small` references whichever behaviors are
    // currently registered + listed in TIER_DEFAULT_BEHAVIORS. Unknown
    // ids are silently skipped. We assert the shape — every resolved
    // entry is well-formed and references an in-registry behavior —
    // not an exact list, so this test stays green as more behaviors
    // land throughout the migration.
    expect(profile.catalogId).toBe('test-model');
    expect(profile.tier).toBe('small');
    for (const entry of profile.behaviors) {
      expect(entry.id).toBeTruthy();
      expect(entry.behavior).toBeDefined();
      expect(entry.behavior.id).toBe(entry.id);
    }
  });

  it('returns the manifest-declared style when present', () => {
    const profile = resolveProfile({
      manifest: manifest({
        style: { family: 'gemma', reasoningFormat: 'channel', toolCallFormat: 'function-call' },
      }),
      tier: 'medium',
      providerName: 'mlx',
    });
    expect(profile.style).toEqual({
      family: 'gemma',
      reasoningFormat: 'channel',
      toolCallFormat: 'function-call',
    });
  });

  it('falls back to a provider-derived style when the manifest omits one', () => {
    const localProfile = resolveProfile({
      manifest: manifest({}),
      tier: 'small',
      providerName: 'mlx',
    });
    expect(localProfile.style.reasoningFormat).toBe('think');
    expect(localProfile.style.toolCallFormat).toBe('function-call');

    const cloudProfile = resolveProfile({
      manifest: manifest({}),
      tier: 'cloud',
      providerName: 'copilot',
    });
    expect(cloudProfile.style.reasoningFormat).toBe('none');
  });

  it('drops manifest entries whose ids are not registered (and does not throw)', () => {
    const profile = resolveProfile({
      manifest: manifest({
        behaviors: ['behavior.does-not-exist', 'also.not.real'],
      }),
      tier: 'medium',
      providerName: 'mlx',
    });
    // The two unknown ids are dropped; the universal default
    // (`tools.gezels-as-roles`) is appended to every profile.
    expect(profile.behaviors.map((e) => e.id)).toEqual([
      'tools.gezels-as-roles',
      'prompt.meester-craftbook-prelude',
    ]);
  });

  it('handles undefined manifest (third-party catalog import)', () => {
    const profile = resolveProfile({
      manifest: undefined,
      tier: 'cloud',
      providerName: 'openai',
    });
    expect(profile.catalogId).toBeUndefined();
    expect(profile.tier).toBe('cloud');
    // Cloud tier-default is empty, but the universal default still applies
    // — role tools default ON for frontier models too.
    expect(profile.behaviors.map((e) => e.id)).toEqual([
      'tools.gezels-as-roles',
      'prompt.meester-craftbook-prelude',
    ]);
  });
});
