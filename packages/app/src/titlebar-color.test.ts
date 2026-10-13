import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function repositoryFile(relativeUrl: string): string {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), 'utf8');
}

const mainProcess = repositoryFile('./main.ts');
const splash = repositoryFile('../assets/splash.html');
const foundation = repositoryFile('../../ui/src/styles/foundation.css');

function rootToken(name: string): string {
  const match = foundation.match(new RegExp(`^\\s*--${name}:\\s*([^;]+);`, 'm'));
  if (!match?.[1]) throw new Error(`--${name} is not declared in foundation.css`);
  return match[1].trim();
}

function resolveToken(name: string): string {
  const value = rootToken(name);
  const alias = value.match(/^var\(--([\w-]+)\)$/);
  return alias?.[1] ? resolveToken(alias[1]) : value.toLowerCase();
}

const brandSage = mainProcess.match(/const BRAND_SAGE = '(#[0-9a-f]{6})';/i)?.[1]?.toLowerCase();

// Windows paints the window-control overlay itself, so a renderer titlebar
// one step deeper than the overlay reads as a seam beside minimize/maximize/
// close. A deliberate contrast pass changed only the CSS token and shipped
// exactly that seam.
describe('titlebar color contract', () => {
  it('paints the renderer titlebar the same sage as the native overlay', () => {
    expect(brandSage).toBeDefined();
    expect(resolveToken('titlebar')).toBe(brandSage);
    expect(mainProcess).toMatch(/titleBarOverlay:\s*\{\s*color:\s*BRAND_SAGE,/);
  });

  it('keeps the window background, fallback pages and splash on that sage', () => {
    expect(mainProcess).toContain('backgroundColor: BRAND_SAGE,');
    expect(mainProcess).not.toMatch(/background:\s*#[0-9a-f]{6};\s*color:\s*#f3ede0/i);
    expect(splash.toLowerCase()).toContain(`background: ${brandSage};`);
  });
});
