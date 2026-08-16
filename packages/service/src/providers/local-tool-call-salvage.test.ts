import { describe, expect, it } from 'vitest';
import {
  appendCapTruncationHintToRejectedWrite,
  appendTruncationHintToToolResult,
  buildUnknownToolNudge,
  describeMalformation,
  extractReasoning,
  extractWantedToolName,
  findBareInvokeToolCallSpans,
  findClaudeInvokeToolCallSpan,
  findClaudeInvokeToolCallSpans,
  findGlmToolCallSpan,
  findGlmToolCallSpans,
  findHermesFunctionToolCallSpan,
  findHermesFunctionToolCallSpans,
  findHermesFunctionToolCallSpansLenient,
  findProseToolCallSpan,
  findProseToolCallSpans,
  findShellToolCallSpan,
  findShellToolCallSpans,
  findTruncatedJsonEnvelope,
  findTruncatedProseToolCall,
  findUnrecognizedFunctionMarkup,
  findUnrecognizedToolEnvelope,
  findXmlTagToolCallSpan,
  findXmlTagToolCallSpans,
  foldPostActionRumination,
  foldPreToolPreamble,
  formatToolMenu,
  isPayloadMutationToolName,
  isWriteShapedToolName,
  parseGemmaToolCall,
  parseJsonEnvelopeToolCall,
  parseJsonEnvelopeToolCalls,
  parseProseToolCall,
  resolveToolNameAlias,
  salvageWriteShapedTruncation,
  stripBareInvokeToolCallsFromText,
  stripClaudeInvokeToolCallsFromText,
  stripGlmToolCallsFromText,
  stripHermesFunctionToolCallsFromText,
  stripJsonEnvelopeFromText,
  stripJsonEnvelopesFromText,
  stripProseToolCallFromText,
  stripProseToolCallsFromText,
  stripReasoningTags,
  stripShellToolCallsFromText,
  stripXmlTagToolCallsFromText,
  uniqueWantedToolNames,
} from './local-tool-call-salvage.js';

const KNOWN = new Set([
  'browser_navigate',
  'list_documents',
  'write_artifact',
  'noop',
  'create_project',
  'create_gezel',
  'list_projects',
  'list_gezels',
  'list_artifacts',
  'update_project',
  'create_task',
  'ask_user_question',
  'read_task_notes',
  'search_memory',
]);

describe('parseGemmaToolCall', () => {
  it('repairs the wild-caught Gemma 4 E4B browser_navigate body', () => {
    const body = 'call:browser_navigate{url:<|"|>https://www.weather.com/ */}';
    expect(parseGemmaToolCall(body, KNOWN)).toEqual({
      name: 'browser_navigate',
      arguments: { url: 'https://www.weather.com/ ' },
    });
  });

  it('accepts the canonical "call:NAME{...}" envelope', () => {
    const body = 'call:list_documents{recursive:<|"|>true */}';
    expect(parseGemmaToolCall(body, KNOWN)).toEqual({
      name: 'list_documents',
      arguments: { recursive: 'true ' },
    });
  });

  it('accepts a body without the leading "call:"', () => {
    const body = 'noop{}';
    expect(parseGemmaToolCall(body, KNOWN)).toEqual({ name: 'noop', arguments: {} });
  });

  it('parses multi-arg bodies with mixed string + number values', () => {
    const body = 'call:write_artifact{path:<|"|>notes.md */, size:42}';
    expect(parseGemmaToolCall(body, KNOWN)).toEqual({
      name: 'write_artifact',
      arguments: { path: 'notes.md ', size: 42 },
    });
  });

  it('refuses an unknown tool name (defense against fabrication)', () => {
    const body = 'call:rm_rf_universe{path:<|"|>/ */}';
    expect(parseGemmaToolCall(body, KNOWN)).toBeNull();
  });

  it('accepts the parens-wrapped "call:NAME({...})" function-call shape', () => {
    // Wild-caught from gemma4-26b emitting `start_project({about: "...", ...})`
    // — JS-style call syntax. The strict `name{args}` regex was
    // rejecting this, dropping otherwise-perfect tool-call attempts.
    const body = 'call:create_project({name: "Test", about: "A short description"})';
    expect(parseGemmaToolCall(body, KNOWN)).toEqual({
      name: 'create_project',
      arguments: { name: 'Test', about: 'A short description' },
    });
  });

  it('accepts multi-line string values inside args (markdown bullet lists)', () => {
    // Wild-caught from gemma4-26b's `start_project` call where the
    // missionObjectives arg was a multi-line bullet list. JSON forbids
    // unescaped control chars in strings; without
    // `escapeControlCharsInStrings` this body landed in
    // `unrepairedBodies` and the call was lost.
    const body = 'call:create_project({name: "Test", about: "Line one\nLine two\nLine three"})';
    const parsed = parseGemmaToolCall(body, KNOWN);
    expect(parsed?.name).toBe('create_project');
    expect(parsed?.arguments.about).toBe('Line one\nLine two\nLine three');
  });

  it('handles the full wild-caught `start_project({about, missionObjectives, name, taskDescription})` shape', () => {
    // The exact shape that failed in the missile-command repro:
    // parens-wrapped envelope + multi-line markdown bullets inside
    // missionObjectives. Both gap fixes together must repair it.
    const body =
      'call:create_project({about: "A web-based arcade game.", missionObjectives: "- Functional game loop.\n- Scoring system.\n- City protection.", name: "Missile Command Clone", taskDescription: "Set up the project."})';
    const parsed = parseGemmaToolCall(body, KNOWN);
    expect(parsed?.name).toBe('create_project');
    expect(parsed?.arguments.name).toBe('Missile Command Clone');
    expect(parsed?.arguments.missionObjectives).toContain('- Functional game loop.');
    expect(parsed?.arguments.missionObjectives).toContain('- City protection.');
  });

  it('refuses a body whose envelope does not match', () => {
    expect(parseGemmaToolCall('blah blah blah', KNOWN)).toBeNull();
    expect(parseGemmaToolCall('call:noop', KNOWN)).toBeNull(); // no args block
    expect(parseGemmaToolCall('{a:1}', KNOWN)).toBeNull(); // no name
  });

  it('refuses bodies whose args block does not parse to a plain object', () => {
    // Garbage args after token-strip → JSON.parse fails.
    const body = 'call:noop{not json at all}';
    expect(parseGemmaToolCall(body, KNOWN)).toBeNull();
  });

  it('preserves : inside string values rather than quoting them', () => {
    // The regex-based bare-key quoter must respect string boundaries —
    // `http://x:80` should NOT get extra quotes around `x`.
    const body = 'call:browser_navigate{url:<|"|>http://x:80/ */}';
    expect(parseGemmaToolCall(body, KNOWN)).toEqual({
      name: 'browser_navigate',
      arguments: { url: 'http://x:80/ ' },
    });
  });

  it("accepts single-quoted string values (Gemma's `{name: 'X'}` shape)", () => {
    // The previous parser missed this — single quotes are common
    // when Gemma is prompted with JS-style examples and slips into
    // that mode. The other prose-call salvager already handles this;
    // bringing parseGemmaToolCall in line removes a class of
    // user-visible "malformed syntax" warnings.
    const body = "call:write_artifact{path: 'notes.md', size: 42}";
    expect(parseGemmaToolCall(body, KNOWN)).toEqual({
      name: 'write_artifact',
      arguments: { path: 'notes.md', size: 42 },
    });
  });

  it('accepts trailing commas before the closing brace', () => {
    // Wild-caught: Gemma 4 26B emits a trailing comma after the last
    // arg roughly 1 in 5 tool calls. Strict JSON.parse rejects that;
    // the new stripTrailingCommas pass lets it through.
    const body = 'call:write_artifact{path:<|"|>notes.md */, size:42,}';
    expect(parseGemmaToolCall(body, KNOWN)).toEqual({
      name: 'write_artifact',
      arguments: { path: 'notes.md ', size: 42 },
    });
  });

  it('accepts hyphenated tool names via the alias resolver', () => {
    // Model emits `create-task` — the regex now allows hyphens, the
    // alias resolver normalizes to `create_task` against KNOWN.
    const body = 'call:write-artifact{path: "x.md", size: 1}';
    // The KNOWN set has `write_artifact`. Hyphenated input should
    // still resolve via the alias normalizer.
    expect(parseGemmaToolCall(body, KNOWN)).toEqual({
      name: 'write_artifact',
      arguments: { path: 'x.md', size: 1 },
    });
  });
});

