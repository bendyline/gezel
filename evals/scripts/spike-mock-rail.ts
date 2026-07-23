/**
 * M1 spike — proves the live mock-service rail end to end on this
 * machine, deterministically, with no model:
 *
 *   1. `startMockServices` boots the ship book's fake GitHub/CI on
 *      loopback HTTPS with a per-trial self-signed cert.
 *   2. A real `gezeld` is spawned with `NODE_EXTRA_CA_CERTS` (daemon
 *      trusts the cert) and `GEZEL_SEED_SECRETS_FILE` (mock.github /
 *      mock.ci credentials seeded at boot).
 *   3. The trial project grants those credentials with the mock's exact
 *      origin, the ship `test.json` cli shim installs as a provenance-
 *      trusted project script, and `runProjectScript` executes it: the
 *      sandbox child starts on Windows via the catalog-shipped-shim
 *      provenance lane, and its `gezel.http.authed` calls travel the
 *      REAL dispatcher → credential → origin-check → TLS path into the
 *      mock.
 *   4. Assertions: script output carries both raw responses; the mock
 *      request logs show the authorized POST + GET; an unauthenticated
 *      direct probe gets 401.
 *
 * Run: pnpm --filter @bendyline/gezel-evals exec tsx scripts/spike-mock-rail.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CRAFTBOOK_TEST_FILENAME } from '@bendyline/gezel';
import { discoverOrSpawn, resolveDaemonEntry } from '@bendyline/gezel-client/node';
import { loadCraftbookTestSpecsSync } from '../src/craftbooks/test-spec-loader.ts';
import { startMockServices } from '../src/mock/mock-server.ts';

async function main(): Promise<void> {
  const ship = loadCraftbookTestSpecsSync().find((entry) => entry.craftbookId === 'ship');
  if (!ship) throw new Error(`ship ${CRAFTBOOK_TEST_FILENAME} not found`);
  const shim = ship.spec.mocks.find((mock) => mock.kind === 'cli');
  if (!shim || shim.kind !== 'cli') throw new Error('ship spec has no cli shim');

  const runtime = await startMockServices(ship.spec.mocks);
  if (!runtime) throw new Error('no live mock services in the ship spec');
  const home = await mkdtemp(join(tmpdir(), 'gezel-mock-spike-'));
  const caPath = join(home, 'mock-ca.pem');
  const seedPath = join(home, 'mock-seed.json');
  await writeFile(caPath, runtime.caPem, 'utf8');
  await writeFile(seedPath, JSON.stringify(runtime.seedEntries()), 'utf8');

  let child: { kill(signal: string): void; exitCode: number | null } | undefined;
  try {
    const spawned = await discoverOrSpawn({
      daemonEntry: resolveDaemonEntry(import.meta.url),
      detached: false,
      stdio: 'pipe',
      home,
      env: {
        ...process.env,
        GEZEL_HOME: home,
        GEZEL_MOCK_PROVIDER: '1',
        GEZEL_PORT: '0',
        NODE_EXTRA_CA_CERTS: caPath,
        GEZEL_SEED_SECRETS_FILE: seedPath,
      },
      timeoutMs: 20_000,
    });
    child = spawned.child ?? undefined;
    const client = spawned.client;

    // Scripts need the `network` capability for http.authed; the default
    // lockdown posture strips it. The trial home is isolated and mock-only,
    // so the free posture is the correct eval-scoped setting.
    await client.updateConfig({
      securityPolicy: {
        level: 'free',
        allowFileEdits: true,
        allowExternalChat: true,
        allowExternalServices: true,
        allowScriptExecution: true,
        allowAppNetwork: true,
      },
    });

    const project = await client.createProject({ name: 'Mock Rail Spike' });
    const grants = runtime.projectGrants();
    await client.updateProject(project.id, grants);
    console.log(`[spike] granted ${grants.grantedCredentials.join(', ')}`);

    // Seed discovery doc + install the shim as a provenance-trusted
    // project script (header + catalog-shipped bytes).
    const workspaceDir = join(home, 'projects', project.id, 'workspace', 'mocks');
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, 'services.json'), runtime.servicesJson(), 'utf8');
    const scriptsDir = join(home, 'projects', project.id, 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    const header = `// @gezel-craftbook-test: ship@${ship.version}`;
    await writeFile(
      join(scriptsDir, 'ship-mock-probe.ts'),
      `${header}\n${shim.shim.content}`,
      'utf8',
    );

    const run = await client.runProjectScript(project.id, { name: 'ship-mock-probe' });
    console.log(`[spike] script status=${run.status}`);
    if (run.status !== 'ok') {
      throw new Error(`ship-mock-probe failed: ${JSON.stringify(run, null, 2).slice(0, 2000)}`);
    }
    const output = run.output as { pr?: string; ci?: string } | undefined;
    if (!output?.pr?.includes('"number":42') && !output?.pr?.includes('"number": 42')) {
      throw new Error(`unexpected PR output: ${output?.pr}`);
    }
    if (!output?.ci?.includes('success')) {
      throw new Error(`unexpected CI output: ${output?.ci}`);
    }

    const github = runtime.services.get('github')!;
    const ci = runtime.services.get('ci')!;
    const authedPost = github.requests.filter(
      (entry) => entry.authorized && entry.method === 'POST',
    );
    const authedPoll = ci.requests.filter((entry) => entry.authorized && entry.method === 'GET');
    if (authedPost.length < 1) throw new Error('fake GitHub never saw the authorized POST');
    if (authedPoll.length < 1) throw new Error('fake CI never saw the authorized poll');

    // Negative control: an unauthenticated call must 401. (This probe
    // disables TLS verification — the assertion is AUTH, not trust; the
    // daemon-side calls above already proved the trust chain.)
    const { request } = await import('node:https');
    const bareStatus = await new Promise<number>((resolvePromise, rejectPromise) => {
      const req = request(
        `${github.baseUrl}/repos/co-op/returns-desk/pulls/42`,
        { rejectUnauthorized: false },
        (res) => {
          res.resume();
          resolvePromise(res.statusCode ?? 0);
        },
      );
      req.on('error', rejectPromise);
      req.end();
    });
    if (bareStatus !== 401) throw new Error(`unauthenticated probe got ${bareStatus}, want 401`);

    console.log('[spike] PASS — TLS trust, secret seeding, origin grant, provenance-trusted shim,');
    console.log('        dispatcher http.authed round-trips, and 401 on missing credential.');
    console.log(`[spike] github log: ${JSON.stringify(github.requests)}`);
    console.log(`[spike] ci log: ${JSON.stringify(ci.requests)}`);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await runtime.close();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('[spike] FAIL:', err);
  process.exit(1);
});
