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

const packages = loadPublishedPackages();
const service = packages.find((pkg) => pkg.name === '@bendyline/gezel-service')!;
const appSdk = packages.find((pkg) => pkg.name === '@bendyline/gezel-app-sdk')!;

describe('optional service runtimes', () => {
  it('declares node-pty as an optional peer rather than an installed dependency', () => {
    expect(service.pkg.dependencies?.['node-pty']).toBeUndefined();
    expect(service.pkg.optionalDependencies?.['node-pty']).toBeUndefined();
    expect(service.pkg.peerDependencies?.['node-pty']).toBe('^1.1.0');
    expect(service.pkg.peerDependenciesMeta?.['node-pty']).toEqual({ optional: true });
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

describe('optional app-SDK host runtime', () => {
  it('declares the service as an optional peer, not an installed dependency', () => {
    // An app that only connects to the user's Gezel must be able to install
    // this SDK without pulling a ~37 MB daemon it will never start.
    expect(appSdk.pkg.dependencies?.['@bendyline/gezel-service']).toBeUndefined();
    expect(appSdk.pkg.peerDependencies?.['@bendyline/gezel-service']).toBeTruthy();
    expect(appSdk.pkg.peerDependenciesMeta?.['@bendyline/gezel-service']).toEqual({
      optional: true,
    });
  });

  it('imports the host entry without resolving the service', () => {
    // The service is reached by a dynamic import, and only when an app
    // actually hosts. Importing `/host` to read its types or call
    // `connectOrHost` against a running daemon must not need it installed.
    const entryUrl = pathToFileURL(resolve(appSdk.dist, 'host.js')).href;
    const probe = [
      "import { registerHooks } from 'node:module';",
      'registerHooks({',
      '  resolve(specifier, context, nextResolve) {',
      "    if (specifier === '@bendyline/gezel-service') throw new Error('eager service resolution');",
      '    return nextResolve(specifier, context);',
      '  },',
      '});',
      `const mod = await import(${JSON.stringify(entryUrl)});`,
      "if (typeof mod.connectOrHost !== 'function') throw new Error('missing connectOrHost');",
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: appSdk.path,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });

    expect(
      result.status,
      [result.error?.stack, result.stderr, result.stdout].filter(Boolean).join('\n'),
    ).toBe(0);
  });
});