describe('describeMalformation', () => {
  it('flags a missing arg block', () => {
    const msg = describeMalformation('call:foo');
    expect(msg).toMatch(/recognizable function name/i);
  });

  it('flags an unclosed brace', () => {
    const msg = describeMalformation('call:foo{a:1');
    expect(msg).toMatch(/closing brace/i);
  });

  it('flags JSON parse failure for a closed-but-broken block', () => {
    const msg = describeMalformation('call:foo{not json}');
    expect(msg).toMatch(/didn't parse as JSON/i);
  });

  it('handles the empty case cleanly', () => {
    expect(describeMalformation('   ')).toMatch(/empty/i);
  });

  it("scrubs channel / reasoning markup from the echoed body so retries don't feed the bad shape back", () => {
    // Wild-caught with Gemma 4 26B: when the malformed body itself
    // contains gpt-oss channel markup, echoing it verbatim into the
    // corrective system message gave the model another instance of
    // its own markup to copy on the retry. Scrub before echoing.
    const msg = describeMalformation('<|channel|>commentary<|message|>write_file<|end|>');
    expect(msg).not.toContain('<|channel');
    expect(msg).not.toContain('<|message');
    expect(msg).not.toContain('<|end');
    expect(msg).toMatch(/recognizable function name/i);
  });
});

describe('parseProseToolCall', () => {
  it('salvages the wild-caught Gemma SpaceWar Clone code-block emit', () => {
    // Verbatim from the user's repro — model wrote the tool call as
    // a markdown code block instead of issuing a real tool call.
    const text = `Understood. A simple web clone of SpaceWar.

Since this sounds like a focused, sustained effort, I recommend we create a dedicated project for it so all the code, assets, and discussions stay organized.

I will create a new project named "SpaceWar Clone."

\`\`\`
create_project({ name: "SpaceWar Clone" })
\`\`\``;
    expect(parseProseToolCall(text, KNOWN)).toEqual({
      name: 'create_project',
      arguments: { name: 'SpaceWar Clone' },
    });
  });

  it('salvages a single-quoted prose call', () => {
    const text = `I'll create the project: create_project({ name: 'Spacewar' })`;
    expect(parseProseToolCall(text, KNOWN)).toEqual({
      name: 'create_project',
      arguments: { name: 'Spacewar' },
    });
  });

  it('salvages multi-arg prose calls', () => {
    const text =
      'create_gezel({ name: "Alex", role: "Project Lead", about: "A focused engineer." })';
    expect(parseProseToolCall(text, KNOWN)).toEqual({
      name: 'create_gezel',
      arguments: { name: 'Alex', role: 'Project Lead', about: 'A focused engineer.' },
    });
  });

  it('handles nested object args (brace balancing)', () => {
    const text = 'write_artifact({ path: "x.md", content: "{ y: 1 }" })';
    expect(parseProseToolCall(text, KNOWN)).toEqual({
      name: 'write_artifact',
      arguments: { path: 'x.md', content: '{ y: 1 }' },
    });
  });

  it('refuses unknown tool names (safety rail against fabricated calls)', () => {
    const text = 'fabricated_tool({ name: "x" })';
    expect(parseProseToolCall(text, KNOWN)).toBeNull();
  });

  it('refuses calls whose args block does not parse', () => {
    const text = 'create_project({ name: "X", about: invalid_unquoted_value })';
    expect(parseProseToolCall(text, KNOWN)).toBeNull();
  });

  it('returns null on prose with no tool-call shape', () => {
    expect(parseProseToolCall('I am thinking about this.', KNOWN)).toBeNull();
    expect(parseProseToolCall('', KNOWN)).toBeNull();
  });

  it('returns null when the closing paren is missing', () => {
    expect(parseProseToolCall('create_project({ name: "X" }', KNOWN)).toBeNull();
  });

  it('returns the FIRST viable call when multiple appear', () => {
    const text = `First: create_project({ name: "A" })
Second: create_project({ name: "B" })`;
    const result = parseProseToolCall(text, KNOWN);
    expect(result?.arguments).toEqual({ name: 'A' });
  });

  it('does not confuse "I will call create_project" descriptions', () => {
    // Prose around the name without a paren+brace shape — never
    // promotes. Safety rail against false positives.
    expect(parseProseToolCall('I will call create_project later.', KNOWN)).toBeNull();
    expect(parseProseToolCall('Note: create_project takes a name.', KNOWN)).toBeNull();
  });

  it('salvages empty-paren no-args calls (list_artifacts())', () => {
    // Wild-caught Qwen on MLX — emitted `list_artifacts()` as decoration.
    // Previously the parser required `\(\s*\{` and silently dropped it.
    const text = `Let me start by listing the artifacts to see the current state of the project.

\`\`\`
list_artifacts()
\`\`\``;
    expect(parseProseToolCall(text, KNOWN)).toEqual({
      name: 'list_artifacts',
      arguments: {},
    });
  });

  it('salvages empty-paren no-args calls without code fences', () => {
    expect(parseProseToolCall("I'll list them: list_artifacts()", KNOWN)).toEqual({
      name: 'list_artifacts',
      arguments: {},
    });
  });

  it('refuses empty-paren calls for unknown names (safety rail)', () => {
    // `something()` is common English prose — only known tools promote.
    expect(parseProseToolCall('Then something() happens.', KNOWN)).toBeNull();
  });
});

describe('findProseToolCallSpan', () => {
  it('returns the source span covering the call', () => {
    const text = `Header.\n\n\`\`\`\ncreate_project({ name: "Atari" })\n\`\`\``;
    const span = findProseToolCallSpan(text, KNOWN);
    expect(span).not.toBeNull();
    expect(span!.name).toBe('create_project');
    expect(span!.arguments).toEqual({ name: 'Atari' });
    expect(text.slice(span!.start, span!.end)).toBe('create_project({ name: "Atari" })');
  });

  it('returns the span for empty-paren calls too', () => {
    const text = 'Plain prose, then list_artifacts() and trailing text.';
    const span = findProseToolCallSpan(text, KNOWN);
    expect(span).not.toBeNull();
    expect(span!.name).toBe('list_artifacts');
    expect(text.slice(span!.start, span!.end)).toBe('list_artifacts()');
  });
});

describe('findProseToolCallSpan kwargs + multi-call', () => {
  it('parses a Python-style colon-kwarg call (`key: value`)', () => {
    const text = 'Then I will: search_memory(scope: "project")';
    const span = findProseToolCallSpan(text, KNOWN);
    expect(span).not.toBeNull();
    expect(span!.name).toBe('search_memory');
    expect(span!.arguments).toEqual({ scope: 'project' });
  });

  it('parses a Python-style equals-kwarg call (`key=value`)', () => {
    const text = 'search_memory(scope="project", limit=5)';
    const span = findProseToolCallSpan(text, KNOWN);
    expect(span).not.toBeNull();
    expect(span!.name).toBe('search_memory');
    expect(span!.arguments).toEqual({ scope: 'project', limit: 5 });
  });

  it('does not rewrite `==` Python comparisons', () => {
    // The kwarg path is only for `<ident>=<value>` not `==` (comparisons).
    // We don't expect this to parse — it's not a valid arg list — but
    // confirm it doesn't throw or produce a false positive.
    const text = 'search_memory(a == b)';
    expect(findProseToolCallSpan(text, KNOWN)).toBeNull();
  });

  it('leaves `=` inside string values intact', () => {
    const text = 'search_memory(scope="x=y")';
    const span = findProseToolCallSpan(text, KNOWN);
    expect(span).not.toBeNull();
    expect(span!.arguments).toEqual({ scope: 'x=y' });
  });
});

describe('findProseToolCallSpans (plural)', () => {
  it('returns every call when the model chains multiple in a fence', () => {
    // The wild-caught Qwen MLX repro — three calls in a single ``` fence.
    const text = `Let me call the appropriate tools to get this information.

\`\`\`
list_artifacts()
read_task_notes()
search_memory(scope: "project")
\`\`\``;
    const spans = findProseToolCallSpans(text, KNOWN);
    expect(spans.map((s) => s.name)).toEqual([
      'list_artifacts',
      'read_task_notes',
      'search_memory',
    ]);
    expect(spans[2]!.arguments).toEqual({ scope: 'project' });
  });

  it('returns spans whose ranges cover the source text of each call', () => {
    const text = 'A: list_artifacts() then B: read_task_notes()';
    const spans = findProseToolCallSpans(text, KNOWN);
    expect(spans).toHaveLength(2);
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe('list_artifacts()');
    expect(text.slice(spans[1]!.start, spans[1]!.end)).toBe('read_task_notes()');
  });

  it('returns empty when no known calls match', () => {
    expect(findProseToolCallSpans('Plain prose, no calls.', KNOWN)).toEqual([]);
  });
});

describe('findProseToolCallSpans — OpenAI-flavored write_file shape (Gemma 4 26B wild-caught)', () => {
  const WRITE_KNOWN = new Set(['write_file', 'write_artifact', 'set_task_status']);

  it('salvages a write_file call with properly-escaped multi-line HTML content', () => {
    // The "expected" shape: `\n` and `\"` as 2-char escape sequences.
    // This is the JSON-correct version of what the model is trying to
    // emit — and what makes it through the existing parser cleanly.
    const text =
      '```javascript\n' +
      'write_file({"path": "index.html", "content": "<!DOCTYPE html>\\n<html lang=\\"en\\"><body><h1>Tic-Tac-Toe</h1></body></html>"})\n' +
      '```';
    const spans = findProseToolCallSpans(text, WRITE_KNOWN);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('write_file');
    expect(spans[0]!.arguments).toEqual({
      path: 'index.html',
      content: '<!DOCTYPE html>\n<html lang="en"><body><h1>Tic-Tac-Toe</h1></body></html>',
    });
  });

  it('salvages a write_file call with RAW newlines inside the content string', () => {
    // The "imperfect" shape: model emitted real `\n` chars (not the
    // 2-char escape sequence) inside what is otherwise a JSON object.
    // Common when the model streams multi-line markdown / HTML / code
    // and forgets to escape control characters per JSON spec.
    // Before the escapeControlCharsInStrings wire-up, JSON.parse
    // rejected this and the call was silently lost.
    const text =
      '```javascript\n' +
      'write_file({"path": "index.html", "content": "<!DOCTYPE html>\n<html lang=\\"en\\">\n<body>X</body>\n</html>"})\n' +
      '```';
    const spans = findProseToolCallSpans(text, WRITE_KNOWN);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('write_file');
    const c = String(spans[0]!.arguments.content);
    expect(c).toContain('<!DOCTYPE html>');
    expect(c).toContain('<html lang="en">');
    expect(c).toContain('</html>');
  });

  it('salvages a write_file call with UNESCAPED inner quotes (the wild-caught case)', () => {
    // The "natural" shape: model writes HTML with real `"` chars
    // (`class="board"`) instead of `\"`. JSON.parse sees the string
    // close at the first inner `"` and chokes. The rebalanceUnescaped
    // Quotes pass re-escapes them based on the structural delimiter
    // heuristic (a `"` is content unless followed by `,` or `}` at
    // top level).
    const text =
      '```javascript\n' +
      'write_file({"path": "game.html", "content": "<div class="board"><span id="title">Hi</span></div>"})\n' +
      '```';
    const spans = findProseToolCallSpans(text, WRITE_KNOWN);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('write_file');
    const c = String(spans[0]!.arguments.content);
    expect(c).toContain('class="board"');
    expect(c).toContain('id="title"');
  });

  it('salvages write_file when content has BOTH raw newlines AND unescaped quotes', () => {
    // The composite of cases 2 + 3 — the actual shape Gemma 4 26B
    // emits on long HTML write_file calls. Tests that the two recovery
    // stages compose cleanly (escapeControlCharsInStrings first, then
    // rebalanceUnescapedQuotes on the result).
    const text =
      '```javascript\n' +
      'write_file({"path": "index.html", "content": "<!DOCTYPE html>\n<html lang="en">\n<head>\n  <title>Tic-Tac-Toe</title>\n</head>\n<body>\n  <div class="board"></div>\n</body>\n</html>"})\n' +
      '```';
    const spans = findProseToolCallSpans(text, WRITE_KNOWN);
    expect(spans).toHaveLength(1);
    const c = String(spans[0]!.arguments.content);
    expect(c).toContain('<!DOCTYPE html>');
    expect(c).toContain('class="board"');
    expect(c).toContain('</html>');
  });

  it('salvages a pythonic write_file whose content escapes single quotes', () => {
    // LFM2.5's chat template escapes every `'` in a tool argument
    // (`replace("'", "\\'")`), so any JS or HTML the model writes arrives
    // with `\'` inside a single-quoted kwarg. `\'` is legal in Python/JS
    // but NOT valid JSON, so copying it through made `JSON.parse` reject the
    // whole object and the call vanished. Wild-caught on the tankcombat
    // anchor: the model emitted a complete, working 3.1 KB game and the
    // deliverable was dropped on the floor — the trial scored 0 writes.
    const text = String.raw`<|tool_call_start|>[write_file(path='game.html', content='<script>\n  let s = \'playing\';\n</script>\n')]<|tool_call_end|>`;
    const spans = findProseToolCallSpans(text, WRITE_KNOWN);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('write_file');
    const c = String(spans[0]!.arguments.content);
    expect(c).toContain("let s = 'playing';");
    expect(c).not.toContain("\\'");
  });

  it('keeps other backslash escapes intact when unescaping single quotes', () => {
    // The `\'` special-case must not eat legitimate escapes sharing the
    // branch: `\\` (literal backslash) and `\n` (newline) still round-trip.
    const text = String.raw`write_file(path='p.txt', content='C:\\dir\nit\'s fine')`;
    const spans = findProseToolCallSpans(text, WRITE_KNOWN);
    expect(spans).toHaveLength(1);
    const c = String(spans[0]!.arguments.content);
    expect(c).toContain('C:\\dir');
    expect(c).toContain('\n');
    expect(c).toContain("it's fine");
  });

  it('salvages write_file that arrives without a wrapping markdown fence', () => {
    // Some Gemma turns drop the ```javascript wrapper and emit the
    // call as bare prose. Should still salvage.
    const text =
      'I will write the file now: write_file({"path": "x.txt", "content": "hello\nworld"})';
    const spans = findProseToolCallSpans(text, WRITE_KNOWN);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.arguments).toEqual({ path: 'x.txt', content: 'hello\nworld' });
  });

  it('does NOT salvage when the tool name is unknown', () => {
    // Critical safety rail — we never fabricate calls to unknown
    // tools, even when the shape parses cleanly.
    const text = 'write_file2({"path": "x", "content": "y"})';
    expect(findProseToolCallSpans(text, WRITE_KNOWN)).toEqual([]);
  });

  it('does NOT salvage when content is genuinely malformed (no recoverable boundary)', () => {
    // A `{` with no matching `}` and no plausible string-close
    // boundary. Should give up, not corrupt.
    const text = 'write_file({"path": "x", "content": "y';
    expect(findProseToolCallSpans(text, WRITE_KNOWN)).toEqual([]);
  });
});

describe('stripProseToolCallsFromText (multi-strip)', () => {
  it('strips every call AND peels the wrapping fence when emptied', () => {
    const text = `Let me call the appropriate tools.

\`\`\`
list_artifacts()
read_task_notes()
search_memory(scope: "project")
\`\`\`

Done.`;
    const spans = findProseToolCallSpans(text, KNOWN);
    const stripped = stripProseToolCallsFromText(text, spans);
    expect(stripped).not.toContain('list_artifacts');
    expect(stripped).not.toContain('read_task_notes');
    expect(stripped).not.toContain('search_memory');
    expect(stripped).not.toContain('```');
    expect(stripped).toContain('Let me call the appropriate tools.');
    expect(stripped).toContain('Done.');
  });

  it('is a no-op on an empty span list', () => {
    expect(stripProseToolCallsFromText('hello', [])).toBe('hello');
  });
});

describe('stripProseToolCallFromText', () => {
  it('peels the wrapping fence when the call was the only content inside', () => {
    const text = `Let me list them.

\`\`\`
list_artifacts()
\`\`\`

Then we proceed.`;
    const span = findProseToolCallSpan(text, KNOWN)!;
    const stripped = stripProseToolCallFromText(text, span);
    expect(stripped).not.toContain('list_artifacts()');
    expect(stripped).not.toContain('```');
    expect(stripped).toContain('Let me list them.');
    expect(stripped).toContain('Then we proceed.');
  });

  it('strips inline calls without disturbing surrounding prose', () => {
    const text = "I'll list them: list_artifacts(). Then continue.";
    const span = findProseToolCallSpan(text, KNOWN)!;
    const stripped = stripProseToolCallFromText(text, span);
    expect(stripped).toBe("I'll list them: . Then continue.");
  });

  it('collapses runs of 3+ newlines left behind by the strip', () => {
    const text = 'Before.\n\n```\nlist_artifacts()\n```\n\nAfter.';
    const span = findProseToolCallSpan(text, KNOWN)!;
    const stripped = stripProseToolCallFromText(text, span);
    // The strip should not leave a 4-newline gap between Before and After.
    expect(stripped).not.toMatch(/\n{3,}/);
  });
});

describe('parseJsonEnvelopeToolCall', () => {
  it('promotes the wild-caught Qwen 3.5 9B `{tool, args}` envelope', () => {
    // Verbatim from the screenshot the user reported — Qwen 3.5 (9B)
    // running on MLX, asked to "poke all the projects".
    const text = `The user is asking me to check on all projects. I should use the list_projects tool to see what's currently in the workspace and their status.

\`\`\`json
{
  "tool": "list_projects",
  "args": {}
}
\`\`\``;
    expect(parseJsonEnvelopeToolCall(text, KNOWN)).toMatchObject({
      name: 'list_projects',
      arguments: {},
    });
  });

  it('handles the bare (non-fenced) form', () => {
    const text =
      'I will create a project for you.\n\n{ "tool": "create_project", "args": { "name": "Atari Adventure" } }';
    expect(parseJsonEnvelopeToolCall(text, KNOWN)).toMatchObject({
      name: 'create_project',
      arguments: { name: 'Atari Adventure' },
    });
  });

  it('accepts `name`/`arguments` and `function`/`parameters` alternates', () => {
    expect(
      parseJsonEnvelopeToolCall('{"name":"create_project","arguments":{"name":"X"}}', KNOWN),
    ).toMatchObject({ name: 'create_project', arguments: { name: 'X' } });
    expect(
      parseJsonEnvelopeToolCall('{"function":"create_project","parameters":{"name":"X"}}', KNOWN),
    ).toMatchObject({ name: 'create_project', arguments: { name: 'X' } });
  });

  it('rejects fabricated tool names not in the known set', () => {
    const text = '{ "tool": "delete_universe", "args": {} }';
    expect(parseJsonEnvelopeToolCall(text, KNOWN)).toBeNull();
  });

  it('rejects when args is missing or not an object', () => {
    expect(parseJsonEnvelopeToolCall('{ "tool": "list_projects" }', KNOWN)).toBeNull();
    expect(parseJsonEnvelopeToolCall('{ "tool": "list_projects", "args": "x" }', KNOWN)).toBeNull();
  });

  it('returns null for plain text mentioning tool names', () => {
    expect(
      parseJsonEnvelopeToolCall('I would call list_projects but I will not.', KNOWN),
    ).toBeNull();
  });

  it('returns matchStart/matchEnd indices so the caller can splice the envelope out', () => {
    const text = 'preamble\n\n{ "tool": "list_projects", "args": {} }\n\nepilogue';
    const result = parseJsonEnvelopeToolCall(text, KNOWN);
    expect(result).not.toBeNull();
    if (result) {
      expect(text.slice(result.matchStart, result.matchEnd)).toBe(
        '{ "tool": "list_projects", "args": {} }',
      );
    }
  });
});

