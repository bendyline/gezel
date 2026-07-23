/**
 * Coverage for the reasoning-strip behaviors. Each behavior runs
 * against fixtures sourced from the wild-caught patterns the legacy
 * `extractReasoning()` was tested against — same patterns, narrower
 * scope per behavior.
 */

import { describe, expect, it } from 'vitest';
import { ReasoningStripChannelTags } from './reasoning-strip-channel-tags.js';
import { ReasoningStripThinkTags } from './reasoning-strip-think-tags.js';

describe('ReasoningStripThinkTags', () => {
  const cap = ReasoningStripThinkTags.captureReasoning!;

  it('captures a closed <think> pair', () => {
    const out = cap(
      '<think>plan: do X</think>final answer',
      undefined as never,
      undefined as never,
    );
    expect(out.visible).toBe('final answer');
    expect(out.reasoning).toBe('plan: do X');
  });

  it('captures a closed <reasoning> pair', () => {
    const out = cap('<reasoning>r1</reasoning>visible', undefined as never, undefined as never);
    expect(out.visible).toBe('visible');
    expect(out.reasoning).toBe('r1');
  });

  it('captures the leading-close shape (Qwen 3.6 enable_thinking=True)', () => {
    const out = cap(
      'reasoning prose...</think>\nthe visible reply',
      undefined as never,
      undefined as never,
    );
    expect(out.visible).toBe('the visible reply');
    expect(out.reasoning).toBe('reasoning prose...');
  });

  it('strips stray bare <think> tags left over from partial emissions', () => {
    const out = cap('<think>stuff</think>visible<think>', undefined as never, undefined as never);
    expect(out.visible).toBe('visible');
    expect(out.reasoning).toBe('stuff');
  });

  it('returns input unchanged when no markup is present', () => {
    const out = cap('plain reply', undefined as never, undefined as never);
    expect(out.visible).toBe('plain reply');
    expect(out.reasoning).toBe('');
  });

  it('joins multiple captured blocks with a blank line', () => {
    const out = cap(
      '<think>A</think>middle<think>B</think>end',
      undefined as never,
      undefined as never,
    );
    expect(out.visible).toBe('middleend');
    expect(out.reasoning).toBe('A\n\nB');
  });

  it('does NOT touch <|channel|> markers (that belongs to strip-channel-tags)', () => {
    const out = cap(
      '<|channel|>analysis<|message|>r1<|end|>visible',
      undefined as never,
      undefined as never,
    );
    expect(out.visible).toContain('<|channel|>');
    expect(out.reasoning).toBe('');
  });
});

