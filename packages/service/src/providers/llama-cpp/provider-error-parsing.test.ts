import { describe, expect, it } from 'vitest';
import {
  mergeSystemMessagesIntoFirst,
  tryParseContextOverflow,
  tryParseSystemMessageOrderingError,
} from './provider.js';

describe('tryParseContextOverflow', () => {
  it('extracts structured fields from the exceed_context_size_error body', () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        type: 'exceed_context_size_error',
        n_prompt_tokens: 48514,
        n_ctx: 16384,
        message: 'request (48514 tokens) exceeds the available context size (16384 tokens)',
      },
    });
    expect(tryParseContextOverflow(body)).toEqual({ promptTokens: 48514, nCtx: 16384 });
  });

  it('falls back to regex-parsing the message when structured fields are missing', () => {
    // Older llama-server builds may omit n_prompt_tokens / n_ctx —
    // regex the human text as a backup.
    const body = JSON.stringify({
      error: {
        code: 400,
        type: 'exceed_context_size_error',
        message: 'request (5000 tokens) exceeds the available context size (4096 tokens)',
      },
    });
    expect(tryParseContextOverflow(body)).toEqual({ promptTokens: 5000, nCtx: 4096 });
  });

  it('returns null for unrelated 400 bodies', () => {
    expect(
      tryParseContextOverflow(JSON.stringify({ error: { code: 400, type: 'other' } })),
    ).toBeNull();
    expect(tryParseContextOverflow('not json at all')).toBeNull();
    expect(tryParseContextOverflow('')).toBeNull();
  });
});

describe('single-system-message template fallback', () => {
  it('merges the stable + volatile system turns into one leading system message', () => {
    const merged = mergeSystemMessagesIntoFirst([
      { role: 'system', content: 'stable prompt' },
      { role: 'system', content: 'volatile band' },
      { role: 'user', content: 'start' },
    ]);

    expect(merged.map((m) => m.role)).toEqual(['system', 'user']);
    expect(merged[0]?.content).toBe('stable prompt\n\nvolatile band');
    expect(merged[1]?.content).toBe('start');
  });

  it('is a no-op shape for a single leading system message', () => {
    const merged = mergeSystemMessagesIntoFirst([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);

    expect(merged.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(merged[0]?.content).toBe('sys');
  });

  it('hoists a non-leading system turn into the single leading system message', () => {
    const merged = mergeSystemMessagesIntoFirst([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'mid-stream nudge' },
      { role: 'assistant', content: 'ok' },
    ]);

    // Exactly one system message, at index 0 — what Qwen's template requires.
    expect(merged.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(merged[0]?.role).toBe('system');
    expect(merged[0]?.content).toBe('sys\n\nmid-stream nudge');
    expect(merged.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  });

  it('passes through untouched when there is no system message', () => {
    const merged = mergeSystemMessagesIntoFirst([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);

    expect(merged.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('detects llama.cpp single-system-message template errors', () => {
    expect(
      tryParseSystemMessageOrderingError(
        JSON.stringify({
          error: {
            message:
              "While executing CallExpression: raise_exception('System message must be at the beginning of the conversation')",
          },
        }),
      ),
    ).toBe(true);
    // Raw (non-JSON) body still matches on the stable substring.
    expect(
      tryParseSystemMessageOrderingError('...first %}\n  System message must be at the beginning'),
    ).toBe(true);
    expect(tryParseSystemMessageOrderingError('model load failed')).toBe(false);
  });
});