const TASKS_KNOWN = new Set(['list_tasks', 'get_project', 'create_project']);

describe('findUnrecognizedToolEnvelope', () => {
  // After the alias resolver landed (`listtasks` → `list_tasks`,
  // `getProject` → `get_project`), names that are merely punctuation /
  // case off no longer reach `findUnrecognizedToolEnvelope` — those are
  // promoted upstream. The tests below use typos with at least one
  // *letter* off so they fall through to the "did you mean…?" path.

  it('suggests `list_tasks` for `lst_tasks` (typo: dropped letter)', () => {
    const text = '```json\n{ "tool": "lst_tasks", "args": {} }\n```';
    const miss = findUnrecognizedToolEnvelope(text, TASKS_KNOWN);
    expect(miss?.wanted).toBe('lst_tasks');
    expect(miss?.suggestion).toBe('list_tasks');
  });

  it('suggests `get_project` for `get_porject` (typo: transposed letters)', () => {
    const miss = findUnrecognizedToolEnvelope(
      '{ "tool": "get_porject", "args": {"id": "x"} }',
      TASKS_KNOWN,
    );
    expect(miss?.suggestion).toBe('get_project');
  });

  it('returns null when the envelope name is in the known set (not our concern)', () => {
    const miss = findUnrecognizedToolEnvelope('{ "tool": "list_tasks", "args": {} }', TASKS_KNOWN);
    expect(miss).toBeNull();
  });

  it('returns null when no envelope is present at all', () => {
    const miss = findUnrecognizedToolEnvelope('Just plain prose, no JSON.', TASKS_KNOWN);
    expect(miss).toBeNull();
  });

  it('returns no suggestion when nothing is close enough', () => {
    const miss = findUnrecognizedToolEnvelope(
      '{ "tool": "delete_universe", "args": {} }',
      TASKS_KNOWN,
    );
    expect(miss?.wanted).toBe('delete_universe');
    expect(miss?.suggestion).toBeNull();
  });

  it('exposes matchStart / matchEnd so the caller can splice the bad envelope out of the bubble', () => {
    const text = 'Let me list the tasks.\n\n```json\n{ "tool": "lst_tasks", "args": {} }\n```';
    const miss = findUnrecognizedToolEnvelope(text, TASKS_KNOWN);
    expect(miss).not.toBeNull();
    // matchStart points at the opening `{`, matchEnd just after the closing `}`.
    expect(text.slice(miss!.matchStart, miss!.matchEnd)).toBe(
      '{ "tool": "lst_tasks", "args": {} }',
    );
  });

  it('returns null for names the alias resolver would promote — those are not "unrecognized"', () => {
    // `listtasks` aliases to `list_tasks` (same letters, no underscore).
    // The salvage pipeline already promotes these to real calls, so the
    // "did you mean…?" retry path must NOT fire on them.
    const miss = findUnrecognizedToolEnvelope(
      '{ "tool": "listtasks", "args": {} }',
      new Set(['list_tasks']),
    );
    expect(miss).toBeNull();
  });
});

describe('resolveToolNameAlias', () => {
  const KNOWN_TOOLS = new Set(['create_task', 'list_tasks', 'get_project', 'update_project']);

  it('returns the name unchanged when it is an exact known match', () => {
    expect(resolveToolNameAlias('create_task', KNOWN_TOOLS)).toBe('create_task');
  });

  it('aliases dropped underscores (createtask → create_task)', () => {
    expect(resolveToolNameAlias('createtask', KNOWN_TOOLS)).toBe('create_task');
  });

  it('aliases camelCase (getProject → get_project)', () => {
    expect(resolveToolNameAlias('getProject', KNOWN_TOOLS)).toBe('get_project');
  });

  it('aliases all-caps (LIST_TASKS → list_tasks)', () => {
    expect(resolveToolNameAlias('LIST_TASKS', KNOWN_TOOLS)).toBe('list_tasks');
  });

  it('aliases hyphens (create-task → create_task)', () => {
    expect(resolveToolNameAlias('create-task', KNOWN_TOOLS)).toBe('create_task');
  });

  it('returns null for typos that do not normalize to an exact match', () => {
    // `geet_project` and `get_project` differ by an extra letter — too
    // risky to alias silently. The "did you mean…?" retry handles these.
    expect(resolveToolNameAlias('geet_project', KNOWN_TOOLS)).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(resolveToolNameAlias('', KNOWN_TOOLS)).toBeNull();
  });

  it('returns null when no known tool normalizes to the wanted name', () => {
    expect(resolveToolNameAlias('delete_universe', KNOWN_TOOLS)).toBeNull();
  });
});

describe('alias-aware salvage end-to-end', () => {
  const KNOWN_ALIAS = new Set(['create_task', 'list_tasks', 'get_project']);

  it('parseJsonEnvelopeToolCall promotes a punctuation-stripped name to the canonical tool', () => {
    const text = '```json\n{ "tool": "createtask", "args": {"title": "x"} }\n```';
    const parsed = parseJsonEnvelopeToolCall(text, KNOWN_ALIAS);
    expect(parsed?.name).toBe('create_task');
    expect(parsed?.arguments).toEqual({ title: 'x' });
  });

  it('parseJsonEnvelopeToolCalls aliases each chained envelope', () => {
    const text =
      '```json\n{ "tool": "listtasks", "args": {} }\n```\n```json\n{ "tool": "getProject", "args": {"id": "p"} }\n```';
    const calls = parseJsonEnvelopeToolCalls(text, KNOWN_ALIAS);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.name).toBe('list_tasks');
    expect(calls[1]!.name).toBe('get_project');
  });

  it('findProseToolCallSpan promotes a camelCase prose call', () => {
    const text = 'I will run getProject({"id": "p"}) now.';
    const span = findProseToolCallSpan(text, KNOWN_ALIAS);
    expect(span?.name).toBe('get_project');
  });

  it('parseGemmaToolCall accepts an aliased Gemma envelope', () => {
    const parsed = parseGemmaToolCall('createtask{"title":"x"}', KNOWN_ALIAS);
    expect(parsed?.name).toBe('create_task');
  });
});

describe('stripJsonEnvelopeFromText', () => {
  it('strips a fenced JSON envelope cleanly, leaving narrative behind', () => {
    const text =
      'I\'ll list projects.\n\n```json\n{"tool":"list_projects","args":{}}\n```\n\nDone.';
    const start = text.indexOf('{"tool"');
    const end = text.indexOf('}}') + 2;
    expect(stripJsonEnvelopeFromText(text, start, end)).toBe("I'll list projects.\n\nDone.");
  });

  it('strips a bare (non-fenced) envelope', () => {
    const text = 'Calling now: { "tool": "list_projects", "args": {} } — done.';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}') + 1;
    expect(stripJsonEnvelopeFromText(text, start, end)).toBe('Calling now:  — done.');
  });
});

describe('stripReasoningTags', () => {
  it('removes a closed `<think>...</think>` block', () => {
    expect(stripReasoningTags('<think>plan: do X</think>Here is the answer.')).toBe(
      'Here is the answer.',
    );
  });

  it('removes an unclosed leading `<think>` block at a paragraph break', () => {
    expect(stripReasoningTags('<think>I should think...\n\nActual answer here.')).toBe(
      'Actual answer here.',
    );
  });

  it('handles `<reasoning>` tags too', () => {
    expect(stripReasoningTags('<reasoning>step 1, step 2</reasoning>Final answer.')).toBe(
      'Final answer.',
    );
  });

  it('removes a closed `[THINK]...[/THINK]` block (Mistral Medium 3.5)', () => {
    expect(stripReasoningTags('[THINK]weigh options[/THINK]Here is the answer.')).toBe(
      'Here is the answer.',
    );
  });

  it('removes a leading `[THINK]` block when the chat template prefilled the opener', () => {
    expect(stripReasoningTags('plan: weigh A vs B[/THINK]\nFinal answer.')).toBe('Final answer.');
  });

  it('is a no-op on text with no reasoning tags', () => {
    expect(stripReasoningTags('Plain answer.')).toBe('Plain answer.');
  });

  it('strips leading reasoning prose ending with </think> (Qwen 3.6 enable_thinking pattern)', () => {
    // Wild-caught: Qwen 3.6 with `enable_thinking=True`. The chat
    // template injects `<think>\n` into the prompt, so the model's
    // raw output starts mid-reasoning (no `<think>` opener) and
    // emits `</think>` before the visible reply. Old behavior
    // preserved "Real text" — leaked the entire reasoning block.
    // New behavior drops everything from start to and including
    // `</think>`.
    expect(stripReasoningTags('Real text</think> more text.')).toBe('more text.');
  });

  it('only strips the leading reasoning block, preserving stray </think> in later prose', () => {
    // Per-iteration content has at most one `</think>` (the close
    // for the chat-template-injected `<think>`). A stray `</think>`
    // later in the same iteration's content would be a model
    // anomaly — preserve the surrounding content rather than eat
    // visible text between two close tags. Multi-iteration cases
    // are handled at the streaming-buffer level (UI strip) where
    // `</tool_call>` boundaries can be used.
    const input = 'iter reasoning</think>\n\nvisible content with stray </think> tag in prose.';
    const out = stripReasoningTags(input);
    expect(out).not.toContain('iter reasoning');
    expect(out).not.toContain('</think>');
    expect(out).toContain('visible content with stray');
    expect(out).toContain('tag in prose.');
  });

  it('handles the wild-caught Atari Combat shape: long reasoning + </think> + tool-call markup', () => {
    // Exact pattern from Ada's bundle — paragraphs of "The user is
    // asking me..." reasoning, a `</think>` close, then visible
    // prose. Old behavior preserved the reasoning paragraphs;
    // new behavior drops them.
    const input = [
      'The user is asking me to work more on the Atari Combat Clone project.',
      'Let me check what tasks I have and what the current state is.',
      'I have two active tasks:',
      '',
      '1. atari-combat-clone/3 - "Build Atari Combat clone" - phase Game architecture',
      '2. atari-combat-clone/1 - "Build Atari Combat clone" - phase Team assembly',
      '</think>',
      '',
      'Let me check where we left off.',
    ].join('\n');
    const out = stripReasoningTags(input);
    expect(out).not.toContain('The user is asking me');
    expect(out).not.toContain('atari-combat-clone/3');
    expect(out).not.toContain('</think>');
    expect(out).toContain('Let me check where we left off.');
  });
});

describe('extractReasoning', () => {
  it('returns the visible text and the captured reasoning separately', () => {
    const out = extractReasoning('<think>plan: do X</think>Here is the answer.');
    expect(out.visible).toBe('Here is the answer.');
    expect(out.reasoning).toBe('plan: do X');
  });

  it('captures multiple <think> blocks and joins them', () => {
    const out = extractReasoning(
      '<think>first thought</think>Hello.\n\n<think>second thought</think>World.',
    );
    expect(out.visible).toBe('Hello.\n\nWorld.');
    expect(out.reasoning).toBe('first thought\n\nsecond thought');
  });

  it('captures the leading-reasoning shape (no opening <think>)', () => {
    const out = extractReasoning('Real text</think> more text.');
    expect(out.visible).toBe('more text.');
    expect(out.reasoning).toBe('Real text');
  });

  it('captures <reasoning>...</reasoning> blocks too', () => {
    const out = extractReasoning('<reasoning>step 1, step 2</reasoning>Final answer.');
    expect(out.visible).toBe('Final answer.');
    expect(out.reasoning).toBe('step 1, step 2');
  });

  it('captures `[THINK]...[/THINK]` blocks (Mistral Medium 3.5)', () => {
    const out = extractReasoning('[THINK]plan: do X[/THINK]Here is the answer.');
    expect(out.visible).toBe('Here is the answer.');
    expect(out.reasoning).toBe('plan: do X');
  });

  it('returns empty reasoning for plain text', () => {
    const out = extractReasoning('Plain answer.');
    expect(out.visible).toBe('Plain answer.');
    expect(out.reasoning).toBe('');
  });

  it('handles empty input safely', () => {
    expect(extractReasoning('')).toEqual({ visible: '', reasoning: '' });
  });

  it('captures the asymmetric gpt-oss `<|channel>NAME...<channel|>` shape (Gemma 3/4 leak)', () => {
    // Wild-caught from Gemma 4 26B: after routing through the
    // verbose-family `<think>` hint, Gemma started emitting
    // gpt-oss channel markers picked up from training data. The
    // body is reasoning prose that should land in the `reasoning`
    // half, not in the visible reply.
    const input = [
      '<|channel>thought',
      'Plan: do X then Y.',
      "Let's go.<channel|>",
      '',
      'Visible reply continues here.',
    ].join('\n');
    const out = extractReasoning(input);
    expect(out.visible).toBe('Visible reply continues here.');
    expect(out.reasoning).toContain('Plan: do X then Y.');
    expect(out.reasoning).not.toContain('<|channel');
    expect(out.reasoning).not.toContain('<channel|');
  });

  it('captures the gpt-oss canonical `<|channel|>NAME<|message|>...<|end|>` shape', () => {
    const out = extractReasoning(
      '<|channel|>analysis<|message|>step 1, step 2<|end|>Final answer.',
    );
    expect(out.visible).toBe('Final answer.');
    expect(out.reasoning).toBe('step 1, step 2');
  });

  it('strips leaked chat-template framing tokens (gemma4-e4b-q4 `<eos><|tool_response><eos>`)', () => {
    // Wild-caught from gemma4-e4b-q4 (debug bundle): after firing its
    // tool calls the model streamed the chat-template tool-response
    // framing as literal special-token text. None of it is reasoning or
    // reply — it should vanish entirely.
    const out = extractReasoning('<eos><|tool_response><eos>');
    expect(out.visible).toBe('');
    expect(out.reasoning).toBe('');
  });

  it('strips leaked Qwen chat-template markers (qwen3.6-27b-q8 bare `<|im_end|>`)', () => {
    // Wild-caught from qwen3.6-27b-q8 (debug bundle): after firing its
    // tool calls the model streamed the chat-template end-of-turn marker
    // as literal special-token text, which surfaced as the entire body of
    // a THINKING bubble. It is pure framing — it should vanish entirely.
    const out = extractReasoning('<|im_end|>');
    expect(out.visible).toBe('');
    expect(out.reasoning).toBe('');
    expect(extractReasoning('<|im_start|>assistant').visible).toBe('assistant');
  });

  it('strips framing tokens while preserving the surrounding reply text', () => {
    const out = extractReasoning('Lined up a Builder.<eos><|tool_response>');
    expect(out.visible).toBe('Lined up a Builder.');
    expect(out.visible).not.toContain('tool_response');
    expect(out.visible).not.toContain('<eos>');
  });

  it('strips `<|turn>` / `<turn|>` and `<bos>` framing variants', () => {
    const out = extractReasoning('<bos><|turn>Hello there.<turn|>');
    expect(out.visible).toBe('Hello there.');
  });

  it('does NOT strip tool-CALL markers (owned by the streaming stripper)', () => {
    // `<|tool_call>` / `<tool_call|>` must survive extractReasoning so
    // the LeakyToolCallStripper / Gemma salvage path can still see them.
    const out = extractReasoning('<|tool_call>call:x{}<tool_call|>');
    expect(out.visible).toContain('<|tool_call>');
    expect(out.visible).toContain('<tool_call|>');
  });

  it('captures multiple stacked channel blocks (Gemma turn-of-thought across iterations)', () => {
    // Three channel blocks in one turn — common when Gemma plans,
    // emits a malformed tool-call, then re-plans. The captured
    // reasoning should join all three; the visible reply should be
    // empty (or at least contain none of the prose).
    const input = [
      '<|channel>thought',
      'first plan',
      '<channel|>',
      '<|channel>thought',
      'second plan',
      '<channel|>',
      '<|channel>thought',
      'third plan',
      '<channel|>',
    ].join('\n');
    const out = extractReasoning(input);
    expect(out.reasoning).toContain('first plan');
    expect(out.reasoning).toContain('second plan');
    expect(out.reasoning).toContain('third plan');
    expect(out.visible).not.toContain('plan');
  });
});

