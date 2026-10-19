import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureNativeBinaries } from './ensure-native-binaries.mjs';

function harness({ hasPins = true, verdicts = [], fetchCode = 0 } = {}) {
  const calls = { verify: 0, fetch: [], log: [], warn: [] };
  const queue = [...verdicts];
  return {
    calls,
    opts: {
      release: '0.1.51',
      hasPins,
      verify: async () => {
        calls.verify += 1;
        return queue.shift() ?? { reused: false, reason: 'no verdict scripted' };
      },
      fetch: (version) => {
        calls.fetch.push(version);
        return fetchCode;
      },
      log: (message) => calls.log.push(message),
      warn: (message) => calls.warn.push(message),
    },
  };
}

test('leaves a tree that already verifies alone', async () => {
  const { calls, opts } = harness({
    verdicts: [{ reused: true, reason: 'verified standalone native release 0.1.51 in 0.1s' }],
  });
  assert.equal(await ensureNativeBinaries(opts), 'current');
  assert.deepEqual(calls.fetch, []);
  assert.equal(calls.verify, 1);
});

test('fetches the pinned release, not latest, when the tree is stale', async () => {
  const { calls, opts } = harness({
    verdicts: [
      { reused: false, reason: 'gezel-llama-server sha256 mismatch' },
      { reused: true, reason: 'verified standalone native release 0.1.51 in 0.4s' },
    ],
  });
  assert.equal(await ensureNativeBinaries(opts), 'fetched');
  assert.deepEqual(calls.fetch, ['0.1.51']);
  assert.equal(calls.verify, 2);
  assert.deepEqual(calls.warn, []);
});

test('a failed fetch warns instead of blocking the launch', async () => {
  const { calls, opts } = harness({
    verdicts: [{ reused: false, reason: 'missing' }],
    fetchCode: 1,
  });
  assert.equal(await ensureNativeBinaries(opts), 'fetch-failed');
  assert.equal(calls.verify, 1);
  assert.match(calls.warn[0], /--version 0\.1\.51/);
});

test('reports a fetched tree the verifier still rejects', async () => {
  const { calls, opts } = harness({
    verdicts: [
      { reused: false, reason: 'missing' },
      { reused: false, reason: 'unpinned loadable file libextra.dylib' },
    ],
  });
  assert.equal(await ensureNativeBinaries(opts), 'unverified');
  assert.match(calls.warn[0], /libextra\.dylib/);
});

test('does nothing on a platform the release does not pin', async () => {
  const { calls, opts } = harness({ hasPins: false });
  assert.equal(await ensureNativeBinaries(opts), 'skipped');
  assert.equal(calls.verify, 0);
  assert.deepEqual(calls.fetch, []);
});
