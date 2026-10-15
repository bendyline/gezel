import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PACKAGE_BUILD_STAGES, runPackageBuilds } from './build-packages.mjs';
import {
  buildOutputLeasePath,
  dependencyLeasePath,
  withBuildOutputLease,
  withDependencyReadLease,
} from './dependency-lease.mjs';
import { runWorkspaceValidation } from './validate-workspace.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gezel-build-runner-test-'));
  const dependencyLease = await dependencyLeasePath(root);
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(dependencyLease, { recursive: true, force: true });
  });
  return root;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function capture() {
  let text = '';
  return {
    write(chunk) {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
}

test('workspace build stages finish dependencies and staged assets before consumers', () => {
  const index = (name) =>
    PACKAGE_BUILD_STAGES.findIndex((stage) => stage.args.includes(`@bendyline/${name}`));
  assert.ok(index('gezk') < index('gezel'));
  assert.ok(index('gezel') < index('gezel-client'));
  assert.ok(index('gezel-client') < index('gezel-mcp'));
  assert.ok(index('gezel-inference') < index('gezel-service'));
  assert.ok(index('gezel-ui') < index('gezel-service'));
  assert.ok(index('gezel-libreoffice-extension') < index('gezel-service'));
  assert.ok(index('gezel-service') < index('gezel-app'));
  assert.ok(PACKAGE_BUILD_STAGES[index('gezel-ui')].args.includes('build:all'));
});

test(
  'build output writers wait while dependency readers remain compatible',
  { timeout: 5000 },
  async (t) => {
    const root = await fixture(t);
    const started = deferred();
    const release = deferred();
    const waiting = deferred();
    t.mock.method(console, 'log', (message) => {
      if (message.startsWith('[build] waiting')) waiting.resolve();
    });
    const events = [];
    const first = withDependencyReadLease(root, () =>
      withBuildOutputLease(root, async () => {
        events.push('first:start');
        started.resolve();
        await release.promise;
        events.push('first:end');
      }),
    );
    await started.promise;
    const second = withBuildOutputLease(root, async () => events.push('second:start'), {
      pollMs: 5,
      timeoutMs: 2000,
    });
    await waiting.promise;
    assert.deepEqual(events, ['first:start']);
    release.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
  },
);

test('build locks live in the checkout and nested builds inherit their separate owner', async (t) => {
  const root = await fixture(t);
  assert.equal(await buildOutputLeasePath(root), join(root, '.cache', 'build-output-lease'));
  await withDependencyReadLease(root, async ({ leaseEnv: dependencyEnv }) => {
    await withBuildOutputLease(root, async ({ leaseEnv: buildEnv }) => {
      assert.notEqual(
        buildEnv.GEZEL_BUILD_OUTPUT_LEASE_TOKEN,
        dependencyEnv.GEZEL_DEPENDENCY_LEASE_TOKEN,
      );
      await withBuildOutputLease(
        root,
        async ({ leaseEnv: nested }) => {
          assert.deepEqual(nested, buildEnv);
        },
        { env: { ...dependencyEnv, ...buildEnv }, timeoutMs: 100, pollMs: 5 },
      );
    });
  });
});

test('a failure after successful DTS output stops the build and preserves its earlier error', async (t) => {
  const root = await fixture(t);
  const stdout = capture();
  const stderr = capture();
  const invocations = [];
  const stages = [
    { name: 'core', args: ['--filter', '@bendyline/gezel', 'run', 'build'] },
    { name: 'consumer', args: ['--filter', '@bendyline/gezel-service', 'run', 'build'] },
  ];
  const code = await runPackageBuilds({
    repoRoot: root,
    stages,
    stdout,
    stderr,
    spawnPnpmFn(args, options) {
      invocations.push(args);
      assert.equal(options.env.GEZEL_DEPENDENCY_LEASE_MODE, 'read');
      assert.equal(options.env.GEZEL_BUILD_OUTPUT_LEASE_MODE, 'mutation');
      return spawn(
        process.execPath,
        [
          '-e',
          "console.log('ESM Build success'); console.error('ENOENT: dist was cleaned by another build'); console.log('DTS Build success'); process.exitCode = 1;",
        ],
        options,
      );
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(invocations, [stages[0].args]);
  assert.match(stderr.text, /FAILED: core \(exit code 1\)/);
  assert.match(stderr.text, /Error output:[\s\S]*ENOENT/);
  const logDir = join(root, '.cache', 'build-logs');
  const logs = await readdir(logDir);
  assert.equal(logs.length, 1);
  const log = await readFile(join(logDir, logs[0]), 'utf8');
  assert.match(log, /ENOENT/);
  assert.match(log, /DTS Build success/);
  assert.match(log, /FAILED: core/);
});

test('a failed launch reports its stage without starting later consumers', async (t) => {
  const root = await fixture(t);
  const stderr = capture();
  const code = await runPackageBuilds({
    repoRoot: root,
    stdout: capture(),
    stderr,
    stages: [{ name: 'core', args: ['run', 'build'] }],
    spawnPnpmFn() {
      throw new Error('spawn ENOENT');
    },
  });
  assert.equal(code, 1);
  assert.match(stderr.text, /Could not start core: spawn ENOENT/);
});

test('validation owns build outputs through coverage and child builds inherit that lock', async (t) => {
  const root = await fixture(t);
  let token;
  const code = await runWorkspaceValidation({
    repoRoot: root,
    coverage: true,
    async runValidationFn({ env }) {
      token = env.GEZEL_BUILD_OUTPUT_LEASE_TOKEN;
      assert.ok(token);
      await withBuildOutputLease(root, async () => {}, { env, timeoutMs: 100, pollMs: 5 });
      return 0;
    },
    async runCoverageFn({ env }) {
      assert.equal(env.GEZEL_BUILD_OUTPUT_LEASE_TOKEN, token);
      const owner = JSON.parse(
        await readFile(join(await buildOutputLeasePath(root), 'writer', 'owner.json'), 'utf8'),
      );
      assert.equal(owner.token, token);
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(await readdir(await buildOutputLeasePath(root)), ['readers']);
});

test('a dead build owner is recovered after an interrupted build', async (t) => {
  const root = await fixture(t);
  const lease = await buildOutputLeasePath(root);
  await withBuildOutputLease(root, async () => {});
  await mkdir(join(lease, 'writer'));
  await writeFile(
    join(lease, 'writer', 'owner.json'),
    JSON.stringify({ token: 'dead-owner', pid: 2_147_483_647, childPid: null }),
  );
  await withBuildOutputLease(root, async () => {}, { timeoutMs: 1000, pollMs: 5 });
});
