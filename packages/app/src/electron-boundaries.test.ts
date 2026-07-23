import { describe, expect, it } from 'vitest';
import { isAllowedTopLevelNavigation, isExactApprovedPath } from './electron-boundaries.js';

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
