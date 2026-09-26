import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findUnbootstrappedPackages } from './check-npm-bootstrap.mjs';

function fakeRegistry(statusByName) {
  return async (url) => {
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    const status = statusByName[name] ?? 200;
    return { status, ok: status >= 200 && status < 300 };
  };
}

test('names a registered package that npm has never seen', async () => {
  const result = await findUnbootstrappedPackages({
    names: ['@bendyline/gezel', '@bendyline/gezel-script-runtime'],
    fetch: fakeRegistry({ '@bendyline/gezel-script-runtime': 404 }),
  });
  assert.deepEqual(result, { missing: ['@bendyline/gezel-script-runtime'], unreachable: [] });
});

test('passes when every package exists', async () => {
  const result = await findUnbootstrappedPackages({
    names: ['@bendyline/gezel', '@bendyline/gezk'],
    fetch: fakeRegistry({}),
  });
  assert.deepEqual(result, { missing: [], unreachable: [] });
});

test('reports registry trouble separately from a missing package', async () => {
  const result = await findUnbootstrappedPackages({
    names: ['@bendyline/gezel'],
    fetch: fakeRegistry({ '@bendyline/gezel': 503 }),
  });
  assert.deepEqual(result, { missing: [], unreachable: ['@bendyline/gezel (HTTP 503)'] });
});

test('encodes the scope separator the way the registry expects', async () => {
  const seen = [];
  await findUnbootstrappedPackages({
    names: ['@bendyline/gezel-cli'],
    fetch: async (url) => {
      seen.push(url);
      return { status: 200, ok: true };
    },
  });
  assert.deepEqual(seen, ['https://registry.npmjs.org/@bendyline%2fgezel-cli']);
});
