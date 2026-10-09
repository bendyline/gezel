import type { ImageStaticMeta, RecognitionMode } from '@bendyline/gezel';

export { MODE_PROMPTS, type ModePrompt } from '@bendyline/gezel';

/**
 * Resolve `auto` to a concrete mode from signals we already have.
 *
 * Deliberately dumb and deterministic: no classifier call (which would double
 * latency to answer a question a heuristic gets right most of the time), and a
 * wrong guess degrades to `describe`, which still quotes visible text.
 */
export function resolveAutoMode(meta: ImageStaticMeta, filename?: string): RecognitionMode {
  if (meta.likelyScreenshot) return 'ui';

  const name = (filename ?? '').toLowerCase();
  if (/screenshot|screen-shot|snip|capture/.test(name)) return 'ui';
  if (/scan|receipt|invoice|statement|page-?\d|doc/.test(name)) return 'ocr';

  // Portrait, document-shaped, and not a photo: most likely a scan.
  if (meta.width && meta.height && meta.height > meta.width * 1.2 && !meta.exif?.make) {
    return 'ocr';
  }
  return 'describe';
}
