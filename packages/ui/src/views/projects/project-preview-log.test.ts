import { describe, expect, it } from 'vitest';
import type { HtmlPreviewLogEntry } from '../../components/HtmlPreviewFrame.js';
import { formatPreviewComplaint, formatPreviewLog } from './project-preview-log.js';

const entry: HtmlPreviewLogEntry = {
  kind: 'error',
  detail: {
    message: 'boom',
    filename: '/preview/app.js',
    lineno: 12,
    colno: 4,
    stack: 'Error: boom\n  at app.js:12:4',
  },
  url: 'https://preview.invalid/index.html',
  at: 42,
};

describe('project preview log formatting', () => {
  it('uses console arguments for console.error entries', () => {
    expect(
      formatPreviewLog({
        ...entry,
        kind: 'console.error',
        detail: { args: ['could not load', 'scene.json'] },
      }),
    ).toBe('could not load scene.json');
  });

  it('includes source, location, URL, and stack in a complaint', () => {
    const complaint = formatPreviewComplaint(entry, {
      source: 'workspace',
      path: 'index.html',
    });

    expect(complaint).toContain('`workspace/index.html`');
    expect(complaint).toContain('- **Message:** boom');
    expect(complaint).toContain('- **Location:** /preview/app.js:12:4');
    expect(complaint).toContain('- **Preview URL:** https://preview.invalid/index.html');
    expect(complaint).toContain('Error: boom\n  at app.js:12:4');
  });
});
