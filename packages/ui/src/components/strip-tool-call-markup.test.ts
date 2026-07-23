import { describe, expect, it } from 'vitest';
import { stripVisibleToolCallMarkup } from './strip-tool-call-markup.js';

describe('stripVisibleToolCallMarkup', () => {
  it('strips the wild-caught Qwen-Hermes hybrid that the salvage layer missed', () => {
    // The exact bubble text from the McKinley Park session — Qwen
    // outer `<tool_call>` with malformed inner Hermes (no closing
    // `</parameter>` or `</function>` before the `</tool_call>`).
    // Salvage didn't fire because `<function=…></function>` regex
    // requires the inner closes; this human-only scrub catches it
    // via the outer pair.
    const input = [
      'The user is asking me to check the weather. Let me use the browser.',
      '',
      '<tool_call>',
      '<function=browser_navigate>',
      '<parameter=url>',
      'https://weather.com/...',
      '',
      '',
      '</tool_call>',
    ].join('\n');
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('<tool_call>');
    expect(out).not.toContain('<function=');
    expect(out).not.toContain('<parameter=');
    expect(out).toContain('Let me use the browser.');
  });

  it('strips the canonical Qwen <tool_call>JSON</tool_call> shape', () => {
    const input =
      'Calling the tool now.\n\n<tool_call>\n{"name":"browser_navigate","arguments":{"url":"https://x.com"}}\n</tool_call>';
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('<tool_call>');
    expect(out).not.toContain('"name"');
    expect(out).toContain('Calling the tool now.');
  });

  it('strips Anthropic <function_calls><invoke>...</invoke></function_calls>', () => {
    const input =
      'Let me look that up.\n\n<function_calls>\n<invoke name="browser_snapshot"></invoke>\n</function_calls>\n\nDone.';
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('<function_calls>');
    expect(out).not.toContain('<invoke');
    expect(out).toContain('Let me look that up.');
    expect(out).toContain('Done.');
  });

  it('strips bare Hermes <function=NAME>...</function> blocks (no outer tool_call wrap)', () => {
    const input =
      'Trying it.\n<function=create_project>\n  <parameter=name>Test</parameter>\n</function>\n\nResult below.';
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('<function=');
    expect(out).not.toContain('<parameter=');
    expect(out).toContain('Trying it.');
    expect(out).toContain('Result below.');
  });

  it('strips bare Anthropic <invoke>...</invoke> not wrapped in function_calls', () => {
    const input = 'OK.\n<invoke name="list_projects"></invoke>\nProceeding.';
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('<invoke');
    expect(out).toContain('OK.');
    expect(out).toContain('Proceeding.');
  });

  it('strips Gemma <|tool_call|>...<tool_call|> markup', () => {
    const input = 'Trying.\n<|tool_call|>browser_navigate({url: "x"})<tool_call|>\nDone.';
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('<|tool_call|>');
    expect(out).not.toContain('<tool_call|>');
    expect(out).toContain('Trying.');
    expect(out).toContain('Done.');
  });

  it('collapses 3+ blank lines into 2 after a strip cuts a paragraph gap', () => {
    const input = 'first\n\n<tool_call></tool_call>\n\nsecond';
    const out = stripVisibleToolCallMarkup(input);
    // Should have at most a blank line between "first" and "second",
    // not 3+ blank lines from the strip leaving a gash.
    expect(out).toMatch(/first\n+second/);
    expect(out).not.toMatch(/\n\n\n/);
  });

  it('returns input unchanged when no markup is present (common case)', () => {
    const input =
      "Today's weather forecast for McKinley Park, IL: 54°F and cloudy. Tomorrow looks sunny with a high of 65°F.";
    expect(stripVisibleToolCallMarkup(input)).toBe(input);
  });

  it('returns the empty string for empty input', () => {
    expect(stripVisibleToolCallMarkup('')).toBe('');
  });

  it('is idempotent — re-running on already-stripped output is a no-op', () => {
    const input = 'Before\n<tool_call>x</tool_call>\nAfter';
    const once = stripVisibleToolCallMarkup(input);
    const twice = stripVisibleToolCallMarkup(once);
    expect(twice).toBe(once);
  });

  it('strips multiple markup blocks in one message', () => {
    const input =
      'Step 1.\n<tool_call>a</tool_call>\nStep 2.\n<function_calls><invoke name="list_projects"></invoke></function_calls>\nDone.';
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('<tool_call>');
    expect(out).not.toContain('<function_calls>');
    expect(out).toContain('Step 1.');
    expect(out).toContain('Step 2.');
    expect(out).toContain('Done.');
  });

  it('does NOT strip a bare unclosed `<tool_call>` opener (could be mid-stream)', () => {
    // Streaming responses can produce a partial token at the tail
    // before the close arrives. Stripping a bare opener could erase
    // legitimate streaming content; we only strip closed pairs.
    const input = 'Trying...\n<tool_call>';
    expect(stripVisibleToolCallMarkup(input)).toBe(input);
  });

  it('strips orphan `<parameter=NAME>VALUE</parameter>` (broken Hermes, no `<function=…>` wrapper)', () => {
    // Wild-caught: Qwen 3.6 emitting half-formed Hermes — `<parameter=…>`
    // tags inside an `update_project` attempt without the `<function=update_project>...</function>`
    // envelope. Salvage can't promote (no function name) but the user
    // shouldn't see the raw markup.
    const input = [
      'Setting up the project:',
      '- Score display, round timer, win conditions',
      '- Deployable as a single HTML file playable in any modern browser',
      '<parameter=voormanGezelId>ada</parameter>',
      '<parameter=workingDir></parameter>',
    ].join('\n');
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('<parameter=');
    expect(out).not.toContain('</parameter>');
    expect(out).toContain('Score display, round timer, win conditions');
    expect(out).toContain('Deployable as a single HTML file');
  });

  it('strips bare `<parameter=NAME>` openers that have no close (broken streaming)', () => {
    // The exact shape from the screenshot — opener tags on their own
    // lines with the value on the next line, no `</parameter>` close.
    // We strip the tag and leave the value text behind.
    const input = [
      '- Deployable as a single HTML file playable in any modern browser',
      '<parameter=voormanGezelId>',
      'ada',
      '<parameter=workingDir>',
    ].join('\n');
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('<parameter=');
    expect(out).toContain('Deployable as a single HTML file');
    // Value behind the bare opener stays — at least the user sees the
    // intent fragment.
    expect(out).toContain('ada');
  });

  it('strips leading reasoning ending with </think> (Qwen 3.6 enable_thinking pattern)', () => {
    // The model's raw output starts mid-reasoning (chat template
    // injects <think>\n into the prompt) and emits </think> before
    // the visible reply. Without this, the user watches the
    // reasoning prose render in the streaming bubble until it gets
    // cleaned later — every turn.
    const input = [
      'The user is asking me to work on the Atari Combat Clone.',
      'Let me check what tasks I have and what the current state is.',
      '</think>',
      '',
      'Let me check where we left off.',
    ].join('\n');
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('The user is asking me');
    expect(out).not.toContain('</think>');
    expect(out).toContain('Let me check where we left off.');
  });

  it('strips multiple stacked reasoning blocks separated by </tool_call> boundaries', () => {
    // Each tool-loop iteration's raw output ends with </tool_call>
    // (when the model emitted a tool via Hermes markup); the next
    // iteration starts mid-reasoning. Streaming buffer accumulates
    // these, so multiple reasoning blocks stack up — anchored to
    // either start-of-buffer or </tool_call> boundary, each strips
    // cleanly without eating the visible content between iterations.
    const input = [
      'reasoning A',
      '</think>',
      'visible A',
      '<tool_call><function=readFile><parameter=path>x</parameter></function></tool_call>',
      'reasoning B',
      '</think>',
      'visible B',
      '<tool_call><function=writeFile><parameter=path>y</parameter></function></tool_call>',
      'final visible content.',
    ].join('\n');
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('reasoning A');
    expect(out).not.toContain('reasoning B');
    expect(out).not.toContain('</think>');
    expect(out).not.toContain('<tool_call>');
    expect(out).not.toContain('<function=');
    expect(out).toContain('visible A');
    expect(out).toContain('visible B');
    expect(out).toContain('final visible content.');
  });

  it('strips the wild-caught gpt-oss `<|channel>NAME...<channel|>` block (Gemma 3/4 leak)', () => {
    // Wild-caught from a Gemma 4 26B turn: after we routed Gemma
    // through the verbose-family `<think>` hint, the model started
    // emitting gpt-oss-style channel markers instead. Both the
    // canonical `<|channel|>...<|end|>` and the asymmetric
    // `<|channel>NAME...<channel|>` shape need to disappear.
    const input = [
      '<|channel>thought',
      'The design doc is loaded. Key details:',
      '- Level: Jungle Outpost.',
      "Let's start with index.html.<channel|>",
      '',
      'Building index.html now.',
    ].join('\n');
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('<|channel');
    expect(out).not.toContain('<channel|');
    expect(out).not.toContain('Jungle Outpost');
    expect(out).toContain('Building index.html now.');
  });

  it('strips the gpt-oss canonical `<|channel|>NAME<|message|>...<|end|>` shape', () => {
    const input =
      '<|channel|>analysis<|message|>plan: do X then Y<|end|>Visible reply continues here.';
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('<|channel|>');
    expect(out).not.toContain('<|message|>');
    expect(out).not.toContain('<|end|>');
    expect(out).not.toContain('plan: do X');
    expect(out).toContain('Visible reply continues here.');
  });

  it('strips orphan `</parameter>` and `</function>` closes left after partial salvage', () => {
    const input = 'project setup complete</parameter>\n</function>\nReady.';
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('</parameter>');
    expect(out).not.toContain('</function>');
    expect(out).toContain('project setup complete');
    expect(out).toContain('Ready.');
  });

  it('strips a bare-pipe channel leak (`analysis|sentence.|sentence.|…`) with no surrounding angle brackets', () => {
    // Gemma 4 E4B (llama.cpp) wild-caught shape: the model is supposed
    // to emit `<|channel|>analysis<|message|>…<|end|>` but loses the
    // angle brackets in detokenization, leaving just the channel name
    // + pipe-separated inner content. The persisted message stays
    // clean because the model's final visible reply overwrites it on
    // commit — but the streaming bubble shows the raw deltas, so
    // without this catch the user watches a wall of `analysis|…|…|…`
    // scroll by while the turn runs.
    const input =
      'analysis|Farjana is tasked with creating the plan.|The plan needs to be concrete and simple.|The project is an MVP shooter.|';
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('analysis|');
    expect(out).not.toContain('The plan needs to be concrete');
  });

  it('preserves the real visible reply that follows a bare-pipe channel leak terminated by `\\n\\n`', () => {
    const input =
      'analysis|Step one is X.|Step two is Y.|\n\nThe plan has been written to `plan.md`.';
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('analysis|');
    expect(out).not.toContain('Step one is X');
    expect(out).toContain('The plan has been written to `plan.md`.');
  });

  it('does not strip mid-line `analysis|` (only line-anchored leaks)', () => {
    // Guard against false positives — a user genuinely writing "the
    // analysis|foo data" mid-sentence shouldn't get truncated.
    const input = 'I ran the analysis|foo data through the validator.';
    const out = stripVisibleToolCallMarkup(input);
    expect(out).toContain('the analysis|foo data through the validator');
  });

  it('strips the bracket-loss `analysis|>BODY|<end|>` shape with a multi-paragraph body', () => {
    // Wild-caught from Gemma 4 E4B (llama.cpp): the detokenizer drops
    // the `<` from `<|channel|>` and the leading `|` from `<|end|>`,
    // and the body spans multiple paragraphs so the existing
    // `\n\n`-terminated bare-pipe pattern only caught the first one.
    // The `<end|>` family close should win over `\n\n` and strip the
    // whole block.
    const input = [
      'analysis|>The user has approved the high-level direction.',
      '',
      'I will create a detailed mechanics document covering Combat,',
      'Resource Management, and Progression.|<end|>',
      '',
      'The visible reply continues here.',
    ].join('\n');
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('analysis|');
    expect(out).not.toContain('approved the high-level direction');
    expect(out).not.toContain('Resource Management');
    expect(out).not.toContain('<end|>');
    expect(out).toContain('The visible reply continues here.');
  });

  it('strips the bare-pipe closed `analysis|\\nBODY</|end|>` shape with a multi-paragraph body', () => {
    // Wild-caught from Gemma 4 E4B (llama.cpp): the prompt asked for
    // `<|channel|>analysis<|message|>...<|end|>`, but the visible
    // stream decoded as `analysis|` with a slash-before-pipe end tag.
    const input = [
      'analysis|',
      'The user requested a code review and fix for three identified bugs.',
      '',
      'I will execute these three fixes using `writeFile` in a single turn.',
      '</|end|>',
      '',
      'Visible reply.',
    ].join('\n');
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('analysis|');
    expect(out).not.toContain('three identified bugs');
    expect(out).not.toContain('</|end|>');
    expect(out).toContain('Visible reply.');
  });

  it('strips an unclosed bare-pipe `analysis|\\nBODY` shape to end of buffer', () => {
    const input = [
      'analysis|',
      'The user requested a code review and fix for three identified bugs.',
      '',
      'I will execute these three fixes using `writeFile` in a single turn.',
    ].join('\n');
    const out = stripVisibleToolCallMarkup(input);
    expect(out).toBe('');
  });

  it('strips the unclosed bracket-loss `analysis|>BODY|` shape with a multi-paragraph body', () => {
    // Wild-caught from Gemma 4 E4B (llama.cpp): the model starts a
    // gpt-oss-style analysis channel, loses the opener punctuation,
    // and never emits the `<end|>` residue. The whole end-anchored
    // block is reasoning; leaving paragraph two visible is the leak.
    const input = [
      "analysis|>I need to find three high-impact bugs in the 'squisq' repository.",
      '',
      'I will use `search_files` on the main `packages/core/src` directory.',
      '',
      "I'll run a search for `try...catch` blocks that might be too general.|",
    ].join('\n');
    const out = stripVisibleToolCallMarkup(input);
    expect(out).toBe('');
  });

  it('strips orphan `<end|>` / `<message|>` markers with missing pipes (bracket-loss residue)', () => {
    // After the bracket-loss block strips, malformed orphan end / message
    // markers can survive elsewhere in the buffer. The forgiving residual-
    // tag strip should drop them rather than leak the literal text.
    const input = 'The real reply<end|>\nMore content<|message>\nDone.';
    const out = stripVisibleToolCallMarkup(input);
    expect(out).not.toContain('<end|>');
    expect(out).not.toContain('<|message>');
    expect(out).toContain('The real reply');
    expect(out).toContain('More content');
    expect(out).toContain('Done.');
  });
});