describe('parseJsonEnvelopeToolCalls (chained tool uses)', () => {
  it('extracts all envelopes back-to-back from a Qwen-style chain', () => {
    const text = `Let me check what projects exist.

\`\`\`json
{ "tool": "list_projects", "args": {} }
\`\`\`

Now check the gezels:

\`\`\`json
{ "tool": "list_gezels", "args": {} }
\`\`\`

Then create one:

\`\`\`json
{ "tool": "create_project", "args": { "name": "Logos", "about": "x", "missionObjectives": "y" } }
\`\`\``;
    const calls = parseJsonEnvelopeToolCalls(text, KNOWN);
    expect(calls.map((c) => c.name)).toEqual(['list_projects', 'list_gezels', 'create_project']);
    expect(calls[0]!.arguments).toEqual({});
    expect(calls[2]!.arguments).toMatchObject({ name: 'Logos' });
  });

  it('skips envelopes with unrecognized names but keeps the chain going', () => {
    // `delete_galaxy` is genuinely unknown — not in KNOWN, doesn't
    // normalize-match anything in there. The valid `update_project`
    // and `create_project` around it should still surface. This was
    // the user-visible bug — one fabricated name in a chain killed
    // every following call. (Note: `createtask` would now be aliased
    // to `create_task` rather than skipped — see the alias-aware
    // salvage suite below for that path.)
    const text = `
{ "tool": "update_project", "args": { "id": "x", "voormanGezelId": "mira" } }
{ "tool": "delete_galaxy", "args": { "projectId": "x" } }
{ "tool": "create_project", "args": { "name": "Y", "about": "z", "missionObjectives": "q" } }
`;
    const calls = parseJsonEnvelopeToolCalls(text, KNOWN);
    expect(calls.map((c) => c.name)).toEqual(['update_project', 'create_project']);
  });

  it('returns an empty array when no envelopes match', () => {
    expect(parseJsonEnvelopeToolCalls('Just plain text with no JSON.', KNOWN)).toEqual([]);
    expect(parseJsonEnvelopeToolCalls('', KNOWN)).toEqual([]);
  });

  it('returns the singular result wrapped in an array for a single envelope', () => {
    const text = '{ "tool": "list_projects", "args": {} }';
    const calls = parseJsonEnvelopeToolCalls(text, KNOWN);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('list_projects');
  });

  it('preserves source order even when envelopes are tightly adjacent', () => {
    const text = '{"tool": "list_projects", "args": {}}{"tool": "list_gezels", "args": {}}';
    const calls = parseJsonEnvelopeToolCalls(text, KNOWN);
    expect(calls.map((c) => c.name)).toEqual(['list_projects', 'list_gezels']);
    // Match offsets for the second envelope are after the first one's end.
    expect(calls[1]!.matchStart).toBeGreaterThanOrEqual(calls[0]!.matchEnd);
  });
});

describe('findTruncatedJsonEnvelope', () => {
  it('detects an unmatched trailing envelope mid-stream', () => {
    const text = `Here's a tool call:

\`\`\`json
{
  "tool": "create_task",
  "args": {
    "title": "Refine"`;
    const truncated = findTruncatedJsonEnvelope(text);
    expect(truncated).not.toBeNull();
    expect(truncated!.wanted).toBe('create_task');
  });

  it('returns null when every brace pair is matched', () => {
    expect(findTruncatedJsonEnvelope('{"tool": "list_projects", "args": {}}')).toBeNull();
  });

  it('returns null when the unmatched brace is unrelated to a tool call', () => {
    // Random unmatched `{` with no tool-name key should not produce a
    // false positive — we only flag truncations that are clearly mid-call.
    expect(findTruncatedJsonEnvelope('Here is a `{` for some reason.')).toBeNull();
  });

  it('skips earlier completed envelopes and only flags the trailing truncation', () => {
    const text = `{"tool": "list_projects", "args": {}}
{"tool": "create_project", "args": {"name": "x"`;
    const truncated = findTruncatedJsonEnvelope(text);
    expect(truncated).not.toBeNull();
    expect(truncated!.wanted).toBe('create_project');
  });
});

describe('stripJsonEnvelopesFromText', () => {
  it('removes multiple envelopes (and their fences) in one pass', () => {
    const text = `Intro line.
\`\`\`json
{ "tool": "list_projects", "args": {} }
\`\`\`

Mid-text.

\`\`\`json
{ "tool": "list_gezels", "args": {} }
\`\`\`

Outro.`;
    const calls = parseJsonEnvelopeToolCalls(text, KNOWN);
    expect(calls).toHaveLength(2);
    const stripped = stripJsonEnvelopesFromText(text, calls);
    expect(stripped).not.toContain('list_projects');
    expect(stripped).not.toContain('list_gezels');
    expect(stripped).not.toContain('```json');
    expect(stripped).toContain('Intro line.');
    expect(stripped).toContain('Mid-text.');
    expect(stripped).toContain('Outro.');
  });

  it('drops everything from a truncated tail when truncatedFromIndex is supplied', () => {
    const text = `Body text.
\`\`\`json
{ "tool": "create_task", "args": {`;
    const truncated = findTruncatedJsonEnvelope(text);
    expect(truncated).not.toBeNull();
    const stripped = stripJsonEnvelopesFromText(text, [], truncated!.matchStart);
    expect(stripped).toBe('Body text.');
  });

  it('handles complete envelopes plus a truncated tail together', () => {
    const text = `\`\`\`json
{ "tool": "list_projects", "args": {} }
\`\`\`

\`\`\`json
{ "tool": "create_task", "args": { "title": "x"`;
    const calls = parseJsonEnvelopeToolCalls(text, KNOWN);
    const truncated = findTruncatedJsonEnvelope(text);
    expect(calls).toHaveLength(1);
    expect(truncated).not.toBeNull();
    const stripped = stripJsonEnvelopesFromText(text, calls, truncated!.matchStart);
    expect(stripped).toBe('');
  });

  it('is a no-op when nothing is provided to strip', () => {
    expect(stripJsonEnvelopesFromText('hello world', [])).toBe('hello world');
  });
});

describe('findTruncatedProseToolCall', () => {
  it('detects a prose call with an unmatched args brace (no closing })', () => {
    const text = `You're right — I should have acted. Let me act now.

ask_user_question({
  question: "The Gezel Logos project is in 'Review & iterate' phase. We've completed the UX audit and need your feedback on`;
    // Add ask_user_question to known so it's recognized.
    const known = new Set([...KNOWN, 'ask_user_question']);
    const truncated = findTruncatedProseToolCall(text, known);
    expect(truncated).not.toBeNull();
    expect(truncated!.wanted).toBe('ask_user_question');
  });

  it('detects a prose call with balanced args but no closing paren', () => {
    const text = 'Let me try create_project({ "name": "Logos", "about": "x" }';
    const truncated = findTruncatedProseToolCall(text, KNOWN);
    expect(truncated).not.toBeNull();
    expect(truncated!.wanted).toBe('create_project');
  });

  it('returns null for a complete prose call', () => {
    const text = 'create_project({ "name": "Logos", "about": "x" })';
    expect(findTruncatedProseToolCall(text, KNOWN)).toBeNull();
  });

  it('returns null when the function-shaped match is not a known tool', () => {
    // Unknown name "highlight" should not produce a false positive.
    const text = 'I would highlight({ a: 1, b: 2';
    expect(findTruncatedProseToolCall(text, KNOWN)).toBeNull();
  });

  it('returns null on legitimate prose with parens', () => {
    const text = "I'd recommend (a) doing X and (b) doing Y.";
    expect(findTruncatedProseToolCall(text, KNOWN)).toBeNull();
  });

  it('returns the LAST truncated call when multiple are present', () => {
    // First call is complete; second is truncated.
    const text =
      'create_project({ "name": "X", "about": "y", "missionObjectives": "z" }) then list_projects({';
    const truncated = findTruncatedProseToolCall(text, KNOWN);
    expect(truncated).not.toBeNull();
    expect(truncated!.wanted).toBe('list_projects');
  });

  it('returns null for empty input or empty known-tools set', () => {
    expect(findTruncatedProseToolCall('', KNOWN)).toBeNull();
    expect(findTruncatedProseToolCall('create_project({', new Set())).toBeNull();
  });
});

describe('findTruncatedProseToolCall — partial-args extraction (write_file truncation salvage)', () => {
  const WRITE_KNOWN = new Set(['write_file', 'write_artifact', 'append_to_file']);

  it('extracts path + partial content when content string is cut mid-stream', () => {
    // The headline failure shape: write_file started, content arg
    // opened, stream ended without a closing quote.
    const text = 'write_file({"path": "index.html", "content": "<!DOCTYPE html>\\n<html>\\n<body>';
    const tr = findTruncatedProseToolCall(text, WRITE_KNOWN);
    expect(tr).not.toBeNull();
    expect(tr!.wanted).toBe('write_file');
    expect(tr!.partialArgs.path).toBe('index.html');
    expect(typeof tr!.partialArgs.content).toBe('string');
    // The captured content should include what the model emitted
    // before EOS — JSON escape sequences decoded back to real chars.
    const c = String(tr!.partialArgs.content);
    expect(c).toContain('<!DOCTYPE html>');
    expect(c).toContain('<html>');
    expect(c).toContain('<body>');
  });

  it('extracts complete args when only the close-paren is missing', () => {
    // Args fully balanced, just the trailing `)` never arrived.
    // Should hand back complete args (path + full content).
    const text = 'write_file({"path": "x.txt", "content": "hello world"}';
    const tr = findTruncatedProseToolCall(text, WRITE_KNOWN);
    expect(tr).not.toBeNull();
    expect(tr!.partialArgs).toEqual({ path: 'x.txt', content: 'hello world' });
  });

  it('handles literal newlines in the truncated content', () => {
    // Realistic Gemma streaming: real newlines inside the JSON
    // string value. extractPartialArgs walks char-by-char so raw
    // control chars don't break it.
    const text = 'write_file({"path": "game.html", "content": "<html>\n<body>\n<script>alert(1)';
    const tr = findTruncatedProseToolCall(text, WRITE_KNOWN);
    expect(tr).not.toBeNull();
    expect(tr!.partialArgs.path).toBe('game.html');
    const c = String(tr!.partialArgs.content);
    expect(c).toContain('<html>\n<body>');
    expect(c).toContain('alert(1)');
  });

  it('extracts JavaScript-object template-string write_file args cut mid-content', () => {
    const text =
      'write_file({\n' +
      '  path: "index.html",\n' +
      '  content: `\n' +
      '<!DOCTYPE html>\n' +
      '<html><body><div class="board"></div><script>\n' +
      'function checkWin() {';
    const tr = findTruncatedProseToolCall(text, WRITE_KNOWN);
    expect(tr).not.toBeNull();
    expect(tr!.wanted).toBe('write_file');
    expect(tr!.partialArgs.path).toBe('index.html');
    const c = String(tr!.partialArgs.content);
    expect(c).toContain('<!DOCTYPE html>');
    expect(c).toContain('class="board"');
    expect(c).toContain('function checkWin()');
  });

  it('returns empty partialArgs when args block is unparseable', () => {
    // Malformed mid-key — extractor can't recover the path.
    const text = 'write_file({"pa';
    const tr = findTruncatedProseToolCall(text, WRITE_KNOWN);
    expect(tr).not.toBeNull();
    expect(tr!.partialArgs).toEqual({});
  });
});

