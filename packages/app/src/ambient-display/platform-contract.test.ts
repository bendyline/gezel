import { describe, expect, it } from 'vitest';
import * as darwin from './darwin.js';
import type { AmbientDisplayModule } from './index.js';
import * as linux from './linux.js';
import * as win32 from './win32.js';

/**
 * Every platform module satisfies the same shape, and the pure command
 * builders quote hostile paths safely — the file lives in the user's
 * home, so spaces, quotes, and ampersands are ordinary inputs.
 */

const HOSTILE_PATH = `/Users/test user/.gezel/ambient/It's "mine" & co.png`;

describe('ambient-display platform module contract', () => {
  it('all platform modules satisfy AmbientDisplayModule', () => {
    for (const mod of [darwin, linux, win32]) {
      const shaped: AmbientDisplayModule = mod;
      expect(typeof shaped.capability).toBe('function');
      expect(typeof shaped.getCurrentWallpaper).toBe('function');
      expect(typeof shaped.setWallpaper).toBe('function');
      expect(typeof shaped.restoreWallpaper).toBe('function');
    }
  });

  it('darwin escapes AppleScript string metacharacters', () => {
    const script = darwin.buildSetScript(HOSTILE_PATH);
    expect(script).toContain(
      `POSIX file "/Users/test user/.gezel/ambient/It's \\"mine\\" & co.png"`,
    );
    expect(darwin.buildSetScript('a\\b"c')).toContain('a\\\\b\\"c');
  });

  it('win32 quotes the image path as a PowerShell literal', () => {
    const winPath = `C:\\Users\\Test & User\\.gezel\\ambient\\It's mine.png`;
    const script = win32.buildSetWallpaperPs(winPath);
    expect(script).toContain(`'C:\\Users\\Test & User\\.gezel\\ambient\\It''s mine.png'`);
    expect(script).toContain('SystemParametersInfo(20, 0,');
  });

  it('win32 powershellLiteral matches the service local-harness rule', () => {
    // Replicated from packages/service/src/local-harness/base.ts — the
    // app cannot import the service. Keep the outputs identical.
    const serviceRule = (value: string) => `'${value.replace(/'/g, "''")}'`;
    for (const value of ['plain', `It's`, `two''quotes`, 'path with space']) {
      expect(win32.powershellLiteral(value)).toBe(serviceRule(value));
    }
  });
});
