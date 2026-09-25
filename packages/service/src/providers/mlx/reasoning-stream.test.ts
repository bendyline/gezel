import { describe, expect, it } from 'vitest';
import {
  requestOpensReasoning,
  StreamingReasoningSplit,
  templateTextOpensReasoning,
} from './reasoning-stream.js';

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
    // The real LFM2.5 shape: the last thing the template emits is a bare
    // opener, so the model's output starts mid-reasoning whatever it is sent.
    expect(
      templateTextOpensReasoning(
        '{%- if add_generation_prompt -%}{{- "<|im_start|>assistant\\n<think>" -}}{%- endif -%}',
      ),
    ).toBe('always');
  });

  it('marks an opener gated on enable_thinking as request-dependent', () => {
    // Qwen 3.8's shipped generation branch, verbatim.
    expect(
      templateTextOpensReasoning(
        "{%- if add_generation_prompt %}\n" +
          "    {{- '<|im_start|>assistant\\n' }}\n" +
          '    {%- if enable_thinking is defined and enable_thinking is false %}\n' +
          "        {{- '<think>\\n\\n</think>\\n\\n' }}\n" +
          '    {%- else %}\n' +
          "        {{- '<think>\\n' }}\n" +
          '    {%- endif %}\n' +
          '{%- endif %}',
      ),
    ).toBe('unless-thinking-off');
  });

  it('ignores an opener that the template itself closes', () => {
    expect(
      templateTextOpensReasoning(
        '{%- if add_generation_prompt -%}{{- "<|im_start|>assistant\\n<think>\\n</think>\\n" -}}{%- endif -%}',
      ),
    ).toBeUndefined();
  });

  it('ignores openers outside the generation prompt', () => {
    // A replayed assistant turn may carry think tags; only the branch that
    // ends the prompt decides how the *next* turn starts.
    expect(
      templateTextOpensReasoning(
        '{%- for message in messages -%}{{- "<think>" + message.thinking + "</think>" -}}{%- endfor -%}' +
          '{%- if add_generation_prompt -%}{{- "<|im_start|>assistant\\n" -}}{%- endif -%}',
      ),
    ).toBeUndefined();
  });

  it('is false for a template with no generation prompt at all', () => {
    expect(templateTextOpensReasoning('{{ messages }}')).toBeUndefined();
  });
});

describe('requestOpensReasoning', () => {
  const off = { chat_template_kwargs: { enable_thinking: false } };

  it('follows enable_thinking for a switch-aware template', () => {
    expect(requestOpensReasoning('unless-thinking-off', off)).toBe(false);
    expect(
      requestOpensReasoning('unless-thinking-off', {
        chat_template_kwargs: { enable_thinking: true },
      }),
    ).toBe(true);
    // The engine renders with thinking on unless told otherwise.
    expect(requestOpensReasoning('unless-thinking-off', {})).toBe(true);
    expect(
      requestOpensReasoning('unless-thinking-off', {
        chat_template_kwargs: { reasoning_effort: 'medium' },
      }),
    ).toBe(true);
  });

  it('ignores the switch when the template opens unconditionally', () => {
    // Constrained turns send `enable_thinking: false` to every model; a
    // template that never reads it still starts the model mid-thought.
    expect(requestOpensReasoning('always', off)).toBe(true);
  });

  it('is false when the template opens nothing', () => {
    expect(requestOpensReasoning(undefined, {})).toBe(false);
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

  it('streams a thinking-off tool call as reply text, not reasoning', () => {
    // Wild-caught 2026-09-24 on qwen3.8-27b-q4: a Writer gezel under the
    // `creative` profile (thinking off) streamed its whole `write_file` call
    // into the reasoning pane, because the prompt had already closed the
    // block and no `</think>` ever arrived.
    const opensInReasoning = requestOpensReasoning('unless-thinking-off', {
      chat_template_kwargs: { enable_thinking: false },
    });
    const call =
      '<tool_call>\n<function=write_file>\n<parameter=path>\npowerpoint/task-18/deck.md\n' +
      '</parameter>\n<parameter=content>\n# Valencia\n</parameter>\n</function>\n</tool_call>';
    expect(run([call.slice(0, 40), call.slice(40)], { opensInReasoning })).toEqual({
      visible: call,
      reasoning: '',
    });
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
