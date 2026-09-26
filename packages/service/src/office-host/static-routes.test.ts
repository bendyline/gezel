import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../service.js';
import { OFFICE_JS_ORIGIN, isOfficeListenerRequest } from './static-routes.js';

let svc: RunningService;
let home: string;
let officeDir: string;
let baseUrl: string;
let httpFetch: typeof fetch;
const priorMock = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-office-static-'));
  officeDir = await mkdtemp(join(tmpdir(), 'gezel-office-pages-'));
  await mkdir(join(officeDir, 'word'), { recursive: true });
  await mkdir(join(officeDir, 'assets'), { recursive: true });
  await writeFile(join(officeDir, 'word', 'taskpane.html'), '<!doctype html><title>pane</title>');
  await writeFile(join(officeDir, 'assets', 'pane-abc123.js'), 'export {};');
  svc = await startService({ home, officeDir, officeHostPort: 0 });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 60_000);

afterAll(async () => {
  await svc?.stop();
  await rm(home, { recursive: true, force: true });
  await rm(officeDir, { recursive: true, force: true });
  if (priorMock === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMock;
}, 60_000);

describe('/office static pages', () => {
  it('serves pane pages with the Office CSP, which admits only the office.js CDN', async () => {
    const res = await httpFetch(`${baseUrl}/office/word/taskpane.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain(`script-src 'self' 'wasm-unsafe-eval' ${OFFICE_JS_ORIGIN}`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('caches hashed assets forever', async () => {
    const res = await httpFetch(`${baseUrl}/office/assets/pane-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('answers 404, not the SPA shell, for anything missing or outside the tree', async () => {
    expect((await httpFetch(`${baseUrl}/office/word/missing.js`)).status).toBe(404);
    expect((await httpFetch(`${baseUrl}/office/`)).status).toBe(404);
    expect((await httpFetch(`${baseUrl}/office/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
  });

  it('keeps the strict default CSP everywhere else', async () => {
    const res = await httpFetch(`${baseUrl}/api/health`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain(OFFICE_JS_ORIGIN);
  });

  it('does not bind the Office listener until Office is set up', () => {
    expect(svc.context.officeHostOrigin?.()).toBeNull();
  });
});

describe('embedded chat framing', () => {
  it('may be framed by its own origin only on the Office listener', async () => {
    const plain = await httpFetch(`${baseUrl}/?embedded=chat&projectId=default`);
    expect(plain.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(plain.headers.get('x-frame-options')).toBe('DENY');

    const prior = svc.context.officeHostOrigin;
    // Pretend this listener is the Office one; the check is by Host port.
    svc.context.officeHostOrigin = () => `https://localhost:${svc.port}`;
    try {
      const framed = await httpFetch(`${baseUrl}/?embedded=chat&projectId=default`);
      expect(framed.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
      expect(framed.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      // Any other page on that listener stays unframeable.
      const app = await httpFetch(`${baseUrl}/`);
      expect(app.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    } finally {
      svc.context.officeHostOrigin = prior;
    }
  });
});

describe('isOfficeListenerRequest', () => {
  const origin = 'https://localhost:31234';
  it.each([
    ['localhost:31234', true],
    ['127.0.0.1:31234', true],
    ['[::1]:31234', true],
    ['LOCALHOST:31234', true],
    ['localhost:31235', false],
    ['evil.example:31234', false],
    ['localhost', false],
    [undefined, false],
  ] as const)('%s → %s', (host, expected) => {
    expect(isOfficeListenerRequest(host, origin)).toBe(expected);
  });
  it('is false when the Office listener is off', () => {
    expect(isOfficeListenerRequest('localhost:31234', null)).toBe(false);
  });
});