describe('salvageWriteShapedTruncation — shared Layer-3 helper', () => {
  const WRITE_KNOWN = new Set(['write_file', 'write_artifact', 'append_to_file']);

  it('synthesizes a call from a truncated prose write_file', () => {
    const text = 'write_file({"path": "x.html", "content": "<!DOCTYPE html>\\n<html>';
    const result = salvageWriteShapedTruncation(text, WRITE_KNOWN, 'test-prefix');
    expect(result.synthesizedCall).not.toBeNull();
    expect(result.synthesizedCall!.name).toBe('write_file');
    expect(result.synthesizedCall!.argsObject.path).toBe('x.html');
    expect(result.synthesizedCall!.argsObject.content).toContain('<!DOCTYPE html>');
    expect(result.synthesizedCall!.id).toBe('test-prefix-0');
    expect(result.wanted).toBe('write_file');
  });

  it('synthesizes a call from a truncated JavaScript-object template-string write_file', () => {
    const text =
      'write_file({\n' +
      '  path: "index.html",\n' +
      '  content: `\n' +
      '<!DOCTYPE html>\n' +
      '<html><body><script>\n' +
      'const wins = [[0,1,2]];';
    const result = salvageWriteShapedTruncation(text, WRITE_KNOWN, 'template-prefix');
    expect(result.synthesizedCall).not.toBeNull();
    expect(result.synthesizedCall!.name).toBe('write_file');
    expect(result.synthesizedCall!.argsObject.path).toBe('index.html');
    expect(result.synthesizedCall!.argsObject.content).toContain('const wins');
    expect(result.strippedContent).toBe('');
  });

  it('synthesizes a call from a truncated JSON-envelope write_file', () => {
    const text = '{"tool": "write_artifact", "args": {"path": "out.txt", "content": "hello\\nworld';
    const result = salvageWriteShapedTruncation(text, WRITE_KNOWN, 'envelope-prefix');
    expect(result.synthesizedCall).not.toBeNull();
    expect(result.synthesizedCall!.name).toBe('write_artifact');
    expect(result.synthesizedCall!.argsObject.path).toBe('out.txt');
    expect(result.synthesizedCall!.argsObject.content).toContain('hello\nworld');
  });

  it('returns null for non-write-shaped tools', () => {
    // `set_task_status` truncation should NOT promote to a partial-
    // write salvage — its args aren't bytes to land.
    const known = new Set(['set_task_status', 'write_file']);
    const text = 'set_task_status({"ref": "task-1", "status": "done';
    const result = salvageWriteShapedTruncation(text, known, 'test');
    expect(result.synthesizedCall).toBeNull();
    expect(result.wanted).toBe('set_task_status');
  });

  it('returns null when partial args lack path or content', () => {
    const text = 'write_file({"path": "x.html"'; // no content key
    const result = salvageWriteShapedTruncation(text, WRITE_KNOWN, 'test');
    expect(result.synthesizedCall).toBeNull();
  });

  it('returns the stripped content (truncated tail removed)', () => {
    const text =
      'I will write the file now.\n```javascript\nwrite_file({"path": "x.html", "content": "<!DOCTYPE html>';
    const result = salvageWriteShapedTruncation(text, WRITE_KNOWN, 'test');
    expect(result.synthesizedCall).not.toBeNull();
    expect(result.strippedContent).toContain('I will write the file now.');
    expect(result.strippedContent).not.toContain('write_file({');
  });
});

describe('appendTruncationHintToToolResult', () => {
  it('appends a continuation hint for write-shaped tools', () => {
    const before = 'Wrote 16384 bytes to artifacts/x.html';
    const after = appendTruncationHintToToolResult(before, 'write_file', {
      path: 'x.html',
      content: 'A'.repeat(16384),
    });
    expect(after).not.toBe(before);
    expect(after).toContain('[runtime] Your `write_file` call');
    expect(after).toContain('append_to_file');
    expect(after).toContain('x.html');
    expect(after).toContain('16384 bytes');
  });

  it('skips non-write-shaped tools (no hint appended)', () => {
    const before = 'ok';
    const after = appendTruncationHintToToolResult(before, 'set_task_status', {
      ref: 'task-1',
      status: 'done',
    });
    expect(after).toBe(before);
  });

  it("skips when the tool result is an ERROR (write didn't land)", () => {
    const before = 'ERROR: file path is outside workspace';
    const after = appendTruncationHintToToolResult(before, 'write_file', {
      path: 'x.html',
      content: 'whatever',
    });
    expect(after).toBe(before);
  });

  it('is idempotent — calling twice produces the same output', () => {
    const before = 'Wrote 4 bytes';
    const once = appendTruncationHintToToolResult(before, 'write_artifact', {
      path: 'x.html',
      content: 'data',
    });
    const twice = appendTruncationHintToToolResult(once, 'write_artifact', {
      path: 'x.html',
      content: 'data',
    });
    expect(twice).toBe(once);
  });
});

describe('appendCapTruncationHintToRejectedWrite', () => {
  const REJECTED =
    'ERROR: index.html: inline <script> #1 at line 532, col 1 failed to parse: ' +
    "Unexpected token '}'. Existing index.html was left untouched to preserve the last complete version.";

  it('appends an incremental-edit hint to a rejected write with the cap named', () => {
    const after = appendCapTruncationHintToRejectedWrite(
      REJECTED,
      'write_file',
      {
        path: 'index.html',
        content: 'A'.repeat(30000),
      },
      8192,
    );
    expect(after).not.toBe(REJECTED);
    expect(after).toContain('hit the per-turn output token cap');
    expect(after).toContain('max_tokens=8192');
    expect(after).toContain('replace_in_file(path="index.html"');
    expect(after).toContain('replace_lines(path="index.html"');
    expect(after).toContain('do not retry a full rewrite');
  });

  it('omits the cap label when maxTokens is unknown', () => {
    const after = appendCapTruncationHintToRejectedWrite(
      REJECTED,
      'write_file',
      {
        path: 'index.html',
        content: 'x',
      },
      null,
    );
    expect(after).toContain('hit the per-turn output token cap');
    expect(after).not.toContain('max_tokens=');
  });

  it('skips successful results (nothing to steer)', () => {
    const before = 'Wrote 16384 bytes to index.html';
    const after = appendCapTruncationHintToRejectedWrite(
      before,
      'write_file',
      {
        path: 'index.html',
        content: 'data',
      },
      8192,
    );
    expect(after).toBe(before);
  });

  it('skips non-write-shaped tools', () => {
    const before = 'ERROR: something failed';
    const after = appendCapTruncationHintToRejectedWrite(
      before,
      'set_task_status',
      {
        ref: 'task-1',
      },
      8192,
    );
    expect(after).toBe(before);
  });

  it('skips when args carry no content string', () => {
    const before = 'ERROR: bad call';
    const after = appendCapTruncationHintToRejectedWrite(
      before,
      'write_file',
      {
        path: 'index.html',
      },
      8192,
    );
    expect(after).toBe(before);
  });

  it('is idempotent — calling twice produces the same output', () => {
    const once = appendCapTruncationHintToRejectedWrite(
      REJECTED,
      'write_file',
      {
        path: 'index.html',
        content: 'data',
      },
      8192,
    );
    const twice = appendCapTruncationHintToRejectedWrite(
      once,
      'write_file',
      {
        path: 'index.html',
        content: 'data',
      },
      8192,
    );
    expect(twice).toBe(once);
  });

  it('steers even when the cap ate the ARGUMENTS json and the args arrived sanitized', () => {
    // The shape this helper exists for: generation stopped inside the
    // arguments, so nothing parsed and the call reaches us as `{}` — no
    // `content` to prove truncation with. Without the caller's vouch the
    // guard skipped exactly the case it was written to catch, and the
    // model saw only "malformed JSON — emit one new compact call", which
    // reads as an invitation to rewrite the whole file again.
    const before = 'ERROR: `write_file` was not executed because the model emitted malformed JSON.';
    const after = appendCapTruncationHintToRejectedWrite(before, 'write_file', {}, 16384, {
      argsLostToCap: true,
      pathHint: 'index.html',
    });
    expect(after).not.toBe(before);
    expect(after).toContain('hit the per-turn output token cap');
    expect(after).toContain('max_tokens=16384');
    expect(after).toContain('replace_in_file(path="index.html"');
    expect(after).toContain('do not retry a full rewrite');
  });

  it('covers payload-carrying mutations beyond whole-file writes', () => {
    for (const toolName of [
      'insert_at_marker',
      'replace_in_file',
      'replace_lines',
      'apply_patch',
    ]) {
      const before = `ERROR: ${toolName} was rejected: index.html has an unterminated <script>.`;
      const after = appendCapTruncationHintToRejectedWrite(
        before,
        toolName,
        { path: 'index.html', content: 'A'.repeat(30000) },
        16384,
      );
      expect(after, toolName).toContain('hit the per-turn output token cap');
      expect(after, toolName).toContain(`\`${toolName}\` call for \`index.html\``);
    }
  });

  it('names the strategy instead of a fake path when none was recovered', () => {
    const before = 'ERROR: `insert_at_marker` was not executed — malformed JSON arguments.';
    const after = appendCapTruncationHintToRejectedWrite(before, 'insert_at_marker', {}, 16384, {
      argsLostToCap: true,
    });
    expect(after).toContain('hit the per-turn output token cap');
    expect(after).toContain('replace_in_file');
    // A `(unknown path)` placeholder inside a call example gets copied
    // verbatim by small local models.
    expect(after).not.toContain('(unknown path)');
    expect(after).not.toContain('path="');
  });

  it('still skips a non-truncated write whose args carry no content', () => {
    const before = 'ERROR: bad call';
    expect(appendCapTruncationHintToRejectedWrite(before, 'write_file', { path: 'x' }, 8192)).toBe(
      before,
    );
  });
});

describe('write-shaped vs payload-mutation tool sets', () => {
  it('keeps whole-file semantics narrow and cap detection wide', () => {
    for (const name of ['write_file', 'write_artifact', 'append_to_file']) {
      expect(isWriteShapedToolName(name), name).toBe(true);
      expect(isPayloadMutationToolName(name), name).toBe(true);
    }
    // Payload-carrying, but a partial one never lands on disk — so these
    // must stay out of the `{path, content}` salvage/repair paths while
    // still being visible to cap detection.
    for (const name of ['insert_at_marker', 'replace_in_file', 'replace_lines', 'apply_patch']) {
      expect(isWriteShapedToolName(name), name).toBe(false);
      expect(isPayloadMutationToolName(name), name).toBe(true);
    }
    for (const name of ['read_file', 'set_task_status', 'browser_navigate']) {
      expect(isPayloadMutationToolName(name), name).toBe(false);
    }
  });
});

describe('findTruncatedJsonEnvelope — partial-args extraction', () => {
  const WRITE_KNOWN = new Set(['write_file', 'write_artifact', 'append_to_file']);

  it('extracts args from inside an args sub-object when content is truncated', () => {
    const text = '{"tool": "write_file", "args": {"path": "main.js", "content": "function main()';
    const tr = findTruncatedJsonEnvelope(text);
    expect(tr).not.toBeNull();
    expect(tr!.wanted).toBe('write_file');
    expect(tr!.partialArgs.path).toBe('main.js');
    expect(String(tr!.partialArgs.content)).toContain('function main()');
  });

  it('handles `parameters` key alias for the args sub-object', () => {
    const text = '{"name": "write_artifact", "parameters": {"path": "out.txt", "content": "hi';
    const tr = findTruncatedJsonEnvelope(text);
    expect(tr).not.toBeNull();
    expect(tr!.wanted).toBe('write_artifact');
    expect(tr!.partialArgs.path).toBe('out.txt');
    expect(tr!.partialArgs.content).toBe('hi');
    // Validate this is what the MLX salvage pipeline would gate on.
    expect(WRITE_KNOWN.has(tr!.wanted!)).toBe(true);
  });

  it('returns empty partialArgs when there is no args sub-object (top-level only)', () => {
    // Just a function name and nothing else useful — should NOT
    // fabricate args.
    const text = '{"tool": "write_file"';
    const tr = findTruncatedJsonEnvelope(text);
    expect(tr).not.toBeNull();
    expect(tr!.wanted).toBe('write_file');
    // Top-level extraction may pick up the name key as a string,
    // but it definitely shouldn't fabricate a path or content.
    expect(tr!.partialArgs.path).toBeUndefined();
    expect(tr!.partialArgs.content).toBeUndefined();
  });
});

