import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PUBLISHED_PACKAGE_DIRS, readPublishedManifest } from './published-packages.mjs';
import { verifyPublishedNpmRelease } from './verify-published-npm-release.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function registryFixture({ availableAfterMs = 0, consumerStatus = 0, spawnError } = {}) {
  const packs = [];
  const consumers = [];
  const waits = [];
  const logs = [];
  let elapsedMs = 0;
  return {
    packs,
    consumers,
    waits,
    logs,
    options: {
      spawn(command, args) {
        if (command === 'npm') {
          packs.push(args);
          if (spawnError) return { error: spawnError, status: null };
          return { status: elapsedMs >= availableAfterMs ? 0 : 1 };
        }
        assert.equal(command, process.execPath);
        consumers.push(args);
        return { status: consumerStatus };
      },
      wait(ms) {
        waits.push(ms);
        elapsedMs += ms;
      },
      log(message) {
        logs.push(message);
      },
    },
  };
}

function assertCleanedUp(fixture) {
  const args = fixture.packs[0];
  const tarballDir = args[args.indexOf('--pack-destination') + 1];
  assert.equal(existsSync(dirname(tarballDir)), false, 'temporary artifacts and cache are removed');
}

test('downloads every exact package version, including gezk, before strict consumer checks', () => {
  const fixture = registryFixture();
  verifyPublishedNpmRelease(fixture.options);

  assert.equal(fixture.packs.length, 1);
  const args = fixture.packs[0];
  assert.equal(args[0], 'pack');
  assert.ok(args.includes('--prefer-online'), 'cached registry metadata must be revalidated');
  const specs = args.filter((arg) => arg.startsWith('@bendyline/'));
  const expected = PUBLISHED_PACKAGE_DIRS.map((dir) => {
    const manifest = readPublishedManifest(repoRoot, dir);
    return `${manifest.name}@${manifest.version}`;
  });
  assert.deepEqual(specs, expected);
  assert.ok(specs.some((spec) => spec.startsWith('@bendyline/gezk@')));
  assert.deepEqual(fixture.consumers, [
    [
      resolve(repoRoot, 'scripts/check-package-consumers.mjs'),
      '--tarball-dir',
      args[args.indexOf('--pack-destination') + 1],
      '--require-release-stamp',
    ],
  ]);
  assert.deepEqual(fixture.waits, []);
  assertCleanedUp(fixture);
});

test('survives registry propagation lasting longer than the former 45-second retry window', () => {
  const fixture = registryFixture({ availableAfterMs: 105_000 });
  verifyPublishedNpmRelease(fixture.options);

  assert.equal(
    fixture.waits.reduce((sum, ms) => sum + ms, 0),
    105_000,
  );
  assert.equal(fixture.consumers.length, 1);
  for (const args of fixture.packs) assert.deepEqual(args, fixture.packs[0]);
  assertCleanedUp(fixture);
});

test('fails after five minutes of retries without accepting a missing release', () => {
  const fixture = registryFixture({ availableAfterMs: Number.POSITIVE_INFINITY });
  assert.throws(
    () => verifyPublishedNpmRelease(fixture.options),
    /could not download the exact published artifacts after 21 attempts \(1\)/,
  );

  assert.equal(fixture.packs.length, 21);
  assert.equal(fixture.waits.length, 20);
  assert.equal(
    fixture.waits.reduce((sum, ms) => sum + ms, 0),
    300_000,
  );
  assert.equal(fixture.consumers.length, 0);
  assertCleanedUp(fixture);
});

test('consumer failures remain fatal and do not restart registry retries', () => {
  const fixture = registryFixture({ consumerStatus: 1 });
  assert.throws(
    () => verifyPublishedNpmRelease(fixture.options),
    /published artifact consumer checks failed \(1\)/,
  );

  assert.equal(fixture.packs.length, 1);
  assert.equal(fixture.consumers.length, 1);
  assert.deepEqual(fixture.waits, []);
  assertCleanedUp(fixture);
});

test('an npm spawn failure is reported immediately and removes temporary state', () => {
  const spawnError = new Error('spawn npm ENOENT');
  const fixture = registryFixture({ spawnError });
  assert.throws(() => verifyPublishedNpmRelease(fixture.options), spawnError);
  assert.equal(fixture.packs.length, 1);
  assert.equal(fixture.consumers.length, 0);
  assert.deepEqual(fixture.waits, []);
  assertCleanedUp(fixture);
});
