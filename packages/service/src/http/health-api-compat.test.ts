/**
 * `/api/health` publishes the HTTP contract generation this daemon speaks.
 *
 * `version` could never answer "can a separately-built client use this
 * daemon?" — the only comparison anyone made with it was string equality,
 * which reads every ordinary release as a mismatch. A store-distributed
 * client cannot restart or replace the daemon it discovers, so it needs an
 * answer that stays stable across the releases where the contract did not
 * move.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GEZEL_API_GENERATION,
  GEZEL_API_GENERATION_FLOOR,
  HealthResponseSchema,
} from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../service.js';

let service: RunningService;
let home: string;
let baseUrl: string;
let httpFetch: typeof fetch;

const priorMock = process.env.GEZEL_MOCK_PROVIDER;
const priorSecrets = process.env.GEZEL_SECRETS_BACKEND;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  process.env.GEZEL_SECRETS_BACKEND = 'file';
  home = await mkdtemp(join(tmpdir(), 'gezel-health-compat-'));
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
});

describe('/api/health — API compatibility handshake', () => {
  it('reports the generation it speaks and the oldest it serves', async () => {
    const res = await httpFetch(`${baseUrl}/api/health`);
    expect(res.ok).toBe(true);
    // Parsed against the published schema so the field can't drift out of the
    // wire contract clients import.
    const payload = HealthResponseSchema.parse(await res.json());

    // Sent unconditionally: a client reading `undefined` must be able to
    // conclude "this daemon predates the handshake", which it cannot do if a
    // current daemon might also omit the field.
    expect('apiCompat' in payload).toBe(true);
    expect(payload.apiCompat).toEqual({
      floor: GEZEL_API_GENERATION_FLOOR,
      current: GEZEL_API_GENERATION,
    });
  });

  it('keeps the floor at or below the current generation', () => {
    // A floor above the current generation would refuse every client,
    // including one built from this very commit.
    expect(GEZEL_API_GENERATION_FLOOR).toBeLessThanOrEqual(GEZEL_API_GENERATION);
    expect(Number.isInteger(GEZEL_API_GENERATION)).toBe(true);
    expect(Number.isInteger(GEZEL_API_GENERATION_FLOOR)).toBe(true);
  });
});
