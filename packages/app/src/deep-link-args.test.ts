import { describe, expect, it } from 'vitest';
import { deepLinkKey, findDeepLinkArguments } from './deep-link-args.js';

describe('findDeepLinkArguments', () => {
  it('keeps gezel URLs and ignores flags and files', () => {
    expect(
      findDeepLinkArguments([
        'C:\\Program Files\\Gezel\\Gezel.exe',
        '--allow-file-access-from-files',
        'D:\\models\\qwen.gezmodel',
        '"gezel://app/meal-planner/"',
      ]),
    ).toEqual([{ kind: 'app', id: 'meal-planner' }]);
  });

  it('turns a gezel URL it cannot read into Home, not a failure', () => {
    expect(findDeepLinkArguments(['/usr/bin/gezel', 'gezel://app/Bad Id'])).toEqual([
      { kind: 'home' },
    ]);
  });

  it('keys links by target', () => {
    expect(deepLinkKey({ kind: 'home' })).toBe('home');
    expect(deepLinkKey({ kind: 'craftbook', id: 'fact-check' })).toBe('craftbook:fact-check');
  });
});
