import { describe, expect, it } from 'vitest';
import { StreamingReasoningSplit, templateTextOpensReasoning } from './reasoning-stream.js';

/** Drive a split across arbitrary chunk boundaries and total the two channels. */
function run(
  chunks: string[],
  opts: { opensInReasoning: boolean; enabled?: boolean },
): { visible: string; reasoning: string } {
  const split = new StreamingReasoningSplit(opts);
  let visible = '';
  let reasoning = '';
  for (const chunk of chunks) {
    const out = split.push(chunk);
    visible += out.visible;
    reasoning += out.reasoning;
  }
  const tail = split.flush();
  return { visible: visible + tail.visible, reasoning: reasoning + tail.reasoning };
}

describe('templateTextOpensReasoning', () => {
  it('detects a generation prompt that opens thinking for the model', () => {
    // The real LFM2.5 / Qwen shape: the last thing the template emits is a
    // bare opener, so the model's output starts mid-reasoning.
    expect(
      templateTextOpensReasoning(
        '{%- if add_generation_prompt -%}{{- "<|im_start|>assistant\\n<think>" -}}{%- endif -%}',
      ),
    ).toBe(true);
  });

  it('ignores an opener that the template itself closes', () => {
    expect(
      templateTextOpensReasoning(
        '{%- if add_generation_prompt -%}{{- "<|im_start|>assistant\\n<think>\\n</think>\\n" -}}{%- endif -%}',
      ),
    ).toBe(false);
  });

  it('ignores openers outside the generation prompt', () => {
    // A replayed assistant turn may carry think tags; only the branch that
    // ends the prompt decides how the *next* turn starts.
    expect(
      templateTextOpensReasoning(
        '{%- for message in messages -%}{{- "<think>" + message.thinking + "</think>" -}}{%- endfor -%}' +
          '{%- if add_generation_prompt -%}{{- "<|im_start|>assistant\\n" -}}{%- endif -%}',
      ),
    ).toBe(false);
  });

  it('is false for a template with no generation prompt at all', () => {
    expect(templateTextOpensReasoning('{{ messages }}')).toBe(false);
  });
});

describe('StreamingReasoningSplit', () => {
  it('routes a template-opened block to reasoning and the reply to visible', () => {
    expect(
      run(['The user wants ', 'a greeting. ', '</think>', 'Hello!'], { opensInReasoning: true }),
    ).toEqual({ visible: 'Hello!', reasoning: 'The user wants a greeting. ' });
  });

  it('splits a close marker straddling a chunk boundary', () => {
    // The engine chunks on tokens, so `</think>` routinely arrives in pieces.
    expect(run(['thinking</th', 'ink>answer'], { opensInReasoning: true })).toEqual({
      visible: 'answer',
      reasoning: 'thinking',
    });
    expect(run(['thinking<', '/', 'think', '>', 'answer'], { opensInReasoning: true })).toEqual({
      visible: 'answer',
      reasoning: 'thinking',
    });
  });

  it('handles an explicit paired block when the template opens nothing', () => {
    expect(
      run(['Sure. ', '<think>', 'weighing it', '</think>', 'Done.'], { opensInReasoning: false }),
    ).toEqual({ visible: 'Sure. Done.', reasoning: 'weighing it' });
  });

  it('streams a plain reply untouched when no reasoning appears', () => {
    // The case that must never regress: a model that simply answers keeps
    // streaming token by token rather than being withheld.
    const split = new StreamingReasoningSplit({ opensInReasoning: false });
    expect(split.push('Hello ').visible).toBe('Hello ');
    expect(split.push('there').visible).toBe('there');
    expect(split.flush()).toEqual({ visible: '', reasoning: '' });
  });

  it('keeps an unclosed reasoning block out of the reply', () => {
    // Truncated mid-thought: promoting the buffer to visible would publish
    // exactly the chain-of-thought this exists to withhold.
    expect(run(['still thinking when the stream died'], { opensInReasoning: true })).toEqual({
      visible: '',
      reasoning: 'still thinking when the stream died',
    });
  });

  it('passes everything through when disabled', () => {
    expect(run(['<think>a</think>b'], { opensInReasoning: true, enabled: false })).toEqual({
      visible: '<think>a</think>b',
      reasoning: '',
    });
  });

  it('does not hold back text that merely looks like a marker start', () => {
    const split = new StreamingReasoningSplit({ opensInReasoning: false });
    // `<` could begin `<think>`, so it is held until the next chunk proves otherwise.
    expect(split.push('a < b').visible).toBe('a < b');
    expect(split.push('c').visible).toBe('c');
  });
});
