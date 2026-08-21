import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  localReleaseLinks,
  pnpmDeployArgs,
  registryOverridesForLinks,
  runIsolatedPnpmDeploy,
  workspaceOverrides,
} from './pnpm-deploy.mjs';

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

test('linked development packages select exact registry overrides for legacy deploy', () => {
  const args = pnpmDeployArgs({
    filter: '@bendyline/gezel-service',
    target: '/tmp/bundle',
    releaseOverrides: { '@bendyline/gilde': '0.1.36' },
  });
  assert.ok(args.includes('--legacy'));
  assert.ok(args.includes('--config.overrides={"@bendyline/gilde":"0.1.36"}'));
});

test('reads workspace overrides without including adjacent configuration', () => {
  assert.deepEqual(
    workspaceOverrides(`overrides:
  # An ordinary registry pin.
  "sharp": "workspace:0.35.3"
  '@bendyline/gilde': 'link:../gilde'

patchedDependencies:
  "sharp@0.35.3": "patches/sharp.patch"
`),
    {
      sharp: 'workspace:0.35.3',
      '@bendyline/gilde': 'link:../gilde',
    },
  );
});

test('discovers the exact registry version hidden behind a local link', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gezel-pnpm-deploy-pins-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'packages', 'catalog'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'catalog', 'package.json'),
    JSON.stringify({ dependencies: { '@bendyline/gilde': '0.1.36' } }),
  );
  assert.deepEqual(await registryOverridesForLinks(root, ['@bendyline/gilde']), {
    '@bendyline/gilde': '0.1.36',
  });
});

test('linked deploy reads config without editing it and uses the registry fallback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gezel-pnpm-deploy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'packages', 'catalog'), { recursive: true });
  const workspace =
    'overrides:\n  "sharp": "workspace:0.35.3"\n  "@bendyline/gilde": "link:../gilde"\n';
  await writeFile(join(root, 'pnpm-workspace.yaml'), workspace);
  await mkdir(join(root, 'node_modules'), { recursive: true });
  const workspaceStatePath = join(root, 'node_modules', '.pnpm-workspace-state-v1.json');
  const workspaceState = '{"settings":{"production":false}}\n';
  await writeFile(workspaceStatePath, workspaceState);
  await writeFile(
    join(root, 'packages', 'catalog', 'package.json'),
    JSON.stringify({ dependencies: { '@bendyline/gilde': '0.1.36' } }),
  );
  const calls = [];
  const execPnpmFn = async (args, options) => {
    calls.push({ args, options });
    await writeFile(workspaceStatePath, '{"settings":{"production":true}}\n');
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
  assert.equal(calls[0].args.includes('--legacy'), true);
  assert.ok(
    calls[0].args.includes(
      '--config.overrides={"sharp":"workspace:0.35.3","@bendyline/gilde":"0.1.36"}',
    ),
  );
  assert.equal(calls[0].options.env.GEZEL_SERIALIZED_PNPM_INSTALL, '1');
  assert.equal(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'), workspace);
  assert.equal(await readFile(workspaceStatePath, 'utf8'), workspaceState);
});

test('dedicated deploy can ignore links outside the target dependency graph', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gezel-pnpm-deploy-ignore-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = 'overrides:\n  "@bendyline/gilde": "link:../gilde"\n';
  await writeFile(join(root, 'pnpm-workspace.yaml'), workspace);
  const calls = [];

  await runIsolatedPnpmDeploy({
    repoRoot: root,
    filter: '@bendyline/internal-ml-runtime',
    target: join(root, 'bundle'),
    label: 'test-deploy',
    ignoreLocalReleaseLinks: true,
    execPnpmFn: async (args, options) => {
      calls.push({ args, options });
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes('--legacy'), false);
  assert.equal(calls[0].options.env.GEZEL_SERIALIZED_PNPM_INSTALL, undefined);
  assert.equal(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'), workspace);
});
