/**
 * Optional native runtimes must not become eager service-entry imports.
 *
 * The ordinary workspace always has node-pty linked, which used to hide that
 * importing gezeld loaded the native addon before any terminal was opened.
 * A Node 24 synchronous resolve hook gives the built package a resolver where
 * node-pty is deliberately unavailable. Importing the service must still work;
 * the terminal-specific source tests cover the friendly failure on first use.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPublishedPackages } from './_packages';

const service = loadPublishedPackages().find((pkg) => pkg.name === '@bendyline/gezel-service')!;

describe('optional service runtimes', () => {
  it('declares node-pty as optional rather than a hard runtime dependency', () => {
    expect(service.pkg.dependencies?.['node-pty']).toBeUndefined();
    expect(service.pkg.optionalDependencies?.['node-pty']).toBe('^1.1.0');
  });

  it('imports the built service module without resolving node-pty', () => {
    const entryUrl = pathToFileURL(resolve(service.dist, 'index.js')).href;
    const probe = [
      "import { registerHooks } from 'node:module';",
      'registerHooks({',
      '  resolve(specifier, context, nextResolve) {',
      "    if (specifier === 'node-pty') throw new Error('eager node-pty resolution');",
      '    return nextResolve(specifier, context);',
      '  },',
      '});',
      `await import(${JSON.stringify(entryUrl)});`,
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: service.path,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });

    expect(
      result.status,
      [result.error?.stack, result.stderr, result.stdout].filter(Boolean).join('\n'),
    ).toBe(0);
  });
});
