import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  candidateTarballCacheKeys,
  npmConsumerCacheDir,
  prepareNpmConsumerCache,
  pruneCandidateTarballs,
} from './npm-consumer-cache.mjs';

const consumer = resolve('/tmp/gezel-packed-consumer-AAAA/consumer');
const tarballs = [
  resolve('/tmp/gezel-npm-rehearsal-BBBB/tarballs/bendyline-gezel-1.3.1.tgz'),
  resolve('/tmp/gezel-npm-rehearsal-BBBB/tarballs/gezel-cli-1.0.3.tgz'),
];
const absoluteKey = (path) => `pacote:tarball:file:${path.replaceAll('\\', '/')}`;

test('keeps the cache in the repo by default and honors an override', () => {
  assert.equal(npmConsumerCacheDir('/repo', {}), resolve('/repo/.cache/npm-consumer-cache'));
  assert.equal(
    npmConsumerCacheDir('/repo', { GEZEL_CONSUMER_NPM_CACHE: '/elsewhere/cache' }),
    resolve('/elsewhere/cache'),
  );
});

test('picks one key per candidate tarball, relative or absolute', () => {
  const listing = [
    'make-fetch-happen:request-cache:https://registry.npmjs.org/zod',
    'pacote:tarball:file:../../gezel-npm-rehearsal-BBBB/tarballs/bendyline-gezel-1.3.1.tgz',
    absoluteKey(tarballs[0]),
    absoluteKey(tarballs[1]),
    '',
  ].join('\r\n');
  assert.deepEqual(candidateTarballCacheKeys(listing, tarballs, consumer), [
    'pacote:tarball:file:../../gezel-npm-rehearsal-BBBB/tarballs/bendyline-gezel-1.3.1.tgz',
    absoluteKey(tarballs[1]),
  ]);
});

test("leaves registry entries and other runs' tarballs alone", () => {
  const listing = [
    'pacote:tarball:file:../../gezel-npm-rehearsal-CCCC/tarballs/bendyline-gezel-1.3.1.tgz',
    'pacote:tarball:file:../tarballs/bendyline-gezel-1.3.1.tgz',
    'make-fetch-happen:request-cache:https://registry.npmjs.org/zod/-/zod-4.6.7.tgz',
  ].join('\n');
  assert.deepEqual(candidateTarballCacheKeys(listing, tarballs, consumer), []);
});

test('matches Windows keys whatever their drive-letter case', () => {
  const windowsTarball = 'C:\\Users\\me\\AppData\\Local\\Temp\\r\\tarballs\\gezel-cli-1.0.3.tgz';
  const listing =
    'pacote:tarball:file:c:/users/me/appdata/local/temp/r/tarballs/gezel-cli-1.0.3.tgz';
  assert.deepEqual(candidateTarballCacheKeys(listing, [windowsTarball], 'C:\\consumer', 'win32'), [
    listing,
  ]);
});

test('reports an empty cache, keeps one within budget, and starts an oversized one over', () => {
  const root = mkdtempSync(join(tmpdir(), 'gezel-npm-cache-test-'));
  try {
    const dir = join(root, 'cache');
    const logs = [];
    const log = (line) => logs.push(line);
    assert.deepEqual(prepareNpmConsumerCache(dir, { log }), { bytes: 0, reset: false });
    assert.match(logs.at(-1), /is empty/);

    mkdirSync(join(dir, '_cacache'), { recursive: true });
    writeFileSync(join(dir, '_cacache', 'entry'), Buffer.alloc(2048));
    assert.deepEqual(prepareNpmConsumerCache(dir, { maxBytes: 4096, log }), {
      bytes: 2048,
      reset: false,
    });
    assert.ok(existsSync(dir));

    assert.deepEqual(prepareNpmConsumerCache(dir, { maxBytes: 1024, log }), {
      bytes: 2048,
      reset: true,
    });
    assert.ok(!existsSync(dir));
    assert.match(logs.at(-1), /started it over/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleans the selected keys in one npm call', () => {
  const calls = [];
  const runNpm = (args) => {
    calls.push(args);
    if (args[1] === 'ls') return { status: 0, stdout: `${absoluteKey(tarballs[0])}\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const removed = pruneCandidateTarballs({
    runNpm,
    tarballs,
    consumerDir: consumer,
    log: () => {},
  });
  assert.equal(removed, 1);
  assert.deepEqual(calls, [
    ['cache', 'ls'],
    ['cache', 'clean', absoluteKey(tarballs[0])],
  ]);
});

test('never throws when npm cannot list or clean the cache', () => {
  const logs = [];
  for (const runNpm of [
    () => ({ status: 1, stdout: '', stderr: 'EACCES' }),
    () => {
      throw new Error('could not resolve the Windows npm CLI');
    },
    (args) =>
      args[1] === 'ls'
        ? { status: 0, stdout: absoluteKey(tarballs[1]), stderr: '' }
        : { status: 1, stdout: '', stderr: 'EPERM' },
  ]) {
    assert.equal(
      pruneCandidateTarballs({ runNpm, tarballs, consumerDir: consumer, log: (l) => logs.push(l) }),
      0,
    );
  }
  assert.equal(logs.length, 3);
  for (const line of logs) assert.match(line, /could not remove/);
});
