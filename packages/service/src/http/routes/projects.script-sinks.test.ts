import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securityPolicyForLevel } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

/**
 * `run_nodejs_script` and `derive_file` are hidden from the model when script
 * execution is off, but a hidden tool is not a boundary: a stale session or a
 * direct API caller still reaches these routes, and on a host with no deny-net
 * fence the sandbox no longer refuses on its own.
 */

let svc: RunningService;
let home: string;
let baseUrl: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-script-sinks-route-'));
  svc = await startService({ home });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  await svc.context.store.writeConfig({ securityPolicy: securityPolicyForLevel('super-lockdown') });
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function post(path: string, body: unknown) {
  return httpFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${svc.context.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('script execution sinks with script execution disabled', () => {
  it.each([
    ['run-nodejs-script', { path: 'script.mjs' }],
    ['derive-file', { script: 'throw new Error("must not run")', outputPath: 'out.json' }],
  ])('refuses %s before starting anything', async (route, body) => {
    const res = await post(`/api/projects/default/${route}`, body);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /script execution is disabled/i,
    );
  });
});
