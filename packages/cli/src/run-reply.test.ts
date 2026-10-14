import { describe, expect, it } from 'vitest';
import { ReplyPrinter, visibleReply } from './run-reply.js';

/** Stream `chunks` through a printer and return exactly what reached stdout. */
function print(chunks: string[]): string {
  let out = '';
  const printer = new ReplyPrinter((text) => {
    out += text;
  });
  for (const chunk of chunks) printer.push(chunk);
  printer.finish();
  return out;
}

/** Split a string into fixed-size pieces, the way token deltas cut through tags. */
function pieces(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

describe('ReplyPrinter', () => {
  // qwen3.5-0.8b-q4 on MLX, 2026-10-14: the salvaged call ran and the saved
  // message was clean, but every token of the markup reached stdout first.
  const leaked =
    '<tool_call>\n<function=write_artifact>\n<parameter=path>\nproj/README.md\n</parameter>\n' +
    '<parameter=content>\n**Netherlands Capital: Amsterdam**\n</parameter>\n</function>\n</tool_call>' +
    'I can help you with that! The capital of the Netherlands is **Amsterdam**.';

  it('prints the reply and not the tool call, at any chunking', () => {
    for (const size of [1, 3, 7, 64]) {
      expect(print(pieces(leaked, size))).toBe(
        'I can help you with that! The capital of the Netherlands is **Amsterdam**.',
      );
    }
  });

  it('streams a plain reply as it arrives', () => {
    let out = '';
    const printer = new ReplyPrinter((text) => {
      out += text;
    });
    printer.push('The answer ');
    expect(out).toBe('The answer');
    printer.push('is 391.');
    expect(out).toBe('The answer is 391.');
    expect(printer.finish()).toBe(true);
  });

  it('keeps prose that only looks like a tag', () => {
    expect(print(['Use a < b and <b>bold</b> ', 'freely.'])).toBe(
      'Use a < b and <b>bold</b> freely.',
    );
  });

  it('removes a call between two parts of the reply', () => {
    expect(
      print(
        pieces(
          'Let me check.\n\n<function=search>\n<parameter=q>x</parameter>\n</function>\n\nIt is 21°C.',
          5,
        ),
      ),
    ).toBe('Let me check.\n\nIt is 21°C.');
  });

  it("drops Gemma's call markers", () => {
    expect(print(pieces('<|tool_call>call:get_weather{city:Paris}<tool_call|>Sunny.', 4))).toBe(
      'Sunny.',
    );
  });

  it("keeps the reply's own whitespace", () => {
    // stdout is byte-for-byte the reply apart from what was cut out.
    expect(print(['Line one.\n', '\n\n\nLine two.\n'])).toBe('Line one.\n\n\n\nLine two.\n');
  });

  it('reports nothing printed for a turn that was only a call', () => {
    const printer = new ReplyPrinter(() => {});
    printer.push('<tool_call>\n<function=x>\n</function>\n</tool_call>');
    expect(printer.finish()).toBe(false);
  });
});

describe('visibleReply', () => {
  it('shows an unclosed opener once the reply is over', () => {
    // Withheld while it might still close; afterwards it is what the model said.
    expect(visibleReply('Done. <tool_call>{"name":', true)).toBe('Done.');
    expect(visibleReply('Done. <tool_call>{"name":', false)).toBe('Done. <tool_call>{"name":');
  });
});
