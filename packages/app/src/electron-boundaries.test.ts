import { describe, expect, it } from 'vitest';
import {
  daemonEntrypointArgument,
  isAllowedTopLevelNavigation,
  isExactApprovedPath,
} from './electron-boundaries.js';

describe('daemon-entrypoint launch guard', () => {
  it('recognizes the daemon entrypoint on both path separators', () => {
    expect(
      daemonEntrypointArgument([
        '/Applications/Gezel.app/Contents/MacOS/Gezel',
        '/x/dist/bin/gezeld.js',
      ]),
    ).toBe('/x/dist/bin/gezeld.js');
    expect(
      daemonEntrypointArgument([
        'C:\\Program Files\\gezel\\gezel.exe',
        'C:\\x\\dist\\bin\\gezeld.js',
      ]),
    ).toBe('C:\\x\\dist\\bin\\gezeld.js');
    expect(daemonEntrypointArgument(['gezel', 'gezeld.js'])).toBe('gezeld.js');
  });

  it('ignores a normal application launch', () => {
    expect(daemonEntrypointArgument(['/Applications/Gezel.app/Contents/MacOS/Gezel'])).toBeNull();
    expect(
      daemonEntrypointArgument(['gezel', '--gezel-home=/tmp/h', '--gezel-packaged-smoke']),
    ).toBeNull();
  });

  it('never matches argv[0], which is the executable itself', () => {
    expect(daemonEntrypointArgument(['/x/dist/bin/gezeld.js'])).toBeNull();
  });

  it('does not match lookalike filenames', () => {
    expect(daemonEntrypointArgument(['gezel', '/x/not-gezeld.js'])).toBeNull();
    expect(daemonEntrypointArgument(['gezel', '/x/gezeld.js.map'])).toBeNull();
    expect(daemonEntrypointArgument(['gezel', '/x/gezeld.json'])).toBeNull();
  });
});

describe('Electron boundary policies', () => {
  it('allows only the daemon origin and the exact splash file', () => {
    const origin = 'https://127.0.0.1:4312';
    const splash = 'file:///opt/gezel/splash.html';
    expect(isAllowedTopLevelNavigation(`${origin}/settings`, origin, splash)).toBe(true);
    expect(isAllowedTopLevelNavigation(splash, origin, splash)).toBe(true);
    expect(isAllowedTopLevelNavigation('file:///etc/passwd', origin, splash)).toBe(false);
    expect(isAllowedTopLevelNavigation('data:text/html,pwned', origin, splash)).toBe(false);
    expect(isAllowedTopLevelNavigation('https://example.com', origin, splash)).toBe(false);
  });

  it('approves exact roots, not their parents or children', () => {
    const approved = ['C:\\Users\\A\\.gezel\\projects'];
    expect(isExactApprovedPath('c:\\users\\a\\.gezel\\projects', approved, 'win32')).toBe(true);
    expect(isExactApprovedPath('C:\\Users\\A\\.gezel', approved, 'win32')).toBe(false);
    expect(isExactApprovedPath('C:\\Users\\A\\.gezel\\projects\\secret', approved, 'win32')).toBe(
      false,
    );
  });
});
