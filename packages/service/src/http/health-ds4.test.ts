/**
 * `/api/health` publishes whether a `ds4-server` binary resolved for this host.
 *
 * The ds4 Settings panel had no way to ask, so it classified the device from
 * `navigator.platform` and told every Linux machine — DGX Spark included —
 * "requires NVIDIA / CUDA", while the llama.cpp tab beside it reported `cuda`
 * from a real probe. The binary's presence is the same fact the ds4 provider
 * launches from, so it is the honest answer to "can DwarfStar run here".
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthResponseSchema } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../service.js';

let service: RunningService;
let home: string;
let baseUrl: string;
let httpFetch: typeof fetch;

const priorMock = process.env.GEZEL_MOCK_PROVIDER;
const priorSecrets = process.env.GEZEL_SECRETS_BACKEND;
const priorDs4Bin = process.env.GEZEL_DS4_SERVER_BIN;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  process.env.GEZEL_SECRETS_BACKEND = 'file';
  home = await mkdtemp(join(tmpdir(), 'gezel-health-ds4-'));
  service = await startService({ home });
  baseUrl = `${service.cert ? 'https' : 'http'}://127.0.0.1:${service.port}`;
  httpFetch = service.cert ? createTrustingFetch({ cert: service.cert.certPem }) : fetch;
}, 60_000);

afterAll(async () => {
  await service?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMock === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMock;
  if (priorSecrets === undefined) delete process.env.GEZEL_SECRETS_BACKEND;
  else process.env.GEZEL_SECRETS_BACKEND = priorSecrets;
  if (priorDs4Bin === undefined) delete process.env.GEZEL_DS4_SERVER_BIN;
  else process.env.GEZEL_DS4_SERVER_BIN = priorDs4Bin;
});

async function health() {
  const res = await httpFetch(`${baseUrl}/api/health`);
  expect(res.ok).toBe(true);
  // Parsed against the published schema so the field can't drift out of the
  // wire contract the UI imports.
  return HealthResponseSchema.parse(await res.json());
}

describe('/api/health — ds4 engine presence', () => {
  it('reports true when a ds4-server binary resolved', async () => {
    process.env.GEZEL_DS4_SERVER_BIN = '/opt/Gezel/native-bin/linux-arm64-cuda/gezel-ds4-server';

    expect((await health()).ds4ServerBundled).toBe(true);
  });

  it('reports an explicit false — not an omitted field — when none did', async () => {
    delete process.env.GEZEL_DS4_SERVER_BIN;

    const payload = await health();

    // The distinction is load-bearing: the client must tell "no ds4 build for
    // this host" (a verdict) apart from "this daemon is too old to say"
    // (unknown), and dropping falsy values collapses them into one.
    expect(payload.ds4ServerBundled).toBe(false);
    expect('ds4ServerBundled' in payload).toBe(true);
  });
});
