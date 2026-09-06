import { describe, expect, it } from 'vitest';
import { resolveSuitesFlag, resolveSuitesForRun, suitesFlagFragment } from './scorecard-args.ts';

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

describe('eval:scorecard --suites on re-ingest', () => {
  it('inherits a narrowed run’s own suites when the flag is omitted', () => {
    // The trap this closes: `--ingest-only --run-id X` with no --suites
    // would rebuild a core+productivity run as a four-suite one, claiming
    // developer/complex-work cells that were never measured.
    const r = resolveSuitesForRun(undefined, DEFAULTS, ['core', 'productivity']);
    expect(r.suites).toEqual(['core', 'productivity']);
    expect(r.inherited).toBe(true);
  });

  it('falls back to the full set for a run the dataset has never seen', () => {
    const r = resolveSuitesForRun(undefined, DEFAULTS, undefined);
    expect(r.suites).toEqual([...DEFAULTS]);
    expect(r.inherited).toBeUndefined();
  });

  it('lets an explicit flag widen or change a recorded scope', () => {
    const r = resolveSuitesForRun('core,developer', DEFAULTS, ['core', 'productivity']);
    expect(r.suites).toEqual(['core', 'developer']);
    expect(r.inherited).toBeUndefined();
  });

  it('still rejects a bad value even when a prior scope exists', () => {
    expect(resolveSuitesForRun('bogus', DEFAULTS, ['core']).error).toContain('unknown suite(s)');
  });
});
