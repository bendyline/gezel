import { describe, expect, it } from 'vitest';
import { isAppleDoubleName, isSyncJunkName, isSyncJunkPath } from './sync-junk.js';

describe('sync junk', () => {
  it('treats macOS AppleDouble files as junk, and nothing else that starts with a dot', () => {
    expect(isAppleDoubleName('._IMG_0001.JPEG')).toBe(true);
    expect(isSyncJunkName('._IMG_0001.JPEG')).toBe(true);
    expect(isSyncJunkPath('2013 summer/._beach.jpg')).toBe(true);
    expect(isSyncJunkName('._')).toBe(false);
    expect(isSyncJunkName('.gitignore')).toBe(false);
    expect(isSyncJunkName('IMG_0001.JPEG')).toBe(false);
  });
});
