import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gildeDataDir, gildePackageRoot } from './gilde-data.js';

/**
 * Permanent guard against the @bendyline/gilde exports gotcha: the
 * loader resolves the content root via the package's `./package.json`
 * export. If a gilde release ships an `exports` map without that
 * subpath, every catalog read silently returns empty — this test makes
 * that failure loud in gezel CI instead.
 */
describe('gilde data resolution', () => {
  it('resolves @bendyline/gilde/package.json through node resolution', () => {
    const require = createRequire(import.meta.url);
    expect(() => require.resolve('@bendyline/gilde/package.json')).not.toThrow();
  });

  it('finds the content tree at the package root', () => {
    const root = gildePackageRoot();
    expect(existsSync(join(root, 'data', 'chat-models', 'index.json'))).toBe(true);
    expect(existsSync(join(root, 'data', 'craftbook-templates', 'index.json'))).toBe(true);
    expect(existsSync(join(root, 'data', 'community', 'toolsets', 'index.json'))).toBe(true);
  });

  it('honors the GEZEL_GILDE_DATA_DIR override', () => {
    const prev = process.env.GEZEL_GILDE_DATA_DIR;
    process.env.GEZEL_GILDE_DATA_DIR = '/nonexistent-gilde-override';
    try {
      expect(gildeDataDir()).toBe('/nonexistent-gilde-override');
    } finally {
      if (prev === undefined) delete process.env.GEZEL_GILDE_DATA_DIR;
      else process.env.GEZEL_GILDE_DATA_DIR = prev;
    }
  });
});
