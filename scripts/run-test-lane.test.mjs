import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LANES, runLane, withTimings } from './run-test-lane.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Every workspace package `pnpm test:ci` runs: the gezel and gezk packages that have tests. */
function testCiPackages() {
  const dirs = [...readdirSync(join(root, 'packages')).map((d) => join('packages', d)), 'evals'];
  const out = [];
  for (const dir of dirs) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const name = manifest.name ?? '';
    if (!/^@bendyline\/(gezel|gezk)/.test(name) || !manifest.scripts?.test) continue;
    out.push(name);
  }
  return out.sort();
}

function lanesNaming(predicate) {
  return Object.entries(LANES)
    .filter(([, commands]) => commands.some(predicate))
    .map(([lane]) => lane);
}

test('the lanes run every package test:ci runs, each in exactly one lane', () => {
  const packagesLane = LANES.packages[0];
  const excluded = packagesLane
    .filter((arg, i) => packagesLane[i - 1] === '--filter' && arg.startsWith('!'))
    .map((arg) => arg.slice(1))
    .sort();
  assert.deepEqual(excluded, ['@bendyline/gezel-service', '@bendyline/gezel-ui']);
  for (const name of testCiPackages()) {
    if (name === '@bendyline/gezel-service') {
      assert.deepEqual(lanesNaming((args) => args.includes(name)).sort(), [
        'service-integration',
        'service-integration-chat',
        'service-unit',
      ]);
    } else if (name === '@bendyline/gezel-ui') {
      assert.deepEqual(
        lanesNaming((args) => args.includes(name)),
        ['ui'],
      );
    } else {
      assert.ok(!excluded.includes(name), `${name} runs in the packages lane`);
    }
  }
});

test('the service lanes run every service project exactly once', () => {
  const config = readFileSync(join(root, 'packages', 'service', 'vitest.config.ts'), 'utf8');
  const declared = [...config.matchAll(/\bname: '([\w-]+)'/g)].map((m) => m[1]).sort();
  const run = Object.entries(LANES)
    .filter(([lane]) => lane.startsWith('service-'))
    .flatMap(([, commands]) =>
      commands.flatMap((args) => args.filter((arg, i) => args[i - 1] === '--project')),
    )
    .sort();
  assert.deepEqual(run, declared);
});

test('a lane stops at the first failing command and reports its status', () => {
  const calls = [];
  const status = runLane('ui', (args) => {
    calls.push(args);
    return { status: 3 };
  });
  assert.equal(status, 3);
  assert.equal(calls.length, 1);
});

test('asks vitest for a timing report only when CI names a folder for it', () => {
  const vitest = LANES['service-unit'][0];
  assert.deepEqual(withTimings('service-unit', 0, vitest, undefined), vitest);
  const timed = withTimings('service-unit', 0, vitest, '/tmp/timings');
  assert.deepEqual(timed.slice(0, vitest.length), vitest);
  assert.ok(timed.includes('--reporter=default'), 'the console log stays as it was');
  assert.match(timed.at(-1), /^--outputFile\.json=.*\/service-unit-0\.json$/);
  const packages = LANES.packages[0];
  assert.deepEqual(withTimings('packages', 0, packages, '/tmp/timings'), packages);
});

test('an unknown lane is refused with the list of lanes', () => {
  assert.equal(
    runLane('nope', () => {
      throw new Error('must not spawn');
    }),
    2,
  );
});
