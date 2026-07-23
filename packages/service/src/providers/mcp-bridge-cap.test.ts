import { describe, expect, it } from 'vitest';
import {
  CAP_TOOL_OUTPUT_HARD_FLOOR,
  MAX_TOOL_OUTPUT_CHARS,
  MIN_TOOL_OUTPUT_CHARS,
  capToolOutput,
  computeToolBudgetChars,
} from './mcp-bridge.js';

/**
 * Unit tests for the tool-output cap helper. The full bridge test
 * spawns a real MCP child and is heavier; these sit alongside as a
 * direct check on the truncation contract.
 *
 * Context for the cap: a single tool call (e.g. `fetch_url` against a
 * modern web page) can return hundreds of KB of HTML that would blow
 * any provider's context window on the very next tool-loop iteration.
 * See mcp-bridge.ts for the rationale header.
 */
describe('capToolOutput', () => {
  it('returns the input unchanged when under the cap', () => {
    const small = 'hello world';
    expect(capToolOutput(small)).toBe(small);
  });

  it('returns the input unchanged at exactly the cap', () => {
    const exact = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS);
    expect(capToolOutput(exact)).toBe(exact);
    expect(capToolOutput(exact).length).toBe(MAX_TOOL_OUTPUT_CHARS);
  });

  it('truncates and appends a footer when over the cap', () => {
    const over = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 1000);
    const capped = capToolOutput(over);
    expect(capped.length).toBeGreaterThan(MAX_TOOL_OUTPUT_CHARS);
    expect(capped.startsWith('x'.repeat(MAX_TOOL_OUTPUT_CHARS))).toBe(true);
    expect(capped).toContain('tool output truncated');
    expect(capped).toContain('1,000 additional chars dropped');
  });

  it('handles the pathological weather.com-sized case without exploding', () => {
    // Simulate a 500k-char dump — exactly the class of case that blew
    // the 131k context window on the user's first on-device tool call.
    const huge = 'a'.repeat(500_000);
    const capped = capToolOutput(huge);
    expect(capped.length).toBeLessThan(600_000);
    expect(capped).toContain('tool output truncated');
    expect(capped).toContain(`${(500_000 - MAX_TOOL_OUTPUT_CHARS).toLocaleString('en-US')}`);
  });

  it('handles empty input', () => {
    expect(capToolOutput('')).toBe('');
  });

  it('accepts a custom (smaller) maxChars and truncates to it', () => {
    const text = 'x'.repeat(30_000);
    const capped = capToolOutput(text, 20_000);
    expect(capped.length).toBeGreaterThan(20_000); // header + footer
    expect(capped.startsWith('x'.repeat(20_000))).toBe(true);
    expect(capped).toContain('10,000 additional chars dropped');
  });

  it('clamps a too-small budget up to the HARD_FLOOR (not MIN)', () => {
    // Previous behavior clamped UP to MIN_TOOL_OUTPUT_CHARS (8K)
    // unconditionally — that's how a sub-MIN budget could push the
    // running transcript past `numCtx` on tight-context sessions
    // (the model called a tool with 200 chars of headroom and got
    // back 8K chars of payload anyway). Now we floor at the much
    // smaller HARD_FLOOR (500 chars) and switch the footer to a
    // "context window is nearly full" guidance so the model knows
    // to refine.
    const text = 'x'.repeat(30_000);
    const capped = capToolOutput(text, 100);
    expect(capped.startsWith('x'.repeat(CAP_TOOL_OUTPUT_HARD_FLOOR))).toBe(true);
    // Should NOT have been forced up to MIN_TOOL_OUTPUT_CHARS.
    expect(capped.indexOf('x'.repeat(MIN_TOOL_OUTPUT_CHARS))).toBe(-1);
    // Footer says "context tight" because budget was below MIN.
    expect(capped).toContain('context window is nearly full');
  });

  it('uses the normal "context protected" footer when budget is between MIN and MAX', () => {
    const text = 'x'.repeat(30_000);
    const capped = capToolOutput(text, 20_000);
    expect(capped).toContain('context window protected');
    expect(capped).not.toContain('context window is nearly full');
  });

  it('clamps an oversized budget down to MAX_TOOL_OUTPUT_CHARS', () => {
    // Caller passing a generous budget on a huge-ctx model shouldn't
    // be able to raise the hard ceiling — fetching 5 MB of a web
    // page and shoving it at a 128K model would still be a mistake.
    const text = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 500_000);
    const capped = capToolOutput(text, 10_000_000);
    expect(capped.startsWith('x'.repeat(MAX_TOOL_OUTPUT_CHARS))).toBe(true);
  });
});

