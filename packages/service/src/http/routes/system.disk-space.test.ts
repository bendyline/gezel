import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelDownloadPreflightResponseSchema } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { ServiceContext } from '../context.js';
import { systemRoutes } from './system.js';

function appFor(home = join(tmpdir(), 'gezel-model-download-preflight-test')) {
  return systemRoutes({ home } as ServiceContext);
}

describe('POST /model-download-preflight', () => {
  it('checks the combined plan against Gezel model storage without exposing a path', async () => {
    const response = await appFor().request('/model-download-preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sizeBytes: 1_000_000 }),
    });

    expect(response.status).toBe(200);
    const body = ModelDownloadPreflightResponseSchema.parse(await response.json());
    expect(body.storageLocation).toBe('Gezel model storage');
    expect(body.requiredBytes).toBeGreaterThan(1_000_000);
    expect(JSON.stringify(body)).not.toContain(tmpdir());
  });

  it('rejects a plan larger than the declared safety boundary', async () => {
    const response = await appFor().request('/model-download-preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sizeBytes: 11 * 1024 ** 4 }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'sizeBytes must be a positive integer no larger than 10 TiB',
    });
  });
});
