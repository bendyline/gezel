import { describe, expect, it } from 'vitest';
import { stepToolKit } from './step-kit.js';

describe('stepToolKit gate-driven additions', () => {
  // 1.26300.100 audit: the nine Gilde code books' repair steps must show a
  // test run, but named the runner only in an "if it is not among your tools"
  // note. The kit dropped it, so a local model could never pass the step.
  it('gives a commandEvidence step the runner its receipt comes from', () => {
    const kit = (check: Record<string, unknown>) =>
      stepToolKit({
        advanceWhen: { file: 'src/fix.ts' },
        gate: { at: 'completion', checks: [{ kind: 'commandEvidence', expect: 'pass', ...check }] },
      } as Parameters<typeof stepToolKit>[0]);
    const script = kit({ script: 'test' });
    expect(script?.tools.has('run_package_script')).toBe(true);
    expect(script?.tools.has('run_npx')).toBe(false);
    const bin = kit({ bin: 'vitest', args: ['run'] });
    expect(bin?.tools.has('run_npx')).toBe(true);
    expect(bin?.tools.has('run_package_script')).toBe(false);
  });
});
