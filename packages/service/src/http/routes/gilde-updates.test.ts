import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GildeUpdateStatusResponseSchema } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningService, startService } from '../../service.js';

/**
 * Route-layer coverage for the live gilde update surface. The update engine
 * itself is covered in gilde-updates/manager.test.ts against a loopback
 * registry; what's pinned here is the wire contract: status shape, the 202
 * check kickoff (which must never reach the network while the feature is
 * disabled), and the config whitelist round-trip for the toggle.
 */

let svc: RunningService;
let home: string;
let httpFetch: typeof fetch;
let baseUrl: string;

const priorSkipFlag = process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP;
const priorOverride = process.env.GEZEL_GILDE_DATA_DIR;

beforeEach(async () => {
  process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP = '1';
  delete process.env.GEZEL_GILDE_DATA_DIR;
  home = await mkdtemp(join(tmpdir(), 'gezel-gilde-updates-route-'));
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
  if (priorOverride === undefined) delete process.env.GEZEL_GILDE_DATA_DIR;
  else process.env.GEZEL_GILDE_DATA_DIR = priorOverride;
}, 30_000);

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${svc.context.token}`, 'content-type': 'application/json' };
}

describe('GET /api/gilde-updates', () => {
  it('requires auth', async () => {
    const res = await httpFetch(`${baseUrl}/api/gilde-updates`);
    expect(res.status).toBe(401);
  });

  it('reports a schema-valid default status on a fresh home', async () => {
    const res = await httpFetch(`${baseUrl}/api/gilde-updates`, { headers: auth() });
    expect(res.status).toBe(200);
    const status = GildeUpdateStatusResponseSchema.parse(await res.json());
    expect(status.enabled).toBe(false);
    expect(status.mode).toBe('bundled');
    expect(status.activeVersion).toBeNull();
    expect(status.bundledVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(status.updateInProgress).toBe(false);
  });
});

describe('POST /api/gilde-updates/check', () => {
  it('returns 202 and records a blocked result while disabled (no network)', async () => {
    const res = await httpFetch(`${baseUrl}/api/gilde-updates/check`, {
      method: 'POST',
      headers: auth(),
    });
    expect(res.status).toBe(202);
    expect((await res.json()) as { started: boolean }).toEqual({ started: true });
    await vi.waitFor(async () => {
      const status = GildeUpdateStatusResponseSchema.parse(
        await (await httpFetch(`${baseUrl}/api/gilde-updates`, { headers: auth() })).json(),
      );
      expect(status.lastCheck?.outcome).toBe('blocked');
      expect(status.lastCheck?.message).toMatch(/disabled/);
    });
  });
});

describe('config toggle round-trip', () => {
  it('echoes gildeUpdates from the GET whitelist after a PUT', async () => {
    // The env override keeps the post-enable background check off the
    // network for this test; the dispatcher itself is what's under test.
    process.env.GEZEL_GILDE_DATA_DIR = join(home, 'override-data');
    const put = await httpFetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ gildeUpdates: { enabled: true } }),
    });
    expect(put.status).toBe(200);
    const config = (await (
      await httpFetch(`${baseUrl}/api/config`, { headers: auth() })
    ).json()) as { gildeUpdates?: { enabled?: boolean } };
    expect(config.gildeUpdates).toEqual({ enabled: true });

    const status = GildeUpdateStatusResponseSchema.parse(
      await (await httpFetch(`${baseUrl}/api/gilde-updates`, { headers: auth() })).json(),
    );
    expect(status.enabled).toBe(true);
    expect(status.mode).toBe('overridden');
  });
});
