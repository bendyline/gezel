import { describe, expect, it } from 'vitest';
import { GATE_SCRIPT_FIXTURES } from './gate-fixtures.js';
import { evaluateGateScripts, withSdkImportHint } from './gate-scripts.js';

describe('evaluateGateScripts', () => {
  it.each(GATE_SCRIPT_FIXTURES.map((f) => [f.name, f] as const))('%s', async (_name, fixture) => {
    const refs = fixture.runs.map((_run, index) => ({ name: `gate-${index}` }));
    let cursor = 0;
    const outcome = await evaluateGateScripts(refs, async () => {
      const run = fixture.runs[cursor++]!;
      if (run === 'throws') throw new Error('sandbox unavailable');
      if (run === 'skipped') return 'skipped';
      return { id: `r${cursor}`, ...run };
    });
    expect(outcome.decision).toBe(fixture.expect.decision);
    expect(outcome.goto).toBe(fixture.expect.goto);
    expect(outcome.infrastructureError).toBe(fixture.expect.infrastructureError);
    expect(outcome.skipped).toHaveLength(fixture.expect.skipped);
    if (fixture.expect.message) expect(outcome.message).toBe(fixture.expect.message);
  });

  it('faults on a route to a step the task does not declare, when told the steps', async () => {
    const outcome = await evaluateGateScripts(
      [{ name: 'router' }],
      async () => ({ status: 'ok', output: { decision: 'approve', goto: 'ghost' } }),
      { steps: [{ id: 'build' }, { id: 'done' }] },
    );
    expect(outcome).toMatchObject({ decision: 'reject', infrastructureError: true });
    expect(outcome.message).toMatch(/not a declared task step/);
  });

  it('names where a misplaced SDK import lives', () => {
    expect(withSdkImportHint("does not provide an export named 'gateResult'")).toContain(
      '@bendyline/gezel-sdk/checks',
    );
    expect(withSdkImportHint('boom')).toBe('boom');
  });
});
