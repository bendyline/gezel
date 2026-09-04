import { describe, expect, it } from 'vitest';
import { resolveSuitesFlag, suitesFlagFragment } from './scorecard-args.ts';

const DEFAULTS = ['core', 'productivity', 'developer', 'complex-work'] as const;

describe('eval:scorecard --suites', () => {
  it('defaults to the full sweep when the flag is absent', () => {
    expect(resolveSuitesFlag(undefined, DEFAULTS).suites).toEqual([...DEFAULTS]);
  });

  it('narrows to the requested suites, in the order given', () => {
    expect(resolveSuitesFlag('productivity,core', DEFAULTS).suites).toEqual([
      'productivity',
      'core',
    ]);
  });

  it('rejects an unknown id rather than silently dropping that cell', () => {
    const result = resolveSuitesFlag('core,bogus', DEFAULTS);
    expect(result.suites).toBeUndefined();
    expect(result.error).toContain('unknown suite(s): bogus');
  });

  it('rejects the bare-flag boolean sentinel instead of measuring nothing', () => {
    expect(resolveSuitesFlag(true, DEFAULTS).error).toContain('--suites requires');
    expect(resolveSuitesFlag('   ', DEFAULTS).error).toContain('--suites requires');
    expect(resolveSuitesFlag(',,', DEFAULTS).error).toContain('at least one suite id');
  });

  it('dedupes so a repeated id cannot run a cell twice under one run', () => {
    expect(resolveSuitesFlag('core,core,productivity', DEFAULTS).suites).toEqual([
      'core',
      'productivity',
    ]);
  });
});

describe('eval:scorecard resume hints', () => {
  it('omits the fragment for a default sweep, whatever the order', () => {
    expect(suitesFlagFragment([...DEFAULTS], DEFAULTS)).toBe('');
    expect(suitesFlagFragment([...DEFAULTS].reverse(), DEFAULTS)).toBe('');
  });

  it('carries the fragment for a narrowed sweep, so resuming stays narrowed', () => {
    expect(suitesFlagFragment(['core', 'productivity'], DEFAULTS)).toBe(
      ' --suites core,productivity',
    );
  });
});
