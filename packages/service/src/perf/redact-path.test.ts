import { describe, expect, it } from 'vitest';
import { redactPathSecrets } from './redact-path.js';

const CAPABILITY = 'Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg';

describe('redactPathSecrets', () => {
  it('removes the preview capability from a bare path and from a request label', () => {
    expect(redactPathSecrets(`/preview/${CAPABILITY}/artifacts/proj-1/site/index.html`)).toBe(
      '/preview/[capability]/artifacts/proj-1/site/index.html',
    );
    expect(redactPathSecrets(`GET /preview/${CAPABILITY}/workspace/proj-1/`)).toBe(
      'GET /preview/[capability]/workspace/proj-1/',
    );
  });

  it('removes it from a full URL and when nothing follows the capability', () => {
    expect(
      redactPathSecrets(
        `classic-script https://127.0.0.1:6228/preview/${CAPABILITY}/type/p/app.js`,
      ),
    ).toBe('classic-script https://127.0.0.1:6228/preview/[capability]/type/p/app.js');
    expect(redactPathSecrets(`/preview/${CAPABILITY}`)).toBe('/preview/[capability]');
    expect(redactPathSecrets(`/preview/${CAPABILITY}?x=1`)).toBe('/preview/[capability]?x=1');
    expect(redactPathSecrets(`//preview/${CAPABILITY}/a`)).toBe('//preview/[capability]/a');
  });

  it('removes an app grant id, the handle that collects its token', () => {
    const grant = '0b7f4d4e-58f4-4a39-9a43-5a1c3f0e6b21';
    expect(redactPathSecrets(`GET /v1/apps/grant/${grant}`)).toBe('GET /v1/apps/grant/[grant]');
    expect(redactPathSecrets(`/v1/apps/grant/${grant}/events`)).toBe(
      '/v1/apps/grant/[grant]/events',
    );
  });

  it('every occurrence, not just the first', () => {
    expect(redactPathSecrets(`/preview/${CAPABILITY}/a /preview/other/b`)).toBe(
      '/preview/[capability]/a /preview/[capability]/b',
    );
  });

  it('leaves paths without a secret segment alone', () => {
    for (const path of [
      '/api/projects/proj-1/preview-capability',
      '/api/projects/proj-1/preview-about',
      '/api/projects/proj-1/artifacts/raw/preview/index.html',
      '/api/system/perf',
      '/v1/apps/register',
      'index scan proj-1',
    ]) {
      expect(redactPathSecrets(path)).toBe(path);
    }
  });
});
