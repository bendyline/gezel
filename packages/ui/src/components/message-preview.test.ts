import { describe, expect, it } from 'vitest';
import { humanMessagePreview } from './message-preview.js';

describe('humanMessagePreview', () => {
  // The design-review finding this file exists to prevent: a hand-off card
  // whose context line read `Sumarni, Si… · <toolcall <function=search…`.
  // The `<toolcall` is what a markdown flatten leaves of `<tool_call>` once
  // it has eaten the `_` and the `>`.
  it('translates the tool-call markup that used to reach a card headline', () => {
    expect(
      humanMessagePreview('<tool_call><function=search_memory><parameter=query>project layout'),
    ).toBe('Searching memory…');
  });

  it('keeps prose and scrubs the markup around it', () => {
    expect(
      humanMessagePreview(
        'Let me check the workspace.\n<tool_call><function=grep_files>' +
          '<parameter=pattern>todo</parameter></function></tool_call>',
      ),
    ).toBe('Let me check the workspace.');
  });

  it('names the act for every markup dialect a model might emit', () => {
    expect(humanMessagePreview('<invoke name="write_artifact">')).toBe('Writing artifact…');
    expect(humanMessagePreview('{"tool": "read_file", "args": {"path": "a.ts"}}')).toBe(
      'Reading file…',
    );
    expect(humanMessagePreview('<function=advance_task_step>')).toBe('Advancing task step…');
  });

  // A summary is cut at 200 characters server-side, so the slug itself can
  // be truncated. `grep_fi` must not become "Grep fi…".
  it('stays generic when the tool name was cut mid-slug', () => {
    expect(humanMessagePreview('<tool_call>\n<function=grep_fi')).toBe('Using a tool…');
  });

  it('phrases an unmapped tool from its own label rather than guessing a verb', () => {
    expect(humanMessagePreview('<function=some_new_tool>')).toBe('Some new tool…');
  });

  it('names reasoning the bubble hides instead of blanking the line', () => {
    expect(humanMessagePreview('<think>The user is asking me to')).toBe('Thinking…');
  });

  it('names an image-only reply, which flattens to nothing', () => {
    expect(humanMessagePreview('![](artifact:chart.png)')).toBe('Shared an image');
  });

  it('flattens markdown to the words a person would read', () => {
    expect(
      humanMessagePreview('## Findings\n\n**two** [issues](http://x) in @[Ada](gezel:g1)'),
    ).toBe('Findings two issues in @Ada');
  });

  it('drops a JSON envelope that no angle-bracket scrub would catch', () => {
    expect(humanMessagePreview('Checking. {"name":"read_file","arguments":{"path":"a.ts"}}')).toBe(
      'Checking.',
    );
    // A brace inside an argument value is not the end of the envelope.
    expect(
      humanMessagePreview('{"name":"write_file","arguments":{"content":"} not the end"}}'),
    ).toBe('Writing file…');
  });

  it('keeps the words before an unclosed reasoning block', () => {
    expect(humanMessagePreview('Sure.<think>the user wants')).toBe('Sure.');
  });

  it('does not report a call the model only mentioned while thinking', () => {
    expect(humanMessagePreview('<think>I could use <function=grep_files> here')).toBe('Thinking…');
  });

  it('condenses a task dispatch seed to the fact under it', () => {
    expect(
      humanMessagePreview(
        'Liesel has handed step `review` of task default/11 to you. Follow the step instructions already in your prompt — make the first tool call they name this turn.',
      ),
    ).toBe('Liesel passed on the review step.');
    // Session summaries carry a 200-character slice, which an entry seed
    // spends on its step-arc preface.
    expect(
      humanMessagePreview(
        'Task default/11 ("Board deck for Q3") was just created from the **Presentation** craftbook.\n\nIts steps:\n1. Sources — gather them ← your step\n2. Outline',
      ),
    ).toBe('New task “Board deck for Q3” — Presentation.');
  });

  it('leaves ordinary prose alone and reports nothing for an empty body', () => {
    expect(humanMessagePreview('Ready when you are.')).toBe('Ready when you are.');
    expect(humanMessagePreview('')).toBe('');
    expect(humanMessagePreview('   ')).toBe('');
  });
});
