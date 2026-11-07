import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A described tray drops a stem from its latched key into the readout panel
// beneath it. A tray marked described without that panel left the stem
// dangling into the next heading (Settings → Artificial intelligence,
// generalist mode). The readout is static markup next to the tray, so the
// pairing can be checked per component file.
const SRC = resolve(import.meta.dirname, '..');

function componentFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return componentFiles(path);
    return name.endsWith('.tsx') && !name.endsWith('.test.tsx') ? [path] : [];
  });
}

describe('described trays', () => {
  it('render a readout wherever a tray is marked described', () => {
    const missing = componentFiles(SRC).filter((file) => {
      const source = readFileSync(file, 'utf8');
      return source.includes('gz-tray--described') && !source.includes('gz-tray-description');
    });
    expect(missing.map((file) => relative(SRC, file))).toEqual([]);
  });
});
