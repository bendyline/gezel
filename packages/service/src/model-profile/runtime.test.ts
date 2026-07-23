import { afterEach, describe, expect, it } from 'vitest';
import { lookupBehavior, resolveProfile } from './registry.js';
import { applyBehaviorEnvOverrides, profileHasBehavior } from './runtime.js';

const FORCE = 'GEZEL_FORCE_BEHAVIORS';
const REMOVE = 'GEZEL_REMOVE_BEHAVIORS';

function baseProfile() {
  return resolveProfile({ manifest: undefined, tier: 'medium', providerName: 'mlx' });
}

afterEach(() => {
  delete process.env[FORCE];
  delete process.env[REMOVE];
});

describe('tools.gezels-as-roles behavior registration', () => {
  it('is registered in the behavior registry', () => {
    expect(lookupBehavior('tools.gezels-as-roles')).toBeDefined();
  });

  it('is a universal default — present on every resolved profile', () => {
    expect(profileHasBehavior(baseProfile(), 'tools.gezels-as-roles')).toBe(true);
    // ...including a cloud/frontier profile with no manifest.
    const cloud = resolveProfile({ manifest: undefined, tier: 'cloud', providerName: 'openai' });
    expect(profileHasBehavior(cloud, 'tools.gezels-as-roles')).toBe(true);
  });
});

describe('applyBehaviorEnvOverrides', () => {
  // A real behavior NOT in the medium tier default (it's a tiny-tier
  // default), used to exercise the add path now that tools.gezels-as-roles
  // is a universal default and always present.
  const ADD_ID = 'prompt.tool-cookbook-full';

  it('returns the same reference when no override env is set', () => {
    const p = baseProfile();
    expect(applyBehaviorEnvOverrides(p)).toBe(p);
  });

  it('adds a forced behavior via GEZEL_FORCE_BEHAVIORS', () => {
    process.env[FORCE] = ADD_ID;
    const p = baseProfile();
    expect(profileHasBehavior(p, ADD_ID)).toBe(false);
    const next = applyBehaviorEnvOverrides(p);
    expect(profileHasBehavior(next, ADD_ID)).toBe(true);
    // Original profile untouched (returns a copy).
    expect(profileHasBehavior(p, ADD_ID)).toBe(false);
  });

  it('ignores unknown forced behavior ids without throwing', () => {
    process.env[FORCE] = `does.not.exist,${ADD_ID}`;
    const next = applyBehaviorEnvOverrides(baseProfile());
    expect(profileHasBehavior(next, 'does.not.exist')).toBe(false);
    expect(profileHasBehavior(next, ADD_ID)).toBe(true);
  });

  it('does not duplicate an already-present behavior', () => {
    // tools.gezels-as-roles is a universal default → already present;
    // forcing it again must not duplicate.
    process.env[FORCE] = 'tools.gezels-as-roles,tools.gezels-as-roles';
    const p = applyBehaviorEnvOverrides(baseProfile());
    expect(p.behaviors.filter((e) => e.id === 'tools.gezels-as-roles')).toHaveLength(1);
  });

  it('removes a default behavior via GEZEL_REMOVE_BEHAVIORS (the A/B opt-out)', () => {
    const base = baseProfile();
    expect(profileHasBehavior(base, 'tools.gezels-as-roles')).toBe(true); // default ON
    process.env[REMOVE] = 'tools.gezels-as-roles';
    const removed = applyBehaviorEnvOverrides(base);
    expect(profileHasBehavior(removed, 'tools.gezels-as-roles')).toBe(false);
  });
});
