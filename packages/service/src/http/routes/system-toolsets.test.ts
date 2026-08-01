import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

/**
 * Route-layer coverage for the on-demand system-toolset install surface.
 *
 * The happy path downloads a real npm tarball, so what's pinned here is the
 * deterministic contract instead: which toolset ids the endpoint will accept,
 * that the boot health bus stays out of it, and that Copilot availability is
 * reported honestly on a home with nothing installed.
 */

let svc: RunningService;
let home: string;
let httpFetch: typeof fetch;
let baseUrl: string;

// Skip the background bootstrap: it would start a real @playwright/mcp
// download into `home`, which `afterEach` then deletes mid-flight.
const priorSkipFlag = process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP;

beforeEach(async () => {
  process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-system-toolsets-route-'));
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

describe('POST /api/system-toolsets/:toolsetId/install', () => {
  // The security boundary. Without the `onDemand` filter this endpoint would
  // be a general "install any pinned package right now" trigger, able to race
  // the boot bootstrap over the same staging directory.
  it('refuses an eagerly-installed toolset', async () => {
    const res = await httpFetch(
      `${baseUrl}/api/system-toolsets/${encodeURIComponent('@playwright/mcp')}/install`,
      { method: 'POST', headers: auth() },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/not an on-demand/i);
  });

  it('refuses a toolset that is not in the manifest at all', async () => {
    const res = await httpFetch(
      `${baseUrl}/api/system-toolsets/${encodeURIComponent('@nope/nothing')}/install`,
      { method: 'POST', headers: auth() },
    );
    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await httpFetch(
      `${baseUrl}/api/system-toolsets/${encodeURIComponent('@github/copilot-sdk')}/install`,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
    );
    expect(res.status).toBe(401);
  });

  it('reports no in-flight installs on a fresh home', async () => {
    const res = await httpFetch(`${baseUrl}/api/system-toolsets/installs`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ installs: [] });
  });

  it('cancelling a toolset with nothing running is a no-op, not an error', async () => {
    const res = await httpFetch(
      `${baseUrl}/api/system-toolsets/${encodeURIComponent('@github/copilot-sdk')}/install`,
      { method: 'DELETE', headers: auth() },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ aborted: false });
  });
});

describe('GET /api/system/copilot-status', () => {
  it('reports the pinned version and no managed install on a fresh home', async () => {
    const res = await httpFetch(`${baseUrl}/api/system/copilot-status`, { headers: auth() });
    expect(res.status).toBe(200);
    const status = (await res.json()) as Record<string, unknown>;
    expect(status.managed).toBe('absent');
    expect(status.updateAvailable).toBe(false);
    expect(typeof status.pinnedVersion).toBe('string');
    // `available` deliberately not asserted: it's true on a machine that has
    // its own Copilot CLI on PATH, which is a supported state and exactly
    // what the availability unit tests cover rung by rung.
    expect(typeof status.available).toBe('boolean');
  });
});

describe('GET /api/system-toolsets/status', () => {
  // On-demand entries must not move the boot health bus, or a user-triggered
  // Copilot install would knock the Home pill out of "Runtime ready".
  it('does not report the on-demand Copilot entry as a boot install', async () => {
    const res = await httpFetch(`${baseUrl}/api/system-toolsets/status`, { headers: auth() });
    expect(res.status).toBe(200);
    const status = (await res.json()) as { currentToolset?: string };
    expect(status.currentToolset).not.toBe('@github/copilot-sdk');
  });
});
