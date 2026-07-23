import { describe, expect, it } from 'vitest';
import { formatMemoryBlock, parseMemoryDay } from './daily-markdown.js';

describe('formatMemoryBlock + parseMemoryDay', () => {
  it('round-trips a tagged block', () => {
    const content = formatMemoryBlock('14:30', 'User prefers terse replies.', 'pref');
    const blocks = parseMemoryDay(content);
    expect(blocks).toEqual([{ time: '14:30', kind: 'pref', text: 'User prefers terse replies.' }]);
  });

  it('parses a mixed file of legacy and tagged blocks', () => {
    const content = [
      '\n## 10:00\n\nLegacy entry without a kind.\n',
      '\n## 10:05 [pref]\n\nTagged preference entry.\n',
      '\n## 10:10 [status]\n\nTagged status entry.\n',
    ].join('');
    const blocks = parseMemoryDay(content);
    expect(blocks).toEqual([
      { time: '10:00', kind: 'fact', text: 'Legacy entry without a kind.' },
      { time: '10:05', kind: 'pref', text: 'Tagged preference entry.' },
      { time: '10:10', kind: 'status', text: 'Tagged status entry.' },
    ]);
  });

  it('maps unknown kind tags to fact', () => {
    const blocks = parseMemoryDay('\n## 09:00 [banana]\n\nSomething.\n');
    expect(blocks).toEqual([{ time: '09:00', kind: 'fact', text: 'Something.' }]);
  });

  it('preserves multi-line block text', () => {
    const blocks = parseMemoryDay('\n## 09:00 [fact]\n\nLine one.\nLine two.\n');
    expect(blocks).toEqual([{ time: '09:00', kind: 'fact', text: 'Line one.\nLine two.' }]);
  });

  it('drops blocks with empty bodies and ignores non-heading preamble', () => {
    const content = 'stray preamble text\n\n## 09:00 [fact]\n\n\n\n## 09:05 [fact]\n\nKept.\n';
    expect(parseMemoryDay(content)).toEqual([{ time: '09:05', kind: 'fact', text: 'Kept.' }]);
  });

  it('does not treat ### or deeper headings as block boundaries', () => {
    const blocks = parseMemoryDay('\n## 09:00 [fact]\n\nBody with\n### a sub-heading\ninside.\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toContain('### a sub-heading');
  });
});
