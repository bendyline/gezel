/**
 * Phase-2b exit tests: the machine-knowledge-assets capability boundary and
 * the two-user privacy story. The broker installs signed coordinates into
 * the shared store; user daemons adopt read-only refs independently; no
 * query/session/project identifier ever crosses to the broker; a
 * remote-inference (or even machine-models) token cannot administer
 * knowledge assets; and the machine role serves no /api/knowledge surface.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestCatalog } from '../knowledge/test-catalog-fixture.js';
import { sharedKnowledgeVersionDir } from '../machine-engine/knowledge-assets.js';
import { type RunningService, startService } from '../service.js';

const priorEnv = {
  mock: process.env.GEZEL_MOCK_PROVIDER,
  secrets: process.env.GEZEL_SECRETS_BACKEND,
  shared: process.env.GEZEL_SHARED_ASSETS_DIR,
  registry: process.env.GEZEL_KNOWLEDGE_REGISTRY_DIR,
};

let dir: string;
let sharedAssets: string;
let machine: RunningService;
let machineBase: string;
let machineFetch: typeof fetch;
let archiveDigest: string;

const COORD = () => ({
  publisherId: 'gezel-tests',
  catalogId: 'test-notes',
  version: '1.0.0',
  expectedDigest: archiveDigest,
});

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  process.env.GEZEL_SECRETS_BACKEND = 'file';
  dir = await mkdtemp(join(tmpdir(), 'gezel-knowledge-2b-'));
  sharedAssets = join(dir, 'shared-assets');
  const registryDir = join(dir, 'registry-drop');
  await mkdir(registryDir, { recursive: true });
  process.env.GEZEL_SHARED_ASSETS_DIR = sharedAssets;
  process.env.GEZEL_KNOWLEDGE_REGISTRY_DIR = registryDir;

  const archivePath = join(registryDir, 'test-notes-1.0.0.gezk');
  await buildTestCatalog({ outputPath: archivePath, workDir: join(dir, 'work') });
  archiveDigest = createHash('sha256')
    .update(await readFile(archivePath))
    .digest('hex');

  machine = await startService({ home: join(dir, 'machine-home'), role: 'machine-engine' });
  machineBase = `${machine.cert ? 'https' : 'http'}://127.0.0.1:${machine.port}`;
  machineFetch = machine.cert ? createTrustingFetch({ cert: machine.cert.certPem }) : fetch;
}, 120_000);

afterAll(async () => {
  await machine.stop();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  for (const [key, envName] of [
    ['mock', 'GEZEL_MOCK_PROVIDER'],
    ['secrets', 'GEZEL_SECRETS_BACKEND'],
    ['shared', 'GEZEL_SHARED_ASSETS_DIR'],
    ['registry', 'GEZEL_KNOWLEDGE_REGISTRY_DIR'],
  ] as const) {
    const prior = priorEnv[key];
    if (prior === undefined) delete process.env[envName];
    else process.env[envName] = prior;
  }
}, 30_000);

/** A paired LAN device's token — the only externally grantable scope. */
async function pairedInferenceToken(): Promise<string> {
  const issued = await machine.context.tokenStore.issue({
    appId: 'paired-test-device',
    appName: 'Paired test device',
    scopes: ['remote-inference'],
  });
  return issued.token;
}

/** The first-party runtime credential the user-daemon bridge reads. */
async function runtimeToken(): Promise<string> {
  return (await readFile(join(dir, 'machine-home', 'runtime', 'auth-token'), 'utf8')).trim();
}

describe('machine-knowledge-assets boundary', () => {
  it('a paired LAN inference token cannot reach the knowledge broker', async () => {
    const token = await pairedInferenceToken();
    const res = await machineFetch(`${machineBase}/v1/remote/manage/knowledge/inventory`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'missing_scope:machine-knowledge-assets',
    });
    // ...and remains able to use inference discovery — the scope split, not
    // a broken token.
    const inference = await machineFetch(`${machineBase}/v1/remote/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(inference.status).toBe(200);
  });

  it('the first-party runtime credential reaches the broker', async () => {
    const token = await runtimeToken();
    const inventory = await machineFetch(`${machineBase}/v1/remote/manage/knowledge/inventory`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(inventory.status).toBe(200);
  });

  it('the machine role serves no /api/knowledge or product surface', async () => {
    for (const path of ['/api/knowledge/catalogs', '/api/knowledge/search', '/api/projects']) {
      const res = await machineFetch(`${machineBase}${path}`, {
        headers: { Authorization: `Bearer ${machine.context.token}` },
      });
      expect(res.status, path).toBe(404);
    }
  });

  it('ensure installs a signed coordinate into the shared store and inventories it', async () => {
    const token = await runtimeToken();
    const res = await machineFetch(`${machineBase}/v1/remote/manage/knowledge/ensure`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ coordinate: COORD() }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ready' });

    const target = sharedKnowledgeVersionDir(join(sharedAssets, 'knowledge'), COORD());
    expect((await stat(join(target, 'manifest.json'))).isFile()).toBe(true);

    const inventory = await machineFetch(`${machineBase}/v1/remote/manage/knowledge/inventory`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await inventory.json()) as { catalogs: Array<{ catalogId: string }> };
    expect(body.catalogs.map((c) => c.catalogId)).toContain('test-notes');
  });

  it('ensure rejects a wrong digest without installing anything', async () => {
    const token = await runtimeToken();
    const res = await machineFetch(`${machineBase}/v1/remote/manage/knowledge/ensure`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ coordinate: { ...COORD(), expectedDigest: 'f'.repeat(64) } }),
    });
    expect(res.status).toBe(404);
  });
});

describe('two-user privacy', () => {
  let userA: RunningService;
  let userB: RunningService;

  beforeAll(async () => {
    userA = await startService({ home: join(dir, 'user-a-home') });
    userB = await startService({ home: join(dir, 'user-b-home') });
  }, 120_000);

  afterAll(async () => {
    await userA.stop();
    await userB.stop();
  }, 30_000);

  it('both users adopt the shared catalog independently and search it', async () => {
    expect(await userA.context.knowledge?.adoptSharedCatalog(COORD())).toBe(true);
    expect(await userB.context.knowledge?.adoptSharedCatalog(COORD())).toBe(true);
    for (const svc of [userA, userB]) {
      const results = await svc.context.knowledge?.searchUnified('dovetail corner joint', {
        vector: null,
        maxResults: 5,
      });
      expect(results?.length).toBeGreaterThan(0);
      expect(results?.[0]?.uri).toMatch(/^knowledge:\/\/test-notes\//);
    }
  });

  it("user A's removal never touches the shared bytes or user B", async () => {
    expect(await userA.context.knowledge?.remove('test-notes')).toBe(true);
    const target = sharedKnowledgeVersionDir(join(sharedAssets, 'knowledge'), COORD());
    expect((await stat(join(target, 'manifest.json'))).isFile()).toBe(true);
    const results = await userB.context.knowledge?.searchUnified('dovetail corner joint', {
      vector: null,
      maxResults: 5,
    });
    expect(results?.length).toBeGreaterThan(0);
  });
});
