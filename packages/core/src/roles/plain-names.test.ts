import { describe, expect, it } from 'vitest';
import { roleGloss, roleWithGloss } from './plain-names.js';

describe('role glosses', () => {
  it('puts plain words beside a guild role, and leaves plain roles alone', () => {
    expect(roleWithGloss('Reisleider')).toBe('Reisleider — trip planner');
    expect(roleWithGloss('Voorman')).toBe('Voorman — crew lead');
    expect(roleWithGloss('Planner')).toBe('Planner');
    expect(roleGloss('Researcher')).toBeUndefined();
  });

  it('reads a role however it is cased or accented', () => {
    expect(roleGloss('Zorgcoördinator')).toBe('care coordinator');
    expect(roleGloss('  ceremoniemeester ')).toBe('event planner');
    expect(roleGloss(undefined)).toBeUndefined();
  });
});
