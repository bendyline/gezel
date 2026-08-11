import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securityPolicyForLevel } from '@bendyline/gezel';
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
    expect(csp).toContain("webrtc 'block'");
    expect(page.headers.get('access-control-allow-origin')).toBe('null');
    expect(page.headers.get('x-dns-prefetch-control')).toBe('off');
    expect(page.headers.get('x-gezel-preview-external-services')).toBe('blocked');

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

  it('relaxes only resource egress when both network capabilities are enabled', async () => {
    await svc.context.store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
    try {
      const minted = await mint(svc.clientToken);
      expect(minted.status).toBe(201);
      const lease = (await minted.json()) as { url: string };
      const page = await httpFetch(`${baseUrl}${lease.url}`);
      expect(page.status).toBe(200);

      const csp = page.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' http: https:");
      expect(csp).toContain("connect-src 'self' http: https: ws: wss:");
      expect(csp).toContain("img-src 'self' data: blob: http: https:");
      expect(csp).toContain("frame-src 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).toContain('sandbox allow-scripts');
      expect(csp).toContain("webrtc 'allow'");
      expect(page.headers.get('x-gezel-preview-external-services')).toBe('allowed');

      await svc.context.store.writeConfig({
        securityPolicy: {
          ...securityPolicyForLevel('free'),
          level: 'custom',
          allowAppNetwork: false,
        },
      });
      const appNetworkOff = await mint(svc.clientToken);
      const blockedLease = (await appNetworkOff.json()) as { url: string };
      const blockedPage = await httpFetch(`${baseUrl}${blockedLease.url}`);
      const blockedCsp = blockedPage.headers.get('content-security-policy') ?? '';
      expect(blockedCsp).not.toContain('https:');
      expect(blockedCsp).toContain("connect-src 'self'");
      expect(blockedPage.headers.get('x-gezel-preview-external-services')).toBe('blocked');
    } finally {
      await svc.context.store.writeConfig({ securityPolicy: securityPolicyForLevel('lockdown') });
    }
  });

  it('serves the same preview over a plain-HTTP browserUrl on a separate port', async () => {
    // A dedicated browser-openable sidecar serves the identical
    // capability-gated content without exposing the API surface.
    expect(svc.cert).toBeTruthy();
    const minted = await mint(svc.clientToken);
    expect(minted.status).toBe(201);
    const lease = (await minted.json()) as { url: string; browserUrl?: string };
    expect(lease.browserUrl).toBeTruthy();
    const browser = new URL(lease.browserUrl as string);
    expect(browser.protocol).toBe('http:');
    expect(browser.hostname).toBe('127.0.0.1');
    // Distinct listener from the TLS API server.
    expect(Number(browser.port)).not.toBe(svc.port);
    expect(browser.pathname + browser.search).toBe(lease.url);

    // Plain fetch — no cert trust needed — reaches the same file, and the
    // TLS API port refuses to answer the same path over http.
    const page = await fetch(lease.browserUrl as string);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('CAP PREVIEW');
    // The sidecar is preview-only: the bearer-gated API surface is absent.
    expect((await fetch(`http://127.0.0.1:${browser.port}/api/config`)).status).toBe(404);

    // Chromium's local-only mode points its proxy at this same listener.
    // Absolute-form requests for preview URLs resolve here; external hosts
    // are rejected rather than forwarded, so redirects and link clicks
    // cannot escape even though upstream Playwright's origin list is not a
    // security boundary.
    const throughProxy = (target: string): Promise<number | undefined> =>
      new Promise((resolve, reject) => {
        const targetUrl = new URL(target);
        const req = httpRequest(
          {
            hostname: browser.hostname,
            port: browser.port,
            method: 'GET',
            path: target,
            headers: { host: targetUrl.host },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          },
        );
        req.on('error', reject);
        req.end();
      });
    expect(await throughProxy(lease.browserUrl as string)).toBe(200);
    expect(await throughProxy('http://example.com/')).toBe(403);
  });
});