describe('computeToolBudgetChars', () => {
  it('reserves 25% of numCtx for the assistant response and next turn', () => {
    // Empty transcript, 32K ctx → 75% × 32_768 tokens × 4 chars/token
    // = 98_304 chars of headroom. The bridge will clamp to
    // MAX_TOOL_OUTPUT_CHARS (80_000) on slice; we return raw so
    // the adaptive semantics stay visible for other callers.
    const budget = computeToolBudgetChars(32_768, 0);
    expect(budget).toBe(Math.floor(32_768 * 0.75) * 4);
  });

  it('shrinks as the transcript grows', () => {
    const small = computeToolBudgetChars(16_384, 0);
    const med = computeToolBudgetChars(16_384, 20_000);
    const large = computeToolBudgetChars(16_384, 40_000);
    expect(small).toBeGreaterThan(med);
    expect(med).toBeGreaterThan(large);
  });

  it('clamps at zero when the transcript is already over the working ratio', () => {
    // 16K ctx × 0.75 = 12_288 usable tokens = 49_152 chars of head-
    // room total. If the transcript alone is 200K chars (~50K
    // tokens), we're already over; return 0 rather than a negative
    // budget. `capToolOutput`'s floor rescues the actual slice.
    const budget = computeToolBudgetChars(16_384, 200_000);
    expect(budget).toBe(0);
  });

  it('yields a workable budget for the weather.com overflow case', () => {
    // Post-Layer-1 shape: same model, but effectiveNumCtx is now
    // 32K (catalog-aware), and the transcript heading into the
    // fetch_url call is ~12K tokens (system + recall + history).
    // Adaptive budget should reserve plenty of room for the tool
    // result *without* blowing the window.
    const preToolChars = 12_000 * 4; // 12K tokens → ~48K chars
    const budget = computeToolBudgetChars(32_768, preToolChars);
    // 32K × 0.75 = 24_576 usable tokens; 12K already consumed →
    // ~12_576 remaining tokens → ~50_304 chars of headroom.
    const budgetTokens = budget / 4;
    expect(budgetTokens).toBeGreaterThan(10_000);
    expect(budgetTokens).toBeLessThan(32_768 - 12_000);
    // capToolOutput enforces its own ceiling (MAX_TOOL_OUTPUT_CHARS),
    // so the slice returned to the model is bounded even when the
    // raw budget exceeds it.
    const slice = capToolOutput('y'.repeat(500_000), budget);
    expect(slice.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS + 500); // + footer slop
  });

  it('falls back to the HARD_FLOOR when the transcript already over-fills the budget', () => {
    // The pathological case: prompt already > 75% × numCtx. Budget
    // returns 0; capToolOutput floors to HARD_FLOOR (500 chars) so
    // the model still sees a small sentinel + a "context tight"
    // footer rather than getting forced to 8K and overflowing the
    // window. The previous floor (MIN_TOOL_OUTPUT_CHARS, 8K) was
    // the bug this catches.
    const budget = computeToolBudgetChars(16_384, 200_000);
    expect(budget).toBe(0);
    const slice = capToolOutput('y'.repeat(500_000), budget);
    expect(slice.length).toBeGreaterThanOrEqual(CAP_TOOL_OUTPUT_HARD_FLOOR);
    // Crucially, NOT 8K — the old behavior would have forced 8K
    // chars through and pushed the transcript past numCtx.
    expect(slice.indexOf('y'.repeat(MIN_TOOL_OUTPUT_CHARS))).toBe(-1);
    expect(slice).toContain('context window is nearly full');
  });
});

