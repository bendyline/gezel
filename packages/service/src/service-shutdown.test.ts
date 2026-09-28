import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunningService, startService } from './service.js';

const priorMockProvider = process.env.GEZEL_MOCK_PROVIDER;
const priorSecretsBackend = process.env.GEZEL_SECRETS_BACKEND;
const priorSkipBootstrap = process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP;

let home: string | undefined;
let service: RunningService | undefined;
let stopped = false;

afterEach(async () => {
  if (service && !stopped) await service.stop().catch(() => {});
  if (home) await rm(home, { recursive: true, force: true }).catch(() => {});
  service = undefined;
  home = undefined;
  stopped = false;

  if (priorMockProvider === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockProvider;
  if (priorSecretsBackend === undefined) delete process.env.GEZEL_SECRETS_BACKEND;
  else process.env.GEZEL_SECRETS_BACKEND = priorSecretsBackend;
  if (priorSkipBootstrap === undefined) delete process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP;
  else process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP = priorSkipBootstrap;
});

describe('service shutdown', () => {
  it('starts and stops the inference-only embedded profile', async () => {
    process.env.GEZEL_MOCK_PROVIDER = '1';
    process.env.GEZEL_SECRETS_BACKEND = 'file';
    home = await mkdtemp(join(tmpdir(), 'gezel-service-embedded-'));
    service = await startService({ home, embeddedInferenceOnly: true });

    expect(service.port).toBeGreaterThan(0);
    expect(service.profile).toBe('embedded-inference');
    expect(service.fetch).toBeTypeOf('function');
    const models = await service.fetch?.(`https://127.0.0.1:${service.port}/v1/models`, {
      headers: { Authorization: `Bearer ${service.clientToken}` },
    });
    expect(models?.status).toBe(200);
    await service.stop();
    stopped = true;
  }, 30_000);

  it('drains chat background work exactly once', async () => {
    process.env.GEZEL_MOCK_PROVIDER = '1';
    process.env.GEZEL_SECRETS_BACKEND = 'file';
    process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP = '1';
    home = await mkdtemp(join(tmpdir(), 'gezel-service-shutdown-'));
    service = await startService({ home });
    const drainBackground = vi.spyOn(service.context.chat, 'drainBackground');

    await service.stop();
    stopped = true;

    expect(drainBackground).toHaveBeenCalledOnce();
  }, 30_000);
});
