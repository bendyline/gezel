import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiAppDetail, ImportAiAppResult, ListAiAppsResponse } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { aiAppsRegistryFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GEZAPP_MAX_ARCHIVE_BYTES, packGezapp } from '../../project-type/gezapp.js';
import { type RunningService, startService } from '../../service.js';
import type { ServiceContext } from '../context.js';
import { aiAppRoutes } from './ai-apps.js';

/**
 * Wire contract for the global AI App management surface. The engine itself
 * is covered in project-type/gezapp.test.ts; what's pinned here is the raw
 * octet-stream import (preview vs confirm), the registry lifecycle over
 * HTTP, and the auth boundary (bearer required; session tokens denied).
 */

let svc: RunningService;
let home: string;
let httpFetch: typeof fetch;
let baseUrl: string;
let fixture: Buffer;
let fixtureVersion: string;

const priorSkipFlag = process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP;

beforeEach(async () => {
  process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP = '1';
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-ai-apps-route-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  const packed = await packGezapp({ catalog: new CatalogService() }, { typeId: 'just-chat' });
  fixture = packed.buffer;
  fixtureVersion = packed.manifest.entry.version;
}, 30_000);

afterEach(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorSkipFlag === undefined) delete process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP;
  else process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP = priorSkipFlag;
  delete process.env.GEZEL_MOCK_PROVIDER;
}, 30_000);

function auth(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${svc.context.token}`, ...(extra ?? {}) };
}

async function importFixture(confirm: boolean): Promise<ImportAiAppResult> {
  const res = await httpFetch(`${baseUrl}/api/ai-apps/import${confirm ? '?confirm=1' : ''}`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/octet-stream' }),
    body: new Uint8Array(fixture),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ImportAiAppResult;
}

describe('/api/ai-apps auth boundary', () => {
  it('requires a bearer token', async () => {
    const res = await httpFetch(`${baseUrl}/api/ai-apps`);
    expect(res.status).toBe(401);
  });

  it('denies session-scoped tokens', async () => {
    const record = svc.context.tokenStore.issueSession({
      appId: 'session:ai-apps-test',
      projectId: 'default',
      gezelId: 'some-gezel',
      team: false,
    });
    const res = await httpFetch(`${baseUrl}/api/ai-apps`, {
      headers: { Authorization: `Bearer ${record.token}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('import + lifecycle over HTTP', () => {
  it('previews without touching disk, then installs, lists, and re-registers idempotently', async () => {
    const preview = await importFixture(false);
    expect(preview.installed).toBeUndefined();
    expect(preview.previous).toBeUndefined();
    expect(preview.manifest.entry.projectType).toBe('just-chat');
    expect(existsSync(aiAppsRegistryFile(home))).toBe(false);

    const installed = await importFixture(true);
    expect(installed.installed).toMatchObject({
      appId: 'just-chat',
      version: fixtureVersion,
      alreadyPresent: false,
    });

    const list = (await (
      await httpFetch(`${baseUrl}/api/ai-apps`, { headers: auth() })
    ).json()) as ListAiAppsResponse;
    expect(list.apps).toHaveLength(1);
    expect(list.apps[0]).toMatchObject({
      appId: 'just-chat',
      version: fixtureVersion,
      enabled: true,
      itemCount: preview.items.length,
      versionsOnDisk: [fixtureVersion],
    });
    expect(list.apps[0]?.name).not.toBeNull();

    const again = await importFixture(true);
    expect(again.installed?.alreadyPresent).toBe(true);
    expect(again.previous).toEqual({ version: fixtureVersion, enabled: true });
  });

  it('rejects an empty body', async () => {
    const res = await httpFetch(`${baseUrl}/api/ai-apps/import`, {
      method: 'POST',
      headers: auth({ 'content-type': 'application/octet-stream' }),
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(400);
  });

  it('serves detail with a live dependency check, and 404s unknown apps', async () => {
    await importFixture(true);
    const res = await httpFetch(`${baseUrl}/api/ai-apps/just-chat`, { headers: auth() });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as AiAppDetail;
    expect(detail.manifest?.entry.projectType).toBe('just-chat');
    expect(detail.missingDependencies).toEqual([]);
    expect(detail.appliedProjects).toEqual([]);

    const missing = await httpFetch(`${baseUrl}/api/ai-apps/nope`, { headers: auth() });
    expect(missing.status).toBe(404);
  });

  it('toggles enabled over PATCH and 404s unknown apps', async () => {
    await importFixture(true);
    const res = await httpFetch(`${baseUrl}/api/ai-apps/just-chat`, {
      method: 'PATCH',
      headers: auth({ 'content-type': 'application/json' }),
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const { entry } = (await res.json()) as { entry: { enabled: boolean } };
    expect(entry.enabled).toBe(false);

    const list = (await (
      await httpFetch(`${baseUrl}/api/ai-apps`, { headers: auth() })
    ).json()) as ListAiAppsResponse;
    expect(list.apps[0]?.enabled).toBe(false);

    const missing = await httpFetch(`${baseUrl}/api/ai-apps/nope`, {
      method: 'PATCH',
      headers: auth({ 'content-type': 'application/json' }),
      body: JSON.stringify({ enabled: true }),
    });
    expect(missing.status).toBe(404);
  });

  it('uninstalls over DELETE and 404s unknown apps', async () => {
    await importFixture(true);
    const res = await httpFetch(`${baseUrl}/api/ai-apps/just-chat`, {
      method: 'DELETE',
      headers: auth(),
    });
    expect(res.status).toBe(200);
    const removed = (await res.json()) as {
      appId: string;
      removedVersions: string[];
      keptVersions: string[];
    };
    expect(removed).toMatchObject({
      appId: 'just-chat',
      removedVersions: [fixtureVersion],
      keptVersions: [],
    });

    const list = (await (
      await httpFetch(`${baseUrl}/api/ai-apps`, { headers: auth() })
    ).json()) as ListAiAppsResponse;
    expect(list.apps).toEqual([]);

    const missing = await httpFetch(`${baseUrl}/api/ai-apps/just-chat`, {
      method: 'DELETE',
      headers: auth(),
    });
    expect(missing.status).toBe(404);
  });
});

describe('import size guard (route unit)', () => {
  it('413s on an oversize declared content-length before reading the body', async () => {
    const ctx = {
      home: '/nonexistent',
      catalog: new CatalogService([]),
      chat: {
        resetClient: async () => {
          throw new Error('must not reset on a refused import');
        },
      },
      history: {
        log: async () => {
          throw new Error('must not log on a refused import');
        },
      },
      store: { listProjects: async () => [] },
    } as unknown as ServiceContext;
    const app = aiAppRoutes(ctx);
    const res = await app.request('/import', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(GEZAPP_MAX_ARCHIVE_BYTES + 1),
      },
      body: new Uint8Array(4),
    });
    expect(res.status).toBe(413);
  });
});
