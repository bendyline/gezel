import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptNotFoundError } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { PortableProductService, type PortableScripts } from '@bendyline/gezel/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../service.js';
import { portableStoreOverHome } from '../test-support/portable-node-files.js';

/**
 * The same client calls, against the desktop daemon and the portable
 * runtime, must get the same status codes and the same reply shapes. This is
 * what keeps the two route layers from drifting apart, one 200-versus-201 at
 * a time.
 */
interface Observed {
  name: string;
  status: number;
  keys: string[];
}
interface Scenario {
  name: string;
  method: string;
  path: string;
  body?: unknown;
}

const scenarios = (projectId: string): Scenario[] => {
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const source = "export const meta = { name: 'parity', description: 'Parity check' };\n";
  return [
    { name: 'list', method: 'GET', path: `${base}/scripts` },
    { name: 'create', method: 'POST', path: `${base}/scripts`, body: { name: 'parity', source } },
    {
      name: 'create again',
      method: 'POST',
      path: `${base}/scripts`,
      body: { name: 'parity', source },
    },
    { name: 'invalid create', method: 'POST', path: `${base}/scripts`, body: {} },
    { name: 'get source', method: 'GET', path: `${base}/scripts/source?name=parity` },
    { name: 'get missing', method: 'GET', path: `${base}/scripts/source?name=nope` },
    {
      name: 'save',
      method: 'PUT',
      path: `${base}/scripts/source`,
      body: { name: 'parity', source },
    },
    {
      name: 'stale save',
      method: 'PUT',
      path: `${base}/scripts/source`,
      body: { name: 'parity', source, baseHash: 'stale' },
    },
    { name: 'run unknown', method: 'POST', path: `${base}/scripts/run`, body: { name: 'nope' } },
    { name: 'run record unknown', method: 'GET', path: `${base}/script-runs/nope` },
    { name: 'delete', method: 'DELETE', path: `${base}/scripts/source?name=parity` },
    { name: 'delete again', method: 'DELETE', path: `${base}/scripts/source?name=parity` },
  ];
};

async function observe(
  call: (method: string, path: string, body?: unknown) => Promise<Response>,
  projectId: string,
): Promise<Observed[]> {
  const out: Observed[] = [];
  for (const scenario of scenarios(projectId)) {
    const response = await call(scenario.method, scenario.path, scenario.body);
    let keys: string[] = [];
    try {
      const parsed = (await response.json()) as Record<string, unknown>;
      keys = Object.keys(parsed).sort();
    } catch {
      keys = ['(not json)'];
    }
    out.push({ name: scenario.name, status: response.status, keys });
  }
  return out;
}

let svc: RunningService;
let desktopHome: string;
let portableHome: string;
const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  desktopHome = await mkdtemp(join(tmpdir(), 'gezel-parity-desktop-'));
  portableHome = await mkdtemp(join(tmpdir(), 'gezel-parity-portable-'));
  svc = await startService({ home: desktopHome });
}, 30_000);
afterAll(async () => {
  await svc.stop();
  await rm(desktopHome, { recursive: true, force: true }).catch(() => {});
  await rm(portableHome, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

describe('script routes agree across hosts', () => {
  it('returns the same status and reply shape for the same calls', async () => {
    const scheme = svc.cert ? 'https' : 'http';
    const baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
    const httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
    const desktopCall = (method: string, path: string, body?: unknown) =>
      httpFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${svc.context.token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    const created = await desktopCall('POST', '/api/projects', { name: 'Parity' });
    const desktopProject = ((await created.json()) as { id: string }).id;

    const store = portableStoreOverHome(portableHome);
    const service = new PortableProductService(
      store,
      {
        providers: async () => [],
        generate: async () => {
          throw new Error('Unexpected inference');
        },
        cancel: async () => {},
      },
      'token',
    );
    const scripts: PortableScripts = {
      list: () => [],
      source: async () => {
        throw new Error('Standard script not found');
      },
      initialize: async () => {},
      isBusy: () => false,
      cancel: async () => {},
      run: async (options) => {
        throw new ScriptNotFoundError(options.scriptName, options.scope ?? 'project');
      },
      authoring: {
        scaffold: async (name) => `export const meta = { name: '${name}' };`,
        sdkTypes: () => ({ version: 'test', files: [] }),
        inspect: async (source, name) => ({
          meta: { name, description: 'Parity check' },
          diagnostics: [],
        }),
      },
    };
    service.setScripts(scripts);
    await service.initialize();
    const portableCall = (method: string, path: string, body?: unknown) =>
      service.fetch(`https://gezel.local${path}`, {
        method,
        headers: {
          Authorization: 'Bearer token',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    const portableCreated = await portableCall('POST', '/api/projects', { name: 'Parity' });
    const portableProject = ((await portableCreated.json()) as { id: string }).id;

    const desktop = await observe(desktopCall, desktopProject);
    const portable = await observe(portableCall, portableProject);
    expect(portable).toEqual(desktop);
  }, 30_000);
});
