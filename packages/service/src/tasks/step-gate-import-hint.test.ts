import { describe, expect, it } from 'vitest';
import { withSdkImportHint } from './step-gate.js';

/**
 * A gate script needs two imports — `defineScript`/`gezel` from the SDK
 * root, the check predicates and `gateResult` from `/checks` — and the
 * bare runtime error names the missing symbol without saying where it
 * lives.
 *
 * Wild-caught on the first frontier run of `craftbook-author-gate-script`:
 * claude-sonnet-4-6 imported `defineScript` from `/checks`, hit the
 * identical SyntaxError three times across two tasks, and paused rather
 * than moving the import. Repair-message fidelity is the difference between
 * a one-line correction and an abandoned run.
 */
describe('withSdkImportHint', () => {
  const wrongSubpath =
    "SyntaxError: The requested module '@bendyline/gezel-sdk/checks' does not provide an export named 'defineScript'";

  it('names where a root-only symbol actually lives', () => {
    const hinted = withSdkImportHint(wrongSubpath);
    expect(hinted).toContain(wrongSubpath);
    expect(hinted).toContain('exported from "@bendyline/gezel-sdk"');
    // The fix a gate script actually needs is BOTH imports, so show both.
    expect(hinted).toContain("from '@bendyline/gezel-sdk/checks'");
  });

  it('names the checks subpath for a checks-only symbol', () => {
    const hinted = withSdkImportHint(
      "SyntaxError: The requested module '@bendyline/gezel-sdk' does not provide an export named 'gateResult'",
    );
    expect(hinted).toContain('exported from "@bendyline/gezel-sdk/checks"');
  });

  // A hint that fires on unrelated failures would dress every crash up as
  // an import problem and send the next attempt to the wrong place.
  it.each([
    'TypeError: Cannot read properties of undefined (reading length)',
    "SyntaxError: The requested module 'node:fs' does not provide an export named 'nope'",
    'timed out after 30000ms',
  ])('leaves %s unchanged', (error) => {
    expect(withSdkImportHint(error)).toBe(error);
  });
});
