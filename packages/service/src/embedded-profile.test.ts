import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningInferenceOnlyService, startService } from './service.js';

const priorMockProvider = process.env.GEZEL_MOCK_PROVIDER;
const priorSecretsBackend = process.env.GEZEL_SECRETS_BACKEND;

let home: string | undefined;
let service: RunningInferenceOnlyService | undefined;

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
  it('serves the inference package behind the daemon listener, with no product state', async () => {
    process.env.GEZEL_MOCK_PROVIDER = '1';
    // Deliberately no GEZEL_SECRETS_BACKEND: the profile itself must stay out
    // of every secret store, not rely on the caller forcing a harmless one.
    delete process.env.GEZEL_SECRETS_BACKEND;
    home = await mkdtemp(join(tmpdir(), 'gezel-service-embedded-'));
    service = await startService({ home, embeddedInferenceOnly: true });
    expect(service.profile).toBe('embedded-inference');

    // Opening a persistent store writes its backend marker; creating an
    // identity writes its public half. Neither may exist.
    for (const name of ['secrets.backend', 'secrets.enc', 'secrets.key', 'device-identity.json']) {
      expect(await exists(join(home, name)), name).toBe(false);
    }
    expect(await exists(join(home, 'gezels'))).toBe(false);
    expect(await exists(join(home, 'projects'))).toBe(false);

    // A gezeld child is found through the same runtime files any daemon writes.
    const runtime = join(home, 'runtime');
    expect((await readFile(join(runtime, 'port'), 'utf8')).trim()).toBe(String(service.port));
    expect(await readFile(join(runtime, 'auth-token'), 'utf8')).toBe(service.clientToken);
    if (!service.cert) throw new Error('expected the loopback TLS listener');
    expect(await readFile(join(runtime, 'cert.pem'), 'utf8')).toBe(service.cert.certPem);

    const http = createTrustingFetch({ cert: service.cert.certPem });
    const base = `https://127.0.0.1:${service.port}`;
    const auth = { headers: { Authorization: `Bearer ${service.clientToken}` } };
    const health = await http(`${base}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      profile: 'embedded-inference',
      serviceRole: 'user',
      version: expect.any(String),
      startedAt: expect.any(String),
    });
    expect((await http(`${base}/v1/models`)).status).toBe(401);
    expect((await http(`${base}/v1/models`, auth)).status).toBe(200);
    expect((await http(`${base}/v1/knowledge/state`, auth)).status).toBe(200);
    for (const path of ['/v1/identity', '/v1/remote/models', '/api/remotes', '/api/projects']) {
      expect((await http(`${base}${path}`, auth)).status, path).toBe(404);
    }
    // The listener keeps the daemon's DNS-rebinding guard. Raw https because
    // fetch replaces a spoofed Host header with the URL's authority.
    const ca = service.cert.certPem;
    const port = service.port;
    const spoofedStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/models',
          ca,
          servername: '127.0.0.1',
          headers: { host: 'evil.example', ...auth.headers },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(spoofedStatus).toBe(403);

    // The direct transport reaches the same host without the socket.
    expect((await service.fetch('http://gezel.local/v1/models', auth)).status).toBe(200);
  }, 30_000);
});
