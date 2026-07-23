import createDOMPurify from 'dompurify';
import { marked } from 'marked';

type WindowLike = Parameters<typeof createDOMPurify>[0];

/**
 * Render an eval report as Markdown while treating every report as untrusted.
 * Reports can contain model-authored text, so "local file" is provenance, not
 * a security boundary. Raw HTML is allowed through Marked only so DOMPurify can
 * reduce it to the same safe subset as generated Markdown.
 */
export function renderSafeMarkdown(source: string, windowLike: WindowLike = window): string {
  const rendered = marked.parse(source, { async: false, gfm: true, breaks: false });
  if (typeof rendered !== 'string') {
    throw new Error('synchronous Markdown rendering unexpectedly returned a promise');
  }

  return createDOMPurify(windowLike).sanitize(rendered, {
    ALLOW_UNKNOWN_PROTOCOLS: false,
    FORBID_ATTR: ['style', 'srcset'],
    FORBID_TAGS: [
      'button',
      'embed',
      'form',
      'iframe',
      'input',
      'math',
      'object',
      'option',
      'select',
      'style',
      'svg',
      'template',
      'textarea',
    ],
    RETURN_TRUSTED_TYPE: false,
    USE_PROFILES: { html: true },
  });
}
