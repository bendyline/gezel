import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AnsiOutput, createAnsiRenderer } from './AnsiOutput.js';

/**
 * The parser's contract is "given a string, produce React nodes
 * that visually represent it." Asserting on rendered DOM is the
 * least brittle way to test that — we don't tie the test to the
 * exact ReactNode shape (which would lock in implementation
 * details like whether unstyled text gets wrapped in a span).
 */

function renderToText(text: string): string {
  const { container } = render(<AnsiOutput text={text} />);
  return container.textContent ?? '';
}

function renderToClasses(text: string): string[] {
  const { container } = render(<AnsiOutput text={text} />);
  return Array.from(container.querySelectorAll('[class]')).map((el) => el.className);
}

describe('AnsiOutput', () => {
  it('renders plain text unchanged', () => {
    expect(renderToText('hello world')).toBe('hello world');
  });

  it('renders empty input as nothing', () => {
    expect(renderToText('')).toBe('');
  });

  it('strips the SGR sequence and keeps the styled text content', () => {
    expect(renderToText('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('applies a foreground color class to the styled span', () => {
    const classes = renderToClasses('\x1b[31mred\x1b[0m');
    expect(classes).toContain('ansi-fg-red');
  });

  it('handles bright (90-97) foreground colors', () => {
    const classes = renderToClasses('\x1b[92mbright-green\x1b[0m');
    expect(classes).toContain('ansi-fg-bright-green');
  });

  it('handles background colors (40-47)', () => {
    const classes = renderToClasses('\x1b[44mblue-bg\x1b[0m');
    expect(classes).toContain('ansi-bg-blue');
  });

  it('combines multiple styles in one span', () => {
    const classes = renderToClasses('\x1b[1;4;31mbold-underline-red\x1b[0m');
    const styled = classes.find((c) => c.includes('ansi-fg-red'));
    expect(styled).toBeDefined();
    expect(styled).toContain('ansi-bold');
    expect(styled).toContain('ansi-underline');
  });

  it('treats a bare reset (CSI m) the same as CSI 0 m', () => {
    expect(renderToText('\x1b[31mred\x1b[m plain')).toBe('red plain');
    const classes = renderToClasses('\x1b[31mred\x1b[m plain');
    // Both spans (or none for the plain part) should exist; the
    // critical assertion is the second segment is NOT styled red.
    expect(classes.some((c) => c.includes('ansi-fg-red'))).toBe(true);
    // The trailing " plain" lands as a text node (no class), so
    // classes should not include red for the second segment.
    const reds = classes.filter((c) => c.includes('ansi-fg-red'));
    expect(reds.length).toBe(1);
  });

  it('silently drops non-SGR CSI sequences (cursor moves, erases)', () => {
    expect(renderToText('before\x1b[2Aafter')).toBe('beforeafter');
    expect(renderToText('before\x1b[Kafter')).toBe('beforeafter');
  });

  it('silently drops OSC sequences (terminated by BEL)', () => {
    expect(renderToText('a\x1b]0;title\x07b')).toBe('ab');
  });

  it('silently drops OSC sequences (terminated by ESC \\)', () => {
    expect(renderToText('a\x1b]0;title\x1b\\b')).toBe('ab');
  });

  it('consumes extended-color params without leaking the rgb numbers as text', () => {
    // 38;2;255;0;0 = 24-bit red — we don't apply the color but
    // we MUST consume the four trailing parameters or the `255` /
    // `0` would land as literal output.
    expect(renderToText('\x1b[38;2;255;0;0mtext\x1b[0m')).toBe('text');
    expect(renderToText('\x1b[38;5;208morange\x1b[0m')).toBe('orange');
  });

  it('passes through unknown SGR codes without losing the trailing text', () => {
    // 999 is reserved/unknown; should be silently ignored, text preserved.
    expect(renderToText('\x1b[999msurvived\x1b[0m')).toBe('survived');
  });

  it('handles `\\x1b[39m` (default foreground) by clearing the fg color', () => {
    const classes = renderToClasses('\x1b[31mred\x1b[39mplain');
    const reds = classes.filter((c) => c.includes('ansi-fg-red'));
    expect(reds.length).toBe(1);
  });
});

describe('createAnsiRenderer (stateful)', () => {
  it('buffers a partial CSI sequence across feed() calls', () => {
    const renderer = createAnsiRenderer();
    // First chunk splits the escape mid-parameter; nothing in this
    // chunk should leak as plain text containing the partial.
    const first = renderer.feed('plain \x1b[31');
    // The first chunk MUST NOT contain the raw escape — that's the
    // whole point of buffering. Concat to text to verify.
    const firstText = first.map((n) => (typeof n === 'string' ? n : '')).join('');
    expect(firstText).not.toContain('\x1b');

    const second = renderer.feed('mred\x1b[0m done');
    // Total rendered text across both feeds should be "plain red done".
    // Compare via a container test render.
    const { container } = render(
      <div>
        {first}
        {second}
      </div>,
    );
    expect(container.textContent).toBe('plain red done');
    expect(container.querySelector('.ansi-fg-red')).not.toBeNull();
  });

  it('persists style across feed() calls until reset arrives', () => {
    const renderer = createAnsiRenderer();
    renderer.feed('\x1b[32m'); // green on, no text yet
    const second = renderer.feed('still green');
    const { container } = render(<div>{second}</div>);
    expect(container.querySelector('.ansi-fg-green')?.textContent).toBe('still green');
  });

  it('handles a stream of styled chunks without losing characters', () => {
    const renderer = createAnsiRenderer();
    const chunks = ['\x1b[31m', 'red', '\x1b[0m', ' then ', '\x1b[34m', 'blue', '\x1b[0m'];
    const nodes = chunks.flatMap((c) => renderer.feed(c));
    const { container } = render(<div>{nodes}</div>);
    expect(container.textContent).toBe('red then blue');
    expect(container.querySelector('.ansi-fg-red')?.textContent).toBe('red');
    expect(container.querySelector('.ansi-fg-blue')?.textContent).toBe('blue');
  });
});
