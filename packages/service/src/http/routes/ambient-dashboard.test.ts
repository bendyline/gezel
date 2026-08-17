import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AmbientDashboardStatusResponseSchema } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { ambientDashboardLatestFile, ambientDir } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

/**
 * Wire contract for the ambient dashboard surface: status shape,
 * latest.png streaming, and the 202 run kickoff. Generator behavior is
 * covered in ambient/dashboard-generator.test.ts.
 */

let svc: RunningService;
let home: string;
let httpFetch: typeof fetch;
let baseUrl: string;

const priorSkipFlag = process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP;

beforeEach(async () => {
  process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-ambient-route-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterEach(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorSkipFlag === undefined) delete process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP;
  else process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP = priorSkipFlag;
}, 30_000);

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${svc.context.token}`, 'content-type': 'application/json' };
}

describe('GET /api/ambient-dashboard', () => {
  it('requires auth', async () => {
    const res = await httpFetch(`${baseUrl}/api/ambient-dashboard`);
    expect(res.status).toBe(401);
  });

  it('reports a schema-valid default status on a fresh home', async () => {
    const res = await httpFetch(`${baseUrl}/api/ambient-dashboard`, { headers: auth() });
    expect(res.status).toBe(200);
    const status = AmbientDashboardStatusResponseSchema.parse(await res.json());
    expect(status.enabled).toBe(false);
    expect(status.running).toBe(false);
    expect(status.lastGeneratedAt).toBeNull();
    expect(status.latestFilename).toBeNull();
    expect(status.resolution).toBe('fhd');
  });
});

describe('GET /api/ambient-dashboard/latest.png', () => {
  it('404s before the first render, then streams the PNG', async () => {
    const miss = await httpFetch(`${baseUrl}/api/ambient-dashboard/latest.png`, {
      headers: auth(),
    });
    expect(miss.status).toBe(404);

    await mkdir(ambientDir(home), { recursive: true });
    await writeFile(ambientDashboardLatestFile(home), Buffer.from('png-bytes'));
    const hit = await httpFetch(`${baseUrl}/api/ambient-dashboard/latest.png`, {
      headers: auth(),
    });
    expect(hit.status).toBe(200);
    expect(hit.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await hit.arrayBuffer()).toString()).toBe('png-bytes');
  });
});

describe('config round-trip', () => {
  it('persists and returns the ambientDashboard + ambientDisplay keys', async () => {
    const put = await httpFetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({
        ambientDashboard: { enabled: true, resolution: '4k' },
        ambientDisplay: { applyWallpaper: true },
      }),
    });
    expect(put.status).toBe(200);
    // GET /api/config is a hand-crafted whitelist — this pins the two new
    // keys into it so the Settings toggles don't lose their values.
    const got = (await (await httpFetch(`${baseUrl}/api/config`, { headers: auth() })).json()) as {
      ambientDashboard?: unknown;
      ambientDisplay?: unknown;
    };
    expect(got.ambientDashboard).toEqual({ enabled: true, resolution: '4k' });
    expect(got.ambientDisplay).toEqual({ applyWallpaper: true });

    const status = await httpFetch(`${baseUrl}/api/ambient-dashboard`, { headers: auth() });
    const parsed = AmbientDashboardStatusResponseSchema.parse(await status.json());
    expect(parsed.enabled).toBe(true);
    expect(parsed.resolution).toBe('4k');
  });
});

describe('POST /api/ambient-dashboard/run', () => {
  it('kicks off a run and returns 202', async () => {
    const res = await httpFetch(`${baseUrl}/api/ambient-dashboard/run`, {
      method: 'POST',
      headers: auth(),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ started: true });
  });
});