describe('ReasoningStripChannelTags', () => {
  const cap = ReasoningStripChannelTags.captureReasoning!;

  it('captures the canonical `<|channel|>analysis<|message|>...<|end|>` shape', () => {
    const out = cap(
      '<|channel|>analysis<|message|>plan: X<|end|>visible',
      undefined as never,
      undefined as never,
    );
    expect(out.visible).toBe('visible');
    expect(out.reasoning).toBe('plan: X');
  });

  it('captures the asymmetric `<|channel>NAME\\n...<channel|>` shape', () => {
    const out = cap(
      '<|channel>thought\nplan: Y<channel|>visible reply',
      undefined as never,
      undefined as never,
    );
    expect(out.visible).toBe('visible reply');
    expect(out.reasoning).toContain('plan: Y');
  });

  it('captures the dropped-pipe `<channel>NAME\\n...<channel|>` Gemma 4 26B variant', () => {
    const out = cap(
      '<channel>thought\nweighing options<channel|>final answer',
      undefined as never,
      undefined as never,
    );
    expect(out.visible).toBe('final answer');
    expect(out.reasoning).toContain('weighing options');
  });

  it('captures the bracket-loss `NAME|>BODY|<end|>` Gemma 4 E4B llama.cpp variant', () => {
    // Wild-caught: the detokenizer drops the `<` from `<|channel|>` and
    // the leading `|` from `<|end|>`, leaving just the channel name +
    // the `|>` tail of `<|message|>` as the opener and `<end|>` as the
    // close. The body often spans multiple paragraphs, so the existing
    // bare-pipe-then-paragraph-break pattern only caught the first one.
    const body = [
      'The user has approved the high-level direction.',
      '',
      'I will create a detailed mechanics document covering Combat,',
      'Resource Management, and Progression.',
    ].join('\n');
    const out = cap(
      `analysis|>${body}|<end|>The visible reply.`,
      undefined as never,
      undefined as never,
    );
    expect(out.visible).toBe('The visible reply.');
    expect(out.reasoning).toContain('approved the high-level direction');
    expect(out.reasoning).toContain('Resource Management');
  });

  it('captures the unclosed bracket-loss `NAME|>BODY|` Gemma 4 E4B llama.cpp variant', () => {
    // Wild-caught from Sakura on Gemma 4 E4B (llama.cpp): the prompt
    // asked for `<|channel|>analysis<|message|>...<|end|>`, but the
    // detokenizer returned `analysis|>...|` with no `<end|>` close.
    // Treat the end-anchored block as reasoning instead of letting it
    // become the persisted visible reply.
    const body = [
      "I need to find three high-impact bugs in the 'squisq' repository.",
      '',
      'I will use `search_files` on the main `packages/core/src` directory.',
      '',
      "I'll run a search for `try...catch` blocks that might be too general.",
    ].join('\n');
    const out = cap(`analysis|>${body}|`, undefined as never, undefined as never);
    expect(out.visible).toBe('');
    expect(out.reasoning).toContain('three high-impact bugs');
    expect(out.reasoning).toContain('packages/core/src');
    expect(out.reasoning).not.toContain('analysis|>');
  });

  it('captures the bare-pipe closed `NAME|\\nBODY</|end|>` Gemma 4 E4B variant', () => {
    // Wild-caught from Gemma 4 E4B (llama.cpp): the opener lost both
    // the angle brackets and the `<|message|>` tail, while the close
    // decoded as `</|end|>`. It is still the private analysis channel.
    const body = [
      'The user requested a code review and fix for three identified bugs.',
      '',
      'I will execute these three fixes using `writeFile` in a single turn.',
    ].join('\n');
    const out = cap(`analysis|\n${body}\n</|end|>Visible.`, undefined as never, undefined as never);
    expect(out.visible).toBe('Visible.');
    expect(out.reasoning).toContain('three identified bugs');
    expect(out.reasoning).toContain('single turn');
    expect(out.reasoning).not.toContain('analysis|');
    expect(out.reasoning).not.toContain('</|end|>');
  });

  it('cleans up bracket-loss residue when the opener was already stripped but `<end|>` remains', () => {
    // Defensive: if some upstream pass already removed the `analysis|>`
    // opener but left the `<end|>` close, the forgiving end-tag strip
    // should still drop the orphan marker rather than leak it.
    const out = cap('the real reply<end|>', undefined as never, undefined as never);
    expect(out.visible).toBe('the real reply');
  });

  it('strips stray bare channel markers left over', () => {
    const out = cap('visible<|channel|>', undefined as never, undefined as never);
    expect(out.visible).toBe('visible');
  });

  it('returns input unchanged when no channel markup is present', () => {
    const out = cap('plain reply', undefined as never, undefined as never);
    expect(out.visible).toBe('plain reply');
    expect(out.reasoning).toBe('');
  });

  it('does NOT touch <think> tags (that belongs to strip-think-tags)', () => {
    const out = cap('<think>prose</think>visible', undefined as never, undefined as never);
    expect(out.visible).toContain('<think>');
    expect(out.reasoning).toBe('');
  });

  it('promotes bare `thought` line leaks to a `_Thinking…_` mode indicator', () => {
    // Gemma 4 26B failure mode: model emits the bare channel name on
    // its own line, sometimes 50+ times in a row, with no surrounding
    // tag markup. Without promotion these bleed into the visible bubble
    // exactly as the model emitted them.
    const input = ['thought', 'thought', 'thought', 'real visible content'].join('\n');
    const out = cap(input, undefined as never, undefined as never);
    expect(out.visible).toContain('_Thinking…_');
    expect(out.visible).toContain('real visible content');
    // 50 thoughts collapse to ONE indicator, not 50.
    expect(out.visible.match(/_Thinking…_/g)?.length ?? 0).toBe(1);
    // The bare word `thought` shouldn't survive on its own line.
    expect(out.visible.split('\n').filter((l) => l.trim() === 'thought')).toHaveLength(0);
  });

  it('promotes other channel-name leaks to their corresponding mode indicator', () => {
    expect(cap('analysis\nrest', undefined as never, undefined as never).visible).toContain(
      '_Analyzing…_',
    );
    expect(cap('commentary\nrest', undefined as never, undefined as never).visible).toContain(
      '_Reflecting…_',
    );
  });

  it('drops bare `final` markers (it just signals "the real reply starts here")', () => {
    const out = cap('final\nthe answer', undefined as never, undefined as never);
    expect(out.visible).toBe('the answer');
  });

  it('emits a fresh indicator after real content even if the same channel repeats', () => {
    const input = ['thought', 'first reply', 'thought', 'thought', 'second reply'].join('\n');
    const out = cap(input, undefined as never, undefined as never);
    expect(out.visible.match(/_Thinking…_/g)?.length ?? 0).toBe(2);
  });
});
