import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PUBLISHED_PACKAGE_DIRS, readPublishedManifest } from './published-packages.mjs';
import {
  REGISTRY_AVAILABILITY_TIMEOUT_MS,
  verifyPublishedNpmRelease,
} from './verify-published-npm-release.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publishedSpecs = PUBLISHED_PACKAGE_DIRS.map((dir) => {
  const manifest = readPublishedManifest(repoRoot, dir);
  return `${manifest.name}@${manifest.version}`;
});
const serviceSpec = publishedSpecs.find((spec) => spec.startsWith('@bendyline/gezel-service@'));
if (!serviceSpec) throw new Error('published package list must include @bendyline/gezel-service');

function registryFixture({
  availableAfterMs = 0,
  delayedSpec,
  consumerStatus = 0,
  spawnError,
  availabilityTimeoutMs,
} = {}) {
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
          const spec = args.find((arg) => arg.startsWith('@bendyline/'));
          const delayed = delayedSpec === undefined || spec === delayedSpec;
          return { status: !delayed || elapsedMs >= availableAfterMs ? 0 : 1 };
        }
        assert.equal(command, process.execPath);
        consumers.push(args);
        return { status: consumerStatus };
      },
      wait(ms) {
        waits.push(ms);
        elapsedMs += ms;
      },
      now() {
        return elapsedMs;
      },
      log(message) {
        logs.push(message);
      },
      availabilityTimeoutMs,
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

  assert.equal(fixture.packs.length, publishedSpecs.length);
  const specs = fixture.packs.map((args) => {
    assert.equal(args[0], 'pack');
    assert.ok(args.includes('--prefer-online'), 'cached registry metadata must be revalidated');
    return args.find((arg) => arg.startsWith('@bendyline/'));
  });
  assert.deepEqual(specs, publishedSpecs);
  assert.ok(specs.some((spec) => spec.startsWith('@bendyline/gezk@')));
  const tarballDir = fixture.packs[0][fixture.packs[0].indexOf('--pack-destination') + 1];
  assert.deepEqual(fixture.consumers, [
    [
      resolve(repoRoot, 'scripts/check-package-consumers.mjs'),
      '--tarball-dir',
      tarballDir,
      '--require-release-stamp',
    ],
  ]);
  assert.deepEqual(fixture.waits, []);
  assertCleanedUp(fixture);
});

test('survives an eight-minute publish-time scan without redownloading ready siblings', () => {
  const fixture = registryFixture({
    availableAfterMs: 8 * 60_000 + 15_000,
    delayedSpec: serviceSpec,
  });
  verifyPublishedNpmRelease(fixture.options);

  assert.equal(
    fixture.waits.reduce((sum, ms) => sum + ms, 0),
    8 * 60_000 + 15_000,
  );
  assert.equal(fixture.consumers.length, 1);
  const attemptsBySpec = Map.groupBy(fixture.packs, (args) =>
    args.find((arg) => arg.startsWith('@bendyline/')),
  );
  assert.ok(attemptsBySpec.get(serviceSpec).length > 1);
  for (const [spec, attempts] of attemptsBySpec) {
    if (spec !== serviceSpec)
      assert.equal(attempts.length, 1, `${spec} should only be downloaded once`);
  }
  assert.equal(REGISTRY_AVAILABILITY_TIMEOUT_MS, 40 * 60_000);
  assertCleanedUp(fixture);
});

test('fails at the wall-clock deadline and names the artifact still being scanned', () => {
  const fixture = registryFixture({
    availableAfterMs: Number.POSITIVE_INFINITY,
    delayedSpec: serviceSpec,
    availabilityTimeoutMs: 45_000,
  });
  assert.throws(
    () => verifyPublishedNpmRelease(fixture.options),
    new RegExp(
      `could not download 1/${publishedSpecs.length} exact published artifacts within 0\\.75 minutes: ${serviceSpec}`,
    ),
  );

  assert.equal(fixture.waits.length, 3);
  assert.equal(
    fixture.waits.reduce((sum, ms) => sum + ms, 0),
    45_000,
  );
  assert.match(fixture.logs.at(-1), new RegExp(serviceSpec));
  assert.equal(fixture.consumers.length, 0);
  assertCleanedUp(fixture);
});

test('consumer failures remain fatal and do not restart registry retries', () => {
  const fixture = registryFixture({ consumerStatus: 1 });
  assert.throws(
    () => verifyPublishedNpmRelease(fixture.options),
    /published artifact consumer checks failed \(1\)/,
  );

  assert.equal(fixture.packs.length, PUBLISHED_PACKAGE_DIRS.length);
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