describe('capToolOutput — context-aware ceiling', () => {
  it('honors numCtxTokens to compute a tighter ceiling for small-context models', () => {
    // 4K-context model: usable = 0.75 × 4096 = 3072 tokens × 4
    // chars/token = 12_288 chars. A caller asking for 80K chars
    // (or no budget at all) shouldn't be allowed to land 80K of
    // payload on a model that can only hold 16K total.
    const huge = 'z'.repeat(500_000);
    const capped = capToolOutput(huge, MAX_TOOL_OUTPUT_CHARS, { numCtxTokens: 4_096 });
    // Cap should be ~12K, not 80K.
    const expectedCap = Math.floor(4_096 * 0.75 * 4);
    expect(capped.startsWith('z'.repeat(expectedCap))).toBe(true);
    expect(capped.indexOf('z'.repeat(MAX_TOOL_OUTPUT_CHARS))).toBe(-1);
  });

  it('keeps the 80K ceiling on large-context models (no extra clamp)', () => {
    // 32K context model: usable = 0.75 × 32768 = 24576 tokens × 4
    // chars/token = 98304 chars. The numCtx-derived ceiling is
    // bigger than MAX_TOOL_OUTPUT_CHARS (80K), so the absolute cap
    // wins.
    const huge = 'z'.repeat(500_000);
    const capped = capToolOutput(huge, MAX_TOOL_OUTPUT_CHARS, { numCtxTokens: 32_768 });
    expect(capped.startsWith('z'.repeat(MAX_TOOL_OUTPUT_CHARS))).toBe(true);
  });

  it('ignores numCtxTokens=0 / undefined (defaults to MAX)', () => {
    const huge = 'z'.repeat(500_000);
    const a = capToolOutput(huge, MAX_TOOL_OUTPUT_CHARS, { numCtxTokens: 0 });
    const b = capToolOutput(huge, MAX_TOOL_OUTPUT_CHARS);
    expect(a.startsWith('z'.repeat(MAX_TOOL_OUTPUT_CHARS))).toBe(true);
    expect(b.startsWith('z'.repeat(MAX_TOOL_OUTPUT_CHARS))).toBe(true);
  });

  // A failed script run stamps `✗ … failed (exit N)` then a huge stdout then
  // the stderr — the bytes the model needs to fix it. A plain head-keep would
  // drop the stderr tail (the data-wrangle blind-debug loop). The cap must
  // preserve the head (exit marker) AND the error tail within the budget.
  it('preserves the exit marker AND the stderr tail when a failed-exec output is truncated', () => {
    const head = `✗ run_nodejs_script failed (exit 1)\nstdout:\n${'L'.repeat(20_000)}`;
    const tail =
      '\nstderr:\nTypeError: cannot read x of undefined\n    at /scripts/normalize.ts:42:10';
    const capped = capToolOutput(head + tail, 4000);
    expect(capped).toContain('✗ run_nodejs_script failed (exit 1)'); // head (exit reason)
    expect(capped).toContain('TypeError: cannot read x of undefined'); // error tail kept
    expect(capped).toContain('normalize.ts:42:10');
    expect(capped).toContain('middle truncated');
    expect(capped.length).toBeLessThan(4000 + 400); // still bounded by the budget
  });

  it('preserves the tail on a timed-out exec, too', () => {
    const out = `✗ run_npx timed out\nstdout:\n${'S'.repeat(30_000)}\nstderr:\nKilled after 600s`;
    const capped = capToolOutput(out, 5000);
    expect(capped).toContain('✗ run_npx timed out');
    expect(capped).toContain('Killed after 600s');
  });

  it('a non-failure output still head-keeps (unchanged contract for reads/fetches)', () => {
    const capped = capToolOutput('a'.repeat(20_000), 4000);
    expect(capped.startsWith('a'.repeat(4000))).toBe(true);
    expect(capped).toContain('tool output truncated');
    expect(capped).not.toContain('middle truncated');
  });
});
