import { describe, expect, it } from 'vitest';
import {
  findGemmaNativeToolCallSpans,
  parseGemmaNativeToolCall,
  stripGemmaNativeToolCallsFromText,
} from './local-tool-call-salvage.js';

const TOOLS = new Set([
  'write_artifact',
  'write_file',
  'read_file',
  'create_task',
  'get_task',
  'list_tasks',
  'start_project',
]);

describe('parseGemmaNativeToolCall', () => {
  it('parses a single-arg call with multi-line markdown content', () => {
    const body = `call:write_artifact{content:<|"|># Tic-Tac-Toe Implementation Plan

## 1. HTML Structure
- A single \`index.html\` file.
- A 3x3 grid of cells.<|"|>}`;
    const parsed = parseGemmaNativeToolCall(body, TOOLS);
    expect(parsed?.name).toBe('write_artifact');
    expect(parsed?.arguments.content).toMatch(/# Tic-Tac-Toe/);
    expect(parsed?.arguments.content).toContain('1. HTML Structure');
  });

  it('parses multi-key args (path + content)', () => {
    const body = `call:write_artifact{path:<|"|>index.html<|"|>,content:<|"|><html></html><|"|>}`;
    const parsed = parseGemmaNativeToolCall(body, TOOLS);
    expect(parsed).toEqual({
      name: 'write_artifact',
      arguments: { path: 'index.html', content: '<html></html>' },
    });
  });

  it('parses the optional <|tool_call> envelope', () => {
    const body = `<|tool_call>call:get_task{ref:<|"|>tic-tac-toe-browser-game/1<|"|>}<tool_call|>`;
    const parsed = parseGemmaNativeToolCall(body, TOOLS);
    expect(parsed).toEqual({
      name: 'get_task',
      arguments: { ref: 'tic-tac-toe-browser-game/1' },
    });
  });

  it('rejects an unknown tool name', () => {
    const body = `call:not_a_real_tool{x:<|"|>y<|"|>}`;
    expect(parseGemmaNativeToolCall(body, TOOLS)).toBeNull();
  });

  it('rejects empty input', () => {
    expect(parseGemmaNativeToolCall('', TOOLS)).toBeNull();
  });

  it('aliases name with case/punctuation differences', () => {
    // resolveToolNameAlias normalizes both sides — `WriteArtifact` → `write_artifact`.
    const body = `call:WriteArtifact{path:<|"|>x<|"|>}`;
    const parsed = parseGemmaNativeToolCall(body, TOOLS);
    expect(parsed?.name).toBe('write_artifact');
  });

  it('handles string content that contains "literal" double quotes', () => {
    const body = `call:write_artifact{content:<|"|>he said "hi" loudly<|"|>}`;
    const parsed = parseGemmaNativeToolCall(body, TOOLS);
    expect(parsed?.arguments.content).toBe('he said "hi" loudly');
  });

  it('handles string content with backslashes', () => {
    const body = `call:write_artifact{content:<|"|>path: C:\\Users\\test<|"|>}`;
    const parsed = parseGemmaNativeToolCall(body, TOOLS);
    expect(parsed?.arguments.content).toBe('path: C:\\Users\\test');
  });

  it('parses an unterminated string at end-of-buffer (ramble cut-off)', () => {
    const body = `call:write_artifact{content:<|"|><!DOCTYPE html>\n<html><body>incomplete...`;
    const parsed = parseGemmaNativeToolCall(body, TOOLS);
    expect(parsed?.name).toBe('write_artifact');
    expect(parsed?.arguments.content).toMatch(/<!DOCTYPE html>/);
  });

  it('parses booleans and numbers as bare scalars', () => {
    const body = `call:create_task{title:<|"|>X<|"|>,priority:5,active:true}`;
    const parsed = parseGemmaNativeToolCall(body, TOOLS);
    expect(parsed?.arguments).toEqual({ title: 'X', priority: 5, active: true });
  });

  it('parses nested mapping values', () => {
    const body = `call:create_task{spec:{name:<|"|>Y<|"|>,steps:[<|"|>a<|"|>,<|"|>b<|"|>]}}`;
    const parsed = parseGemmaNativeToolCall(body, TOOLS);
    expect(parsed?.arguments).toEqual({ spec: { name: 'Y', steps: ['a', 'b'] } });
  });

  it('parses a leaked start_project envelope with ordinary quoted strings and arrays', () => {
    const body = `<|tool_call>call:start_project{
  name: "Tic-Tac-Toe Game",
  about: "Browser game project.",
  missionObjectives: [
    "The game must be playable.",
    "The game must show a winner."
  ],
  taskDescription: "Build workspace/index.html."
}<tool_call|>`;
    const parsed = parseGemmaNativeToolCall(body, TOOLS);
    expect(parsed).toEqual({
      name: 'start_project',
      arguments: {
        name: 'Tic-Tac-Toe Game',
        about: 'Browser game project.',
        missionObjectives: ['The game must be playable.', 'The game must show a winner.'],
        taskDescription: 'Build workspace/index.html.',
      },
    });
  });

  it('returns null on non-tool-call prose', () => {
    expect(parseGemmaNativeToolCall("I'll think about this.", TOOLS)).toBeNull();
  });

  it('finds and strips leaked native envelopes from visible text', () => {
    const text = 'Before\n<|tool_call>call:start_project{name:"X",about:"Y"}<tool_call|>\nAfter';
    const spans = findGemmaNativeToolCallSpans(text, TOOLS);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('start_project');
    expect(spans[0]?.arguments).toEqual({ name: 'X', about: 'Y' });
    expect(stripGemmaNativeToolCallsFromText(text, spans)).toBe('Before\n\nAfter');
  });

  describe('embedded, unterminated envelope (no closing <tool_call|>)', () => {
    // Wild-caught on gemma4-e4b-q4 / plan-and-estimate: the model echoed its
    // instruction prose and slid straight into a malformed
    // `…Owner |<channel|><|tool_call>call:write_file{content:<|"|># …` with no
    // closing envelope. Before the embedded-marker fallback this produced zero
    // spans (the terminated regex needs a closer; the whole-text fallback
    // anchors the name at `^`), so a real deliverable was silently dropped.
    it('salvages a write_file whose opener is mid-prose and never closes', () => {
      const text =
        'The Work plan section must be a Markdown table with columns exactly ' +
        '`ID | Task | Owner |<channel|><|tool_call>call:write_file{content:<|"|>' +
        '# Relocation Plan: Studio to Harbourview\n\n| ID | Task | Owner |\n| 1 | Pack | deepak |';
      const spans = findGemmaNativeToolCallSpans(text, TOOLS);
      expect(spans).toHaveLength(1);
      expect(spans[0]?.name).toBe('write_file');
      expect(spans[0]?.arguments.content).toMatch(/# Relocation Plan/);
      expect(spans[0]?.arguments.content).toContain('| Pack | deepak |');
    });

    it('captures a path key when the model does emit one before content', () => {
      const text =
        'prose prose |<channel|><|tool_call>call:write_file{path:<|"|>plan.md<|"|>,content:<|"|># Plan\nline2';
      const spans = findGemmaNativeToolCallSpans(text, TOOLS);
      expect(spans).toHaveLength(1);
      expect(spans[0]?.arguments).toMatchObject({ path: 'plan.md' });
      expect(spans[0]?.arguments.content).toMatch(/# Plan/);
    });

    it('does NOT fabricate a call from prose that merely mentions a tool name', () => {
      const text =
        'The developer should call write_file to save the plan. Owner | write_file matters.';
      expect(findGemmaNativeToolCallSpans(text, TOOLS)).toHaveLength(0);
    });

    it('the span spans from the opener to end-of-text so the marker is stripped', () => {
      const text = 'keep me <|tool_call>call:write_file{content:<|"|>hi';
      const spans = findGemmaNativeToolCallSpans(text, TOOLS);
      expect(spans).toHaveLength(1);
      expect(stripGemmaNativeToolCallsFromText(text, spans)).toBe('keep me ');
    });
  });

  describe('peg-parse dropped shapes (cbmx-20260720-195716)', () => {
    // llama-server's peg-gemma4 parser logs `W common_chat_peg_parse:
    // unparsed peg-gemma4 output: …` on these and streams nothing (the
    // full-drop case) or leaks a fragment into `content` (the cases
    // below). Exact wild-caught strings, file contents redacted to stubs.

    it('parses back-to-back terminated read_file envelopes (craftbook-crm-update-batch)', () => {
      const text =
        '<|tool_call>call:read_file{path:<|"|>source/schema.md<|"|>}<tool_call|>' +
        '<|tool_call>call:read_file{path:<|"|>source/call-notes.md<|"|>}<tool_call|>';
      const spans = findGemmaNativeToolCallSpans(text, TOOLS);
      expect(spans).toHaveLength(2);
      expect(spans[0]).toMatchObject({
        name: 'read_file',
        arguments: { path: 'source/schema.md' },
      });
      expect(spans[1]).toMatchObject({
        name: 'read_file',
        arguments: { path: 'source/call-notes.md' },
      });
      expect(stripGemmaNativeToolCallsFromText(text, spans)).toBe('');
    });

    it('parses a write_file embedded after channel-markup prose (craftbook-crm-update-batch)', () => {
      const text =
        'The CSV must have a specific 1<channel|><|tool_call>call:write_file{content:<|"|>' +
        'account_name,object_type,source_quote\nAcme Corp,Contact,"Quote ID 123"' +
        '<|"|>,path:<|"|>updates.csv<|"|>}<tool_call|>';
      const spans = findGemmaNativeToolCallSpans(text, TOOLS);
      expect(spans).toHaveLength(1);
      expect(spans[0]?.name).toBe('write_file');
      expect(spans[0]?.arguments.path).toBe('updates.csv');
      expect(spans[0]?.arguments.content).toContain('Acme Corp');
    });

    it('parses a terminated-brace call whose <tool_call|> closer is followed by prose (craftbook-juice-pass)', () => {
      const text =
        '<|tool_call>call:write_file{content:<|"|><!DOCTYPE html>\n<html lang="en">\n</html>' +
        '<|"|>,path:<|"|>index.html<|"|>}<tool_call|>I have written the final version of `index.html`.';
      const spans = findGemmaNativeToolCallSpans(text, TOOLS);
      expect(spans).toHaveLength(1);
      expect(spans[0]?.name).toBe('write_file');
      expect(spans[0]?.arguments.path).toBe('index.html');
      expect(spans[0]?.arguments.content).toMatch(/<!DOCTYPE html>/);
      expect(stripGemmaNativeToolCallsFromText(text, spans)).toBe(
        'I have written the final version of `index.html`.',
      );
    });

    describe('headless body (engine ate the `<|tool_call>call:write_file{` prefix)', () => {
      // craftbook-documentation-drift-review: turnContent BEGAN at the
      // first arg key — llama-server consumed the opener + name, choked
      // mid-parse, and leaked the remainder as content.
      it('infers write_file from a leading content+path body and strips only the span', () => {
        const text =
          'content:<|"|>// src/config.ts\n\nexport const SERVER_PORT = 8100;\n' +
          '<|"|>,path:<|"|>src/config.ts<|"|>}` (Self-correction: I need to check what I *actually* wrote.)';
        const spans = findGemmaNativeToolCallSpans(text, TOOLS);
        expect(spans).toHaveLength(1);
        expect(spans[0]?.name).toBe('write_file');
        expect(spans[0]?.arguments.path).toBe('src/config.ts');
        expect(spans[0]?.arguments.content).toContain('SERVER_PORT = 8100');
        expect(stripGemmaNativeToolCallsFromText(text, spans)).toBe(
          '` (Self-correction: I need to check what I *actually* wrote.)',
        );
      });

      it('does NOT infer from an unterminated body (no closing brace)', () => {
        const text = 'content:<|"|>stub<|"|>,path:<|"|>src/config.ts<|"|>';
        expect(findGemmaNativeToolCallSpans(text, TOOLS)).toHaveLength(0);
      });

      it('does NOT infer from an unknown key signature', () => {
        const text = 'note:<|"|>remember this<|"|>}';
        expect(findGemmaNativeToolCallSpans(text, TOOLS)).toHaveLength(0);
      });

      it('does NOT infer from a path-only body (ambiguous across read/rm/stat)', () => {
        const text = 'path:<|"|>source/schema.md<|"|>}';
        expect(findGemmaNativeToolCallSpans(text, TOOLS)).toHaveLength(0);
      });

      it('does NOT fire mid-text — only an engine-truncated leading body qualifies', () => {
        const text = 'Some prose first, then content:<|"|>x<|"|>,path:<|"|>y<|"|>}';
        expect(findGemmaNativeToolCallSpans(text, TOOLS)).toHaveLength(0);
      });

      it('ignores a quoted tail fragment from a previous failed call (craftbook-receipt-intake)', () => {
        const text =
          'Eval<|"|>}<tool_call|>`\n    *   The tool response I received was: `ERROR: invalid';
        expect(findGemmaNativeToolCallSpans(text, TOOLS)).toHaveLength(0);
      });
    });
  });
});
