import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./guard-pnpm-install.mjs', import.meta.url));

function runGuard(env = {}) {
  const cleanEnv = { ...process.env, ...env };
  delete cleanEnv.GEZEL_SERIALIZED_PNPM_INSTALL;
  delete cleanEnv.CI;
  Object.assign(cleanEnv, env);
  return spawnSync(process.execPath, [script], { encoding: 'utf8', env: cleanEnv });
}

test('rejects a bare local pnpm install with the safe replacement', () => {
  const result = runGuard();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing a bare pnpm install/);
  assert.match(result.stderr, /pnpm deps:install/);
  assert.match(result.stderr, /pnpm deps:repair/);
});

test('admits installs launched by the checkout lock wrapper', () => {
  const result = runGuard({ GEZEL_SERIALIZED_PNPM_INSTALL: '1' });
  assert.equal(result.status, 0);
});

test('does not impose the local shared-checkout guard on CI', () => {
  const result = runGuard({ CI: 'true' });
  assert.equal(result.status, 0);
});
