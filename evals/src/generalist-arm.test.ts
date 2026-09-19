import { describe, expect, it } from 'vitest';
import { generalistArmLabel } from './generalist-arm.ts';

describe('generalistArmLabel', () => {
  it('maps the daemon setting to the execution mode it selects', () => {
    expect(generalistArmLabel('on')).toBe('generalist');
    expect(generalistArmLabel('off')).toBe('stepwise');
    expect(generalistArmLabel('auto')).toBe('auto');
  });

  it('is undefined for trials that predate the switch', () => {
    expect(generalistArmLabel(undefined)).toBeUndefined();
    expect(generalistArmLabel(null)).toBeUndefined();
    expect(generalistArmLabel('')).toBeUndefined();
  });
});
