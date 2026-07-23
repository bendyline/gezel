import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gezelPaths } from '@bendyline/gezel/paths';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UnexpectedHttpErrorEvent } from './http/server.js';
import { type RunningService, startService } from './service.js';

// Web mode serves HTTP on loopback (a browser can't trust the self-signed
// cert), so force the insecure transport for the whole suite and drive the
// daemon over plain HTTP — which also lets the host-guard test send a raw,
// un-rewritten Host header via node:http.
let svc: RunningService;
let baseUrl: string;
let home: string;
const unexpectedHttpErrors: UnexpectedHttpErrorEvent[] = [];

const priorMock = process.env.GEZEL_MOCK_PROVIDER;
const priorInsecure = process.env.GEZEL_INSECURE_TRANSPORT;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  process.env.GEZEL_INSECURE_TRANSPORT = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-web-ui-'));
  const runtime = gezelPaths(home).runtime;
  await mkdir(runtime.dir, { recursive: true });
  await writeFile(runtime.cert, 'stale-cert');
  await writeFile(runtime.fingerprint, 'stale-fingerprint');
  svc = await startService({
    home,
    webUi: true,
    onUnexpectedHttpError: (event) => unexpectedHttpErrors.push(event),
  });
  expect(svc.cert).toBeNull(); // HTTP, no TLS
  baseUrl = `http://127.0.0.1:${svc.port}`;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMock === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMock;
  if (priorInsecure === undefined) delete process.env.GEZEL_INSECURE_TRANSPORT;
  else process.env.GEZEL_INSECURE_TRANSPORT = priorInsecure;
}, 30_000);

/** Raw GET with a caller-controlled Host header (node:http won't rewrite it). */
function rawGet(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port: svc.port, path, method: 'GET', headers: { Host: host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('web-UI token', () => {
  it('keeps the daemon root token out of runtime discovery', async () => {
    expect(svc.clientToken).toBeTruthy();
    expect(svc.clientToken).not.toBe(svc.context.token);
    const onDisk = (await readFile(gezelPaths(home).runtime.token, 'utf8')).trim();
    expect(onDisk).toBe(svc.clientToken);
    expect(onDisk).not.toBe(svc.context.token);
    expect(svc.context.tokenStore.lookup(onDisk)?.scopes).toEqual(['ui', 'openai']);
  });

  it('mints a dedicated per-launch token, distinct from root', () => {
    expect(typeof svc.webUiToken).toBe('string');
    expect(svc.webUiToken).toBeTruthy();
    expect(svc.webUiToken).not.toBe(svc.context.token);
    expect(svc.context.tokenStore.lookup(svc.webUiToken!)?.scopes).toEqual(['ui']);
  });

  it('writes the token to runtime/web-ui-token', async () => {
    const onDisk = (await readFile(gezelPaths(home).runtime.webUiToken, 'utf8')).trim();
    expect(onDisk).toBe(svc.webUiToken);
  });

  it('clears stale TLS discovery files when the listener is HTTP', async () => {
    const runtime = gezelPaths(home).runtime;
    await expect(readFile(runtime.cert, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(runtime.fingerprint, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serves the standalone web UI with baseline browser security headers', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('rejects /api bearer credentials in the query string', async () => {
    const res = await fetch(`${baseUrl}/api/gezels?token=${svc.webUiToken}`);
    expect(res.status).toBe(401);
  });

  it('authorizes /api via the Authorization header too', async () => {
    const res = await fetch(`${baseUrl}/api/gezels`, {
      headers: { Authorization: `Bearer ${svc.webUiToken}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects an unknown token', async () => {
    const res = await fetch(`${baseUrl}/api/gezels?token=not-a-real-token`);
    expect(res.status).toBe(401);
  });

  it('never persists the web-ui token to tokens.json', async () => {
    let raw: string | null = null;
    try {
      raw = await readFile(join(home, 'tokens.json'), 'utf8');
    } catch {
      raw = null; // not written at all is the common case (no per-app tokens issued)
    }
    if (raw) {
      const parsed = JSON.parse(raw) as { tokens?: Array<{ appId: string }> };
      expect((parsed.tokens ?? []).some((t) => t.appId === 'web-ui')).toBe(false);
    }
  });

  it('reports thrown route errors to the host observer', async () => {
    const priorDisabled = process.env.GEZEL_DISABLE_EMBEDDINGS;
    const start = unexpectedHttpErrors.length;
    let res: Response;
    try {
      process.env.GEZEL_DISABLE_EMBEDDINGS = '1';
      res = await fetch(`${baseUrl}/api/memory/save`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${svc.webUiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          scope: 'gezel',
          id: 'observer-target',
          text: 'This save deliberately exercises the HTTP error observer.',
        }),
      });
    } finally {
      if (priorDisabled === undefined) delete process.env.GEZEL_DISABLE_EMBEDDINGS;
      else process.env.GEZEL_DISABLE_EMBEDDINGS = priorDisabled;
    }

    expect(res.status).toBe(500);
    expect(unexpectedHttpErrors.slice(start)).toEqual([
      expect.objectContaining({
        kind: 'unhandled_exception',
        method: 'POST',
        path: '/api/memory/save',
        status: 500,
        detail: expect.stringContaining('EmbeddingsDisabledError'),
      }),
    ]);
  });
});

describe('host guard (DNS-rebinding)', () => {
  it('allows loopback Host', async () => {
    expect(await rawGet('/api/health', `127.0.0.1:${svc.port}`)).toBe(200);
  });

  it('allows the localhost alias', async () => {
    expect(await rawGet('/api/health', `localhost:${svc.port}`)).toBe(200);
  });

  it('rejects a non-loopback Host before auth runs', async () => {
    // /api/health is unauthenticated, so a 403 here proves the guard runs
    // ahead of (and independently of) the bearer gate.
    expect(await rawGet('/api/health', 'evil.example')).toBe(403);
  });
});
