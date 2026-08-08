import { describe, expect, it } from 'vitest';
import { humanizeToolMarkup } from './tool-markup.js';

describe('humanizeToolMarkup', () => {
  it('leaves plain prose (including honest angle brackets) untouched', () => {
    const text = 'Use a <div> wrapper, then run `ls -la`.';
    expect(humanizeToolMarkup(text)).toBe(text);
  });

  it('rewrites a hermes call inside a qwen envelope (the read_file leak)', () => {
    const text = [
      'Let me check the security docs.',
      '<tool_call>',
      '<function=read_file>',
      '<parameter=path>',
      'docs/secrets-security.md',
      '</parameter>',
      '</function>',
      '</tool_call>',
    ].join('\n');
    expect(humanizeToolMarkup(text)).toBe(
      'Let me check the security docs.\n🔧 read_file (path: docs/secrets-security.md)',
    );
  });

  it('rewrites a bare hermes call with multiple parameters', () => {
    const text =
      '<function=message_gezel><parameter=gezel>Maya</parameter><parameter=message>status?</parameter></function>';
    expect(humanizeToolMarkup(text)).toBe('🔧 message_gezel (gezel: Maya, message: status?)');
  });

  it('rewrites a qwen-xml JSON envelope', () => {
    const text =
      '<tool_call>{"name": "write_file", "arguments": {"path": "a.md", "content": "# hi\\n..."}}</tool_call>';
    expect(humanizeToolMarkup(text)).toBe('🔧 write_file (path: a.md)');
  });

  it('rewrites a GLM arg_key/arg_value envelope', () => {
    const text =
      '<tool_call>read_file<arg_key>path</arg_key><arg_value>docs/plan.md</arg_value></tool_call>';
    expect(humanizeToolMarkup(text)).toBe('🔧 read_file (path: docs/plan.md)');
  });

  it('rewrites shell-style one-line calls without a closing tag', () => {
    const text = '<tool_call>browser_navigate url="https://example.com"\nDone.';
    expect(humanizeToolMarkup(text)).toBe('🔧 browser_navigate (url: https://example.com)\nDone.');
  });

  it('rewrites a gemma special-token envelope to the tool name', () => {
    const text = '<|tool_call>call:list_dir{path:<|"|>workspace}<tool_call|>';
    expect(humanizeToolMarkup(text)).toBe('🔧 list_dir');
  });

  it('omits bulky values and truncates long ones', () => {
    const long = 'x'.repeat(200);
    const text = `<tool_call><function=write_file><parameter=path>${long}</parameter><parameter=content>BODY</parameter></function></tool_call>`;
    const out = humanizeToolMarkup(text);
    expect(out).toContain('🔧 write_file (path: ');
    expect(out).toContain('…');
    expect(out).not.toContain('BODY');
    expect(out.length).toBeLessThan(100);
  });

  it('shows a live marker for a still-streaming block and resolves it when closed', () => {
    const partial = 'Checking.\n<tool_call>\n<function=read_file>\n<parameter=path>\ndocs/secr';
    expect(humanizeToolMarkup(partial)).toBe('Checking.\n🔧 read_file…');

    const closed = `${partial}ets-security.md\n</parameter>\n</function>\n</tool_call>`;
    expect(humanizeToolMarkup(closed)).toBe(
      'Checking.\n🔧 read_file (path: docs/secrets-security.md)',
    );
  });

  it('marks an unparseable trailing opener as a generic in-flight call', () => {
    expect(humanizeToolMarkup('Working…\n<tool_call>\n<')).toBe('Working…\n🔧 calling a tool…');
  });

  it('keeps an unrecognized closed envelope raw instead of guessing', () => {
    const text = '<tool_call>%%% not a call %%%</tool_call>';
    expect(humanizeToolMarkup(text)).toBe(text);
  });

  it('rewrites multiple envelopes in one reply independently', () => {
    const text =
      '<tool_call>{"name":"list_dir","arguments":{"path":"workspace"}}</tool_call>\nthen\n<tool_call>{"name":"stat","arguments":{"path":"a.md"}}</tool_call>';
    expect(humanizeToolMarkup(text)).toBe(
      '🔧 list_dir (path: workspace)\nthen\n🔧 stat (path: a.md)',
    );
  });
});
