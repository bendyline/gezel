import { describe, expect, it } from 'vitest';
import { promoteBareChannelNames } from './promote-channel-names.js';

describe('promoteBareChannelNames', () => {
  it('returns input unchanged when no bare channel names appear', () => {
    expect(promoteBareChannelNames('plain reply')).toBe('plain reply');
    expect(promoteBareChannelNames('')).toBe('');
  });

  it('promotes a single bare `thought` line to a `_Thinking…_` indicator', () => {
    expect(promoteBareChannelNames('thought\nreal content')).toBe('_Thinking…_\nreal content');
  });

  it('collapses runs of `thought` to a single indicator', () => {
    const input = ['thought', 'thought', 'thought', 'real content'].join('\n');
    expect(promoteBareChannelNames(input).match(/_Thinking…_/g)?.length ?? 0).toBe(1);
  });

  it('maps each known channel name to its corresponding indicator', () => {
    expect(promoteBareChannelNames('analysis\nrest')).toContain('_Analyzing…_');
    expect(promoteBareChannelNames('commentary\nrest')).toContain('_Reflecting…_');
  });

  it('drops bare `final` markers entirely', () => {
    expect(promoteBareChannelNames('final\nthe answer')).toBe('the answer');
  });

  it('emits a fresh indicator after real content', () => {
    const input = ['thought', 'first reply', 'thought', 'thought', 'second reply'].join('\n');
    expect(promoteBareChannelNames(input).match(/_Thinking…_/g)?.length ?? 0).toBe(2);
  });

  it('is case-insensitive', () => {
    expect(promoteBareChannelNames('THOUGHT\nrest')).toContain('_Thinking…_');
    expect(promoteBareChannelNames('Analysis\nrest')).toContain('_Analyzing…_');
  });

  it('ignores lines where the channel name is part of larger content', () => {
    // "thought" embedded in a sentence is not a bare leak; leave it alone.
    expect(promoteBareChannelNames('I thought about this')).toBe('I thought about this');
  });

  it('preserves blank lines verbatim and treats them as part of the same run', () => {
    // Blank lines don't reset the run state — only real content does.
    // Two `thought` markers separated by a blank line still collapse to
    // ONE indicator. This matches the model's intent: a brief gap in
    // emission is still the same thinking phase, not a fresh one.
    expect(promoteBareChannelNames('thought\n\nthought\nrest')).toBe('_Thinking…_\n\nrest');
  });

  it("splits the inline `analysisI've reviewed...` leak into a mode indicator + content", () => {
    // Wild-caught from Gemma 4 26B emitting `analysis<|message|>I've
    // reviewed...` without a newline between the channel name and the
    // body. The bubble would otherwise show `analysisI've reviewed...`
    // run together as a single ugly word.
    const out = promoteBareChannelNames("analysisI've reviewed the task and the workspace.");
    expect(out).toBe("_Analyzing…_\nI've reviewed the task and the workspace.");
  });

  it('splits inline `thoughtThe user…` leaks too', () => {
    const out = promoteBareChannelNames('thoughtThe user wants a tank game.');
    expect(out).toBe('_Thinking…_\nThe user wants a tank game.');
  });

  it('does NOT split real English words like `thoughtful` or `analysis-and-review`', () => {
    // Lowercase letter immediately after the channel name → no split.
    expect(promoteBareChannelNames('thoughtful design choices')).toBe('thoughtful design choices');
    // Hyphen → no split (not `[A-Z]`).
    expect(promoteBareChannelNames('analysis-and-review pass')).toBe('analysis-and-review pass');
  });

  it('handles inline leak followed by run of bare-name lines', () => {
    // `analysisI've reviewed\nthought\nthought\nthe rest` — the inline
    // `analysis` becomes `_Analyzing…_`, the bare `thought` runs collapse
    // to one `_Thinking…_`. Both modes show as separate indicators
    // because they're different channels.
    const input = ["analysisI've reviewed", 'thought', 'thought', 'the rest'].join('\n');
    const out = promoteBareChannelNames(input);
    expect(out).toContain('_Analyzing…_');
    expect(out).toContain('_Thinking…_');
    expect(out).toContain("I've reviewed");
    expect(out).toContain('the rest');
  });
});
