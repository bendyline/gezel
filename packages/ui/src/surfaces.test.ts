import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// surfaces.css only reaches the page through these edges. A view reached any
// other way renders with the startup sheets alone, and nothing fails loudly.
const source = (path: string) => readFileSync(resolve(import.meta.dirname, path), 'utf8');

describe('surface stylesheets', () => {
  it('arrive with every destination the shell can open', () => {
    const loaders = [
      ...source('components/tab-content-loaders.ts').matchAll(
        /export const (load\w+) =\s*([^;]+);/g,
      ),
    ];
    expect(loaders.length).toBeGreaterThan(10);
    for (const [, name, body] of loaders) expect(body, name).toMatch(/^destination\(/);
  });

  it('load after the startup manifest in every entry that renders views outside the shell', () => {
    for (const entry of ['office/pane-main.tsx', 'embedded/webview-main.tsx']) {
      const text = source(entry);
      const startup = text.indexOf("import '../styles.css';");
      expect(startup, entry).toBeGreaterThanOrEqual(0);
      expect(text.indexOf("import '../surfaces.css';"), entry).toBeGreaterThan(startup);
    }
    expect(source('embedded/EmbeddedChat.tsx')).toContain("import '../surfaces.css';");
  });

  it('never also ride the startup manifest', () => {
    const startup = source('styles.css');
    const sheets = [...source('surfaces.css').matchAll(/@import "([^"]+)"/g)].map((m) => m[1]!);
    expect(sheets.length).toBeGreaterThan(0);
    for (const sheet of sheets) expect(startup).not.toContain(sheet);
  });
});
