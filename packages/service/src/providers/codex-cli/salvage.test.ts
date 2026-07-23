import { describe, expect, it } from 'vitest';
import { salvageAgentMessage } from './salvage.js';

describe('salvageAgentMessage', () => {
  it("strips the canonical 'reasoning leaked into agent_message' shape", () => {
    const raw = [
      '<mcp__gezel__ask_specialist  cringe? wait tool call name must commentary.',
      '',
      'I can do that, but the review handoff was cancelled before the reviewer could inspect the code.',
      '',
      'If you want, send "go ahead" and I\'ll route a focused reviewer.',
    ].join('\n');
    const out = salvageAgentMessage(raw);
    expect(out).toBe(
      [
        'I can do that, but the review handoff was cancelled before the reviewer could inspect the code.',
        '',
        'If you want, send "go ahead" and I\'ll route a focused reviewer.',
      ].join('\n'),
    );
  });

  it('strips multi-line garbage in the leading draft, as long as a blank line follows', () => {
    const raw = [
      '<mcp__gezel__ask_specialist',
      "ugh wait this isn't how I do it.",
      '',
      'Real reply text here.',
    ].join('\n');
    const out = salvageAgentMessage(raw);
    expect(out).toBe('Real reply text here.');
  });

  it('preserves text that starts normally — no leading `<server__tool` pattern', () => {
    const raw = 'Hello! Here is the code:\n\n```ts\nconst x = 1;\n```';
    expect(salvageAgentMessage(raw)).toBe(raw);
  });

  it('preserves text whose leading line is a well-formed XML/JSX-like tag (not a draft)', () => {
    const raw =
      '<mcp__gezel__ask_specialist role="reviewer">payload</mcp__gezel__ask_specialist>\n\nfollow-up';
    expect(salvageAgentMessage(raw)).toBe(raw);
  });

  it('preserves leading lines that look like JSX with single-word identifiers (no __ separator)', () => {
    // JSX `<Card>` is NOT a tool-call shape — no `__` separator. Real
    // assistant replies that quote a component should pass through.
    const raw = '<Card title="Hi">\n  ...\n</Card>\n\nMore text.';
    expect(salvageAgentMessage(raw)).toBe(raw);
  });

  it('returns unchanged when the leak is the entire message (no real reply to fall back on)', () => {
    // If stripping would leave nothing, the leak IS the assistant
    // text — better to surface the garbled output than erase the
    // whole turn.
    const raw = '<mcp__gezel__ask_specialist  cringe? wait tool call name must commentary.';
    expect(salvageAgentMessage(raw)).toBe(raw);
  });

  it('returns unchanged when there is no paragraph break (single-block message starting with a draft-looking token)', () => {
    // A single block — no blank line. We don't strip without a safe
    // anchor below, even if the leading shape matches.
    const raw = '<mcp__gezel__ask_specialist\nbut also followed-up text here without a blank line.';
    expect(salvageAgentMessage(raw)).toBe(raw);
  });

  it('handles empty input', () => {
    expect(salvageAgentMessage('')).toBe('');
  });

  it('handles whitespace-only tail (no real reply) by leaving the input alone', () => {
    const raw = '<mcp__gezel__ask_specialist nope\n\n   \n\t';
    expect(salvageAgentMessage(raw)).toBe(raw);
  });

  it('matches drafts namespaced without the `mcp__` prefix too (e.g. `<server__tool>`)', () => {
    // gpt-5.5 occasionally drops the `mcp__` prefix when drafting.
    // Pattern is still distinctive enough: lowercase ident + `__` +
    // lowercase ident.
    const raw = '<gezel__ask_specialist whoops\n\nreal answer here.';
    expect(salvageAgentMessage(raw)).toBe('real answer here.');
  });
});
