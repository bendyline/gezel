import { GezelApiError } from '@bendyline/gezel-client';
import { describe, expect, it } from 'vitest';
import { formatCliFailure } from './cli-errors.js';
import { CliError } from './connection.js';

describe('formatCliFailure', () => {
  it('prints a CliError message as-is', () => {
    expect(formatCliFailure(new CliError('Invalid mode: turbo.'))).toBe('Invalid mode: turbo.');
  });

  it('turns a bare 404 into one line naming the request, with no stack', () => {
    const err = new GezelApiError('Gezel API error 404 on GET /api/gezels/nope', 404, {
      error: 'not found',
    });
    const text = formatCliFailure(err, {});
    expect(text).toBe('error: not found (GET /api/gezels/nope)');
    expect(text).not.toContain('node_modules');
  });

  it('prefers the service explanation when it gives one', () => {
    const err = new GezelApiError('Gezel API error 400 on POST /api/projects', 400, {
      error: 'about must be at least 60 characters',
    });
    const text = formatCliFailure(err, {});
    expect(text).toContain('error: about must be at least 60 characters');
    expect(text).toContain('400 to POST /api/projects');
  });

  it('defers to the full error when GEZEL_DEBUG=1', () => {
    const err = new GezelApiError('Gezel API error 500 on GET /api/x', 500);
    expect(formatCliFailure(err, { GEZEL_DEBUG: '1' })).toBeNull();
  });

  it('leaves unexpected errors to the caller', () => {
    expect(formatCliFailure(new TypeError('boom'))).toBeNull();
  });
});
