import { describe, expect, it } from 'vitest';
import { mainProcessIssueUrl, scrubMainProcessErrorText } from './main-process-errors.js';

describe('main-process error reporting', () => {
  it('removes credentials, emails, and absolute paths from public error text', () => {
    const scrubbed = scrubMainProcessErrorText(
      String.raw`Failed at C:\Program Files\Gezel\resources\app.asar\main.js for me@example.com with ghp_ABCdefGHIjklMNOpqrSTUvwxYZ0123456789`,
    );
    expect(scrubbed).toContain('<path>');
    expect(scrubbed).toContain('[EMAIL]');
    expect(scrubbed).toContain('[REDACTED]');
    expect(scrubbed).not.toContain('Program Files');
    expect(scrubbed).not.toContain(String.raw`Gezel\resources`);
    expect(scrubbed).not.toContain('me@example.com');
    expect(scrubbed).not.toContain('ghp_');
  });

  it('opens an editable, pre-filled issue without a stack or raw path', () => {
    const url = new URL(
      mainProcessIssueUrl({
        error: Object.assign(new Error(String.raw`write EPIPE at C:\Users\Mira\app.js`), {
          stack: String.raw`Error: write EPIPE\n at C:\Users\Mira\app.js:12:3`,
        }),
        source: 'uncaughtException',
        version: '1.26224.1',
        electronVersion: '43.2.0',
        nodeVersion: '24.0.0',
        platform: 'win32',
        arch: 'x64',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://github.com/bendyline/gezel/issues/new');
    expect(url.searchParams.get('title')).toContain('[main-process] write EPIPE');
    const body = url.searchParams.get('body') ?? '';
    expect(body).toContain('What I was doing');
    expect(body).toContain('Nothing is sent automatically');
    expect(body).not.toContain('### Stack');
    expect(body).not.toContain('Mira');
    expect(body).not.toContain('app.js:12:3');
    expect(url.href.length).toBeLessThanOrEqual(2_000);
  });
});
