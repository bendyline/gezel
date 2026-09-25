import { describe, expect, it } from 'vitest';
import { previewAssetPath, previewEntryPath } from './html-preview-path.js';
describe('offline preview file authority', () => {
  it('resolves siblings and nested stylesheet assets inside the entry directory', () => {
    expect(previewAssetPath('./image.png', 'page/index.html', 'page/index.html')).toBe(
      'page/image.png',
    );
    expect(previewAssetPath('../image.png#icon', 'page/css/style.css', 'page/index.html')).toBe(
      'page/image.png',
    );
    expect(previewAssetPath('my%20image.png?v=1', 'page/index.html', 'page/index.html')).toBe(
      'page/my image.png',
    );
  });
  it.each([
    '../private.png',
    '%2e%2e/private.png',
    'assets/%2f../../private.png',
    '%252e%252e/private.png',
    '/private.png',
    '//external.test/image.png',
    'https://external.test/image.png',
    'file:///secret.png',
    'blob:other',
    'folder\\image.png',
  ])('rejects escaped asset %s', (reference) => {
    expect(() => previewAssetPath(reference, 'page/index.html', 'page/index.html')).toThrow();
  });
  it.each([
    '../index.html',
    '/index.html',
    'a/../index.html',
    'a//index.html',
    'a\\index.html',
    'a/\u0000index.html',
  ])('rejects invalid entry %s', (path) => expect(() => previewEntryPath(path)).toThrow());
});
