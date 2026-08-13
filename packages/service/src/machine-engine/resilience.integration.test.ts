import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../service.js';

let machine: RunningService;
let userA: RunningService;
let userB: RunningService;
let root: string;
let machineHome: string;
let externalA: string;
let externalB: string;

const priorMock = process.env.GEZEL_MOCK_PROVIDER;
const priorSecrets = process.env.GEZEL_SECRETS_BACKEND;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  process.env.GEZEL_SECRETS_BACKEND = 'file';
  root = await mkdtemp(join(tmpdir(), 'gezel-machine-resilience-'));
  machineHome = join(root, 'machine');
  externalA = join(root, 'external-a');
  externalB = join(root, 'external-b');
  await Promise.all([
    mkdtemp(`${machineHome}-`),
    mkdtemp(`${externalA}-`),
    mkdtemp(`${externalB}-`),
  ]).then(([actualMachine, actualA, actualB]) => {
    machineHome = actualMachine;
    externalA = actualA;
    externalB = actualB;
  });
  await Promise.all([chmod(externalA, 0o700), chmod(externalB, 0o700)]);

  machine = await startService({ home: machineHome, role: 'machine-engine' });
  userA = await startService({
    home: join(root, 'user-a'),
    role: 'user',
    machineEngineHome: machineHome,
  });
  userB = await startService({
    home: join(root, 'user-b'),
    role: 'user',
    machineEngineHome: machineHome,
  });
}, 90_000);

afterAll(async () => {
  await Promise.all([userA?.stop(), userB?.stop()]);
  await machine?.stop();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  await Promise.all([
    rm(machineHome, { recursive: true, force: true }).catch(() => undefined),
    rm(externalA, { recursive: true, force: true }).catch(() => undefined),
    rm(externalB, { recursive: true, force: true }).catch(() => undefined),
  ]);
  if (priorMock === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMock;
  if (priorSecrets === undefined) delete process.env.GEZEL_SECRETS_BACKEND;
  else process.env.GEZEL_SECRETS_BACKEND = priorSecrets;
}, 45_000);

function api(service: RunningService, path: string, init: RequestInit = {}): Promise<Response> {
  const baseUrl = `${service.cert ? 'https' : 'http'}://127.0.0.1:${service.port}`;
  const fetchImpl = service.cert ? createTrustingFetch({ cert: service.cert.certPem }) : fetch;
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${service.clientToken}`);
  if (init.body) headers.set('content-type', 'application/json');
  return fetchImpl(`${baseUrl}${path}`, { ...init, headers });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function createExternalProject(
  service: RunningService,
  name: string,
  workingDir: string,
): Promise<string> {
  const created = await api(service, '/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name, mode: 'solo', indexingEnabled: false }),
  });
  expect(created.status).toBe(201);
  const project = (await created.json()) as { id: string };
  const updated = await api(service, `/api/projects/${project.id}`, {
    method: 'PUT',
    body: JSON.stringify({ workingDir, managedWorkspaceWritePolicy: 'allow' }),
  });
  expect(updated.status).toBe(200);
  return project.id;
}

describe('machine engine resilience and user isolation', () => {
  it('lets two user daemons share compute without sharing project state', async () => {
    expect(userA.context.machineEngine?.isConnected()).toBe(true);
    expect(userB.context.machineEngine?.isConnected()).toBe(true);

    const projectA = await createExternalProject(userA, 'Account A project', externalA);
    const projectB = await createExternalProject(userB, 'Account B project', externalB);
    const [writeA, writeB] = await Promise.all([
      api(userA, `/api/projects/${projectA}/workspace/file`, {
        method: 'PUT',
        body: JSON.stringify({ path: 'owned-by-a.txt', content: 'alpha' }),
      }),
      api(userB, `/api/projects/${projectB}/workspace/file`, {
        method: 'PUT',
        body: JSON.stringify({ path: 'owned-by-b.txt', content: 'bravo' }),
      }),
    ]);
    expect(writeA.status).toBe(200);
    expect(writeB.status).toBe(200);
    await expect(readFile(join(externalA, 'owned-by-a.txt'), 'utf8')).resolves.toBe('alpha');
    await expect(readFile(join(externalB, 'owned-by-b.txt'), 'utf8')).resolves.toBe('bravo');

    const projectsA = await api(userA, '/api/projects');
    const projectsB = await api(userB, '/api/projects');
    const projectsAText = await projectsA.text();
    const projectsBText = await projectsB.text();
    expect(projectsAText).toContain('Account A project');
    expect(projectsAText).not.toContain('Account B project');
    expect(projectsBText).toContain('Account B project');
    expect(projectsBText).not.toContain('Account A project');
  });

  it('keeps product data online and recovers both users across broker credential rotation', async () => {
    const before = userA.context.remotes.get('this-machine');
    expect(before).not.toBeNull();
    await machine.stop();

    await waitFor(() => !userA.context.machineEngine?.isConnected(), 20_000);
    expect((await api(userA, '/api/projects')).status).toBe(200);
    const unavailable = await api(userA, '/api/engines/status');
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      error: 'machine_engine_unavailable',
    });

    machine = await startService({ home: machineHome, role: 'machine-engine' });
    await waitFor(
      () =>
        Boolean(userA.context.machineEngine?.isConnected()) &&
        Boolean(userB.context.machineEngine?.isConnected()) &&
        userA.context.remotes.get('this-machine')?.token !== before?.token,
      20_000,
    );

    expect((await api(userA, '/api/engines/status')).status).toBe(200);
    expect((await api(userB, '/api/engines/status')).status).toBe(200);
  }, 45_000);
});
