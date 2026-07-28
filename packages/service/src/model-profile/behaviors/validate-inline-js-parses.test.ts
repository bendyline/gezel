import { describe, expect, it } from 'vitest';
import type { TurnCtx } from '../types.js';
import {
  type InlineJsWrite,
  ValidateInlineJsParses,
  detectBrokenInlineJs,
} from './validate-inline-js-parses.js';

/** A `write_file` drained-tool-call shape, with the body embedded in argsFull. */
function htmlWrite(path: string, body: string, success = true): InlineJsWrite {
  return { name: 'write_file', success, path, argsFull: `path: ${path}\n\ncontent:\n${body}` };
}

const CLEAN =
  '<canvas></canvas><script>function tick(){ if (a) { run(); } } tick();</script></body>';
// Extra `)` — the unbalanced-paren shape qwen3.5-9b shipped on tankcombat.
const BROKEN = '<canvas></canvas><script>function tick(){ if (a)) { run(); } }</script></body>';

describe('detectBrokenInlineJs', () => {
  it('flags a full HTML write whose inline JS does not parse', () => {
    const v = detectBrokenInlineJs([htmlWrite('index.html', BROKEN)]);
    expect(v.broken).toBe(true);
    expect(v.file).toBe('index.html');
    expect(v.error).toBeTruthy();
  });

  it('passes clean inline JS', () => {
    expect(detectBrokenInlineJs([htmlWrite('index.html', CLEAN)]).broken).toBe(false);
  });

  it('passes a page with no inline JS (nothing to judge)', () => {
    expect(detectBrokenInlineJs([htmlWrite('index.html', '<h1>static</h1></body>')]).broken).toBe(
      false,
    );
  });

  it('ignores non-HTML writes', () => {
    expect(detectBrokenInlineJs([htmlWrite('notes/plan.md', BROKEN)]).broken).toBe(false);
  });

  it('ignores failed writes', () => {
    expect(detectBrokenInlineJs([htmlWrite('index.html', BROKEN, false)]).broken).toBe(false);
  });

  it('ignores surgical edits (replace_in_file carries a diff, not the whole file)', () => {
    const edit: InlineJsWrite = {
      name: 'replace_in_file',
      success: true,
      path: 'index.html',
      argsFull: `path: index.html\n\nsearch:\n<script>old\n\nreplace:\n<script>${BROKEN}`,
    };
    expect(detectBrokenInlineJs([edit]).broken).toBe(false);
  });

  it('matches .htm as well as .html', () => {
    expect(detectBrokenInlineJs([htmlWrite('game.htm', BROKEN)]).broken).toBe(true);
  });
});

describe('ValidateInlineJsParses.postTurnDetector', () => {
  const ctx = (drained: InlineJsWrite[]): TurnCtx => ({ drained }) as unknown as TurnCtx;

  it('re-prompts with the parse error when inline JS is broken', () => {
    const verdict = ValidateInlineJsParses.postTurnDetector?.(
      ctx([htmlWrite('index.html', BROKEN)]),
    );
    expect(verdict).not.toBeNull();
    expect(verdict?.promptForNextTurn).toMatch(/syntax error/i);
    expect(verdict?.promptForNextTurn).toContain('index.html');
  });

  it('passes (null) when inline JS parses', () => {
    expect(
      ValidateInlineJsParses.postTurnDetector?.(ctx([htmlWrite('index.html', CLEAN)])),
    ).toBeNull();
  });
});
