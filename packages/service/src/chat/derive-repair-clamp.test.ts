import { describe, expect, it } from 'vitest';
import {
  buildDeriveRepairClampNudge,
  deriveRepairClampEnabled,
  deriveRepairClampNudge,
} from './manager.js';

describe('deriveRepairClampNudge (L2, gated behind GEZEL_DERIVE_REPAIR_CLAMP)', () => {
  const on = { GEZEL_DERIVE_REPAIR_CLAMP: '1' } as NodeJS.ProcessEnv;
  const off = {} as NodeJS.ProcessEnv;
  const verdict = 'The 3rd record has a total that does not match its line items.';

  it('reads the enable flag (default OFF)', () => {
    expect(deriveRepairClampEnabled(on)).toBe(true);
    expect(deriveRepairClampEnabled(off)).toBe(false);
  });

  it('fires for a derived-data output path when the flag is ON', () => {
    const nudge = deriveRepairClampNudge({ filePath: 'data/out.csv', failingVerdict: verdict }, on);
    expect(nudge).not.toBeNull();
    expect(nudge).toContain('derive_file');
    expect(nudge).toContain('`data/out.csv`');
    expect(nudge).toContain(verdict);
    expect(nudge).toContain('hand-typing');
  });

  it('fires for a .json deliverable too', () => {
    expect(
      deriveRepairClampNudge({ filePath: 'result.json', failingVerdict: verdict }, on),
    ).not.toBeNull();
  });

  it('does NOT fire when the flag is OFF (shipped behavior unchanged)', () => {
    expect(
      deriveRepairClampNudge({ filePath: 'data/out.csv', failingVerdict: verdict }, off),
    ).toBeNull();
  });

  it('does NOT fire for a non-derived-data output path (e.g. a markdown report)', () => {
    expect(
      deriveRepairClampNudge({ filePath: 'report.md', failingVerdict: verdict }, on),
    ).toBeNull();
  });

  it('does NOT fire when no output path is known', () => {
    expect(deriveRepairClampNudge({ failingVerdict: verdict }, on)).toBeNull();
  });

  it('nudge leads with the failing verdict and points at the compute channel', () => {
    const nudge = buildDeriveRepairClampNudge('x.ndjson', verdict);
    expect(nudge.startsWith(verdict)).toBe(true);
    expect(nudge).toContain('derive_file');
    expect(nudge).toContain('`x.ndjson`');
    expect(nudge).toContain('fs.readFileSync');
  });
});
