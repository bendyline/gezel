import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

/**
 * Route-layer coverage for the CLI/TUI direct MCP tool surface
 * (`/api/sessions/:id/tools` + `/invoke`). The happy path spawns the
 * gezel-mcp subprocess (covered transitively by the fixed-function bridge
 * tests that share `buildSessionOpts`/`McpBridgePool`); here we pin the
 * deterministic contract: the routes are mounted, authenticated, and
 * return 404 for a session that doesn't exist.
 */

let svc: RunningService;
let home: string;
let httpFetch: typeof fetch;
let baseUrl: string;

// Opt out of the background system-toolset bootstrap. Without this the
// service kicks off a real @playwright/mcp tarball download into `home`;
// `afterEach` then removes `home` while that download is mid-flight,
// surfacing an uncaught ENOENT on the half-written `.tgz`. This route test
// never needs the real toolset, so skip the bootstrap entirely (the
// dedicated flag — see startService's bootstrap gate).
const priorSkipFlag = process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP;

beforeEach(async () => {
  process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-mcp-tools-'));
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

describe('mcp-tools routes', () => {
  it('lists 404 for an unknown session', async () => {
    const res = await httpFetch(`${baseUrl}/api/sessions/does-not-exist/tools`, {
      headers: auth(),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toMatch(/not found/i);
  });

  it('invokes 404 for an unknown session', async () => {
    const res = await httpFetch(`${baseUrl}/api/sessions/does-not-exist/tools/some_tool/invoke`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toMatch(/not found/i);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await httpFetch(`${baseUrl}/api/sessions/whatever/tools`, {
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });
});
