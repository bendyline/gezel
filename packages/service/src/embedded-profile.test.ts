import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningService, startService } from './service.js';

const priorMockProvider = process.env.GEZEL_MOCK_PROVIDER;
const priorSecretsBackend = process.env.GEZEL_SECRETS_BACKEND;

let home: string | undefined;
let service: RunningService | undefined;

afterEach(async () => {
  await service?.stop().catch(() => {});
  if (home) await rm(home, { recursive: true, force: true }).catch(() => {});
  service = undefined;
  home = undefined;
  if (priorMockProvider === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockProvider;
  if (priorSecretsBackend === undefined) delete process.env.GEZEL_SECRETS_BACKEND;
  else process.env.GEZEL_SECRETS_BACKEND = priorSecretsBackend;
});

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe('embedded inference profile', () => {
  it('keeps no secrets and sets up no remote connectivity', async () => {
    process.env.GEZEL_MOCK_PROVIDER = '1';
    // Deliberately no GEZEL_SECRETS_BACKEND: the profile itself must stay out
    // of every secret store, not rely on the caller forcing a harmless one.
    delete process.env.GEZEL_SECRETS_BACKEND;
    home = await mkdtemp(join(tmpdir(), 'gezel-service-embedded-'));
    service = await startService({ home, embeddedInferenceOnly: true });
    const fetch = service.fetch;
    if (!fetch) throw new Error('the embedded profile exposes no direct fetch handler');

    expect(service.context.secrets.backend).toBe('memory');
    expect(service.context.deviceIdentity).toBeNull();
    // Opening a persistent store writes its backend marker; creating an
    // identity writes its public half. Neither may exist.
    for (const name of ['secrets.backend', 'secrets.enc', 'secrets.key', 'device-identity.json']) {
      expect(await exists(join(home, name)), name).toBe(false);
    }

    const base = `https://127.0.0.1:${service.port}`;
    const auth = { headers: { Authorization: `Bearer ${service.clientToken}` } };
    expect((await fetch(`${base}/v1/models`, auth)).status).toBe(200);
    for (const path of ['/v1/identity', '/v1/remote/models', '/api/remotes']) {
      expect((await fetch(`${base}${path}`, auth)).status, path).toBe(404);
    }
    expect(service.context.remoteServing.status()).toEqual({ listening: false });
  }, 30_000);
});
