import { describe, expect, it } from 'vitest';
import { GezelApiError, apiErrorMessage } from './api-error.js';

const statusLine = 'Gezel API error 409 on PUT /api/office-setup';

describe('apiErrorMessage', () => {
  it("prefers the route's sentence over its code", () => {
    const err = new GezelApiError(statusLine, 409, {
      error: 'office_setup_failed',
      message: 'Choose at least one Office app first.',
    });
    expect(apiErrorMessage(err)).toBe('Choose at least one Office app first.');
  });

  it('uses `error` when it is a sentence', () => {
    const err = new GezelApiError(statusLine, 409, {
      error: 'a dashboard run is already in flight',
    });
    expect(apiErrorMessage(err)).toBe('a dashboard run is already in flight');
  });

  it('never shows the status line or a bare code', () => {
    for (const [status, details] of [
      [409, { error: 'office_setup_failed' }],
      [500, { error: 'internal_error' }],
      [502, undefined],
      [404, 'not found'],
    ] as const) {
      const text = apiErrorMessage(new GezelApiError(statusLine, status, details));
      expect(text).not.toMatch(/Gezel API error|office_setup_failed|internal_error/);
    }
  });

  it('keeps a transport failure, which names its cause', () => {
    const err = new GezelApiError('fetch failed (ECONNREFUSED)', 0);
    expect(apiErrorMessage(err)).toBe('fetch failed (ECONNREFUSED)');
    expect(apiErrorMessage(new Error('boom'))).toBe('boom');
  });
});
