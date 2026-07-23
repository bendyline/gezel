import { describe, expect, it } from 'vitest';
import { valueRequiredAllFlagError, valueRequiredBatchFlagError } from './all-args.ts';

describe('eval:all value-required flags', () => {
  it('rejects bare --count instead of coercing boolean true to one trial', () => {
    expect(valueRequiredAllFlagError({ count: true })).toBe('--count requires a value');
    expect(valueRequiredAllFlagError({ list: true, count: true })).toBe('--count requires a value');
  });

  it('rejects bare --scenarios instead of silently running the full registry', () => {
    expect(valueRequiredAllFlagError({ count: '1', scenarios: true })).toBe(
      '--scenarios requires a comma-separated value',
    );
  });

  it('accepts absent flags and string values for the CLI to validate normally', () => {
    expect(valueRequiredAllFlagError({})).toBeNull();
    expect(valueRequiredAllFlagError({ count: '1', scenarios: 'tictactoe,petshop' })).toBeNull();
  });
});

describe('eval:batch value-required flags', () => {
  it('rejects bare --count instead of coercing boolean true to one trial', () => {
    expect(valueRequiredBatchFlagError({ count: true })).toBe('--count requires a value');
  });

  it('accepts a string count for normal positive-integer validation', () => {
    expect(valueRequiredBatchFlagError({ count: '3' })).toBeNull();
  });
});
