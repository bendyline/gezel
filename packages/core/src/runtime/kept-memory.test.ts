import { describe, expect, it } from 'vitest';
import {
  formatMemoryBlock,
  keptMemoryTag,
  keptMemoryTagNames,
  parseMemoryDay,
  withoutKeptMemories,
} from './memory-markdown.js';

const day =
  formatMemoryBlock('09:00', 'Likes tea', 'pref') +
  formatMemoryBlock('10:00', 'The dentist is on Tuesday', 'fact', {
    project: 'week',
    kept: keptMemoryTag(['calendar-google:ab12', 'mail-gmail:cd34'])!,
  });

describe('memories kept on this computer', () => {
  it('say which connections they came from, through a round trip', () => {
    const [, kept] = parseMemoryDay(day);
    expect(kept?.source).toEqual({
      project: 'week',
      kept: 'calendar-google.ab12__mail-gmail.cd34',
    });
    expect(keptMemoryTagNames(kept!.source!.kept!, 'mail-gmail:cd34')).toBe(true);
    expect(keptMemoryTagNames(kept!.source!.kept!, 'mail-gmail:other')).toBe(false);
  });

  it('never lose their tag for being long', () => {
    const tag = keptMemoryTag(Array.from({ length: 12 }, (_, i) => `calendar-google:${i}abcdef`))!;
    const block = formatMemoryBlock('10:00', 'x', 'fact', { kept: tag });
    expect(parseMemoryDay(block)[0]?.source?.kept).toBe(tag);
    expect(keptMemoryTag([])).toBeUndefined();
  });

  it('are what a cloud model is not shown', () => {
    expect(withoutKeptMemories(day)).not.toContain('dentist');
    expect(withoutKeptMemories(day)).toContain('Likes tea');
    const plain = '# notes\n\n## 09:00 [pref]\n\nLikes tea\n';
    expect(withoutKeptMemories(plain)).toBe(plain);
  });
});
