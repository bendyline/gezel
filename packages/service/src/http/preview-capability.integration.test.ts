import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../service.js';

let svc: RunningService;
let home: string;
let httpFetch: typeof fetch;
let baseUrl: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-preview-capability-'));
  process.env.GEZEL_MOCK_PROVIDER = '1';
  svc = await startService({ home });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  await svc.context.store.writeProjectWorkspaceFile(
    'default',
    'site/index.html',
    '<!doctype html><head><script src="app.js"></script></head><body>CAP PREVIEW</body>',
  );
  await svc.context.store.writeProjectWorkspaceFile('default', 'site/app.js', 'window.ok = true;');
  await svc.context.store.writeProjectWorkspaceFile('default', 'secret.txt', 'OUT OF SCOPE');
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true });
  delete process.env.GEZEL_MOCK_PROVIDER;
}, 30_000);

function mint(
  token?: string,
  body: { source: 'workspace' | 'artifacts' | 'type'; path: string } = {
    source: 'workspace',
    path: 'site/index.html',
  },
): Promise<Response> {
  return httpFetch(`${baseUrl}/api/projects/default/preview-capability`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('preview capabilities (integration)', () => {
  it('mints only for first-party callers and gates every preview resource', async () => {
    expect((await mint()).status).toBe(401);

    const appToken = await svc.context.tokenStore.issue({
      appId: 'preview-openai-app',
      appName: 'Preview OpenAI app',
      scopes: ['openai'],
    });
    expect((await mint(appToken.token)).status).toBe(403);

    const deviceToken = await svc.context.tokenStore.issue({
      appId: 'preview-device',
      appName: 'Preview device',
      scopes: ['remote-inference'],
      kind: 'device',
    });
    expect((await mint(deviceToken.token)).status).toBe(403);

    const sessionToken = svc.context.tokenStore.issueSession({
      appId: 'session:preview-worker',
      projectId: 'default',
      gezelId: 'worker',
      team: false,
    });
    expect((await mint(sessionToken.token)).status).toBe(403);

    const minted = await mint(svc.clientToken);
    expect(minted.status).toBe(201);
    const lease = (await minted.json()) as {
      url: string;
      expiresAt: string;
      scopePath: string;
    };
    expect(lease.scopePath).toBe('site');
    expect(lease.url).toMatch(
      /^\/preview\/[A-Za-z0-9_-]{43}\/workspace\/default\/site\/index\.html$/,
    );
    expect(lease.url).not.toContain(svc.clientToken);
    expect(lease.url).not.toContain(svc.context.token);

    // The legacy unauthenticated shape must not read anything.
    expect((await httpFetch(`${baseUrl}/preview/workspace/default/site/index.html`)).status).toBe(
      401,
    );
    expect(
      (
        await httpFetch(
          `${baseUrl}/preview/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/workspace/default/site/index.html`,
        )
      ).status,
    ).toBe(401);

    const page = await httpFetch(`${baseUrl}${lease.url}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('CAP PREVIEW');
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).not.toContain('https:');
    expect(page.headers.get('access-control-allow-origin')).toBe('null');

    const base = lease.url.slice(0, lease.url.lastIndexOf('/') + 1);
    expect((await httpFetch(`${baseUrl}${base}app.js`)).status).toBe(200);
    expect((await httpFetch(`${baseUrl}${base}../secret.txt`)).status).toBe(403);

    const wrongProject = lease.url.replace('/workspace/default/', '/workspace/foreign/');
    expect((await httpFetch(`${baseUrl}${wrongProject}`)).status).toBe(403);
    const wrongSource = lease.url.replace('/workspace/default/', '/artifacts/default/');
    expect((await httpFetch(`${baseUrl}${wrongSource}`)).status).toBe(403);

    // Project-type pages get only their catalog-declared cross-source reads.
    const languageType = await svc.context.catalog.get('project-type', 'language-trainer');
    expect(languageType?.manifest.kind).toBe('project-type');
    if (!languageType || languageType.manifest.kind !== 'project-type') {
      throw new Error('language-trainer fixture missing');
    }
    await svc.context.store.updateProject('default', {
      projectType: {
        id: 'language-trainer',
        version: languageType.manifest.version,
        source: languageType.sourceId,
        appliedAt: new Date().toISOString(),
      },
    });
    await svc.context.store.writeProjectWorkspaceFile('default', 'progress.json', '{"level":2}');
    const typeMint = await mint(svc.clientToken, {
      source: 'type',
      path: 'dashboard/index.html',
    });
    expect(typeMint.status).toBe(201);
    const typeLease = (await typeMint.json()) as { url: string };
    expect((await httpFetch(`${baseUrl}${typeLease.url}`)).status).toBe(200);
    const capability = typeLease.url.split('/')[2];
    expect(capability).toBeTruthy();
    expect(
      (await httpFetch(`${baseUrl}/preview/${capability}/workspace/default/progress.json`)).status,
    ).toBe(200);
    expect(
      (await httpFetch(`${baseUrl}/preview/${capability}/workspace/default/secret.txt`)).status,
    ).toBe(403);
  });
});