describe('findXmlTagToolCallSpans', () => {
  it('salvages the wild-caught Qwen 3.6 27B browser_navigate self-closing tag', () => {
    const text =
      'Let me navigate to the URL and take a snapshot.\n\n' +
      '<browser_navigate url="https://weather.com/weather/tenday/l/McKinley+Park+Chicago+Illinois?canonicalCityId=c54457c9e7a5ffd92466a3ac7242ff77" />';
    const spans = findXmlTagToolCallSpans(text, KNOWN);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('browser_navigate');
    expect(spans[0]!.arguments).toEqual({
      url: 'https://weather.com/weather/tenday/l/McKinley+Park+Chicago+Illinois?canonicalCityId=c54457c9e7a5ffd92466a3ac7242ff77',
    });
  });

  it('salvages the open/close tag form by treating attributes as args', () => {
    const text = '<write_artifact path="notes.md" content="hello"></write_artifact>';
    const span = findXmlTagToolCallSpan(text, KNOWN);
    expect(span).not.toBeNull();
    expect(span!.name).toBe('write_artifact');
    expect(span!.arguments).toEqual({ path: 'notes.md', content: 'hello' });
  });

  it('salvages a zero-attribute tag (read-only tools take no args)', () => {
    const span = findXmlTagToolCallSpan('<list_projects />', KNOWN);
    expect(span).not.toBeNull();
    expect(span!.name).toBe('list_projects');
    expect(span!.arguments).toEqual({});
  });

  it('coerces numeric and boolean attribute values', () => {
    const KNOWN_PLUS = new Set([...KNOWN, 'set_threshold']);
    const span = findXmlTagToolCallSpan(
      '<set_threshold value="0.5" enabled="true" retries="3" />',
      KNOWN_PLUS,
    );
    expect(span).not.toBeNull();
    expect(span!.arguments).toEqual({ value: 0.5, enabled: true, retries: 3 });
  });

  it('accepts single-quoted attribute values', () => {
    const span = findXmlTagToolCallSpan("<browser_navigate url='https://example.com' />", KNOWN);
    expect(span).not.toBeNull();
    expect(span!.arguments).toEqual({ url: 'https://example.com' });
  });

  it('refuses tags whose name is not a known tool', () => {
    // Crucially, `<think>...</think>` reasoning markers must not match
    // — there is no MCP tool named `think`. Same for any made-up tool.
    expect(findXmlTagToolCallSpan('<think>I should call X</think>', KNOWN)).toBeNull();
    expect(findXmlTagToolCallSpan('<delete_database table="users" />', KNOWN)).toBeNull();
  });

  it('returns multiple spans in source order when the model chains calls', () => {
    const text =
      '<list_projects />\n' + 'then\n' + '<create_project name="Atari Adventure" about="game" />';
    const spans = findXmlTagToolCallSpans(text, KNOWN);
    expect(spans).toHaveLength(2);
    expect(spans.map((s) => s.name)).toEqual(['list_projects', 'create_project']);
    expect(spans[0]!.start).toBeLessThan(spans[1]!.start);
  });

  it('resolves punctuation/case aliases (camelCase → snake_case)', () => {
    const span = findXmlTagToolCallSpan('<browserNavigate url="https://x.com" />', KNOWN);
    expect(span).not.toBeNull();
    expect(span!.name).toBe('browser_navigate');
  });

  it('returns nothing for empty input or empty known-tools set', () => {
    expect(findXmlTagToolCallSpans('', KNOWN)).toEqual([]);
    expect(findXmlTagToolCallSpans('<list_projects />', new Set())).toEqual([]);
  });
});

describe('stripXmlTagToolCallsFromText', () => {
  it('splices the salvaged tag out of visible content', () => {
    const text = 'Let me navigate now.\n\n<browser_navigate url="https://example.com" />\n\nDone.';
    const spans = findXmlTagToolCallSpans(text, KNOWN);
    const stripped = stripXmlTagToolCallsFromText(text, spans);
    expect(stripped).not.toContain('browser_navigate');
    expect(stripped).toContain('Let me navigate now.');
    expect(stripped).toContain('Done.');
  });

  it('handles multiple spans without offset corruption', () => {
    const text = 'First: <list_projects />\nSecond: <create_project name="X" about="y" />\nDone.';
    const spans = findXmlTagToolCallSpans(text, KNOWN);
    expect(spans).toHaveLength(2);
    const stripped = stripXmlTagToolCallsFromText(text, spans);
    expect(stripped).not.toContain('<list_projects');
    expect(stripped).not.toContain('<create_project');
    expect(stripped).toContain('First:');
    expect(stripped).toContain('Second:');
    expect(stripped).toContain('Done.');
  });

  it('is a no-op when there are no spans', () => {
    expect(stripXmlTagToolCallsFromText('hello', [])).toBe('hello');
  });
});

describe('findClaudeInvokeToolCallSpans', () => {
  it('salvages the wild-caught Qwen 3.6 27B browser_snapshot invoke', () => {
    const text =
      'I have navigated to the page. Now I need to take a snapshot.\n\n' +
      '<function_calls>\n' +
      '<invoke name="browser_snapshot">\n' +
      '</invoke>\n' +
      '</function_calls>';
    const spans = findClaudeInvokeToolCallSpans(text, KNOWN);
    // browser_snapshot isn't in the default KNOWN set — let's add it.
    const KNOWN_PLUS = new Set([...KNOWN, 'browser_snapshot']);
    const out = findClaudeInvokeToolCallSpans(text, KNOWN_PLUS);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('browser_snapshot');
    expect(out[0]!.arguments).toEqual({});
    // And without it being known, the span is rejected (not fabricated).
    expect(spans).toHaveLength(0);
  });

  it('parses parameters from nested <parameter> elements', () => {
    const text =
      '<invoke name="browser_navigate">\n' +
      '  <parameter name="url">https://example.com</parameter>\n' +
      '</invoke>';
    const span = findClaudeInvokeToolCallSpan(text, KNOWN);
    expect(span).not.toBeNull();
    expect(span!.name).toBe('browser_navigate');
    expect(span!.arguments).toEqual({ url: 'https://example.com' });
  });

  it('coerces numeric and boolean parameter values', () => {
    const KNOWN_PLUS = new Set([...KNOWN, 'set_threshold']);
    const text =
      '<invoke name="set_threshold">\n' +
      '<parameter name="value">0.5</parameter>\n' +
      '<parameter name="enabled">true</parameter>\n' +
      '<parameter name="retries">3</parameter>\n' +
      '</invoke>';
    const span = findClaudeInvokeToolCallSpan(text, KNOWN_PLUS);
    expect(span).not.toBeNull();
    expect(span!.arguments).toEqual({ value: 0.5, enabled: true, retries: 3 });
  });

  it('works with or without the <function_calls> wrapper', () => {
    const wrapped = '<function_calls><invoke name="list_projects"></invoke></function_calls>';
    const bare = '<invoke name="list_projects"></invoke>';
    expect(findClaudeInvokeToolCallSpan(wrapped, KNOWN)?.name).toBe('list_projects');
    expect(findClaudeInvokeToolCallSpan(bare, KNOWN)?.name).toBe('list_projects');
  });

  it('returns multiple spans in source order when the model chains calls', () => {
    const text =
      '<function_calls>\n' +
      '<invoke name="list_projects"></invoke>\n' +
      '<invoke name="create_project">\n' +
      '<parameter name="name">Atari Adventure</parameter>\n' +
      '<parameter name="about">A game</parameter>\n' +
      '</invoke>\n' +
      '</function_calls>';
    const spans = findClaudeInvokeToolCallSpans(text, KNOWN);
    expect(spans).toHaveLength(2);
    expect(spans.map((s) => s.name)).toEqual(['list_projects', 'create_project']);
    expect(spans[0]!.start).toBeLessThan(spans[1]!.start);
    expect(spans[1]!.arguments).toEqual({ name: 'Atari Adventure', about: 'A game' });
  });

  it('refuses unknown tool names (defense against fabrication)', () => {
    expect(
      findClaudeInvokeToolCallSpans('<invoke name="delete_database"></invoke>', KNOWN),
    ).toEqual([]);
  });

  it('resolves punctuation/case aliases (camelCase → snake_case)', () => {
    const span = findClaudeInvokeToolCallSpan('<invoke name="listProjects"></invoke>', KNOWN);
    expect(span).not.toBeNull();
    expect(span!.name).toBe('list_projects');
  });

  it('returns nothing for empty input or empty known-tools set', () => {
    expect(findClaudeInvokeToolCallSpans('', KNOWN)).toEqual([]);
    expect(
      findClaudeInvokeToolCallSpans('<invoke name="list_projects"></invoke>', new Set()),
    ).toEqual([]);
  });
});

describe('stripClaudeInvokeToolCallsFromText', () => {
  it('splices the salvaged invoke out of visible content', () => {
    const text =
      'Let me take a snapshot.\n\n' +
      '<function_calls>\n<invoke name="list_projects"></invoke>\n</function_calls>\n\n' +
      'Done.';
    const spans = findClaudeInvokeToolCallSpans(text, KNOWN);
    expect(spans).toHaveLength(1);
    const stripped = stripClaudeInvokeToolCallsFromText(text, spans);
    expect(stripped).not.toContain('<invoke');
    expect(stripped).not.toContain('<function_calls>');
    expect(stripped).toContain('Let me take a snapshot.');
    expect(stripped).toContain('Done.');
  });

  it('removes a leftover empty <function_calls></function_calls> wrapper', () => {
    // After the invoke is stripped, the wrapper has no body. We
    // should clean it up so it doesn't render as visible markup.
    const text = '<function_calls>\n<invoke name="list_projects"></invoke>\n</function_calls>';
    const spans = findClaudeInvokeToolCallSpans(text, KNOWN);
    const stripped = stripClaudeInvokeToolCallsFromText(text, spans);
    expect(stripped).not.toContain('function_calls');
    expect(stripped.trim()).toBe('');
  });

  it('handles multiple spans in one string without offset corruption', () => {
    const text =
      '<function_calls>\n' +
      '<invoke name="list_projects"></invoke>\n' +
      '<invoke name="list_gezels"></invoke>\n' +
      '</function_calls>';
    const spans = findClaudeInvokeToolCallSpans(text, KNOWN);
    expect(spans).toHaveLength(2);
    const stripped = stripClaudeInvokeToolCallsFromText(text, spans);
    expect(stripped).not.toContain('list_projects');
    expect(stripped).not.toContain('list_gezels');
    expect(stripped.trim()).toBe('');
  });

  it('is a no-op when there are no spans', () => {
    expect(stripClaudeInvokeToolCallsFromText('hello', [])).toBe('hello');
  });
});

describe('findShellToolCallSpans', () => {
  it('salvages the wild-caught Qwen 3.6 27B shell-style chain', () => {
    const text =
      "I'll grab that weather forecast for you right now.\n\n" +
      '<tool_call>browser_navigate url="https://weather.com/weather/tenday/l/McKinley+Park+Chicago+Illinois?canonicalCityId=c54457c9e7a5ffd92466a3ac7242ff77"\n' +
      '<tool_call>browser_snapshot';
    const KNOWN_PLUS = new Set([...KNOWN, 'browser_snapshot']);
    const spans = findShellToolCallSpans(text, KNOWN_PLUS);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.name).toBe('browser_navigate');
    expect(spans[0]!.arguments).toEqual({
      url: 'https://weather.com/weather/tenday/l/McKinley+Park+Chicago+Illinois?canonicalCityId=c54457c9e7a5ffd92466a3ac7242ff77',
    });
    expect(spans[1]!.name).toBe('browser_snapshot');
    expect(spans[1]!.arguments).toEqual({});
  });

  it('salvages a single shell-style call', () => {
    const span = findShellToolCallSpan('<tool_call>list_projects', KNOWN);
    expect(span).not.toBeNull();
    expect(span!.name).toBe('list_projects');
    expect(span!.arguments).toEqual({});
  });

  it('coerces numeric and boolean argument values', () => {
    const KNOWN_PLUS = new Set([...KNOWN, 'set_threshold']);
    const span = findShellToolCallSpan(
      '<tool_call>set_threshold value="0.5" enabled="true" retries="3"',
      KNOWN_PLUS,
    );
    expect(span).not.toBeNull();
    expect(span!.arguments).toEqual({ value: 0.5, enabled: true, retries: 3 });
  });

  it('accepts single-quoted argument values', () => {
    const span = findShellToolCallSpan("<tool_call>create_project name='Atari Adventure'", KNOWN);
    expect(span).not.toBeNull();
    expect(span!.arguments).toEqual({ name: 'Atari Adventure' });
  });

  it('refuses unknown tool names', () => {
    expect(findShellToolCallSpans('<tool_call>delete_database table="users"', KNOWN)).toEqual([]);
  });

  it('resolves punctuation/case aliases (camelCase → snake_case)', () => {
    const span = findShellToolCallSpan('<tool_call>listProjects', KNOWN);
    expect(span).not.toBeNull();
    expect(span!.name).toBe('list_projects');
  });

  it('ignores the canonical Qwen format (with JSON envelope) so the JSON-envelope salvage handles it', () => {
    // The canonical `<tool_call>\n{"name": ..., "arguments": ...}\n</tool_call>`
    // form contains a `{` after the tag and shouldn't match this
    // shell-style parser. The downstream JSON-envelope salvage is the
    // right home for that shape.
    const text = `<tool_call>\n{"name": "list_projects", "arguments": {}}\n</tool_call>`;
    expect(findShellToolCallSpans(text, KNOWN)).toEqual([]);
  });

  it('returns nothing for empty input or empty known-tools set', () => {
    expect(findShellToolCallSpans('', KNOWN)).toEqual([]);
    expect(findShellToolCallSpans('<tool_call>list_projects', new Set())).toEqual([]);
  });
});

describe('stripShellToolCallsFromText', () => {
  it('splices the salvaged calls out of visible content', () => {
    const text = "I'll grab that.\n<tool_call>list_projects\n<tool_call>list_gezels\nDone.";
    const spans = findShellToolCallSpans(text, KNOWN);
    expect(spans).toHaveLength(2);
    const stripped = stripShellToolCallsFromText(text, spans);
    expect(stripped).not.toContain('<tool_call>');
    expect(stripped).not.toContain('list_projects');
    expect(stripped).not.toContain('list_gezels');
    expect(stripped).toContain("I'll grab that.");
    expect(stripped).toContain('Done.');
  });

  it('is a no-op when there are no spans', () => {
    expect(stripShellToolCallsFromText('hello', [])).toBe('hello');
  });
});

