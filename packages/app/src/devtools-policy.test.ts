import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { devToolsAllowed } from './devtools-policy.js';

const mainProcess = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');

describe('devToolsAllowed', () => {
  it('keeps DevTools in development launches', () => {
    expect(devToolsAllowed({ isPackaged: false, env: {} })).toBe(true);
  });

  it('withholds DevTools from packaged builds by default', () => {
    expect(devToolsAllowed({ isPackaged: true, env: {} })).toBe(false);
    expect(devToolsAllowed({ isPackaged: true, env: { GEZEL_DEVTOOLS: '0' } })).toBe(false);
    expect(devToolsAllowed({ isPackaged: true, env: { GEZEL_DEVTOOLS: 'true' } })).toBe(false);
  });

  it('re-enables them in a packaged build only on the explicit support opt-in', () => {
    expect(devToolsAllowed({ isPackaged: true, env: { GEZEL_DEVTOOLS: '1' } })).toBe(true);
  });
});

describe('main-process DevTools wiring', () => {
  it('derives the decision once from the packaged state and the environment', () => {
    expect(mainProcess).toContain(
      'const allowDevTools = devToolsAllowed({ isPackaged: app.isPackaged, env: process.env });',
    );
  });

  it('disables DevTools on the window itself, not only in the menu', () => {
    expect(mainProcess).toMatch(/webPreferences: \{[\s\S]*?devTools: allowDevTools,/);
  });

  it('offers Toggle Developer Tools only when DevTools are allowed', () => {
    const toggles = mainProcess.match(/role: 'toggleDevTools'/g) ?? [];
    expect(toggles).toHaveLength(1);
    expect(mainProcess).toMatch(
      /\.\.\.\(allowDevTools\s*\?\s*\(\[\{ role: 'toggleDevTools' \}\] as Electron\.MenuItemConstructorOptions\[\]\)\s*:\s*\[\]\),/,
    );
  });

  it('never opens DevTools programmatically', () => {
    expect(mainProcess).not.toMatch(/\.openDevTools\(/);
    expect(mainProcess).not.toMatch(/\.toggleDevTools\(/);
  });
});
