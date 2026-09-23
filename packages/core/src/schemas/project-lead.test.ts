import { describe, expect, it } from 'vitest';
import { projectLeadGezelId } from './project.js';

describe('projectLeadGezelId', () => {
  it('is the voorman when the project has one', () => {
    expect(projectLeadGezelId({ id: 'shop', voormanGezelId: 'leo' }, 'meester')).toBe('leo');
    expect(projectLeadGezelId({ id: 'default', voormanGezelId: 'leo' }, 'meester')).toBe('leo');
  });

  it('falls back to the Meester only in the Default project', () => {
    expect(projectLeadGezelId({ id: 'default' }, 'meester')).toBe('meester');
    expect(projectLeadGezelId({ id: 'shop' }, 'meester')).toBeUndefined();
    expect(projectLeadGezelId({ id: 'default' }, undefined)).toBeUndefined();
  });
});
