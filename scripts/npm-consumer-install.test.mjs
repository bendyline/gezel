import assert from 'node:assert/strict';
import test from 'node:test';
import { runNpmConsumerInstall } from './npm-consumer-install.mjs';

const success = { status: 0, stdout: 'installed', stderr: '' };
const failed = (code, prefix = 'error') => ({
  status: 1,
  stdout: '',
  stderr: `npm warn cleanup EPERM: operation not permitted\nnpm ${prefix} code ${code}\n`,
});

test('recovers the reported connection reset despite Windows cleanup warnings', async () => {
  let attempts = 0;
  const waits = [];
  const warnings = [];
  const failure = failed('ECONNRESET');
  failure.stderr = failure.stderr.replace('error', '\u001b[31merror\u001b[39m');
  const result = await runNpmConsumerInstall(() => (++attempts === 1 ? failure : success), {
    wait: async (ms) => waits.push(ms),
    warn: (message) => warnings.push(message),
  });
  assert.equal(result, success);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [2_000]);
  assert.match(warnings[0], /ECONNRESET.*attempt 2\/3/);
});

test('fails with the final npm diagnostics after bounded network retries', async () => {
  let attempts = 0;
  const waits = [];
  const failure = failed('ETIMEDOUT', 'ERR!');
  const result = await runNpmConsumerInstall(
    () => {
      attempts += 1;
      return failure;
    },
    { wait: async (ms) => waits.push(ms), warn: () => {} },
  );
  assert.equal(result, failure);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [2_000, 5_000]);
});

test('does not retry package, authentication, filesystem, integrity, or lifecycle errors', async () => {
  for (const code of ['ERESOLVE', 'E401', 'E403', 'E404', 'EPERM', 'ENOSPC', 'EINTEGRITY', '1']) {
    const failure = failed(code);
    failure.stderr += 'npm error command output: ECONNRESET\n';
    let attempts = 0;
    const result = await runNpmConsumerInstall(
      () => {
        attempts += 1;
        return failure;
      },
      { wait: () => assert.fail('must not retry') },
    );
    assert.equal(result, failure);
    assert.equal(attempts, 1);
  }
});

test('does not retry success, an interrupted process, or a missing npm executable', async () => {
  for (const result of [success, { ...failed('ECONNRESET'), status: null, signal: 'SIGINT' }]) {
    assert.equal(
      await runNpmConsumerInstall(() => result, {
        wait: () => assert.fail('must not retry'),
      }),
      result,
    );
  }
  await assert.rejects(
    runNpmConsumerInstall(() => {
      throw new Error('spawn ENOENT');
    }),
    /ENOENT/,
  );
});

test('retries temporary DNS and registry failures', async () => {
  for (const code of ['EAI_AGAIN', 'E429', 'E503']) {
    let attempts = 0;
    assert.equal(
      await runNpmConsumerInstall(() => (++attempts === 1 ? failed(code) : success), {
        wait: async () => {},
        warn: () => {},
      }),
      success,
    );
    assert.equal(attempts, 2);
  }
});
