import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readPathVar, resolveNpmCli, resolvePnpmCli, spawnPnpmSync } from './pnpm-cli.mjs';

test('reads PATH whatever case the platform stored it under', () => {
  assert.equal(readPathVar({ PATH: '/a:/b' }), '/a:/b');
  // Windows: `process.env` is a case-insensitive proxy, but spreading it into
  // a plain object yields the real key. Every caller that injects a variable
  // spreads, so this is the shape the resolver actually receives.
  assert.equal(readPathVar({ Path: 'C:\\a;C:\\b' }), 'C:\\a;C:\\b');
  assert.equal(readPathVar({ path: '/lower' }), '/lower');
  assert.equal(readPathVar({}), '');
  assert.equal(readPathVar({ PATH: undefined, Path: '/fallback' }), '/fallback');
});

test('resolves pnpm from a spread environment', () => {
  // The regression: `{...process.env}` loses `PATH` on Windows, the PATH scan
  // saw an empty string, and resolution threw "Could not resolve pnpm's
  // JavaScript CLI on Windows" while pnpm was installed and on PATH.
  const env = { ...process.env };
  delete env.npm_execpath;
  delete env.GEZEL_PNPM_CLI;
  assert.doesNotThrow(() => resolvePnpmCli(['--version'], { env }));
});

test('synchronously launches pnpm through a resolved JavaScript CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gezel-pnpm-sync-'));
  const cli = join(dir, 'pnpm.mjs');
  try {
    writeFileSync(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
    const result = spawnPnpmSync(['pack', '--json'], {
      env: { GEZEL_PNPM_CLI: cli },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(result.error, undefined);
    assert.deepEqual(JSON.parse(result.stdout), ['pack', '--json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('launches npm through its JavaScript CLI when the environment names one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gezel-npm-cli-'));
  const cli = join(dir, 'npm-cli.js');
  writeFileSync(cli, '// stub\n', 'utf8');

  const resolved = resolveNpmCli(['view', 'pkg', 'version'], { env: { npm_execpath: cli } });
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.args, [cli, 'view', 'pkg', 'version']);
  assert.equal(resolved.shell, false);
});

test('falls back to the npm shim rather than throwing when no CLI resolves', () => {
  const resolved = resolveNpmCli(['view', 'pkg'], { env: { PATH: '' } });
  assert.equal(resolved.command, 'npm');
  assert.deepEqual(resolved.args, ['view', 'pkg']);
  // Only the Windows shim needs a shell; that is the one DEP0190 source left.
  assert.equal(resolved.shell, process.platform === 'win32');
});
