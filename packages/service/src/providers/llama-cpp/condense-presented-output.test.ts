import { describe, expect, it } from 'vitest';
import { condensePresentedToolOutput } from './condense-presented-output.js';

describe('already presented tool output', () => {
  it('distinguishes context shortening from an initially incomplete read', () => {
    const result = condensePresentedToolOutput(`SOURCE START ${'x'.repeat(4000)} SOURCE END`, 200);
    expect(result.length).toBeLessThanOrEqual(500);
    expect(result).toContain('after being presented');
    expect(result).toContain('Do not restart completed reads');
    expect(result).toContain('SOURCE START');
    expect(result).toContain('SOURCE END');
    expect(result).not.toContain('tool output truncated');
    expect(result).not.toContain('re-run');
  });
  it('never claims an initially truncated source was fully read', () => {
    const original = `${'x'.repeat(4000)}\n…[tool output truncated: 2,000 additional chars dropped; re-run with a narrower request]`;
    const result = condensePresentedToolOutput(original);
    expect(result).toContain('original response was also truncated; unread content may remain');
    expect(result).not.toContain('fully read');
  });
  it('preserves an execution failure header and error tail', () => {
    const result = condensePresentedToolOutput(
      `✗ compile failed (exit 2)\n${'x'.repeat(4000)}\nSyntaxError: missing closing brace`,
    );
    expect(result).toContain('failed (exit 2)');
    expect(result).toContain('SyntaxError: missing closing brace');
  });
  it('keeps short responses unchanged and does not repeatedly shorten its own notice', () => {
    expect(condensePresentedToolOutput('Read completed.')).toBe('Read completed.');
    const first = condensePresentedToolOutput('x'.repeat(4000));
    expect(condensePresentedToolOutput(first)).toBe(first);
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 200, 500, 1000])(
    'bounds excerpts for budget %s',
    (budget) => {
      const result = condensePresentedToolOutput('x'.repeat(4000), budget);
      expect(result.length).toBeLessThanOrEqual(
        Number.isFinite(budget) ? Math.max(500, budget) : 500,
      );
    },
  );
});
