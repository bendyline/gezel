import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertCorpusInvariants } from '../../connectors/testing/harness.js';
import { type RunningService, startService } from '../../service.js';

/**
 * `GEZEL_CONNECTOR_SIMULATOR=1` on a real daemon, using the connector types
 * the pinned catalog ships: bind with a placeholder credential over HTTP,
 * sync, and find a believable corpus on disk. This is the switch E2E and eval
 * runs use to exercise connector-backed craftbooks without anyone's account.
 */

let svc: RunningService;
let baseUrl: string;
let home: string;
let httpFetch: typeof fetch;
const prior = {
  mock: process.env.GEZEL_MOCK_PROVIDER,
  sim: process.env.GEZEL_CONNECTOR_SIMULATOR,
};

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  process.env.GEZEL_CONNECTOR_SIMULATOR = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-connector-sim-'));
  svc = await startService({ home });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 60_000);

afterAll(async () => {
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  for (const [key, value] of [
    ['GEZEL_MOCK_PROVIDER', prior.mock],
    ['GEZEL_CONNECTOR_SIMULATOR', prior.sim],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}, 30_000);

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await httpFetch(`${baseUrl}/api/projects/default${path}`, {
    method,
    headers: { Authorization: `Bearer ${svc.context.token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const PLACEHOLDER = {
  accessToken: 'simulated',
  refreshToken: 'simulated',
  clientId: 'simulated',
  expiresAt: '2099-01-01T00:00:00Z',
};

describe('GEZEL_CONNECTOR_SIMULATOR', () => {
  it('syncs a simulated Gmail inbox through the shipped connector type', async () => {
    const { binding } = await call<{ binding: { id: string; corpusDir: string } }>(
      'POST',
      '/connectors/bind',
      {
        type: 'mail-gmail',
        displayName: 'Simulated Gmail',
        config: { address: 'sam@simulated.test', provider: 'gmail' },
        credential: PLACEHOLDER,
      },
    );
    const { result } = await call<{
      result: { written: number; quarantined: number; error?: string };
    }>('POST', `/connectors/${encodeURIComponent(binding.id)}/sync`);
    expect(result.error).toBeUndefined();
    expect(result.written).toBeGreaterThan(0);
    expect(result.quarantined).toBe(1);
    const records = await assertCorpusInvariants(
      svc.context.store.projectArtifactsDir('default'),
      binding.corpusDir,
      { requiredKeys: ['subject', 'from', 'date'], sharedArtifacts: true },
    );
    expect(records.some((r) => /Invoice 4471/.test(r.frontmatter.subject ?? ''))).toBe(true);
  });

  it('syncs a simulated Google calendar', async () => {
    const { binding } = await call<{ binding: { id: string; corpusDir: string } }>(
      'POST',
      '/connectors/bind',
      { type: 'calendar-google', displayName: 'Simulated calendar', credential: PLACEHOLDER },
    );
    const { result } = await call<{ result: { written: number; error?: string } }>(
      'POST',
      `/connectors/${encodeURIComponent(binding.id)}/sync`,
    );
    expect(result.error).toBeUndefined();
    expect(result.written).toBe(2);
  });
});
