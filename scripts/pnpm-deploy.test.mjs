import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { localReleaseLinks, pnpmDeployArgs, runIsolatedPnpmDeploy } from './pnpm-deploy.mjs';

test('reports local gilde and squisq links without changing workspace config', () => {
  assert.deepEqual(
    localReleaseLinks(`overrides:
  "@bendyline/gilde": "link:../gilde"
  '@bendyline/squisq': 'link:../squisq/packages/core'
  "@bendyline/squisq-video": "2.2.11"
  "sharp": "workspace:0.35.3"
`),
    ['@bendyline/gilde', '@bendyline/squisq'],
  );
});

test('deploy arguments select the dedicated-lockfile implementation', () => {
  const args = pnpmDeployArgs({
    filter: '@bendyline/gezel-service',
    target: 'C:\\tmp\\bundle',
  });
  assert.ok(args.includes('--config.inject-workspace-packages=true'));
  assert.ok(args.includes('--node-linker=hoisted'));
  assert.equal(args.includes('--legacy'), false);
  assert.equal(
    args.some((arg) => arg.startsWith('--config.overrides=')),
    false,
  );
});

test('isolated deploy reads config without editing it and runs under the mutation lock', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gezel-pnpm-deploy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const workspace = 'overrides:\n  "@bendyline/gilde": "link:../gilde"\n';
  await writeFile(join(root, 'pnpm-workspace.yaml'), workspace);
  const calls = [];
  const execPnpmFn = async (args) => {
    calls.push(args);
    return { stdout: '', stderr: '' };
  };

  await runIsolatedPnpmDeploy({
    repoRoot: root,
    filter: '@bendyline/gezel-service',
    target: join(root, 'bundle'),
    label: 'test-deploy',
    execPnpmFn,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes('--legacy'), false);
  assert.equal(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'), workspace);
});
