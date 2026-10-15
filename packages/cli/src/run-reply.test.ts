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

  // Release audit of 50a7f293: a tag with a space in it was printed before it
  // completed, the stripped reply no longer extended stdout, and nothing more
  // was written, not even at the end.
  it('holds an invoke tag back across its attribute', () => {
    expect(
      print([
        'Checking.',
        ' <invoke',
        ' name',
        '="get_weather"><parameter name="city">Paris</parameter></invoke>',
        ' It is sunny.',
      ]),
    ).toBe('Checking.\n\nIt is sunny.');
  });

  it('holds a call back while its tool name has digits, hyphens or dots', () => {
    for (const name of ['read_file2', 'weather-v2', 'mcp.fs.read']) {
      const reply = `Checking. <function=${name}>\n<parameter=path>\na.txt\n</parameter>\n</function> It is sunny.`;
      for (const size of [1, 3, 7]) {
        expect(print(pieces(reply, size))).toBe('Checking.\n\nIt is sunny.');
      }
      expect(print(pieces(`Checking. <invoke name="${name}">\n</invoke> It is sunny.`, 2))).toBe(
        'Checking.\n\nIt is sunny.',
      );
    }
  });

  it('prints a comparison as soon as it cannot be a tag', () => {
    let out = '';
    const printer = new ReplyPrinter((text) => {
      out += text;
    });
    printer.push('So a <');
    expect(out).toBe('So a');
    printer.push(' b, and <b');
    expect(out).toBe('So a < b, and <b');
    printer.push('> holds.');
    expect(out).toBe('So a < b, and <b> holds.');
    printer.finish();
    expect(out).toBe('So a < b, and <b> holds.');
  });

  it('releases a tag that never completes', () => {
    expect(print(['Write it as <function=name'])).toBe('Write it as <function=name');
    // An endless run of name characters stops being held before the reply ends.
    let out = '';
    const printer = new ReplyPrinter((text) => {
      out += text;
    });
    printer.push(`See <function=${'a'.repeat(200)}`);
    expect(out).toBe(`See <function=${'a'.repeat(200)}`);
  });

  it('finishes the reply on its own line when stdout no longer matches it', () => {
    // A tag too long to hold is printed, then completes into a call.
    const name = 'a'.repeat(200);
    const out = print([
      'Checking.',
      ` <function=${name}`,
      '>x</function>',
      ' It is sunny.',
      ' Enjoy.',
    ]);
    expect(out).toBe(`Checking. <function=${name}\nIt is sunny. Enjoy.`);
  });

  it('restarts a word that runs into the stray tag on screen', () => {
    const name = 'b'.repeat(200);
    expect(print(['Done', `<function=${name}`, '>x</function>', 'Sunny.'])).toBe(
      `Done<function=${name}\nDone\n\nSunny.`,
    );
  });

  it('prints the saved message when the stream carried none of it', () => {
    let out = '';
    const printer = new ReplyPrinter((text) => {
      out += text;
    });
    expect(printer.finish('The capital is Amsterdam.')).toBe(true);
    expect(out).toBe('The capital is Amsterdam.');
    // A second finish, as the stream closes, adds nothing.
    expect(printer.finish()).toBe(true);
    expect(out).toBe('The capital is Amsterdam.');
  });

  it('prefers the streamed reply to the saved message', () => {
    let out = '';
    const printer = new ReplyPrinter((text) => {
      out += text;
    });
    printer.push('Amsterdam.');
    printer.finish('Amsterdam');
    expect(out).toBe('Amsterdam.');
  });
});

describe('visibleReply', () => {
  it('shows an unclosed opener once the reply is over', () => {
    // Withheld while it might still close; afterwards it is what the model said.
    expect(visibleReply('Done. <tool_call>{"name":', true)).toBe('Done.');
    expect(visibleReply('Done. <tool_call>{"name":', false)).toBe('Done. <tool_call>{"name":');
  });
});
