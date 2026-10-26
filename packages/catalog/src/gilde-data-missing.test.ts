import { describe, expect, it, vi } from 'vitest';

/**
 * The catalog installed globally beside the service, where node resolution
 * from the catalog's own folder cannot reach Gilde.
 */
const resolveGilde = vi.hoisted(() => vi.fn<(specifier: string) => string>());

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  return {
    ...actual,
    createRequire: () => ({ resolve: resolveGilde }),
  };
});

const { GILDE_NOT_FOUND_MESSAGE, gildeDataDir, gildePackageRoot } = await import('./gilde-data.js');

function failWith(code: string): void {
  resolveGilde.mockImplementation(() => {
    const error = new Error("Cannot find module '@bendyline/gilde/package.json'");
    (error as NodeJS.ErrnoException).code = code;
    throw error;
  });
}

describe('gilde data resolution without Gilde', () => {
  it('says what to install when Gilde is missing', () => {
    failWith('MODULE_NOT_FOUND');
    expect(() => gildePackageRoot()).toThrow(GILDE_NOT_FOUND_MESSAGE);
    expect(GILDE_NOT_FOUND_MESSAGE).toContain('npm install @bendyline/gilde');
  });

  it('still reports any other resolution failure as it is', () => {
    failWith('ERR_PACKAGE_PATH_NOT_EXPORTED');
    expect(() => gildePackageRoot()).toThrow("Cannot find module '@bendyline/gilde/package.json'");
  });

  it('never resolves when GEZEL_GILDE_DATA_DIR is set', () => {
    failWith('MODULE_NOT_FOUND');
    const previous = process.env.GEZEL_GILDE_DATA_DIR;
    process.env.GEZEL_GILDE_DATA_DIR = '/override/gilde/data';
    try {
      expect(gildeDataDir()).toBe('/override/gilde/data');
    } finally {
      if (previous === undefined) delete process.env.GEZEL_GILDE_DATA_DIR;
      else process.env.GEZEL_GILDE_DATA_DIR = previous;
    }
  });
});
