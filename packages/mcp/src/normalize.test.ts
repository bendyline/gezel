import { describe, expect, it } from 'vitest';
import { normalizeMarkdown } from './normalize.js';

describe('normalizeMarkdown', () => {
  it('collapses intra-paragraph line breaks to spaces', () => {
    const input = 'You are a reviewer who cares\ndeeply about correctness\nand clear feedback.';
    expect(normalizeMarkdown(input)).toBe(
      'You are a reviewer who cares deeply about correctness and clear feedback.',
    );
  });

  it('preserves blank lines between paragraphs', () => {
    const input = 'First paragraph\nwraps across lines.\n\nSecond paragraph\nalso wraps.';
    expect(normalizeMarkdown(input)).toBe(
      'First paragraph wraps across lines.\n\nSecond paragraph also wraps.',
    );
  });

  it('preserves headings on their own line', () => {
    const input = '## Identity\nYou are a\nreviewer.';
    expect(normalizeMarkdown(input)).toBe('## Identity\nYou are a reviewer.');
  });

  it('keeps each list item on its own line and collapses continuation lines into it', () => {
    const input = '- First item that\n  wraps across lines.\n- Second item that\n  also wraps.';
    expect(normalizeMarkdown(input)).toBe(
      '- First item that wraps across lines.\n- Second item that also wraps.',
    );
  });

  it('preserves fenced code blocks verbatim', () => {
    const input = 'Text before.\n\n```ts\nconst x = 1;\nconst y = 2;\n```\n\nText after\nwraps.';
    expect(normalizeMarkdown(input)).toBe(
      'Text before.\n\n```ts\nconst x = 1;\nconst y = 2;\n```\n\nText after wraps.',
    );
  });

  it('preserves ordered-list markers', () => {
    const input = '1. Step one\n   continues.\n2. Step two.';
    expect(normalizeMarkdown(input)).toBe('1. Step one continues.\n2. Step two.');
  });

  it('preserves blockquotes and horizontal rules on their own lines', () => {
    const input = '> quoted\n> line\n\n---\n\nAfter';
    expect(normalizeMarkdown(input)).toBe('> quoted\n> line\n\n---\n\nAfter');
  });

  it('is a no-op on empty input', () => {
    expect(normalizeMarkdown('')).toBe('');
  });
});