describe('findHermesFunctionToolCallSpans', () => {
  it('salvages the wild-caught Qwen 3.6 27B Hermes-wrapped-in-tool_call shape', () => {
    const text =
      'The user is asking me to check the weather. Let me use the browser to fetch this page.\n\n' +
      '<tool_call>\n' +
      '<function=browser_navigate>\n' +
      '<parameter=url>\n' +
      'https://weather.com/weather/tenday/l/McKinley+Park+Chicago+Illinois?canonicalCityId=c54457c9e7a5ffd92466a3ac7242ff77\n' +
      '</parameter>\n' +
      '</function>\n' +
      '</tool_call>';
    const spans = findHermesFunctionToolCallSpans(text, KNOWN);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('browser_navigate');
    expect(spans[0]!.arguments).toEqual({
      url: 'https://weather.com/weather/tenday/l/McKinley+Park+Chicago+Illinois?canonicalCityId=c54457c9e7a5ffd92466a3ac7242ff77',
    });
  });

  it('salvages the bare Hermes shape without the <tool_call> wrapper', () => {
    const text =
      '<function=create_project>\n' +
      '<parameter=name>Atari Adventure</parameter>\n' +
      '<parameter=about>A retro-style adventure game</parameter>\n' +
      '</function>';
    const span = findHermesFunctionToolCallSpan(text, KNOWN);
    expect(span).not.toBeNull();
    expect(span!.name).toBe('create_project');
    expect(span!.arguments).toEqual({
      name: 'Atari Adventure',
      about: 'A retro-style adventure game',
    });
  });

  it('coerces numeric and boolean parameter values', () => {
    const KNOWN_PLUS = new Set([...KNOWN, 'set_threshold']);
    const text =
      '<function=set_threshold>' +
      '<parameter=value>0.5</parameter>' +
      '<parameter=enabled>true</parameter>' +
      '<parameter=retries>3</parameter>' +
      '</function>';
    const span = findHermesFunctionToolCallSpan(text, KNOWN_PLUS);
    expect(span).not.toBeNull();
    expect(span!.arguments).toEqual({ value: 0.5, enabled: true, retries: 3 });
  });

  it('trims leading/trailing whitespace inside parameter bodies (Qwen-Hermes hybrid format)', () => {
    // Qwen 3.6 commonly wraps the parameter body in newlines:
    //   <parameter=url>
    //   https://...
    //   </parameter>
    const text =
      '<function=browser_navigate>' +
      '<parameter=url>\n   https://example.com   \n</parameter>' +
      '</function>';
    const span = findHermesFunctionToolCallSpan(text, KNOWN);
    expect(span).not.toBeNull();
    expect(span!.arguments).toEqual({ url: 'https://example.com' });
  });

  it('returns multiple spans when the model chains calls', () => {
    const text = '<function=list_projects></function>\n' + '<function=list_gezels></function>';
    const spans = findHermesFunctionToolCallSpans(text, KNOWN);
    expect(spans).toHaveLength(2);
    expect(spans.map((s) => s.name)).toEqual(['list_projects', 'list_gezels']);
  });

  it('refuses unknown tool names', () => {
    expect(findHermesFunctionToolCallSpans('<function=delete_database></function>', KNOWN)).toEqual(
      [],
    );
  });

  it('resolves punctuation/case aliases', () => {
    const span = findHermesFunctionToolCallSpan('<function=listProjects></function>', KNOWN);
    expect(span).not.toBeNull();
    expect(span!.name).toBe('list_projects');
  });

  it('returns nothing for empty input or empty known-tools set', () => {
    expect(findHermesFunctionToolCallSpans('', KNOWN)).toEqual([]);
    expect(
      findHermesFunctionToolCallSpans('<function=list_projects></function>', new Set()),
    ).toEqual([]);
  });
});

describe('findHermesFunctionToolCallSpansLenient', () => {
  // Wild-caught Qwen 3.6 27B on MLX (tictactoe trial):
  // streaming write_file bodies exceeded max_tokens, so `</parameter>`
  // and `</function>` never arrived. The strict parser dropped the
  // call; the lenient parser recovers it.

  const KNOWN_WRITE = new Set([
    'write_file',
    'write_artifact',
    'list_projects',
    'browser_navigate',
  ]);

  it('recovers a write_file call when </parameter> and </function> never arrived (truncated stream)', () => {
    const text =
      'Let me write the file.\n\n' +
      '<tool_call>\n' +
      '<function=write_file>\n' +
      '<parameter=path>\n' +
      'index.html\n' +
      '</parameter>\n' +
      '<parameter=content>\n' +
      '<!DOCTYPE html><html><head><title>x</title></head><body>cut off mid-stream';
    const spans = findHermesFunctionToolCallSpansLenient(text, KNOWN_WRITE);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('write_file');
    expect(spans[0]!.arguments.path).toBe('index.html');
    expect(String(spans[0]!.arguments.content)).toContain('<!DOCTYPE html>');
    expect(String(spans[0]!.arguments.content)).toContain('cut off mid-stream');
  });

  it('still works when </parameter> closers ARE present (degenerate strict case)', () => {
    const text =
      '<function=write_file>\n' +
      '<parameter=path>index.html</parameter>\n' +
      '<parameter=content>hello</parameter>\n' +
      '</function>';
    const spans = findHermesFunctionToolCallSpansLenient(text, KNOWN_WRITE);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.arguments).toEqual({ path: 'index.html', content: 'hello' });
  });

  it('skips an open-only function with no parameters at all (no real call to salvage)', () => {
    // An `<function=write_file>` with NO `<parameter=...>` inside has
    // no usable arguments — promoting it would just produce a
    // missing-required-arg error downstream.
    expect(findHermesFunctionToolCallSpansLenient('<function=write_file>', KNOWN_WRITE)).toEqual(
      [],
    );
  });

  it('skips unknown tool names (gating still applies)', () => {
    expect(
      findHermesFunctionToolCallSpansLenient(
        '<function=does_not_exist>\n<parameter=foo>bar</parameter>',
        KNOWN_WRITE,
      ),
    ).toEqual([]);
  });

  it('handles two consecutive open-only function calls without bleeding between them', () => {
    const text =
      '<function=write_file>\n' +
      '<parameter=path>a.txt</parameter>\n' +
      '<parameter=content>FIRST\n' +
      '<function=write_file>\n' +
      '<parameter=path>b.txt</parameter>\n' +
      '<parameter=content>SECOND';
    const spans = findHermesFunctionToolCallSpansLenient(text, KNOWN_WRITE);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.arguments).toEqual({ path: 'a.txt', content: 'FIRST' });
    expect(spans[1]!.arguments).toEqual({ path: 'b.txt', content: 'SECOND' });
  });

  it('stops the function body at a stray </tool_call> when </function> is missing', () => {
    // Qwen-Hermes hybrid that closes the OUTER wrapper but skips the
    // inner `</function>`. The body should still terminate at the
    // outer closer.
    const text =
      '<tool_call>\n' +
      '<function=write_file>\n' +
      '<parameter=path>x.html</parameter>\n' +
      '<parameter=content>hello\n' +
      '</tool_call>';
    const spans = findHermesFunctionToolCallSpansLenient(text, KNOWN_WRITE);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.arguments.content).toBe('hello');
  });

  it('returns empty for prose-only input without any <function= opener', () => {
    expect(
      findHermesFunctionToolCallSpansLenient("I'll call write_file next turn.", KNOWN_WRITE),
    ).toEqual([]);
  });

  // ── Truncation flag for auto-continuation ────────────────────────

  it('marks span.truncated = true when the last param has no </parameter> AND the function block has no closer', () => {
    const text =
      '<function=write_file>\n' +
      '<parameter=path>index.html</parameter>\n' +
      '<parameter=content>\n' +
      '<!DOCTYPE html><html>cut off mid-stream';
    const spans = findHermesFunctionToolCallSpansLenient(text, KNOWN_WRITE);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.truncated).toBe(true);
  });

  it('does NOT mark truncated when the call closes properly (degenerate strict case)', () => {
    const text =
      '<function=write_file>\n' +
      '<parameter=path>x.html</parameter>\n' +
      '<parameter=content>hello</parameter>\n' +
      '</function>';
    const spans = findHermesFunctionToolCallSpansLenient(text, KNOWN_WRITE);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.truncated).toBeUndefined();
  });

  it('does NOT mark truncated when only the inner </parameter> is missing but the function closes', () => {
    // Trailing `</function>` indicates the model finished the call —
    // even if `</parameter>` was elided, the model thinks it's done.
    // Treat as a "completed" call (no auto-continuation hint needed).
    const text =
      '<function=write_file>\n' +
      '<parameter=path>x.html</parameter>\n' +
      '<parameter=content>hello\n' +
      '</function>';
    const spans = findHermesFunctionToolCallSpansLenient(text, KNOWN_WRITE);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.truncated).toBeUndefined();
  });

  it('marks only the LAST span as truncated when an earlier span closed cleanly', () => {
    const text =
      '<function=write_file>\n' +
      '<parameter=path>a.txt</parameter>\n' +
      '<parameter=content>FIRST</parameter>\n' +
      '</function>\n' +
      '<function=write_file>\n' +
      '<parameter=path>b.txt</parameter>\n' +
      '<parameter=content>SECOND, then truncated';
    const spans = findHermesFunctionToolCallSpansLenient(text, KNOWN_WRITE);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.truncated).toBeUndefined();
    expect(spans[1]!.truncated).toBe(true);
  });
});

describe('stripHermesFunctionToolCallsFromText', () => {
  it('splices the Hermes block AND drops the leftover empty <tool_call> wrapper', () => {
    const text =
      'Let me grab that for you.\n\n' +
      '<tool_call>\n' +
      '<function=browser_navigate>\n' +
      '<parameter=url>https://example.com</parameter>\n' +
      '</function>\n' +
      '</tool_call>\n\n' +
      'Done.';
    const spans = findHermesFunctionToolCallSpans(text, KNOWN);
    expect(spans).toHaveLength(1);
    const stripped = stripHermesFunctionToolCallsFromText(text, spans);
    expect(stripped).not.toContain('<function=');
    expect(stripped).not.toContain('<parameter=');
    expect(stripped).not.toContain('<tool_call>');
    expect(stripped).not.toContain('</tool_call>');
    expect(stripped).toContain('Let me grab that for you.');
    expect(stripped).toContain('Done.');
  });

  it('is a no-op when there are no spans', () => {
    expect(stripHermesFunctionToolCallsFromText('hello', [])).toBe('hello');
  });
});

describe('foldPreToolPreamble', () => {
  const PREAMBLE =
    "The user wants to check the weather for McKinley Park, Chicago, Illinois. They've provided a Weather.com URL. I should use the browser to navigate to this URL.\n\nLet me navigate now.";

  it('drops preamble when a verbose-family model fired a tool call', () => {
    expect(
      foldPreToolPreamble({
        text: PREAMBLE,
        toolCallsFired: true,
        modelLeaksReasoning: true,
      }),
    ).toBe('');
  });

  it('keeps text when no tool calls fired (the text IS the answer)', () => {
    expect(
      foldPreToolPreamble({
        text: 'Here is your answer.',
        toolCallsFired: false,
        modelLeaksReasoning: true,
      }),
    ).toBe('Here is your answer.');
  });

  it('keeps text for non-verbose models even when a tool fires', () => {
    // A Llama 70B saying "I'll search and report back" is intentional
    // UX framing, not chain-of-thought leakage. Don't strip.
    expect(
      foldPreToolPreamble({
        text: "I'll search and report back.",
        toolCallsFired: true,
        modelLeaksReasoning: false,
      }),
    ).toBe("I'll search and report back.");
  });

  it('is a no-op for empty / whitespace-only text', () => {
    expect(foldPreToolPreamble({ text: '', toolCallsFired: true, modelLeaksReasoning: true })).toBe(
      '',
    );
    expect(
      foldPreToolPreamble({
        text: '   \n  ',
        toolCallsFired: true,
        modelLeaksReasoning: true,
      }),
    ).toBe('   \n  ');
  });

  it('folds trailing prose after ask_user_question fired earlier this turn', () => {
    // Wrap-up iteration after the question card was posted: model
    // emits "I asked the user a thing, now waiting" reasoning + a
    // friendly summary. Card is the message; this is decoration.
    const POST_ASK_PROSE =
      "I see I already called `ask_user_question` and it posted. Now I need to wait for the user's answer.\n\nAtari Combat — the classic tank duel game. I've sent you a quick card with a couple of questions.";
    expect(
      foldPreToolPreamble({
        text: POST_ASK_PROSE,
        toolCallsFired: false,
        modelLeaksReasoning: true,
        askedQuestionThisTurn: true,
      }),
    ).toBe('');
  });

  it('does NOT fold post-ask prose for non-verbose models', () => {
    // Non-verbose models that emit "I sent you a card" prose are
    // doing it deliberately. Keep it.
    const intentional = "I've sent you a card with the options.";
    expect(
      foldPreToolPreamble({
        text: intentional,
        toolCallsFired: false,
        modelLeaksReasoning: false,
        askedQuestionThisTurn: true,
      }),
    ).toBe(intentional);
  });

  it('keeps prose when no question asked AND no tools fired (normal final answer)', () => {
    expect(
      foldPreToolPreamble({
        text: 'Here is your answer.',
        toolCallsFired: false,
        modelLeaksReasoning: true,
        askedQuestionThisTurn: false,
      }),
    ).toBe('Here is your answer.');
  });
});

describe('extractWantedToolName / uniqueWantedToolNames', () => {
  it('pulls the function name out of a Gemma `call:NAME{...}` envelope', () => {
    expect(extractWantedToolName('call:start_project{name: "X"}')).toBe('start_project');
  });

  it('pulls the function name out of a bare `NAME{...}` body', () => {
    expect(extractWantedToolName('list_projects{}')).toBe('list_projects');
  });

  it('pulls the function name out of a JSON envelope', () => {
    expect(extractWantedToolName('{"tool": "create_gezel", "args": {"role": "developer"}}')).toBe(
      'create_gezel',
    );
  });

  it('returns null when the body has no recognizable name token', () => {
    expect(extractWantedToolName('thought\nthought\nthought')).toBeNull();
  });

  it('uniqueWantedToolNames preserves emit order and dedups', () => {
    const bodies = [
      'call:start_project{name:"A"}',
      'call:start_project{name:"B"}',
      'list_projects{}',
    ];
    expect(uniqueWantedToolNames(bodies)).toEqual(['start_project', 'list_projects']);
  });

  it('uniqueWantedToolNames normalizes through known aliases', () => {
    const known = new Set(['start_project', 'list_projects']);
    // Hyphenated variant should resolve to the canonical underscore form.
    expect(uniqueWantedToolNames(['start-project{name:"A"}'], known)).toEqual(['start_project']);
  });
});