describe('stripVisibleToolCallMarkup — streaming mode (hideMidStreamOpener)', () => {
  it('hides an in-flight `<tool_call>` opener with everything after', () => {
    // The wild-caught case from the live streaming bubble: the
    // outer `<tool_call>` has arrived but the close hasn't, so the
    // user is watching XML grow token-by-token. Eagerly hiding
    // from the opener to end-of-buffer prevents the flicker.
    const input =
      "The user wants weather. I'll search for the URL.\n\n<tool_call>\n<function=web_search>\n<parameter=query>\nweather.com Seattle 10-day forecast";
    const out = stripVisibleToolCallMarkup(input, { hideMidStreamOpener: true });
    expect(out).not.toContain('<tool_call>');
    expect(out).not.toContain('<function=');
    expect(out).not.toContain('<parameter=');
    expect(out).toContain("I'll search for the URL.");
  });

  it('hides an in-flight Hermes `<function=NAME>` opener (no outer wrap)', () => {
    const input = 'Trying.\n<function=create_project>\n<parameter=name>Test';
    const out = stripVisibleToolCallMarkup(input, { hideMidStreamOpener: true });
    expect(out).not.toContain('<function=');
    expect(out).toContain('Trying.');
  });

  it('hides an in-flight Anthropic `<function_calls>` opener', () => {
    const input = 'Searching.\n<function_calls>\n<invoke name="web_search">';
    const out = stripVisibleToolCallMarkup(input, { hideMidStreamOpener: true });
    expect(out).not.toContain('<function_calls>');
    expect(out).not.toContain('<invoke');
    expect(out).toContain('Searching.');
  });

  it('still strips closed pairs in streaming mode (closed-pair pass runs first)', () => {
    const input = 'Step 1.\n<tool_call>x</tool_call>\n\nStep 2.';
    const out = stripVisibleToolCallMarkup(input, { hideMidStreamOpener: true });
    expect(out).not.toContain('<tool_call>');
    expect(out).toContain('Step 1.');
    expect(out).toContain('Step 2.');
  });

  it('hides an in-flight bare-pipe analysis channel opener', () => {
    const input = [
      'analysis|',
      'The user requested a code review and fix for three identified bugs.',
      '',
      'I will execute these three fixes using `writeFile` in a single turn.',
    ].join('\n');
    const out = stripVisibleToolCallMarkup(input, { hideMidStreamOpener: true });
    expect(out).toBe('');
  });

  it('does NOT hide unrelated trailing prose with no markup opener', () => {
    // No markup in the buffer → no change from the closed-pair pass,
    // and the trailing-open pass is a no-op.
    const input = 'Just normal prose with no tool calls.';
    expect(stripVisibleToolCallMarkup(input, { hideMidStreamOpener: true })).toBe(input);
  });

  it('keeps prose that comes before the in-flight opener', () => {
    // The user has been watching the model build up to a tool call.
    // We hide the opener-onwards but the conversational lead-in
    // stays visible (which is the whole point — we hide the gross
    // markup, not the human-readable narrative).
    const input =
      'I think the right tool here is web_search. Let me run it now.\n\n<tool_call>\n<function=web_search>';
    const out = stripVisibleToolCallMarkup(input, { hideMidStreamOpener: true });
    expect(out).toContain('I think the right tool here is web_search.');
    expect(out).toContain('Let me run it now.');
    expect(out).not.toContain('<tool_call>');
    expect(out).not.toContain('<function=');
  });
});
