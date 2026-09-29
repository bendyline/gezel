import { describe, expect, it } from 'vitest';
import { parseToolEnvelopeReply } from './envelope.js';
import { parseXmlFunctionCall } from './xml-function-call.js';

describe('MiniCPM5 native tool calls', () => {
  it('reads the shape its chat template teaches, CDATA verbatim', () => {
    expect(
      parseXmlFunctionCall(
        '<function name="write_file"><param name="path">notes/plan.md</param><param name="content"><![CDATA[# Plan\n<b>Move</b> & settle\n]]></param></function>',
      ),
    ).toEqual({
      name: 'write_file',
      arguments: { path: 'notes/plan.md', content: '# Plan\n<b>Move</b> & settle\n' },
    });
    expect(parseXmlFunctionCall('<function name="list_dir"></function>')).toEqual({
      name: 'list_dir',
      arguments: {},
    });
  });

  it('coerces plain scalars but never a CDATA value', () => {
    expect(
      parseXmlFunctionCall(
        '<function name="read_file">\n<param name="path">a.md</param>\n<param name="offset">40</param>\n<param name="raw">true</param>\n<param name="note"><![CDATA[42]]></param>\n</function>',
      ),
    ).toEqual({
      name: 'read_file',
      arguments: { path: 'a.md', offset: 40, raw: true, note: '42' },
    });
  });

  it('accepts a call whose closing tag the reply ended before', () => {
    expect(
      parseXmlFunctionCall('<function name="read_file"><param name="path">brief.md</param>'),
    ).toEqual({ name: 'read_file', arguments: { path: 'brief.md' } });
  });

  it('never treats anything but one whole call as a call', () => {
    for (const text of [
      'Sure: <function name="read_file"><param name="path">a</param></function>',
      '<function name="read_file"><param name="path">a</param></function> done',
      '<function name="a"></function><function name="b"></function>',
      '<function name="read_file">path=a</function>',
      '<function name="read_file"><param name="path">a</function>',
      '<function=read_file><parameter=path>a</parameter></function>',
    ]) {
      expect(parseXmlFunctionCall(text)).toBeNull();
    }
  });

  it('is part of the phone reply protocol, fenced or bare', () => {
    const call = '<function name="list_dir"><param name="path">.</param></function>';
    const expected = { name: 'list_dir', arguments: { path: '.' } };
    expect(parseToolEnvelopeReply(call)).toEqual(expected);
    expect(parseToolEnvelopeReply(`\`\`\`xml\n${call}\n\`\`\``)).toEqual(expected);
  });
});