describe('findUnrecognizedFunctionMarkup', () => {
  const voormanTools = new Set([
    'list_dir',
    'read_file',
    'message_gezel',
    'ask_specialist',
    'write_artifact',
  ]);

  it('catches the `<function=write_file>` markup a voorman emits (Laxmi case)', () => {
    const markup = '<tool_call>\n<function=write_file>\n<parameter=path>\nindex.html\n</parameter>';
    const miss = findUnrecognizedFunctionMarkup(markup, voormanTools);
    expect(miss?.wanted).toBe('write_file');
  });

  it('catches the `<invoke name="X">` Claude shape', () => {
    const miss = findUnrecognizedFunctionMarkup('<invoke name="write_file">', voormanTools);
    expect(miss?.wanted).toBe('write_file');
  });

  it('returns null when the named tool IS available (a builder)', () => {
    const builderTools = new Set(['read_file', 'write_file']);
    expect(findUnrecognizedFunctionMarkup('<function=write_file>', builderTools)).toBeNull();
  });

  it('returns null when the name resolves through an alias', () => {
    const known = new Set(['list_tasks']);
    // hyphen/case variant resolves to the canonical name → not "unknown".
    expect(findUnrecognizedFunctionMarkup('<function=list-tasks>', known)).toBeNull();
  });

  it('ignores prose with no function markup', () => {
    expect(
      findUnrecognizedFunctionMarkup('I will delegate this to the builder.', voormanTools),
    ).toBeNull();
  });
});

describe('buildUnknownToolNudge', () => {
  const voormanTools = new Set(['read_file', 'message_gezel', 'ask_specialist', 'write_artifact']);

  it('routes a no-write-access role to DELEGATION, not "did you mean"', () => {
    const nudge = buildUnknownToolNudge('write_file', null, voormanTools);
    expect(nudge).toMatch(/DELEGATE/);
    expect(nudge).toMatch(/message_gezel/);
    expect(nudge).toMatch(/ensure_gezel/);
    expect(nudge).toMatch(/expectedDeliverable/);
    expect(nudge).toMatch(/Do not call `ask_specialist`/);
    // Must NOT tell a write_file-less role to call write_file.
    expect(nudge).not.toMatch(/call `write_file\(/);
  });

  it('tells a role with neither write_file nor delegation tools to inform the user', () => {
    const nudge = buildUnknownToolNudge('write_file', null, new Set(['read_file']));
    expect(nudge).toMatch(/cannot create the file yourself/i);
    expect(nudge).not.toMatch(/DELEGATE/);
  });

  it('falls back to the typo/"did you mean" nudge for a non-write unknown tool', () => {
    const nudge = buildUnknownToolNudge('listtasks', 'list_tasks', voormanTools);
    expect(nudge).toMatch(/Did you mean `list_tasks`/);
    expect(nudge).not.toMatch(/DELEGATE/);
  });

  it('enumerates the available tools when there is no typo suggestion', () => {
    const tools = new Set(['start_project', 'start_job', 'ask_user_question', 'message_gezel']);
    const nudge = buildUnknownToolNudge('frobnicate', null, tools);
    expect(nudge).toMatch(/Your available tools are:/);
    expect(nudge).toMatch(/`start_project`/);
    expect(nudge).toMatch(/`ask_user_question`/);
    // No longer the vague "check the tool list" pointer.
    expect(nudge).not.toMatch(/check the tool list/);
  });

  it('flags a PARAMETER named as a function (description → start_project)', () => {
    const tools = new Set(['start_project', 'start_job', 'ask_user_question']);
    const paramIndex = new Map<string, readonly string[]>([
      ['description', ['start_project', 'create_task']],
    ]);
    const nudge = buildUnknownToolNudge('description', null, tools, paramIndex);
    expect(nudge).toMatch(/`description` is an ARGUMENT of/);
    expect(nudge).toMatch(/`start_project`/);
    expect(nudge).toMatch(/not a tool/i);
    // Still lists the real tools to pick from.
    expect(nudge).toMatch(/Your available tools are:/);
  });
});

describe('formatToolMenu', () => {
  it('lists tool names backtick-quoted', () => {
    expect(formatToolMenu(new Set(['a', 'b']))).toBe('`a`, `b`');
  });

  it('caps the list and notes the remainder', () => {
    const many = new Set(Array.from({ length: 45 }, (_, i) => `t${i}`));
    expect(formatToolMenu(many, 40)).toMatch(/\(\+5 more\)$/);
  });

  it('handles an empty set', () => {
    expect(formatToolMenu(new Set())).toBe('(no tools available)');
  });
});

describe('findBareInvokeToolCallSpans', () => {
  const tools = new Set(['write_file', 'list_projects', 'create_project']);

  it('salvages the exact gemma4-e2b-q4/MLX shape', () => {
    const text = 'invoke write_file {\n  "path": "preflight.txt",\n  "content": "FLIGHT OK"\n}';
    const spans = findBareInvokeToolCallSpans(text, tools);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('write_file');
    expect(spans[0]?.arguments).toEqual({ path: 'preflight.txt', content: 'FLIGHT OK' });
  });

  it('resolves punctuation/case aliases in the tool name', () => {
    const spans = findBareInvokeToolCallSpans('invoke createProject {"name": "X"}', tools);
    expect(spans[0]?.name).toBe('create_project');
  });

  it('does NOT match prose that lacks a JSON object', () => {
    expect(
      findBareInvokeToolCallSpans('you can invoke write_file to save the file', tools),
    ).toEqual([]);
  });

  it('does NOT match an unknown tool name', () => {
    expect(findBareInvokeToolCallSpans('invoke totally_fake {"x": 1}', tools)).toEqual([]);
  });

  it('strips the salvaged span from visible content', () => {
    const text = 'Sure! invoke write_file {"path":"a.txt","content":"hi"} done.';
    const spans = findBareInvokeToolCallSpans(text, tools);
    expect(stripBareInvokeToolCallsFromText(text, spans)).toBe('Sure!  done.');
  });

  it('returns [] when there are no known tools', () => {
    expect(findBareInvokeToolCallSpans('invoke write_file {"path":"a"}', new Set())).toEqual([]);
  });
});

describe('foldPostActionRumination', () => {
  const WALL = [
    'Let me look at the legal moves: b8-c7, d8-c7, f8-g7.',
    'Wait, the board shows my pieces on row 8. If I am moving down, why are they there? Let me re-read the position and recount: row 8 has b pieces, row 1 has r pieces, so I am on top moving toward row 1. '.repeat(
      6,
    ),
    'Hmm, are there captures I missed? The engine says the legal moves are authoritative.',
    'Solid central square it is — e7 to f6, and the game rolls on! 😄',
  ].join('\n\n');

  it('keeps a conclusive final paragraph and folds the analysis into reasoning', () => {
    const { visible, reasoning } = foldPostActionRumination({
      text: WALL,
      actionFiredEarlierThisTurn: true,
      modelLeaksReasoning: true,
    });
    expect(visible).toBe('Solid central square it is — e7 to f6, and the game rolls on! 😄');
    expect(reasoning).toContain('Let me look at the legal moves');
    expect(reasoning).not.toContain('game rolls on');
  });

  it('folds everything when the tail is truncated mid-thought', () => {
    const truncated = `${WALL.slice(0, WALL.lastIndexOf('\n\n'))}\n\nI should check if there are any captures I missed. The engine says "Legal moves:". If it doesn't list`;
    const { visible, reasoning } = foldPostActionRumination({
      text: truncated,
      actionFiredEarlierThisTurn: true,
      modelLeaksReasoning: true,
    });
    expect(visible).toBe('');
    expect(reasoning).toContain("If it doesn't list");
  });

  it('leaves short wrap-ups untouched', () => {
    const short = 'Played e5 — your move! 😄';
    expect(
      foldPostActionRumination({
        text: short,
        actionFiredEarlierThisTurn: true,
        modelLeaksReasoning: true,
      }),
    ).toEqual({ visible: short, reasoning: '' });
  });

  it('never fires without a prior action this turn (long answers to questions survive)', () => {
    const { visible, reasoning } = foldPostActionRumination({
      text: WALL,
      actionFiredEarlierThisTurn: false,
      modelLeaksReasoning: true,
    });
    expect(visible).toBe(WALL);
    expect(reasoning).toBe('');
  });

  it('never fires for non-leaky models', () => {
    const { visible } = foldPostActionRumination({
      text: WALL,
      actionFiredEarlierThisTurn: true,
      modelLeaksReasoning: false,
    });
    expect(visible).toBe(WALL);
  });
});

describe('findGlmToolCallSpans (GLM-4.5/4.6 <tool_call>NAME<arg_key>…</tool_call>)', () => {
  const GLM_KNOWN = new Set(['write_file', 'write_artifact', 'list_projects', 'create_task']);

  it('parses the wild-caught inline laguna form (name flush against <arg_key>, no newlines)', () => {
    // Exactly what laguna-s-118b emitted in the preflight probe.
    const text =
      '<tool_call>write_file<arg_key>path</arg_key><arg_value>preflight.txt</arg_value>' +
      '<arg_key>content</arg_key><arg_value>PREFLIGHT OK</arg_value></tool_call>';
    const spans = findGlmToolCallSpans(text, GLM_KNOWN);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('write_file');
    expect(spans[0]!.arguments).toEqual({ path: 'preflight.txt', content: 'PREFLIGHT OK' });
    expect(spans[0]!.truncated).toBeUndefined();
  });

  it('parses the chat-template pretty form (name on its own line, indented pairs)', () => {
    const text =
      '<tool_call>create_task\n' +
      '<arg_key>title</arg_key>\n' +
      '<arg_value>Wire the daemon</arg_value>\n' +
      '<arg_key>priority</arg_key>\n' +
      '<arg_value>2</arg_value>\n' +
      '</tool_call>';
    const parsed = findGlmToolCallSpan(text, GLM_KNOWN);
    // Numbers coerce like the sibling parsers; strings stay strings.
    expect(parsed).toMatchObject({
      name: 'create_task',
      arguments: { title: 'Wire the daemon', priority: 2 },
    });
  });

  it('preserves free-text values containing quotes, braces and newlines (write_file body)', () => {
    const body = 'line 1\n{"json": true, "n": 2}\n<not a tag>';
    const text = `<tool_call>write_file<arg_key>path</arg_key><arg_value>a.txt</arg_value><arg_key>content</arg_key><arg_value>${body}</arg_value></tool_call>`;
    const parsed = findGlmToolCallSpan(text, GLM_KNOWN);
    // Raw string content is NOT JSON-parsed — a file that happens to hold
    // JSON must land verbatim, not be coerced into an object.
    expect(parsed!.arguments.content).toBe(body);
  });

  it('resolves punctuation/case aliases through resolveToolNameAlias', () => {
    const text = '<tool_call>WriteFile<arg_key>path</arg_key><arg_value>x</arg_value></tool_call>';
    expect(findGlmToolCallSpan(text, GLM_KNOWN)!.name).toBe('write_file');
  });

  it('refuses an unknown/fabricated function name (safety rail)', () => {
    const text =
      '<tool_call>rm_rf_slash<arg_key>path</arg_key><arg_value>/</arg_value></tool_call>';
    expect(findGlmToolCallSpans(text, GLM_KNOWN)).toHaveLength(0);
  });

  it('salvages an unterminated call, flagging truncation and keeping partial content', () => {
    // Stream ran out mid write_file content: no </arg_value>, no </tool_call>.
    const text =
      '<tool_call>write_file<arg_key>path</arg_key><arg_value>big.md</arg_value>' +
      '<arg_key>content</arg_key><arg_value># Title\nfirst half of the file';
    const parsed = findGlmToolCallSpan(text, GLM_KNOWN);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('write_file');
    expect(parsed!.truncated).toBe(true);
    expect(parsed!.arguments.path).toBe('big.md');
    expect(parsed!.arguments.content).toBe('# Title\nfirst half of the file');
  });

  it('does not fabricate a no-arg call from stray narration mentioning <tool_call>', () => {
    // An unterminated opener with no arg pairs is too weak to promote.
    const text = 'I will now use <tool_call>write_file to save the file for you.';
    expect(findGlmToolCallSpans(text, GLM_KNOWN)).toHaveLength(0);
  });

  it('parses two back-to-back calls in one turn', () => {
    const text =
      '<tool_call>list_projects</tool_call>' +
      '<tool_call>write_file<arg_key>path</arg_key><arg_value>b.txt</arg_value></tool_call>';
    const spans = findGlmToolCallSpans(text, GLM_KNOWN);
    expect(spans.map((s) => s.name)).toEqual(['list_projects', 'write_file']);
    expect(spans[0]!.arguments).toEqual({});
  });

  it('strips salvaged spans out of visible content, leaving surrounding prose', () => {
    const text =
      'Sure, saving now.\n<tool_call>write_file<arg_key>path</arg_key><arg_value>c.txt</arg_value></tool_call>\nDone.';
    const spans = findGlmToolCallSpans(text, GLM_KNOWN);
    const stripped = stripGlmToolCallsFromText(text, spans);
    expect(stripped).not.toContain('<tool_call>');
    expect(stripped).toContain('Sure, saving now.');
    expect(stripped).toContain('Done.');
  });

  it('returns nothing when there are no known tools', () => {
    const text = '<tool_call>write_file<arg_key>path</arg_key><arg_value>x</arg_value></tool_call>';
    expect(findGlmToolCallSpans(text, new Set())).toHaveLength(0);
  });
});
