import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { GEZEL_VERSION, type SystemDiagnostics, SystemDiagnosticsSchema } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';
import { resetSystemDiagnosticsCache } from '../../system/diagnostics.js';

/**
 * The privacy guard for `/api/system/diagnostics`.
 *
 * This is a full-service integration test rather than the cheaper fake-context
 * style on purpose: the guard has to run against the real assembled payload on
 * a real machine, because the whole point is catching a field somebody adds
 * later that happens to carry a resolved path on their box.
 */

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-diagnostics-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

async function fetchDiagnostics(): Promise<SystemDiagnostics> {
  const res = await httpFetch(`${baseUrl}/api/system/diagnostics`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return SystemDiagnosticsSchema.parse(await res.json());
}

/** Every string leaf in the payload, paired with its dotted key path. */
function stringLeaves(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string') return [[path || '(root)', value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => stringLeaves(v, path ? `${path}.${k}` : k));
  }
  return [];
}

describe('GET /api/system/diagnostics', () => {
  it('rejects unauthenticated access', async () => {
    const res = await httpFetch(`${baseUrl}/api/system/diagnostics`);
    expect(res.status).toBe(401);
  });

  it('reports this daemon and this machine', async () => {
    const body = await fetchDiagnostics();
    expect(body.version).toBe(GEZEL_VERSION);
    expect(body.runtime.platform).toBe(process.platform);
    expect(body.runtime.arch).toBe(process.arch);
    expect(body.hardware.description).toBeTruthy();
    expect(['tiny', 'small', 'medium', 'large']).toContain(body.hardware.tier);
  });

  it('omits localEngines when no local engine process is up', async () => {
    // Mock provider = no supervised native engines. A phantom entry here
    // would claim a granted context window for an engine that never
    // launched — the opposite of what the field is for.
    const body = await fetchDiagnostics();
    expect(body.localEngines).toBeUndefined();
  });

  it('contains no absolute path, username, or hostname', async () => {
    const body = await fetchDiagnostics();

    for (const [path, leaf] of stringLeaves(body)) {
      expect(leaf, `${path} starts like an absolute path`).not.toMatch(
        /^(\/|~|\$GEZEL_HOME|[A-Za-z]:\\|\\\\)/,
      );
      for (const needle of ['/Users/', '\\Users\\', '/home/', '.gezel']) {
        expect(leaf, `${path} embeds ${needle}`).not.toContain(needle);
      }
    }

    const serialized = JSON.stringify(body);
    // `hostname()` may be `mikes-macbook-pro.local`; check the bare label too.
    for (const needle of [
      home,
      tmpdir(),
      homedir(),
      userInfo().username,
      hostname(),
      hostname().split('.')[0] ?? hostname(),
    ]) {
      if (!needle) continue;
      expect(serialized, `payload contains ${needle}`).not.toContain(needle);
    }
  });

  it('names an installed engine without leaking where it lives', async () => {
    // Direct regression for the `engines[].path` trap: the sibling route
    // `/api/engines/binaries/status` DOES return that path, and it is the
    // likeliest field for somebody to copy over here.
    const fakeBinary = join(home, 'llama-server');
    await writeFile(fakeBinary, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(fakeBinary, 0o755);
    const prior = process.env.GEZEL_LLAMA_SERVER_BIN;
    process.env.GEZEL_LLAMA_SERVER_BIN = fakeBinary;
    resetSystemDiagnosticsCache();
    try {
      const body = await fetchDiagnostics();
      expect(body.engine.installedEngines).toContain('llama-server');
      expect(JSON.stringify(body)).not.toContain(fakeBinary);
    } finally {
      if (prior === undefined) delete process.env.GEZEL_LLAMA_SERVER_BIN;
      else process.env.GEZEL_LLAMA_SERVER_BIN = prior;
      resetSystemDiagnosticsCache();
    }
  });

  it('is cached between calls', async () => {
    resetSystemDiagnosticsCache();
    const first = await fetchDiagnostics();
    const second = await fetchDiagnostics();
    expect(second.sampledAt).toBe(first.sampledAt);
  });
});
